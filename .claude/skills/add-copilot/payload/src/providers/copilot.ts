/**
 * Host-side container config for the `copilot` provider.
 *
 * Authentication uses `COPILOT_GITHUB_TOKEN` (from the host environment or
 * `.env`, because launchd/systemd units do not load `.env` into process.env).
 *
 * When `ctx.coreOwnsProviderSurfaces` is true (contract core), core already
 * realizes AGENTS.md, `.copilot-shared` (`/home/node/.copilot`), and
 * `.agents/skills` from `src/provider-contracts/copilot.ts`, so this callback
 * returns only the container env vars. On pre-contract cores, it composes
 * AGENTS.md, syncs skill links, and returns both mounts and env vars.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { readEnvFile } from '../env.js';
import { materializeTemplateSkills } from '../group-skills.js';
import { log } from '../log.js';
import { composeGroupAgentsMd } from './copilot-agents-md.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

export const COPILOT_TOKEN_ENV_KEY = 'COPILOT_GITHUB_TOKEN';
export const COPILOT_PASSTHROUGH_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'COPILOT_MODEL',
  'COPILOT_CLI_PATH',
  'COPILOT_RUNTIME_MODE',
  'COPILOT_LOG_LEVEL',
] as const;

export function resolveCopilotContainerEnv(
  hostEnv: NodeJS.ProcessEnv,
  dotenvOverride?: Record<string, string | undefined>,
): Record<string, string> {
  const dotenv = dotenvOverride ?? readEnvFile([...COPILOT_PASSTHROUGH_KEYS]);
  const env: Record<string, string> = {};

  for (const key of COPILOT_PASSTHROUGH_KEYS) {
    const value = hostEnv[key]?.trim() || dotenv[key]?.trim();
    if (value) env[key] = value;
  }

  if (!env[COPILOT_TOKEN_ENV_KEY]) {
    log.warn('COPILOT_GITHUB_TOKEN is not set; Copilot container sessions will fail authentication until configured');
  }

  return env;
}

registerProviderContainerConfig(
  'copilot',
  async (ctx) => {
    const env = resolveCopilotContainerEnv(ctx.hostEnv);
    const coreOwnsProviderSurfaces = (ctx as typeof ctx & { coreOwnsProviderSurfaces?: true })
      .coreOwnsProviderSurfaces;

    if (coreOwnsProviderSurfaces) {
      return { env };
    }

    const copilotDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.copilot-shared');
    fs.mkdirSync(copilotDir, { recursive: true });

    const group = await getAgentGroup(ctx.agentGroupId);
    if (group) await composeGroupAgentsMd(group, ctx.groupDir);

    syncCopilotSkillLinks(ctx.groupDir, ctx.selectedSkills);
    materializeTemplateSkills(ctx.agentGroupId, path.join(ctx.groupDir, '.agents', 'skills'));

    const mounts = [{ hostPath: copilotDir, containerPath: '/home/node/.copilot', readonly: false }];

    const composedAgentsMd = path.join(ctx.groupDir, 'AGENTS.md');
    if (fs.existsSync(composedAgentsMd)) {
      mounts.push({ hostPath: composedAgentsMd, containerPath: '/workspace/agent/AGENTS.md', readonly: true });
    }

    const agentsDir = path.join(ctx.groupDir, '.agents');
    if (fs.existsSync(agentsDir)) {
      mounts.push({ hostPath: agentsDir, containerPath: '/workspace/agent/.agents', readonly: true });
      mounts.push({ hostPath: agentsDir, containerPath: '/home/node/.agents', readonly: true });
    }

    return { mounts, env };
  },
  { providesAgentSurfaces: true },
);

function syncCopilotSkillLinks(groupDir: string, selectedSkills: string[]): void {
  const skillsDir = path.join(groupDir, '.agents', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  const desired = new Set(selectedSkills);

  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desired.has(entry)) fs.unlinkSync(entryPath);
  }

  for (const skill of selectedSkills) {
    const linkPath = path.join(skillsDir, skill);
    try {
      fs.lstatSync(linkPath);
    } catch {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}
