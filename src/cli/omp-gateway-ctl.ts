import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveBridgePaths,
  resolveOmpBinary,
  resolveOpenCodeBinary,
  syncCodexAuthToOmp,
} from "../shared/paths.ts";

const BROKER_BIND = process.env.OMP_BROKER_BIND?.trim() || "127.0.0.1:8765";
const BROKER_URL = `http://${BROKER_BIND}`;
const BROKER_HEALTH_URL = `${BROKER_URL}/v1/healthz`;

const GATEWAY_BIND = process.env.OMP_GATEWAY_BIND?.trim() || "127.0.0.1:4000";
const GATEWAY_URL = `http://${GATEWAY_BIND}`;
const GATEWAY_HEALTH_URL = `${GATEWAY_URL}/healthz`;
const GATEWAY_MODELS_URL = `${GATEWAY_URL}/v1/models`;

const PREFERRED_LITE_MODEL = "google-antigravity/gemini-3.8-flash";

interface GatewayModelRow {
  id?: string;
  kind?: string;
  display_name?: string;
  context_length?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  supports_tools?: boolean;
}

interface GatewayModelsEnvelope {
  data?: GatewayModelRow[];
}

interface OpenCodeModelSpec {
  name: string;
  limit: {
    context: number;
    output: number;
  };
  modalities: {
    input: ("text" | "image")[];
    output: ["text"];
  };
}

interface OpenCodeProviderSpec {
  npm: string;
  name: string;
  options: {
    baseURL: string;
    apiKey: string;
  };
  models: Record<string, OpenCodeModelSpec>;
}

interface OpenCodeConfigDoc {
  $schema?: string;
  plugin?: unknown;
  agents?: unknown;
  provider?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CodeBuddyModelEntry {
  id: string;
  name: string;
  vendor?: string;
  url: string;
  apiKey: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  relatedModels?: {
    lite?: string;
    reasoning?: string;
  };
  [key: string]: unknown;
}

interface CodeBuddyModelsDoc {
  models?: CodeBuddyModelEntry[];
  [key: string]: unknown;
}

interface CodeBuddyLocalStorageModel {
  id?: string;
  name?: string;
  credits?: string;
}

interface CodeBuddyLocalStorageEntry {
  "0"?: {
    data?: {
      models?: CodeBuddyLocalStorageModel[];
    };
  };
}

function getManagedGatewayFiles() {
  const paths = resolveBridgePaths();
  return {
    ...paths,
    brokerTokenPath: join(paths.ompRoot, "auth-broker.token"),
    brokerPidPath: join(paths.ompRoot, "auth-broker.pid"),
    brokerLogPath: join(paths.ompLogsDir, "auth-broker.log"),
    gatewayTokenPath: join(paths.ompRoot, "auth-gateway.token"),
    gatewayPidPath: join(paths.ompRoot, "auth-gateway.pid"),
    gatewayLogPath: join(paths.ompLogsDir, "auth-gateway.log"),
    openCodeJsoncPath: join(paths.openCodeConfigDir, "opencode.jsonc"),
    codeBuddyModelsPath: join(paths.codeBuddyHomeDir, "models.json"),
    codeBuddyLocalStorageDir: join(paths.codeBuddyHomeDir, "local_storage"),
    codexConfigTomlPath: join(paths.codexHomeDir, "config.toml"),
  };
}

async function checkHttpOk(url: string, timeoutMs = 1_500): Promise<boolean> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.status === 200;
  } catch {
    return false;
  }
}

function readTail(filePath: string, maxChars = 1_200): string {
  if (!existsSync(filePath)) return "(log file empty)";
  try {
    const content = readFileSync(filePath, "utf8").trim();
    return content ? content.slice(-maxChars) : "(log file empty)";
  } catch {
    return "(failed to read log)";
  }
}

function ensureToken(tokenPath: string, subcmd: "auth-broker" | "auth-gateway"): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  }

  const ompBin = resolveOmpBinary();
  const res = spawnSync(ompBin, [subcmd, "token"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: {
      ...process.env,
      ...(subcmd === "auth-gateway" ? { OMP_AUTH_BROKER_URL: BROKER_URL } : {}),
    },
  });

  if (existsSync(tokenPath)) {
    const created = readFileSync(tokenPath, "utf8").trim();
    if (created) return created;
  }

  const fallback = (res.stdout ?? "").trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (fallback) {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, `${fallback}\n`, "utf8");
    return fallback;
  }

  throw new Error(
    `Failed to generate ${subcmd} token (exit=${res.status}): ${(res.stderr ?? "").trim()}`,
  );
}

function readPidFile(pidPath: string): number | undefined {
  if (!existsSync(pidPath)) return undefined;
  try {
    const val = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    return Number.isFinite(val) && val > 0 ? val : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findListeningPidOnBind(bindAddr: string): number | undefined {
  try {
    if (process.platform === "win32") {
      const res = spawnSync("netstat.exe", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4_000,
      });
      if (res.status !== 0 || !res.stdout) return undefined;
      for (const rawLine of res.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line.startsWith("TCP")) continue;
        const parts = line.split(/\s+/);
        if (parts[1] === bindAddr && parts[3] === "LISTENING" && parts[4]) {
          const pid = Number.parseInt(parts[4], 10);
          if (Number.isFinite(pid) && pid > 0) return pid;
        }
      }
      return undefined;
    }

    const port = bindAddr.split(":").pop();
    if (!port) return undefined;
    const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 3_000,
    });
    if (lsof.status === 0 && lsof.stdout.trim()) {
      const pid = Number.parseInt(lsof.stdout.trim().split(/\r?\n/)[0] ?? "", 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {
    // Ignore port lookup failures
  }
  return undefined;
}

async function stopManagedProcess(pidPath: string, bindAddr: string): Promise<boolean> {
  const candidates = new Set<number>();
  const recordedPid = readPidFile(pidPath);
  if (recordedPid) candidates.add(recordedPid);
  const boundPid = findListeningPidOnBind(bindAddr);
  if (boundPid) candidates.add(boundPid);

  let stoppedAny = false;
  for (const pid of candidates) {
    if (!isProcessAlive(pid)) continue;
    stoppedAny = true;
    try {
      process.kill(pid);
    } catch {
      // Ignore initial kill failure
    }

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await Bun.sleep(100);
    }

    if (isProcessAlive(pid)) {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 5_000,
        });
      } else {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    }
  }

  rmSync(pidPath, { force: true });
  return stoppedAny;
}

async function spawnDetachedAndPoll(opts: {
  name: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  pidPath: string;
  logPath: string;
  healthUrl: string;
}): Promise<number> {
  const ompBin = resolveOmpBinary();
  const logFd = openSync(opts.logPath, "a");
  let pid: number | undefined;
  try {
    const child = spawn(ompBin, opts.args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: opts.env,
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(logFd);
  }

  if (!pid) {
    throw new Error(`Failed to spawn ${opts.name}`);
  }
  writeFileSync(opts.pidPath, `${pid}\n`, "utf8");

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await checkHttpOk(opts.healthUrl, 1_500)) {
      return pid;
    }
    await Bun.sleep(250);
  }

  throw new Error(
    `${opts.name} failed health check at ${opts.healthUrl} within 10s.\nLog tail (${opts.logPath}):\n${readTail(opts.logPath)}`,
  );
}

export function writeAtomicUtf8(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, targetPath);
}

async function fetchGatewayChatModels(gatewayToken: string): Promise<Array<GatewayModelRow & { id: string }>> {
  const resp = await fetch(GATEWAY_MODELS_URL, {
    headers: { Authorization: `Bearer ${gatewayToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`GET /v1/models returned HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const parsed = (await resp.json()) as GatewayModelRow[] | GatewayModelsEnvelope;
  const rawList = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.data)
      ? parsed.data
      : [];

  return rawList.filter(
    (row): row is GatewayModelRow & { id: string } =>
      !row.kind && typeof row.id === "string" && row.id.length > 0 && !row.id.includes("/tab_"),
  );
}

function syncOpenCodeConfig(
  openCodeJsoncPath: string,
  chatModels: Array<GatewayModelRow & { id: string }>,
): void {
  let doc: OpenCodeConfigDoc = {
    $schema: "https://opencode.ai/config.json",
  };

  if (existsSync(openCodeJsoncPath)) {
    const raw = readFileSync(openCodeJsoncPath, "utf8");
    if (raw.trim()) {
      const parsed = Bun.JSONC.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        doc = parsed as OpenCodeConfigDoc;
      }
    }
  }

  const modelsMap: Record<string, OpenCodeModelSpec> = {};
  for (const row of chatModels) {
    const baseLabel = row.display_name?.trim() || row.id;
    const supportsImage =
      Array.isArray(row.input_modalities) && row.input_modalities.includes("image");
    modelsMap[row.id] = {
      name: `${baseLabel} (OMP)`,
      limit: {
        context: row.context_length ?? 200_000,
        output: row.max_output_tokens ?? 65_536,
      },
      modalities: {
        input: supportsImage ? ["text", "image"] : ["text"],
        output: ["text"],
      },
    };
  }

  const gatewayProvider: OpenCodeProviderSpec = {
    npm: "@ai-sdk/openai-compatible",
    name: "OMP Auth Gateway",
    options: {
      baseURL: `${GATEWAY_URL}/v1`,
      apiKey: "{file:~/.omp/auth-gateway.token}",
    },
    models: modelsMap,
  };

  const existingProviders =
    doc.provider && typeof doc.provider === "object" && !Array.isArray(doc.provider)
      ? doc.provider
      : {};

  doc.provider = {
    ...existingProviders,
    "omp-gateway": gatewayProvider,
  };

  writeAtomicUtf8(openCodeJsoncPath, `${JSON.stringify(doc, null, 2)}\n`);
}

function syncCodeBuddyModels(
  codeBuddyModelsPath: string,
  chatModels: Array<GatewayModelRow & { id: string }>,
  gatewayToken: string,
): void {
  let preservedUserModels: CodeBuddyModelEntry[] = [];
  let extraRootFields: Record<string, unknown> = {};

  if (existsSync(codeBuddyModelsPath)) {
    const raw = readFileSync(codeBuddyModelsPath, "utf8").trim();
    if (raw) {
      const parsed = JSON.parse(raw) as CodeBuddyModelsDoc;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const { models, availableModels: _omittedAvailableModels, ...rest } = parsed;
        extraRootFields = rest;
        if (Array.isArray(models)) {
          preservedUserModels = models.filter(
            (entry) => entry && typeof entry === "object" && entry.vendor !== "OMP Gateway",
          );
        }
      }
    }
  }

  const hasPreferredLite = chatModels.some((row) => row.id === PREFERRED_LITE_MODEL);

  const syncedEntries: CodeBuddyModelEntry[] = chatModels.map((row) => {
    const baseLabel = row.display_name?.trim() || row.id;
    const supportsImages =
      Array.isArray(row.input_modalities) && row.input_modalities.includes("image");
    return {
      id: row.id,
      name: `${baseLabel} (OMP Gateway)`,
      vendor: "OMP Gateway",
      url: `${GATEWAY_URL}/v1/chat/completions`,
      apiKey: gatewayToken,
      maxInputTokens: row.context_length ?? 200_000,
      maxOutputTokens: row.max_output_tokens ?? 65_536,
      supportsToolCall: row.supports_tools !== false,
      supportsImages,
      supportsReasoning: true,
      relatedModels: {
        lite: hasPreferredLite ? PREFERRED_LITE_MODEL : row.id,
        reasoning: row.id,
      },
    };
  });

  const nextDoc: CodeBuddyModelsDoc = {
    ...extraRootFields,
    models: [...preservedUserModels, ...syncedEntries],
  };

  writeAtomicUtf8(codeBuddyModelsPath, `${JSON.stringify(nextDoc, null, 2)}\n`);
}

export function upsertCodexGatewaySection(existingToml: string, gatewayUrl: string, gatewayToken: string): string {
  const stripped = existingToml
    .replace(/\n?\[model_providers\.omp_gateway\][\s\S]*?(?=\n\[|$)/g, "")
    .trimEnd();

  const block = [
    "[model_providers.omp_gateway]",
    'name = "OMP Gateway"',
    `base_url = "${gatewayUrl}/v1"`,
    'wire_api = "responses"',
    `http_headers = { Authorization = "Bearer ${gatewayToken}" }`,
  ].join("\n");

  return stripped ? `${stripped}\n\n${block}\n` : `${block}\n`;
}

function syncCodexConfigToml(codexConfigTomlPath: string, gatewayToken: string): void {
  const existing = existsSync(codexConfigTomlPath)
    ? readFileSync(codexConfigTomlPath, "utf8")
    : "";
  writeAtomicUtf8(
    codexConfigTomlPath,
    upsertCodexGatewaySection(existing, GATEWAY_URL, gatewayToken),
  );
}

async function runSync(): Promise<number> {
  const files = getManagedGatewayFiles();
  const gatewayToken = ensureToken(files.gatewayTokenPath, "auth-gateway");
  const chatModels = await fetchGatewayChatModels(gatewayToken);
  if (chatModels.length === 0) {
    console.warn(
      "omp-gateway sync: warning: /v1/models returned 0 chat models; skipping target config updates.",
    );
    return 0;
  }

  syncOpenCodeConfig(files.openCodeJsoncPath, chatModels);
  syncCodeBuddyModels(files.codeBuddyModelsPath, chatModels, gatewayToken);
  if (existsSync(files.codexHomeDir)) {
    syncCodexConfigToml(files.codexConfigTomlPath, gatewayToken);
  }

  const providers = [...new Set(chatModels.map((m) => m.id.split("/")[0]))];
  console.log(
    `Synced ${chatModels.length} OMP chat model(s) [${providers.join(", ")}] -> OpenCode, CodeBuddy, & Codex`,
  );
  return chatModels.length;
}

async function runStart(): Promise<void> {
  const files = getManagedGatewayFiles();
  mkdirSync(files.ompLogsDir, { recursive: true });
  syncCodexAuthToOmp();
  const brokerToken = ensureToken(files.brokerTokenPath, "auth-broker");
  ensureToken(files.gatewayTokenPath, "auth-gateway");

  let brokerStatus = "already running";
  if (!(await checkHttpOk(BROKER_HEALTH_URL, 1_500))) {
    const pid = await spawnDetachedAndPoll({
      name: "auth-broker",
      args: ["auth-broker", "serve", `--bind=${BROKER_BIND}`],
      env: { ...process.env },
      pidPath: files.brokerPidPath,
      logPath: files.brokerLogPath,
      healthUrl: BROKER_HEALTH_URL,
    });
    brokerStatus = `started (pid ${pid})`;
  } else {
    const pid = readPidFile(files.brokerPidPath) ?? findListeningPidOnBind(BROKER_BIND);
    if (pid) writeFileSync(files.brokerPidPath, `${pid}\n`, "utf8");
    brokerStatus = `running${pid ? ` (pid ${pid})` : ""}`;
  }

  let gatewayStatus = "already running";
  if (!(await checkHttpOk(GATEWAY_HEALTH_URL, 1_500))) {
    const pid = await spawnDetachedAndPoll({
      name: "auth-gateway",
      args: ["auth-gateway", "serve", `--bind=${GATEWAY_BIND}`],
      env: {
        ...process.env,
        OMP_AUTH_BROKER_URL: BROKER_URL,
        OMP_AUTH_BROKER_TOKEN: brokerToken,
      },
      pidPath: files.gatewayPidPath,
      logPath: files.gatewayLogPath,
      healthUrl: GATEWAY_HEALTH_URL,
    });
    gatewayStatus = `started (pid ${pid})`;
  } else {
    const pid = readPidFile(files.gatewayPidPath) ?? findListeningPidOnBind(GATEWAY_BIND);
    if (pid) writeFileSync(files.gatewayPidPath, `${pid}\n`, "utf8");
    gatewayStatus = `running${pid ? ` (pid ${pid})` : ""}`;
  }

  console.log(`auth-broker (${BROKER_BIND}): ${brokerStatus}`);
  console.log(`auth-gateway (${GATEWAY_BIND}): ${gatewayStatus}`);
  await runSync();
}

async function runStop(): Promise<void> {
  const files = getManagedGatewayFiles();
  const gwStopped = await stopManagedProcess(files.gatewayPidPath, GATEWAY_BIND);
  const brStopped = await stopManagedProcess(files.brokerPidPath, BROKER_BIND);
  console.log(
    `auth-gateway (${GATEWAY_BIND}): ${gwStopped ? "stopped" : "already stopped"}`,
  );
  console.log(
    `auth-broker (${BROKER_BIND}): ${brStopped ? "stopped" : "already stopped"}`,
  );
}

async function runStatus(): Promise<void> {
  const files = getManagedGatewayFiles();
  const brokerUp = await checkHttpOk(BROKER_HEALTH_URL, 1_500);
  const gatewayUp = await checkHttpOk(GATEWAY_HEALTH_URL, 1_500);
  const brokerPid = brokerUp
    ? readPidFile(files.brokerPidPath) ?? findListeningPidOnBind(BROKER_BIND)
    : undefined;
  const gatewayPid = gatewayUp
    ? readPidFile(files.gatewayPidPath) ?? findListeningPidOnBind(GATEWAY_BIND)
    : undefined;

  console.log(
    `auth-broker (${BROKER_BIND}): ${brokerUp ? `healthy (200 OK${brokerPid ? `, pid ${brokerPid}` : ""})` : "stopped"}`,
  );
  console.log(
    `auth-gateway (${GATEWAY_BIND}): ${gatewayUp ? `healthy (200 OK${gatewayPid ? `, pid ${gatewayPid}` : ""})` : "stopped"}`,
  );

  if (gatewayUp && existsSync(files.gatewayTokenPath)) {
    try {
      const token = readFileSync(files.gatewayTokenPath, "utf8").trim();
      const models = await fetchGatewayChatModels(token);
      const providers = [...new Set(models.map((m) => m.id.split("/")[0]))];
      console.log(
        `catalog (/v1/models): ${models.length} chat model(s) [${providers.join(", ")}]`,
      );
    } catch (err) {
      console.log(
        `catalog (/v1/models): error (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

function readCodeBuddyModelCredits(localStorageDir: string): CodeBuddyLocalStorageModel[] {
  if (!existsSync(localStorageDir)) return [];
  try {
    for (const file of readdirSync(localStorageDir)) {
      if (!file.endsWith(".info")) continue;
      const fullPath = join(localStorageDir, file);
      const raw = readFileSync(fullPath, "utf8");
      if (!raw.includes('"deepseek-v4.1-flash"')) continue;
      const parsed = JSON.parse(raw) as CodeBuddyLocalStorageEntry;
      const models = parsed["0"]?.data?.models;
      if (Array.isArray(models) && models.length > 0) return models;
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

function formatDurationUntilNextUtcMidnight(): string {
  const now = new Date();
  const nextUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  const diffMs = Math.max(0, nextUtcMidnight - now.getTime());
  const hours = Math.floor(diffMs / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  return `${hours}h ${mins}m (00:00 UTC / 07:00 WIB)`;
}

export function runQuotaReport(): void {
  const files = getManagedGatewayFiles();
  syncCodexAuthToOmp();

  console.log("=== 1. OMP & ChatGPT/Codex OAuth Quotas ===");
  const ompBin = resolveOmpBinary();
  const ompUsage = spawnSync(ompBin, ["usage"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  console.log((ompUsage.stdout || ompUsage.stderr || "(no output)").trim());

  console.log("\n=== 2. CodeBuddy CLI Credit Multipliers & Free Tier ===");
  const cbModels = readCodeBuddyModelCredits(files.codeBuddyLocalStorageDir);
  if (cbModels.length > 0) {
    const freeModels: string[] = [];
    const lowCostModels: string[] = [];
    const midCostModels: string[] = [];
    const highCostModels: string[] = [];

    for (const m of cbModels) {
      const id = m.id?.trim();
      if (!id) continue;
      const cred = (m.credits ?? "").trim();
      const numMatch = cred.match(/(\d+(?:\.\d+)?)/);
      const val = numMatch ? Number(numMatch[1]) : undefined;
      if (val === 0) {
        freeModels.push(`${id} (x0.00 FREE)`);
      } else if (val !== undefined && val <= 0.15) {
        lowCostModels.push(`${id} (${cred})`);
      } else if (val !== undefined && val <= 1.0) {
        midCostModels.push(`${id} (${cred})`);
      } else if (val !== undefined) {
        highCostModels.push(`${id} (${cred})`);
      }
    }

    console.log(`  ● Default @codebuddy : codebuddy-cli/deepseek-v4.1-flash (x0.00 FREE, 0 credit/turn)`);
    console.log(`  ● Free (0 Credit)    : ${freeModels.join(", ") || "deepseek-v4.1-flash, hy3"}`);
    console.log(`  ● Low (<= x0.15)     : ${lowCostModels.join(", ")}`);
    console.log(`  ● Medium (<= x1.00)  : ${midCostModels.join(", ")}`);
    console.log(`  ● High (> x1.00)     : ${highCostModels.join(", ")}`);
  } else {
    console.log("  ● Free (0 Credit): deepseek-v4.1-flash (x0.00), hy3 (x0.00)");
  }

  console.log("\n=== 3. OpenCode CLI Free Tier & Local Stats (Last 24h) ===");
  console.log(`  ● Daily Free Reset   : in ${formatDurationUntilNextUtcMidnight()}`);
  const openCodeBin = resolveOpenCodeBinary();
  if (openCodeBin && existsSync(openCodeBin)) {
    const ocStats = spawnSync(openCodeBin, ["--pure", "stats", "--days", "1"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8_000,
      env: {
        ...process.env,
        OPENCODE_DISABLE_UPDATE_CHECK: "1",
        OPENCODE_CONFIG_CONTENT: '{"plugin":[],"mcp":{"figma":{"enabled":false}}}',
      },
    });
    const statsOut = (ocStats.stdout || "").trim();
    if (statsOut) console.log(statsOut);
  } else {
    console.log("  ○ OpenCode CLI not detected on PATH.");
  }
}

export async function runGatewayCli(argv: string[]): Promise<void> {
  const cmd = (argv[0] ?? "status").trim().toLowerCase();
  switch (cmd) {
    case "start":
      await runStart();
      break;
    case "stop":
      await runStop();
      break;
    case "restart":
      await runStop();
      await runStart();
      break;
    case "status":
      await runStatus();
      break;
    case "sync":
      await runSync();
      break;
    case "quota":
      runQuotaReport();
      break;
    default:
      console.error("Usage: omp-gateway <start|stop|restart|status|sync|quota>");
      process.exit(1);
  }
}

if (import.meta.main) {
  runGatewayCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
