import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
} from "@oh-my-pi/pi-ai";
import {
  resolveBunBinary,
  resolveCodeBuddyRuntime,
  resolveGatewayControlScript,
} from "../shared/paths.ts";

const PROVIDER_ID = "codebuddy-cli";
const API_ID = "codebuddy-cli-runner" as Api;
const DISCOVERY_TIMEOUT_MS = 8_000;
const STDERR_LIMIT = 16_000;
const AUTH_ERROR_RE =
  /\b401\b|unauthorized|unauthenticated|not\s+logged\s+in|please\s+login|login\s+required|authentication\s+failed|invalid\s+token/i;

const FALLBACK_MODELS = [
  "deepseek-v4.1-flash", "hy3",
  "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4",
  "grok-4.7", "gemini-3.8-flash",
  "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k3",
  "glm-5.3", "glm-5.3-flash", "glm-5.2",
  "minimax-m3.1-flash", "deepseek-v4.1-flash-sg", "hy4-preview",
  "primary-model", "balanced-model", "fast-model", "default-model",
] as const;

const LOWMEM_ENV_OVERRIDES = {
  CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1",
  CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1",
} as const;

const V8_LOWMEM_FLAGS = [
  "--optimize-for-size",
  "--max-semi-space-size=2",
] as const;

class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface AcpUsagePayload {
  inputTokens?: number;
  promptTokens?: number;
  input_tokens?: number;
  used?: number;
  outputTokens?: number;
  completionTokens?: number;
  output_tokens?: number;
  cacheReadTokens?: number;
  cache_read_input_tokens?: number;
}

interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: {
    type?: string;
    text?: string;
  };
  usage?: AcpUsagePayload;
  inputTokens?: number;
  promptTokens?: number;
  input_tokens?: number;
  used?: number;
  outputTokens?: number;
  completionTokens?: number;
  output_tokens?: number;
  cacheReadTokens?: number;
  cache_read_input_tokens?: number;
}

interface AcpJsonRpcEnvelope {
  id?: number | string;
  method?: string;
  params?: {
    sessionId?: string;
    update?: AcpSessionUpdate;
  };
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface AcpDaemon {
  proc: ChildProcessWithoutNullStreams;
  workDir: string;
  activeTurns: number;
  idleTimer?: NodeJS.Timeout;
  stderrTail: string;
  sessionListeners: Map<string, (update: AcpSessionUpdate) => void>;
  sendRequest: <T = unknown>(method: string, params: unknown, timeoutMs: number) => Promise<T>;
  sendNotification: (method: string, params: unknown) => void;
}

interface StreamJsonContentBlock {
  type?: string;
  name?: string;
  text?: string;
  thinking?: string;
}

interface StreamJsonLine {
  type?: string;
  event?: {
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
    };
  };
  message?: {
    content?: StreamJsonContentBlock[];
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  is_error?: boolean;
  result?: string;
  errors?: unknown[];
  duration_ms?: number;
  total_cost_usd?: number;
}

type DelegateMode = "readonly" | "edit" | "full";

interface DelegateRunOptions {
  task: string;
  mode: DelegateMode;
  model: string;
  effort?: string;
  maxTurns: number;
  cwd: string;
  signal?: AbortSignal;
  onToolUse?: (toolUseCount: number, toolName: string) => void;
}

interface DelegateRunResult {
  text: string;
  mode: DelegateMode;
  model: string;
  durationMs: number;
  costUsd: number;
  toolUseCount: number;
}

let registeredModels: string[] = [];
let lastDiscoveryError: string | undefined;
let cbDaemon: AcpDaemon | undefined;
let cbDaemonStarting: Promise<AcpDaemon> | undefined;

function contextWindowFor(id: string): number {
  if (
    id.startsWith("gpt-6") ||
    id.startsWith("gpt-5.6") ||
    id.startsWith("gemini-3.8") ||
    id.startsWith("deepseek-v4.1") ||
    id.startsWith("kimi-k3") ||
    id === "glm-5.2" ||
    id === "glm-5.3-flash"
  ) {
    return 1_000_000;
  }
  return 200_000;
}

function buildProviderModelConfigs(ids: readonly string[]) {
  return ids.map((id) => ({
    id,
    name: `${id} (CodeBuddy CLI)`,
    reasoning: id !== "fast-model",
    input: ["text"] as ("text" | "image")[],
    contextWindow: contextWindowFor(id),
    maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

async function discoverCodeBuddyModels(): Promise<string[]> {
  const configuredRaw = process.env.CODEBUDDY_OMP_MODELS?.trim();
  if (configuredRaw) {
    const manual = [...new Set(configuredRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    if (manual.length > 0) {
      lastDiscoveryError = undefined;
      return manual;
    }
  }

  const runtime = resolveCodeBuddyRuntime();
  if ("error" in runtime) {
    lastDiscoveryError = runtime.error;
    return [...FALLBACK_MODELS];
  }

  try {
    const { promise, resolve: resolvePromise, reject: rejectPromise } =
      Promise.withResolvers<{ stdout: string; stderr: string; code: number | null }>();
    const child = spawn(
      runtime.nodeBin,
      [...V8_LOWMEM_FLAGS, runtime.entryScript, "--help"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...LOWMEM_ENV_OVERRIDES },
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`codebuddy --help timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
    }, DISCOVERY_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
    child.on("error", (err) => { clearTimeout(timer); rejectPromise(err); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ stdout, stderr, code }); });

    const output = await promise;
    if (output.code !== 0) {
      throw new Error(output.stderr.trim() || `codebuddy --help exited with code ${output.code}`);
    }

    const match = output.stdout.match(/Currently supported:\s*\(([^)]+)\)/);
    if (!match?.[1]) {
      throw new Error("Could not parse 'Currently supported: (...)' from codebuddy --help");
    }

    const parsed = [
      ...new Set(
        match[1]
          .split(",")
          .map((item) => item.trim())
          .filter((id) => Boolean(id) && !id.includes("/")),
      ),
    ];

    if (parsed.length === 0) {
      throw new Error("Parsed empty native model list from codebuddy --help");
    }

    lastDiscoveryError = undefined;
    return parsed;
  } catch (err) {
    lastDiscoveryError = err instanceof Error ? err.message : String(err);
    return [...FALLBACK_MODELS];
  }
}

function scheduleDaemonIdleStop(daemon: AcpDaemon): void {
  if (daemon.idleTimer) {
    clearTimeout(daemon.idleTimer);
    daemon.idleTimer = undefined;
  }
  if (daemon.activeTurns > 0 || cbDaemon !== daemon) return;

  const envIdle = Number(process.env.CODEBUDDY_OMP_IDLE_MS);
  const idleTimeoutMs = Number.isFinite(envIdle) && envIdle > 0 ? envIdle : 5 * 60_000;
  const timer = setTimeout(() => {
    if (cbDaemon === daemon && daemon.activeTurns === 0) {
      void stopAcpDaemon();
    }
  }, idleTimeoutMs);
  timer.unref?.();
  daemon.idleTimer = timer;
}

async function stopAcpDaemon(): Promise<void> {
  const daemon = cbDaemon;
  cbDaemon = undefined;
  cbDaemonStarting = undefined;
  if (!daemon) return;

  if (daemon.idleTimer) {
    clearTimeout(daemon.idleTimer);
    daemon.idleTimer = undefined;
  }
  daemon.sessionListeners.clear();

  try {
    if (!daemon.proc.killed && daemon.proc.exitCode === null) {
      daemon.proc.stdin.end();
      daemon.proc.kill();
    }
  } catch {
    // Ignore process termination errors
  }

  await rm(daemon.workDir, { recursive: true, force: true }).catch(() => undefined);
}

async function startAcpDaemonInternal(): Promise<AcpDaemon> {
  const runtime = resolveCodeBuddyRuntime();
  if ("error" in runtime) {
    throw new Error(runtime.error);
  }

  const workDir = await mkdtemp(join(tmpdir(), "codebuddy-omp-acp-"));
  const proc = spawn(
    runtime.nodeBin,
    [
      ...V8_LOWMEM_FLAGS,
      runtime.entryScript,
      "--acp",
      "--no-session-persistence",
      "--tools", "",
      "--strict-mcp-config",
      "--mcp-config", "{\"mcpServers\":{}}",
      "--setting-sources", "user",
    ],
    {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...LOWMEM_ENV_OVERRIDES },
    },
  );

  let nextRpcId = 0;
  let stdoutBuffer = "";
  const pendingRequests = new Map<number, PendingRpc>();
  const sessionListeners = new Map<string, (update: AcpSessionUpdate) => void>();

  const writeJsonLine = (payload: unknown): void => {
    if (proc.killed || proc.exitCode !== null || !proc.stdin.writable) {
      throw new Error("CodeBuddy ACP daemon stdin is closed");
    }
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const daemon: AcpDaemon = {
    proc,
    workDir,
    activeTurns: 0,
    stderrTail: "",
    sessionListeners,
    sendRequest<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
      const id = ++nextRpcId;
      const { promise, resolve: resolveReq, reject: rejectReq } = Promise.withResolvers<T>();
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        rejectReq(new Error(`CodeBuddy ACP '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pendingRequests.set(id, {
        resolve: (val) => resolveReq(val as T),
        reject: rejectReq,
        timer,
      });

      try {
        writeJsonLine({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        rejectReq(err instanceof Error ? err : new Error(String(err)));
      }
      return promise;
    },
    sendNotification(method: string, params: unknown): void {
      try {
        writeJsonLine({ jsonrpc: "2.0", method, params });
      } catch {
        // Ignore notification write errors on closing stream
      }
    },
  };

  const failAllPending = (reason: string) => {
    const tail = daemon.stderrTail.trim();
    const detail = tail ? `${reason} | stderr: ${tail.slice(-600)}` : reason;
    for (const [id, pending] of pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pendingRequests.delete(id);
      pending.reject(new Error(detail));
    }
  };

  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdin.on("error", () => { /* handled via exit/close */ });

  proc.stderr.on("data", (chunk: string) => {
    daemon.stderrTail = (daemon.stderrTail + chunk).slice(-STDERR_LIMIT);
  });

  proc.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIdx = stdoutBuffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const rawLine = stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, "").trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
      newlineIdx = stdoutBuffer.indexOf("\n");
      if (!rawLine || !rawLine.startsWith("{")) continue;

      let msg: AcpJsonRpcEnvelope;
      try {
        msg = JSON.parse(rawLine) as AcpJsonRpcEnvelope;
      } catch {
        continue;
      }

      if (msg.id !== undefined && typeof msg.method === "string") {
        try {
          writeJsonLine({
            jsonrpc: "2.0",
            id: msg.id,
            result: { outcome: { outcome: "cancelled" } },
          });
        } catch {
          // Ignore write failures
        }
        continue;
      }

      if (typeof msg.id === "number") {
        const pending = pendingRequests.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);

        if (msg.error && typeof msg.error === "object") {
          const code = typeof msg.error.code === "number" ? msg.error.code : -32000;
          const message = typeof msg.error.message === "string" ? msg.error.message : JSON.stringify(msg.error);
          pending.reject(new AcpRpcError(code, message, msg.error.data));
        } else {
          pending.resolve(msg.result);
        }
        continue;
      }

      if (msg.method === "session/update" && msg.params && typeof msg.params === "object") {
        const sid = msg.params.sessionId;
        const upd = msg.params.update;
        if (typeof sid === "string" && upd && typeof upd === "object") {
          sessionListeners.get(sid)?.(upd);
        }
      }
    }
  });

  proc.on("error", (err) => {
    if (cbDaemon === daemon) cbDaemon = undefined;
    failAllPending(`CodeBuddy ACP process error: ${err.message}`);
    void rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  proc.on("exit", (code, signal) => {
    if (daemon.idleTimer) {
      clearTimeout(daemon.idleTimer);
      daemon.idleTimer = undefined;
    }
    if (cbDaemon === daemon) cbDaemon = undefined;
    failAllPending(`CodeBuddy ACP daemon exited (code=${code}, signal=${signal})`);
    void rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  try {
    await daemon.sendRequest(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {} },
      15_000,
    );
  } catch (err) {
    try { proc.kill(); } catch { /* ignore */ }
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  cbDaemon = daemon;
  if (daemon.activeTurns === 0) {
    scheduleDaemonIdleStop(daemon);
  }
  return daemon;
}

async function ensureAcpDaemon(): Promise<AcpDaemon> {
  if (cbDaemon && !cbDaemon.proc.killed && cbDaemon.proc.exitCode === null) {
    return cbDaemon;
  }
  if (cbDaemonStarting) {
    return cbDaemonStarting;
  }
  cbDaemonStarting = startAcpDaemonInternal().finally(() => {
    cbDaemonStarting = undefined;
  });
  return cbDaemonStarting;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function setEstimatedUsage(output: AssistantMessage, prompt: string, text: string): void {
  if (output.usage.totalTokens > 0) return;
  output.usage.input = Math.max(1, Math.ceil(prompt.length / 4));
  output.usage.output = Math.max(1, Math.ceil(text.length / 4));
  output.usage.totalTokens = output.usage.input + output.usage.output;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentToText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      return `[image omitted: ${item.mimeType}, ${item.data.length} base64 chars]`;
    })
    .join("\n");
}

function serializeMessage(message: Message): string {
  if (message.role === "user") {
    return `USER:\n${contentToText(message.content)}`;
  }
  if (message.role === "toolResult") {
    return [
      `OMP TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content),
    ].join("\n");
  }
  const rawContent = message.content;
  if (typeof rawContent === "string") return `ASSISTANT:\n${rawContent}`;
  if (!Array.isArray(rawContent)) return `ASSISTANT:\n${safeJson(rawContent)}`;
  const parts = rawContent.map((part: unknown) => {
    if (part === null || typeof part !== "object") return String(part);
    if ("type" in part) {
      if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
      if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
        return `<thinking>${part.thinking}</thinking>`;
      }
      if (part.type === "toolCall" && "name" in part && "arguments" in part) {
        return `<omp_tool_call>${JSON.stringify({ name: part.name, arguments: part.arguments })}</omp_tool_call>`;
      }
    }
    return safeJson(part);
  });
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools?: Tool[]): string {
  if (!tools || tools.length === 0) return "No OMP tools are available for this turn.";
  return safeJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

const BRIDGE_RULES = `# OMP/CodeBuddy bridge instructions

You are acting as the LLM backend for Oh My Pi (OMP) coding agent via CodeBuddy CLI.
CodeBuddy internal tools are disabled. Do not attempt to invoke CodeBuddy built-in tools.

OUTPUT RULES:

1. When you need OMP to execute one or more tools, output ONLY tool-call block(s) with no prose before or after:
   <omp_tool_call>{"name":"tool_name","arguments":{...}}</omp_tool_call>
   Start immediately with <omp_tool_call>. Never wrap tool calls in Markdown code fences.

2. Include EVERY required property from the tool's "parameters" schema inside "arguments" (for example, if "i" is in "required", include a concise 2-6 word present-participle intent string in "i").

3. When no tool is needed, reply in plain text with no <omp_tool_call> tags.

4. After receiving OMP TOOL RESULT entries in the transcript, either emit the next <omp_tool_call> or provide the final answer in plain text.`;

function buildSystemInstruction(context: Context): string {
  const sysPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n").trim()
    : (context.systemPrompt ?? "").trim();
  return sysPrompt ? `${BRIDGE_RULES}\n\n---\n\n# OMP system prompt\n\n${sysPrompt}` : BRIDGE_RULES;
}

function buildConversationPayload(context: Context): string {
  const sections: string[] = [
    `# Available OMP tools\n\n${serializeTools(context.tools)}`,
    context.messages.length > 0
      ? `# Conversation transcript\n\n${context.messages.map(serializeMessage).join("\n\n---\n\n")}`
      : "# Conversation transcript\n\n(no prior messages)",
    "Now produce the next assistant response for OMP.",
  ];
  return sections.join("\n\n---\n\n");
}

function parseToolCallJson(raw: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    return [];
  }

  let candidates: unknown[];
  if (Array.isArray(value)) {
    candidates = value;
  } else if (value !== null && typeof value === "object" && "tool_calls" in value && Array.isArray(value.tool_calls)) {
    candidates = value.tool_calls;
  } else {
    candidates = [value];
  }

  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    let name: string | undefined;
    if ("name" in candidate && typeof candidate.name === "string") name = candidate.name;
    else if ("tool" in candidate && typeof candidate.tool === "string") name = candidate.tool;
    if (!name) continue;

    let args: unknown = {};
    if ("arguments" in candidate) args = candidate.arguments;
    else if ("args" in candidate) args = candidate.args;
    else if ("input" in candidate) args = candidate.input;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { continue; }
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) continue;
    calls.push({ name, arguments: args as Record<string, unknown> });
  }
  return calls;
}

function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const trimmed = text.trim();
  const tagRegex = /<omp_tool_call>([\s\S]*?)<\/omp_tool_call>/g;
  const matches = [...trimmed.matchAll(tagRegex)];
  if (matches.length > 0) {
    return matches.flatMap((m) => parseToolCallJson(m[1] ?? ""));
  }
  return parseToolCallJson(trimmed);
}

function formatErrorWithAuthHint(err: unknown, stderrTail?: string): string {
  const base = err instanceof Error ? err.message : String(err);
  const stderr = stderrTail?.trim() ?? "";
  const combined = `${base} ${stderr}`;
  if (AUTH_ERROR_RE.test(combined)) {
    const snippet = stderr && !base.includes(stderr.slice(-200)) ? ` [stderr: ${stderr.slice(-400)}]` : "";
    return `${base}${snippet}\nEnsure CodeBuddy CLI is authenticated (run 'codebuddy' in terminal and sign in).`;
  }
  return base;
}

interface TurnStreamHandlers {
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onUsage: (input: number, output: number, cacheRead?: number) => void;
}

async function runOneShotPrintFallback(
  modelId: string,
  context: Context,
  effort: string | undefined,
  signal: AbortSignal | undefined,
  handlers: TurnStreamHandlers,
): Promise<void> {
  const runtime = resolveCodeBuddyRuntime();
  if ("error" in runtime) {
    throw new Error(runtime.error);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), "codebuddy-omp-fallback-"));
  const sysPromptPath = join(tmpDir, "system-prompt.txt");
  await writeFile(sysPromptPath, buildSystemInstruction(context), "utf8");
  const stdinPrompt = buildConversationPayload(context);

  try {
    const { promise, resolve: resolveRun, reject: rejectRun } = Promise.withResolvers<void>();
    const args = [
      ...V8_LOWMEM_FLAGS,
      runtime.entryScript,
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--no-session-persistence",
      "--tools", "",
      "--strict-mcp-config",
      "--mcp-config", "{\"mcpServers\":{}}",
      "--setting-sources", "user",
      "--system-prompt-file", sysPromptPath,
      "--model", modelId,
      ...(effort ? ["--effort", effort] : []),
    ];

    const child = spawn(runtime.nodeBin, args, {
      cwd: tmpDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...LOWMEM_ENV_OVERRIDES },
    });

    let stderr = "";
    let stdoutBuf = "";
    let sawPartialText = false;
    let sawPartialThinking = false;
    let sawAssistantText = false;

    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      rejectRun(new Error("Request was aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return await promise;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });

    const handleJsonLine = (line: string) => {
      if (!line.startsWith("{")) return;
      let obj: StreamJsonLine;
      try {
        obj = JSON.parse(line) as StreamJsonLine;
      } catch {
        return;
      }

      if (obj.type === "stream_event" && obj.event?.delta) {
        const delta = obj.event.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          sawPartialText = true;
          handlers.onTextDelta(delta.text);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          sawPartialThinking = true;
          handlers.onThinkingDelta(delta.thinking);
        }
        return;
      }

      if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string" && !sawPartialText) {
            sawAssistantText = true;
            handlers.onTextDelta(block.text);
          } else if (block.type === "thinking" && typeof block.thinking === "string" && !sawPartialThinking) {
            handlers.onThinkingDelta(block.thinking);
          }
        }
        return;
      }

      if (obj.type === "result") {
        const usage = obj.usage;
        if (usage && (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number")) {
          handlers.onUsage(
            usage.input_tokens ?? 0,
            usage.output_tokens ?? 0,
            usage.cache_read_input_tokens ?? 0,
          );
        }
        if (obj.is_error) {
          const errMsg =
            typeof obj.result === "string" && obj.result.trim()
              ? obj.result
              : Array.isArray(obj.errors) && obj.errors.length > 0
                ? obj.errors.map(String).join("; ")
                : "CodeBuddy returned an error result";
          rejectRun(new Error(formatErrorWithAuthHint(errMsg, stderr)));
          return;
        }
        if (!sawPartialText && !sawAssistantText && typeof obj.result === "string" && obj.result) {
          handlers.onTextDelta(obj.result);
        }
      }
    };

    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, "").trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        idx = stdoutBuf.indexOf("\n");
        if (line) handleJsonLine(line);
      }
    });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      rejectRun(new Error(formatErrorWithAuthHint(err, stderr)));
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      const rem = stdoutBuf.trim();
      if (rem) handleJsonLine(rem);
      if (signal?.aborted) {
        rejectRun(new Error("Request was aborted"));
        return;
      }
      if (code !== 0) {
        rejectRun(
          new Error(
            formatErrorWithAuthHint(
              stderr.trim() || `CodeBuddy fallback exited with code ${code}`,
              stderr,
            ),
          ),
        );
        return;
      }
      resolveRun();
    });

    child.stdin.end(stdinPrompt);
    await promise;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function streamCodeBuddy(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const hasTool = (context.tools?.length ?? 0) > 0;
    const allowedToolNames = new Set((context.tools ?? []).map((t) => t.name));
    const fullPrompt = `${buildSystemInstruction(context)}\n\n---\n\n${buildConversationPayload(context)}`;
    const disableReasoning = options !== undefined && "disableReasoning" in options && Boolean(options.disableReasoning);
    const effort = disableReasoning ? undefined : options?.reasoning;

    const st = {
      textMode: (hasTool ? "gating" : "streaming") as "gating" | "streaming" | "buffered",
      gateBuffer: "",
      textContentIndex: -1,
    };

    let activeThinkingBlock: ThinkingContent | undefined;
    let activeTextBlock: TextContent | undefined;
    let reasoningContentIndex = -1;
    let accumulatedText = "";
    let emittedAnyContent = false;

    const handleThinkingDelta = (delta: string): void => {
      if (!delta) return;
      emittedAnyContent = true;
      if (!activeThinkingBlock) {
        activeThinkingBlock = { type: "thinking", thinking: "" };
        reasoningContentIndex = output.content.length;
        output.content.push(activeThinkingBlock);
        stream.push({ type: "thinking_start", contentIndex: reasoningContentIndex, partial: output });
      }
      activeThinkingBlock.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex: reasoningContentIndex, delta, partial: output });
    };

    const handleTextDelta = (delta: string): void => {
      if (!delta) return;
      emittedAnyContent = true;
      accumulatedText += delta;

      if (hasTool) {
        if (st.textMode === "buffered") return;
        if (st.textMode === "gating") {
          st.gateBuffer += delta;
          const trimmedStart = st.gateBuffer.trimStart();
          if (!trimmedStart) return;
          const first = trimmedStart[0];
          if (first === "<" || first === "{" || first === "[" || first === "`" || trimmedStart.includes("<omp_tool_call>")) {
            st.textMode = "buffered";
            return;
          }
          if (trimmedStart.length < 48) return;
          st.textMode = "buffered";
          return;
        }
      }

      if (!activeTextBlock) {
        activeTextBlock = { type: "text", text: "" };
        st.textContentIndex = output.content.length;
        output.content.push(activeTextBlock);
        stream.push({ type: "text_start", contentIndex: st.textContentIndex, partial: output });
      }
      activeTextBlock.text += delta;
      stream.push({ type: "text_delta", contentIndex: st.textContentIndex, delta, partial: output });
    };

    const handleUsage = (input: number, out: number, cacheRead = 0): void => {
      output.usage.input = input;
      output.usage.output = out;
      output.usage.cacheRead = cacheRead;
      output.usage.totalTokens = input + out + cacheRead;
    };

    const handlers: TurnStreamHandlers = {
      onTextDelta: handleTextDelta,
      onThinkingDelta: handleThinkingDelta,
      onUsage: handleUsage,
    };

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      let runFallback = false;
      let daemonRef: AcpDaemon | undefined;
      try {
        const daemon = await ensureAcpDaemon();
        daemonRef = daemon;
        daemon.activeTurns += 1;
        if (daemon.idleTimer) {
          clearTimeout(daemon.idleTimer);
          daemon.idleTimer = undefined;
        }

        let sessionId: string | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const sess = await daemon.sendRequest<{
            sessionId: string;
            configOptions?: Array<{ id: string }>;
          }>("session/new", { cwd: daemon.workDir, mcpServers: [] }, 15_000);
          sessionId = sess.sessionId;

          try {
            await daemon.sendRequest(
              "session/set_model",
              { sessionId: sess.sessionId, modelId: model.id },
              10_000,
            );
          } catch (setModelErr) {
            if (setModelErr instanceof AcpRpcError && setModelErr.code === -32601) {
              await daemon.sendRequest(
                "session/set_config_option",
                { sessionId: sess.sessionId, configId: "model", value: model.id },
                10_000,
              );
            } else {
              throw setModelErr;
            }
          }

          if (effort && Array.isArray(sess.configOptions)) {
            const effortOpt = sess.configOptions.find(
              (opt) => opt.id === "effort" || opt.id === "reasoning_effort",
            );
            if (effortOpt) {
              await daemon
                .sendRequest(
                  "session/set_config_option",
                  { sessionId: sess.sessionId, configId: effortOpt.id, value: effort },
                  5_000,
                )
                .catch(() => undefined);
            }
          }

          daemon.sessionListeners.set(sess.sessionId, (update) => {
            const kind = update.sessionUpdate;
            const content = update.content;
            if (
              kind === "agent_message_chunk" &&
              (content?.type === "text" || content?.type === undefined) &&
              typeof content?.text === "string"
            ) {
              handleTextDelta(content.text);
              return;
            }
            if (
              kind === "agent_thought_chunk" &&
              (content?.type === "text" || content?.type === undefined) &&
              typeof content?.text === "string"
            ) {
              handleThinkingDelta(content.text);
              return;
            }
            if (kind === "usage_update") {
              const u = update.usage ?? update;
              const inp = Number(u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? u.used ?? 0);
              const out = Number(u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? 0);
              if (inp > 0 || out > 0) {
                handleUsage(inp, out, Number(u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0));
              }
            }
          });

          const { promise: abortPromise, reject: rejectAbort } = Promise.withResolvers<never>();
          onAbort = () => {
            if (sessionId) {
              daemon.sendNotification("session/cancel", { sessionId });
            }
            rejectAbort(new Error("Request was aborted"));
          };
          if (options?.signal?.aborted) {
            onAbort();
          } else {
            options?.signal?.addEventListener("abort", onAbort, { once: true });
          }

          await Promise.race([
            daemon.sendRequest(
              "session/prompt",
              { sessionId: sess.sessionId, prompt: [{ type: "text", text: fullPrompt }] },
              300_000,
            ),
            abortPromise,
          ]);
        } finally {
          if (onAbort) {
            options?.signal?.removeEventListener("abort", onAbort);
          }
          if (sessionId) {
            daemon.sessionListeners.delete(sessionId);
            await daemon
              .sendRequest("session/close", { sessionId }, 5_000)
              .catch(() => undefined);
          }
          daemon.activeTurns = Math.max(0, daemon.activeTurns - 1);
          if (daemon.activeTurns === 0 && cbDaemon === daemon) {
            scheduleDaemonIdleStop(daemon);
          }
        }
      } catch (acpErr) {
        const errMsg = formatErrorWithAuthHint(acpErr, daemonRef?.stderrTail);
        if (options?.signal?.aborted || AUTH_ERROR_RE.test(errMsg) || emittedAnyContent) {
          throw new Error(errMsg);
        }
        runFallback = true;
      }

      if (runFallback) {
        await runOneShotPrintFallback(model.id, context, effort, options?.signal, handlers);
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      setEstimatedUsage(output, fullPrompt, accumulatedText);

      if (activeThinkingBlock && reasoningContentIndex !== -1) {
        stream.push({
          type: "thinking_end",
          contentIndex: reasoningContentIndex,
          content: activeThinkingBlock.thinking,
          partial: output,
        });
      }

      const parsedCalls = hasTool
        ? parseToolCalls(accumulatedText).filter((call) => allowedToolNames.has(call.name))
        : [];

      if (parsedCalls.length > 0) {
        if (activeTextBlock && st.textContentIndex !== -1) {
          stream.push({
            type: "text_end",
            contentIndex: st.textContentIndex,
            content: activeTextBlock.text,
            partial: output,
          });
        }
        output.stopReason = "toolUse";
        for (const call of parsedCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `codebuddy_omp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments,
          };
          const contentIndex = output.content.length;
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex, delta: safeJson(toolCall.arguments), partial: output });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      if (activeTextBlock && st.textContentIndex !== -1) {
        stream.push({
          type: "text_end",
          contentIndex: st.textContentIndex,
          content: activeTextBlock.text,
          partial: output,
        });
      } else {
        const finalTextBlock: TextContent = { type: "text", text: accumulatedText };
        st.textContentIndex = output.content.length;
        output.content.push(finalTextBlock);
        stream.push({ type: "text_start", contentIndex: st.textContentIndex, partial: output });
        if (accumulatedText) {
          stream.push({
            type: "text_delta",
            contentIndex: st.textContentIndex,
            delta: accumulatedText,
            partial: output,
          });
        }
        stream.push({
          type: "text_end",
          contentIndex: st.textContentIndex,
          content: accumulatedText,
          partial: output,
        });
      }

      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function getDelegateModeArgs(mode: DelegateMode): string[] {
  switch (mode) {
    case "readonly":
      return ["-y", "--permission-mode", "bypassPermissions", "--tools", "Read,Glob,Grep"];
    case "edit":
      return ["-y", "--permission-mode", "acceptEdits", "--tools", "Read,Write,Edit,Glob,Grep"];
    case "full":
      return ["-y", "--permission-mode", "bypassPermissions", "--tools", "default"];
  }
}

async function runCodeBuddyDelegate(opts: DelegateRunOptions): Promise<DelegateRunResult> {
  const runtime = resolveCodeBuddyRuntime();
  if ("error" in runtime) {
    throw new Error(runtime.error);
  }
  if (!existsSync(opts.cwd)) {
    throw new Error(`Working directory not found: ${opts.cwd}`);
  }

  const startedAt = Date.now();
  const modeArgs = getDelegateModeArgs(opts.mode);
  const args = [
    ...V8_LOWMEM_FLAGS,
    runtime.entryScript,
    "-p",
    "--output-format", "stream-json",
    "--no-session-persistence",
    ...modeArgs,
    "--max-turns", String(opts.maxTurns),
    "--model", opts.model,
    ...(opts.effort ? ["--effort", opts.effort] : []),
  ];

  const { promise, resolve: resolveDelegate, reject: rejectDelegate } =
    Promise.withResolvers<DelegateRunResult>();

  const child = spawn(runtime.nodeBin, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...LOWMEM_ENV_OVERRIDES },
  });

  let stdoutBuf = "";
  let stderr = "";
  let toolUseCount = 0;
  let durationMs = 0;
  let costUsd = 0;
  let resultText = "";
  const assistantTextChunks: string[] = [];

  const onAbort = () => {
    try { child.kill(); } catch { /* ignore */ }
    rejectDelegate(new Error("CodeBuddy delegate cancelled"));
  };
  if (opts.signal?.aborted) {
    onAbort();
    return promise;
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });

  const processLine = (line: string) => {
    if (!line.startsWith("{")) return;
    let obj: StreamJsonLine;
    try {
      obj = JSON.parse(line) as StreamJsonLine;
    } catch {
      return;
    }

    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use" && typeof block.name === "string") {
          toolUseCount += 1;
          opts.onToolUse?.(toolUseCount, block.name.trim() || "tool");
        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          assistantTextChunks.push(block.text);
        }
      }
      return;
    }

    if (obj.type === "result") {
      if (typeof obj.duration_ms === "number") durationMs = obj.duration_ms;
      if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
      if (obj.is_error) {
        const errMsg =
          typeof obj.result === "string" && obj.result.trim()
            ? obj.result
            : Array.isArray(obj.errors) && obj.errors.length > 0
              ? obj.errors.map(String).join("; ")
              : "CodeBuddy delegate returned an error";
        rejectDelegate(new Error(formatErrorWithAuthHint(errMsg, stderr)));
        return;
      }
      if (typeof obj.result === "string" && obj.result.trim()) {
        resultText = obj.result;
      }
    }
  };

  child.stdout.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx = stdoutBuf.indexOf("\n");
    while (idx !== -1) {
      const line = stdoutBuf.slice(0, idx).replace(/\r$/, "").trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      idx = stdoutBuf.indexOf("\n");
      if (line) processLine(line);
    }
  });

  child.on("error", (err) => {
    opts.signal?.removeEventListener("abort", onAbort);
    rejectDelegate(new Error(formatErrorWithAuthHint(err, stderr)));
  });

  child.on("close", (code) => {
    opts.signal?.removeEventListener("abort", onAbort);
    const rem = stdoutBuf.trim();
    if (rem) processLine(rem);

    if (opts.signal?.aborted) {
      rejectDelegate(new Error("CodeBuddy delegate cancelled"));
      return;
    }
    if (code !== 0 && !resultText && assistantTextChunks.length === 0) {
      rejectDelegate(
        new Error(
          formatErrorWithAuthHint(
            stderr.trim() || `CodeBuddy delegate exited with code ${code}`,
            stderr,
          ),
        ),
      );
      return;
    }

    const finalText = resultText || assistantTextChunks.join("\n\n").trim() || "(no text output)";
    resolveDelegate({
      text: finalText,
      mode: opts.mode,
      model: opts.model,
      durationMs: durationMs || Date.now() - startedAt,
      costUsd,
      toolUseCount,
    });
  });

  child.stdin.end(opts.task);
  return promise;
}

function parseCodeBuddyRunArgs(rawArgs: string): {
  mode: DelegateMode;
  model: string;
  prompt: string;
} {
  let mode: DelegateMode = "readonly";
  let model = process.env.CODEBUDDY_OMP_AGENT_MODEL?.trim() || "deepseek-v4.1-flash";
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  let idx = 0;

  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok === "--edit") {
      mode = "edit";
      idx += 1;
      continue;
    }
    if (tok === "--full") {
      mode = "full";
      idx += 1;
      continue;
    }
    if (tok === "--model" && idx + 1 < tokens.length) {
      model = tokens[idx + 1]!;
      idx += 2;
      continue;
    }
    if (tok.startsWith("--model=")) {
      model = tok.slice("--model=".length) || model;
      idx += 1;
      continue;
    }
    break;
  }

  const prompt = tokens.slice(idx).join(" ").trim();
  return { mode, model, prompt };
}

async function execGatewayControl(subcommand: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const bunBin = resolveBunBinary();
  const scriptPath = resolveGatewayControlScript();
  const { promise, resolve: resolveCmd, reject: rejectCmd } =
    Promise.withResolvers<{ stdout: string; stderr: string; code: number | null }>();

  const child = spawn(bunBin, [scriptPath, subcommand], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
    rejectCmd(new Error(`omp-gateway ${subcommand} timed out after 25s`));
  }, 25_000);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => { stdout += c; });
  child.stderr.on("data", (c: string) => { stderr += c; });
  child.on("error", (err) => { clearTimeout(timer); rejectCmd(err); });
  child.on("close", (code) => { clearTimeout(timer); resolveCmd({ stdout, stderr, code }); });
  return promise;
}

process.once("exit", () => {
  if (cbDaemon?.idleTimer) {
    clearTimeout(cbDaemon.idleTimer);
  }
  try {
    cbDaemon?.proc.kill();
  } catch {
    // Ignore on exit
  }
});

export default async function codeBuddyOmpExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  registeredModels = await discoverCodeBuddyModels();

  const registerCurrentProvider = (models: readonly string[]) => {
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "cli:codebuddy-acp",
      apiKey: "codebuddy-cli-local-auth",
      api: API_ID,
      models: buildProviderModelConfigs(models),
      streamSimple: streamCodeBuddy,
    });
  };

  registerCurrentProvider(registeredModels);

  pi.on("session_start", async () => {
    const gatewayScript = resolveGatewayControlScript();
    if (process.env.OMP_GATEWAY_AUTOSTART === "1" && existsSync(gatewayScript)) {
      void execGatewayControl("start").catch(() => undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    await stopAcpDaemon();
  });

  pi.registerTool({
    name: "codebuddy_delegate",
    label: "CodeBuddy Sub-Agent",
    description:
      "Delegate a self-contained coding or analysis task to an autonomous CodeBuddy CLI sub-agent running in low-memory mode.",
    loadMode: "essential",
    approval: "exec",
    parameters: z.object({
      task: z.string().min(1).describe("Self-contained task instructions for the CodeBuddy CLI sub-agent"),
      mode: z
        .enum(["readonly", "edit", "full"])
        .optional()
        .describe(
          "Permission scope: readonly (default, Read/Glob/Grep only), edit (acceptEdits + Read/Write/Edit/Glob/Grep), full (bypassPermissions + all default tools)",
        ),
      model: z
        .string()
        .optional()
        .describe("CodeBuddy model ID, e.g. deepseek-v4.1-flash (x0.00 free), hy3 (x0.00 free), glm-5.3 (default: deepseek-v4.1-flash)"),
      effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
      maxTurns: z.number().int().min(1).max(50).optional().describe("Maximum agentic turns (default: 15)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory path (relative to current session cwd or absolute)"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const mode: DelegateMode = params.mode ?? "readonly";
      const model =
        params.model?.trim() ||
        process.env.CODEBUDDY_OMP_AGENT_MODEL?.trim() ||
        "deepseek-v4.1-flash";
      const targetCwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      if (!existsSync(targetCwd)) {
        throw new Error(`Working directory not found: ${targetCwd}`);
      }

      const res = await runCodeBuddyDelegate({
        task: params.task,
        mode,
        model,
        effort: params.effort,
        maxTurns: params.maxTurns ?? 15,
        cwd: targetCwd,
        signal,
        onToolUse(toolUseCount, toolName) {
          onUpdate?.({
            content: [{ type: "text", text: `[CodeBuddy ${mode}] tool #${toolUseCount}: ${toolName}` }],
            details: { mode, model, toolUseCount },
          });
        },
      });

      return {
        content: [{ type: "text", text: res.text }],
        details: {
          mode: res.mode,
          model: res.model,
          durationMs: res.durationMs,
          costUsd: res.costUsd,
          toolUseCount: res.toolUseCount,
        },
      };
    },
  });

  pi.registerCommand("codebuddy", {
    description: "CodeBuddy ACP provider status, models, quota, refresh, restart, and sub-agent runner",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const firstSpace = trimmed.search(/\s/);
      const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)) || "status";
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      if (sub === "status") {
        const runtime = resolveCodeBuddyRuntime();
        const daemonStatus =
          cbDaemon && !cbDaemon.proc.killed && cbDaemon.proc.exitCode === null
            ? `running (pid ${cbDaemon.proc.pid}, activeTurns=${cbDaemon.activeTurns})`
            : "idle (0 MB)";
        const lines = [
          `Provider: ${PROVIDER_ID}`,
          "error" in runtime
            ? `Runtime: ERROR (${runtime.error})`
            : `Node binary: ${runtime.nodeBin}\nEntry script: ${runtime.entryScript}`,
          `ACP daemon: ${daemonStatus}`,
          `Registered models: ${registeredModels.length}`,
        ];
        if (lastDiscoveryError) {
          lines.push(`Discovery note: ${lastDiscoveryError}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "models") {
        const lines = registeredModels.map((id) => `  ${PROVIDER_ID}/${id}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "quota") {
        try {
          const res = await execGatewayControl("quota");
          ctx.ui.notify((res.stdout.trim() || res.stderr.trim() || "No quota output").trim(), "info");
        } catch (err) {
          ctx.ui.notify(`Quota check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      if (sub === "refresh") {
        registeredModels = await discoverCodeBuddyModels();
        try {
          registerCurrentProvider(registeredModels);
        } catch {
          // Ignore duplicate registration notice if unchanged
        }
        const msg = lastDiscoveryError
          ? `codebuddy-cli: registered ${registeredModels.length} fallback models (${lastDiscoveryError})`
          : `codebuddy-cli: refreshed ${registeredModels.length} native models.`;
        ctx.ui.notify(msg, lastDiscoveryError ? "warning" : "info");
        return;
      }

      if (sub === "restart") {
        await stopAcpDaemon();
        try {
          const daemon = await ensureAcpDaemon();
          ctx.ui.notify(`CodeBuddy ACP daemon restarted (pid ${daemon.proc.pid}).`, "info");
        } catch (err) {
          ctx.ui.notify(
            `Failed to start CodeBuddy ACP daemon: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
        return;
      }

      if (sub === "run") {
        const parsed = parseCodeBuddyRunArgs(rest);
        if (!parsed.prompt) {
          ctx.ui.notify("Usage: /codebuddy run [--edit|--full] [--model <id>] <prompt>", "warning");
          return;
        }
        ctx.ui.notify(
          `Running CodeBuddy sub-agent (mode=${parsed.mode}, model=${parsed.model})...`,
          "info",
        );
        try {
          const res = await runCodeBuddyDelegate({
            task: parsed.prompt,
            mode: parsed.mode,
            model: parsed.model,
            maxTurns: 15,
            cwd: ctx.cwd,
          });
          const formattedResult = [
            `[CodeBuddy Sub-Agent | mode=${res.mode} | model=${res.model} | tools=${res.toolUseCount} | ${(res.durationMs / 1000).toFixed(1)}s]`,
            "",
            res.text,
          ].join("\n");
          pi.sendMessage(
            {
              customType: "codebuddy-delegate",
              content: formattedResult,
              display: true,
              attribution: "user",
            },
            { triggerTurn: false },
          );
        } catch (err) {
          ctx.ui.notify(
            `CodeBuddy run failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
        return;
      }

      ctx.ui.notify(
        "Usage: /codebuddy [status|models|quota|refresh|restart|run [--edit|--full] [--model <id>] <prompt>]",
        "warning",
      );
    },
  });

  pi.registerCommand("omp-gateway", {
    description: "Control on-demand OMP Auth Broker + Auth Gateway (status|start|stop|restart|sync|quota)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (!["status", "start", "stop", "restart", "sync", "quota"].includes(sub)) {
        ctx.ui.notify("Usage: /omp-gateway [status|start|stop|restart|sync|quota]", "warning");
        return;
      }
      const gatewayScript = resolveGatewayControlScript();
      if (!existsSync(gatewayScript)) {
        ctx.ui.notify(`Gateway script not found: ${gatewayScript}`, "error");
        return;
      }
      try {
        const res = await execGatewayControl(sub);
        const text = (res.stdout.trim() || res.stderr.trim() || `omp-gateway ${sub} exited (${res.code})`).trim();
        ctx.ui.notify(text, res.code === 0 ? "info" : "error");
      } catch (err) {
        ctx.ui.notify(
          `omp-gateway ${sub} failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
