import {
  type CopilotClientFactoryOptions,
  type CopilotClientHandle,
  type CopilotInferenceConfig,
  type CopilotMcpEntry,
  type CopilotMemoryHookConfig,
  type CopilotSessionEvent,
  type CopilotSessionHandle,
  STALE_COPILOT_SESSION_RE,
  buildCopilotSdkCompatibilityWarning,
  classifyCopilotError,
  createCopilotClient,
  formatToolConfigurationWarning,
  readCopilotSdkVersionInfo,
  resolveCopilotInference,
  resolveCopilotMcpServers,
} from './copilot-client.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const COPILOT_HOME_DIR = '/home/node/.copilot';
const COPILOT_SKILL_DIRS = ['/workspace/agent/.agents/skills', '/home/node/.copilot/skills'];

export interface CopilotRuntimeDeps {
  createCopilotClient: (options: CopilotClientFactoryOptions) => Promise<CopilotClientHandle>;
}

export interface CopilotResolvedConfiguration {
  executionPolicy?: unknown;
  inference?: unknown;
  mcpServers?: unknown;
  tone?: unknown;
}

export const defaultCopilotRuntimeDeps: CopilotRuntimeDeps = {
  createCopilotClient,
};

export class CopilotProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private readonly assistantName?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly additionalDirectories: string[];
  private readonly inference: CopilotInferenceConfig;
  private readonly mcpServers: Record<string, CopilotMcpEntry>;
  private readonly runtime: CopilotRuntimeDeps;
  private memorySessionHook?: CopilotMemoryHookConfig;

  constructor(
    options: ProviderOptions = {},
    runtime: CopilotRuntimeDeps = defaultCopilotRuntimeDeps,
    configuration?: CopilotResolvedConfiguration,
  ) {
    this.runtime = runtime;
    this.assistantName = options.assistantName;
    this.env = options.env ?? process.env;
    this.additionalDirectories = options.additionalDirectories ?? [];

    if (configuration) {
      this.inference = (configuration.inference as CopilotInferenceConfig | undefined) ?? {};
      this.mcpServers = (configuration.mcpServers as Record<string, CopilotMcpEntry> | undefined) ?? {};
    } else {
      this.inference = resolveCopilotInference(
        { model: options.model, effort: options.effort },
        this.env as NodeJS.ProcessEnv,
      );
      this.mcpServers = resolveCopilotMcpServers(options.mcpServers ?? {});
    }
  }

  registerMemorySessionHook(hook: CopilotMemoryHookConfig): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_COPILOT_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [input.prompt];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let inFlightTurn = false;
    let activeSession: CopilotSessionHandle | null = null;

    const wake = (): void => {
      waiting?.();
      waiting = null;
    };

    const pushOrSteer = (message: string): void => {
      if (activeSession && inFlightTurn) {
        void activeSession.send({ prompt: message }).catch(() => {
          pending.push(message);
          wake();
        });
        return;
      }
      pending.push(message);
      wake();
    };

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      const token = (self.env.COPILOT_GITHUB_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN)?.trim();
      if (!token) {
        yield {
          type: 'error',
          message: 'COPILOT_GITHUB_TOKEN is not set. Configure COPILOT_GITHUB_TOKEN on the host and restart.',
          retryable: false,
          classification: 'auth',
        };
        yield {
          type: 'result',
          text: null,
          isError: true,
          error: 'COPILOT_GITHUB_TOKEN is missing.',
        };
        return;
      }

      const rawMode = (self.env.COPILOT_RUNTIME_MODE ?? process.env.COPILOT_RUNTIME_MODE)?.trim();
      const runtimeMode =
        rawMode === 'direct' || rawMode === 'node-bridge' || rawMode === 'auto' ? rawMode : 'auto';
      const rawLogLevel = (self.env.COPILOT_LOG_LEVEL ?? process.env.COPILOT_LOG_LEVEL)?.trim();
      const logLevel =
        rawLogLevel === 'none' ||
        rawLogLevel === 'error' ||
        rawLogLevel === 'warning' ||
        rawLogLevel === 'info' ||
        rawLogLevel === 'debug' ||
        rawLogLevel === 'all'
          ? rawLogLevel
          : 'warning';

      const client = await self.runtime.createCopilotClient({
        gitHubToken: token,
        baseDirectory: COPILOT_HOME_DIR,
        workingDirectory: input.cwd,
        logLevel,
        cliPath: (self.env.COPILOT_CLI_PATH ?? process.env.COPILOT_CLI_PATH)?.trim() || undefined,
        runtimeMode,
        env: self.env,
        memoryHook: self.memorySessionHook,
      });

      let unsubscribe: (() => void) | null = null;

      try {
        const versionInfo = readCopilotSdkVersionInfo();
        if (versionInfo.actualVersion) {
          const compatWarning = buildCopilotSdkCompatibilityWarning(
            versionInfo.expectedVersion,
            versionInfo.actualVersion,
          );
          if (compatWarning) console.error(`[copilot] ${compatWarning}`);
        }

        await client.start();

        const sessionParams = {
          ...(self.inference.model ? { model: self.inference.model } : {}),
          ...(self.inference.reasoningEffort ? { reasoningEffort: self.inference.reasoningEffort } : {}),
          workingDirectory: input.cwd,
          ...(self.additionalDirectories.length > 0 ? { additionalDirectories: self.additionalDirectories } : {}),
          ...(Object.keys(self.mcpServers).length > 0 ? { mcpServers: self.mcpServers } : {}),
          ...(input.systemContext?.instructions
            ? { systemMessage: { mode: 'append' as const, content: input.systemContext.instructions } }
            : {}),
          skillDirectories: COPILOT_SKILL_DIRS,
          streaming: true,
          ...(self.assistantName ? { clientName: `nanoclaw-${self.assistantName.toLowerCase()}` } : {}),
        };

        // The Copilot SDK has no per-session metadata getter (only
        // `listSessions()`), so a stale continuation cannot be detected up
        // front. Resume directly and start a fresh session when the SDK
        // refuses. A genuine auth/network failure surfaces again from
        // `createSession` and is reported by the outer catch.
        let session: CopilotSessionHandle;
        if (input.continuation) {
          try {
            session = await client.resumeSession(input.continuation, sessionParams);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(
              `[copilot] could not resume session ${input.continuation}; starting a fresh one: ${message}`,
            );
            session = await client.createSession(sessionParams);
          }
        } else {
          session = await client.createSession(sessionParams);
        }

        activeSession = session;
        yield { type: 'init', continuation: session.sessionId };
        const seenConfigWarnings = new Set<string>();

        while (!aborted) {
          if (pending.length === 0) {
            if (ended) break;
            await new Promise<void>((resolve) => {
              waiting = resolve;
            });
            continue;
          }

          const prompt = pending.shift()!;
          const eventQueue: ProviderEvent[] = [];
          let notifyEvent: (() => void) | null = null;
          let turnDone = false;
          let streamedText = '';
          let finalAssistantMessage = '';
          let turnError: string | undefined;

          const pushEvent = (ev: ProviderEvent): void => {
            eventQueue.push(ev);
            notifyEvent?.();
            notifyEvent = null;
          };

          unsubscribe = session.on((sdkEvent: CopilotSessionEvent) => {
            // Every SDK event emits an activity heartbeat so poll-loop's idle
            // detector stays honest during long tool runs.
            pushEvent({ type: 'activity' });

            const data = sdkEvent.data ?? {};
            if (sdkEvent.type === 'assistant.message_delta') {
              const delta = typeof data.deltaContent === 'string' ? data.deltaContent : '';
              if (delta) {
                streamedText += delta;
              }
            } else if (sdkEvent.type === 'assistant.message') {
              const content = typeof data.content === 'string' ? data.content : '';
              if (content) {
                finalAssistantMessage = content;
              }
            } else if (sdkEvent.type === 'session.info') {
              if (data.infoType === 'configuration' && typeof data.message === 'string') {
                const formatted = formatToolConfigurationWarning(data.message);
                if (formatted && !seenConfigWarnings.has(data.message)) {
                  seenConfigWarnings.add(data.message);
                  pushEvent({ type: 'progress', message: formatted });
                }
              }
            } else if (sdkEvent.type === 'session.error') {
              const message =
                typeof data.message === 'string'
                  ? data.message
                  : typeof data.error === 'string'
                    ? data.error
                    : 'Copilot session failed';
              turnError = message;
              turnDone = true;
              pushEvent({
                type: 'error',
                message,
                retryable: false,
                classification: classifyCopilotError(message),
              });
              pushEvent({ type: 'result', text: null, isError: true, error: message });
            } else if (sdkEvent.type === 'session.idle') {
              if (!turnDone) {
                turnDone = true;
                const output = (finalAssistantMessage || streamedText).trim() || null;
                pushEvent({ type: 'result', text: output });
              }
            }
          });

          const timer = setTimeout(() => {
            if (!turnDone) {
              turnDone = true;
              const msg = 'Copilot turn timed out waiting for session.idle';
              pushEvent({ type: 'error', message: msg, retryable: true });
              pushEvent({ type: 'result', text: null, isError: true, error: msg });
            }
          }, TURN_TIMEOUT_MS);

          try {
            inFlightTurn = true;
            await session.send({ prompt });

            while (!aborted) {
              if (eventQueue.length > 0) {
                const ev = eventQueue.shift()!;
                yield ev;
                if (ev.type === 'result') break;
              } else if (turnDone || turnError) {
                break;
              } else {
                await new Promise<void>((resolve) => {
                  notifyEvent = resolve;
                });
              }
            }
          } finally {
            inFlightTurn = false;
            clearTimeout(timer);
            unsubscribe?.();
            unsubscribe = null;
          }
        }
      } catch (err) {
        if (!aborted) {
          const message = err instanceof Error ? err.message : String(err);
          yield {
            type: 'error',
            message,
            retryable: false,
            classification: classifyCopilotError(message),
          };
          yield {
            type: 'result',
            text: null,
            isError: true,
            error: message,
          };
        }
      } finally {
        unsubscribe?.();
        if (activeSession) {
          await activeSession.disconnect().catch(() => {});
          activeSession = null;
        }
        await client.stop().catch(() => {});
      }
    }

    return {
      push(message: string): void {
        if (ended || aborted) return;
        pushOrSteer(message);
      },
      end(): void {
        ended = true;
        wake();
      },
      abort(): void {
        aborted = true;
        ended = true;
        if (activeSession) {
          void activeSession.abort().catch(() => {});
        }
        wake();
      },
      events: gen(),
    };
  }
}

registerProvider('copilot', (options, configuration) => {
  return new CopilotProvider(options, defaultCopilotRuntimeDeps, configuration as CopilotResolvedConfiguration);
});
