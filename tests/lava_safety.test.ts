/**
 * task-26：placeBlock 不拆承重块；岩浆靠近/接触立即中断并上/逃。
 */
import { describe, expect, it, vi } from 'vitest';
import { assessPlaceBlockRisk } from '../src/body/library/skills.js';
import { runEmergency } from '../src/body/safety/emergency.js';
import { createEdgeWatcher, snapshotFromBot } from '../src/body/edges.js';

type Block = { name: string } | null;
const accessor = (blocks: Record<string, string>) => (x: number, y: number, z: number): Block => {
  const name = blocks[x + ',' + y + ',' + z];
  return name == null ? null : { name };
};

describe('assessPlaceBlockRisk：清障不得拆承重块', () => {
  it('目标就是脚下方块 / 脚下承重块：拒绝', () => {
    const blockAt = accessor({ '0,-1,0': 'deepslate', '0,0,0': 'air', '0,1,0': 'air' });
    expect(assessPlaceBlockRisk(blockAt, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }).ok).toBe(false);
    expect(assessPlaceBlockRisk(blockAt, { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }).reason).toContain('承重');
  });

  it('目标紧邻岩浆 / 下方紧邻岩浆：拒绝', () => {
    const near = accessor({ '0,-1,0': 'stone', '1,0,0': 'lava', '0,0,0': 'air' });
    expect(assessPlaceBlockRisk(near, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }).reason).toContain('承重');
    const below = accessor({ '0,-1,0': 'stone', '2,0,0': 'dirt', '2,-1,0': 'lava' });
    const risk = assessPlaceBlockRisk(below, { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    expect(risk.ok).toBe(false);
    expect(risk.reason).toContain('下方紧邻');
  });

  it('安全位置：允许', () => {
    const blockAt = accessor({ '0,-1,0': 'stone', '1,0,0': 'stone', '0,0,0': 'air' });
    expect(assessPlaceBlockRisk(blockAt, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }).ok).toBe(true);
  });
});

describe('岩浆紧急反射', () => {
  it('脚在岩浆：立即 stopAll + 上浮/远离，脱离后返回 escaped', async () => {
    let calls = 0;
    const bot: any = {
      health: 20,
      inventoryNames: () => [],
      feet: () => ({ x: 0, y: 0, z: 0 }),
      feetBlockName: () => (++calls <= 1 ? 'lava' : 'stone'),
      headBlockName: () => 'air',
      lavaNear: () => ({ x: 1, z: 0 }),
      stopAll: vi.fn(),
      swimUp: vi.fn(),
      fleeTo: vi.fn(),
      eat: async () => {},
      threats: () => [],
      safeguardsOff: () => false,
    };
    const result = await runEmergency(bot, { intent: 'lava', tickMs: 0, sleep: async () => {}, now: () => Date.now() });
    expect(result.escaped).toBe(true);
    expect(bot.stopAll).toHaveBeenCalled();
    expect(bot.swimUp).toHaveBeenCalled();
    expect(bot.fleeTo).toHaveBeenCalled();
  });

  it('保命被关闭：岩浆反射也不抢身体', async () => {
    const bot: any = {
      health: 20,
      inventoryNames: () => [],
      feet: () => ({ x: 0, y: 0, z: 0 }),
      feetBlockName: () => 'lava',
      headBlockName: () => 'air',
      lavaNear: () => null,
      stopAll: vi.fn(),
      swimUp: vi.fn(),
      fleeTo: vi.fn(),
      eat: async () => {},
      threats: () => [],
      safeguardsOff: () => true,
    };
    const result = await runEmergency(bot, { intent: 'lava', tickMs: 0, sleep: async () => {}, now: () => Date.now() });
    expect(result.escaped).toBe(false);
    expect(bot.swimUp).not.toHaveBeenCalled();
  });
});

describe('lava.nearby 边沿检测', () => {
  it('身边 3 格内有岩浆：snapshot 标 lavaNearby 并发 L5 事件', () => {
    const bot: any = {
      health: 20,
      food: 20,
      entity: { position: { x: 0.5, y: 0.5, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true },
      inventory: { slots: [], items: () => [] },
      game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
      time: { timeOfDay: 6000 },
      entities: {},
      // task-34：安全实心岸上不再触发预测性 lava.nearby；这里故意脚下无支撑来触发真实危险。
      blockAt: (p: { x: number; y: number; z: number }) =>
        p.x === 1 && p.y === 0 && p.z === 0 ? { name: 'lava' } : { name: 'air' },
    };
    const snapshot = snapshotFromBot(bot);
    expect(snapshot.lavaNearby).toBe(true);
    const events = createEdgeWatcher().poll(snapshot);
    const nearby = events.find((e) => e.type === 'world.lava.nearby');
    expect(nearby).toBeDefined();
    // task-37：预测性 nearby 降为 L3，只告知不抢断。
    expect(nearby?.level).toBe(3);
  });
});
