/**
 * 计划存储契约：整单替换，不合并；空串清目标；脏数据过滤。
 * 现在只维护单一 goal，没有 todos。
 */
import { describe, expect, it } from 'vitest';
import { PlanStore } from '../src/brain/plan.js';

describe('PlanStore', () => {
  it('starts empty', () => {
    expect(new PlanStore().snapshot()).toEqual({ goal: null });
  });

  it('replaces wholesale and trims', () => {
    const p = new PlanStore();
    expect(p.update('  build a house  ')).toEqual({ goal: 'build a house' });
  });

  it('undefined leaves the goal untouched', () => {
    const p = new PlanStore();
    p.update('g1');
    expect(p.update(undefined)).toEqual({ goal: 'g1' });
    expect(p.update(null)).toEqual({ goal: null });
  });

  it('empty goal clears; snapshot returns a copy', () => {
    const p = new PlanStore();
    p.update('g');
    expect(p.update('   ').goal).toBeNull();
    const s1 = p.snapshot();
    s1.goal = 'hack';
    expect(p.snapshot().goal).toBeNull();
  });

  it('hydrate restores the goal and treats blank as empty', () => {
    const p = new PlanStore();
    p.hydrate('  旧目标  ');
    expect(p.snapshot()).toEqual({ goal: '旧目标' });
    p.hydrate('   ');
    expect(p.snapshot()).toEqual({ goal: null });
  });

  it('clear wipes everything', () => {
    const p = new PlanStore();
    p.update('g');
    expect(p.clear()).toEqual({ goal: null });
  });
});
