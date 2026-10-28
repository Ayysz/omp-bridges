---
name: omp-bridges
description: Set up, operate, troubleshoot, and check quotas for bidirectional bridges between Oh My Pi (OMP), CodeBuddy CLI, OpenCode CLI, and OpenAI Codex CLI with 0 MB idle RAM.
---

# omp-bridges Skill

Use this skill when setting up `omp-bridges` on a new machine, switching or delegating across **OMP**, **CodeBuddy CLI**, **OpenCode CLI**, and **Codex CLI**, syncing OAuth models through `omp-gateway`, or inspecting provider quotas.

## 1. Architecture Overview (0 MB Idle RAM)

- **Inbound into OMP (CLI -> OMP):**
  - `codebuddy-cli/*`: Runs a lazy low-memory `codebuddy --acp` daemon (`--optimize-for-size --max-semi-space-size=2` + `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`). Automatically shuts down after 5 minutes of inactivity (`0 MB` idle). Default `@codebuddy` maps to `codebuddy-cli/deepseek-v4.1-flash` (`x0.00` free credit multiplier).
  - `opencode-cli/*`: Runs `opencode serve --pure` with isolated config (`figma` MCP disabled) and bridges SSE turns + `<omp_tool_call>` markers without cold-start plugin bloat.
  - `openai-codex/*` + `codex-cli/*`: Hybrid setup. Imports `~/.codex/auth.json` (ChatGPT Go/Plus/Pro) directly into OMP's native `openai-codex` WebSocket/SSE store (`@codex`), installs `omp-codex-reserve` to unhide `gpt-reserve`, and also registers `codex-cli/*` + `codex_delegate` (`codex exec` / `codex review`).
  - **Skill & Sub-Agent Discovery:** `enabledProviders: [opencode, codex]` loads skills from `~/.config/opencode/skills/` and `~/.codex/skills/`, while `agents/codebuddy.md` and `agents/codex.md` expose native Agent Hub sub-agents.
- **Outbound from OMP (`omp-gateway`):**
  - On-demand supervisor managing `omp auth-broker serve` (`127.0.0.1:8765`) + `omp auth-gateway serve` (`127.0.0.1:4000`) **without** setting global `auth.broker.url` in `config.yml` (preserving offline/reboot safety).
  - Syncs OMP OAuth catalogs (`google-antigravity/*`, `openai-codex/*`, `zai/*`) to `~/.config/opencode/opencode.jsonc`, `~/.codebuddy/models.json`, and `~/.codex/config.toml`.

## 2. One-Command Setup on a New Machine

Prerequisites: [Bun](https://bun.sh) and [Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi) installed, plus one or more of `codebuddy`, `opencode`, or `codex`.

### Option A: Automated CLI Setup (Recommended)
```bash
git clone <your-repo-url> omp-bridges
cd omp-bridges
bun run setup
omp-bridges doctor
```
This installs standalone runtime modules into `~/.omp/agent/omp-bridges/`, registers extensions, sub-agents, this skill, `omp-gateway` and `omp-bridges` CLI shims in `~/.bun/bin`, merges `config.yml` & `mcp.json` non-destructively, and imports `~/.codex/auth.json` if present.

### Option B: Native OMP Marketplace Install
```bash
omp plugin marketplace add ./omp-bridges
omp plugin install omp-bridges@omp-bridges
```

## 3. Daily Usage Reference

### Inside OMP (Interactive TUI or `-p`)
- **Select bridged models:**
  - `/model codebuddy-cli/deepseek-v4.1-flash` (`x0.00` free) or `omp --model @codebuddy`
  - `/model openai-codex/gpt-6-luna` (fast native OAuth) or `omp --model @codex`
  - `/model codex-cli/gpt-reserve` or `/model openai-codex/gpt-reserve`
  - `/model opencode-cli/opencode/deepseek-v4.1-flash-free`
- **Delegate to autonomous CLI sub-agents:**
  - `/codebuddy run [--edit|--full] [--model <id>] <prompt>` (or tool `codebuddy_delegate`)
  - `/codex review` (runs `codex review` on uncommitted git changes)
  - `/codex run [--edit|--full] [--model <id>] <prompt>` (or tool `codex_delegate`)
  - Native parallel fan-out via OMP `task` tool using `agent: "codebuddy"` or `agent: "codex"`.

### Sharing OMP Credentials Outbound to OpenCode, CodeBuddy, and Codex
1. Start the gateway before launching external CLIs:
   ```bash
   omp-gateway start
   ```
2. Use OMP models inside external CLIs:
   - **OpenCode:** `opencode -m omp-gateway/google-antigravity/gemini-4-argon` or `opencode -m omp-gateway/openai-codex/gpt-6-luna`
   - **CodeBuddy:** `codebuddy --model google-antigravity/gemini-4-argon`
   - **Codex CLI:** `codex -c model_provider="omp_gateway" -m google-antigravity/gemini-3.8-flash`
3. Stop the gateway when finished to return to `0 MB` idle RAM:
   ```bash
   omp-gateway stop
   ```

## 4. Checking Quotas (4-in-1 Unified Report)

From any terminal:
```bash
omp-gateway quota
```
Or inside OMP TUI:
```text
/omp-gateway quota
/codex quota
/codebuddy quota
/opencode-omp quota
```
Reports:
1. **OMP & ChatGPT/Codex OAuth (`omp usage`):** Multi-account `google-antigravity` 5h/7d bars, `openai-codex` window usage & saved reset credits, and `zai`.
2. **CodeBuddy Credit Multipliers:** Lists `x0.00` free models (`deepseek-v4.1-flash`, `hy3`) vs credit-weighted models (`x0.03` to `x6.67`) from `~/.codebuddy/local_storage/`.
3. **OpenCode Free Tier:** Countdown to daily reset (`00:00 UTC` / `07:00 WIB`) and 24-hour local token usage (`opencode --pure stats --days 1`).

## 5. Troubleshooting Checklist

1. **Run diagnostics first:** `omp-bridges doctor` and `omp-gateway status`.
2. **Codex token rotated after re-login in Codex CLI:** Run `/codex sync-auth` inside OMP or `omp-gateway start` to re-import `~/.codex/auth.json`.
3. **Windows `opencode` spawn error (`EINVAL`/`ENOENT`):** Ensure `OPENCODE_OMP_BIN` in `~/.omp/agent/.env` points directly to `opencode.exe` (`omp-bridges setup` configures this automatically).
4. **30s startup stall from OpenCode Figma MCP:** Confirm `"figma"` is listed in `disabledServers` inside `~/.omp/agent/mcp.json`.
5. **Port `8765` or `4000` already in use:** Override with `OMP_BROKER_BIND=127.0.0.1:18765` and `OMP_GATEWAY_BIND=127.0.0.1:14000`, then run `omp-gateway restart`.
