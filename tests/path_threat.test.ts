/**
 * 走路前的路线威胁评估（Lead 2026-10-21）：A 血 10.6、496 件（含钻石镐），`useEntity` 直线
 * 穿过三只苦力怕去开箱子矿车 ⇒ 被炸死全丢。威胁不在目的地，而在**路上**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  distanceToSegment,
  LOW_HEALTH_FOR_CREEPER,
  planRouteThreatResponse,
  threatsNearRoute,
} from '../src/body/safety/path_threat.js';

const from = { x: 0, z: 0 };
const to = { x: 20, z: 0 };

describe('路线旁威胁：算的是"离线段多远"，不是"离终点多远"', () => {
  it('离线 2 格的苦力怕算在路上（即使它在路线中段、离终点很远）', () => {
    const near = threatsNearRoute({ from, to, hostiles: [{ name: 'creeper', x: 10, z: 2 }] });
    expect(near).toHaveLength(1);
    expect(near[0]!.offRoute).toBeCloseTo(2);
  });
  it('离线 20 格的（终点附近的）不算', () => {
    expect(threatsNearRoute({ from, to, hostiles: [{ name: 'zombie', x: 20, z: 20 }] })).toHaveLength(0);
  });
  it('点在端点外时按端点距离（不会把"更远"算近）', () => {
    expect(distanceToSegment({ x: -5, z: 0 }, from, to)).toBeCloseTo(5);
  });
});

describe('planRouteThreatResponse：低血 + 苦力怕 ⇒ 不直走，给三个选项', () => {
  it('真机情形（血 10.6 + 三只苦力怕）⇒ proceed=false，回执含数量/位置/回血/绕路/放弃', () => {
    const threats = threatsNearRoute({
      from,
      to,
      hostiles: [
        { name: 'creeper', x: 6, z: 3 },
        { name: 'creeper', x: 10, z: -2 },
        { name: 'creeper', x: 15, z: 1 },
      ],
    });
    const verdict = planRouteThreatResponse({ health: 10.6, threats, from, to });
    expect(verdict.proceed).toBe(false);
    expect(verdict.creepersOnRoute).toBe(3);
    expect(verdict.message).toContain('三只苦力怕'.slice(0, 1)); // 中文数字由模板给出
    expect(verdict.message).toContain('苦力怕');
    expect(verdict.message).toContain('血只有 10.6');
    expect(verdict.message).toContain('先回血');
    expect(verdict.message).toContain('绕开');
    expect(verdict.message).toContain('放弃');
  });
  it('血正常（>14）⇒ 允许通过（不制造新墙）', () => {
    const threats = threatsNearRoute({ from, to, hostiles: [{ name: 'creeper', x: 10, z: 2 }] });
    expect(planRouteThreatResponse({ health: 20, threats, from, to }).proceed).toBe(true);
    expect(LOW_HEALTH_FOR_CREEPER).toBeGreaterThanOrEqual(14);
  });
  it('低血但只有僵尸（不是苦力怕）⇒ 允许（僵尸可以跑，苦力怕一击毙命）', () => {
    const threats = threatsNearRoute({ from, to, hostiles: [{ name: 'zombie', x: 10, z: 2 }] });
    expect(planRouteThreatResponse({ health: 8, threats, from, to }).proceed).toBe(true);
  });
});

describe('接线守卫：useEntity 走路之前评估', () => {
  it('在 goToPosition 之前调用 threatsNearRoute + planRouteThreatResponse，并且拒绝时直接返回不走路', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
    const routeCheck = code.indexOf('threatsNearRoute({ from, to, hostiles })');
    const walk = code.indexOf('await skills.goToPosition(', code.indexOf("name: '!useEntity'"));
    expect(routeCheck).toBeGreaterThan(-1);
    expect(routeCheck).toBeLessThan(walk);
    expect(code).toContain('if (!verdict.proceed) {');
  });
});
