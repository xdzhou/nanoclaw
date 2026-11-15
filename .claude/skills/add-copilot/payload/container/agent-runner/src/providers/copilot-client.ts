import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import type { McpServerConfig } from './types.js';

export type CopilotReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface CopilotExecutionPolicy {
  readonly approveAllTools: true;
  readonly sandboxBoundary: 'container-and-egress-gateway';
}

export interface CopilotInferenceConfig {
  model?: string;
  reasoningEffort?: CopilotReasoningEffort;
}

export interface CopilotMemoryHookConfig {
  command: string;
  legacyCommands: readonly string[];
  sources: readonly string[];
}

export interface CopilotMemoryRuntime {
  readonly sessionHookMode: 'on-session-start-hook';
}

export type CopilotMcpEntry =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      workingDirectory?: string;
      tools: ['*'];
    }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      tools: ['*'];
    };

export interface CopilotSessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface CopilotSessionHandle {
  readonly sessionId: string;
  on(handler: (event: CopilotSessionEvent) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotSessionCreateParams {
  model?: string;
  reasoningEffort?: CopilotReasoningEffort;
  workingDirectory?: string;
  additionalDirectories?: string[];
  mcpServers?: Record<string, CopilotMcpEntry>;
  systemMessage?: { mode: 'append'; content: string };
  skillDirectories?: string[];
  streaming?: boolean;
  clientName?: string;
}

export interface CopilotClientHandle {
  start(): Promise<void>;
  listModels?(): Promise<Array<{ id: string; name: string; policy?: { state?: string } }>>;
  createSession(params: CopilotSessionCreateParams): Promise<CopilotSessionHandle>;
  resumeSession(sessionId: string, params: CopilotSessionCreateParams): Promise<CopilotSessionHandle>;
  stop(): Promise<void>;
}

export interface ToolConfigurationWarning {
  disabledTools?: string[];
  unknownTools?: string[];
}

export interface CopilotSdkVersionInfo {
  expectedVersion?: string;
  actualVersion?: string;
}

export interface CopilotClientFactoryOptions {
  gitHubToken: string;
  baseDirectory: string;
  workingDirectory: string;
  logLevel?: 'none' | 'error' | 'warning' | 'info' | 'debug' | 'all';
  cliPath?: string;
  runtimeMode?: 'auto' | 'direct' | 'node-bridge';
  env?: Record<string, string | undefined>;
  memoryHook?: CopilotMemoryHookConfig;
}

export const STALE_COPILOT_SESSION_RE =
  /session\s*(?:not found|does not exist|expired|invalid|missing)|unknown session/i;

const VALID_REASONING_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);

export function resolveCopilotExecutionPolicy(): CopilotExecutionPolicy {
  return {
    approveAllTools: true,
    sandboxBoundary: 'container-and-egress-gateway',
  };
}

export function resolveCopilotMemoryRuntime(): CopilotMemoryRuntime {
  return { sessionHookMode: 'on-session-start-hook' };
}

export function resolveCopilotInference(
  input: { model?: string; effort?: string; speed?: string },
  environment: NodeJS.ProcessEnv = process.env,
): CopilotInferenceConfig {
  const model = input.model?.trim() || environment.COPILOT_MODEL?.trim() || undefined;
  const rawEffort = input.effort?.trim().toLowerCase();
  let reasoningEffort: CopilotReasoningEffort | undefined;
  if (rawEffort) {
    if (VALID_REASONING_EFFORTS.has(rawEffort)) {
      reasoningEffort = rawEffort as CopilotReasoningEffort;
    } else if (rawEffort === 'max') {
      reasoningEffort = 'xhigh';
    }
  }
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function resolveCopilotMcpServers(
  mcpServers: Record<string, McpServerConfig>,
): Record<string, CopilotMcpEntry> {
  const resolved: Record<string, CopilotMcpEntry> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (config.type === 'http') {
      resolved[name] = {
        type: 'http',
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        tools: ['*'],
      };
    } else {
      resolved[name] = {
        type: 'stdio',
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { workingDirectory: config.cwd } : {}),
        tools: ['*'],
      };
    }
  }
  return resolved;
}

export function classifyCopilotError(message: string): string | undefined {
  if (/COPILOT_GITHUB_TOKEN|unauthorized|forbidden|bad credentials|authentication|login|401|403/i.test(message)) {
    return 'auth';
  }
  if (/quota|rate limit|too many requests|429|billing|copilot.*subscription/i.test(message)) {
    return 'quota';
  }
  if (/permission|sandbox|denied|eacces/i.test(message)) {
    return 'sandbox';
  }
  if (STALE_COPILOT_SESSION_RE.test(message)) {
    return 'stale-session';
  }
  return undefined;
}

export function executeMemoryHookCommand(hook: CopilotMemoryHookConfig | undefined, source: string): string | undefined {
  if (!hook?.command) return undefined;
  try {
    const out = execFileSync('/bin/sh', ['-c', hook.command], {
      input: JSON.stringify({ source }),
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trimmed = out.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function parseToolList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseWarningValue(message: string, prefix: string): string | undefined {
  if (message.length < prefix.length || message.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return undefined;
  }
  const value = message.slice(prefix.length).trim();
  return value.length > 0 ? value : undefined;
}

export function parseToolConfigurationWarning(message: string): ToolConfigurationWarning | null {
  const disabledTools = parseWarningValue(message, 'Disabled tools:');
  if (disabledTools) return { disabledTools: parseToolList(disabledTools) };

  for (const prefix of ['Unknown tool name in the tool allowlist:', 'Unknown tool name:']) {
    const unknownTools = parseWarningValue(message, prefix);
    if (unknownTools) return { unknownTools: parseToolList(unknownTools) };
  }

  if (message.includes('Unknown tool name')) return { unknownTools: [] };
  return null;
}

export function formatToolConfigurationWarning(message: string): string | null {
  const warning = parseToolConfigurationWarning(message);
  if (!warning) return null;
  if (warning.disabledTools && warning.disabledTools.length > 0) {
    return `Copilot tool config warning — disabled tools: ${warning.disabledTools.join(', ')}`;
  }
  if (warning.unknownTools) {
    return warning.unknownTools.length > 0
      ? `Copilot tool config warning — unknown tools: ${warning.unknownTools.join(', ')}`
      : `Copilot tool config warning: ${message}`;
  }
  return null;
}

export function buildCopilotSdkCompatibilityWarning(
  expectedVersion: string | undefined,
  actualVersion: string | undefined,
): string | undefined {
  if (!expectedVersion) {
    return 'Could not verify pinned @github/copilot-sdk version from agent-runner/package.json.';
  }
  const isExactPin = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(expectedVersion);
  if (!isExactPin) {
    return `@github/copilot-sdk is not pinned to an exact version in agent-runner/package.json (${expectedVersion}).`;
  }
  if (!actualVersion) {
    return 'Could not determine the loaded @github/copilot-sdk version at runtime.';
  }
  if (expectedVersion !== actualVersion) {
    return `Loaded @github/copilot-sdk version ${actualVersion} does not match pinned version ${expectedVersion}.`;
  }
  return undefined;
}

export function readCopilotSdkVersionInfo(): CopilotSdkVersionInfo {
  let expectedVersion: string | undefined;
  let actualVersion: string | undefined;
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, unknown> };
    if (typeof pkg.dependencies?.['@github/copilot-sdk'] === 'string') {
      expectedVersion = pkg.dependencies['@github/copilot-sdk'];
    }
  } catch {
    expectedVersion = undefined;
  }
  try {
    const require = createRequire(import.meta.url);
    const sdkPkgPath = require.resolve('@github/copilot-sdk/package.json');
    const sdkPkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf-8')) as { version?: unknown };
    if (typeof sdkPkg.version === 'string') {
      actualVersion = sdkPkg.version;
    }
  } catch {
    actualVersion = undefined;
  }
  return { expectedVersion, actualVersion };
}

export function createAutoFallbackClient(
  createDirect: () => Promise<CopilotClientHandle>,
  createBridge: () => CopilotClientHandle,
): CopilotClientHandle {
  let active: CopilotClientHandle | null = null;

  return {
    async start(): Promise<void> {
      let direct: CopilotClientHandle | null = null;
      try {
        direct = await createDirect();
        await direct.start();
        active = direct;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[copilot] direct SDK client unavailable (${message}); using the node 22 bridge`);
        if (direct) {
          await direct.stop().catch(() => {});
        }
        const bridge = createBridge();
        await bridge.start();
        active = bridge;
      }
    },
    listModels(): Promise<Array<{ id: string; name: string; policy?: { state?: string } }>> {
      if (!active) return Promise.reject(new Error('CopilotClient not started'));
      return active.listModels ? active.listModels() : Promise.resolve([]);
    },
    createSession(params: CopilotSessionCreateParams): Promise<CopilotSessionHandle> {
      if (!active) return Promise.reject(new Error('CopilotClient not started'));
      return active.createSession(params);
    },
    resumeSession(sessionId: string, params: CopilotSessionCreateParams): Promise<CopilotSessionHandle> {
      if (!active) return Promise.reject(new Error('CopilotClient not started'));
      return active.resumeSession(sessionId, params);
    },
    async stop(): Promise<void> {
      if (active) {
        const current = active;
        active = null;
        await current.stop();
      }
    },
  };
}

async function createDirectCopilotClient(options: CopilotClientFactoryOptions): Promise<CopilotClientHandle> {
  const sdk = (await import('@github/copilot-sdk')) as {
    CopilotClient: new (opts: Record<string, unknown>) => {
      start(): Promise<void>;
      listModels?(): Promise<Array<{ id: string; name: string; policy?: { state?: string } }>>;
      createSession(cfg: Record<string, unknown>): Promise<CopilotSessionHandle>;
      resumeSession(id: string, cfg: Record<string, unknown>): Promise<CopilotSessionHandle>;
      stop(): Promise<unknown>;
    };
    RuntimeConnection?: {
      forStdio: (opts?: { path?: string; args?: readonly string[]; env?: Record<string, string> }) => unknown;
    };
    approveAll: unknown;
  };

  const client = new sdk.CopilotClient({
    gitHubToken: options.gitHubToken,
    useLoggedInUser: false,
    baseDirectory: options.baseDirectory,
    workingDirectory: options.workingDirectory,
    logLevel: options.logLevel ?? 'warning',
    env: options.env,
    ...(options.cliPath && sdk.RuntimeConnection
      ? { connection: sdk.RuntimeConnection.forStdio({ path: options.cliPath }) }
      : {}),
  });

  const hooks = options.memoryHook
    ? {
        onSessionStart: async (input: { source?: string }) => {
          const additionalContext = executeMemoryHookCommand(options.memoryHook, input?.source ?? 'startup');
          return additionalContext ? { additionalContext } : undefined;
        },
      }
    : undefined;

  return {
    start: () => client.start(),
    ...(client.listModels ? { listModels: () => client.listModels!() } : {}),
    createSession: (params) =>
      client.createSession({
        ...params,
        onPermissionRequest: sdk.approveAll,
        ...(hooks ? { hooks } : {}),
      }),
    resumeSession: (sessionId, params) =>
      client.resumeSession(sessionId, {
        ...params,
        onPermissionRequest: sdk.approveAll,
        ...(hooks ? { hooks } : {}),
      }),
    stop: async () => {
      await client.stop();
    },
  };
}

export async function createCopilotClient(options: CopilotClientFactoryOptions): Promise<CopilotClientHandle> {
  const mode = options.runtimeMode ?? 'auto';
  if (mode === 'node-bridge') {
    return new NodeBridgeCopilotClient(options);
  }
  if (mode === 'direct') {
    return createDirectCopilotClient(options);
  }
  return createAutoFallbackClient(
    () => createDirectCopilotClient(options),
    () => new NodeBridgeCopilotClient(options),
  );
}

class NodeBridgeCopilotClient implements CopilotClientHandle {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(event: CopilotSessionEvent) => void>();
  private stdoutBuffer = '';
  private stderrTail = '';

  constructor(private readonly options: CopilotClientFactoryOptions) {}

  async start(): Promise<void> {
    const bridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'copilot-node-bridge.mjs');
    const sanitizedEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(this.options.env ?? process.env)) {
      if (val !== undefined) sanitizedEnv[key] = val;
    }

    this.child = spawn('node', [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedEnv,
    });

    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));

    this.child.stderr.setEncoding('utf-8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });

    this.child.on('exit', (code, signal) => {
      const reason = `Copilot node bridge exited (code=${String(code)}, signal=${String(signal)})${
        this.stderrTail ? `: ${this.stderrTail.trim()}` : ''
      }`;
      for (const entry of this.pending.values()) {
        entry.reject(new Error(reason));
      }
      this.pending.clear();
    });

    await this.rpc('start', {
      gitHubToken: this.options.gitHubToken,
      baseDirectory: this.options.baseDirectory,
      workingDirectory: this.options.workingDirectory,
      logLevel: this.options.logLevel ?? 'warning',
      cliPath: this.options.cliPath,
      env: sanitizedEnv,
      memoryHook: this.options.memoryHook,
    });
  }

  async listModels(): Promise<Array<{ id: string; name: string; policy?: { state?: string } }>> {
    const res = (await this.rpc('listModels', {})) as {
      models: Array<{ id: string; name: string; policy?: { state?: string } }>;
    };
    return res.models ?? [];
  }

  async createSession(params: CopilotSessionCreateParams): Promise<CopilotSessionHandle> {
    const res = (await this.rpc('createSession', params)) as { sessionId: string };
    return this.makeSessionHandle(res.sessionId);
  }

  async resumeSession(sessionId: string, params: CopilotSessionCreateParams): Promise<CopilotSessionHandle> {
    const res = (await this.rpc('resumeSession', { sessionId, config: params })) as { sessionId: string };
    return this.makeSessionHandle(res.sessionId);
  }

  async stop(): Promise<void> {
    try {
      if (this.child && !this.child.killed) {
        await this.rpc('stop', {}).catch(() => {});
      }
    } finally {
      if (this.child && !this.child.killed) {
        this.child.kill('SIGTERM');
      }
      this.child = null;
    }
  }

  private makeSessionHandle(sessionId: string): CopilotSessionHandle {
    return {
      sessionId,
      on: (handler) => {
        this.listeners.add(handler);
        return () => {
          this.listeners.delete(handler);
        };
      },
      send: async ({ prompt }) => {
        const res = (await this.rpc('send', { prompt })) as { messageId: string };
        return res.messageId;
      },
      abort: async () => {
        await this.rpc('abort', {});
      },
      disconnect: async () => {
        await this.rpc('disconnect', {});
      },
    };
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const msg = JSON.parse(line) as {
            id?: number | null;
            ok?: boolean;
            result?: unknown;
            error?: string;
            event?: CopilotSessionEvent;
          };
          if (msg.event) {
            for (const listener of this.listeners) {
              listener(msg.event);
            }
          } else if (typeof msg.id === 'number') {
            const waiter = this.pending.get(msg.id);
            if (waiter) {
              this.pending.delete(msg.id);
              if (msg.ok) waiter.resolve(msg.result);
              else waiter.reject(new Error(msg.error || 'Copilot node bridge error'));
            }
          }
        } catch {
          // Ignore malformed bridge line
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('Copilot node bridge is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
}
