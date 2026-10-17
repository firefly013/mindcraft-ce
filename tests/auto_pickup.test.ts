/**
 * 自动拾取契约：只认地上的掉落物（`name === 'item'`）、只在半径内、
 * 只挑最近的；读不到实体表就安静地什么都不做。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  nearestDropWithin,
  markDiscarded,
  clearDiscards,
  isDiscardedDrop,
} from '../src/body/auto_pickup.js';
import {
  confirmedPickupGains,
  formatInventoryGains,
  itemNameMatches,
  nextPickupBackoffMs,
  positiveInventoryDelta,
  shouldAttemptPickup,
  DISCARD_IGNORE_MS,
  PICKUP_BACKOFF_MAX_MS,
  PICKUP_CONFIRM_DELAY_MS,
  PICKUP_INTERVAL_MS,
  PICKUP_RADIUS,
} from '../src/shared/auto_pickup.js';

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

beforeEach(() => {
  clearDiscards();
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
    // 失败退避期间：即使冷却到了也不许抢身体。
    expect(shouldAttemptPickup({ ...base, backoffRemainingMs: 5000 })).toBe(false);
  });

  it('失败退避指数增长并封顶，成功后归零', () => {
    expect(nextPickupBackoffMs(0)).toBe(0);
    expect(nextPickupBackoffMs(1)).toBeGreaterThanOrEqual(PICKUP_INTERVAL_MS);
    expect(nextPickupBackoffMs(2)).toBeGreaterThan(nextPickupBackoffMs(1));
    expect(nextPickupBackoffMs(99)).toBe(PICKUP_BACKOFF_MAX_MS);
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

describe('markDiscarded', () => {
  it('skips what the bot just threw away, then picks it again after the window', () => {
    const bot = botWith([drop(1, 1, 64, 0, { displayName: 'cobblestone' })]);
    // 没扔过：正常去捡。
    expect(nearestDropWithin(bot, 8)?.id).toBe(1);

    markDiscarded('cobblestone');
    expect(nearestDropWithin(bot, 8)).toBeNull();

    // 过了忽略窗口就重新可以捡——否则地上的东西永远收不回来。
    const realNow = Date.now;
    Date.now = (): number => realNow() + DISCARD_IGNORE_MS + 1_000;
    try {
      expect(nearestDropWithin(bot, 8)?.id).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('does not skip a different item', () => {
    clearDiscards(); // 免疫表跟着模块走，上面的用例扔过的名字别漏到这里
    markDiscarded('dirt');
    const bot = botWith([drop(2, 1, 64, 0, { displayName: 'cobblestone' })]);
    expect(nearestDropWithin(bot, 8)?.id).toBe(2);
  });

  it('isDiscardedDrop 按 id/displayName 归一化匹配，并在时间窗后失效', () => {
    expect(isDiscardedDrop('Oak Log')).toBe(false);
    markDiscarded('oak_log');
    expect(isDiscardedDrop('Oak Log')).toBe(true);
    expect(isDiscardedDrop('Dirt Block')).toBe(false);

    const realNow = Date.now;
    Date.now = (): number => realNow() + DISCARD_IGNORE_MS + 1_000;
    try {
      expect(isDiscardedDrop('Oak Log')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('拾取入包核验', () => {
  it('确认 200ms 核验窗口常量', () => {
    expect(PICKUP_CONFIRM_DELAY_MS).toBe(200);
  });

  it('after 相对 before 有正增量才算 gained', () => {
    expect(positiveInventoryDelta({}, { porkchop: 1 })).toEqual({ porkchop: 1 });
    expect(positiveInventoryDelta({ porkchop: 1 }, { porkchop: 1 })).toEqual({});
    expect(positiveInventoryDelta({ porkchop: 1 }, { porkchop: 3, dirt: 1 })).toEqual({ porkchop: 2, dirt: 1 });
  });

  it('读不到任一侧时不报 gained', () => {
    expect(positiveInventoryDelta(null, { porkchop: 1 })).toEqual({});
    expect(positiveInventoryDelta({ porkchop: 1 }, null)).toEqual({});
    expect(confirmedPickupGains(null, { porkchop: 1 }, 'porkchop')).toEqual({});
  });

  it('知道掉落物名时只认该物品，别处的增量不算捡到', () => {
    expect(confirmedPickupGains({}, { porkchop: 1 }, 'Porkchop')).toEqual({ porkchop: 1 });
    expect(confirmedPickupGains({}, { dirt: 1 }, 'Porkchop')).toEqual({});
    expect(confirmedPickupGains({ porkchop: 1 }, { porkchop: 2, dirt: 1 }, 'Porkchop')).toEqual({
      porkchop: 1,
    });
  });

  it('显示名带空格也能匹配物品 id', () => {
    expect(itemNameMatches('Oak Log', 'oak_log')).toBe(true);
    expect(itemNameMatches('Dirt Block', 'dirt')).toBe(true);
    expect(confirmedPickupGains({}, { oak_log: 1 }, 'Oak Log')).toEqual({ oak_log: 1 });
    expect(confirmedPickupGains({}, { cobblestone: 1 }, 'Oak Log')).toEqual({});
  });

  it('gained 渲染成模型能读的文本', () => {
    expect(formatInventoryGains({ porkchop: 1, oak_log: 2 })).toBe('porkchop×1、oak_log×2');
    expect(formatInventoryGains({})).toBe('');
  });
});

describe('丢弃免疫的命名归一化', () => {
  it('oak_log 免疫能挡住 Oak Log 掉落物', () => {
    const bot = botWith([drop(1, 1, 64, 0, { displayName: 'Oak Log' })]);
    markDiscarded('oak_log');
    expect(nearestDropWithin(bot, 8)).toBeNull();
  });

  it('dirt 免疫能挡住 Dirt Block 掉落物', () => {
    const bot = botWith([drop(2, 1, 64, 0, { displayName: 'Dirt Block' })]);
    markDiscarded('dirt');
    expect(nearestDropWithin(bot, 8)).toBeNull();
  });
});
