/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initBridgeContext } from '../../lib/bridge/context';
import { handleCommand } from '../../lib/bridge/bridge-manager';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore, LifecycleHooks } from '../../lib/bridge/host';
import type { BridgeSession, ModelCatalog } from '../../lib/bridge/host';
import type { ChannelBinding, InboundMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

class TestAdapter extends BaseChannelAdapter {
  readonly channelType = 'telegram';
  sent: OutboundMessage[] = [];

  async start() {}
  async stop() {}
  isRunning() { return true; }
  async consumeOne() { return null; }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true, messageId: String(this.sent.length) };
  }
  validateConfig() { return null; }
  isAuthorized() { return true; }
}

class CommandTestStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();

  constructor(defaultModel = 'claude-default') {
    this.settings.set('bridge_default_model', defaultModel);
    this.settings.set('default_model', defaultModel);
  }

  seedSession(session: BridgeSession) {
    this.sessions.set(session.id, session);
  }

  seedBinding(binding: ChannelBinding) {
    this.bindings.set(`${binding.channelType}:${binding.chatId}`, binding);
  }

  getSetting(key: string) { return this.settings.get(key) ?? null; }
  getChannelBinding(channelType: string, chatId: string) { return this.bindings.get(`${channelType}:${chatId}`) ?? null; }
  upsertChannelBinding(data: { channelType: string; chatId: string; codepilotSessionId: string; sdkSessionId?: string; workingDirectory: string; model: string; mode?: string }) {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const binding: ChannelBinding = {
      id: existing?.id || `binding-${this.bindings.size + 1}`,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId ?? existing?.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (data.mode as ChannelBinding['mode']) ?? existing?.mode ?? 'code',
      active: true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(key, binding);
    return binding;
  }
  updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
    for (const [key, binding] of this.bindings) {
      if (binding.id === id) {
        this.bindings.set(key, { ...binding, ...updates, updatedAt: new Date().toISOString() });
      }
    }
  }
  listChannelBindings() { return Array.from(this.bindings.values()); }
  getSession(id: string) { return this.sessions.get(id) ?? null; }
  createSession(_name: string, model: string, systemPrompt?: string, cwd?: string) {
    const session: BridgeSession = {
      id: `session-${this.sessions.size + 1}`,
      working_directory: cwd || '/tmp',
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    return session;
  }
  updateSessionProviderId(sessionId: string, providerId: string) {
    const session = this.sessions.get(sessionId);
    if (session) session.provider_id = providerId;
  }
  addMessage() {}
  getMessages() { return { messages: [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock() {}
  releaseSessionLock() {}
  setSessionRuntimeStatus() {}
  updateSdkSessionId() {}
  updateSessionModel(sessionId: string, model: string) {
    const session = this.sessions.get(sessionId);
    if (session) session.model = model;
  }
  syncSdkTasks() {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog() {}
  checkDedup() { return false; }
  insertDedup() {}
  cleanupExpiredDedup() {}
  insertOutboundRef() {}
  insertPermissionLink() {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset() { return '0'; }
  setChannelOffset() {}
}

function createCommandMessage(text: string): InboundMessage {
  return {
    messageId: 'msg-1',
    address: { channelType: 'telegram', chatId: 'chat-1', displayName: 'Test Chat' },
    text,
    timestamp: Date.now(),
  };
}

describe('bridge-manager model commands', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('lists current/default/catalog models via /model list', async () => {
    const store = new CommandTestStore('claude-default');
    store.seedSession({
      id: 'session-1',
      working_directory: '/tmp/project',
      model: 'claude-session',
      provider_id: 'provider-1',
    });
    store.seedBinding({
      id: 'binding-1',
      channelType: 'telegram',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: '',
      workingDirectory: '/tmp/project',
      model: 'claude-current',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>(),
        listModels: async (): Promise<ModelCatalog> => ({
          models: [{ id: 'claude-current' }, { id: 'claude-opus-4' }],
          note: 'catalog note',
        }),
      },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const adapter = new TestAdapter();
    await handleCommand(adapter, createCommandMessage('/model list'), '/model list');

    assert.equal(adapter.sent.length, 1);
    assert.match(adapter.sent[0].text, /Model List/);
    assert.match(adapter.sent[0].text, /claude-current/);
    assert.match(adapter.sent[0].text, /claude-default/);
    assert.match(adapter.sent[0].text, /claude-opus-4/);
    assert.match(adapter.sent[0].text, /catalog note/);
  });

  it('switches to a fresh session on /model use', async () => {
    const store = new CommandTestStore('claude-default');
    store.seedSession({
      id: 'session-1',
      working_directory: '/tmp/project',
      model: 'claude-session',
      provider_id: 'provider-1',
    });
    store.seedBinding({
      id: 'binding-1',
      channelType: 'telegram',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'sdk-1',
      workingDirectory: '/tmp/project',
      model: '',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream<string>() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const adapter = new TestAdapter();
    await handleCommand(adapter, createCommandMessage('/model use claude-sonnet-4'), '/model use claude-sonnet-4');

    const binding = store.getChannelBinding('telegram', 'chat-1');
    assert.ok(binding);
    assert.notEqual(binding?.codepilotSessionId, 'session-1');
    assert.equal(binding?.model, 'claude-sonnet-4');
    assert.equal(binding?.sdkSessionId, '');
    assert.equal(store.getSession(binding!.codepilotSessionId)?.model, 'claude-sonnet-4');
    assert.equal(store.getSession(binding!.codepilotSessionId)?.provider_id, 'provider-1');
    assert.match(adapter.sent[0].text, /fresh session was created/i);
  });

  it('restores default model on /model default', async () => {
    const store = new CommandTestStore('claude-default');
    store.seedSession({
      id: 'session-1',
      working_directory: '/tmp/project',
      model: 'claude-session',
    });
    store.seedBinding({
      id: 'binding-1',
      channelType: 'telegram',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'sdk-1',
      workingDirectory: '/tmp/project',
      model: 'claude-sonnet-4',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream<string>() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const adapter = new TestAdapter();
    await handleCommand(adapter, createCommandMessage('/model default'), '/model default');

    const binding = store.getChannelBinding('telegram', 'chat-1');
    assert.ok(binding);
    assert.equal(binding?.model, '');
    assert.equal(store.getSession(binding!.codepilotSessionId)?.model, 'claude-default');
    assert.match(adapter.sent[0].text, /Model reset to default/);
  });

  it('writes a safe restart request on /restart', async () => {
    const store = new CommandTestStore('claude-default');
    store.seedSession({
      id: 'session-1',
      working_directory: '/tmp/project',
      model: 'claude-session',
    });
    store.seedBinding({
      id: 'binding-1',
      channelType: 'telegram',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: 'sdk-1',
      workingDirectory: '/tmp/project',
      model: '',
      mode: 'code',
      active: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream<string>() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-home-'));
    const oldCtiHome = process.env.CTI_HOME;
    process.env.CTI_HOME = tmpHome;

    try {
      const adapter = new TestAdapter();
      await handleCommand(adapter, createCommandMessage('/restart'), '/restart');

      const requestPath = path.join(tmpHome, 'runtime', 'restart-request.json');
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as {
        requestedBy: string;
        delayMs: number;
      };

      assert.equal(request.requestedBy, 'bridge-command');
      assert.equal(request.delayMs, 15000);
      assert.match(adapter.sent[0].text, /Safe restart requested/);
    } finally {
      if (oldCtiHome === undefined) delete process.env.CTI_HOME;
      else process.env.CTI_HOME = oldCtiHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
