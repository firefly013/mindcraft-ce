/**
 * 两个独立开关的契约：闸门许可（permits）与保命开关（safeguards）。
 *
 * 它们**必须分开** —— 一个是"不拦你做危险动作"，一个是"不救你"。原来这两件事
 * 耦合在一张 permit 上（拿到危险操作授权就顺手关了保命），于是"我想自己承担风险"
 * 这个语义根本表达不出来。
 *
 * 次数制是这一轮的重点：失败也要扣额度，这样模型中途失手时保命会立刻回来。
 */
import { describe, expect, it } from 'vitest';
import { createPermits } from '../src/agent/permits.js';
import { createSafeguards } from '../src/agent/safeguards.js';

const T0 = 1_700_000_000_000;
const dry = { dimension: 'overworld', onFire: false };

describe('次数制授权', () => {
  it('按次数授权：放行，消耗一次后还有，耗尽立刻恢复禁止', () => {
    const p = createPermits();
    p.grantCalls(['enter_deep_water'], 3, '水底挖洞', T0);
    expect(p.isAllowed('enter_deep_water', dry, T0).allowed).toBe(true);
    expect(p.consumeCall(T0)).toBe(false); // 还有 2
    expect(p.isAllowed('enter_deep_water', dry, T0).allowed).toBe(true);
    expect(p.consumeCall(T0)).toBe(false); // 还有 1
    expect(p.isAllowed('enter_deep_water', dry, T0).allowed).toBe(true);
    expect(p.consumeCall(T0)).toBe(true); // 用尽
    expect(p.isAllowed('enter_deep_water', dry, T0).allowed).toBe(false);
  });

  it('次数制没有时间限制：过很久也还在（这是它跟时间制的根本差别）', () => {
    const p = createPermits();
    p.grantCalls(null, 1, 'x', T0);
    expect(p.isAllowed('pour_water', dry, T0 + 365 * 24 * 3600_000).allowed).toBe(true);
  });

  it('时间制不被 consumeCall 影响', () => {
    const p = createPermits();
    p.grant(null, 5, 'x', T0);
    expect(p.consumeCall(T0)).toBe(false);
    expect(p.consumeCall(T0)).toBe(false);
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(true);
  });

  it('次数制只覆盖被点名的操作', () => {
    const p = createPermits();
    p.grantCalls(['enter_deep_water'], 3, 'x', T0);
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(false);
    expect(p.isAllowed('enter_deep_water', dry, T0).allowed).toBe(true);
  });

  it('revoke 立刻收回次数额度', () => {
    const p = createPermits();
    p.grantCalls(null, 5, 'x', T0);
    p.revoke();
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(false);
  });

  it('describe 说清是"几次"而不是"几秒"', () => {
    const p = createPermits();
    p.grantCalls(['ignite'], 4, '点地狱门', T0);
    const text = p.describe(T0);
    expect(text).toContain('ignite');
    expect(text).toContain('4 次');
    expect(text).toContain('点地狱门');
  });

  it('次数制过期（被 revoke 或用尽）后 describe 回到默认', () => {
    const p = createPermits();
    p.grantCalls(null, 1, 'x', T0);
    p.consumeCall(T0);
    expect(p.describe(T0)).toContain('没有任何授权');
  });

  it('0 或负数会被兜成 1 次（不给"申请 0 次就等于关闸门"这种玩法）', () => {
    const p = createPermits();
    p.grantCalls(null, 0, 'x', T0);
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(true);
    expect(p.consumeCall(T0)).toBe(true);
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(false);
  });
});

describe('保命开关', () => {
  it('默认是开的', () => {
    const s = createSafeguards();
    expect(s.isSuppressed(T0)).toBe(false);
    expect(s.describe(T0)).toContain('正常');
  });

  it('按时间关闭，到点自动恢复', () => {
    const s = createSafeguards();
    s.suppressFor(2, '水底挖洞', T0);
    expect(s.isSuppressed(T0)).toBe(true);
    expect(s.isSuppressed(T0 + 2 * 60_000)).toBe(false);
  });

  it('按次数关闭，用完立刻恢复', () => {
    const s = createSafeguards();
    s.suppressCalls(2, '水底挖洞', T0);
    expect(s.isSuppressed(T0)).toBe(true);
    s.consumeCall(T0);
    expect(s.isSuppressed(T0)).toBe(true);
    expect(s.consumeCall(T0)).toBe(true);
    expect(s.isSuppressed(T0)).toBe(false);
  });

  it('时间制不被 consumeCall 影响', () => {
    const s = createSafeguards();
    s.suppressFor(5, 'x', T0);
    s.consumeCall(T0);
    s.consumeCall(T0);
    expect(s.isSuppressed(T0)).toBe(true);
  });

  it('release 立刻恢复', () => {
    const s = createSafeguards();
    s.suppressFor(60, 'x', T0);
    s.release();
    expect(s.isSuppressed(T0)).toBe(false);
  });

  it('describe 说清代价（出事没人救），模型得知道自己签了什么', () => {
    const s = createSafeguards();
    s.suppressCalls(3, '挖洞留空气', T0);
    const text = s.describe(T0);
    expect(text).toContain('已关闭');
    expect(text).toContain('3 次');
    expect(text).toContain('出事没人救');
  });
});

describe('一键恢复两层保护', () => {
  it('revokeAll 把授权和内部豁免票一起清干净', () => {
    const p = createPermits();
    p.grantCalls(null, 5, 'x', T0);
    p.bypassFor('enter_deep_water', 30_000, 'forceExitWater', T0);
    expect(p.isAllowed('enter_deep_water', dry, T0).why).toBe('bypass');

    p.revokeAll();

    // 授权没了，内部豁免票也该没了 —— 否则"立刻恢复"里有残留。
    expect(p.isAllowed('enter_deep_water', dry, T0).allowed).toBe(false);
    expect(p.describe(T0)).toContain('没有任何授权');
    expect(p.describe(T0)).not.toContain('内部豁免');
  });

  it('只 revoke 不清 bypass（那是"你不再被特别批准"，不是"清场"）', () => {
    const p = createPermits();
    p.grant(null, 5, 'x', T0);
    p.bypassFor('enter_deep_water', 30_000, '保命', T0);
    p.revoke();
    // 模型授权确实收了，但保命代码自己发的短票还在 —— 此刻正在救命的动作不该被误伤。
    expect(p.isAllowed('enter_deep_water', dry, T0).why).toBe('bypass');
  });
});