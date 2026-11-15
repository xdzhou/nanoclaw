import fs from 'fs';
import { describe, it } from 'bun:test';

const CONFORMANCE_SUITE = '../provider-contracts/testing/conformance.ts';
const hasContractCore = fs.existsSync(new URL(CONFORMANCE_SUITE, import.meta.url));

if (hasContractCore) {
  await import('./index.js');
  await import('../provider-contracts/index.js');
  const { copilotRuntimeContract } = await import('../provider-contracts/copilot.js');
  const { defineProviderConformance } = await import('../provider-contracts/testing/conformance.js');
  defineProviderConformance('copilot', copilotRuntimeContract);
} else {
  describe.skip('runtime provider contract: copilot', () => {
    it('needs the contract core', () => {});
  });
}
