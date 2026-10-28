import { describe, expect, test } from "bun:test";
import { mergeOmpConfigYaml } from "../src/cli/omp-bridges-cli.ts";
import { upsertCodexGatewaySection } from "../src/cli/omp-gateway-ctl.ts";
import { resolveBridgePaths } from "../src/shared/paths.ts";

describe("omp-bridges portable helpers", () => {
  test("resolveBridgePaths returns non-empty cross-platform directories", () => {
    const paths = resolveBridgePaths();
    expect(paths.homeDir.length).toBeGreaterThan(0);
    expect(paths.ompAgentDir).toContain(".omp");
    expect(paths.openCodeConfigDir).toContain("opencode");
    expect(paths.codeBuddyHomeDir).toContain(".codebuddy");
    expect(paths.codexHomeDir).toContain(".codex");
  });

  test("mergeOmpConfigYaml preserves existing fields and adds providers & roles", () => {
    const existing = [
      "setupVersion: 2",
      "browser:",
      "  headless: false",
      "memory:",
      "  backend: mnemopi",
      "modelRoles:",
      "  default: google-antigravity/gemini-4-argon",
      "defaultThinkingLevel: auto",
      "",
    ].join("\n");

    const merged = mergeOmpConfigYaml(existing, true, true, true);
    const parsed = Bun.YAML.parse(merged) as {
      setupVersion: number;
      enabledProviders: string[];
      modelRoles: Record<string, string>;
      defaultThinkingLevel: string;
    };

    expect(parsed.setupVersion).toBe(2);
    expect(parsed.defaultThinkingLevel).toBe("auto");
    expect(parsed.enabledProviders).toEqual(["opencode", "codex"]);
    expect(parsed.modelRoles.default).toBe("google-antigravity/gemini-4-argon");
    expect(parsed.modelRoles.codebuddy).toBe("codebuddy-cli/deepseek-v4.1-flash");
    expect(parsed.modelRoles.codex).toBe("openai-codex/gpt-6-luna");
  });

  test("upsertCodexGatewaySection idempotently replaces managed block while keeping user sections", () => {
    const base = '[tui]\nscreen_reader_detection_done = true\n\n[windows]\nsandbox = "elevated"\n';
    const once = upsertCodexGatewaySection(base, "http://127.0.0.1:4000", "tok_1");
    const twice = upsertCodexGatewaySection(once, "http://127.0.0.1:4000", "tok_2");

    expect(twice).toContain("[tui]");
    expect(twice).toContain('[windows]\nsandbox = "elevated"');
    expect(twice).toContain('Authorization = "Bearer tok_2"');
    expect(twice).not.toContain("tok_1");
    expect(twice.match(/\[model_providers\.omp_gateway\]/g)?.length).toBe(1);
  });
});
