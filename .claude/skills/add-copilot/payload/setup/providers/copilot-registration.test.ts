import { describe, expect, it } from 'vitest';
import { getSetupProvider } from './registry.js';
import './index.js';

describe('copilot setup registration', () => {
  it('registers copilot with auth + install check via the barrel', () => {
    const copilot = getSetupProvider('copilot');
    expect(copilot).toBeDefined();
    expect(typeof copilot!.runAuth).toBe('function');
    expect(typeof copilot!.runInstallCheck).toBe('function');
  });
});
