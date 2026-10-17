/**
 * task-9 的交互层修复：
 *   1) nearestReachableBlock 改手动 blockAt 扫描——1 格外的方块、刚放下的方块都要找到；
 *      旧实现依赖 bot.findBlocks，真机上工作台就在 1 米外/刚放下却报"身边 4 格内没有"。
 *   2) planAggregateFuel 按全背包求和统计燃料——14 煤分散几堆不能再报"need 2 coal"。
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { fuelTier, nearestReachableBlock, planAggregateFuel } from '../src/body/commands/interact.js';

/** 只有 blockAt、没有 findBlocks 的假身体——专门证明新实现不再依赖 findBlocks。 */
function scanBot(blocks: Record<string, string>) {
  return {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (p: any) => ({ name: blocks[`${p.x},${p.y},${p.z}`] ?? 'air' }),
  };
}

describe('nearestReachableBlock：手动 blockAt 扫描', () => {
  it('找到 1 格外的方块（旧实现因为依赖 findBlocks 会漏）', () => {
    const bot = scanBot({ '1,64,0': 'crafting_table' });
    expect(nearestReachableBlock(bot, 'crafting_table')).toEqual({ x: 1, y: 64, z: 0 });
  });

  it('找到刚放下、就在脚边的方块（距离 0）', () => {
    const bot = scanBot({ '0,64,0': 'crafting_table' });
    expect(nearestReachableBlock(bot, 'crafting_table')).toEqual({ x: 0, y: 64, z: 0 });
  });

  it('多块时取最近的一块', () => {
    const bot = scanBot({ '2,64,0': 'crafting_table', '1,64,0': 'crafting_table' });
    expect(nearestReachableBlock(bot, 'crafting_table')).toEqual({ x: 1, y: 64, z: 0 });
  });

  it('超出 maxDistance 的方块不返回', () => {
    const bot = scanBot({ '5,64,0': 'crafting_table' });
    expect(nearestReachableBlock(bot, 'crafting_table')).toBeNull();
  });

  it('名字对不上或读不到身体时安静返回 null', () => {
    const bot = scanBot({ '1,64,0': 'furnace' });
    expect(nearestReachableBlock(bot, 'crafting_table')).toBeNull();
    expect(nearestReachableBlock({}, 'crafting_table')).toBeNull();
  });
});

function fuelBot(items: Array<[string, number[]]>) {
  return {
    inventory: {
      items: () => items.flatMap(([name, counts]) => counts.map((count) => ({ name, count }))),
    },
  };
}

describe('planAggregateFuel：燃料按全背包求和', () => {
  it('★14 个煤分散成 8+6 两堆：烧 16 个只需要 2 个，ok=true', () => {
    const plan = planAggregateFuel(fuelBot([['coal', [8, 6]]]), 16);
    expect(plan).not.toBeNull();
    expect(plan?.name).toBe('coal');
    expect(plan?.available).toBe(14);
    expect(plan?.needed).toBe(2);
    expect(plan?.stacks).toBe(2);
    expect(plan?.ok).toBe(true);
  });

  it('真的不够时报"需要多少、一共只有多少（分几堆）"，ok=false', () => {
    const plan = planAggregateFuel(fuelBot([['coal', [1]]]), 16);
    expect(plan?.available).toBe(1);
    expect(plan?.needed).toBe(2);
    expect(plan?.stacks).toBe(1);
    expect(plan?.ok).toBe(false);
  });

  it('煤不够但木板够时改挑木板，而不是误报失败', () => {
    const plan = planAggregateFuel(fuelBot([['coal', [1]], ['oak_planks', [32]]]), 16);
    expect(plan?.name).toBe('oak_planks');
    expect(plan?.ok).toBe(true);
    // 木板 1.5 个/件 → 烧 16 需要 ceil(16/1.5)=11。
    expect(plan?.needed).toBe(11);
  });

  it('两种都够时优先煤（数字越小越优先）', () => {
    const plan = planAggregateFuel(fuelBot([['coal', [14]], ['oak_planks', [64]]]), 8);
    expect(plan?.name).toBe('coal');
  });

  it('原木按 1.5 计算：10 个原木烧 16 个需要 11 个，ok=false', () => {
    const plan = planAggregateFuel(fuelBot([['oak_log', [10]]]), 16);
    expect(plan?.name).toBe('oak_log');
    expect(plan?.needed).toBe(11);
    expect(plan?.ok).toBe(false);
  });

  it('没有任何燃料返回 null（调用方再报"没有燃料"）', () => {
    expect(planAggregateFuel(fuelBot([['dirt', [64]], ['stone', [64]]]), 8)).toBeNull();
    expect(planAggregateFuel({}, 8)).toBeNull();
  });
});

describe('fuelTier：燃料优先级', () => {
  it('煤/木炭/烈焰棒 < 木头 < 煤块/岩浆桶 < 其它', () => {
    expect(fuelTier('coal')).toBeLessThan(fuelTier('oak_log'));
    expect(fuelTier('oak_planks')).toBeLessThan(fuelTier('coal_block'));
    expect(fuelTier('coal_block')).toBeLessThan(fuelTier('dirt'));
  });
});
