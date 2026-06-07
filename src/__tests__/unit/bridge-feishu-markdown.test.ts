import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStreamingCardJson,
  buildStreamingContent,
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

    assert.match(content, /最近进度/);
    assert.match(content, /✅ `Bash`/);
    assert.match(content, /🔄 `Edit`/);
    assert.match(content, /正在执行: Edit · 12\.3s/);
  });

  it('uses dynamic summary in streaming card json', () => {
    const cardJson = buildStreamingCardJson('', [
      { id: '1', name: 'Bash', status: 'complete' },
    ], {
      thinking: false,
      elapsedMs: 9_000,
    });

    const parsed = JSON.parse(cardJson);
    assert.equal(parsed.config.summary.content, '最近完成: Bash · 9.0s');
    assert.match(parsed.body.elements[0].content, /最近进度/);
  });
});
