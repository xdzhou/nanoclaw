/**
 * Setup-side registration & COPILOT_GITHUB_TOKEN auth walk-through for the
 * `copilot` provider.
 */
import fs from 'fs';
import path from 'path';
import * as p from '@clack/prompts';
import k from 'kleur';
import { readEnvFile } from '../../src/env.js';
import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { registerSetupProvider } from './registry.js';

const TOKEN_KEY = 'COPILOT_GITHUB_TOKEN';
const COPILOT_SDK_PKG = '@github/copilot-sdk';

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

export function isPlausibleGitHubToken(token: string): boolean {
  const trimmed = token.trim();
  return /^(?:github_pat_|gh[pousr]_)[A-Za-z0-9_-]{12,}$/.test(trimmed);
}

export function upsertEnvVar(key: string, value: string, projectRoot = process.cwd()): void {
  const envPath = path.join(projectRoot, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const encoded = `${key}=${JSON.stringify(value)}`;
  let replaced = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    if (trimmed.slice(0, eqIdx).trim() === key) {
      replaced = true;
      return encoded;
    }
    return line;
  });

  if (!replaced) {
    if (updated.length > 0 && updated[updated.length - 1] !== '') updated.push('');
    updated.push(encoded);
  }

  fs.writeFileSync(envPath, `${updated.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

export interface AvailableCopilotModel {
  id: string;
  name: string;
}

export async function listAvailableCopilotModels(token: string): Promise<AvailableCopilotModel[]> {
  try {
    const sdk = (await import('@github/copilot-sdk')) as {
      CopilotClient: new (opts: Record<string, unknown>) => {
        start(): Promise<void>;
        listModels(): Promise<Array<{ id: string; name: string; policy?: { state?: string } }>>;
        stop(): Promise<unknown>;
      };
    };
    const client = new sdk.CopilotClient({
      gitHubToken: token,
      useLoggedInUser: false,
      logLevel: 'warning',
    });
    try {
      await client.start();
      const models = await client.listModels();
      return models
        .filter((m) => m.policy?.state !== 'disabled')
        .map((m) => ({ id: m.id, name: m.name }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } finally {
      await client.stop().catch(() => {});
    }
  } catch {
    return [];
  }
}

export async function runCopilotAuthStep(projectRoot = process.cwd()): Promise<void> {
  const existing = process.env[TOKEN_KEY]?.trim() || readEnvFile([TOKEN_KEY], projectRoot)[TOKEN_KEY]?.trim();
  if (existing) {
    p.log.success(brandBody(`${TOKEN_KEY} is already configured.`));
    setupLog.step('auth', 'skipped', 0, { REASON: 'copilot-token-already-present', PROVIDER: 'copilot' });
    return;
  }

  const startedAt = Date.now();
  const token = ensureAnswer(
    await p.password({
      message: 'Paste your COPILOT_GITHUB_TOKEN (GitHub PAT with Copilot Requests permission, or gh auth token):',
      validate: (value) => {
        if (!value?.trim()) return 'COPILOT_GITHUB_TOKEN is required.';
        if (!isPlausibleGitHubToken(value)) return 'Enter a valid GitHub token without whitespace.';
        return undefined;
      },
    }),
  ).trim();

  upsertEnvVar(TOKEN_KEY, token, projectRoot);
  setupLog.step('auth', 'success', Date.now() - startedAt, { PROVIDER: 'copilot', METHOD: 'env-token' });
  p.log.success(brandBody(`Saved ${TOKEN_KEY} to .env.`));

  const models = await listAvailableCopilotModels(token);
  if (models.length > 0) {
    const preview = models
      .slice(0, 8)
      .map((m) => m.id)
      .join(', ');
    console.log(k.dim(`   Available Copilot models (${models.length}): ${preview}${models.length > 8 ? ', …' : ''}`));
  }
}

export function verifyCopilotInstall(root = process.cwd()): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const requiredFiles = [
    'src/providers/copilot.ts',
    'src/providers/copilot-agents-md.ts',
    'src/provider-contracts/copilot.ts',
    'container/agent-runner/src/providers/copilot.ts',
    'container/agent-runner/src/providers/copilot-client.ts',
    'container/agent-runner/src/providers/copilot-node-bridge.mjs',
    'container/agent-runner/src/provider-contracts/copilot.ts',
    'setup/providers/copilot.ts',
  ];

  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) {
      problems.push(`missing file: ${file}`);
    }
  }

  const barrels = [
    'src/providers/index.ts',
    'src/provider-contracts/index.ts',
    'container/agent-runner/src/providers/index.ts',
    'container/agent-runner/src/provider-contracts/index.ts',
    'setup/providers/index.ts',
  ];

  for (const barrel of barrels) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './copilot.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const pkgPath = path.join(root, 'container', 'agent-runner', 'package.json');
  let hasSdk = false;
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
      };
      hasSdk = Boolean(pkg.dependencies?.[COPILOT_SDK_PKG]);
    } catch {
      hasSdk = false;
    }
  }
  if (!hasSdk) {
    problems.push(`container/agent-runner/package.json missing dependency ${COPILOT_SDK_PKG}`);
  }

  return { ok: problems.length === 0, problems };
}

export async function runCopilotInstallCheck(root = process.cwd()): Promise<void> {
  p.log.step(brandBody('Checking the GitHub Copilot provider install…'));
  const { ok, problems } = verifyCopilotInstall(root);
  if (ok) {
    setupLog.step('copilot-install', 'success', 0, {});
    p.log.success(brandBody('GitHub Copilot provider installed properly.'));
    return;
  }

  setupLog.step('copilot-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The GitHub Copilot provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  throw new Error(`Copilot provider is not fully installed: ${problems.join('; ')}`);
}

registerSetupProvider({
  value: 'copilot',
  label: 'GitHub Copilot',
  hint: 'GitHub Copilot SDK (COPILOT_GITHUB_TOKEN)',
  runAuth: () => runCopilotAuthStep(),
  runInstallCheck: () => runCopilotInstallCheck(),
});
