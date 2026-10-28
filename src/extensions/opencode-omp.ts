import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  resolveBridgePaths,
  resolveBunBinary,
  resolveGatewayControlScript,
  resolveOpenCodeBinary,
} from "../shared/paths.ts";

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner" as Api;
const AGENT_ID = "omp-model";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const SERVER_START_TIMEOUT_MS = 12_000;
const STDERR_LIMIT = 16_000;

const DEFAULT_FREE_MODELS = [
  "opencode/deepseek-v4.1-flash-free",
  "opencode/glm-5.3-flash-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/big-pickle",
];

const DISABLED_TOOLS: Record<string, false> = {
  bash: false, edit: false, read: false, glob: false, grep: false,
  list: false, task: false, webfetch: false, websearch: false, todowrite: false,
};

interface OcServer {
  url: string;
  proc: ChildProcess;
}

interface SseEventEnvelope {
  type?: string;
  properties?: Record<string, unknown>;
}

let registeredModels: string[] = [];
let lastDiscoveryError: string | undefined;
let ocAgentDir: string | undefined;
let ocServer: OcServer | undefined;

function getOpenCodeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCODE_DISABLE_UPDATE_CHECK: "1",
    OPENCODE_CONFIG_CONTENT: "{\"plugin\":[],\"mcp\":{\"figma\":{\"enabled\":false}}}",
  };
}

function runOpenCodeCapture(
  args: string[],
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const bin = resolveOpenCodeBinary() ?? "opencode";
  const { promise, resolve, reject } =
    Promise.withResolvers<{ stdout: string; stderr: string; code: number | null }>();

  const child = spawn(bin, ["--pure", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: getOpenCodeEnv(),
  });

  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error(`opencode timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
  child.on("error", (err) => { clearTimeout(timer); reject(err); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
  return promise;
}

async function discoverOpenCodeModels(): Promise<string[]> {
  const raw = process.env.OPENCODE_OMP_MODELS?.trim();
  if (raw) {
    const manual = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((m) => (m.includes("/") ? m : `opencode/${m}`));
    if (manual.length > 0) {
      lastDiscoveryError = undefined;
      return [...new Set(manual)];
    }
  }

  try {
    const res = await runOpenCodeCapture(["models", "opencode"]);
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || `opencode models exited with code ${res.code}`);
    }
    const found = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("opencode/"))
      .filter((m) => /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(m));
    lastDiscoveryError = undefined;
    return [...new Set(found.length > 0 ? found : DEFAULT_FREE_MODELS)];
  } catch (err) {
    lastDiscoveryError = err instanceof Error ? err.message : String(err);
    return [...DEFAULT_FREE_MODELS];
  }
}

const AGENT_INSTRUCTIONS = `---
description: Text-only OMP bridge agent. OpenCode tools are denied; OMP tool calls are emitted as text markers.
mode: primary
permission:
  read: deny
  edit: deny
  glob: deny
  grep: deny
  list: deny
  bash: deny
  task: deny
  external_directory: deny
  todowrite: deny
  webfetch: deny
  websearch: deny
  lsp: deny
  skill: deny
  question: deny
  doom_loop: deny
---
You are the OpenCode side of an OMP coding agent bridge. OpenCode tools are disabled. Reply in plain text, or emit <omp_tool_call>{"name":"...","arguments":{...}}</omp_tool_call> when requesting an OMP tool.
`;

async function ensureServer(): Promise<string> {
  if (ocServer) return ocServer.url;

  if (!ocAgentDir) {
    const dir = await mkdtemp(join(tmpdir(), "opencode-omp-"));
    await mkdir(join(dir, ".opencode", "agents"), { recursive: true });
    await writeFile(join(dir, ".opencode", "agents", `${AGENT_ID}.md`), AGENT_INSTRUCTIONS, "utf8");
    ocAgentDir = dir;
  }

  const bin = resolveOpenCodeBinary() ?? "opencode";
  const port = 49000 + Math.floor(Math.random() * 5000);
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  const proc = spawn(bin, ["serve", "--pure", `--port=${port}`], {
    cwd: ocAgentDir,
    windowsHide: true,
    env: getOpenCodeEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.unref?.();

  const timer = setTimeout(() => {
    proc.kill();
    reject(new Error(`opencode serve start timeout after ${SERVER_START_TIMEOUT_MS}ms`));
  }, SERVER_START_TIMEOUT_MS);

  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    const match = chunk.match(/on\s+(https?:\/\/[^\s]+)/);
    if (match?.[1]) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  proc.on("exit", () => { ocServer = undefined; });

  const url = await promise;
  ocServer = { url, proc };
  return url;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function contentToText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => (item.type === "text" ? item.text : `[image omitted: ${item.mimeType}, ${item.data.length} base64 chars]`))
    .join("\n");
}

function serializeMessage(message: Message): string {
  if (message.role === "user") return `USER:\n${contentToText(message.content)}`;
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
        return `<omp_tool_call>${safeJson({ name: part.name, arguments: part.arguments })}</omp_tool_call>`;
      }
    }
    return safeJson(part);
  });
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function buildPrompt(context: Context): string {
  const sysPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n").trim()
    : (context.systemPrompt ?? "").trim();
  const toolsJson = !context.tools || context.tools.length === 0
    ? "No OMP tools are available for this turn."
    : safeJson(context.tools.map((t: Tool) => ({ name: t.name, description: t.description, parameters: t.parameters })));

  return [
    `# OMP/OpenCode bridge instructions\n\nReply in plain text, or emit ONLY <omp_tool_call>{"name":"tool_name","arguments":{...}}</omp_tool_call> with all required schema fields when calling an OMP tool.`,
    ...(sysPrompt ? [`# OMP system prompt\n\n${sysPrompt}`] : []),
    `# Available OMP tools\n\n${toolsJson}`,
    context.messages.length > 0
      ? `# Conversation transcript\n\n${context.messages.map(serializeMessage).join("\n\n---\n\n")}`
      : "# Conversation transcript\n\n(no prior messages)",
    "Now produce the next assistant message for OMP.",
  ].join("\n\n---\n\n");
}

function parseToolCalls(text: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const trimmed = text.trim();
  const matches = [...trimmed.matchAll(/<omp_tool_call>([\s\S]*?)<\/omp_tool_call>/g)];
  const rawList = matches.length > 0 ? matches.map((m) => m[1] ?? "") : [trimmed];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const raw of rawList) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw.trim()); } catch { continue; }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const name = "name" in c && typeof c.name === "string" ? c.name : undefined;
      const args = "arguments" in c && c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments)
        ? (c.arguments as Record<string, unknown>)
        : undefined;
      if (name && args) calls.push({ name, arguments: args });
    }
  }
  return calls;
}

function parseSseBlocks(raw: string): Array<{ type: string; properties: Record<string, unknown> }> {
  const events: Array<{ type: string; properties: Record<string, unknown> }> = [];
  for (const block of raw.split(/\n\n/)) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try {
      const ev = JSON.parse(dataLine.slice(5).trim()) as SseEventEnvelope;
      if (typeof ev.type === "string") {
        events.push({ type: ev.type, properties: ev.properties ?? {} });
      }
    } catch { /* skip malformed */ }
  }
  return events;
}

function streamOpenCode(
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
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    const hasTool = (context.tools?.length ?? 0) > 0;
    const allowedTools = new Set((context.tools ?? []).map((t) => t.name));
    const prompt = buildPrompt(context);
    let sessionId: string | undefined;
    let sseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let accumulatedText = "";
    let activeTextBlock: TextContent | undefined;
    let activeThinkingBlock: ThinkingContent | undefined;
    let textIdx = -1;
    let thinkingIdx = -1;
    const assistantMsgIds = new Set<string>();
    const partTextById = new Map<string, string>();

    const pushText = (delta: string) => {
      if (!delta) return;
      accumulatedText += delta;
      if (hasTool) return;
      if (!activeTextBlock) {
        activeTextBlock = { type: "text", text: "" };
        textIdx = output.content.length;
        output.content.push(activeTextBlock);
        stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
      }
      activeTextBlock.text += delta;
      stream.push({ type: "text_delta", contentIndex: textIdx, delta, partial: output });
    };

    const pushThinking = (delta: string) => {
      if (!delta) return;
      if (!activeThinkingBlock) {
        activeThinkingBlock = { type: "thinking", thinking: "" };
        thinkingIdx = output.content.length;
        output.content.push(activeThinkingBlock);
        stream.push({ type: "thinking_start", contentIndex: thinkingIdx, partial: output });
      }
      activeThinkingBlock.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex: thinkingIdx, delta, partial: output });
    };

    try {
      stream.push({ type: "start", partial: output });
      const baseUrl = await ensureServer();
      const sessResp = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!sessResp.ok) throw new Error(`OpenCode session create failed: ${sessResp.status}`);
      const sessJson = (await sessResp.json()) as { id: string };
      sessionId = sessJson.id;

      const sseAbort = new AbortController();
      const onAbort = () => sseAbort.abort();
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const evtResp = await fetch(`${baseUrl}/event`, { signal: sseAbort.signal });
      sseReader = evtResp.body?.getReader();
      if (!sseReader) throw new Error("Failed to open OpenCode SSE stream");

      const slashIdx = model.id.indexOf("/");
      const providerID = slashIdx >= 0 ? model.id.slice(0, slashIdx) : model.id;
      const modelID = slashIdx >= 0 ? model.id.slice(slashIdx + 1) : model.id;

      const promptResp = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: { providerID, modelID },
          agent: AGENT_ID,
          tools: DISABLED_TOOLS,
          parts: [{ type: "text", text: prompt }],
        }),
      });
      if (!promptResp.ok) throw new Error(`OpenCode prompt_async failed: ${promptResp.status}`);

      const dec = new TextDecoder();
      let sseRemainder = "";
      let done = false;

      while (!done) {
        if (options?.signal?.aborted) throw new Error("Request was aborted");
        const { done: rdDone, value } = await sseReader.read();
        if (rdDone) break;
        sseRemainder += dec.decode(value, { stream: true });
        const boundary = sseRemainder.lastIndexOf("\n\n");
        if (boundary < 0) continue;
        const chunk = sseRemainder.slice(0, boundary + 2);
        sseRemainder = sseRemainder.slice(boundary + 2);

        for (const ev of parseSseBlocks(chunk)) {
          const props = ev.properties;
          if (ev.type === "message.updated" && props.info && typeof props.info === "object") {
            const info = props.info as { id?: string; sessionID?: string; role?: string };
            if (info.sessionID === sessionId && info.role === "assistant" && info.id) {
              assistantMsgIds.add(info.id);
            }
          } else if (ev.type === "message.part.delta") {
            if (props.sessionID !== sessionId || typeof props.delta !== "string" || !props.delta) continue;
            const msgId = typeof props.messageID === "string" ? props.messageID : "";
            if (!assistantMsgIds.has(msgId)) continue;
            if (props.field === "text") {
              const partId = typeof props.partID === "string" ? props.partID : "";
              partTextById.set(partId, (partTextById.get(partId) ?? "") + props.delta);
              pushText(props.delta);
            } else if (props.field === "reasoning") {
              pushThinking(props.delta);
            }
          } else if (ev.type === "message.part.updated" && props.part && typeof props.part === "object") {
            const part = props.part as { id?: string; type?: string; sessionID?: string; messageID?: string; text?: string };
            if (part.sessionID !== sessionId || !part.messageID || !assistantMsgIds.has(part.messageID)) continue;
            if (part.type === "text" && part.id && typeof part.text === "string") {
              const prev = partTextById.get(part.id) ?? "";
              const delta = part.text.slice(prev.length);
              partTextById.set(part.id, part.text);
              pushText(delta);
            }
          } else if (ev.type === "session.idle") {
            if (props.sessionID === sessionId) { done = true; break; }
          } else if (ev.type === "session.error") {
            if (props.sessionID === sessionId) {
              throw new Error(`OpenCode session error: ${safeJson(props.error ?? props)}`);
            }
          } else if (ev.type === "session.status" && props.sessionID === sessionId && props.status && typeof props.status === "object") {
            const st = props.status as { type?: string; message?: string };
            if (st.type === "retry") {
              throw new Error(`OpenCode upstream limit: ${st.message ?? "retrying"}`);
            }
          }
        }
      }

      options?.signal?.removeEventListener("abort", onAbort);
      sseAbort.abort();

      output.usage.input = Math.max(1, Math.ceil(prompt.length / 4));
      output.usage.output = Math.max(1, Math.ceil(accumulatedText.length / 4));
      output.usage.totalTokens = output.usage.input + output.usage.output;

      if (activeThinkingBlock && thinkingIdx !== -1) {
        stream.push({ type: "thinking_end", contentIndex: thinkingIdx, content: activeThinkingBlock.thinking, partial: output });
      }

      const calls = hasTool ? parseToolCalls(accumulatedText).filter((c) => allowedTools.has(c.name)) : [];
      if (calls.length > 0) {
        output.stopReason = "toolUse";
        for (const call of calls) {
          const tc: ToolCall = {
            type: "toolCall",
            id: `opencode_omp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments,
          };
          const idx = output.content.length;
          output.content.push(tc);
          stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: idx, delta: safeJson(tc.arguments), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: tc, partial: output });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      if (activeTextBlock && textIdx !== -1) {
        stream.push({ type: "text_end", contentIndex: textIdx, content: activeTextBlock.text, partial: output });
      } else {
        const block: TextContent = { type: "text", text: accumulatedText };
        textIdx = output.content.length;
        output.content.push(block);
        stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
        if (accumulatedText) stream.push({ type: "text_delta", contentIndex: textIdx, delta: accumulatedText, partial: output });
        stream.push({ type: "text_end", contentIndex: textIdx, content: accumulatedText, partial: output });
      }
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (err) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      await sseReader?.cancel().catch(() => undefined);
      if (sessionId && ocServer?.url) {
        await fetch(`${ocServer.url}/session/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
  })();

  return stream;
}

export default async function openCodeBridgeExtension(pi: ExtensionAPI) {
  const { ompRoot } = resolveBridgePaths();
  const externalPluginInstalled = existsSync(join(ompRoot, "plugins", "node_modules", "opencode-omp"));
  if (externalPluginInstalled && process.env.OMP_BRIDGES_FORCE_OPENCODE !== "1") {
    return;
  }

  registeredModels = await discoverOpenCodeModels();

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: registeredModels.map((id) => ({
      id,
      name: `${id} (OpenCode CLI)`,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      contextWindow: id.includes("big-pickle") ? 200_000 : DEFAULT_CONTEXT_WINDOW,
      maxTokens: id.includes("big-pickle") ? 32_000 : DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: streamOpenCode,
  });

  pi.on("session_shutdown", async () => {
    ocServer?.proc.kill();
    ocServer = undefined;
    if (ocAgentDir) {
      await rm(ocAgentDir, { recursive: true, force: true }).catch(() => undefined);
      ocAgentDir = undefined;
    }
  });

  pi.registerCommand("opencode-omp", {
    description: "OpenCode CLI bridge status, models, update, and quota",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        const bin = resolveOpenCodeBinary() ?? "(not found)";
        const lines = [
          `Provider: ${PROVIDER_ID}`,
          `OpenCode binary: ${bin}`,
          `Server running: ${ocServer ? ocServer.url : "idle (0 MB)"}`,
          `Registered models: ${registeredModels.length}`,
          ...(lastDiscoveryError ? [`Discovery note: ${lastDiscoveryError}`] : []),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "models") {
        ctx.ui.notify(registeredModels.map((m) => `  ${PROVIDER_ID}/${m}`).join("\n"), "info");
        return;
      }
      if (sub === "update") {
        registeredModels = await discoverOpenCodeModels();
        ctx.ui.notify(`Refreshed ${registeredModels.length} OpenCode model(s).`, "info");
        return;
      }
      if (sub === "quota") {
        const bunBin = resolveBunBinary();
        const scriptPath = resolveGatewayControlScript();
        const { promise, resolve: resolveQuota } = Promise.withResolvers<string>();
        const child = spawn(bunBin, [scriptPath, "quota"], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let out = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (c: string) => { out += c; });
        child.stderr.on("data", (c: string) => { out += c; });
        child.on("error", (e) => resolveQuota(e.message));
        child.on("close", () => resolveQuota(out.trim() || "No quota output"));
        ctx.ui.notify(await promise, "info");
        return;
      }
      ctx.ui.notify("Usage: /opencode-omp [status|models|update|quota]", "warning");
    },
  });
}
