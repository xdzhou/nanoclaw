---
name: add-copilot
description: Use GitHub Copilot SDK (@github/copilot-sdk) as an agent provider with COPILOT_GITHUB_TOKEN authentication — not the Anthropic Agent SDK. Per group via `ncl groups config update --provider copilot`; host passes COPILOT_GITHUB_TOKEN and Copilot state/skill mounts when spawning containers.
metadata:
  nanoclaw-provider: copilot
  nanoclaw-provider-label: GitHub Copilot
  nanoclaw-provider-hint: GitHub Copilot SDK (COPILOT_GITHUB_TOKEN)
  nanoclaw-provider-offered: 'true'
  nanoclaw-provider-image: local-required
---

# GitHub Copilot agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth copilot` runs the auth check and install verification once this payload is applied. The steps below apply the skill's payload deterministically.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the **GitHub Copilot** provider powered by `@github/copilot-sdk` (`1.0.34`, exact pin): copy this skill's payload, append one import to each of the five provider/contract/setup barrels, pin `@github/copilot-sdk` in `container/agent-runner`, rebuild the container image and host, and configure `COPILOT_GITHUB_TOKEN` in `.env` (or the host environment).

The container-side runtime runs `@github/copilot-sdk` with `COPILOT_GITHUB_TOKEN` (`gitHubToken` + `useLoggedInUser: false`), supports native streaming, MCP tools (`stdio` with native `workingDirectory` and `http`), NanoClaw memory injection on session start, server/CLI-side session resumption (`sessionId` continuation, falling back to a fresh session when the SDK refuses a stale id), mid-turn steering, and exchange archiving via core's shared `exchange-archive.ts`. Because `agent-runner` runs on Bun while `@github/copilot-sdk` depends on `koffi` native FFI bindings, `copilot-client.ts` supports both direct Bun import and automatic fallback (including when `client.start()` fails on FFI/runtime spawn) to a thin `node` 22 stdio NDJSON bridge (`copilot-node-bridge.mjs`) inside the `node:22-slim` container.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run.

## Install

### Pre-flight

Requires `src/project-doc-compose.ts`, `src/provider-contracts/registry.ts` (`PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1`), and core's shared exchange archive (`container/agent-runner/src/provider-contracts/exchange-archive.ts`) on trunk. If any is missing, stop and tell the operator to run `/update-nanoclaw` first.

```nc:run effect:refresh capture:copilot_core_ready validate:^yes$
node -e "const fs=require('fs'); const p='src/provider-contracts/registry.ts', d='src/project-doc-compose.ts', a='container/agent-runner/src/provider-contracts/exchange-archive.ts'; if(fs.existsSync(p) && fs.existsSync(d) && fs.existsSync(a) && /PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1/.test(fs.readFileSync(p,'utf8'))) console.log('yes'); else console.log('no')"
```

Check whether the payload is already wired (a prior apply, or a trunk that already carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/copilot.ts`, `src/providers/copilot-agents-md.ts`, `src/provider-contracts/copilot.ts`
- `container/agent-runner/src/providers/copilot.ts`, `copilot-client.ts`, `copilot-node-bridge.mjs`, and `container/agent-runner/src/provider-contracts/copilot.ts`
- `setup/providers/copilot.ts`
- `import './copilot.js';` in all five barrels (`src/providers/index.ts`, `src/provider-contracts/index.ts`, `container/agent-runner/src/providers/index.ts`, `container/agent-runner/src/provider-contracts/index.ts`, `setup/providers/index.ts`)
- `@github/copilot-sdk` pinned in `container/agent-runner/package.json`

### 1. Copy the payload

Copy the Copilot payload from this skill's `payload/` into the host, container, and setup trees (additive — overwrite each file).

```nc:copy when:copilot_core_ready=yes
payload/container/AGENTS.md -> container/AGENTS.md
payload/src/providers/copilot.ts -> src/providers/copilot.ts
payload/src/providers/copilot-agents-md.ts -> src/providers/copilot-agents-md.ts
payload/src/providers/copilot-registration.test.ts -> src/providers/copilot-registration.test.ts
payload/src/providers/copilot-host-contribution.test.ts -> src/providers/copilot-host-contribution.test.ts
payload/src/provider-contracts/copilot.ts -> src/provider-contracts/copilot.ts
payload/container/agent-runner/src/providers/copilot-client.ts -> container/agent-runner/src/providers/copilot-client.ts
payload/container/agent-runner/src/providers/copilot-node-bridge.mjs -> container/agent-runner/src/providers/copilot-node-bridge.mjs
payload/container/agent-runner/src/providers/copilot.ts -> container/agent-runner/src/providers/copilot.ts
payload/container/agent-runner/src/providers/copilot-registration.test.ts -> container/agent-runner/src/providers/copilot-registration.test.ts
payload/container/agent-runner/src/providers/copilot.conformance.test.ts -> container/agent-runner/src/providers/copilot.conformance.test.ts
payload/container/agent-runner/src/providers/copilot.test.ts -> container/agent-runner/src/providers/copilot.test.ts
payload/container/agent-runner/src/provider-contracts/copilot.ts -> container/agent-runner/src/provider-contracts/copilot.ts
payload/setup/providers/copilot.ts -> setup/providers/copilot.ts
payload/setup/providers/copilot-registration.test.ts -> setup/providers/copilot-registration.test.ts
```

### 2. Wire the five barrels

Append `import './copilot.js';` to each of the five barrels (idempotent — skip if already present).

```nc:append to:src/providers/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:src/provider-contracts/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:container/agent-runner/src/providers/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:container/agent-runner/src/provider-contracts/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

```nc:append to:setup/providers/index.ts when:copilot_core_ready=yes
import './copilot.js';
```

### 3. Agent-runner dependency

Pin `@github/copilot-sdk` (`1.0.34`, exact pin, which bundles the platform Copilot CLI runtime and JSON-RPC client) in `container/agent-runner/` using `nc:dep` (Bun, not the host pnpm workspace).

```nc:dep manager:bun cwd:container/agent-runner when:copilot_core_ready=yes
@github/copilot-sdk@1.0.34
```

### 4. Build

```nc:run effect:build when:copilot_core_ready=yes
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 5. Validate

Run the host provider contract verifier and the Copilot unit/conformance tests:

```nc:run effect:test when:copilot_core_ready=yes
pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared copilot
pnpm exec vitest run src/providers/copilot-registration.test.ts src/providers/copilot-host-contribution.test.ts setup/providers/copilot-registration.test.ts
cd container/agent-runner && bun test --isolate src/providers/copilot*.test.ts
```

## Authenticate (`COPILOT_GITHUB_TOKEN`)

```nc:run effect:external when:copilot_core_ready=yes
pnpm exec tsx setup/index.ts --step provider-auth copilot
```

Or configure `COPILOT_GITHUB_TOKEN` directly in `.env`:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key COPILOT_GITHUB_TOKEN --value <your-github-copilot-token>
```

**Token requirements & security note:**
- Fine-grained GitHub PAT with the **Copilot Requests** permission (`github_pat_...`), GitHub OAuth token (`gho_...` / `ghu_...`), or GitHub App installation token (`ghs_...`) with `copilot-requests` access.
- **Security boundary:** By design for `COPILOT_GITHUB_TOKEN` authentication, the host reads the token from `.env` / host environment and passes `COPILOT_GITHUB_TOKEN` into the container environment. This carries a lower isolation level than vault-only gateway custody (such as `add-codex` or `add-cursor`, where the container only sees a stub and the gateway injects the real secret on the wire). Prefer short-lived or narrowly scoped tokens (e.g. GitHub App installation tokens or PATs restricted to Copilot Requests).
- Optional overrides in `.env`:
  - `COPILOT_MODEL` — default Copilot model ID when group config omits `--model` (e.g. `gpt-4.1`, `claude-sonnet-4.5`, `gpt-5`).
  - `COPILOT_CLI_PATH` — override path to a custom Copilot CLI binary inside the container (passed via `RuntimeConnection.forStdio({ path })` and `COPILOT_CLI_PATH` env).
  - `COPILOT_RUNTIME_MODE` — `auto` (default: tries direct `@github/copilot-sdk` in Bun and falls back to `node` 22 stdio bridge if FFI/`koffi` or `client.start()` fails), `direct`, or `node-bridge`.
  - `COPILOT_LOG_LEVEL` — `none` | `error` | `warning` | `info` | `debug` | `all` (default: `warning`).

**Egress Lockdown / Gateway note:**
When `NANOCLAW_EGRESS_LOCKDOWN=true`, the host contract declares `github.com`, `api.github.com`, `api.githubcopilot.com`, and `copilot-proxy.githubusercontent.com` in `modelDomains`. Ensure your active gateway allow-lists these domains (or route through a configured gateway rule) so the container can reach the Copilot API.

## Repository CI & Pin Wiring

Two repo-level files keep this skill green in `registry-skills.yml` (`discover` / `registry-gate`) and `skill-pins:check`, and are wired in the same change as the skill:

1. **`.github/workflows/registry-skills.yml`** lists `- { skill: add-copilot, bun: true }` in the `test` matrix (alphabetically between `add-codex` and `add-cursor`).
2. **`.github/skill-pins/package.json`** mirrors `@github/copilot-sdk@1.0.34` from this skill's `nc:dep` fence. After bumping the SDK pin, run `pnpm run skill-pins:generate` and commit the updated shadow manifest.
3. **`apply-fixtures.json`** stubs the `copilot_core_ready` pre-flight capture so the skill-conformance harness can apply every `when:`-guarded directive programmatically.

## Use it

After applying the steps above on a running NanoClaw host, restart the host so it loads the Copilot registration:

```bash
bash setup/lib/restart.sh
```

Then switch an existing group to `copilot` and restart that group:

```bash
ncl groups config update --id <group-id> --provider copilot
ncl groups restart --id <group-id>
```

Optionally override the model or reasoning effort per group:

```bash
ncl groups config update --id <group-id> --model gpt-4.1 --effort high
```

### Default new groups to copilot (optional)

New groups use `DEFAULT_AGENT_PROVIDER` in `.env` (default `claude`). To make `copilot` the default for newly created groups:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value copilot
bash setup/lib/restart.sh
```

## Troubleshooting

- **Container exits with `Unknown provider: copilot`:** the host or container barrel import is missing, or the host wasn't restarted after `pnpm run build`.
- **Auth error (`COPILOT_GITHUB_TOKEN is required` or `401` / `403`):** verify `COPILOT_GITHUB_TOKEN` is set in `.env` (or service env) and has Copilot access. Re-run `pnpm exec tsx setup/index.ts --step provider-auth copilot`.
- **Egress lockdown blocks Copilot API calls:** verify your gateway permits `api.githubcopilot.com`, `api.github.com`, `github.com`, and `copilot-proxy.githubusercontent.com`.
- **Bun FFI / `koffi` load error inside container:** `COPILOT_RUNTIME_MODE=auto` automatically falls back to `node-bridge` if `import` or `client.start()` fails; you can also force `COPILOT_RUNTIME_MODE=node-bridge` in `.env`.
