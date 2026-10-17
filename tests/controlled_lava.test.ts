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
