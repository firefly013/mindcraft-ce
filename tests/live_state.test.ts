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
  describeViewDirection,
  durabilityFraction,
  KEY_BLOCKS,
  PERCEPTION_LIMIT,
  PERCEPTION_RADIUS,
  renderLiveState,
  summarizeOmitted,
} from '../src/shared/live_state.js';
import { sampleLiveState } from '../src/body/live_state.js';

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

  it('entities carry a tag telling players from mobs', () => {
    // 玩家的 `name` 是类型名 'player'、身份在 `username`，所以采样时把
    // name 换成 username 填进 `name` 字段——渲染出来 `- Notch#12 8m (...)`
    // 和 `- zombie#7 3m (...)` 结构上完全一样。不标 (player) 的话模型
    // 分不出那是人还是怪物，也就无从判断"打不打得起"。
    const entities: Record<string, unknown> = {
      7: { id: 7, name: 'zombie', position: { x: 13.5, y: 64, z: -3.2 } },
      12: { id: 12, name: 'player', username: 'Notch', position: { x: 18.5, y: 64, z: -3.2 } },
    };
    const s = sampleLiveState({ bot: stubBot({ entities }) });
    const zombie = s.entities.find((e) => e.id === 7);
    const player = s.entities.find((e) => e.id === 12);
    expect(zombie?.tag).toBeUndefined();
    expect(player?.tag).toBe('player');
    // 名字取的是 username，不是 'player'——否则模型只知道有个玩家，不知道是谁。
    expect(player?.name).toBe('Notch');
    const text = renderLiveState(s);
    expect(text).toContain('Notch#12');
    expect(text).toContain('(player)');
  });

  it('villager tags carry profession or baby, never both', () => {
    const villager = (id: number, metadata: unknown[]) => ({
      id,
      name: 'villager',
      position: { x: 12.5, y: 64, z: -3.2 },
      metadata,
    });
    // metadata[16] === 1 是婴儿。婴儿不能交易，必须优先标出来。
    const baby = sampleLiveState({
      bot: stubBot({ entities: { 20: villager(20, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) } }),
    }).entities.find((e) => e.id === 20);
    expect(baby?.tag).toBe('baby');
  });

  it(
    'passes a Vec3 to bot.blockAt, never a plain object',
    () => {
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
    },
    // 这条要背 live_state.ts 的首次模块加载，本身就要 1.5 秒上下（实测 1530ms）。
    // 默认 5 秒超时在并行跑、机器负载高的时候会被挤爆 —— 已经用 git stash 对照
    // 确认过 baseline（不含任何新代码）同样会挂，所以是**环境**问题不是逻辑问题。
    // 给它放宽，别让它把真实的失败淹掉。
    20_000,
  );

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

  it('**坏帧的怀疑必须跟着图走**：图照发，但要说清「?」是渲染失败、不是虚空', () => {
    const line =
      '⚠️ **这张图的渲染不可全信**：世界是 1.21.11，渲染器只到 1.21.4 ⇒ 附近方块里**至少 100%** 它认不出（画成「?」）。' +
      '**地形判断以 near key blocks 的方块数据为准**，不要只凭画面。';
    const s = sampleLiveState({
      bot: stubBot(),
      vision: {
        lastScreenshot: { file: 'screenshot_bad.jpg', takenAt: Date.now() },
        lastFrameTrust: { trusted: false, reason: 'version_skew', line },
      },
    });
    expect(s.screenshot.trust?.trusted).toBe(false);
    expect(s.screenshot.trust?.reason).toBe('version_skew');
    // 图本身还在（**不靠删图来掩盖坏帧**）
    expect(s.screenshot.ref?.file).toBe('screenshot_bad.jpg');

    const text = renderLiveState(s);
    expect(text).toContain('Screenshot: screenshot_bad.jpg');
    expect(text).toContain('这张图的渲染不可全信');
    expect(text).toContain('以 near key blocks 的方块数据为准');
    // 那一行必须紧跟在 Screenshot 行之后（模型最容易把图旁边的字当结论）
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('Screenshot:'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lines[idx + 1]).toContain('不可全信');
  });

  it('图可信时**一个字都不多**（零噪音）', () => {
    const s = sampleLiveState({
      bot: stubBot(),
      vision: {
        lastScreenshot: { file: 'screenshot_ok.jpg', takenAt: Date.now() },
        lastFrameTrust: { trusted: true, reason: 'ok', line: '' },
      },
    });
    expect(s.screenshot.trust?.trusted).toBe(true);
    const text = renderLiveState(s);
    expect(text).toContain('Screenshot: screenshot_ok.jpg');
    expect(text).not.toContain('不可全信');
    expect(text).not.toContain('不可全信');
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

      // 危险操作许可必须出现在快照里：模型得能看见"我现在能不能倒水/点火"，

      // 而不是靠"试一下被拒"来发现——那是最贵的一种发现方式。

      'DangerousOps:',
      'Held:',
      'Backpack',
      'Position (此刻):',
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

  it('clamps durability instead of reporting negative percentages', () => {
    // 模型反馈过 `Held: stone_pickaxe (durability -300%)`：mineflayer 的
    // durabilityUsed 可以大于 mcData 的 maxDurability。不钳的话负数会让
    // tool.durability_low 永远处于触发态，也会把模型带进沟里。
    expect(durabilityFraction(3000, 1000)).toBe(0);
    expect(durabilityFraction(1300, 1000)).toBe(0);
    expect(durabilityFraction(999, 1000)).toBeCloseTo(0.001);
    expect(durabilityFraction(0, 1000)).toBe(1);
    // 读不到 / 上限不合法 -> 没有结论，而不是编一个数。
    expect(durabilityFraction(undefined, 1000)).toBeNull();
    expect(durabilityFraction(1, undefined)).toBeNull();
    expect(durabilityFraction(1, 0)).toBeNull();

    const s = sampleLiveState({
      bot: stubBot({
        entity: { id: 1, position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, metadata: [], onGround: true },
        heldItem: { name: 'stone_pickaxe', count: 1, durabilityUsed: 4000, maxDurability: 1000 },
      }),
    });
    expect(s.held.mainHandDurability).toBe(0);
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

  it('clamps durability instead of reporting negative percentages', () => {
    // 模型反馈过 `Held: stone_pickaxe (durability -300%)`：mineflayer 的
    // durabilityUsed 可以大于 mcData 的 maxDurability。不钳的话负数会让
    // tool.durability_low 永远处于触发态，也会把模型带进沟里。
    expect(durabilityFraction(3000, 1000)).toBe(0);
    expect(durabilityFraction(1300, 1000)).toBe(0);
    expect(durabilityFraction(999, 1000)).toBeCloseTo(0.001);
    expect(durabilityFraction(0, 1000)).toBe(1);
    // 读不到 / 上限不合法 -> 没有结论，而不是编一个数。
    expect(durabilityFraction(undefined, 1000)).toBeNull();
    expect(durabilityFraction(1, undefined)).toBeNull();
    expect(durabilityFraction(1, 0)).toBeNull();

    const s = sampleLiveState({
      bot: stubBot({
        entity: {
          id: 1,
          position: { x: 0, y: 64, z: 0 },
          yaw: 0,
          pitch: 0,
          metadata: [],
          onGround: true,
        },
        heldItem: { name: 'stone_pickaxe', count: 1, durabilityUsed: 4000, maxDurability: 1000 },
      }),
    });
    expect(s.held.mainHandDurability).toBe(0);
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

describe('视线方向：先给上下文，再谈可不可信（真机 overnight_a 的"整片天空"其实是朝上）', () => {
  it('pitch ≈ −87°（几乎垂直朝上）⇒ 点名"朝天空"、仰视、朝向罗盘，并说明这时的图不能判断地形', () => {
    const line = describeViewDirection((-87 * Math.PI) / 180, 0); // yaw 0 = +z = 南
    expect(line).not.toBeNull();
    expect(line).toContain('朝天空');
    expect(line).toContain('pitch -87°');
    expect(line).toContain('仰视');
    expect(line).toContain('朝 S');
    expect(line).toContain('不能用来判断地形');
    expect(line).toContain('纯天空色是正常的');
  });

  it('平视 ⇒ **一个字都不加**（零噪音）', () => {
    expect(describeViewDirection(0.05, 0)).toBeNull();
    expect(describeViewDirection((-20 * Math.PI) / 180, 1.2)).toBeNull(); // 20° 还在半视场内
  });

  it('几乎垂直向下 ⇒ 说明"只能看到脚下几格"', () => {
    const line = describeViewDirection((85 * Math.PI) / 180, Math.PI);
    expect(line).toContain('几乎垂直向下');
    expect(line).toContain('俯视');
    expect(line).toContain('朝 N');
    expect(line).toContain('不可靠');
  });

  it('朝向罗盘按 MC 的 yaw 约定（0=南、±90=东/西、180=北）', () => {
    const at = (yawDeg: number): string | null => describeViewDirection((-80 * Math.PI) / 180, (yawDeg * Math.PI) / 180);
    expect(at(0)).toContain('朝 S');
    expect(at(180)).toContain('朝 N');
    expect(at(-90)).toContain('朝 E');
    expect(at(90)).toContain('朝 W');
  });

  it('读不到 pitch/yaw ⇒ **说"读不到"**（不许让"测不出来"冒充"平视"）', () => {
    for (const [pitch, yaw] of [[null, 0.3], [0.3, undefined], [Number.NaN, 0.3]] as const) {
      const line = describeViewDirection(pitch, yaw);
      expect(line).not.toBeNull();
      expect(line).toContain('读不到');
      expect(line).toContain('不要假设现在是平视');
    }
  });

  it('渲染进截图块：紧跟 Screenshot 行（上下文在怀疑之前；朝向来自**这一帧**）', () => {
    const bot: any = stubBot();
    const s = sampleLiveState({
      bot,
      vision: {
        lastScreenshot: { file: 'screenshot_sky.jpg', takenAt: Date.now() },
        lastFrameView: { pitch: (-88 * Math.PI) / 180, yaw: 0 },
      },
    });
    const text = renderLiveState(s);
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('Screenshot:'));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(lines[idx + 1]).toContain('朝天空');
  });
});

describe('视线行必须描述**这一帧**，不是"现在身体朝哪"（真机：文字说朝天空、图里是水平隧道）', () => {
  const frame = (pitchDeg: number, yawDeg = 0) => ({
    pitch: (pitchDeg * Math.PI) / 180,
    yaw: (yawDeg * Math.PI) / 180,
  });

  it('**矛盾回归**：身体现在朝天空，但这一帧是平视 ⇒ 不许说"朝天空"', () => {
    const bot: any = stubBot();
    bot.entity.pitch = (-88 * Math.PI) / 180; // 现在的姿态（会骗人的那个）
    bot.entity.yaw = 0;
    const s = sampleLiveState({
      bot,
      vision: {
        lastScreenshot: { file: 'screenshot_tunnel.jpg', takenAt: Date.now() },
        lastFrameView: frame(-2), // 这一帧其实是水平隧道
      },
    });
    const text = renderLiveState(s);
    expect(text).toContain('Screenshot: screenshot_tunnel.jpg');
    expect(text).not.toContain('朝天空');
    expect(text).not.toContain('视线：');
  });

  it('反过来也只看帧：身体平视、这一帧朝天空 ⇒ 说"朝天空"', () => {
    const bot: any = stubBot();
    bot.entity.pitch = 0;
    const s = sampleLiveState({
      bot,
      vision: {
        lastScreenshot: { file: 'screenshot_sky.jpg', takenAt: Date.now() },
        lastFrameView: frame(-88),
      },
    });
    expect(renderLiveState(s)).toContain('朝天空');
  });

  it('这一帧没记朝向 ⇒ **什么都不说**（绝不拿当前姿态顶替）', () => {
    const bot: any = stubBot();
    bot.entity.pitch = (-88 * Math.PI) / 180; // 当前姿态很"吓人"，但不许用
    const s = sampleLiveState({
      bot,
      vision: { lastScreenshot: { file: 'screenshot_x.jpg', takenAt: Date.now() } },
    });
    const text = renderLiveState(s);
    expect(text).toContain('Screenshot: screenshot_x.jpg');
    expect(text).not.toContain('视线：');
  });
});

describe('裁决进 Screenshot 第一行（不让模型每帧自己猜哪张能信）', () => {
  const shot = (trust: any, view: any = null) =>
    sampleLiveState({
      bot: stubBot(),
      vision: {
        lastScreenshot: { file: 'frame_test.jpg', takenAt: Date.now() },
        lastFrameTrust: trust,
        ...(view == null ? {} : { lastFrameView: view }),
      },
    });

  it('不可用 ⇒ 第一行就有 这张图不可信 / 不要用它认方块 / 用方块数据，且带数字', () => {
    const text = renderLiveState(
      shot({
        trusted: false,
        reason: 'version_skew',
        usable: false,
        verdict: '—— **这张图不可信**（渲染器 1.21.4 vs 世界 1.21.11，只有 12% 的方块一对一）：**不要用它认方块**，用下面的 near key blocks 方块数据（那份每次都对）。',
        line: '⚠️ 旧的详细说明（既然裁决已在第一行，就不该重复）',
      }),
    );
    const lines = text.split('\n');
    const head = lines.find((l) => l.startsWith('Screenshot:')) ?? '';
    expect(head).toContain('frame_test.jpg');
    expect(head).toContain('这张图不可信');
    expect(head).toContain('不要用它认方块');
    expect(head).toContain('12%');
    expect(head).toContain('near key blocks');
    expect(text).not.toContain('旧的详细说明');
  });

  it('可用（覆盖率过阈值）⇒ 一个字都不加（不误报）', () => {
    const text = renderLiveState(
      shot({ trusted: true, reason: 'version_skew', usable: true, verdict: '', line: '' }, { pitch: 0.05, yaw: 0 }),
    );
    expect(text).not.toContain('不可信');
    expect(text).not.toContain('不要用它认方块');
  });

  it('版本一致 ⇒ 那两个词永远不出现', () => {
    const text = renderLiveState(shot({ trusted: true, reason: 'ok', usable: true, verdict: '', line: '' }));
    expect(text).not.toContain('不可信');
    expect(text).not.toContain('不要用它认方块');
  });

  it('裁决为空串但不可用（老数据）⇒ 回落到详细说明，绝不静默', () => {
    const text = renderLiveState(shot({ trusted: false, reason: 'version_skew', usable: false, verdict: '', line: '⚠️ **回落的详细说明**' }));
    expect(text).toContain('回落的详细说明');
  });

  it('视线行仍然保留（在裁决之后、同一条 Screenshot 段里）', () => {
    const text = renderLiveState(
      shot(
        { trusted: false, reason: 'version_skew', usable: false, verdict: '—— **这张图不可信**（测试）', line: '' },
        { pitch: (-88 * Math.PI) / 180, yaw: 0 },
      ),
    );
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('Screenshot:'));
    expect(lines[idx]).toContain('这张图不可信');
    expect(lines[idx + 1]).toContain('朝天空');
  });
});

describe('颜色是独立事实：丢颜色 ≠ 不可信（三件事分开说）', () => {
  const shot = (opts: { color?: any; trust?: any }) =>
    sampleLiveState({
      bot: stubBot(),
      vision: {
        lastScreenshot: { file: 'frame_color.jpg', takenAt: Date.now() },
        ...(opts.trust === undefined ? {} : { lastFrameTrust: opts.trust }),
        ...(opts.color === undefined ? {} : { lastFrameColor: opts.color }),
      },
    });

  it('丢颜色 ⇒ 说"丢了颜色/无彩度/认方块可以但别靠颜色认材质"，且**不说"不可信"**', () => {
    const text = renderLiveState(shot({ color: { chromaMean: 0.4, grayscale: true } }));
    expect(text).toContain('这张图丢了颜色');
    expect(text).toContain('无彩度');
    expect(text).toContain('0.4');
    expect(text).toContain('认方块可以');
    expect(text).toContain('别靠颜色认材质');
    expect(text).not.toContain('不可信');
  });

  it('彩色帧 ⇒ 一个字都不提颜色（不误报）', () => {
    const text = renderLiveState(shot({ color: { chromaMean: 41.2, grayscale: false } }));
    expect(text).not.toContain('丢了颜色');
    expect(text).not.toContain('无彩度');
  });

  it('没量颜色 ⇒ 不提（没测就是没测，不猜）', () => {
    const text = renderLiveState(shot({}));
    expect(text).not.toContain('丢了颜色');
  });

  it('三态可区分：测出来低覆盖率 / 无法核对 / 丢颜色，三种文字互不混用', () => {
    const low = renderLiveState(
      shot({
        trust: {
          trusted: false,
          reason: 'version_skew',
          usable: false,
          verdict: '—— **这张图不可信**（渲染器 1.21.4 vs 世界 1.21.11，只有 12% 的方块一对一）：**不要用它认方块**，用下面的 near key blocks 方块数据。',
          line: '',
        },
      }),
    );
    const unknown = renderLiveState(
      shot({
        trust: {
          trusted: false,
          reason: 'renderer_unsupported',
          usable: false,
          verdict: '—— **无法核对**（读不到渲染器/世界版本）：这张图**没有校对过**，可能对也可能错——**用方块数据交叉验证，别只凭它下结论**。',
          line: '',
        },
      }),
    );
    const gray = renderLiveState(shot({ color: { chromaMean: 0.2, grayscale: true } }));
    expect(low).toContain('这张图不可信');
    expect(low).not.toContain('无法核对');
    expect(unknown).toContain('无法核对');
    expect(unknown).not.toContain('这张图不可信');
    expect(gray).toContain('丢了颜色');
    expect(gray).not.toContain('无法核对');
    expect(gray).not.toContain('这张图不可信');
  });
});
