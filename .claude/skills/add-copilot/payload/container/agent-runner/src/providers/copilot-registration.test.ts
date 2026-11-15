import { describe, expect, it } from 'bun:test';
import { listProviderNames } from './provider-registry.js';
import './index.js';

describe('copilot provider registration', () => {
  it('registers copilot via the provider barrel', () => {
    expect(listProviderNames()).toContain('copilot');
  });
});
