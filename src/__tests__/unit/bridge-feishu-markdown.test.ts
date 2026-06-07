import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStreamingCardJson,
  buildStreamingContent,
  buildFinalCardJson,
} from '../../lib/bridge/markdown/feishu.js';

describe('feishu streaming markdown helpers', () => {
  it('shows waiting status and elapsed time before any text arrives', () => {
    const content = buildStreamingContent('', [], {
      thinking: true,
      elapsedMs: 65_000,
    });

    assert.match(content, /已接收，正在思考 · 1m 5s/);
    assert.match(content, /当前还在分析阶段/);
  });

  it('includes recent tool progress in streaming content', () => {
    const content = buildStreamingContent('', [
      { id: '1', name: 'Bash', status: 'complete' },
      { id: '2', name: 'Edit', status: 'running' },
    ], {
      thinking: false,
      elapsedMs: 12_300,
    });

    assert.match(content, /工具动态/);
    assert.match(content, /✅ `执行命令`/);
    assert.match(content, /🔄 `修改文件`/);
    assert.match(content, /正在执行: 修改文件 · 12\.3s/);
  });

  it('shows status text before the first reply token arrives', () => {
    const content = buildStreamingContent('', [], {
      thinking: true,
      elapsedMs: 8_000,
      statusText: '正在请求模型响应。',
      statusHistory: ['任务已接收，正在准备上下文。', '正在请求模型响应。'],
    });

    assert.match(content, /正在请求模型响应。 · 8\.0s/);
    assert.match(content, /处理进度/);
    assert.match(content, /任务已接收，正在准备上下文。/);
    assert.match(content, /正在请求模型响应。/);
  });

  it('uses dynamic summary in streaming card json', () => {
    const cardJson = buildStreamingCardJson('', [
      { id: '1', name: 'Bash', status: 'complete' },
    ], {
      thinking: false,
      elapsedMs: 9_000,
    });

    const parsed = JSON.parse(cardJson);
    assert.equal(parsed.config.summary.content, '最近完成: 执行命令 · 9.0s');
    assert.match(parsed.body.elements[0].content, /工具动态/);
  });

  it('keeps a compact process summary in the final card', () => {
    const cardJson = buildFinalCardJson(
      '最终答案',
      [{ id: '1', name: 'Bash', status: 'complete', detail: 'npm run build' }],
      { status: '✅ Completed', elapsed: '12.0s' },
      { statusHistory: ['任务已接收，正在准备上下文。', '正在执行命令: npm run build'] },
    );

    const parsed = JSON.parse(cardJson);
    const content = parsed.body.elements.map((element: { content?: string }) => element.content || '').join('\n');
    assert.match(content, /处理过程/);
    assert.match(content, /工具摘要/);
    assert.match(content, /执行命令/);
    assert.match(content, /npm run build/);
  });
});
