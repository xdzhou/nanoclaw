# Remove GitHub Copilot Provider (`add-copilot`)

Before removing the provider, switch every agent group using `copilot` back to `claude` (or another installed provider):

```bash
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

Use `/migrate-memory` first if needed. Do not edit materialized `container.json` files or clear database rows directly.

## 1. Remove barrel imports

Delete `import './copilot.js';` from these five barrels, leaving all other imports intact:

- `src/providers/index.ts`
- `src/provider-contracts/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `container/agent-runner/src/provider-contracts/index.ts`
- `setup/providers/index.ts`

## 2. Delete skill-owned files

Delete each destination file copied by [SKILL.md](SKILL.md) (leave shared registries, `exchange-archive.ts`, `cwd-shim.ts`, and `container/AGENTS.md` if shared with another provider such as `codex`):

```bash
rm -f \
  src/providers/copilot.ts \
  src/providers/copilot-agents-md.ts \
  src/providers/copilot-registration.test.ts \
  src/providers/copilot-host-contribution.test.ts \
  src/provider-contracts/copilot.ts \
  container/agent-runner/src/providers/copilot-client.ts \
  container/agent-runner/src/providers/copilot-node-bridge.mjs \
  container/agent-runner/src/providers/copilot.ts \
  container/agent-runner/src/providers/copilot-registration.test.ts \
  container/agent-runner/src/providers/copilot.conformance.test.ts \
  container/agent-runner/src/providers/copilot.test.ts \
  container/agent-runner/src/provider-contracts/copilot.ts \
  setup/providers/copilot.ts \
  setup/providers/copilot-registration.test.ts
```

`container/AGENTS.md` stays only if another installed provider uses agent surfaces (e.g. `codex` or `cursor`); otherwise remove it too (`rm -f container/AGENTS.md`).

## 3. Remove container SDK dependency & rebuild

```bash
cd container/agent-runner && bun remove @github/copilot-sdk
cd ../..
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

## 4. Clean environment & restart host

If `DEFAULT_AGENT_PROVIDER=copilot` is set in `.env`, reset it to `claude` (or another installed provider). Optionally remove `COPILOT_GITHUB_TOKEN`, `COPILOT_MODEL`, `COPILOT_CLI_PATH`, `COPILOT_RUNTIME_MODE`, and `COPILOT_LOG_LEVEL` from `.env`, then restart the NanoClaw host:

```bash
bash setup/lib/restart.sh
```
