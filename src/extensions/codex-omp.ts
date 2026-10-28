import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  readCodexAccountMetadata,
  resolveBridgePaths,
  resolveBunBinary,
  resolveCodexBinary,
  resolveGatewayControlScript,
  syncCodexAuthToOmp,
} from "../shared/paths.ts";

const PROVIDER_ID = "codex-cli";
const API_ID = "codex-cli-runner" as Api;
const STDERR_LIMIT = 16_000;

const FALLBACK_CODEX_MODELS = [
  "gpt-6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-reserve",
  "codex-auto-review",
] as const;

interface CodexModelCacheRow {
  slug?: string;
  id?: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
}

interface CodexModelsCacheDoc {
  models?: CodexModelCacheRow[];
}

interface CodexExecItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
}

interface CodexExecEvent {
  type?: string;
  item?: CodexExecItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
  message?: string;
}

type CodexDelegateMode = "readonly" | "edit" | "full" | "review";

interface CodexDelegateOptions {
  task: string;
  mode: CodexDelegateMode;
  model: string;
  cwd: string;
  uncommitted?: boolean;
  baseBranch?: string;
  signal?: AbortSignal;
  onStep?: (stepCount: number, label: string) => void;
}

interface CodexDelegateResult {
  text: string;
  mode: CodexDelegateMode;
  model: string;
  durationMs: number;
  stepCount: number;
}

let registeredModels: string[] = [];

function discoverCodexModels(): Array<{ id: string; name: string; contextWindow: number; maxTokens: number }> {
  const manualRaw = process.env.CODEX_OMP_MODELS?.trim();
  if (manualRaw) {
    const ids = [...new Set(manualRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    if (ids.length > 0) {
      return ids.map((id) => ({
        id,
        name: `${id} (Codex CLI)`,
        contextWindow: 272_000,
        maxTokens: 128_000,
      }));
    }
  }

  const { codexHomeDir } = resolveBridgePaths();
  const cachePath = join(codexHomeDir, "models_cache.json");
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as
        | CodexModelCacheRow[]
        | CodexModelsCacheDoc;
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.models)
          ? parsed.models
          : [];
      const seen = new Set<string>();
      const out: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }> = [];
      for (const row of list) {
        const slug = (row.slug || row.id || "").trim();
        if (!slug || slug.includes("/") || seen.has(slug)) continue;
        seen.add(slug);
        out.push({
          id: slug,
          name: `${row.display_name?.trim() || slug} (Codex CLI)`,
          contextWindow: row.context_window ?? 272_000,
          maxTokens: row.max_output_tokens ?? 128_000,
        });
      }
      if (out.length > 0) return out;
    } catch {
      // Fall back to default list
    }
  }

  return FALLBACK_CODEX_MODELS.map((id) => ({
    id,
    name: `${id} (Codex CLI)`,
    contextWindow: 272_000,
    maxTokens: 128_000,
  }));
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

const CODEX_BRIDGE_RULES = `# OMP/Codex CLI bridge instructions

You are acting as the LLM backend for Oh My Pi (OMP) coding agent via Codex CLI.
Do not execute shell commands or built-in Codex tools.

OUTPUT RULES:

1. When you need OMP to execute one or more tools, output ONLY tool-call block(s) with no prose before or after:
   <omp_tool_call>{"name":"tool_name","arguments":{...}}</omp_tool_call>
   Include EVERY required property from the tool's "parameters" schema inside "arguments" (for example, if "i" is in "required", include a concise 2-6 word present-participle intent string in "i").

2. When no tool is needed, reply in plain text with no <omp_tool_call> tags.

3. After receiving OMP TOOL RESULT entries in the transcript, either emit the next <omp_tool_call> or provide the final answer in plain text.`;

function buildBridgePrompt(context: Context): string {
  const sysPrompt = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.join("\n").trim()
    : (context.systemPrompt ?? "").trim();
  const sections: string[] = [
    CODEX_BRIDGE_RULES,
    ...(sysPrompt ? [`# OMP system prompt\n\n${sysPrompt}`] : []),
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

function streamCodexCli(
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
    const fullPrompt = buildBridgePrompt(context);
    const codexBin = resolveCodexBinary() ?? "codex";

    let activeThinkingBlock: ThinkingContent | undefined;
    let activeTextBlock: TextContent | undefined;
    let reasoningContentIndex = -1;
    let textContentIndex = -1;
    let accumulatedText = "";

    const emitThinking = (text: string) => {
      if (!text) return;
      if (!activeThinkingBlock) {
        activeThinkingBlock = { type: "thinking", thinking: "" };
        reasoningContentIndex = output.content.length;
        output.content.push(activeThinkingBlock);
        stream.push({ type: "thinking_start", contentIndex: reasoningContentIndex, partial: output });
      }
      activeThinkingBlock.thinking += text;
      stream.push({ type: "thinking_delta", contentIndex: reasoningContentIndex, delta: text, partial: output });
    };

    const emitText = (text: string) => {
      if (!text) return;
      accumulatedText += text;
      if (hasTool) return;
      if (!activeTextBlock) {
        activeTextBlock = { type: "text", text: "" };
        textContentIndex = output.content.length;
        output.content.push(activeTextBlock);
        stream.push({ type: "text_start", contentIndex: textContentIndex, partial: output });
      }
      activeTextBlock.text += text;
      stream.push({ type: "text_delta", contentIndex: textContentIndex, delta: text, partial: output });
    };

    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      const { promise, resolve: resolveRun, reject: rejectRun } = Promise.withResolvers<void>();
      const args = [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "-s", "read-only",
        "--json",
        "-m", model.id,
        "-",
      ];

      const child = spawn(codexBin, args, {
        cwd: tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdoutBuf = "";
      let stderr = "";
      const onAbort = () => {
        try { child.kill(); } catch { /* ignore */ }
        rejectRun(new Error("Request was aborted"));
      };
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c: string) => {
        stderr = (stderr + c).slice(-STDERR_LIMIT);
      });

      const handleLine = (line: string) => {
        if (!line.startsWith("{")) return;
        let ev: CodexExecEvent;
        try {
          ev = JSON.parse(line) as CodexExecEvent;
        } catch {
          return;
        }

        if (ev.type === "item.completed" && ev.item) {
          if (ev.item.type === "agent_message" && typeof ev.item.text === "string") {
            emitText(ev.item.text);
          } else if (ev.item.type === "reasoning" && typeof ev.item.text === "string") {
            emitThinking(ev.item.text);
          }
          return;
        }

        if (ev.type === "turn.completed" && ev.usage) {
          const inp = ev.usage.input_tokens ?? 0;
          const out = ev.usage.output_tokens ?? 0;
          const cached = ev.usage.cached_input_tokens ?? 0;
          output.usage.input = inp;
          output.usage.output = out;
          output.usage.cacheRead = cached;
          output.usage.totalTokens = inp + out;
          return;
        }

        if (ev.type === "turn.failed" || ev.type === "error") {
          const errMsg = ev.error?.message || ev.message || "Codex CLI turn failed";
          rejectRun(new Error(errMsg));
        }
      };

      child.stdout.on("data", (chunk: string) => {
        stdoutBuf += chunk;
        let idx = stdoutBuf.indexOf("\n");
        while (idx !== -1) {
          const line = stdoutBuf.slice(0, idx).replace(/\r$/, "").trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          idx = stdoutBuf.indexOf("\n");
          if (line) handleLine(line);
        }
      });

      child.on("error", (err) => {
        options?.signal?.removeEventListener("abort", onAbort);
        rejectRun(err);
      });

      child.on("close", (code) => {
        options?.signal?.removeEventListener("abort", onAbort);
        const rem = stdoutBuf.trim();
        if (rem) handleLine(rem);
        if (options?.signal?.aborted) {
          rejectRun(new Error("Request was aborted"));
          return;
        }
        if (code !== 0 && !accumulatedText) {
          rejectRun(new Error(stderr.trim() || `codex exec exited with code ${code}`));
          return;
        }
        resolveRun();
      });

      child.stdin.end(fullPrompt);
      await promise;

      if (output.usage.totalTokens === 0) {
        output.usage.input = Math.max(1, Math.ceil(fullPrompt.length / 4));
        output.usage.output = Math.max(1, Math.ceil(accumulatedText.length / 4));
        output.usage.totalTokens = output.usage.input + output.usage.output;
      }

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
        output.stopReason = "toolUse";
        for (const call of parsedCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `codex_omp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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

      if (activeTextBlock && textContentIndex !== -1) {
        stream.push({
          type: "text_end",
          contentIndex: textContentIndex,
          content: activeTextBlock.text,
          partial: output,
        });
      } else {
        const finalTextBlock: TextContent = { type: "text", text: accumulatedText };
        textContentIndex = output.content.length;
        output.content.push(finalTextBlock);
        stream.push({ type: "text_start", contentIndex: textContentIndex, partial: output });
        if (accumulatedText) {
          stream.push({
            type: "text_delta",
            contentIndex: textContentIndex,
            delta: accumulatedText,
            partial: output,
          });
        }
        stream.push({
          type: "text_end",
          contentIndex: textContentIndex,
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

async function runCodexDelegate(opts: CodexDelegateOptions): Promise<CodexDelegateResult> {
  if (!existsSync(opts.cwd)) {
    throw new Error(`Working directory not found: ${opts.cwd}`);
  }

  const codexBin = resolveCodexBinary() ?? "codex";
  const startedAt = Date.now();
  const { promise, resolve: resolveDelegate, reject: rejectDelegate } =
    Promise.withResolvers<CodexDelegateResult>();

  let args: string[];
  const isReview = opts.mode === "review";
  if (isReview) {
    args = [
      "review",
      ...(opts.uncommitted ? ["--uncommitted"] : []),
      ...(opts.baseBranch ? ["--base", opts.baseBranch] : []),
      ...(opts.task.trim() ? ["-"] : []),
    ];
  } else {
    const sandbox =
      opts.mode === "full"
        ? "danger-full-access"
        : opts.mode === "edit"
          ? "workspace-write"
          : "read-only";
    args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-s", sandbox,
      "--json",
      "-C", opts.cwd,
      "-m", opts.model,
      "-",
    ];
  }

  const child = spawn(codexBin, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuf = "";
  let rawStdout = "";
  let stderr = "";
  let stepCount = 0;
  const messages: string[] = [];

  const onAbort = () => {
    try { child.kill(); } catch { /* ignore */ }
    rejectDelegate(new Error("Codex delegate cancelled"));
  };
  if (opts.signal?.aborted) {
    onAbort();
    return promise;
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => {
    stderr = (stderr + c).slice(-STDERR_LIMIT);
  });

  const handleJsonLine = (line: string) => {
    if (!line.startsWith("{")) return;
    let ev: CodexExecEvent;
    try {
      ev = JSON.parse(line) as CodexExecEvent;
    } catch {
      return;
    }

    if (ev.type === "item.completed" && ev.item) {
      if (ev.item.type === "agent_message" && typeof ev.item.text === "string" && ev.item.text.trim()) {
        messages.push(ev.item.text.trim());
      } else if (ev.item.type && ev.item.type !== "reasoning") {
        stepCount += 1;
        const label = ev.item.command || ev.item.type;
        opts.onStep?.(stepCount, label);
      }
      return;
    }

    if (ev.type === "turn.failed" || ev.type === "error") {
      const msg = ev.error?.message || ev.message || "Codex delegate failed";
      rejectDelegate(new Error(msg));
    }
  };

  child.stdout.on("data", (chunk: string) => {
    if (isReview) {
      rawStdout += chunk;
      return;
    }
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
    opts.signal?.removeEventListener("abort", onAbort);
    rejectDelegate(err);
  });

  child.on("close", (code) => {
    opts.signal?.removeEventListener("abort", onAbort);
    if (!isReview) {
      const rem = stdoutBuf.trim();
      if (rem) handleJsonLine(rem);
    }
    if (opts.signal?.aborted) {
      rejectDelegate(new Error("Codex delegate cancelled"));
      return;
    }
    const finalText = isReview
      ? (rawStdout.trim() || stderr.trim())
      : messages.join("\n\n").trim();
    if (code !== 0 && !finalText) {
      rejectDelegate(new Error(stderr.trim() || `codex exited with code ${code}`));
      return;
    }
    resolveDelegate({
      text: finalText || "(no text output)",
      mode: opts.mode,
      model: opts.model,
      durationMs: Date.now() - startedAt,
      stepCount,
    });
  });

  if (!isReview || opts.task.trim()) {
    child.stdin.end(opts.task);
  } else {
    child.stdin.end();
  }

  return promise;
}

function parseCodexRunArgs(rawArgs: string): {
  mode: CodexDelegateMode;
  model: string;
  prompt: string;
} {
  let mode: CodexDelegateMode = "readonly";
  let model = process.env.CODEX_OMP_AGENT_MODEL?.trim() || "gpt-6-luna";
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
    if (tok === "--review") {
      mode = "review";
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

export default async function codexOmpExtension(pi: ExtensionAPI) {
  const z = pi.zod;
  const discovered = discoverCodexModels();
  registeredModels = discovered.map((m) => m.id);

  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "cli:codex-exec",
    apiKey: "codex-cli-local-auth",
    api: API_ID,
    models: discovered.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: streamCodexCli,
  });

  pi.registerTool({
    name: "codex_delegate",
    label: "Codex Sub-Agent",
    description:
      "Delegate a coding task or non-interactive git code review to OpenAI Codex CLI.",
    loadMode: "essential",
    approval: "exec",
    parameters: z.object({
      task: z
        .string()
        .min(1)
        .describe("Task instructions or review focus for the Codex CLI sub-agent"),
      mode: z
        .enum(["readonly", "edit", "full", "review"])
        .optional()
        .describe(
          "Execution mode: readonly (default, read-only sandbox), edit (workspace-write sandbox), full (danger-full-access), or review (runs 'codex review')",
        ),
      model: z
        .string()
        .optional()
        .describe("Codex model ID, e.g. gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna, gpt-reserve (default: gpt-6-luna)"),
      uncommitted: z
        .boolean()
        .optional()
        .describe("For mode='review': review staged, unstaged, and untracked changes"),
      baseBranch: z
        .string()
        .optional()
        .describe("For mode='review': review changes against a base branch"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory path (relative to current session cwd or absolute)"),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const mode: CodexDelegateMode = params.mode ?? "readonly";
      const model =
        params.model?.trim() ||
        process.env.CODEX_OMP_AGENT_MODEL?.trim() ||
        "gpt-6-luna";
      const targetCwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
      if (!existsSync(targetCwd)) {
        throw new Error(`Working directory not found: ${targetCwd}`);
      }

      const res = await runCodexDelegate({
        task: params.task,
        mode,
        model,
        cwd: targetCwd,
        uncommitted: params.uncommitted,
        baseBranch: params.baseBranch,
        signal,
        onStep(stepCount, label) {
          onUpdate?.({
            content: [{ type: "text", text: `[Codex ${mode}] step #${stepCount}: ${label}` }],
            details: { mode, model, stepCount },
          });
        },
      });

      return {
        content: [{ type: "text", text: res.text }],
        details: {
          mode: res.mode,
          model: res.model,
          durationMs: res.durationMs,
          stepCount: res.stepCount,
        },
      };
    },
  });

  pi.registerCommand("codex", {
    description: "Codex CLI hybrid status, models, quota, OAuth sync, review, and sub-agent runner",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const firstSpace = trimmed.search(/\s/);
      const sub = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)) || "status";
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      if (sub === "status") {
        const meta = readCodexAccountMetadata();
        const bin = resolveCodexBinary() ?? "(not found)";
        const lines = [
          `Codex CLI binary: ${bin}`,
          `ChatGPT account: ${meta.email ?? "unknown"} (plan: ${meta.planType ?? "unknown"})`,
          `Native OAuth provider: openai-codex/* (role @codex -> openai-codex/gpt-6-luna)`,
          `CLI Bridge provider: ${PROVIDER_ID}/* (${registeredModels.length} models: ${registeredModels.join(", ")})`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "models") {
        const lines = [
          "Native OAuth (WebSocket/SSE):",
          ...registeredModels.filter((m) => m !== "codex-auto-review").map((id) => `  openai-codex/${id}`),
          "",
          "CLI Bridge (codex exec):",
          ...registeredModels.map((id) => `  ${PROVIDER_ID}/${id}`),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "sync-auth") {
        const res = syncCodexAuthToOmp();
        ctx.ui.notify(res.message, res.ok ? "info" : "error");
        return;
      }

      if (sub === "quota") {
        const bunBin = resolveBunBinary();
        const scriptPath = resolveGatewayControlScript();
        const proc = spawnSync(bunBin, [scriptPath, "quota"], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 25_000,
        });
        const out = (proc.stdout || proc.stderr || "Failed to fetch quota").trim();
        ctx.ui.notify(out, proc.status === 0 ? "info" : "warning");
        return;
      }

      if (sub === "review") {
        ctx.ui.notify("Running Codex CLI code review on current workspace...", "info");
        try {
          const res = await runCodexDelegate({
            task: rest,
            mode: "review",
            model: "gpt-6-luna",
            cwd: ctx.cwd,
            uncommitted: !rest,
          });
          pi.sendMessage(
            {
              customType: "codex-delegate",
              content: `[Codex Code Review | ${(res.durationMs / 1000).toFixed(1)}s]\n\n${res.text}`,
              display: true,
              attribution: "user",
            },
            { triggerTurn: false },
          );
        } catch (err) {
          ctx.ui.notify(
            `Codex review failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
        return;
      }

      if (sub === "run") {
        const parsed = parseCodexRunArgs(rest);
        if (!parsed.prompt && parsed.mode !== "review") {
          ctx.ui.notify("Usage: /codex run [--edit|--full|--review] [--model <id>] <prompt>", "warning");
          return;
        }
        ctx.ui.notify(
          `Running Codex sub-agent (mode=${parsed.mode}, model=${parsed.model})...`,
          "info",
        );
        try {
          const res = await runCodexDelegate({
            task: parsed.prompt,
            mode: parsed.mode,
            model: parsed.model,
            cwd: ctx.cwd,
          });
          pi.sendMessage(
            {
              customType: "codex-delegate",
              content: `[Codex Sub-Agent | mode=${res.mode} | model=${res.model} | steps=${res.stepCount} | ${(res.durationMs / 1000).toFixed(1)}s]\n\n${res.text}`,
              display: true,
              attribution: "user",
            },
            { triggerTurn: false },
          );
        } catch (err) {
          ctx.ui.notify(
            `Codex run failed: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
        }
        return;
      }

      ctx.ui.notify(
        "Usage: /codex [status|models|quota|sync-auth|review [prompt]|run [--edit|--full] [--model <id>] <prompt>]",
        "warning",
      );
    },
  });
}
