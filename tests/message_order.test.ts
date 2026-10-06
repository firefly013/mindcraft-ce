/**
 * 消息列顺序：system 头固定，历史居中，Live 快照永远最后一条。
 * 常变部分不前移，前缀缓存才保得住。client 注入，不联网。
 */
import { describe, expect, it } from 'vitest';
import { GPT } from '../src/models/gpt.js';
import type { ChatMessage } from '../src/types/common.js';

interface CapturedBody {
  messages: ChatMessage[];
  tools: unknown[];
  tool_choice: unknown;
}

function stubbedGpt(): { model: GPT; bodies: CapturedBody[] } {
  const bodies: CapturedBody[] = [];
  const client = {
    chat: {
      completions: {
        create: (body: Record<string, unknown>) => {
          bodies.push(body as unknown as CapturedBody);
          return Promise.resolve({
            choices: [{ message: { content: 'ok', tool_calls: [] } }],
          });
        },
      },
    },
  };
  return { model: new GPT('gpt-5.4', undefined, undefined, client as never), bodies };
}

describe('sendRequestWithTools message order', () => {
  it('system first, history middle, live snapshot last', async () => {
    const { model, bodies } = stubbedGpt();
    const turns: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await model.sendRequestWithTools(turns, 'SYS', [], 'auto', 'SNAP');
    expect(bodies).toHaveLength(1);
    const messages = bodies[0]?.messages ?? [];
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(messages[2]?.role).toBe('user');
    // 适配器不再自己套 "## 当前世界快照" 标题：尾巴由调用方拼好，
    // 这里原样发出，免得 "## 事件" 挂到 "## 当前世界快照" 底下。
    expect(messages[2]?.content).toBe('SNAP');
  });

  it('no snapshot, no tail message', async () => {
    const { model, bodies } = stubbedGpt();
    await model.sendRequestWithTools([{ role: 'user', content: 'hi' }], 'SYS', [], 'auto', '  ');
    expect(bodies[0]?.messages ?? []).toHaveLength(2);
  });

  it('system prompt never carries the snapshot even when provided', async () => {
    const { model, bodies } = stubbedGpt();
    await model.sendRequestWithTools([], 'SYS', [], 'auto', 'SNAP');
    expect(bodies[0]?.messages[0]?.content).toBe('SYS');
  });
});
