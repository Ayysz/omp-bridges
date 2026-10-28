#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(rootDir, "src", "cli", "omp-bridges-cli.ts");
const ext = process.platform === "win32" ? ".exe" : "";
const homeBun = join(homedir(), ".bun", "bin", `bun${ext}`);
const bunBin = existsSync(homeBun) ? homeBun : "bun";

const res = spawnSync(bunBin, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
