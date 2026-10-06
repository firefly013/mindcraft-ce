/**
 * 自动拾取契约：只认地上的掉落物（`name === 'item'`）、只在半径内、
 * 只挑最近的；读不到实体表就安静地什么都不做。
 */
import { describe, expect, it } from 'vitest';
import { nearestDropWithin, shouldAttemptPickup, PICKUP_INTERVAL_MS, PICKUP_RADIUS } from '../src/agent/auto_pickup.js';

function botWith(entities: Array<Record<string, unknown>>, self = { x: 0, y: 64, z: 0 }): unknown {
  const map: Record<string, unknown> = { self: { id: 99, name: 'player', position: self } };
  entities.forEach((e, i) => {
    map[`e${i}`] = e;
  });
  return { entity: { id: 99, position: self }, entities: map };
}

const drop = (id: number, x: number, y: number, z: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  name: 'item',
  position: { x, y, z },
  ...extra,
});

describe('shouldAttemptPickup', () => {
  const base = { pickingUp: false, busy: false, sinceLastAttemptMs: 5000 };

  it('goes for it only when idle and cooled down', () => {
    expect(shouldAttemptPickup(base)).toBe(true);
    // 通道被模型占着：等下一轮。
    expect(shouldAttemptPickup({ ...base, busy: true })).toBe(false);
    // 上一次还没收尾：不重叠。
    expect(shouldAttemptPickup({ ...base, pickingUp: true })).toBe(false);
    // 冷却没到。
    expect(shouldAttemptPickup({ ...base, sinceLastAttemptMs: PICKUP_INTERVAL_MS - 1 })).toBe(false);
    expect(shouldAttemptPickup({ ...base, sinceLastAttemptMs: PICKUP_INTERVAL_MS })).toBe(true);
  });
});

describe('nearestDropWithin', () => {
  it('picks the nearest dropped item and reports the distance', () => {
    const bot = botWith([drop(1, 5, 64, 0), drop(2, 2, 64, 0, { displayName: 'oak_log' })]);
    const target = nearestDropWithin(bot, PICKUP_RADIUS);
    expect(target?.id).toBe(2);
    expect(target?.name).toBe('oak_log');
    expect(target?.distance).toBeCloseTo(2);
  });

  it('ignores everything that is not a dropped item', () => {
    // 玩家/怪物/船/经验球都不该让 bot 走过去。
    const bot = botWith([
      { id: 1, name: 'zombie', position: { x: 1, y: 64, z: 0 } },
      { id: 2, name: 'player', position: { x: 1, y: 64, z: 0 } },
      { id: 3, name: 'boat', position: { x: 1, y: 64, z: 0 } },
      { id: 4, name: 'xp_orb', position: { x: 1, y: 64, z: 0 } },
    ]);
    expect(nearestDropWithin(bot, PICKUP_RADIUS)).toBeNull();
  });

  it('keeps the closest when a farther drop shows up later', () => {
    const bot = botWith([
      drop(1, 1, 64, 0, { displayName: 'near' }),
      drop(2, 6, 64, 0, { displayName: 'far' }),
    ]);
    expect(nearestDropWithin(bot, PICKUP_RADIUS)?.name).toBe('near');
  });

  it('falls back to a generic name when the drop has no displayName', () => {
    const bot = botWith([drop(1, 2, 64, 0)]);
    expect(nearestDropWithin(bot, PICKUP_RADIUS)?.name).toBe('item');
  });

  it('ignores drops outside the radius', () => {
    const bot = botWith([drop(1, 40, 64, 0)]);
    expect(nearestDropWithin(bot, PICKUP_RADIUS)).toBeNull();
  });

  it('never throws on a broken/empty bot', () => {
    expect(nearestDropWithin(null, 8)).toBeNull();
    expect(nearestDropWithin({}, 8)).toBeNull();
    expect(nearestDropWithin({ entity: { id: 1 } }, 8)).toBeNull();
    // 有自身位置、但没有实体表：安静返回 null。
    expect(nearestDropWithin({ entity: { id: 1, position: { x: 0, y: 0, z: 0 } } }, 8)).toBeNull();
    expect(nearestDropWithin({ entity: { id: 1, position: {} }, entities: {} }, 8)).toBeNull();
    expect(
      nearestDropWithin({ entity: { id: 1, position: { x: 0, y: 0, z: 0 } }, entities: { a: drop(2, NaN, 0, 0) } }, 8),
    ).toBeNull();
  });
});
