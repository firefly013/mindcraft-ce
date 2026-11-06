/**
 * 工具回执文本：只报工具名与结果，不回显模型刚发出去的参数。
 */
import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../src/shared/prompts.js';
import { loopResultText, outcomeText } from '../src/brain/tools/tools.js';

describe('loopResultText', () => {
  it('completed：正文是 data 的 outcomeText', () => {
    expect(loopResultText('Look', { status: 'completed', data: '看到平原' })).toBe(
      MESSAGES.toolOutcome('Look', '看到平原'),
    );
  });

  it('accepted：动作类即时回执，只给认领标识（结果以后以 L3 事件回来）', () => {
    const text = loopResultText('goToPlayer', {
      status: 'accepted',
      data: { action_id: 'goToPlayer', call_id: 'goToPlayer#3' },
    });
    expect(text).toBe(
      MESSAGES.toolOutcome('goToPlayer', '{"action_id":"goToPlayer","call_id":"goToPlayer#3"}'),
    );
    expect(text).toContain('call_id');
    expect(text).not.toContain('参数');
  });

  it('rejected：正文是 `rejected: 原因`', () => {
    expect(loopResultText('craftRecipe', { status: 'rejected', reason: '缺木头' })).toBe(
      MESSAGES.toolOutcome('craftRecipe', 'rejected: 缺木头'),
    );
  });

  it('rejected 没给 reason 时退回 code，再退回 unknown', () => {
    expect(loopResultText('X', { status: 'rejected', code: 'BAD_ARGS' })).toContain(
      'rejected: BAD_ARGS',
    );
    expect(loopResultText('X', { status: 'rejected' })).toContain('rejected: unknown');
  });

  it('completed 但 data 为空/null/空串 → (no output)，与 outcomeText 一致', () => {
    expect(loopResultText('X', { status: 'completed' })).toContain('(no output)');
    expect(loopResultText('X', { status: 'completed', data: null })).toContain('(no output)');
    expect(loopResultText('X', { status: 'completed', data: '' })).toContain('(no output)');
  });

  it('对象 data 走 JSON，不出现 [object Object]', () => {
    const text = loopResultText('X', { status: 'completed', data: { hits: 2 } });
    expect(text).toContain('{"hits":2}');
    expect(text).not.toContain('[object Object]');
  });

  it('data 是函数 → String() 兜底（JSON.stringify 对函数返回 undefined）', () => {
    // 箭头函数的源码里没有 `function` 关键字，所以只断言"给了可读的源码"
    expect(outcomeText((): void => {})).toContain('=>');
  });

  it('data 循环引用 → [unserializable]，**不是** [object Object]', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    // [object Object] 看起来像一条真的回执，比没有信息更糟
    expect(outcomeText(circular)).toBe('[unserializable]');
  });
});

describe('outcomeText（既有行为，钉住）', () => {
  it('字符串原样，空串 → (no output)', () => {
    expect(outcomeText('abc')).toBe('abc');
    expect(outcomeText('')).toBe('(no output)');
    expect(outcomeText(null)).toBe('(no output)');
  });
});
