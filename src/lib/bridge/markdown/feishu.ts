import type { ToolCallInfo } from '../types.js';

interface StreamingCardMeta {
  elapsedMs?: number;
  thinking?: boolean;
  statusText?: string;
  statusHistory?: string[];
}

interface FinalCardMeta {
  statusHistory?: string[];
}

/**
 * Feishu-specific Markdown processing.
 *
 * Rendering strategy (aligned with Openclaw):
 * - Code blocks / tables → interactive card (schema 2.0 markdown)
 * - Other text → post (msg_type: 'post') with md tag
 *
 * Schema 2.0 cards render code blocks, tables, bold, italic, links properly.
 * Post messages with md tag render bold, italic, inline code, links.
 */

/**
 * Detect complex markdown (code blocks / tables).
 * Used by send() to decide between card and post rendering.
 */
export function hasComplexMarkdown(text: string): boolean {
  // Fenced code blocks
  if (/```[\s\S]*?```/.test(text)) return true;
  // Tables: header row followed by separator row with pipes and dashes
  if (/\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)) return true;
  return false;
}

/**
 * Preprocess markdown for Feishu rendering.
 * Only ensures code fences have a newline before them.
 * Does NOT touch the text after ``` to preserve language tags like ```python.
 */
export function preprocessFeishuMarkdown(text: string): string {
  // Ensure ``` has newline before it (unless at start of text)
  return text.replace(/([^\n])```/g, '$1\n```');
}

/**
 * Build Feishu interactive card content (schema 2.0 markdown).
 * Renders code blocks, tables, bold, italic, links, inline code properly.
 * Aligned with Openclaw's buildMarkdownCard().
 */
export function buildCardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  });
}

/**
 * Build Feishu post message content (msg_type: 'post') with md tag.
 * Used for simple text without code blocks or tables.
 * Aligned with Openclaw's buildFeishuPostMessagePayload().
 */
export function buildPostContent(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Convert simple HTML (from command responses) to markdown for Feishu.
 * Handles common tags: <b>, <i>, <code>, <br>, entities.
 */
export function htmlToFeishuMarkdown(html: string): string {
  return html
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<i>(.*?)<\/i>/gi, '*$1*')
    .replace(/<em>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build tool progress markdown lines.
 * Each tool shows an icon based on status: 🔄 Running, ✅ Complete, ❌ Error.
 */
export function buildToolProgressMarkdown(tools: ToolCallInfo[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((tc) => {
    const icon = tc.status === 'running' ? '🔄' : tc.status === 'complete' ? '✅' : '❌';
    const label = humanizeToolName(tc.name);
    const detail = formatToolDetail(tc.detail);
    return `${icon} \`${label}\`${detail}`;
  });
  return lines.join('\n');
}

function humanizeToolName(name: string): string {
  if (name === 'Bash') return '执行命令';
  if (name === 'Edit') return '修改文件';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean);
    if (parts.length >= 3) {
      return `调用工具 ${parts[1]}/${parts[2]}`;
    }
    return '调用工具';
  }
  return name;
}

function formatToolDetail(detail?: string): string {
  if (!detail) return '';
  const safeDetail = detail.replace(/`/g, "'");
  return ` · ${safeDetail}`;
}

/**
 * Format elapsed time for card footer.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m ${remSec}s`;
}

function buildStreamingSummary(text: string, tools: ToolCallInfo[], meta?: StreamingCardMeta): string {
  const elapsed = meta?.elapsedMs != null ? ` · ${formatElapsed(meta.elapsedMs)}` : '';
  const trimmedText = text.trim();
  const statusText = normalizeStreamingStatusText(meta?.statusText);
  if (trimmedText) return `正在生成回复${elapsed}`;
  if (tools.length > 0) {
    const latestTool = tools[tools.length - 1];
    const latestState = latestTool.status === 'error'
      ? '最近出错'
      : latestTool.status === 'running'
        ? '正在执行'
        : '最近完成';
    return `${latestState}: ${humanizeToolName(latestTool.name)}${elapsed}`;
  }
  if (statusText) return `${summarizeStatusText(statusText)}${elapsed}`;
  if (meta?.thinking === false) return `正在处理中${elapsed}`;
  return `已接收，正在思考${elapsed}`;
}

function normalizeStreamingStatusText(statusText?: string): string | null {
  if (typeof statusText !== 'string') return null;
  const normalized = statusText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || null;
}

function summarizeStatusText(statusText: string): string {
  const oneLine = statusText.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 44) return oneLine;
  return `${oneLine.slice(0, 41)}...`;
}

function normalizeStatusHistory(statusHistory?: string[]): string[] {
  if (!Array.isArray(statusHistory)) return [];
  const normalized = statusHistory
    .map((entry) => normalizeStreamingStatusText(entry))
    .filter((entry): entry is string => !!entry);
  return normalized.filter((entry, index) => index === 0 || entry !== normalized[index - 1]);
}

function buildStatusHistoryMarkdown(statusHistory?: string[]): string {
  const history = normalizeStatusHistory(statusHistory).slice(-4);
  if (history.length === 0) return '';
  return history
    .map((entry, index) => `${index === history.length - 1 ? '•' : '◦'} ${entry}`)
    .join('\n');
}

/**
 * Build the body elements array for a streaming card update.
 * Combines main text content with tool progress.
 */
export function buildStreamingContent(text: string, tools: ToolCallInfo[], meta?: StreamingCardMeta): string {
  const trimmedText = text.trim();
  const statusHistoryBlock = buildStatusHistoryMarkdown(meta?.statusHistory ?? (meta?.statusText ? [meta.statusText] : []));
  const recentTools = tools.slice(-6);
  const hiddenToolCount = tools.length - recentTools.length;
  const sections = [`**${buildStreamingSummary(text, tools, meta)}**`];

  if (trimmedText) {
    sections.push(trimmedText);
  } else if (tools.length > 0) {
    sections.push('_任务已开始，正在持续执行中。_');
  } else {
    sections.push('_任务已开始，当前还在分析阶段。_');
  }

  if (statusHistoryBlock) {
    sections.push(`**处理进度**\n${statusHistoryBlock}`);
  }

  if (recentTools.length > 0) {
    let toolBlock = `**工具动态**\n${buildToolProgressMarkdown(recentTools)}`;
    if (hiddenToolCount > 0) {
      toolBlock += `\n… 另有 ${hiddenToolCount} 项较早进度`;
    }
    sections.push(toolBlock);
  }

  return sections.join('\n\n');
}

/**
 * Build the full streaming card JSON (schema 2.0) for incremental updates.
 */
export function buildStreamingCardJson(text: string, tools: ToolCallInfo[], meta?: StreamingCardMeta): string {
  const summary = buildStreamingSummary(text, tools, meta);
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      wide_screen_mode: true,
      summary: { content: summary },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: preprocessFeishuMarkdown(buildStreamingContent(text, tools, meta)),
          text_align: 'left',
          text_size: 'normal',
          element_id: 'streaming_content',
        },
      ],
    },
  });
}

/**
 * Build the final card JSON (schema 2.0) with text, tool progress, and footer.
 */
export function buildFinalCardJson(
  text: string,
  tools: ToolCallInfo[],
  footer: { status: string; elapsed: string } | null,
  meta?: FinalCardMeta,
): string {
  const elements: Array<Record<string, unknown>> = [];

  // Main text content
  let content = preprocessFeishuMarkdown(text);
  void tools;

  if (content) {
    elements.push({
      tag: 'markdown',
      content,
      text_align: 'left',
      text_size: 'normal',
    });
  }

  const processSummary = buildFinalProcessSummary(tools, meta?.statusHistory);
  if (processSummary) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: preprocessFeishuMarkdown(processSummary),
      text_size: 'notation',
    });
  }

  // Footer
  if (footer) {
    const parts: string[] = [];
    if (footer.status) parts.push(footer.status);
    if (footer.elapsed) parts.push(footer.elapsed);
    if (parts.length > 0) {
      if (!processSummary) {
        elements.push({ tag: 'hr' });
      }
      elements.push({
        tag: 'markdown',
        content: parts.join(' · '),
        text_size: 'notation',
      });
    }
  }

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

function buildFinalProcessSummary(tools: ToolCallInfo[], statusHistory?: string[]): string {
  const sections: string[] = [];
  const historyBlock = buildStatusHistoryMarkdown(statusHistory);
  if (historyBlock) {
    sections.push(`**处理过程**\n${historyBlock}`);
  }

  if (tools.length > 0) {
    const recentTools = tools.slice(-4);
    sections.push(`**工具摘要**\n${buildToolProgressMarkdown(recentTools)}`);
  }

  return sections.join('\n\n');
}

/**
 * Build a permission card with real action buttons (column_set layout).
 * Structure aligned with CodePilot's working Feishu outbound implementation.
 * Returns the card JSON string for msg_type: 'interactive'.
 */
export function buildPermissionButtonCard(
  text: string,
  permissionRequestId: string,
  chatId?: string,
): string {
  const buttons = [
    { label: 'Allow', type: 'primary', action: 'allow' },
    { label: 'Allow Session', type: 'default', action: 'allow_session' },
    { label: 'Deny', type: 'danger', action: 'deny' },
  ];

  const buttonColumns = buttons.map((btn) => ({
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: btn.label },
      type: btn.type,
      size: 'medium',
      value: { callback_data: `perm:${btn.action}:${permissionRequestId}`, ...(chatId ? { chatId } : {}) },
    }],
  }));

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Permission Required' },
      template: 'blue',
      icon: { tag: 'standard_icon', token: 'lock-chat_filled' },
      padding: '12px 12px 12px 12px',
    },
    body: {
      elements: [
        { tag: 'markdown', content: text, text_size: 'normal' },
        { tag: 'markdown', content: '⏱ This request will expire in 5 minutes', text_size: 'notation' },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_align: 'left',
          columns: buttonColumns,
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: 'Or reply: `1` Allow · `2` Allow Session · `3` Deny',
          text_size: 'notation',
        },
      ],
    },
  });
}
