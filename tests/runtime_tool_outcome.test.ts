/**
 * 工具回执文本：与旧 `Agent.runTool` 逐字一致。
 *
 * 回执措辞是模型学过的契约——`工具 X {args} → 结果` 这个形状它认得。
 * 翻转 `agent.ts` 时最容易丢的就是这个：新路径如果直接把 `{status,data}`
 * JSON 化发出去，模型看到的就不是它熟悉的东西了。
 */
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/prompts.js';
import { loopResultText, outcomeText } from '../src/runtime/tools.js';

describe('loopResultText', () => {
  it('completed：正文是 data 的 outcomeText', () => {
    expect(loopResultText('Look', { radius: 8 }, { status: 'completed', data: '看到平原' })).toBe(
      MESSAGES.toolOutcome('Look', { radius: 8 }, '看到平原'),
    );
  });

  it('accepted：动作类即时回执，正文是认领信息（结果以后以 L3 事件回来）', () => {
    const text = loopResultText('goToPlayer', { username: 'bobo' }, {
      status: 'accepted',
      data: { action_id: 7, generation: 3 },
    });
    expect(text).toBe(
      MESSAGES.toolOutcome('goToPlayer', { username: 'bobo' }, '{"action_id":7,"generation":3}'),
    );
    expect(text).toContain('action_id');
  });

  it('rejected：正文是 `rejected: 原因`', () => {
    expect(loopResultText('craftRecipe', {}, { status: 'rejected', reason: '缺木头' })).toBe(
      MESSAGES.toolOutcome('craftRecipe', {}, 'rejected: 缺木头'),
    );
  });

  it('rejected 没给 reason 时退回 code，再退回 unknown', () => {
    expect(loopResultText('X', {}, { status: 'rejected', code: 'BAD_ARGS' })).toContain(
      'rejected: BAD_ARGS',
    );
    expect(loopResultText('X', {}, { status: 'rejected' })).toContain('rejected: unknown');
  });

  it('completed 但 data 为空/null/空串 → (no output)，与 outcomeText 一致', () => {
    expect(loopResultText('X', {}, { status: 'completed' })).toContain('(no output)');
    expect(loopResultText('X', {}, { status: 'completed', data: null })).toContain('(no output)');
    expect(loopResultText('X', {}, { status: 'completed', data: '' })).toContain('(no output)');
  });

  it('对象 data 走 JSON，不出现 [object Object]', () => {
    const text = loopResultText('X', {}, { status: 'completed', data: { hits: 2 } });
    expect(text).toContain('{"hits":2}');
    expect(text).not.toContain('[object Object]');
  });

  it('args 超长会被截断（500 字），并标出来', () => {
    const text = loopResultText('X', { blob: 'a'.repeat(800) }, { status: 'completed', data: 'ok' });
    expect(text).toContain('…[截断]');
    // 截断后整条回执不该还带着 800 个 a
    expect(text.length).toBeLessThan(600);
  });

  it('args 循环引用不抛，降级成 {}', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => loopResultText('X', circular, { status: 'completed', data: 'ok' })).not.toThrow();
    expect(loopResultText('X', circular, { status: 'completed', data: 'ok' })).toContain('{}');
  });
});

describe('outcomeText（既有行为，钉住）', () => {
  it('字符串原样，空串 → (no output)', () => {
    expect(outcomeText('abc')).toBe('abc');
    expect(outcomeText('')).toBe('(no output)');
    expect(outcomeText(null)).toBe('(no output)');
  });
});
