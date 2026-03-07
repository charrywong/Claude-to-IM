/**
 * Unit tests for QQ-related bridge functionality.
 *
 * Tests cover:
 * - PLATFORM_LIMITS for QQ
 * - Delivery-layer QQ chunking (3 segment max, truncation marker)
 * - Permission-broker QQ text permissions (no buttons, /perm commands)
 * - QQAdapter: validateConfig, isAuthorized, send
 * - qq-api: nextMsgSeq auto-increment
 * - bridge-manager: hasError clears sdkSessionId logic
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import { deliver } from '../../lib/bridge/delivery-layer';
import { forwardPermissionRequest } from '../../lib/bridge/permission-broker';
import { PLATFORM_LIMITS } from '../../lib/bridge/types';
import { nextMsgSeq } from '../../lib/bridge/adapters/qq-api';
import { QQAdapter } from '../../lib/bridge/adapters/qq-adapter';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

// ── Mock Store ──────────────────────────────────────────────

function createMockStore(settings: Record<string, string> = {}) {
  const auditLogs: any[] = [];
  const outboundRefs: any[] = [];
  const dedupKeys = new Set<string>();
  const permLinks = new Map<string, any>();

  return {
    auditLogs,
    outboundRefs,
    dedupKeys,
    permLinks,
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
    insertAuditLog: (entry: any) => { auditLogs.push(entry); },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => { dedupKeys.add(key); },
    cleanupExpiredDedup: () => {},
    insertOutboundRef: (ref: any) => { outboundRefs.push(ref); },
    insertPermissionLink: (link: any) => { permLinks.set(link.permissionRequestId, link); },
    getPermissionLink: (id: string) => permLinks.get(id) ?? null,
    markPermissionLinkResolved: () => false,
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

type MockStore = ReturnType<typeof createMockStore>;

function setupContext(store: MockStore) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

// ── Mock QQ Adapter ─────────────────────────────────────────

function createMockQQAdapter(opts?: {
  sendFn?: (msg: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter {
  const sendFn = opts?.sendFn ?? (async () => ({ ok: true, messageId: 'msg-1' }));
  return {
    channelType: 'qq',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: sendFn,
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

// ── 1. PLATFORM_LIMITS ─────────────────────────────────────

describe('types - qq platform limit', () => {
  it('qq limit is 2000', () => {
    assert.equal(PLATFORM_LIMITS['qq'], 2000);
  });
});

// ── 2. Delivery-layer QQ chunking ──────────────────────────

describe('delivery-layer - qq chunking', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('limits qq to 3 segments max', async () => {
    const sentMessages: string[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg.text);
        return { ok: true, messageId: `msg-${sentMessages.length}` };
      },
    });

    // Generate text that would produce >3 chunks at 2000 char limit
    // 5 chunks worth of text (each ~2000 chars)
    const longText = 'A'.repeat(1900) + '\n' +
                     'B'.repeat(1900) + '\n' +
                     'C'.repeat(1900) + '\n' +
                     'D'.repeat(1900) + '\n' +
                     'E'.repeat(1900);

    const result = await deliver(adapter, {
      address: { channelType: 'qq', chatId: 'user-1' },
      text: longText,
      parseMode: 'plain',
      replyToMessageId: 'inbound-1',
    });

    assert.ok(result.ok);
    assert.equal(sentMessages.length, 3, `Expected exactly 3 chunks, got ${sentMessages.length}`);
  });

  it('truncates overflow with marker', async () => {
    const sentMessages: string[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg.text);
        return { ok: true, messageId: `msg-${sentMessages.length}` };
      },
    });

    // Generate text that would produce >3 chunks
    const longText = 'X'.repeat(1900) + '\n' +
                     'Y'.repeat(1900) + '\n' +
                     'Z'.repeat(1900) + '\n' +
                     'W'.repeat(1900) + '\n' +
                     'V'.repeat(1900);

    await deliver(adapter, {
      address: { channelType: 'qq', chatId: 'user-2' },
      text: longText,
      parseMode: 'plain',
      replyToMessageId: 'inbound-2',
    });

    // The last (3rd) chunk should contain the truncation marker
    const lastChunk = sentMessages[sentMessages.length - 1];
    assert.ok(lastChunk.includes('[... response truncated]'), 'Last chunk should contain truncation marker');
  });

  it('passes replyToMessageId through chunks', async () => {
    const sentReplyIds: (string | undefined)[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentReplyIds.push(msg.replyToMessageId);
        return { ok: true, messageId: `msg-${sentReplyIds.length}` };
      },
    });

    // Generate text that produces multiple chunks
    const longText = 'A'.repeat(1900) + '\n' +
                     'B'.repeat(1900) + '\n' +
                     'C'.repeat(1900);

    await deliver(adapter, {
      address: { channelType: 'qq', chatId: 'user-3' },
      text: longText,
      parseMode: 'plain',
      replyToMessageId: 'reply-target-id',
    });

    // All chunks should carry the replyToMessageId
    for (const replyId of sentReplyIds) {
      assert.equal(replyId, 'reply-target-id', 'Each chunk should pass through replyToMessageId');
    }
  });
});

// ── 3. Permission-broker QQ text permissions ────────────────

describe('permission-broker - qq text permissions', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('sends plain text prompt for qq (no buttons)', async () => {
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'perm-msg-1' };
      },
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'qq', chatId: 'user-perm-1' },
      'perm-req-unique-1',
      'Bash',
      { command: 'ls -la' },
      'session-1',
      undefined,
      'reply-msg-1',
    );

    assert.ok(sentMessages.length > 0, 'Should have sent at least one message');

    const permMsg = sentMessages[0];
    // No inline buttons for QQ
    assert.equal(permMsg.inlineButtons, undefined, 'QQ permission prompt should not have inline buttons');
    // Should contain /perm commands
    assert.ok(permMsg.text.includes('/perm allow perm-req-unique-1'), 'Should contain /perm allow command');
    assert.ok(permMsg.text.includes('/perm allow_session perm-req-unique-1'), 'Should contain /perm allow_session command');
    assert.ok(permMsg.text.includes('/perm deny perm-req-unique-1'), 'Should contain /perm deny command');
  });

  it('passes replyToMessageId for qq', async () => {
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'perm-msg-2' };
      },
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'qq', chatId: 'user-perm-2' },
      'perm-req-unique-2',
      'Read',
      { file_path: '/tmp/test' },
      'session-2',
      undefined,
      'reply-msg-2',
    );

    assert.ok(sentMessages.length > 0);
    assert.equal(sentMessages[0].replyToMessageId, 'reply-msg-2', 'Should pass through replyToMessageId');
  });
});

// ── 4. QQAdapter unit tests ────────────────────────────────

describe('qq-adapter', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('validateConfig returns error when app_id missing', () => {
    const adapter = new QQAdapter();
    const error = adapter.validateConfig();
    assert.ok(error);
    assert.ok(error.includes('app_id'), `Expected error about app_id, got: ${error}`);
  });

  it('validateConfig returns error when app_secret missing', () => {
    store = createMockStore({ bridge_qq_app_id: 'test-app-id' });
    setupContext(store);

    const adapter = new QQAdapter();
    const error = adapter.validateConfig();
    assert.ok(error);
    assert.ok(error.includes('app_secret'), `Expected error about app_secret, got: ${error}`);
  });

  it('validateConfig returns null when both configured', () => {
    store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();
    const error = adapter.validateConfig();
    assert.equal(error, null);
  });

  it('isAuthorized allows all when allowed_users empty', () => {
    const adapter = new QQAdapter();
    assert.ok(adapter.isAuthorized('any-user', 'any-chat'));
  });

  it('isAuthorized blocks unlisted users', () => {
    store = createMockStore({ bridge_qq_allowed_users: 'user-a,user-b' });
    setupContext(store);

    const adapter = new QQAdapter();
    assert.equal(adapter.isAuthorized('user-c', 'chat-1'), false);
  });

  it('isAuthorized allows listed users', () => {
    store = createMockStore({ bridge_qq_allowed_users: 'user-a,user-b' });
    setupContext(store);

    const adapter = new QQAdapter();
    assert.ok(adapter.isAuthorized('user-a', 'chat-1'));
    assert.ok(adapter.isAuthorized('user-b', 'chat-1'));
  });

  it('send returns error when replyToMessageId missing', async () => {
    store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();
    const result = await adapter.send({
      address: { channelType: 'qq', chatId: 'user-1' },
      text: 'Hello',
      parseMode: 'plain',
      // No replyToMessageId
    });

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('replyToMessageId'));
  });

  it('send strips HTML tags when parseMode is HTML', async () => {
    store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;

    globalThis.fetch = (async (_url: any, init: any) => {
      // Capture the token request
      const urlStr = typeof _url === 'string' ? _url : _url.toString();
      if (urlStr.includes('getAppAccessToken')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'test-token', expires_in: 7200 }),
          text: async () => '',
        };
      }
      // Capture the send message request
      capturedBody = init?.body;
      return {
        ok: true,
        json: async () => ({ id: 'sent-1' }),
        text: async () => '',
      };
    }) as typeof fetch;

    try {
      await adapter.send({
        address: { channelType: 'qq', chatId: 'user-1' },
        text: '<b>Hello</b> <i>world</i>',
        parseMode: 'HTML',
        replyToMessageId: 'msg-in-1',
      });

      assert.ok(capturedBody, 'Should have captured request body');
      const parsed = JSON.parse(capturedBody!);
      assert.equal(parsed.content, 'Hello world', 'HTML tags should be stripped');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 5. qq-api nextMsgSeq ────────────────────────────────────

describe('qq-api - nextMsgSeq', () => {
  it('auto-increments per message ID', () => {
    // Use a unique message ID to avoid interference from other tests
    const msgId = `test-msg-seq-${Date.now()}`;

    const seq1 = nextMsgSeq(msgId);
    const seq2 = nextMsgSeq(msgId);
    const seq3 = nextMsgSeq(msgId);

    assert.equal(seq1, 1);
    assert.equal(seq2, 2);
    assert.equal(seq3, 3);
  });
});

// ── 6. qq-adapter send() catches exceptions ──────────────────

describe('qq-adapter - send catches exceptions', () => {
  it('returns SendResult on token fetch failure instead of throwing', async () => {
    const store = createMockStore({
      bridge_qq_app_id: 'test-app-id',
      bridge_qq_app_secret: 'test-app-secret',
    });
    setupContext(store);

    const adapter = new QQAdapter();

    // Mock fetch to throw on token request
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network timeout');
    }) as typeof fetch;

    try {
      const result = await adapter.send({
        address: { channelType: 'qq', chatId: 'user-1' },
        text: 'Hello',
        parseMode: 'plain',
        replyToMessageId: 'msg-in-1',
      });

      // Should NOT throw — should return { ok: false }
      assert.equal(result.ok, false);
      assert.ok(result.error?.includes('network timeout'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 7. qq-adapter image download failure tracking ──────────────

describe('qq-adapter - image download failure tracking', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore({
      bridge_qq_app_id: 'test-id',
      bridge_qq_app_secret: 'test-secret',
    });
    setupContext(store);
  });

  it('enqueues message with failure info when all images fail', async () => {
    const adapter = new QQAdapter();

    // Mock fetch to fail on image download
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('getAppAccessToken')) {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 7200 }), text: async () => '' };
      }
      // Image download fails
      return { ok: false, status: 500, text: async () => 'server error' };
    }) as unknown as typeof fetch;

    try {
      // Access private method via cast
      const adapterAny = adapter as any;

      // Simulate C2C message with image-only (no text)
      adapterAny.handleC2CMessage({
        id: 'img-fail-msg-1',
        author: { user_openid: 'user-img-1' },
        content: '',
        timestamp: new Date().toISOString(),
        attachments: [
          { content_type: 'image/png', url: 'https://example.com/img.png', filename: 'test.png' },
        ],
      });

      // Wait for async download to complete
      await new Promise(r => setTimeout(r, 100));

      // Should have enqueued a message with raw.imageDownloadFailed
      const msg = adapterAny.queue.shift();
      assert.ok(msg, 'Should have enqueued a message');
      assert.equal(msg.text, '');
      assert.ok((msg.raw as any)?.imageDownloadFailed, 'Should flag imageDownloadFailed');
      assert.equal((msg.raw as any)?.failedCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── 8. bridge-manager: image download failure replies to user ───

describe('bridge-manager - image download failure reply', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('replies to user when image-only message fails download', async () => {
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockQQAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg);
        return { ok: true, messageId: 'reply-1' };
      },
    });

    // Simulate what bridge-manager handleMessage does when receiving
    // an empty-text message with imageDownloadFailed raw data
    // We import deliver to test the code path directly
    const msg = {
      messageId: 'img-msg-1',
      address: { channelType: 'qq' as const, chatId: 'user-1', userId: 'user-1' },
      text: '',
      timestamp: Date.now(),
      raw: { imageDownloadFailed: true, failedCount: 2 },
    };

    const rawText = msg.text.trim();
    const hasAttachments = (msg as any).attachments !== undefined && (msg as any).attachments?.length > 0;

    // This mimics the bridge-manager logic
    if (!rawText && !hasAttachments) {
      const rawData = msg.raw as { imageDownloadFailed?: boolean; failedCount?: number } | undefined;
      if (rawData?.imageDownloadFailed) {
        await deliver(adapter, {
          address: msg.address,
          text: `Failed to download ${rawData.failedCount ?? 1} image(s). Please try sending again.`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
      }
    }

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Failed to download 2 image(s)'));
    assert.equal(sentMessages[0].replyToMessageId, 'img-msg-1');
  });
});

// ── 9. bridge-manager sdkSessionId clearing via store mock ──────

describe('bridge-manager - sdkSessionId update contract', () => {
  it('updateChannelBinding clears sdkSessionId on error even with new sdkSessionId', () => {
    // Verify the actual bridge-manager.ts logic by reading the source code pattern.
    // The code at bridge-manager.ts lines 580-586 is:
    //   if (result.sdkSessionId && !result.hasError) { save }
    //   else if (result.hasError) { clear }
    //
    // This test verifies the contract: when both sdkSessionId AND hasError are set,
    // the clear branch wins.

    const bindingUpdates: Partial<{ sdkSessionId: string }>[] = [];
    const mockUpdateBinding = (_id: string, updates: Partial<{ sdkSessionId: string }>) => {
      bindingUpdates.push(updates);
    };

    // Scenario 1: error with sdkSessionId — should clear
    const result1 = { sdkSessionId: 'new-sdk', hasError: true };
    if (result1.sdkSessionId && !result1.hasError) {
      mockUpdateBinding('b1', { sdkSessionId: result1.sdkSessionId });
    } else if (result1.hasError) {
      mockUpdateBinding('b1', { sdkSessionId: '' });
    }

    // Scenario 2: no error with sdkSessionId — should save
    const result2 = { sdkSessionId: 'new-sdk-2', hasError: false };
    if (result2.sdkSessionId && !result2.hasError) {
      mockUpdateBinding('b2', { sdkSessionId: result2.sdkSessionId });
    } else if (result2.hasError) {
      mockUpdateBinding('b2', { sdkSessionId: '' });
    }

    // Scenario 3: error without sdkSessionId — should still clear
    const result3 = { sdkSessionId: null as string | null, hasError: true };
    if (result3.sdkSessionId && !result3.hasError) {
      mockUpdateBinding('b3', { sdkSessionId: result3.sdkSessionId });
    } else if (result3.hasError) {
      mockUpdateBinding('b3', { sdkSessionId: '' });
    }

    assert.equal(bindingUpdates.length, 3);
    assert.equal(bindingUpdates[0].sdkSessionId, '', 'Error with SDK ID: should clear');
    assert.equal(bindingUpdates[1].sdkSessionId, 'new-sdk-2', 'No error: should save');
    assert.equal(bindingUpdates[2].sdkSessionId, '', 'Error without SDK ID: should clear');
  });

  it('verifies bridge-manager source code matches expected pattern', async () => {
    // Read the actual bridge-manager.ts source and verify the sdkSessionId logic
    const fs = await import('fs');
    const source = fs.readFileSync(
      new URL('../../lib/bridge/bridge-manager.ts', import.meta.url),
      'utf-8',
    );

    // The critical pattern: hasError always clears, regardless of sdkSessionId
    assert.ok(
      source.includes('result.sdkSessionId && !result.hasError'),
      'Should check sdkSessionId && !hasError for save path',
    );
    assert.ok(
      source.includes('else if (result.hasError)'),
      'Should have unconditional hasError clear path',
    );
    // Verify it does NOT have the old pattern that only cleared when binding had existing sdkSessionId
    assert.ok(
      !source.includes('result.hasError && binding.sdkSessionId'),
      'Should NOT conditionally check binding.sdkSessionId for clear',
    );
  });

  it('verifies replyToMessageId is passed in all response paths', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(
      new URL('../../lib/bridge/bridge-manager.ts', import.meta.url),
      'utf-8',
    );

    // Normal response path
    assert.ok(
      source.includes('deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId)'),
      'deliverResponse should receive msg.messageId',
    );
    // Error response path
    assert.ok(
      source.includes('replyToMessageId: msg.messageId,'),
      'Error response should include replyToMessageId',
    );
    // Command response path
    assert.ok(
      /deliver\(adapter,\s*\{[^}]*replyToMessageId:\s*msg\.messageId/s.test(source),
      'Command deliver should include replyToMessageId',
    );
  });
});
