/**
 * task-32：受控岩浆作业不被 lava.nearby 保命误中断。
 */
import { describe, expect, it, vi } from 'vitest';
import { createEdgeWatcher, snapshotFromBot } from '../src/body/edges.js';
import { makeObsidian } from '../src/body/commands/make_obsidian.js';

function baseBot(blocks: Record<string, string>): any {
  return {
    health: 20,
    food: 20,
    controlledLavaOperation: false,
    entity: { position: { x: 0.5, y: 0.5, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true },
    inventory: { slots: [], items: () => [] },
    game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    time: { timeOfDay: 6000 },
    entities: {},
    blockAt: (p: { x: number; y: number; z: number }) => {
      const key = Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z);
      const name = blocks[key];
      return name == null ? { name: 'air' } : { name };
    },
  };
}

describe('controlledLavaOperation：安全站岩浆边不抢断', () => {
  it('安全站位 + controlled flag：lava.nearby 不发 L5 事件', () => {
    const bot = baseBot({ '0,-1,0': 'stone', '1,0,0': 'lava' });
    const snapshot = snapshotFromBot(bot, { controlledLavaOperation: true });
    expect(snapshot.lavaNearby).toBe(true);
    expect(snapshot.controlledLavaOperation).toBe(true);
    const events = createEdgeWatcher().poll(snapshot);
    expect(events.map((e) => e.type)).not.toContain('world.lava.nearby');
  });

  it('真实掉进岩浆 + controlled flag：仍然发 lava.contact / lava.nearby', () => {
    const bot = baseBot({ '0,0,0': 'lava', '1,0,0': 'lava' });
    const snapshot = snapshotFromBot(bot, { controlledLavaOperation: true });
    expect(snapshot.inLava).toBe(true);
    expect(snapshot.controlledLavaOperation).toBeUndefined();
    const events = createEdgeWatcher().poll(snapshot);
    const types = events.map((e) => e.type);
    expect(types).toContain('world.lava.contact');
    expect(types).toContain('world.lava.nearby');
  });

  it('脚下没有支撑：controlled flag 不生效', () => {
    const bot = baseBot({ '1,0,0': 'lava' }); // 脚下 air，无支撑
    const snapshot = snapshotFromBot(bot, { controlledLavaOperation: true });
    expect(snapshot.controlledLavaOperation).toBeUndefined();
  });
});

describe('makeObsidian：标志生命周期', () => {
  it('早期失败也清除 controlledLavaOperation，不残留', async () => {
    const bot = baseBot({});
    await expect(makeObsidian(bot)).resolves.toBeDefined();
    expect(bot.controlledLavaOperation).toBe(false);
  });
});

describe('预测性 lava L5 全部豁免', () => {
  it('受控安全作业时 about_to_enter 也不抢断', () => {
    const bot = baseBot({ '0,-1,0': 'stone', '0,0,-2': 'lava' });
    bot.entity.yaw = 0;
    bot.entity.velocity = { x: 1, y: 0, z: 0 };
    const snapshot = snapshotFromBot(bot, { controlledLavaOperation: true });
    expect(snapshot.nextIsLava).toBe(true);
    expect(snapshot.controlledLavaOperation).toBe(true);
    const types = createEdgeWatcher().poll(snapshot).map((e) => e.type);
    expect(types).not.toContain('world.lava.about_to_enter');
    expect(types).not.toContain('world.lava.nearby');
  });

  it('没有 controlled 标志时 about_to_enter 照常发 L5', () => {
    const bot = baseBot({ '0,-1,0': 'stone', '0,0,-2': 'lava' });
    bot.entity.yaw = 0;
    bot.entity.velocity = { x: 1, y: 0, z: 0 };
    const snapshot = snapshotFromBot(bot, {});
    const types = createEdgeWatcher().poll(snapshot).map((e) => e.type);
    expect(types).toContain('world.lava.about_to_enter');
  });
});

describe('formatMakeObsidianProgress', () => {
  it('中断回执带进度/已挖坐标/剩余水桶/下一块', async () => {
    const { formatMakeObsidianProgress } = await import('../src/body/commands/make_obsidian.js');
    const text = formatMakeObsidianProgress(
      {
        ok: false,
        produced: 3,
        message: '',
        mined: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }],
        remainingWaterBuckets: 2,
        nextTarget: { liquid: { x: 7, y: 8, z: 9 }, stand: { x: 10, y: 11, z: 12 } },
        dangerStop: false,
      },
      'makeObsidian 被 Stop/保命打断',
    );
    expect(text).toContain('进度 3/10');
    expect(text).toContain('(1,2,3)');
    expect(text).toContain('剩余水桶 2');
    expect(text).toContain('下一块候选');
    expect(text).toContain('(7,8,9)');
    expect(text).toContain('(10,11,12)');
  });
});

describe('task-34：预测性 lava 只在真实危险时触发', () => {
  it('安全站在实心岸上：即使旁边有岩浆，lava.nearby 也不触发（不靠 flag）', () => {
    const bot = baseBot({ '0,-1,0': 'stone', '1,0,0': 'lava' });
    const snapshot = snapshotFromBot(bot, {});
    expect(snapshot.lavaNearby).toBe(true);
    expect(snapshot.hasSupport).toBe(true);
    const types = createEdgeWatcher().poll(snapshot).map((e) => e.type);
    expect(types).not.toContain('world.lava.nearby');
  });

  it('脚下没有实心支撑 + 旁边岩浆：lava.nearby 触发', () => {
    const bot = baseBot({ '1,0,0': 'lava' });
    const snapshot = snapshotFromBot(bot, {});
    expect(snapshot.hasSupport).toBeUndefined();
    const types = createEdgeWatcher().poll(snapshot).map((e) => e.type);
    expect(types).toContain('world.lava.nearby');
  });

  it('前方岩浆但下一步下方实心：about_to_enter 不触发', () => {
    const bot = baseBot({ '0,-1,0': 'stone', '0,0,-2': 'lava', '0,-1,-2': 'stone' });
    bot.entity.yaw = 0;
    bot.entity.velocity = { x: 1, y: 0, z: 0 };
    const snapshot = snapshotFromBot(bot, {});
    expect(snapshot.nextIsLava).toBe(true);
    expect(snapshot.nextIsLavaFallRisk).toBeUndefined();
    const types = createEdgeWatcher().poll(snapshot).map((e) => e.type);
    expect(types).not.toContain('world.lava.about_to_enter');
  });

  it('前方岩浆且下一步下方非实心：about_to_enter 触发', () => {
    const bot = baseBot({ '0,-1,0': 'stone', '0,0,-2': 'lava', '0,-1,-2': 'air' });
    bot.entity.yaw = 0;
    bot.entity.velocity = { x: 1, y: 0, z: 0 };
    const snapshot = snapshotFromBot(bot, {});
    expect(snapshot.nextIsLavaFallRisk).toBe(true);
    const types = createEdgeWatcher().poll(snapshot).map((e) => e.type);
    expect(types).toContain('world.lava.about_to_enter');
  });
});

