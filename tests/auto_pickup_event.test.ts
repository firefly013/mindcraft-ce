/**
 * task-42：playerCollect 只在校验到真实入包后才报 gained。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MineflayerBody,
  expectedItemNameFromEntity,
  nearbyOtherPlayerNames,
} from '../src/body/mineflayer_body.js';
import { clearDiscards, markDiscarded } from '../src/body/auto_pickup.js';
import { PICKUP_CONFIRM_DELAY_MS } from '../src/shared/auto_pickup.js';

beforeEach(() => {
  clearDiscards();
});

function fakeLogger(): any {
  return { with: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
}

function makeBody(
  items: () => Array<{ name: string; count: number }>,
  entities: Record<string, unknown> = {},
): any {
  const body: any = Object.create(MineflayerBody.prototype);
  body.bot = {
    entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
    inventory: { items },
    entities: {
      self: { id: 1, name: 'player', username: 'me', position: { x: 0, y: 64, z: 0 } },
      ...entities,
    },
  };
  body.log = fakeLogger();
  body.notify = vi.fn();
  body.lastCollectEmitAt = 0;
  return body;
}

function collectedEvent(name: string): { id: number; displayName: string } {
  return { id: 42, displayName: name };
}
describe('autoPickup 200ms 入包核验', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('200ms 后物品计数确实增加才报 gained', () => {
    let items: Array<{ name: string; count: number }> = [];
    const body = makeBody(() => items);
    body.handlePlayerCollect({ id: 1 }, collectedEvent('Porkchop'));
    items = [{ name: 'porkchop', count: 1 }];
    vi.advanceTimersByTime(PICKUP_CONFIRM_DELAY_MS);
    expect(body.notify).toHaveBeenCalledTimes(1);
    expect(body.notify).toHaveBeenCalledWith(
      'inventory.collected',
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({
        item: 'porkchop×1',
        gained: { porkchop: 1 },
        auto_pickup: true,
        expected_item: 'Porkchop',
      }),
    );
  });
  it('200ms 后没有增加就不报"捡到"', () => {
    const items: Array<{ name: string; count: number }> = [];
    const body = makeBody(() => items);
    body.handlePlayerCollect({ id: 1 }, collectedEvent('Porkchop'));
    vi.advanceTimersByTime(PICKUP_CONFIRM_DELAY_MS);
    expect(body.notify).not.toHaveBeenCalled();
  });
  it('增加的是别的东西也不算捡到 porkchop', () => {
    let items: Array<{ name: string; count: number }> = [];
    const body = makeBody(() => items);
    body.handlePlayerCollect({ id: 1 }, collectedEvent('Porkchop'));
    items = [{ name: 'dirt', count: 1 }];
    vi.advanceTimersByTime(PICKUP_CONFIRM_DELAY_MS);
    expect(body.notify).not.toHaveBeenCalled();
  });
  it('事件带 nearby_players 和"可能是队友掉落"提示', () => {
    let items: Array<{ name: string; count: number }> = [];
    const body = makeBody(() => items, {
      mate: { id: 2, name: 'player', username: 'overnight_b', position: { x: 1, y: 64, z: 0 } },
    });
    body.handlePlayerCollect({ id: 1 }, collectedEvent('Porkchop'));
    items = [{ name: 'porkchop', count: 1 }];
    vi.advanceTimersByTime(PICKUP_CONFIRM_DELAY_MS);
    const call = body.notify.mock.calls.find((c: unknown[]) => c[0] === 'inventory.collected');
    expect(call?.[3]).toMatchObject({ nearby_players: ['overnight_b'] });
    expect(String(call?.[3]?.hint)).toContain('可能是队友掉落');
  });
  it('collector 不是自己就忽略', () => {
    const items: Array<{ name: string; count: number }> = [{ name: 'porkchop', count: 1 }];
    const body = makeBody(() => items);
    body.handlePlayerCollect({ id: 99 }, collectedEvent('Porkchop'));
    vi.advanceTimersByTime(PICKUP_CONFIRM_DELAY_MS);
    expect(body.notify).not.toHaveBeenCalled();
  });
});
describe('附近玩家列表', () => {
  it('按距离排序、去重', () => {
    const bot = {
      entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
      entities: {
        self: { id: 1, name: 'player', username: 'me', position: { x: 0, y: 64, z: 0 } },
        far: { id: 3, name: 'player', username: 'far', position: { x: 5, y: 64, z: 0 } },
        near: { id: 2, name: 'player', username: 'near', position: { x: 1, y: 64, z: 0 } },
        duplicate: { id: 4, name: 'player', username: 'near', position: { x: 2, y: 64, z: 0 } },
      },
    };
    expect(nearbyOtherPlayerNames(bot, 8)).toEqual(['near', 'far']);
  });

  it('读不到自身位置或实体表时返回空数组', () => {
    expect(nearbyOtherPlayerNames(null)).toEqual([]);
    expect(nearbyOtherPlayerNames({ entity: { id: 1, position: {} }, entities: {} })).toEqual([]);
  });
});
describe('expectedItemNameFromEntity', () => {
  it('优先用 displayName，其次用 name，"item"不算物品名', () => {
    expect(expectedItemNameFromEntity({ displayName: 'Porkchop', name: 'item' })).toBe('Porkchop');
    expect(expectedItemNameFromEntity({ name: 'porkchop' })).toBe('porkchop');
    expect(expectedItemNameFromEntity({ name: 'item' })).toBeNull();
    expect(expectedItemNameFromEntity(null)).toBeNull();
  });
});
describe('模型动作抢占 autoPickup', () => {
  it('模型动作一到就调 pickupCancel，并等 pickup 收手后放行', async () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.pickingUp = true;
    body.requestInterrupt = vi.fn();
    body.pickupCancel = vi.fn(() => {
      body.pickingUp = false;
    });
    await body.yieldAutoPickupToModel();
    expect(body.pickupAbortRequested).toBe(true);
    expect(body.requestInterrupt).toHaveBeenCalledTimes(1);
    expect(body.pickupCancel).toHaveBeenCalledTimes(1);
    expect(body.pickingUp).toBe(false);
  });

  it('gotoPickupInterruptibly 注册 pickupCancel，调用后立即 stop 并释放', async () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.bot = {
      interrupt_code: false,
      pathfinder: { goto: vi.fn(() => new Promise<never>(() => {})), stop: vi.fn() },
    };
    body.pickupAbortRequested = false;
    const pending = body.gotoPickupInterruptibly({}, 12_000);
    expect(typeof body.pickupCancel).toBe('function');
    body.pickupCancel();
    await expect(pending).resolves.toBe(false);
    expect(body.bot.pathfinder.stop).toHaveBeenCalled();
    expect(body.pickupCancel).toBeNull();
  });

  it('pickupAbortRequested 时 50ms 内 stop pathfinder 并返回 false', async () => {
    vi.useFakeTimers();
    try {
      const body: any = Object.create(MineflayerBody.prototype);
      body.bot = {
        interrupt_code: false,
        pathfinder: { goto: vi.fn(() => new Promise<never>(() => {})), stop: vi.fn() },
      };
      body.pickupAbortRequested = false;
      const pending = body.gotoPickupInterruptibly({}, 12_000);
      await vi.advanceTimersByTimeAsync(60);
      body.pickupAbortRequested = true;
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBe(false);
      expect(body.bot.pathfinder.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('正常 goto 完成返回 true', async () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.bot = {
      interrupt_code: false,
      pathfinder: { goto: vi.fn(() => Promise.resolve()), stop: vi.fn() },
    };
    body.pickupAbortRequested = false;
    await expect(body.gotoPickupInterruptibly({}, 1_000)).resolves.toBe(true);
  });

  it('超时会 stop pathfinder 并返回 false', async () => {
    vi.useFakeTimers();
    try {
      const body: any = Object.create(MineflayerBody.prototype);
      body.bot = {
        interrupt_code: false,
        pathfinder: { goto: vi.fn(() => new Promise<never>(() => {})), stop: vi.fn() },
      };
      body.pickupAbortRequested = false;
      const pending = body.gotoPickupInterruptibly({}, 100);
      await vi.advanceTimersByTimeAsync(160);
      await expect(pending).resolves.toBe(false);
      expect(body.bot.pathfinder.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pickupAbortRequested 期间不启动新拾取', () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.pickupAbortRequested = true;
    body.pickingUp = false;
    body.pickupBackoffUntil = 0;
    body.lastPickupAt = 0;
    body.actions = { executing: false };
    body.modelActionRequested = false;
    body.schedulePickup({ id: 1, name: 'item', x: 0, y: 64, z: 0, distance: 1 });
    expect(body.pickingUp).toBe(false);
  });

  it('modelActionsInFlight > 0 时 pickup 不启动（覆盖重叠查询/动作）', () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.pickupAbortRequested = false;
    body.pickingUp = false;
    body.pickupBackoffUntil = 0;
    body.lastPickupAt = 0;
    body.actions = { executing: false };
    body.modelActionRequested = false;
    body.modelActionsInFlight = 1;
    body.schedulePickup({ id: 1, name: 'item', x: 0, y: 64, z: 0, distance: 1 });
    expect(body.pickingUp).toBe(false);
  });

  it('退避期间不启动新拾取，不占身体通道', () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.pickupAbortRequested = false;
    body.pickingUp = false;
    body.pickupBackoffUntil = Date.now() + 30_000;
    body.lastPickupAt = 0;
    body.actions = { executing: false };
    body.modelActionRequested = false;
    body.schedulePickup({ id: 1, name: 'item', x: 0, y: 64, z: 0, distance: 1 });
    expect(body.pickingUp).toBe(false);
  });

  it('discard 免疫窗口内即使目标实体已出现也不启动 pickup', () => {
    markDiscarded('oak_log');
    const body: any = Object.create(MineflayerBody.prototype);
    body.pickupAbortRequested = false;
    body.pickingUp = false;
    body.pickupBackoffUntil = 0;
    body.lastPickupAt = 0;
    body.actions = { executing: false };
    body.modelActionRequested = false;
    body.modelActionsInFlight = 0;
    body.schedulePickup({ id: 1, name: 'Oak Log', x: 0, y: 64, z: 0, distance: 1 });
    expect(body.pickingUp).toBe(false);
  });

  it('行走中目标被 discard 免疫命中：50ms 内 stop 并返回 false', async () => {
    vi.useFakeTimers();
    try {
      const body: any = Object.create(MineflayerBody.prototype);
      body.bot = {
        interrupt_code: false,
        pathfinder: { goto: vi.fn(() => new Promise<never>(() => {})), stop: vi.fn() },
      };
      body.pickupAbortRequested = false;
      body.pickupTargetName = 'Oak Log';
      const pending = body.gotoPickupInterruptibly({}, 12_000);
      await vi.advanceTimersByTimeAsync(60);
      markDiscarded('oak_log');
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toBe(false);
      expect(body.bot.pathfinder.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
