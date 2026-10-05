/**
 * 计划存储契约：整单替换，不合并；空串清目标；脏数据过滤。
 */
import { describe, expect, it } from 'vitest';
import { PlanStore } from '../src/agent/plan.js';

describe('PlanStore', () => {
  it('starts empty', () => {
    expect(new PlanStore().snapshot()).toEqual({ goal: null, todos: [] });
  });

  it('replaces wholesale, trims, drops empties and non-strings', () => {
    const p = new PlanStore();
    const snap = p.update('  build a house  ', [' gather wood ', '', '  ', 42 as unknown as string]);
    expect(snap).toEqual({ goal: 'build a house', todos: ['gather wood'] });
  });

  it('untouched fields stay: goal-only and todos-only updates', () => {
    const p = new PlanStore();
    p.update('g', ['t1']);
    expect(p.update('g2').todos).toEqual(['t1']);
    expect(p.update(undefined, ['t2']).goal).toBe('g2');
  });

  it('empty goal clears; snapshot returns copies', () => {
    const p = new PlanStore();
    p.update('g', ['t']);
    expect(p.update('   ').goal).toBeNull();
    const s1 = p.snapshot();
    s1.todos.push('hack');
    expect(p.snapshot().todos).toEqual(['t']);
  });

  it('clear wipes everything', () => {
    const p = new PlanStore();
    p.update('g', ['t']);
    expect(p.clear()).toEqual({ goal: null, todos: [] });
  });
});
