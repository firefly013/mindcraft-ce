/**
 * 苦力怕反射（Lead 2026-10-21，用户 spec）：有盾举盾、没盾跑；身体层反射不是工具/门；
 * 只报实测事实，没有证据不许说"躲过了"。
 */
import { describe, expect, it } from 'vitest';
import {
  CREEPER_ALERT_RANGE,
  CREEPER_REFLEX_COOLDOWN_MS,
  CREEPER_SAFE_DISTANCE,
  formatCreeperReflexReceipt,
  planCreeperResponse,
} from '../src/body/safety/creeper_reflex.js';

const base = { health: 20, hasShield: false, sheltered: false, cooldownActive: false, otherReflexActive: false };
const near = (distance: number, prev?: number | null) => [{ name: 'creeper', distance, prevDistance: prev ?? null }];

describe('触发条件', () => {
  it('(a) 逼近 + 有盾 ⇒ 举盾', () => {
    expect(planCreeperResponse({ ...base, hasShield: true, creepers: near(5) }).action).toBe('block');
  });
  it('(b) 逼近 + 没盾 ⇒ 跑', () => {
    const plan = planCreeperResponse({ ...base, creepers: near(4) }, { x: 4, z: 0 });
    expect(plan.action).toBe('run');
    expect(plan.away?.x).toBeLessThan(-0.9); // 远离 (4,0)
  });
  it('(c) 远处 / 正在远离 ⇒ 不触发', () => {
    expect(planCreeperResponse({ ...base, creepers: near(20) }).action).toBe('none');
    expect(planCreeperResponse({ ...base, creepers: near(5, 3) }).action).toBe('none'); // 距离变大
  });
  it('(d) 已躲在封闭空间/掩体 ⇒ 不触发', () => {
    expect(planCreeperResponse({ ...base, sheltered: true, creepers: near(3) }).action).toBe('none');
  });
  it('(e) 冷却中不再触发（防抖）', () => {
    expect(planCreeperResponse({ ...base, cooldownActive: true, creepers: near(3) }).action).toBe('none');
    expect(CREEPER_REFLEX_COOLDOWN_MS).toBeGreaterThanOrEqual(1000);
  });
  it('(f) 死亡恢复/重生循环占用身体 ⇒ 让位（不抢身体）', () => {
    expect(planCreeperResponse({ ...base, otherReflexActive: true, creepers: near(3) }).action).toBe('yield');
  });
  it('范围常量符合契约', () => {
    expect(CREEPER_ALERT_RANGE).toBe(6);
    expect(CREEPER_SAFE_DISTANCE).toBeGreaterThanOrEqual(10);
  });
});

describe('事实回执：不许无证据说"躲过了"', () => {
  it('(a) 举盾且掉血 0 ⇒ 说举盾挡住（掉血 0）', () => {
    const text = formatCreeperReflexReceipt({ action: 'block', outcome: 'blocked', distance: 3.2, healthBefore: 20, healthAfter: 20 });
    expect(text).toContain('举盾挡住');
    expect(text).toContain('掉血 0');
    expect(text).not.toContain('躲过了');
  });
  it('(b) 跑了 N 格 ⇒ 只报实测距离，不说躲过', () => {
    const text = formatCreeperReflexReceipt({ action: 'run', outcome: 'ran', distance: 4, healthBefore: 20, healthAfter: 20, ranBlocks: 8, steps: 6 });
    expect(text).toContain('跑了 8 格');
    expect(text).not.toContain('躲过了');
    expect(text).not.toContain('没受伤'); // 未观测到就不能断言
  });
  it('(g) 吃伤害 ⇒ 回执说被炸/掉血，不说挡住', () => {
    const text = formatCreeperReflexReceipt({ action: 'block', outcome: 'tooLate', distance: 2, healthBefore: 20, healthAfter: 14 });
    expect(text).toContain('被炸了');
    expect(text).toContain('掉血 6');
    expect(text).not.toContain('挡住');
  });
  it('读不到血量 ⇒ 如实说读不到', () => {
    const text = formatCreeperReflexReceipt({ action: 'block', outcome: 'blocked', distance: 3, healthBefore: null, healthAfter: null });
    expect(text).toContain('读不到');
  });
});
