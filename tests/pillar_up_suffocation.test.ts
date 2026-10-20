/**
 * `pillarUp` 把自己埋住 → 窒息死亡（真机 2026-10-21 overnight_a）：
 * y=51 竖井里 `pillarUp(14)`，方块进了身体，血 19→0，损失 82 件（Hard + keepInventory=false）。
 * 两条修复都要求"不用服务器就能测"：
 *  ① 放块前的**占位判定**（方块绝不能和身体 AABB 相交）；
 *  ② **窒息自救**（血在掉 + 脚/头格实心 ⇒ 就地挖开，而不是逃跑）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cellIntersectsBody,
  formatSuffocationReceipt,
  planSuffocationEscape,
  standingRoomOk,
} from '../src/body/safety/suffocation.js';

describe('cellIntersectsBody：放块前的硬前置', () => {
  it('脚下同一格 ⇒ true（放进身体里）', () => {
    expect(cellIntersectsBody({ x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 64, z: 0 })).toBe(true);
  });

  it('头那一格 ⇒ true；再上一格 ⇒ false', () => {
    expect(cellIntersectsBody({ x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 65, z: 0 })).toBe(true);
    expect(cellIntersectsBody({ x: 0.5, y: 64, z: 0.5 }, { x: 0, y: 66, z: 0 })).toBe(false);
  });

  it('旁边的格子 ⇒ false（正常垫脚要放的是脚下那格，跳起来后才不重叠）', () => {
    expect(cellIntersectsBody({ x: 0.5, y: 64, z: 0.5 }, { x: 2, y: 64, z: 0 })).toBe(false);
  });

  it('跳起来后（y 已高过格子顶）⇒ false，允许放', () => {
    expect(cellIntersectsBody({ x: 0.5, y: 65.2, z: 0.5 }, { x: 0, y: 64, z: 0 })).toBe(false);
  });

  it('读不到位置/格子 ⇒ null（不下结论）', () => {
    expect(cellIntersectsBody(null, { x: 0, y: 64, z: 0 })).toBeNull();
    expect(cellIntersectsBody({ x: 0.5, y: 64, z: 0.5 }, null)).toBeNull();
  });
});

describe('standingRoomOk：站进去前先看脚+头', () => {
  it('脚下实心 ⇒ false（不能站）；脚空头空 ⇒ true', () => {
    expect(standingRoomOk('stone', 'air')).toBe(false);
    expect(standingRoomOk('air', 'air')).toBe(true);
  });
  it('水里/岩浆不算实心但也不适合当陆地；读不到 ⇒ null', () => {
    expect(standingRoomOk('water', 'air')).toBe(true);
    expect(standingRoomOk(null, 'air')).toBeNull();
  });
});

describe('planSuffocationEscape：被埋住就挖开，不逃跑', () => {
  it('血在掉 + 脚格实心 ⇒ break-feet，并说清"脚那格是 stone"', () => {
    const plan = planSuffocationEscape({ healthDropped: true, feetBlock: 'stone', headBlock: 'air' });
    expect(plan.action).toBe('break-feet');
    expect(plan.reason).toContain('脚那格是 stone');
  });

  it('脚空、头格实心 ⇒ break-head', () => {
    expect(planSuffocationEscape({ healthDropped: true, feetBlock: 'air', headBlock: 'cobblestone' }).action).toBe('break-head');
  });

  it('血没在掉 ⇒ none（不许瞎挖）；都读不到 ⇒ none/unreadable', () => {
    expect(planSuffocationEscape({ healthDropped: false, feetBlock: 'stone', headBlock: 'stone' }).action).toBe('none');
    expect(planSuffocationEscape({ healthDropped: true, feetBlock: null, headBlock: null })).toMatchObject({
      action: 'none',
      reason: 'unreadable',
    });
  });

  it('两格都空（比如只是被怪打）⇒ none：这不该由窒息反射处理', () => {
    expect(planSuffocationEscape({ healthDropped: true, feetBlock: 'air', headBlock: 'air' }).reason).toBe('not-in-wall');
  });
});

describe('formatSuffocationReceipt：说清"我在方块里、哪一格、血在掉、在挖"', () => {
  it('挖开成功 ⇒ 告诉模型血应该会停 + 下一步自检', () => {
    const text = formatSuffocationReceipt({ position: { x: 12, y: 51, z: -3 }, which: '头', blockName: 'stone', health: 6, broke: true });
    expect(text).toContain('我在方块里');
    expect(text).toContain('头那格是 stone');
    expect(text).toContain('血在掉');
    expect(text).toContain('已经把那一格挖开了');
    expect(text).toContain('(12, 51, -3)');
  });

  it('挖开失败 ⇒ 明确要求 Stop + mineBlock，别继续垫/挤', () => {
    const text = formatSuffocationReceipt({ position: { x: 0, y: 0, z: 0 }, which: '脚', blockName: 'early', health: null, broke: false });
    expect(text).toContain('挖开失败');
    expect(text).toContain('Stop');
    expect(text).toContain('mineBlock');
    expect(text).toContain('别继续垫方块');
  });
});

describe('接线守卫：pillarUp 放块前判占位、身体有窒息反射', () => {
  const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');
  const body = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('pillarUp：跳跃后才检查占位；不通过就停止、不放置；放完再验，落进身体就挖掉', () => {
    const code = skills();
    expect(code).toContain('cellIntersectsBody(bot?.entity?.position, { x: startX, y: Math.floor(startY), z: startZ }) !== false');
    expect(code).toContain('仍与身体重叠（放进去会窒息）');
    expect(code).toContain('pillarUp 紧急自救');
    expect(code).toContain('已立刻挖掉');
  });

  it('身体 update() 每 tick 检查窒息自救，并且让位给反射/中断', () => {
    const code = body();
    expect(code).toContain('this.maybeSuffocationEscape();');
    expect(code).toContain('suffocation');
    expect(code).toContain('formatSuffocationReceipt(');
    expect(code).toContain('formatSuffocationReceipt(');
  });
});
