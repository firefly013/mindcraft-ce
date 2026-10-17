/**
 * task-40：逃跑落点必须避开 lava/水/落差，优先实心支撑。
 */
import { describe, expect, it } from 'vitest';
import { assessStandingSpot, chooseSafeFleeTarget } from '../src/body/safety/flee.js';

function accessor(overrides: Record<string, string> = {}) {
  return (x: number, y: number, z: number): { name: string } | null => {
    const key = x + ',' + y + ',' + z;
    if (overrides[key] != null) return { name: overrides[key] };
    if (y === -1) return { name: 'stone' };
    return { name: 'air' };
  };
}

describe('assessStandingSpot', () => {
  it('脚/头空气 + 脚下实心：安全', () => {
    expect(assessStandingSpot(accessor(), 0, 0, 0)).toEqual({ ok: true, reason: 'ok' });
  });

  it('脚下是 lava / 水 / 空：不安全', () => {
    expect(assessStandingSpot(accessor({ '0,0,0': 'lava' }), 0, 0, 0).ok).toBe(false);
    expect(assessStandingSpot(accessor({ '0,0,0': 'water' }), 0, 0, 0).ok).toBe(false);
    const noSupport = accessor({ '0,-1,0': 'air' });
    expect(assessStandingSpot(noSupport, 0, 0, 0).ok).toBe(false);
  });

  it('脚下是岩浆/水支撑：不安全', () => {
    expect(assessStandingSpot(accessor({ '0,-1,0': 'lava' }), 0, 0, 0).ok).toBe(false);
    expect(assessStandingSpot(accessor({ '0,-1,0': 'water' }), 0, 0, 0).ok).toBe(false);
  });
});

describe('chooseSafeFleeTarget', () => {
  it('远离威胁的方向是 safe 岸：选它，不选岩浆方向', () => {
    const blockAt = accessor({ '5,0,0': 'lava', '5,-1,0': 'air' });
    const result = chooseSafeFleeTarget(blockAt, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.x).toBeLessThan(0);
    expect(assessStandingSpot(blockAt, result.target.x, result.target.y, result.target.z).ok).toBe(true);
  });

  it('四周都是岩浆/无支撑：明确返回没有安全落点', () => {
    const blockAt = (x: number, y: number, z: number): { name: string } | null => {
      if (y === 0) return { name: 'lava' };
      if (y === -1) return { name: 'air' };
      return { name: 'air' };
    };
    const result = chooseSafeFleeTarget(blockAt, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('没有');
  });
});
