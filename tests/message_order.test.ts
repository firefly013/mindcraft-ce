/**
 * 消息列顺序：system 头固定，历史居中，Live 快照永远最后一条。
 * 常变部分不前移，前缀缓存才保得住。send 直接 stub，不联网。
 */
import { describe, expect, it } from 'vitest';
import { Andy } from '../src/models/andy.js';
import type { ChatMessage } from '../src/types/common.js';

interface CapturedBody {
  messages: ChatMessage[];
  tools: unknown[];
  tool_choice: unknown;
}

function stubbedAndy(): { model: Andy; bodies: CapturedBody[] } {
  const model = new Andy('auto');
  const bodies: CapturedBody[] = [];
  model.send = ((endpoint: string, body: Record<string, unknown>) => {
    void endpoint;
    bodies.push(body as unknown as CapturedBody);
    return Promise.resolve({
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
    });
  }) as Andy['send'];
  return { model, bodies };
}

describe('sendRequestWithTools message order', () => {
  it('system first, history middle, live snapshot last', async () => {
    const { model, bodies } = stubbedAndy();
    const turns: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await model.sendRequestWithTools(turns, 'SYS', [], 'auto', 'SNAP');
    expect(bodies).toHaveLength(1);
    const messages = bodies[0]?.messages ?? [];
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(messages[2]?.role).toBe('user');
    expect(messages[2]?.content).toContain('## 当前世界快照');
    expect(messages[2]?.content).toContain('SNAP');
  });

  it('no snapshot, no tail message', async () => {
    const { model, bodies } = stubbedAndy();
    await model.sendRequestWithTools([{ role: 'user', content: 'hi' }], 'SYS', [], 'auto', '  ');
    expect(bodies[0]?.messages).toHaveLength(2);
  });

  it('system prompt never carries the snapshot even when provided', async () => {
    const { model, bodies } = stubbedAndy();
    await model.sendRequestWithTools([], 'SYS', [], 'auto', 'SNAP');
    expect(bodies[0]?.messages[0]?.content).toBe('SYS');
  });
});
