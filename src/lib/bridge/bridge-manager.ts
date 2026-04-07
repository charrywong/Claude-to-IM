/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState, ToolCallInfo } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
// Side-effect import: triggers self-registration of all adapter factories
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';
import type { BridgeSession, ModelCatalogEntry } from './host.js';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string, botInstanceId?: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq' && channelType !== 'weixin') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId, botInstanceId);
  return pending.length > 0; // any pending → route to inline path
}

/** Fire-and-forget: send a preview draft. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;

  state.lastSentText = text;
  state.lastSentAt = Date.now();

  adapter.sendPreview(state.chatId, text, state.draftId).then(result => {
    if (result === 'degrade') state.degraded = true;
    // 'skip' — transient failure, next flush will retry naturally
  }).catch(() => {
    // Network error — transient, don't degrade
  });
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  return g[GLOBAL_KEY];
}

function parseDelayMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return null;
  }
}

function getDefaultModelSetting(): string {
  const { store } = getBridgeContext();
  return store.getSetting('bridge_default_model')
    || store.getSetting('default_model')
    || '';
}

function getModelState(binding: import('./types.js').ChannelBinding): {
  currentModel: string;
  bindingModel: string;
  sessionModel: string;
  defaultModel: string;
  session: BridgeSession | null;
} {
  const { store } = getBridgeContext();
  const session = store.getSession(binding.codepilotSessionId);
  const bindingModel = binding.model.trim();
  const sessionModel = session?.model?.trim() || '';
  const defaultModel = getDefaultModelSetting();
  const currentModel = bindingModel || sessionModel || defaultModel || '';

  return {
    currentModel,
    bindingModel,
    sessionModel,
    defaultModel,
    session,
  };
}

function dedupeModelEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const seen = new Set<string>();
  const unique: ModelCatalogEntry[] = [];

  for (const entry of entries) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push({ ...entry, id });
  }

  return unique;
}

async function buildModelListResponse(binding: import('./types.js').ChannelBinding): Promise<string> {
  const { llm } = getBridgeContext();
  const state = getModelState(binding);
  let catalogEntries: ModelCatalogEntry[] = [];
  let catalogNote = '';

  if (llm.listModels) {
    try {
      const catalog = await llm.listModels();
      catalogEntries = catalog.models ?? [];
      catalogNote = catalog.note ?? '';
    } catch (error) {
      catalogNote = error instanceof Error
        ? `Model catalog lookup failed: ${escapeHtml(error.message)}`
        : 'Model catalog lookup failed.';
    }
  } else {
    catalogNote = 'This runtime does not expose a model catalog yet.';
  }

  const modelEntries = dedupeModelEntries([
    ...(state.currentModel ? [{ id: state.currentModel, label: 'current' }] : []),
    ...(state.defaultModel ? [{ id: state.defaultModel, label: 'default' }] : []),
    ...catalogEntries,
  ]);

  const lines = [
    '<b>Model List</b>',
    '',
    `Current: <code>${escapeHtml(state.currentModel || 'runtime default')}</code>`,
    `Default: <code>${escapeHtml(state.defaultModel || 'runtime default')}</code>`,
  ];

  if (modelEntries.length > 0) {
    lines.push('', '<b>Known Models</b>');
    for (const entry of modelEntries) {
      const label = entry.label ? ` <i>(${escapeHtml(entry.label)})</i>` : '';
      lines.push(`- <code>${escapeHtml(entry.id)}</code>${label}`);
    }
  } else {
    lines.push('', 'No model identifiers are currently available.');
  }

  if (catalogNote) {
    lines.push('', `<i>${escapeHtml(catalogNote)}</i>`);
  }

  return lines.join('\n');
}

function abortActiveTask(sessionId: string): void {
  const state = getState();
  const taskAbort = state.activeTasks.get(sessionId);
  if (!taskAbort) return;
  taskAbort.abort();
  state.activeTasks.delete(sessionId);
}

function switchBindingToModel(
  address: import('./types.js').ChannelAddress,
  binding: import('./types.js').ChannelBinding,
  overrideModel: string,
): import('./types.js').ChannelBinding {
  const { store } = getBridgeContext();
  const current = getModelState(binding);
  const displayName = address.displayName || address.chatId;
  const nextSession = store.createSession(
    `Bridge: ${displayName}`,
    overrideModel || current.defaultModel,
    current.session?.system_prompt,
    binding.workingDirectory,
    binding.mode,
    binding.botInstanceId,
  );

  if (current.session?.provider_id) {
    store.updateSessionProviderId(nextSession.id, current.session.provider_id);
  }

  store.updateChannelBinding(binding.id, {
    codepilotSessionId: nextSession.id,
    sdkSessionId: '',
    workingDirectory: binding.workingDirectory,
    model: overrideModel,
    mode: binding.mode,
    active: true,
  });

  return store.getChannelBinding(address.channelType, address.chatId, address.botInstanceId) ?? binding;
}

function buildModelStatusResponse(binding: import('./types.js').ChannelBinding): string {
  const state = getModelState(binding);
  return [
    '<b>Model Status</b>',
    '',
    `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
    `Current: <code>${escapeHtml(state.currentModel || 'runtime default')}</code>`,
    `Override: <code>${escapeHtml(state.bindingModel || 'none')}</code>`,
    `Default: <code>${escapeHtml(state.defaultModel || 'runtime default')}</code>`,
    '',
    'Usage:',
    '/model list',
    '/model use <name>',
    '/model default',
    '/model help',
  ].join('\n');
}

function getBridgeHome(): string {
  return process.env.CTI_HOME || path.join(process.env.HOME || '~', '.claude-to-im');
}

function requestSafeRestart(requestedBy = 'bridge-command'): string {
  const runtimeDir = path.join(getBridgeHome(), 'runtime');
  const requestPath = path.join(runtimeDir, 'restart-request.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify({
    requestedAt: new Date().toISOString(),
    requestedBy,
    delayMs: 15_000,
  }));
  return requestPath;
}

function parseBotParams(raw: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const item of raw) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (!key || !value) continue;
    params[key] = value;
  }
  return params;
}

function parseCsv(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const CTI_SCHEDULE_TAG_RE = /<cti-schedule>\s*([\s\S]*?)\s*<\/cti-schedule>/gi;

type ParsedScheduleDirective = {
  title: string;
  description: string;
  instruction: string;
  timezone?: string;
} & (
  | { schedule: { mode: 'once'; run_at: string } }
  | { schedule: { mode: 'daily'; time: string } }
);

function parseScheduleDirectives(responseText: string): {
  cleanedText: string;
  directives: ParsedScheduleDirective[];
  errors: string[];
} {
  const directives: ParsedScheduleDirective[] = [];
  const errors: string[] = [];

  const cleanedText = responseText.replace(CTI_SCHEDULE_TAG_RE, (_full, body: string) => {
    const raw = String(body || '').trim();
    if (!raw) {
      errors.push('Empty <cti-schedule> block.');
      return '';
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const title = String(parsed.title || '').trim();
      const description = String(parsed.description || '').trim();
      const instruction = String(parsed.instruction || '').trim();
      const timezone = typeof parsed.timezone === 'string' ? parsed.timezone.trim() : undefined;
      const schedule = parsed.schedule;

      if (!title || !description || !instruction || !schedule || typeof schedule !== 'object') {
        throw new Error('Missing required fields.');
      }

      const mode = String((schedule as Record<string, unknown>).mode || '').trim();
      if (mode === 'once') {
        const runAt = String((schedule as Record<string, unknown>).run_at || '').trim();
        if (!runAt || !Number.isFinite(new Date(runAt).getTime())) {
          throw new Error('Invalid schedule.run_at.');
        }
        directives.push({
          title,
          description,
          instruction,
          timezone,
          schedule: { mode: 'once', run_at: runAt },
        });
      } else if (mode === 'daily') {
        const time = String((schedule as Record<string, unknown>).time || '').trim();
        if (!/^\d{2}:\d{2}$/.test(time)) {
          throw new Error('Invalid schedule.time.');
        }
        directives.push({
          title,
          description,
          instruction,
          timezone,
          schedule: { mode: 'daily', time },
        });
      } else {
        throw new Error(`Unsupported schedule mode: ${mode || '(empty)'}`);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Invalid schedule directive.');
    }

    return '';
  });

  return {
    cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n').trim(),
    directives,
    errors,
  };
}

function appendScheduleErrors(text: string, errors: string[]): string {
  if (errors.length === 0) return text;
  const suffix = [
    '**Schedule parsing failed:**',
    ...errors.map((err) => `- ${err}`),
  ].join('\n');
  return text.trim() ? `${text.trim()}\n\n${suffix}` : suffix;
}

function materializeScheduleDirectives(
  botInstanceId: string | undefined,
  channelType: string,
  chatId: string,
  directives: ParsedScheduleDirective[],
): string[] {
  const { scheduler } = getBridgeContext();
  if (!scheduler || directives.length === 0) return [];

  const created: string[] = [];
  for (const directive of directives) {
    if (directive.schedule.mode === 'once') {
      const task = scheduler.scheduleTaskAt({
        botInstanceId,
        channelType,
        chatId,
        title: directive.title,
        description: directive.description,
        instruction: directive.instruction,
        runAt: directive.schedule.run_at,
        timezone: directive.timezone,
      });
      created.push(`Task created: ${task.id} (${directive.title})`);
      continue;
    }

    const task = scheduler.scheduleTaskDaily({
      botInstanceId,
      channelType,
      chatId,
      title: directive.title,
      description: directive.description,
      instruction: directive.instruction,
      timeHHMM: directive.schedule.time,
      timezone: directive.timezone,
    });
    created.push(`Daily task created: ${task.id} (${directive.title})`);
  }

  return created;
}

async function sendProactiveMessage(
  address: ChannelAddress,
  text: string,
  parseMode: OutboundMessage['parseMode'] = 'plain',
): Promise<SendResult> {
  const state = getState();
  const adapterKey = `${address.channelType}:${address.botInstanceId || `${address.channelType}_default`}`;
  const adapter = state.adapters.get(adapterKey);
  if (!adapter || !adapter.isRunning()) {
    return { ok: false, error: `Adapter not running for ${adapterKey}` };
  }
  return deliver(adapter, { address, text, parseMode });
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Iterate all registered adapter types and create those that are enabled
  const configuredBots = store.listBotInstances?.() ?? [];
  if (configuredBots.length > 0) {
    for (const bot of configuredBots) {
      if (!bot.enabled) continue;
      if (!getRegisteredTypes().includes(bot.channelType)) continue;

      const adapter = createAdapter(bot);
      if (!adapter) continue;

      const configError = adapter.validateConfig();
      if (!configError) {
        registerAdapter(adapter);
      } else {
        console.warn(`[bridge-manager] ${bot.channelType}:${bot.id} adapter not valid:`, configError);
      }
    }
  } else {
    for (const channelType of getRegisteredTypes()) {
      const settingKey = `bridge_${channelType}_enabled`;
      if (store.getSetting(settingKey) !== 'true') continue;
      const adapter = createAdapter({
        id: `${channelType}_default`,
        channelType,
        enabled: true,
        credentials: {},
        defaults: { workdir: process.env.HOME || '', mode: 'code' },
      });
      if (!adapter) continue;
      const configError = adapter.validateConfig();
      if (!configError) {
        registerAdapter(adapter);
      } else {
        console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
      }
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
        botInstanceId: adapter.botInstanceId,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.adapterKey, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.adapterKey, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId, msg.address.botInstanceId)
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.adapterKey) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.adapterKey, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.adapterKey) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.adapterKey, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.adapterKey) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.adapterKey, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId, msg.address.botInstanceId);
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Handle attachment-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as {
      imageDownloadFailed?: boolean;
      attachmentDownloadFailed?: boolean;
      failedCount?: number;
      failedLabel?: string;
      userVisibleError?: string;
    } | undefined;
    if (rawData?.userVisibleError) {
      await deliver(adapter, {
        address: msg.address,
        text: rawData.userVisibleError,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    } else if (rawData?.imageDownloadFailed || rawData?.attachmentDownloadFailed) {
      const failureLabel = rawData.failedLabel || (rawData.imageDownloadFailed ? 'image(s)' : 'attachment(s)');
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} ${failureLabel}. Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (feishu/qq/weixin only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (
    adapter.channelType === 'feishu'
    || adapter.channelType === 'qq'
    || adapter.channelType === 'weixin'
  ) {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId, msg.address.botInstanceId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId, undefined, msg.address.botInstanceId);
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address.chatId);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address.chatId) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      chatId: msg.address.chatId,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;

  // Build the preview onPartialText callback (or undefined if preview not supported)
  const previewOnPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  // ── Streaming card setup (Feishu CardKit v2) ──────────────────
  // If the adapter supports streaming cards (e.g. Feishu), wire up
  // onStreamText, onToolEvent, and onStreamEnd callbacks.
  // These run in parallel with the existing preview system — Feishu
  // uses cards instead of message edit for streaming.
  const hasStreamingCards = typeof adapter.onStreamText === 'function';
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onStreamCardText = hasStreamingCards ? (fullText: string) => {
    try { adapter.onStreamText!(msg.address.chatId, fullText); } catch { /* non-critical */ }
  } : undefined;

  const onToolEvent = hasStreamingCards ? (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      // tool_result doesn't carry name — update existing entry's status
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      adapter.onToolEvent!(msg.address.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  } : undefined;

  // Combined partial text callback: streaming preview + streaming cards
  const onPartialText = (previewOnPartialText || onStreamCardText) ? (fullText: string) => {
    if (previewOnPartialText) previewOnPartialText(fullText);
    if (onStreamCardText) onStreamCardText(fullText);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use a synthetic prompt for attachment-only messages.
    // Images keep the old behavior; non-image files get a generic inspection prompt.
    const promptText = text || (() => {
      if (!hasAttachments) return '';
      const attachments = msg.attachments || [];
      const allImages = attachments.length > 0 && attachments.every((a) => a.type.startsWith('image/'));
      return allImages
        ? 'Describe this image.'
        : 'Inspect the attached file(s) and help the user with them.';
    })();

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, onToolEvent);

    const parsedSchedules = parseScheduleDirectives(result.responseText);
    const createdTasks = materializeScheduleDirectives(
      msg.address.botInstanceId,
      adapter.channelType,
      msg.address.chatId,
      parsedSchedules.directives,
    );
    let responseText = appendScheduleErrors(parsedSchedules.cleanedText, parsedSchedules.errors);
    if (!responseText && createdTasks.length > 0) {
      responseText = createdTasks.join('\n');
    }

    // Finalize streaming card if adapter supports it.
    // onStreamEnd awaits any in-flight card creation and returns true if a card
    // was actually finalized (meaning content is already visible to the user).
    let cardFinalized = false;
    if (hasStreamingCards && adapter.onStreamEnd) {
      try {
        const status = result.hasError ? 'error' : 'completed';
        cardFinalized = await adapter.onStreamEnd(msg.address.chatId, status, responseText);
      } catch (err) {
        console.warn('[bridge-manager] Card finalize failed:', err instanceof Error ? err.message : err);
      }
    }

    // Send response text — render via channel-appropriate format.
    // Skip if streaming card was finalized (content already in card).
    if (responseText) {
      if (!cardFinalized) {
        await deliverResponse(adapter, msg.address, responseText, binding.codepilotSessionId, msg.messageId);
      }
    } else if (result.hasError) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    if (createdTasks.length > 0) {
      console.log(`[bridge-manager] Created scheduled tasks for ${adapter.channelType}:${msg.address.botInstanceId || `${adapter.channelType}_default`}:${msg.address.chatId}: ${createdTasks.join(', ')}`);
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      adapter.endPreview?.(msg.address.chatId, previewState.draftId);
    }

    // If task was aborted and streaming card is still active, finalize as interrupted
    if (hasStreamingCards && adapter.onStreamEnd && taskAbort.signal.aborted) {
      try {
        await adapter.onStreamEnd(msg.address.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address.chatId);
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
export async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store, scheduler } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/model - Show current model status',
        '/model list - Show known models',
        '/model use &lt;name&gt; - Switch model',
        '/model default - Use the default model',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/restart - Request a safe daemon restart',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/task in <2m|30s|1h> <instruction> - Schedule one agent task',
        '/task daily <HH:MM> <instruction> - Daily recurring agent task',
        '/task list - List scheduled tasks',
        '/task remove <id> - Remove scheduled task',
        '/bot list - List configured bots',
        '/bot add <channel> <id> <workdir> key=value... - Add a bot config',
        '/bot delete <id> - Delete a bot config (cannot delete self)',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      // Abort any running task on the current session before creating a new one
      const oldBinding = router.resolve(msg.address);
      const st = getState();
      const oldTask = st.activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        st.activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      break;
    }

    case '/model': {
      const binding = router.resolve(msg.address);
      const [subcommand = '', ...rest] = args.split(/\s+/).filter(Boolean);
      const normalizedSubcommand = subcommand.toLowerCase();

      if (!normalizedSubcommand) {
        response = buildModelStatusResponse(binding);
        break;
      }

      if (normalizedSubcommand === 'help') {
        response = [
          '<b>Model Commands</b>',
          '',
          '/model',
          '/model list',
          '/model use &lt;name&gt;',
          '/model default',
          '/model help',
        ].join('\n');
        break;
      }

      if (normalizedSubcommand === 'list') {
        response = await buildModelListResponse(binding);
        break;
      }

      if (normalizedSubcommand === 'default') {
        abortActiveTask(binding.codepilotSessionId);
        const nextBinding = switchBindingToModel(msg.address, binding, '');
        const nextState = getModelState(nextBinding);
        response = [
          'Model reset to default.',
          `Session: <code>${nextBinding.codepilotSessionId.slice(0, 8)}...</code>`,
          `Current: <code>${escapeHtml(nextState.currentModel || 'runtime default')}</code>`,
        ].join('\n');
        break;
      }

      if (normalizedSubcommand === 'use') {
        const requestedModel = rest.join(' ').trim();
        if (!requestedModel) {
          response = 'Usage: /model use &lt;name&gt;';
          break;
        }
        abortActiveTask(binding.codepilotSessionId);
        const nextBinding = switchBindingToModel(msg.address, binding, requestedModel);
        response = [
          `Model switched to <code>${escapeHtml(requestedModel)}</code>.`,
          `Session: <code>${nextBinding.codepilotSessionId.slice(0, 8)}...</code>`,
          'A fresh session was created for this chat to avoid stale resume state.',
        ].join('\n');
        break;
      }

      response = 'Usage: /model | /model list | /model use &lt;name&gt; | /model default | /model help';
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      const modelState = getModelState(binding);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${escapeHtml(modelState.currentModel || 'runtime default')}</code>`,
        `Model Override: <code>${escapeHtml(modelState.bindingModel || 'none')}</code>`,
      ].join('\n');
      break;
    }

    case '/restart': {
      const requestPath = requestSafeRestart();
      response = [
        'Safe restart requested.',
        'The daemon will restart after the current chat turn completes.',
        `Request file: <code>${escapeHtml(requestPath)}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = getBridgeContext().store.listChannelBindings(adapter.channelType, adapter.botInstanceId);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId, undefined, msg.address.botInstanceId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/bot': {
      const botParts = args.split(/\s+/).filter(Boolean);
      const subcommand = (botParts[0] || '').toLowerCase();

      if (subcommand === 'list') {
        const bots = store.listBotInstances?.() || [];
        if (bots.length === 0) {
          response = 'No bots configured.';
          break;
        }
        response = [
          '<b>Bots</b>',
          '',
          ...bots.map((bot) => {
            const current = bot.id === adapter.botInstanceId ? ' current' : '';
            const state = bot.enabled ? 'enabled' : 'disabled';
            return `<code>${escapeHtml(bot.id)}</code> [${escapeHtml(bot.channelType)}] ${state}${current}\n<code>${escapeHtml(bot.defaults.workdir || '~')}</code>`;
          }),
        ].join('\n');
        break;
      }

      if (subcommand === 'add') {
        if (botParts.length < 4) {
          response = 'Usage: /bot add <channelType> <id> <workdir> key=value...';
          break;
        }
        const channelType = botParts[1].toLowerCase();
        const botId = botParts[2];
        const workdir = botParts[3];
        const validatedPath = validateWorkingDirectory(workdir);
        if (!validatedPath) {
          response = 'Invalid workdir. Must be an absolute path.';
          break;
        }
        const params = parseBotParams(botParts.slice(4));
        const defaults = {
          workdir: validatedPath,
          ...(params.model ? { model: params.model } : {}),
          mode: (validateMode(params.mode || 'code') ? params.mode || 'code' : 'code') as 'code' | 'plan' | 'ask',
          ...(params.providerId ? { providerId: params.providerId } : {}),
        };
        const security: Record<string, unknown> = {};
        const allowedUsers = parseCsv(params.allowedUsers);
        if (allowedUsers) security.allowedUsers = allowedUsers;
        const allowedChannels = parseCsv(params.allowedChannels);
        if (allowedChannels) security.allowedChannels = allowedChannels;
        const allowedGuilds = parseCsv(params.allowedGuilds);
        if (allowedGuilds) security.allowedGuilds = allowedGuilds;

        const bot: import('./host.js').BotInstance = {
          id: botId,
          channelType,
          enabled: true,
          defaults,
          credentials: {},
          ...(Object.keys(security).length > 0 ? { security } : {}),
        };

        if (channelType === 'feishu') {
          bot.credentials = {
            appId: params.appId || '',
            appSecret: params.appSecret || '',
            domain: params.domain || 'feishu',
          };
        } else if (channelType === 'telegram') {
          bot.credentials = {
            botToken: params.botToken || '',
            ...(params.chatId ? { chatId: params.chatId } : {}),
          };
        } else if (channelType === 'discord') {
          bot.credentials = { botToken: params.botToken || '' };
        } else if (channelType === 'qq') {
          bot.credentials = { appId: params.appId || '', appSecret: params.appSecret || '' };
          if (params.imageEnabled || params.maxImageSize) {
            bot.features = {
              ...(params.imageEnabled ? { imageEnabled: params.imageEnabled === 'true' } : {}),
              ...(params.maxImageSize ? { maxImageSize: Number(params.maxImageSize) } : {}),
            };
          }
        } else if (channelType === 'weixin') {
          bot.credentials = {};
        }

        try {
          if (!store.addBotInstance) {
            response = 'Bot management is not available in this runtime.';
            break;
          }
          store.addBotInstance(bot);
          response = [
            `Bot <code>${escapeHtml(botId)}</code> added.`,
            `Channel: <b>${escapeHtml(channelType)}</b>`,
            `Workdir: <code>${escapeHtml(validatedPath)}</code>`,
            'Restart the daemon to activate the new bot.',
          ].join('\n');
        } catch (error) {
          response = error instanceof Error ? escapeHtml(error.message) : 'Failed to add bot.';
        }
        break;
      }

      if (subcommand === 'delete') {
        const botId = botParts[1];
        if (!botId) {
          response = 'Usage: /bot delete <id>';
          break;
        }
        if (botId === adapter.botInstanceId) {
          response = 'Refusing to delete the current bot instance.';
          break;
        }
        response = store.deleteBotInstance?.(botId)
          ? `Bot <code>${escapeHtml(botId)}</code> deleted. Restart the daemon to apply the change.`
          : 'Bot not found.';
        break;
      }

      response = [
        '<b>Bot Commands</b>',
        '',
        '/bot list',
        '/bot add <channelType> <id> <workdir> key=value...',
        '/bot delete <id>',
      ].join('\n');
      break;
    }

    case '/task': {
      if (!scheduler) {
        response = 'Scheduler is not available in this runtime.';
        break;
      }
      const taskParts = args.split(/\s+/).filter(Boolean);
      const subcommand = (taskParts[0] || '').toLowerCase();

      if (subcommand === 'list') {
        const tasks = scheduler.listTasks(adapter.channelType, msg.address.chatId, msg.address.botInstanceId);
        if (tasks.length === 0) {
          response = 'No scheduled tasks.';
          break;
        }
        response = [
          '<b>Scheduled Tasks</b>',
          '',
          ...tasks.slice(0, 20).map((task) => {
            const title = escapeHtml(String(task.payload.title || task.payload.instruction || ''));
            const description = escapeHtml(String(task.payload.description || ''));
            return `<code>${task.id}</code> ${title}${description ? `\n${description}` : ''}\nnext: <code>${escapeHtml(task.nextRunAt)}</code>`;
          }),
        ].join('\n');
        break;
      }

      if (subcommand === 'remove') {
        const taskId = taskParts[1];
        if (!taskId) {
          response = 'Usage: /task remove &lt;id&gt;';
          break;
        }
        response = scheduler.removeTask(taskId, adapter.channelType, msg.address.chatId, msg.address.botInstanceId)
          ? `Removed task <code>${escapeHtml(taskId)}</code>.`
          : 'Task not found.';
        break;
      }

      if (subcommand === 'in') {
        const delayRaw = taskParts[1] || '';
        const instruction = taskParts.slice(2).join(' ').trim();
        if (!delayRaw || !instruction) {
          response = 'Usage: /task in &lt;2m|30s|1h&gt; &lt;instruction&gt;';
          break;
        }
        const delayMs = parseDelayMs(delayRaw);
        if (!delayMs) {
          response = 'Invalid delay. Use forms like 30s, 2m, 1h, 1d.';
          break;
        }
        const task = scheduler.scheduleTaskIn({
          botInstanceId: msg.address.botInstanceId,
          channelType: adapter.channelType,
          chatId: msg.address.chatId,
          title: instruction,
          description: instruction,
          instruction,
          delayMs,
        });
        response = `Task created.\nTask: <code>${task.id}</code>\nInstruction: <b>${escapeHtml(instruction)}</b>\nNext run: <code>${escapeHtml(task.nextRunAt)}</code>`;
        break;
      }

      if (subcommand === 'daily') {
        const timeHHMM = taskParts[1] || '';
        const instruction = taskParts.slice(2).join(' ').trim();
        if (!/^\d{2}:\d{2}$/.test(timeHHMM) || !instruction) {
          response = 'Usage: /task daily &lt;HH:MM&gt; &lt;instruction&gt;';
          break;
        }
        const task = scheduler.scheduleTaskDaily({
          botInstanceId: msg.address.botInstanceId,
          channelType: adapter.channelType,
          chatId: msg.address.chatId,
          title: instruction,
          description: instruction,
          instruction,
          timeHHMM,
        });
        response = `Daily task created.\nTask: <code>${task.id}</code>\nInstruction: <b>${escapeHtml(instruction)}</b>\nNext run: <code>${escapeHtml(task.nextRunAt)}</code>`;
        break;
      }

      response = [
        'Usage:',
        '/task in <2m|30s|1h> <instruction>',
        '/task daily <HH:MM> <instruction>',
        '/task list',
        '/task remove <id>',
      ].join('\n');
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/model - Show current model status',
        '/model list - Show known models',
        '/model use &lt;name&gt; - Switch model',
        '/model default - Use the default model',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/restart - Request a safe daemon restart',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/task in <2m|30s|1h> <instruction> - Schedule one agent task',
        '/task daily <HH:MM> <instruction> - Daily recurring agent task',
        '/task list - List scheduled tasks',
        '/task remove <id> - Remove scheduled task',
        '/bot list - List configured bots',
        '/bot add <channelType> <id> <workdir> key=value...',
        '/bot delete <id> - Delete a bot config',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (Feishu/QQ/WeChat, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage, sendProactiveMessage };

export { sendProactiveMessage };
