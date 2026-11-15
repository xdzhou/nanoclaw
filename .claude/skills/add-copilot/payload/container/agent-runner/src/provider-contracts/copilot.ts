import {
  resolveCopilotExecutionPolicy,
  resolveCopilotInference,
  resolveCopilotMcpServers,
  resolveCopilotMemoryRuntime,
} from '../providers/copilot-client.js';
import { registerProviderContract } from '../providers/provider-registry.js';
import { archiveProviderExchange } from './exchange-archive.js';
import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type ProviderRuntimeContract,
  type RuntimeAfterExchangeInput,
  type RuntimeCallbackEffects,
} from './registry.js';

const provider = 'copilot';

export const copilotRuntimeContract: ProviderRuntimeContract = {
  seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  configuration: {
    executionPolicy: { constant: resolveCopilotExecutionPolicy() },
    inference: resolveCopilotInference,
    memory: { constant: resolveCopilotMemoryRuntime() },
    mcpServers: resolveCopilotMcpServers,
  },
  history: { afterExchange: archiveCopilotExchange },
  textDelivery: 'result',
  commands: { formatting: 'xml' },
};

registerProviderContract(provider, copilotRuntimeContract);

function archiveCopilotExchange({ exchange }: RuntimeAfterExchangeInput, fx: RuntimeCallbackEffects): string | null {
  return archiveProviderExchange({
    provider,
    prompt: exchange.prompt,
    result: exchange.result,
    continuation: exchange.continuation,
    status: exchange.status,
    timestamp: new Date(fx.now()),
  });
}
