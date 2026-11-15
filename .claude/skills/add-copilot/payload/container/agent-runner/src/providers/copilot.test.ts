import { describe, expect, it } from 'bun:test';
import {
  buildCopilotSdkCompatibilityWarning,
  classifyCopilotError,
  createAutoFallbackClient,
  parseToolConfigurationWarning,
  resolveCopilotInference,
  resolveCopilotMcpServers,
  type CopilotClientHandle,
  type CopilotSessionEvent,
  type CopilotSessionHandle,
} from './copilot-client.js';
import { CopilotProvider } from './copilot.js';
import type { ProviderEvent } from './types.js';

function createFakeRuntime(
  eventsPerTurn: CopilotSessionEvent[][],
  sessionId = 'copilot-sess-1',
  knownMetadata: Record<string, unknown> = { [sessionId]: { sessionId } },
) {
  const sentPrompts: string[] = [];
  const createCalls: unknown[] = [];
  const resumeCalls: Array<{ sessionId: string; params: unknown }> = [];
  let turnIdx = 0;

  const client: CopilotClientHandle = {
    async start() {},
    async createSession(params) {
      createCalls.push(params);
      return makeSession();
    },
    async resumeSession(id, params) {
      resumeCalls.push({ sessionId: id, params });
      if (!knownMetadata[id]) {
        throw new Error(`session not found: ${id}`);
      }
      return makeSession();
    },
    async stop() {},
  };

  function makeSession(): CopilotSessionHandle {
    const handlers = new Set<(ev: CopilotSessionEvent) => void>();
    return {
      sessionId,
      on(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async send({ prompt }) {
        sentPrompts.push(prompt);
        const batch = eventsPerTurn[turnIdx++] ?? [{ type: 'session.idle', data: {} }];
        queueMicrotask(() => {
          for (const ev of batch) {
            for (const h of handlers) h(ev);
          }
        });
        return `msg-${turnIdx}`;
      },
      async abort() {},
      async disconnect() {},
    };
  }

  return {
    deps: {
      createCopilotClient: async () => client,
    },
    sentPrompts,
    createCalls,
    resumeCalls,
  };
}

describe('CopilotProvider unit tests', () => {
  it('fails fast with auth error when COPILOT_GITHUB_TOKEN is absent', async () => {
    const fake = createFakeRuntime([]);
    const provider = new CopilotProvider({ env: {} }, fake.deps);
    const q = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
    q.end();

    const events: ProviderEvent[] = [];
    for await (const ev of q.events) events.push(ev);

    expect(events[0]).toMatchObject({ type: 'error', classification: 'auth', retryable: false });
    expect(events[1]).toMatchObject({ type: 'result', isError: true });
  });

  it('creates a session, emits init + activity + result, and resumes on continuation', async () => {
    const fake = createFakeRuntime([
      [
        { type: 'assistant.turn_start', data: {} },
        { type: 'assistant.message_delta', data: { deltaContent: 'Hello ' } },
        { type: 'assistant.message_delta', data: { deltaContent: 'world' } },
        { type: 'assistant.message', data: { content: 'Hello world' } },
        { type: 'session.idle', data: {} },
      ],
    ]);

    const provider = new CopilotProvider(
      {
        model: 'gpt-4.1',
        effort: 'high',
        env: { COPILOT_GITHUB_TOKEN: 'github_pat_fake_123' },
        mcpServers: {
          nanoclaw: { command: 'node', args: ['mcp.js'], cwd: '/workspace/agent' },
        },
      },
      fake.deps,
    );

    const q = provider.query({
      prompt: 'Ping',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'System rules' },
    });
    q.end();

    const events: ProviderEvent[] = [];
    for await (const ev of q.events) events.push(ev);

    expect(events[0]).toEqual({ type: 'init', continuation: 'copilot-sess-1' });
    expect(events.some((e) => e.type === 'activity')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'result', text: 'Hello world' });
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]).toMatchObject({
      model: 'gpt-4.1',
      reasoningEffort: 'high',
      workingDirectory: '/workspace/agent',
      mcpServers: {
        nanoclaw: {
          type: 'stdio',
          command: 'node',
          args: ['mcp.js'],
          workingDirectory: '/workspace/agent',
          tools: ['*'],
        },
      },
      systemMessage: { mode: 'append', content: 'System rules' },
    });

    const q2 = provider.query({
      prompt: 'Follow-up',
      continuation: 'copilot-sess-1',
      cwd: '/workspace/agent',
    });
    q2.end();
    for await (const _ of q2.events) {
      // drain
    }
    expect(fake.resumeCalls).toHaveLength(1);
    expect(fake.resumeCalls[0].sessionId).toBe('copilot-sess-1');
  });

  it('resolves inference, mcpServers, and classifies errors accurately', () => {
    expect(resolveCopilotInference({ model: 'gpt-5', effort: 'max' }, {})).toEqual({
      model: 'gpt-5',
      reasoningEffort: 'xhigh',
    });
    expect(
      resolveCopilotMcpServers({
        remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
      }),
    ).toEqual({
      remote: {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
        tools: ['*'],
      },
    });
    expect(classifyCopilotError('HTTP 401 Bad credentials')).toBe('auth');
    expect(classifyCopilotError('Session not found: abc')).toBe('stale-session');
    expect(parseToolConfigurationWarning('Disabled tools: bash, edit')).toEqual({
      disabledTools: ['bash', 'edit'],
    });
    expect(parseToolConfigurationWarning('Unknown tool name: foo, bar')).toEqual({
      unknownTools: ['foo', 'bar'],
    });
    expect(buildCopilotSdkCompatibilityWarning('1.0.34', '1.0.34')).toBeUndefined();
    expect(buildCopilotSdkCompatibilityWarning('^1.0.34', '1.0.34')).toContain('not pinned');
    expect(buildCopilotSdkCompatibilityWarning('1.0.34', '1.0.11')).toContain('does not match');
  });

  it('falls back to createSession when resumeSession refuses a stale id, and emits config warnings', async () => {
    const fake = createFakeRuntime(
      [
        [
          {
            type: 'session.info',
            data: { infoType: 'configuration', message: 'Disabled tools: web_search' },
          },
          { type: 'assistant.message', data: { content: 'Done' } },
          { type: 'session.idle', data: {} },
        ],
      ],
      'fresh-sess',
      {},
    );

    const provider = new CopilotProvider({ env: { COPILOT_GITHUB_TOKEN: 'github_pat_fake_123' } }, fake.deps);
    const q = provider.query({
      prompt: 'Check',
      continuation: 'expired-sess',
      cwd: '/workspace/agent',
    });
    q.end();

    const events: ProviderEvent[] = [];
    for await (const ev of q.events) events.push(ev);

    expect(fake.resumeCalls).toHaveLength(1);
    expect(fake.resumeCalls[0].sessionId).toBe('expired-sess');
    expect(fake.createCalls).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'init', continuation: 'fresh-sess' });
    expect(events.some((e) => e.type === 'progress' && e.message.includes('disabled tools: web_search'))).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'result', text: 'Done' });
  });

  it('falls back to node bridge when direct client start() fails in auto mode', async () => {
    let directStopped = false;
    let bridgeStarted = false;
    const fakeSession = {
      sessionId: 'bridge-sess',
      on: () => () => {},
      send: async () => 'm1',
      abort: async () => {},
      disconnect: async () => {},
    };
    const autoClient = createAutoFallbackClient(
      async () => ({
        async start() {
          throw new Error('koffi FFI failed to load');
        },
        async createSession() {
          return fakeSession;
        },
        async resumeSession() {
          return fakeSession;
        },
        async stop() {
          directStopped = true;
        },
      }),
      () => ({
        async start() {
          bridgeStarted = true;
        },
        async createSession() {
          return fakeSession;
        },
        async resumeSession() {
          return fakeSession;
        },
        async stop() {},
      }),
    );

    await autoClient.start();
    const session = await autoClient.createSession({});
    expect(directStopped).toBe(true);
    expect(bridgeStarted).toBe(true);
    expect(session.sessionId).toBe('bridge-sess');
    // The wrapper must not invent optional SDK capabilities: an unconditional
    // getSessionMetadata would make the provider discard every continuation.
    expect('getSessionMetadata' in autoClient).toBe(false);
  });
});
