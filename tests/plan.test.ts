/**
 * 计划存储契约：整单替换，不合并；空串清目标；脏数据过滤。
 * todos 是 {text,done}——模型要能标进度，纯字符串只作为旧格式兼容。
 */
import { describe, expect, it } from 'vitest';
import { PlanStore } from '../src/agent/plan.js';

describe('PlanStore', () => {
  it('starts empty', () => {
    expect(new PlanStore().snapshot()).toEqual({ goal: null, todos: [] });
  });

  it('replaces wholesale, trims, drops empties and junk', () => {
    const p = new PlanStore();
    const snap = p.update('  build a house  ', [
      { text: ' gather wood ', done: false },
      { text: '  ', done: true },
      { text: 'craft planks', done: true },
      null as unknown as { text: string; done: boolean },
    ]);
    expect(snap).toEqual({
      goal: 'build a house',
      todos: [
        { text: 'gather wood', done: false },
        { text: 'craft planks', done: true },
      ],
    });
  });

  it('accepts the legacy plain-string shape as not-done', () => {
    const p = new PlanStore();
    expect(p.update('g', ['t1']).todos).toEqual([{ text: 't1', done: false }]);
  });

  it('coerces a missing/loose done flag to false', () => {
    const p = new PlanStore();
    expect(p.update('g', [{ text: 'a' } as unknown as { text: string; done: boolean }]).todos).toEqual([
      { text: 'a', done: false },
    ]);
    expect(p.update('g', [{ text: 'b', done: 'yes' } as unknown as { text: string; done: boolean }]).todos).toEqual([
      { text: 'b', done: false },
    ]);
  });

  it('untouched fields stay: goal-only and todos-only updates', () => {
    const p = new PlanStore();
    p.update('g', [{ text: 't1', done: false }]);
    expect(p.update('g2').todos).toEqual([{ text: 't1', done: false }]);
    expect(p.update(undefined, [{ text: 't2', done: true }]).goal).toBe('g2');
  });

  it('empty goal clears; snapshot returns copies', () => {
    const p = new PlanStore();
    p.update('g', [{ text: 't', done: false }]);
    expect(p.update('   ').goal).toBeNull();
    const s1 = p.snapshot();
    s1.todos.push({ text: 'hack', done: false });
    s1.todos.forEach((t) => {
      t.text = 'mutated';
    });
    expect(p.snapshot().todos).toEqual([{ text: 't', done: false }]);
  });

  it('clear wipes everything', () => {
    const p = new PlanStore();
    p.update('g', [{ text: 't', done: false }]);
    expect(p.clear()).toEqual({ goal: null, todos: [] });
  });
});
