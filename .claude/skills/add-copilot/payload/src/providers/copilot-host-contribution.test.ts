import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import './index.js';
import '../provider-contracts/index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import { resolveCopilotContainerEnv } from './copilot.js';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-copilot-host-'));

describe('copilot host container contribution', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('extracts COPILOT_GITHUB_TOKEN and optional COPILOT_* overrides from hostEnv', () => {
    const env = resolveCopilotContainerEnv(
      {
        COPILOT_GITHUB_TOKEN: 'github_pat_test_token_123',
        COPILOT_MODEL: 'gpt-4.1',
        COPILOT_RUNTIME_MODE: 'node-bridge',
      },
      {},
    );

    expect(env).toEqual({
      COPILOT_GITHUB_TOKEN: 'github_pat_test_token_123',
      COPILOT_MODEL: 'gpt-4.1',
      COPILOT_RUNTIME_MODE: 'node-bridge',
    });
  });

  it('falls back to .env values when hostEnv omits COPILOT_GITHUB_TOKEN', () => {
    const env = resolveCopilotContainerEnv(
      {},
      {
        COPILOT_GITHUB_TOKEN: 'gho_dotenv_token_456',
        COPILOT_LOG_LEVEL: 'info',
      },
    );

    expect(env).toEqual({
      COPILOT_GITHUB_TOKEN: 'gho_dotenv_token_456',
      COPILOT_LOG_LEVEL: 'info',
    });
  });

  it('returns only env when coreOwnsProviderSurfaces is true', async () => {
    const fn = getProviderContainerConfig('copilot');
    expect(fn).toBeDefined();

    const contribution = await fn!({
      sessionDir: path.join(TEST_ROOT, 'session-1'),
      agentGroupId: 'ag-copilot',
      groupDir: path.join(TEST_ROOT, 'group-1'),
      selectedSkills: [],
      hostEnv: {
        COPILOT_GITHUB_TOKEN: 'github_pat_surface_test',
      },
      coreOwnsProviderSurfaces: true,
    });

    expect(contribution.mounts).toBeUndefined();
    expect(contribution.env).toEqual({
      COPILOT_GITHUB_TOKEN: 'github_pat_surface_test',
    });
  });
});
