/**
 * 水深 / 连通判定的契约。
 *
 * 这模块的失败模式有两种，都很致命且**都很安静**：
 *
 * 1. **该拦没拦** —— 机器人走进连着流动水的深水，被冲走或淹死。真机上淹死过。
 * 2. **不该拦乱拦** —— 机器人连河边 1 格浅水都不敢下，等于残废。
 *
 * 因为拿不到实机（额度打满），这里用假世界把两种方向都钉住。
 */
import { describe, expect, it } from 'vitest';
import Vec3 from 'vec3';
import {
  BFS_RADIUS,
  SAFE_WATER_DEPTH,
  blockAtFrom,
  classifyWaterAt,
  isDangerousWaterAt,
  isWater,
  reachesFlowingWater,
  waterDepthAt,
  waterLevel,
  waterUnderFeet,
  headInWater,
} from '../src/agent/water_safety.js';
import { dangerousWaterRefusal } from '../src/agent/water_safety.js';

/**
 * 假世界。格子用 `[x, y, z, name, level?]` 描述，没写的格子是空气。
 * level 默认 0（静水源）。
 */
type Cell = [number, number, number, string, number?];

function fakeWorld(cells: Cell[]): (x: number, y: number, z: number) => { name: string; metadata: number } {
  const map = new Map<string, { name: string; metadata: number }>();
  for (const [x, y, z, name, level] of cells) {
    map.set(`${x},${y},${z}`, { name, metadata: level ?? 0 });
  }
  return (x: number, y: number, z: number) => map.get(`${x},${y},${z}`) ?? { name: 'air', metadata: 0 };
}

/** 脚下 (0,0,0) 是水，下面铺石头 —— 水深 1 的浅滩。 */
const SHALLOW = fakeWorld([
  [0, 0, 0, 'water'],
  [0, -1, 0, 'stone'],
]);

describe('waterLevel / isWater', () => {
  it('level 0 = 静水源，非 0 = 在流动', () => {
    expect(waterLevel({ name: 'water', metadata: 0 })).toBe(0);
    expect(waterLevel({ name: 'water', metadata: 5 })).toBe(5);
  });

  it('_properties.level 也认（新版 mineflayer）', () => {
    expect(waterLevel({ name: 'water', _properties: { level: 3 } })).toBe(3);
    expect(waterLevel({ name: 'water', _properties: { level: '7' } })).toBe(7);
  });

  it('读不出 level 时当静水——按流动处理会让机器人连河边都不敢去', () => {
    expect(waterLevel({ name: 'water' })).toBe(0);
    expect(waterLevel(null)).toBe(0);
    expect(waterLevel({ name: 'water', metadata: NaN })).toBe(0);
  });

  it('只有 water 算水', () => {
    expect(isWater({ name: 'water' })).toBe(true);
    expect(isWater({ name: 'lava' })).toBe(false);
    expect(isWater({ name: 'air' })).toBe(false);
    expect(isWater(null)).toBe(false);
  });
});

describe('水深', () => {
  it('往下数连续的水有几格', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water'],
      [0, -1, 0, 'water'],
      [0, -2, 0, 'water'],
      [0, -3, 0, 'stone'],
    ]);
    expect(waterDepthAt(w, 0, 0, 0)).toBe(3);
  });

  it('脚下不是水就是 0 格', () => {
    expect(waterDepthAt(SHALLOW, 0, 5, 0)).toBe(0);
  });
});

describe('连通检测', () => {
  it('静水连着流动的水 → 连得到', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water'],
      [1, 0, 0, 'water', 4],
    ]);
    expect(reachesFlowingWater(w, 0, 0, 0)).toBe(true);
  });

  it('一整片静水，没有出口 → 连不到', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water'],
      [1, 0, 0, 'water'],
      [2, 0, 0, 'water'],
      [0, -1, 0, 'stone'],
      [1, -1, 0, 'stone'],
      [2, -1, 0, 'stone'],
    ]);
    expect(reachesFlowingWater(w, 0, 0, 0)).toBe(false);
  });

  it('水会顺着竖井往下淌，所以上下也要搜', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water'],
      [0, -1, 0, 'water'],
      [0, -2, 0, 'water', 2],
    ]);
    expect(reachesFlowingWater(w, 0, 0, 0)).toBe(true);
  });

  it('隔着陆地的水不算连通（水不会穿墙）', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water'],
      [1, 0, 0, 'stone'],
      [2, 0, 0, 'water', 6],
    ]);
    expect(reachesFlowingWater(w, 0, 0, 0)).toBe(false);
  });

  it('超出半径就不管了——那是另一滩水，不是我这滩的出口', () => {
    const cells: Cell[] = [[0, 0, 0, 'water']];
    for (let x = 1; x <= BFS_RADIUS + 4; x++) cells.push([x, 0, 0, 'water']);
    cells.push([BFS_RADIUS + 5, 0, 0, 'water', 3]);
    expect(reachesFlowingWater(fakeWorld(cells), 0, 0, 0)).toBe(false);
  });

  it('起点不是水就直接 false', () => {
    expect(reachesFlowingWater(SHALLOW, 0, 9, 0)).toBe(false);
  });
});

describe('综合判定', () => {
  it('不是水 → 什么都不拦', () => {
    const c = classifyWaterAt(SHALLOW, 0, 9, 0);
    expect(c.isWater).toBe(false);
    expect(c.dangerous).toBe(false);
    expect(c.reason).toBe('');
  });

  it(`${SAFE_WATER_DEPTH} 格深的静水：踩一脚无所谓`, () => {
    const c = classifyWaterAt(SHALLOW, 0, 0, 0);
    expect(c.isWater).toBe(true);
    expect(c.depth).toBe(1);
    expect(c.dangerous).toBe(false);
  });

  it('超过 1 格深 → 可能没顶', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water'],
      [0, -1, 0, 'water'],
      [0, -2, 0, 'stone'],
    ]);
    const c = classifyWaterAt(w, 0, 0, 0);
    expect(c.dangerous).toBe(true);
    expect(c.depth).toBe(2);
    expect(c.reason).toContain('2 格深');
  });

  it('脚下这格在流动 → 站上去直接被冲走', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water', 5],
      [0, -1, 0, 'stone'],
    ]);
    const c = classifyWaterAt(w, 0, 0, 0);
    expect(c.flowingHere).toBe(true);
    expect(c.dangerous).toBe(true);
    expect(c.reason).toContain('正在流动');
  });

  it('1 格静水但连着流动的水 → 会被冲到不知道哪儿去', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water'],
      [0, -1, 0, 'stone'],
      [1, 0, 0, 'water', 4],
    ]);
    const c = classifyWaterAt(w, 0, 0, 0);
    expect(c.depth).toBe(1);
    expect(c.flowingReachable).toBe(true);
    expect(c.dangerous).toBe(true);
    expect(c.reason).toContain('连着流动');
  });

  it('原因按最要命的排：流动 > 深 > 连通', () => {
    const w = fakeWorld([
      [0, 0, 0, 'water', 5],
      [0, -1, 0, 'water'],
      [1, 0, 0, 'water', 4],
    ]);
    expect(classifyWaterAt(w, 0, 0, 0).reason).toContain('正在流动');
  });

  it('isDangerousWaterAt 就是 dangerous 的简写', () => {
    expect(isDangerousWaterAt(SHALLOW, 0, 0, 0)).toBe(false);
    expect(isDangerousWaterAt(SHALLOW, 0, 9, 0)).toBe(false);
  });
});

describe('waterUnderFeet', () => {
  function fakeBot(cells: Cell[], pos: [number, number, number]) {
    const at = fakeWorld(cells);
    const map = new Map<string, { name: string; metadata: number }>();
    for (const [x, y, z, name, level] of cells) {
      map.set(`${x},${y},${z}`, { name, metadata: level ?? 0 });
    }
    return {
      entity: { position: new Vec3(pos[0], pos[1], pos[2]) },
      // 真 mineflayer 会 floored()，这里照做。
      blockAt: (p: { x: number; y: number; z: number }) =>
        map.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', metadata: 0 },
      world: { getBlock: (p: { x: number; y: number; z: number }) => at(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) },
    };
  }

  it('站在深水里 → 危险', () => {
    const bot = fakeBot(
      [
        [0, 64, 0, 'water'],
        [0, 63, 0, 'water'],
        [0, 62, 0, 'stone'],
      ],
      [0.5, 64.2, 0.5],
    );
    expect(waterUnderFeet(bot).dangerous).toBe(true);
  });

  it('站在 1 格浅水里 → 无所谓', () => {
    const bot = fakeBot(
      [
        [0, 64, 0, 'water'],
        [0, 63, 0, 'stone'],
      ],
      [0.5, 64.0, 0.5],
    );
    expect(waterUnderFeet(bot).dangerous).toBe(false);
  });

  it('头在水面上（脚下是水但头那格不是）→ 不算溺水', () => {
    const bot = fakeBot(
      [
        [0, 64, 0, 'water'],
        [0, 63, 0, 'water'],
        [0, 62, 0, 'stone'],
        // 头那一格（64 + 1.6 → 65）是空气
      ],
      [0.5, 64.2, 0.5],
    );
    expect(waterUnderFeet(bot).dangerous).toBe(true); // 身体在深水里
    expect(headInWater(bot)).toBe(false);             // 但头露出来了
  });

  it('头也进水 → 真的开始溺水了', () => {
    const bot = fakeBot(
      [
        [0, 64, 0, 'water'],
        [0, 65, 0, 'water'],
        [0, 66, 0, 'water'],
      ],
      [0.5, 64.2, 0.5],
    );
    expect(headInWater(bot)).toBe(true);
  });

  it('没有 entity / 坐标是垃圾 → 当没水，不炸', () => {
    expect(waterUnderFeet(null).dangerous).toBe(false);
    expect(waterUnderFeet({}).dangerous).toBe(false);
    expect(waterUnderFeet({ entity: {} }).dangerous).toBe(false);
    expect(waterUnderFeet({ entity: { position: { x: 'x', y: null, z: 0 } } }).dangerous).toBe(false);
  });
});

describe('dangerousWaterRefusal（落点闸门）', () => {
  /**
   * 落点是水的假 bot。`/tp` 传送那条分支完全不走寻路，所以**只有这一道闸**
   * 挡得住它——路径层的 blocksToAvoid 在传送面前等于不存在。
   */
  function botWith(cells: Cell[]) {
    const map = new Map<string, { name: string; metadata: number }>();
    for (const [x, y, z, name, level] of cells) {
      map.set(`${x},${y},${z}`, { name, metadata: level ?? 0 });
    }
    return {
      entity: { position: new Vec3(0.5, 70, 0.5) },
      blockAt: (p: { x: number; y: number; z: number }) =>
        map.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? { name: 'air', metadata: 0 },
      world: { getBlock: () => null },
    };
  }

  it('深水落点 → 回执，且说清怎么授权', () => {
    const bot = botWith([
      [5, 64, 5, 'water'],
      [5, 63, 5, 'water'],
      [5, 62, 5, 'stone'],
    ]);
    const text = dangerousWaterRefusal(bot, 5, 64, 5);
    expect(text).not.toBeNull();
    expect(text).toContain('2 格深');
    expect(text).toContain('allowDangerousOps');
    expect(text).toContain('enter_deep_water');
  });

  it('1 格浅水落点 → 放行（null）', () => {
    const bot = botWith([
      [5, 64, 5, 'water'],
      [5, 63, 5, 'stone'],
    ]);
    expect(dangerousWaterRefusal(bot, 5, 64, 5)).toBeNull();
  });

  it('陆地落点 → 放行', () => {
    const bot = botWith([[5, 64, 5, 'grass_block']]);
    expect(dangerousWaterRefusal(bot, 5, 64, 5)).toBeNull();
  });

  it('传送和走路共用同一份判据，只是动词不同', () => {
    const bot = botWith([
      [5, 64, 5, 'water', 3],
      [5, 63, 5, 'stone'],
    ]);
    expect(dangerousWaterRefusal(bot, 5, 64, 5)).toContain('走到');
    expect(dangerousWaterRefusal(bot, 5, 64, 5, '传送到')).toContain('传送到');
  });
});

describe('blockAtFrom', () => {
  it('传真的 Vec3（plain 对象会被 prismarine-world 的 floored() 抛掉）', () => {
    let seen: unknown = null;
    const bot = {
      blockAt: (p: unknown) => {
        seen = p;
        return { name: 'water', metadata: 0 };
      },
    };
    const at = blockAtFrom(bot);
    expect(at(1, 2, 3)?.name).toBe('water');
    // 断言"它是个能 floored() 的坐标"而不是 instanceof：vec3 是 CJS 包，
    // ESM 默认导入下 instanceof 不可靠，而我们要证明的是**不是 plain 对象**
    // ——plain 对象正是会被 prismarine-world 抛掉的那种。
    expect(seen).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(typeof (seen as { floored?: unknown })?.floored).toBe('function');
    expect(Vec3).toBeTypeOf('function');
  });

  it('blockAt 炸了就退到 world.getBlock', () => {
    const bot = {
      blockAt: () => {
        throw new Error('boom');
      },
      world: { getBlock: () => ({ name: 'water', metadata: 0 }) },
    };
    expect(blockAtFrom(bot)(0, 0, 0)?.name).toBe('water');
  });

  it('两条路都没有 → null（当空气，不去猜）', () => {
    expect(blockAtFrom({})(0, 0, 0)).toBeNull();
    expect(blockAtFrom(null)(0, 0, 0)).toBeNull();
  });
});
