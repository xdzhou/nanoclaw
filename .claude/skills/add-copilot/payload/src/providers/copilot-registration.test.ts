import { describe, expect, it } from 'vitest';
import { listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js';

describe('copilot provider host registration', () => {
  it('registers copilot host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('copilot');
  });
});
