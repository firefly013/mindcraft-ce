/**
 * 走路前的走廊威胁评估（2026-10-21 事故）：A 血 10.6、496 件（含钻石镐），`useEntity` 直线
 * 穿过三只苦力怕去开箱子矿车 ⇒ 被炸死全丢。威胁不在目的地，而在**路上**。
 *
 * 2026-10-30 修正：判据是"直线走廊"，不是"实际路线"——所以只在苦力怕几乎压线时才否决。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CORRIDOR_BLOCK_RADIUS,
  CORRIDOR_WARN_RADIUS,
  LOW_HEALTH_FOR_CREEPER,
  corridorThreatVerdict,
  distanceToSegment,
  threatsNearCorridor,
} from '../src/body/safety/path_threat.js';

const from = { x: 0, z: 0 };
const to = { x: 20, z: 0 };

describe('走廊威胁：算的是"离直线多远"，不是"离终点多远"', () => {
  it('离线 2 格的苦力怕算在走廊里（即使它在路线中段、离终点很远）', () => {
    const near = threatsNearCorridor({ from, to, hostiles: [{ name: 'creeper', x: 10, z: 2 }] });
    expect(near).toHaveLength(1);
    expect(near[0]!.offLine).toBeCloseTo(2);
  });
  it('离线 20 格的（终点附近的）不算', () => {
    expect(threatsNearCorridor({ from, to, hostiles: [{ name: 'zombie', x: 20, z: 20 }] })).toHaveLength(0);
  });
  it('点在端点外时按端点距离（不会把"更远"算近）', () => {
    expect(distanceToSegment({ x: -5, z: 0 }, from, to)).toBeCloseTo(5);
  });
});

describe('corridorThreatVerdict：只在"低血 + 几乎压线"时否决', () => {
  it('真机情形（血 10.6 + 一只离线 1 格）⇒ proceed=false，回执是事实 + 一条出口', () => {
    const threats = threatsNearCorridor({ from, to, hostiles: [{ name: 'creeper', x: 10, z: 1 }] });
    const verdict = corridorThreatVerdict({ health: 10.6, threats, from, to });

    expect(verdict.proceed).toBe(false);
    expect(verdict.creepersNear).toBe(1);
    // 事实：位置、离线距离、血量
    expect(verdict.message).toContain('creeper@(10, 1)');
    expect(verdict.message).toContain('离直线 1.0 格');
    expect(verdict.message).toContain('你血 10.6');
    // 不许再声称"这条路"——那是几何谎言
    expect(verdict.message).not.toContain('这条路我不直走');
    expect(verdict.message).toContain('直线');
    // 一条可执行的出口，不是三选一菜单
    expect(verdict.message).toContain('goToCoordinates');
    expect(verdict.message).not.toContain('①');
    expect(verdict.message).not.toContain('放弃');
  });

  it('低血但苦力怕离线 5 格 ⇒ **放行**（旧行为在 6 格就拦，会拦掉安全的绕路）', () => {
    const threats = threatsNearCorridor({ from, to, hostiles: [{ name: 'creeper', x: 10, z: 5 }] });
    const verdict = corridorThreatVerdict({ health: 10.6, threats, from, to });

    expect(verdict.proceed).toBe(true);
    // 但事实照写：模型有权知道
    expect(verdict.message).toContain('creeper@(10, 5)');
    expect(verdict.message).toContain('不是你实际会走的路线');
  });

  it('血正常（>14）⇒ 放行且不出声（不制造新墙）', () => {
    const threats = threatsNearCorridor({ from, to, hostiles: [{ name: 'creeper', x: 10, z: 2 }] });
    const verdict = corridorThreatVerdict({ health: 20, threats, from, to });

    expect(verdict.proceed).toBe(true);
    expect(verdict.message).toBe('');
    expect(LOW_HEALTH_FOR_CREEPER).toBeGreaterThanOrEqual(14);
  });

  it('低血但只有僵尸（不是苦力怕）⇒ 放行（僵尸可以跑，苦力怕一击毙命）', () => {
    const threats = threatsNearCorridor({ from, to, hostiles: [{ name: 'zombie', x: 10, z: 2 }] });
    const verdict = corridorThreatVerdict({ health: 8, threats, from, to });

    expect(verdict.proceed).toBe(true);
    expect(verdict.message).toBe('');
  });

  it('血读不到（null）⇒ 放行（读不到不封路）', () => {
    const threats = threatsNearCorridor({ from, to, hostiles: [{ name: 'creeper', x: 10, z: 1 }] });
    expect(corridorThreatVerdict({ health: null, threats, from, to }).proceed).toBe(true);
  });

  it('两个半径的关系：否决半径必须小于陈述半径，否则"放行+提醒"这条分支永远走不到', () => {
    expect(CORRIDOR_BLOCK_RADIUS).toBeLessThan(CORRIDOR_WARN_RADIUS);
  });
});

describe('接线守卫：useEntity 走路之前评估', () => {
  it('在 goToPosition 之前调用，并且否决时直接返回不走路', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
    const routeCheck = code.indexOf('threatsNearCorridor({ from, to, hostiles })');
    const walk = code.indexOf('await skills.goToPosition(', code.indexOf("name: '!useEntity'"));
    expect(routeCheck).toBeGreaterThan(-1);
    expect(routeCheck).toBeLessThan(walk);
    expect(code).toContain('if (!verdict.proceed) return renderReport(lines);');
  });
});
