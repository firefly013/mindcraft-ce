/**
 * 下坠恢复：**介质决定档位**（Lead 2026-10-19 裁定）。
 *
 * 真机 overnight_b：从 y≈79 自由落体进 y≈25 的岩浆烧死，x/z 一格没动——刹车生效了，
 * 但"下方是岩浆"时刹车就是死刑。末地那套"横移会走进虚空"的判据不能套到岩浆上。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isLethalDestination,
  planFallRecovery,
  readFallMedium,
  shouldEmitFallNotice,
} from '../src/body/safety/fall_recovery.js';

const col = (table: Record<number, string>) => (x: number, y: number, z: number) => {
  void x;
  void z;
  return { name: table[y] ?? 'air' };
};

describe('readFallMedium：只看介质', () => {
  it('脚下一路空气 ⇒ void；读到岩浆/水 ⇒ lava/water；先遇到实心 ⇒ solid', () => {
    expect(readFallMedium(col({}), { x: 0, y: 64, z: 0 }).medium).toBe('void');
    expect(readFallMedium(col({ 60: 'lava' }), { x: 0, y: 64, z: 0 })).toMatchObject({ medium: 'lava', atY: 60 });
    expect(readFallMedium(col({ 61: 'water' }), { x: 0, y: 64, z: 0 })).toMatchObject({ medium: 'water', atY: 61 });
    expect(readFallMedium(col({ 59: 'stone' }), { x: 0, y: 64, z: 0 })).toMatchObject({ medium: 'solid', atY: 59 });
  });

  it('探测窗口内**先遇到流体**就报流体（岩浆在石头上面 ⇒ lava，不是 solid）', () => {
    expect(readFallMedium(col({ 62: 'lava', 60: 'stone' }), { x: 0, y: 64, z: 0 }).medium).toBe('lava');
  });

  it('读不到（blockAt 返 null）⇒ unknown，不是 void（不许猜"大概是虚空"）', () => {
    const medium = readFallMedium(() => null, { x: 0, y: 64, z: 0 });
    expect(medium.medium).toBe('unknown');
  });
});

describe('planFallRecovery：岩浆/水要试，虚空/读不到要保守', () => {
  const base = {
    feet: { x: 0, y: 64, z: 0 },
    medium: 'lava' as const,
    mediumAtY: 25,
    mediumName: 'lava',
    onSolidGround: false,
    safeLanding: { x: 3, y: 64, z: 0 },
    hasWaterBucket: false,
    dropDistance: 39,
  };

  it('下方岩浆 + 3 格外有安全落点 ⇒ **横移**（不是虚空那套刹车），回执带证据', () => {
    const plan = planFallRecovery(base);
    expect(plan.rung).toBe('lateral');
    expect(plan.target).toMatchObject({ x: 3, y: 64, z: 0 });
    expect(plan.text).toContain('岩浆');
    expect(plan.text).toContain('y=25');
    expect(plan.text).toContain('横移');
  });

  it('下方虚空 ⇒ 只刹车、不横移（末地那四条命的规则不许被削弱）', () => {
    const plan = planFallRecovery({ ...base, medium: 'void', mediumAtY: null, mediumName: null, safeLanding: { x: 3, y: 64, z: 0 } });
    expect(plan.rung).toBe('brake');
    expect(plan.target).toBeNull();
    expect(plan.text).toContain('虚空');
  });

  it('介质读不到 ⇒ 保守只刹车（猜"大概是水"会杀人）', () => {
    const plan = planFallRecovery({ ...base, medium: 'unknown', mediumAtY: null, mediumName: null });
    expect(plan.rung).toBe('brake');
    expect(plan.text).toContain('读不到');
    expect(plan.text).toContain('保守');
  });

  it('岩浆 + 没有安全落点 + 没桶 ⇒ 刹车 + 诚实说"试过了、确实没有可落脚处"', () => {
    const plan = planFallRecovery({ ...base, safeLanding: null, hasWaterBucket: false, dropDistance: 39 });
    expect(plan.rung).toBe('brake');
    expect(plan.text).toContain('没有可落脚的安全点');
    expect(plan.text).toContain('没有水桶');
    expect(plan.text).toContain('已经试过');
  });

  it('岩浆 + 没落点 + 有桶 + 还有高度 ⇒ 水桶 MLG 档', () => {
    const plan = planFallRecovery({ ...base, safeLanding: null, hasWaterBucket: true, dropDistance: 20 });
    expect(plan.rung).toBe('mlg');
    expect(plan.text).toContain('水桶');
  });

  it('水下方同样按介质走（水不等于虚空）', () => {
    const plan = planFallRecovery({ ...base, medium: 'water', mediumName: 'water', mediumAtY: 30 });
    expect(plan.rung).toBe('lateral');
    expect(plan.text).toContain('水');
  });

  it('已经站在实地上 ⇒ 这条永不触发（哪怕介质是岩浆）', () => {
    const plan = planFallRecovery({ ...base, onSolidGround: true });
    expect(plan.rung).toBe('brake');
    expect(plan.target).toBeNull();
    expect(plan.text).toContain('不触发');
  });
});

describe('目标格守卫：不许朝致死格移动', () => {
  it('岩浆/虚空/流体目标 ⇒ 判为致死（不可作为落点）', () => {
    expect(isLethalDestination(col({ 64: 'lava' }), { x: 0, y: 64, z: 0 })).toBe(true);
    expect(isLethalDestination(col({}), { x: 0, y: 64, z: 0 })).toBe(true); // 没支撑
    expect(isLethalDestination(col({ 63: 'stone' }), { x: 0, y: 64, z: 0 })).toBe(false);
  });
});

describe('同一条刹车回执不许每 tick 重播（真机审计：B 里 152 次、A 里 54 次）', () => {
  it('第一次一定说；同一状态 5 秒内不重复；5 秒后再说一次；状态变了立刻说', () => {
    const prev = { key: 'brake:void:-,-', at: 1_000 };
    expect(shouldEmitFallNotice(null, 'brake:void:-,-', 1_000)).toBe(true);
    expect(shouldEmitFallNotice(prev, 'brake:void:-,-', 2_000)).toBe(false);
    expect(shouldEmitFallNotice(prev, 'brake:void:-,-', 5_999)).toBe(false);
    expect(shouldEmitFallNotice(prev, 'brake:void:-,-', 6_000)).toBe(true);
    expect(shouldEmitFallNotice(prev, 'lateral:lava:3,0', 1_100)).toBe(true);
  });

  it('回执里带"第几次/已持续多久"，所以少说不等于丢掉信息', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain('第 ${this.fallBrakeNotices} 次刹车');
    expect(src).toContain('shouldEmitFallNotice(this.lastFallNotice');
  });
});
