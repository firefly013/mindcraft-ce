/**
 * 苦力怕反射（Lead 2026-10-21，用户 spec）：有盾举盾、没盾跑；身体层反射不是工具/门；
 * 只报实测事实，没有证据不许说"躲过了"。
 */
import { describe, expect, it } from 'vitest';
import {
  CREEPER_ALERT_RANGE,
  planThreatResponse,
  SKELETON_ALERT_RANGE,
  SKELETON_LOW_HEALTH,
  ZOMBIE_ALERT_RANGE,
  ZOMBIE_LOW_HEALTH,
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
  it('(a2) 8 格就触发（举盾要早于危险距离）', () => {
    expect(planCreeperResponse({ ...base, hasShield: true, creepers: near(7.5) }).action).toBe('block');
    expect(planCreeperResponse({ ...base, creepers: near(7.5) }, { x: 7.5, z: 0 }).action).toBe('run');
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
    expect(CREEPER_ALERT_RANGE).toBe(8); // 真机调参：3.9 格举盾太晚（掉血 1.8）
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

// ─────────────────── 威胁分类：骷髅/僵尸也走同一个反射（Lead 2026-10-21 真机死因） ───────────────────

describe('威胁分类：健康门槛 + 类别触发', () => {
  const base2 = { hasShield: false, sheltered: false, cooldownActive: false, otherReflexActive: false };
  const threat = (threatClass: any, distance: number) => ({
    name: threatClass,
    distance,
    prevDistance: null,
    threatClass,
    position: { x: distance, z: 0 },
  });

  it('(a) 骷髅 11 格 + 血 12 ⇒ cover（找掩体），回执点名类别+距离+血', () => {
    const plan = planThreatResponse({ ...base2, health: 12, hostiles: [threat('skeleton', 11)] });
    expect(plan.action).toBe('cover');
    expect(plan.threatClass).toBe('skeleton');
    expect(plan.reason).toContain('骷髅 11.0 格');
    expect(plan.reason).toContain('血 12');
    expect(plan.reason).toContain('掩体');
  });
  it('(b) 骷髅 11 格 + 血 20 ⇒ 不动（满血不制造噪音）', () => {
    expect(planThreatResponse({ ...base2, health: 20, hostiles: [threat('skeleton', 11)] }).action).toBe('none');
  });
  it('(c) 僵尸 4 格 + 血 8 ⇒ 跑（不近战）', () => {
    const plan = planThreatResponse({ ...base2, health: 8, hostiles: [threat('zombie', 4)] }, { x: 0, z: 0 });
    expect(plan.action).toBe('run');
    expect(plan.threatClass).toBe('zombie');
    expect(plan.away?.x).toBeLessThan(-0.9);
  });
  it('(d) 僵尸 4 格 + 血 20 ⇒ 不动', () => {
    expect(planThreatResponse({ ...base2, health: 20, hostiles: [threat('zombie', 4)] }).action).toBe('none');
  });
  it('(e) 苦力怕行为不变：8 格内有盾举盾、没盾跑（与血量无关）', () => {
    expect(planThreatResponse({ ...base2, health: 20, hasShield: true, hostiles: [threat('creeper', 7)] }).action).toBe('block');
    expect(planThreatResponse({ ...base2, health: 3, hostiles: [threat('creeper', 7)] }).action).toBe('run');
  });
  it('(f) 让位优先：更高优先级反射占用身体 ⇒ yield（不抢）', () => {
    expect(planThreatResponse({ ...base2, health: 5, otherReflexActive: true, hostiles: [threat('skeleton', 6)] }).action).toBe('yield');
  });
  it('骷髅 cover 回执：没掉血才说"这一轮没再中箭"，掉血就说被射中', () => {
    const safe = formatCreeperReflexReceipt({
      action: 'cover', threatClass: 'skeleton', outcome: 'ran', distance: 11, healthBefore: 12, healthAfter: 12,
    });
    expect(safe).toContain('骷髅 11.0 格');
    expect(safe).toContain('这一轮没再中箭');
    expect(safe).not.toContain('躲过了');
    const hit = formatCreeperReflexReceipt({
      action: 'cover', threatClass: 'skeleton', outcome: 'tookDamage', distance: 11, healthBefore: 12, healthAfter: 7,
    });
    expect(hit).toContain('中箭掉血 5');
    expect(hit).not.toContain('这一轮没再中箭');
  });
});
