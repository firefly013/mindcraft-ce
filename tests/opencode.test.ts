/**
 * OpenCode 供应商契约：思考硬关闭走 extra_body，会话路由头必带，
 * 消息列顺序与 andy 一致。client 注入，不联网。
 */
import { describe, expect, it } from 'vitest';
import { OpenCode, OPENCODE_DEFAULT_MODEL } from '../src/models/opencode.js';
import type { OpenCodeClient } from '../src/models/opencode.js';
import type { ChatMessage } from '../src/types/common.js';

interface Seen {
  body: Record<string, unknown>;
  opts?: Record<string, unknown>;
}

function stubbed(seen: Seen[]): OpenCodeClient {
  return {
    chat: {
      completions: {
        create: (body: Record<string, unknown>, opts?: Record<string, unknown>) => {
          seen.push({ body, opts });
          return Promise.resolve({
            choices: [
              {
                message: {
                  content: 'hi',
                  tool_calls: [
                    { id: '1', function: { name: 'Finish', arguments: '{}' } },
                  ],
                },
              },
            ],
          });
        },
      },
    },
  };
}

describe('OpenCode', () => {
  it('defaults to deepseek-v4.1-flash and disables thinking via extra_body', async () => {
    const seen: Seen[] = [];
    const model = new OpenCode(null, undefined, undefined, stubbed(seen));
    const res = await model.sendRequestWithTools([{ role: 'user', content: 'hi' }], 'SYS', [], 'auto', '');
    expect(res.text).toBe('hi');
    expect(res.tool_calls).toEqual([{ id: '1', name: 'Finish', args: {} }]);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body['model']).toBe(OPENCODE_DEFAULT_MODEL);
    const extra = seen[0]?.opts?.['extra_body'] as { thinking?: { type?: string } };
    expect(extra.thinking?.type).toBe('disabled');
    // thinking 开关只走 extra_body，不进正文 body。
    expect('thinking' in (body as object)).toBe(false);
  });

  it('appends the live snapshot last', async () => {
    const seen: Seen[] = [];
    const model = new OpenCode('deepseek-v4.1-flash', undefined, undefined, stubbed(seen));
    await model.sendRequestWithTools([], 'SYS', [], 'auto', 'SNAP');
    const messages = (seen[0]?.body as Record<string, unknown>)['messages'] as ChatMessage[];
    expect(messages[messages.length - 1]?.content).toContain('SNAP');
  });

  it('mints a session id per process, env wins', () => {
    const seen: Seen[] = [];
    const a = new OpenCode(null, undefined, undefined, stubbed(seen));
    const b = new OpenCode(null, undefined, undefined, stubbed(seen));
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.sessionId).not.toBe(b.sessionId);
    const c = new OpenCode(null, undefined, { session_id: 'room-7' }, stubbed(seen));
    expect(c.sessionId).toBe('room-7');
  });
});
