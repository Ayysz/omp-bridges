import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BridgePaths {
  homeDir: string;
  ompRoot: string;
  ompAgentDir: string;
  ompLogsDir: string;
  openCodeConfigDir: string;
  codeBuddyHomeDir: string;
  codexHomeDir: string;
  bunBinDir: string;
}

export interface CodeBuddyRuntime {
  nodeBin: string;
  entryScript: string;
}

export function resolveBridgePaths(): BridgePaths {
  const homeDir = homedir();
  const ompRoot = process.env.PI_CONFIG_DIR?.trim() || join(homeDir, ".omp");
  const ompAgentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(ompRoot, "agent");
  const ompLogsDir = join(ompRoot, "logs");
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
  const openCodeConfigDir =
    process.env.OPENCODE_CONFIG_DIR?.trim() || join(xdgConfig, "opencode");
  const codeBuddyHomeDir =
    process.env.CODEBUDDY_CONFIG_DIR?.trim() || join(homeDir, ".codebuddy");
  const codexHomeDir = process.env.CODEX_HOME?.trim() || join(homeDir, ".codex");
  const bunBinDir = join(homeDir, ".bun", "bin");

  return {
    homeDir,
    ompRoot,
    ompAgentDir,
    ompLogsDir,
    openCodeConfigDir,
    codeBuddyHomeDir,
    codexHomeDir,
    bunBinDir,
  };
}

export function resolveRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function whichExecutable(candidates: readonly string[]): string | undefined {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  for (const name of candidates) {
    try {
      const res = spawnSync(locator, [name], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_500,
      });
      if (res.status === 0 && res.stdout) {
        const first = res.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => Boolean(line) && existsSync(line));
        if (first) return first;
      }
    } catch {
      // Ignore missing locator or lookup failure
    }
  }
  return undefined;
}

export function resolveBunBinary(): string {
  if (process.execPath && /bun(?:\.exe)?$/i.test(process.execPath) && existsSync(process.execPath)) {
    return process.execPath;
  }
  const { bunBinDir } = resolveBridgePaths();
  const ext = process.platform === "win32" ? ".exe" : "";
  const homeBun = join(bunBinDir, `bun${ext}`);
  if (existsSync(homeBun)) return homeBun;
  return whichExecutable(process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"]) ?? "bun";
}

export function resolveOmpBinary(): string {
  const { bunBinDir } = resolveBridgePaths();
  const ext = process.platform === "win32" ? ".exe" : "";
  const homeOmp = join(bunBinDir, `omp${ext}`);
  if (existsSync(homeOmp)) return homeOmp;
  return whichExecutable(process.platform === "win32" ? ["omp.exe", "omp.cmd", "omp"] : ["omp"]) ?? "omp";
}

export function resolveGatewayControlScript(): string {
  const { ompAgentDir } = resolveBridgePaths();
  const installedScript = join(ompAgentDir, "bin", "omp-gateway-ctl.ts");
  if (existsSync(installedScript)) return installedScript;
  const repoScript = join(resolveRepoRoot(), "src", "cli", "omp-gateway-ctl.ts");
  return repoScript;
}

export function resolveOpenCodeBinary(): string | undefined {
  const envBin = process.env.OPENCODE_OMP_BIN?.trim();
  if (envBin && existsSync(envBin)) return envBin;

  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      const npmExe = join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (existsSync(npmExe)) return npmExe;
    }

    const found = whichExecutable(["opencode.exe", "opencode.cmd"]);
    if (found) {
      if (found.toLowerCase().endsWith(".exe")) return found;
      const siblingExe = join(dirname(found), "node_modules", "opencode-ai", "bin", "opencode.exe");
      if (existsSync(siblingExe)) return siblingExe;
      try {
        const cmdText = readFileSync(found, "utf8");
        const relMatch = cmdText.match(/node_modules[\\/]+opencode[^\s"%]*\.exe/i);
        if (relMatch) {
          const resolvedExe = join(dirname(found), relMatch[0]);
          if (existsSync(resolvedExe)) return resolvedExe;
        }
      } catch {
        // Ignore .cmd parse errors
      }
    }
    return undefined;
  }

  return whichExecutable(["opencode"]);
}

export function resolveCodexBinary(): string | undefined {
  const envBin = process.env.CODEX_OMP_BIN?.trim();
  if (envBin && existsSync(envBin)) return envBin;

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const desktopBin = join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
      if (existsSync(desktopBin)) return desktopBin;
    }
    return whichExecutable(["codex.exe", "codex.cmd"]);
  }

  const macAppBin = "/Applications/Codex.app/Contents/Resources/codex";
  if (process.platform === "darwin" && existsSync(macAppBin)) return macAppBin;
  return whichExecutable(["codex"]);
}

export function resolveCodeBuddyRuntime(): CodeBuddyRuntime | { error: string } {
  const checked: string[] = [];
  const envEntry = process.env.CODEBUDDY_OMP_ENTRY?.trim();
  const envNode = process.env.CODEBUDDY_OMP_NODE?.trim();

  if (envEntry) {
    checked.push(`CODEBUDDY_OMP_ENTRY=${envEntry}`);
    if (existsSync(envEntry)) {
      return {
        nodeBin: envNode || (whichExecutable(process.platform === "win32" ? ["node.exe", "node"] : ["node"]) ?? "node"),
        entryScript: envEntry,
      };
    }
  }

  if (process.platform === "win32") {
    const laragonBase = "C:/laragon/bin/nodejs";
    if (existsSync(laragonBase)) {
      try {
        for (const sub of readdirSync(laragonBase).reverse()) {
          const entry = join(laragonBase, sub, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
          checked.push(entry);
          if (existsSync(entry)) {
            const nodeExe = join(laragonBase, sub, "node.exe");
            return {
              nodeBin: envNode || (existsSync(nodeExe) ? nodeExe : "node"),
              entryScript: entry,
            };
          }
        }
      } catch {
        // Ignore directory scan errors
      }
    }

    const appData = process.env.APPDATA?.trim();
    if (appData) {
      const appDataEntry = join(appData, "npm", "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
      checked.push(appDataEntry);
      if (existsSync(appDataEntry)) {
        return {
          nodeBin: envNode || (whichExecutable(["node.exe", "node"]) ?? "node"),
          entryScript: appDataEntry,
        };
      }
    }

    const cmdPath = whichExecutable(["codebuddy.cmd", "codebuddy"]);
    if (cmdPath) {
      const dir = dirname(cmdPath);
      const siblingEntry = join(dir, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
      checked.push(siblingEntry);
      if (existsSync(siblingEntry)) {
        const siblingNode = join(dir, "node.exe");
        return {
          nodeBin: envNode || (existsSync(siblingNode) ? siblingNode : (whichExecutable(["node.exe", "node"]) ?? "node")),
          entryScript: siblingEntry,
        };
      }
    }
  } else {
    const posixCmd = whichExecutable(["codebuddy", "cbc"]);
    if (posixCmd) {
      try {
        const real = realpathSync(posixCmd);
        checked.push(real);
        if (existsSync(real)) {
          return {
            nodeBin: envNode || (whichExecutable(["node"]) ?? "node"),
            entryScript: real,
          };
        }
      } catch {
        // Ignore symlink resolution failure
      }
    }

    const posixPrefixes = ["/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"];
    for (const prefix of posixPrefixes) {
      const entry = join(prefix, "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
      checked.push(entry);
      if (existsSync(entry)) {
        return {
          nodeBin: envNode || (whichExecutable(["node"]) ?? "node"),
          entryScript: entry,
        };
      }
    }
  }

  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmRoot = spawnSync(npmCmd, ["root", "-g"], {
      encoding: "utf8",
      windowsHide: true,
      shell: process.platform === "win32",
      timeout: 4_000,
    });
    if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
      const entry = join(npmRoot.stdout.trim(), "@tencent-ai", "codebuddy-code", "bin", "codebuddy");
      checked.push(entry);
      if (existsSync(entry)) {
        return {
          nodeBin: envNode || (whichExecutable(process.platform === "win32" ? ["node.exe", "node"] : ["node"]) ?? "node"),
          entryScript: entry,
        };
      }
    }
  } catch {
    // Ignore npm root lookup failure
  }

  return {
    error: `CodeBuddy CLI entry not found (checked: ${checked.join(", ")}). Install @tencent-ai/codebuddy-code or set CODEBUDDY_OMP_ENTRY.`,
  };
}

interface CodexAuthDoc {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface CodexJwtClaims {
  email?: string;
  exp?: number;
  "https://api.openai.com/auth"?: {
    chatgpt_plan_type?: string;
  };
}

export function readCodexAccountMetadata(): { email?: string; planType?: string; expiresAtIso?: string } {
  const { codexHomeDir } = resolveBridgePaths();
  const authPath = join(codexHomeDir, "auth.json");
  if (!existsSync(authPath)) return {};
  try {
    const doc = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthDoc;
    const idToken = doc.tokens?.id_token;
    if (!idToken) return {};
    const parts = idToken.split(".");
    if (!parts[1]) return {};
    const claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as CodexJwtClaims;
    const expMs = typeof claims.exp === "number" ? claims.exp * 1000 : Date.now() + 3_600_000;
    return {
      email: claims.email,
      planType: claims["https://api.openai.com/auth"]?.chatgpt_plan_type,
      expiresAtIso: new Date(expMs).toISOString(),
    };
  } catch {
    return {};
  }
}

export function syncCodexAuthToOmp(): { ok: boolean; message: string } {
  const { codexHomeDir } = resolveBridgePaths();
  const authPath = join(codexHomeDir, "auth.json");
  if (!existsSync(authPath)) {
    return { ok: false, message: `Codex auth file not found at ${authPath}` };
  }
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthDoc;
    const t = auth.tokens;
    if (!t?.access_token || !t.refresh_token) {
      return { ok: false, message: "Codex auth.json does not contain OAuth access/refresh tokens" };
    }
    const meta = readCodexAccountMetadata();
    const flatPayload = {
      type: "codex",
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      id_token: t.id_token,
      account_id: t.account_id,
      email: meta.email,
      expired: meta.expiresAtIso ?? new Date(Date.now() + 3_600_000).toISOString(),
      last_refresh: auth.last_refresh,
    };

    const tmpPath = join(tmpdir(), `codex-auth-sync-${process.pid}.json`);
    writeFileSync(tmpPath, JSON.stringify(flatPayload, null, 2), "utf8");
    try {
      const ompBin = resolveOmpBinary();
      const res = spawnSync(
        ompBin,
        ["auth-broker", "import", tmpPath, "--provider=openai-codex"],
        { encoding: "utf8", windowsHide: true, timeout: 15_000 },
      );
      const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
      return {
        ok: res.status === 0,
        message: out || `Exit code ${res.status}`,
      };
    } finally {
      rmSync(tmpPath, { force: true });
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
