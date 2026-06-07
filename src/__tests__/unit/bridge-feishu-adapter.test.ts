import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FeishuAdapter } from '../../lib/bridge/adapters/feishu-adapter.js';

describe('FeishuAdapter streaming card fallback', () => {
  it('falls back to chat send when reply rejects CardKit card entity', async () => {
    const adapter = new FeishuAdapter();
    let createCalls = 0;
    let replyCalls = 0;
    let sendCalls = 0;

    (adapter as any).restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => {
              createCalls += 1;
              return { data: { card_id: 'card_v2_test_123' } };
            },
          },
        },
      },
      im: {
        message: {
          reply: async () => {
            replyCalls += 1;
            const err = new Error('Request failed with status code 400') as Error & {
              response?: { data?: { code?: number; msg?: string } };
            };
            err.response = {
              data: {
                code: 230099,
                msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: cardid is invalid; ',
              },
            };
            throw err;
          },
          create: async () => {
            sendCalls += 1;
            return { data: { message_id: 'om_fallback_message' } };
          },
        },
      },
    };

    const ok = await (adapter as any)._doCreateStreamingCard('oc_test_chat', 'om_reply_target');
    assert.equal(ok, true);
    assert.equal(createCalls, 1);
    assert.equal(replyCalls, 1);
    assert.equal(sendCalls, 1);

    const state = (adapter as any).activeCards.get('oc_test_chat');
    assert.equal(state?.messageId, 'om_fallback_message');
    if (state?.heartbeatTimer) clearInterval(state.heartbeatTimer);
  });
});
