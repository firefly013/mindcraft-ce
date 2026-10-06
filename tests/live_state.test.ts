/**
 * Live State 快照契约。
 *
 * 只用手写的 stub bot，不依赖 mineflayer：快照函数永不抛错、
 * 缺字段写 null/unknown、感知有界、截图位诚实（有就引用，
 * 没有就写原因）。
 */
import { describe, expect, it } from 'vitest';
import {
  budgetedList,
  compassOf,
  KEY_BLOCKS,
  PERCEPTION_LIMIT,
  PERCEPTION_RADIUS,
  renderLiveState,
  sampleLiveState,
  summarizeOmitted,
} from '../src/agent/live_state.js';

function stubBot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    health: 20,
    food: 18,
    foodSaturation: 5,
    oxygenLevel: 20,
    experience: { level: 3, progress: 0.5 },
    entity: {
      id: 1,
      position: { x: 10.5, y: 64, z: -3.2 },
      yaw: 0,
      pitch: 0,
      // mineflayer 不在实体上写 pose：真值在元数据第 6 项（0 = standing）。
      metadata: [0, 0, 0, 0, 0, 0, 0],
      onGround: true,
      velocity: { x: 0, y: 0, z: 0 },
    },
    heldItem: { name: 'diamond_sword', count: 1 },
    inventory: { slots: [] },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 6000 },
    // 真 mineflayer 给的是数字等级（rain.js 初值 0），不是布尔。
    rainState: 0,
    thunderState: 0,
    entities: {},
    currentWindow: null,
    ...overrides,
  };
}

describe('sampleLiveState', () => {
  it('reads body/held/position/environment off a mineflayer-shaped bot', () => {
    const s = sampleLiveState({ bot: stubBot() });
    expect(s.body.health).toBe(20);
    expect(s.body.food).toBe(18);
    expect(s.held.mainHand).toBe('diamond_swordx1');
    expect(s.position.x).toBeCloseTo(10.5);
    expect(s.position.dimension).toBe('overworld');
    expect(s.environment.timeOfDay).toBe(6000);
    expect(s.environment.weather).toBe('Clear');
    expect(s.meta.gamemode).toBe('survival');
  });

  it('never throws on an empty/garbage bot: everything degrades to null', () => {
    const s = sampleLiveState({ bot: {} });
    expect(s.body.health).toBeNull();
    expect(s.position.x).toBeNull();
    expect(s.environment.weather).toBe('Unknown');
    expect(s.entities).toEqual([]);
    expect(s.blocks).toEqual([]);
    expect(s.screenshot.ref).toBeNull();
  });

  it('lists nearby entities nearest-first and truncates past the limit', () => {
    const entities: Record<string, unknown> = {};
    for (let i = 0; i < PERCEPTION_LIMIT + 5; i++) {
      entities[String(100 + i)] = {
        id: 100 + i,
        name: 'zombie',
        position: { x: 10 + i, y: 64, z: -3 },
        health: 20,
      };
    }
    // 一个超距的，一个是自己，都不该出现。
    entities['999'] = { id: 999, name: 'skeleton', position: { x: 500, y: 64, z: 500 } };
    const s = sampleLiveState({ bot: stubBot({ entities }) });
    expect(s.entities).toHaveLength(PERCEPTION_LIMIT);
    expect(s.entitiesTruncated).toBe(5);
    const dists = s.entities.map((e) => e.distance);
    expect([...dists].sort((a, b) => a - b)).toEqual(dists);
  });

  it('thunderstorm beats rain, rain beats clear', () => {
    // mineflayer 的真形状是**数字**等级（rain.js 初值 0、由 game_state_change 赋值），
    // 不是布尔——以前这里喂 true，把"雷暴永远认不出"锁成了契约。
    expect(sampleLiveState({ bot: stubBot({ thunderState: 1, rainState: 1 }) }).environment.weather).toBe(
      'Thunderstorm',
    );
    expect(sampleLiveState({ bot: stubBot({ rainState: 1 }) }).environment.weather).toBe('Rain');
    expect(sampleLiveState({ bot: stubBot({ thunderState: 0, rainState: 0 }) }).environment.weather).toBe(
      'Clear',
    );
  });

  it('passes a Vec3 to bot.blockAt, never a plain object', () => {
    // 同 edge_poll：prismarine-world 的 getBlock 会调 pos.floored()。
    const seen: unknown[] = [];
    sampleLiveState({
      bot: stubBot({
        blockAt: (p: unknown) => {
          seen.push(p);
          return { name: 'air', light: 0, skyLight: 15, biome: { name: 'plains' } };
        },
      }),
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(typeof (p as { floored?: unknown }).floored).toBe('function');
    }
  });

  it('screenshot slot references the latest capture, or states why not', () => {
    const taken = sampleLiveState({
      bot: stubBot(),
      vision: { lastScreenshot: { file: 'screenshot_x.jpg', takenAt: Date.now() } },
    });
    expect(taken.screenshot.ref?.file).toBe('screenshot_x.jpg');
    expect(taken.screenshot.unavailableReason).toBeNull();

    const noVision = sampleLiveState({ bot: stubBot() });
    expect(noVision.screenshot.ref).toBeNull();
    expect(noVision.screenshot.unavailableReason).toBe('vision disabled');

    const neverShot = sampleLiveState({ bot: stubBot(), vision: {} });
    expect(neverShot.screenshot.unavailableReason).toBe('no screenshot taken yet');
  });

  it('key blocks are found by registry name within radius', () => {
    const bot = stubBot({
      blockAt: ({ x, y, z }: { x: number; y: number; z: number }) => {
        if (x === 12 && y === 64 && z === -3) return { name: 'diamond_ore' };
        if (x === 11 && y === 64 && z === -3) return { name: 'dirt' };
        return { name: 'air' };
      },
    });
    // blockAt for light/biome reads also runs; give it air so confidence stays sane.
    const s = sampleLiveState({ bot });
    expect(s.blocks.map((b) => b.name)).toContain('diamond_ore');
    expect(s.blocks.map((b) => b.name)).not.toContain('dirt');
    expect(KEY_BLOCKS.length).toBeGreaterThan(0);
  });
});

describe('renderLiveState', () => {
  it('renders every section with an honest screenshot line', () => {
    const text = renderLiveState(
      sampleLiveState({
        bot: stubBot(),
        vision: { lastScreenshot: { file: 's.jpg', takenAt: Date.now() } },
        goal: 'build a house',
        todos: [{ text: 'gather wood', done: false }],
        currentAction: 'action:collectBlocks',
      }),
    );
    for (const head of [
      'Body:',
      'Held:',
      'Backpack',
      'Position:',
      'Environment:',
      'Nearby entities',
      'Nearby key blocks',
      'Screenshot: s.jpg',
      'Goal: build a house',
      'Meta:',
    ]) {
      expect(text).toContain(head);
    }
  });

  it('states the reason when no screenshot exists', () => {
    const text = renderLiveState(sampleLiveState({ bot: stubBot() }));
    expect(text).toContain('Screenshot: none (vision disabled)');
    expect(text).toContain(`within ${PERCEPTION_RADIUS}`);
  });
});

describe('compassOf', () => {
  it('maps the four cardinals and the diagonals', () => {
    expect(compassOf(0, -10)).toBe('N');
    expect(compassOf(10, -10)).toBe('NE');
    expect(compassOf(10, 0)).toBe('E');
    expect(compassOf(10, 10)).toBe('SE');
    expect(compassOf(0, 10)).toBe('S');
    expect(compassOf(-10, 10)).toBe('SW');
    expect(compassOf(-10, 0)).toBe('W');
    expect(compassOf(-10, -10)).toBe('NW');
  });
});

describe('budgetedList', () => {
  const items = [1, 2, 3, 4, 5];
  const cost = (): number => 10;

  it('stops at the count cap', () => {
    expect(budgetedList(items, 3, 1000, cost)).toEqual([1, 2, 3]);
  });

  it('stops at the token budget when that binds first', () => {
    expect(budgetedList(items, 5, 25, cost)).toEqual([1, 2]);
  });

  it('always keeps the first entry, even with no budget', () => {
    expect(budgetedList(items, 5, 0, cost)).toEqual([1]);
  });
});

describe('summarizeOmitted', () => {
  it('groups by name and compass, biggest group first', () => {
    const omitted = [
      { name: 'zombie', x: 0, z: -20 },
      { name: 'zombie', x: 2, z: -20 },
      { name: 'skeleton', x: 20, z: 0 },
    ];
    expect(summarizeOmitted(omitted, { x: 0, z: 0 })).toEqual(['zombie×2 N', 'skeleton×1 E']);
  });

  it('returns nothing when there is nothing omitted', () => {
    expect(summarizeOmitted([], { x: 0, z: 0 })).toEqual([]);
  });

  it('marks the groups it had to drop beyond the line cap', () => {
    const omitted = [
      { name: 'a', x: 10, z: 0 },
      { name: 'b', x: 20, z: 0 },
      { name: 'c', x: 30, z: 0 },
    ];
    expect(summarizeOmitted(omitted, { x: 0, z: 0 }, 2)).toEqual([
      'a×1 E',
      'b×1 E',
      '+1 more groups',
    ]);
  });
});

describe('perception fields', () => {
  it('reports potion effects, held durability, speed, day and posture', () => {
    const s = sampleLiveState({
      bot: stubBot({
        // mineflayer 的效果只有 {id, amplifier, duration}，名字来自 mcData 注册表。
        registry: { effects: { 0: { id: 0, name: 'Speed', displayName: 'Speed' } } },
        entity: {
          id: 1,
          position: { x: 0, y: 64, z: 0 },
          yaw: 0,
          pitch: 0,
          metadata: [0, 0, 0, 0, 0, 0, 0],
          onGround: true,
          // velocity 单位是格/游戏刻：0.5 格/刻 = 10 格/秒。
          velocity: { x: 0.3, y: 0, z: 0.4 },
          effects: { 0: { id: 0, amplifier: 1, duration: 900 } },
        },
        heldItem: { name: 'diamond_pickaxe', count: 1, durabilityUsed: 250, maxDurability: 1000 },
        time: { timeOfDay: 6000, day: 42 },
        getControlState: (control: string): boolean => control === 'sprint',
      }),
    });
    expect(s.body.effects).toEqual(['Speed II 45s']);
    expect(s.held.mainHandDurability).toBeCloseTo(0.75);
    expect(s.position.speed).toBeCloseTo(10);
    expect(s.environment.day).toBe(42);
    expect(s.meta.posture).toBe('sprinting');
  });

  it('names an effect through the registry and falls back to the raw id', () => {
    const named = sampleLiveState({
      bot: stubBot({
        registry: { effects: { 7: { id: 7, name: 'MiningFatigue', displayName: 'Mining Fatigue' } } },
        entity: { id: 1, position: { x: 0, y: 64, z: 0 }, effects: { 7: { id: 7, amplifier: 0, duration: 40 } } },
      }),
    });
    expect(named.body.effects).toEqual(['Mining Fatigue I 2s']);

    // 注册表缺失时不能默默丢掉，退化成编号。
    const orphan = sampleLiveState({
      bot: stubBot({
        entity: { id: 1, position: { x: 0, y: 64, z: 0 }, effects: { 99: { id: 99, amplifier: 0, duration: 20 } } },
      }),
    });
    expect(orphan.body.effects).toEqual(['effect#99 I 1s']);
  });

  it('reads pose from entity metadata[6] (mineflayer has no entity.pose)', () => {
    // 5 = sneaking（协议枚举）。真值在元数据第 6 项，不是实体字段。
    const sneaking = sampleLiveState({
      bot: stubBot({
        entity: { id: 1, position: { x: 0, y: 64, z: 0 }, metadata: [0, 0, 0, 0, 0, 0, 5] },
      }),
    });
    expect(sneaking.body.pose).toBe('sneaking');

    // 契约钉子：`entity.pose` 不是 mineflayer 的字段，光有它必须读不到。
    const fake = sampleLiveState({
      bot: stubBot({
        entity: { id: 1, position: { x: 0, y: 64, z: 0 }, pose: 'standing' },
      }),
    });
    expect(fake.body.pose).toBeNull();
  });

  it('takes effective light from block light plus (daytime) sky light', () => {
    const at = (timeOfDay: number, light: number, skyLight: number): number | null =>
      sampleLiveState({
        bot: stubBot({
          time: { timeOfDay },
          blockAt: () => ({ name: 'air', light, skyLight, biome: { name: 'plains' } }),
        }),
      }).environment.light;

    // 正午露天：方块光 0 + 天光 15 → 15（以前会报 0，模型被告知"漆黑"）。
    expect(at(6000, 0, 15)).toBe(15);
    // 同一个方块，夜里：天光不照亮 → 0。
    expect(at(18000, 0, 15)).toBe(0);
    // 火把光不受时辰影响。
    expect(at(18000, 14, 15)).toBe(14);
  });

  it('names a player by username, not by the literal type name', () => {
    // mineflayer addNewPlayer: entity.name = 'player'，身份在 username。
    const s = sampleLiveState({
      bot: stubBot({
        entities: { 8: { id: 8, type: 'player', name: 'player', username: 'Steve', position: { x: 11, y: 64, z: -3 } } },
      }),
    });
    expect(s.entities[0]?.name).toBe('Steve');
  });

  it('says unknown (not high) when the column data cannot be read', () => {
    // 脚下读得到、头顶一列全 null：以前 skyExposed 会把"没数据"当露天 → high。
    const s = sampleLiveState({
      bot: stubBot({
        blockAt: (p: unknown) => ((p as { y?: number }).y === 64 ? { name: 'stone', light: 0, skyLight: 0 } : null),
      }),
    });
    expect(s.environment.light).toBe(0);
    expect(s.environment.lightConfidence).toBe('unknown');
  });

  it('says high confidence when it can actually see the column', () => {
    const s = sampleLiveState({
      bot: stubBot({
        blockAt: () => ({ name: 'air', light: 0, skyLight: 15, biome: { name: 'plains' } }),
      }),
    });
    expect(s.environment.lightConfidence).toBe('high');
  });

  it('degrades the new fields to empty/null on a bare bot', () => {
    const s = sampleLiveState({ bot: {} });
    expect(s.body.effects).toEqual([]);
    expect(s.held.mainHandDurability).toBeNull();
    expect(s.position.speed).toBeNull();
    expect(s.environment.day).toBeNull();
    expect(s.meta.posture).toBeNull();
  });

  it('renders the new fields into the snapshot text', () => {
    const text = renderLiveState(
      sampleLiveState({
        bot: stubBot({
          registry: { effects: { 0: { id: 0, name: 'Speed', displayName: 'Speed' } } },
          entity: {
            id: 1,
            position: { x: 0, y: 64, z: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            effects: { 0: { id: 0, amplifier: 0, duration: 200 } },
          },
          time: { timeOfDay: 6000, day: 7 },
        }),
      }),
    );
    expect(text).toContain('effects Speed I 10s');
    expect(text).toContain('Environment: day 7');
    expect(text).toContain('speed 0');
    expect(text).toContain('posture standing');
  });

  it('renders a merged far line when the detail list is full', () => {
    const entities: Record<string, unknown> = {};
    for (let i = 0; i < PERCEPTION_LIMIT; i++) {
      entities[String(100 + i)] = { id: 100 + i, name: 'zombie', position: { x: i, y: 64, z: 1 } };
    }
    entities['900'] = { id: 900, name: 'skeleton', position: { x: 0, y: 64, z: -20 } };
    const text = renderLiveState(sampleLiveState({ bot: stubBot({ entities }) }));
    expect(text).toContain('farther (merged): skeleton×1 N');
  });
});
