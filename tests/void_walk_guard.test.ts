/**
 * void 预检（Lead 2026-10-19 ②-3）：走路工具拒绝"必须跨越无支撑空间"的目标，
 * 搭桥工具不受影响，空中不拦。边界写死，免得把 A 过末地缺口的搭桥也禁掉。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { voidWalkVerdict } from '../src/body/safety/void_walk.js';

/** 用简单的地面高度图造 blockAt：ground(x,z) 返回该列最高实心面的 y，null = 虚空。 */
const world = (ground: Record<string, number | null>) => (x: number, y: number, z: number) => {
  const key = `${x},${z}`;
  const top = ground[key];
  if (top === undefined || top === null) return { name: 'air' };
  return y <= top ? { name: 'stone' } : { name: 'air' };
};

const from = { x: 0.5, y: 66, z: 0.5 };

describe('voidWalkVerdict：走路 vs 搭桥', () => {
  it('目标脚下是虚空 ⇒ 拒绝，并点名**搭桥工具**作为替代', () => {
    const blockAt = world({ '0,0': 65, '5,0': null });
    const verdict = voidWalkVerdict({ tool: 'goToCoordinates', from, to: { x: 5.5, y: 66, z: 0.5 }, blockAt, airborne: false });
    expect(verdict.refuse).toBe(true);
    expect(String(verdict.text)).toContain('脚下没有方块');
    expect(String(verdict.text)).toContain('travelTo');
    expect(String(verdict.text)).toContain('placeBlock');
  });

  it('路径中间有缺口 ⇒ 拒绝（move 只会走、不会铺路）', () => {
    const blockAt = world({ '0,0': 65, '1,0': 65, '2,0': null, '3,0': 65 });
    const verdict = voidWalkVerdict({ tool: 'move', from, to: { x: 3.5, y: 66, z: 0.5 }, blockAt, airborne: false });
    expect(verdict.refuse).toBe(true);
  });

  it('普通目标（一路有地板）⇒ 放行，行为不变', () => {
    const blockAt = world({ '0,0': 65, '1,0': 65, '2,0': 65, '3,0': 65 });
    expect(voidWalkVerdict({ tool: 'goToCoordinates', from, to: { x: 3.5, y: 66, z: 0.5 }, blockAt, airborne: false }).refuse).toBe(false);
    expect(voidWalkVerdict({ tool: 'move', from, to: { x: 3.5, y: 66, z: 0.5 }, blockAt, airborne: false }).refuse).toBe(false);
  });

  it('**已经在空中 ⇒ 不拦**（那是保命反射的事，走路拒绝帮不上忙）', () => {
    const blockAt = world({ '0,0': 65, '5,0': null });
    expect(voidWalkVerdict({ tool: 'goToCoordinates', from, to: { x: 5.5, y: 66, z: 0.5 }, blockAt, airborne: true }).refuse).toBe(false);
  });

  it('**搭桥工具不受影响**（travelTo/placeBlock 才是过缺口的合法手段）', () => {
    const blockAt = world({ '0,0': 65, '5,0': null });
    for (const tool of ['travelTo', 'placeBlock', 'pillarUp', 'goToSurface']) {
      expect(voidWalkVerdict({ tool, from, to: { x: 5.5, y: 66, z: 0.5 }, blockAt, airborne: false }).refuse).toBe(false);
    }
  });

  it('接线：动作入口在出发检查之前调用，拒绝码为 REFUSED_VOID_WALK（源码守卫）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain('const voidRefusal = this.voidWalkRefusalFor(baseName, args);');
    expect(src).toContain('REFUSED_VOID_WALK');
    expect(src).toContain("if (name !== 'move' && name !== 'goToCoordinates') return null;");
  });
});
