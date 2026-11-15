#!/usr/bin/env node
/**
 * Thin Node.js 22+ stdio NDJSON bridge for @github/copilot-sdk.
 *
 * Used automatically when Bun cannot load @github/copilot-sdk's native `koffi`
 * dependency inside the agent container, or when COPILOT_RUNTIME_MODE=node-bridge.
 */
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';
import * as copilotSdk from '@github/copilot-sdk';

const { approveAll, CopilotClient } = copilotSdk;
// A namespace import keeps the bridge bootable on SDK releases that do not
// export RuntimeConnection; cliPath is simply ignored in that case.
const RuntimeConnection = copilotSdk.RuntimeConnection;

let client = null;
let session = null;
let unsubscribe = null;
let memoryHook = null;

function writeLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function runMemoryHook(source) {
  if (!memoryHook?.command) return undefined;
  try {
    const out = execFileSync('/bin/sh', ['-c', memoryHook.command], {
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

function buildSessionHooks() {
  if (!memoryHook?.command) return undefined;
  return {
    onSessionStart: async (input) => {
      const additionalContext = runMemoryHook(input?.source ?? 'startup');
      return additionalContext ? { additionalContext } : undefined;
    },
  };
}

function subscribeSession(activeSession) {
  if (typeof unsubscribe === 'function') {
    unsubscribe();
    unsubscribe = null;
  }
  unsubscribe = activeSession.on((event) => {
    writeLine({ event });
  });
}

async function handleRequest(req) {
  const { id, method, params = {} } = req;

  if (method === 'start') {
    memoryHook = params.memoryHook ?? null;
    client = new CopilotClient({
      gitHubToken: params.gitHubToken,
      useLoggedInUser: false,
      baseDirectory: params.baseDirectory,
      workingDirectory: params.workingDirectory,
      logLevel: params.logLevel ?? 'warning',
      env: params.env,
      ...(params.cliPath && RuntimeConnection
        ? { connection: RuntimeConnection.forStdio({ path: params.cliPath }) }
        : {}),
    });
    await client.start();
    return { started: true };
  }

  if (method === 'listModels') {
    if (!client) throw new Error('CopilotClient not started');
    const models = await client.listModels();
    return { models };
  }

  if (method === 'createSession') {
    if (!client) throw new Error('CopilotClient not started');
    const hooks = buildSessionHooks();
    session = await client.createSession({
      ...params,
      onPermissionRequest: approveAll,
      ...(hooks ? { hooks } : {}),
    });
    subscribeSession(session);
    return { sessionId: session.sessionId };
  }

  if (method === 'resumeSession') {
    if (!client) throw new Error('CopilotClient not started');
    const hooks = buildSessionHooks();
    session = await client.resumeSession(params.sessionId, {
      ...params.config,
      onPermissionRequest: approveAll,
      ...(hooks ? { hooks } : {}),
    });
    subscribeSession(session);
    return { sessionId: session.sessionId };
  }

  if (method === 'send') {
    if (!session) throw new Error('CopilotSession not initialized');
    const messageId = await session.send({ prompt: params.prompt });
    return { messageId };
  }

  if (method === 'abort') {
    if (session) await session.abort();
    return { aborted: true };
  }

  if (method === 'disconnect') {
    if (typeof unsubscribe === 'function') {
      unsubscribe();
      unsubscribe = null;
    }
    if (session) {
      await session.disconnect();
      session = null;
    }
    return { disconnected: true };
  }

  if (method === 'stop') {
    if (typeof unsubscribe === 'function') {
      unsubscribe();
      unsubscribe = null;
    }
    if (session) {
      await session.disconnect().catch(() => {});
      session = null;
    }
    if (client) {
      await client.stop();
      client = null;
    }
    return { stopped: true };
  }

  throw new Error(`Unknown bridge method: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    writeLine({ id: null, ok: false, error: `Invalid JSON request: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  handleRequest(req)
    .then((result) => writeLine({ id: req.id, ok: true, result }))
    .catch((err) =>
      writeLine({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
});

rl.on('close', () => {
  if (client) {
    void client.stop().finally(() => process.exit(0));
  } else {
    process.exit(0);
  }
});
