import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveBridgePaths,
  resolveBunBinary,
  resolveCodeBuddyRuntime,
  resolveCodexBinary,
  resolveOmpBinary,
  resolveOpenCodeBinary,
  resolveRepoRoot,
  syncCodexAuthToOmp,
} from "../shared/paths.ts";
import { runGatewayCli, writeAtomicUtf8 } from "./omp-gateway-ctl.ts";

interface McpConfigDoc {
  $schema?: string;
  mcpServers?: Record<string, unknown>;
  disabledServers?: string[];
  [key: string]: unknown;
}

interface OmpConfigDoc {
  setupVersion?: number;
  enabledProviders?: string[];
  modelRoles?: Record<string, string>;
  [key: string]: unknown;
}

function logAction(dryRun: boolean, action: string): void {
  console.log(`${dryRun ? "[dry-run] " : "✔ "}${action}`);
}

export function mergeOmpConfigYaml(rawYaml: string, hasOpenCode: boolean, hasCodex: boolean, hasCodeBuddy: boolean): string {
  const parsedRaw = rawYaml.trim() ? Bun.YAML.parse(rawYaml) : {};
  const doc: OmpConfigDoc =
    parsedRaw && typeof parsedRaw === "object" && !Array.isArray(parsedRaw)
      ? (parsedRaw as OmpConfigDoc)
      : { setupVersion: 2 };

  const providers = new Set<string>(Array.isArray(doc.enabledProviders) ? doc.enabledProviders : []);
  if (hasOpenCode) providers.add("opencode");
  if (hasCodex) providers.add("codex");
  if (providers.size > 0) {
    doc.enabledProviders = [...providers];
  }

  const roles: Record<string, string> =
    doc.modelRoles && typeof doc.modelRoles === "object" && !Array.isArray(doc.modelRoles)
      ? { ...doc.modelRoles }
      : {};
  if (hasCodeBuddy && !roles.codebuddy) {
    roles.codebuddy = "codebuddy-cli/deepseek-v4.1-flash";
  }
  if (hasCodex && !roles.codex) {
    roles.codex = "openai-codex/gpt-6-luna";
  }
  if (Object.keys(roles).length > 0) {
    doc.modelRoles = roles;
  }

  return `${Bun.YAML.stringify(doc, null, 2).trimEnd()}\n`;
}

function runDoctor(): void {
  const paths = resolveBridgePaths();
  const bunBin = resolveBunBinary();
  const ompBin = resolveOmpBinary();
  const openCodeBin = resolveOpenCodeBinary();
  const codexBin = resolveCodexBinary();
  const cbRuntime = resolveCodeBuddyRuntime();

  console.log("=== omp-bridges Doctor ===");
  console.log(`Platform            : ${process.platform} (${process.arch})`);
  console.log(`Home directory      : ${paths.homeDir}`);
  console.log(`OMP agent dir       : ${paths.ompAgentDir} (${existsSync(paths.ompAgentDir) ? "exists" : "missing"})`);
  console.log(`Bun binary          : ${bunBin}`);
  console.log(`OMP binary          : ${ompBin}`);
  console.log(`CodeBuddy runtime   : ${"error" in cbRuntime ? `NOT FOUND (${cbRuntime.error})` : `${cbRuntime.nodeBin} -> ${cbRuntime.entryScript}`}`);
  console.log(`OpenCode binary     : ${openCodeBin ?? "NOT FOUND"}`);
  console.log(`Codex CLI binary    : ${codexBin ?? "NOT FOUND"}`);
  console.log(`Codex auth.json     : ${existsSync(join(paths.codexHomeDir, "auth.json")) ? "detected" : "not found"}`);
  console.log(`Installed skill     : ${existsSync(join(paths.ompAgentDir, "skills", "omp-bridges", "SKILL.md")) ? "installed" : "not installed"}`);
  console.log(`Gateway controller  : ${existsSync(join(paths.ompAgentDir, "bin", "omp-gateway-ctl.ts")) ? "installed" : "not installed"}`);
}

function writeShimPair(opts: {
  binDir: string;
  name: string;
  bunBin: string;
  targetScript: string;
  dryRun: boolean;
}): void {
  const posixPath = join(opts.binDir, opts.name);
  const posixBody = `#!/usr/bin/env sh\nexec "${opts.bunBin.replace(/\\/g, "/")}" "${opts.targetScript.replace(/\\/g, "/")}" "$@"\n`;

  if (!opts.dryRun) {
    mkdirSync(opts.binDir, { recursive: true });
    writeFileSync(posixPath, posixBody, "utf8");
    try { chmodSync(posixPath, 0o755); } catch { /* ignore on win32 */ }
  }
  logAction(opts.dryRun, `Installed CLI shim ${posixPath}`);

  if (process.platform === "win32") {
    const cmdPath = join(opts.binDir, `${opts.name}.cmd`);
    const cmdBody = `@echo off\r\n"${opts.bunBin.replace(/\//g, "\\")}" "${opts.targetScript.replace(/\//g, "\\")}" %*\r\n`;
    if (!opts.dryRun) {
      writeFileSync(cmdPath, cmdBody, "utf8");
    }
    logAction(opts.dryRun, `Installed Windows shim ${cmdPath}`);
  }
}

function runSetup(dryRun: boolean): void {
  const repoRoot = resolveRepoRoot();
  const paths = resolveBridgePaths();
  const bunBin = resolveBunBinary();
  const ompBin = resolveOmpBinary();
  const openCodeBin = resolveOpenCodeBinary();
  const codexBin = resolveCodexBinary();
  const cbRuntime = resolveCodeBuddyRuntime();

  const hasOpenCode = Boolean(openCodeBin);
  const hasCodex = Boolean(codexBin || existsSync(join(paths.codexHomeDir, "auth.json")));
  const hasCodeBuddy = !("error" in cbRuntime);

  console.log(`=== omp-bridges Setup (${dryRun ? "DRY RUN" : "APPLY"}) ===`);

  // 1. Copy standalone runtime mirror into ~/.omp/agent/omp-bridges/
  const runtimeMirrorDir = join(paths.ompAgentDir, "omp-bridges");
  if (!dryRun) {
    mkdirSync(join(runtimeMirrorDir, "src"), { recursive: true });
    cpSync(join(repoRoot, "src"), join(runtimeMirrorDir, "src"), { recursive: true, force: true });
  }
  logAction(dryRun, `Synced standalone runtime modules -> ${join(runtimeMirrorDir, "src")}`);

  // 2. Write extension entrypoints in ~/.omp/agent/extensions/
  const extDir = join(paths.ompAgentDir, "extensions");
  const extensionEntries: Array<{ file: string; target: string }> = [
    { file: "codebuddy-omp.ts", target: "../omp-bridges/src/extensions/codebuddy-omp.ts" },
    { file: "codex-omp.ts", target: "../omp-bridges/src/extensions/codex-omp.ts" },
    { file: "opencode-omp-bridge.ts", target: "../omp-bridges/src/extensions/opencode-omp.ts" },
  ];
  for (const item of extensionEntries) {
    const dest = join(extDir, item.file);
    if (!dryRun) {
      mkdirSync(extDir, { recursive: true });
      writeAtomicUtf8(dest, `export { default } from "${item.target}";\n`);
    }
    logAction(dryRun, `Configured OMP extension ${dest}`);
  }

  // 3. Install native sub-agents (codebuddy.md & codex.md)
  const agentsDestDir = join(paths.ompAgentDir, "agents");
  for (const agentFile of ["codebuddy.md", "codex.md"]) {
    const src = join(repoRoot, "agents", agentFile);
    const dest = join(agentsDestDir, agentFile);
    if (existsSync(src)) {
      if (!dryRun) {
        mkdirSync(agentsDestDir, { recursive: true });
        cpSync(src, dest, { force: true });
      }
      logAction(dryRun, `Installed native task sub-agent ${dest}`);
    }
  }

  // 4. Install portable skill into ~/.omp/agent/skills/omp-bridges/SKILL.md
  const skillSrc = join(repoRoot, "skills", "omp-bridges", "SKILL.md");
  const skillDest = join(paths.ompAgentDir, "skills", "omp-bridges", "SKILL.md");
  if (existsSync(skillSrc)) {
    if (!dryRun) {
      mkdirSync(dirname(skillDest), { recursive: true });
      cpSync(skillSrc, skillDest, { force: true });
    }
    logAction(dryRun, `Installed agent skill ${skillDest}`);
  }

  // 5. Install gateway & bridges CLI wrappers in ~/.omp/agent/bin/ + global shims
  const agentBinDir = join(paths.ompAgentDir, "bin");
  const gwWrapper = join(agentBinDir, "omp-gateway-ctl.ts");
  const brWrapper = join(agentBinDir, "omp-bridges-cli.ts");
  if (!dryRun) {
    mkdirSync(agentBinDir, { recursive: true });
    writeAtomicUtf8(
      gwWrapper,
      `import { runGatewayCli } from "../omp-bridges/src/cli/omp-gateway-ctl.ts";\nawait runGatewayCli(process.argv.slice(2));\n`,
    );
    writeAtomicUtf8(
      brWrapper,
      `import { runBridgesCli } from "../omp-bridges/src/cli/omp-bridges-cli.ts";\nawait runBridgesCli(process.argv.slice(2));\n`,
    );
  }
  logAction(dryRun, `Installed CLI entrypoints in ${agentBinDir}`);

  writeShimPair({ binDir: paths.bunBinDir, name: "omp-gateway", bunBin, targetScript: gwWrapper, dryRun });
  writeShimPair({ binDir: paths.bunBinDir, name: "omp-bridges", bunBin, targetScript: brWrapper, dryRun });

  // 6. On Windows, pin OPENCODE_OMP_BIN in ~/.omp/agent/.env if OpenCode is installed
  if (process.platform === "win32" && openCodeBin) {
    const envPath = join(paths.ompAgentDir, ".env");
    const existingEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    if (!existingEnv.includes("OPENCODE_OMP_BIN=")) {
      const normalized = openCodeBin.replace(/\\/g, "/");
      const nextEnv = existingEnv.trimEnd()
        ? `${existingEnv.trimEnd()}\nOPENCODE_OMP_BIN=${normalized}\n`
        : `OPENCODE_OMP_BIN=${normalized}\n`;
      if (!dryRun) {
        writeAtomicUtf8(envPath, nextEnv);
      }
      logAction(dryRun, `Pinned OPENCODE_OMP_BIN=${normalized} in ${envPath}`);
    }
  }

  // 7. Ensure ~/.omp/agent/mcp.json disables blocking remote OAuth MCPs (figma)
  const mcpPath = join(paths.ompAgentDir, "mcp.json");
  let mcpDoc: McpConfigDoc = {
    $schema: "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
    mcpServers: {},
    disabledServers: ["figma"],
  };
  if (existsSync(mcpPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as McpConfigDoc;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const disabled = new Set(Array.isArray(parsed.disabledServers) ? parsed.disabledServers : []);
        disabled.add("figma");
        mcpDoc = {
          ...parsed,
          mcpServers: parsed.mcpServers ?? {},
          disabledServers: [...disabled],
        };
      }
    } catch {
      // Keep default mcpDoc if corrupt
    }
  }
  if (!dryRun) {
    writeAtomicUtf8(mcpPath, `${JSON.stringify(mcpDoc, null, 2)}\n`);
  }
  logAction(dryRun, `Updated ${mcpPath} (disabledServers includes "figma")`);

  // 8. Merge enabledProviders & modelRoles in ~/.omp/agent/config.yml
  const cfgPath = join(paths.ompAgentDir, "config.yml");
  const existingCfg = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
  const nextCfg = mergeOmpConfigYaml(existingCfg, hasOpenCode, hasCodex, hasCodeBuddy);
  if (!dryRun) {
    writeAtomicUtf8(cfgPath, nextCfg);
  }
  logAction(dryRun, `Updated ${cfgPath} (enabledProviders & modelRoles)`);

  // 9. Sync Codex OAuth & install omp-codex-reserve if Codex auth.json exists
  if (existsSync(join(paths.codexHomeDir, "auth.json"))) {
    if (!dryRun) {
      const syncRes = syncCodexAuthToOmp();
      logAction(false, `Synced Codex OAuth -> OMP (${syncRes.message})`);
      if (!existsSync(join(paths.ompRoot, "plugins", "node_modules", "omp-codex-reserve"))) {
        spawnSync(ompBin, ["plugin", "install", "omp-codex-reserve"], {
          stdio: "inherit",
          windowsHide: true,
          timeout: 30_000,
        });
      }
    } else {
      logAction(true, "Would sync ~/.codex/auth.json -> OMP openai-codex and install omp-codex-reserve");
    }
  }

  console.log("\nSetup complete! Quick commands:");
  console.log("  omp-bridges doctor   # Verify detected CLIs and paths");
  console.log("  omp-gateway quota    # Check 4-in-1 quotas (OMP, Codex, CodeBuddy, OpenCode)");
  console.log("  omp-gateway start    # Start on-demand OAuth gateway & sync models");
  console.log("  omp-gateway stop     # Stop gateway & return to 0 MB idle");
}

async function runUninstall(dryRun: boolean): Promise<void> {
  const paths = resolveBridgePaths();
  console.log(`=== omp-bridges Uninstall (${dryRun ? "DRY RUN" : "APPLY"}) ===`);

  if (!dryRun) {
    await runGatewayCli(["stop"]).catch(() => undefined);
  }

  const targets = [
    join(paths.ompAgentDir, "omp-bridges"),
    join(paths.ompAgentDir, "extensions", "codebuddy-omp.ts"),
    join(paths.ompAgentDir, "extensions", "codex-omp.ts"),
    join(paths.ompAgentDir, "extensions", "opencode-omp-bridge.ts"),
    join(paths.ompAgentDir, "agents", "codebuddy.md"),
    join(paths.ompAgentDir, "agents", "codex.md"),
    join(paths.ompAgentDir, "skills", "omp-bridges"),
    join(paths.ompAgentDir, "bin", "omp-gateway-ctl.ts"),
    join(paths.ompAgentDir, "bin", "omp-bridges-cli.ts"),
    join(paths.bunBinDir, "omp-gateway"),
    join(paths.bunBinDir, "omp-gateway.cmd"),
    join(paths.bunBinDir, "omp-bridges"),
    join(paths.bunBinDir, "omp-bridges.cmd"),
  ];

  for (const target of targets) {
    if (existsSync(target)) {
      if (!dryRun) {
        rmSync(target, { recursive: true, force: true });
      }
      logAction(dryRun, `Removed ${target}`);
    }
  }
}

export async function runBridgesCli(argv: string[]): Promise<void> {
  const cmd = (argv[0] ?? "doctor").trim().toLowerCase();
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");

  switch (cmd) {
    case "setup":
    case "install":
      runSetup(dryRun);
      break;
    case "doctor":
    case "status":
      runDoctor();
      break;
    case "quota":
      await runGatewayCli(["quota"]);
      break;
    case "gateway":
      await runGatewayCli(argv.slice(1));
      break;
    case "uninstall":
      await runUninstall(dryRun);
      break;
    default:
      console.log("Usage: omp-bridges <setup|doctor|quota|gateway|uninstall> [--dry-run]");
      process.exit(1);
  }
}

if (import.meta.main) {
  runBridgesCli(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
