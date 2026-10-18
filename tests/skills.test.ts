/**
 * task-2 身体技能回执/行为回归：
 * D2 徒手挖软方块（无镐下界岩口袋逃生）
 * D3 equip 三分法回执
 * D4 垫脚材料按数量选、回执写清剩几个/需要几个
 * D5 放置 vs 清障的意图区分，不推荐刚失败的那个工具
 * D7 手持耐久耗尽要有一句话
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BARE_HAND_MAX_DIG_MS,
  PLACE_TARGET_EMPTY_BLOCKS,
  ateByFacts,
  breakBlockAt,
  choosePillarMaterial,
  choosePillarMaterialChoice,
  consume,
  describeStairJumpFailure,
  equip,
  foodValueOf,
  formatFoodDelta,
  formatFoodState,
  heldToolState,
  isHandMineable,
  isFootingBlock,
  listEdibleItems,
  mineBlockAt,
  pathfindDigPolicy,
  pathfindingDigAbort,
  placeBlock,
  planStairStep,
  runPathfindingInterruptibly,
  stairUp,
  toolBreakNotice,
  toolDurabilityGuard,
  warnLowDurabilityOnce,
} from '../src/body/library/skills.js';

function blockOf(overrides: Record<string, unknown> = {}): any {
  return {
    name: 'netherrack',
    hardness: 0.4,
    diggable: true,
    position: { x: 0, y: 0, z: 0 },
    canHarvest: () => false,
    digTime: () => 2000,
    ...overrides,
  };
}

/** 无镐、生存模式的 bot；dig 立刻成功。 */
function bareHandBot(block: any): any {
  return {
    output: '',
    game: { gameMode: 'survival' },
    heldItem: null,
    entity: { position: { distanceTo: () => 1.5 } },
    blockAt: () => block,
    tool: { equipForBlock: async (): Promise<void> => {} },
    dig: vi.fn(async (): Promise<void> => {}),
    stopDigging: vi.fn(),
    targetDigBlock: null,
    inventory: { items: () => [] },
  };
}

describe('D2 安全：徒手挖不能挖自己的立足点', () => {
  /** 站在 (0.5,64,0.5) 的 netherrack 上，下面是岩浆；空手。 */
  function lavaBelowBot(): any {
    const blockAt = (p: any): any => {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      const z = Math.floor(p.z);
      const key = `${x},${y},${z}`;
      const position = { x, y, z };
      if (key === '0,64,0') return { name: 'netherrack', position, hardness: 0.4, diggable: true, canHarvest: () => false, digTime: () => 2000 };
      if (key === '0,63,0') return { name: 'lava', position };
      if (key === '0,64,1') return { name: 'netherrack', position, hardness: 0.4, diggable: true, canHarvest: () => false, digTime: () => 2000 };
      return { name: 'air', position };
    };
    return {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: null,
      entity: { position: { x: 0.5, y: 64, z: 0.5, distanceTo: (p: any) => Math.hypot(0.5 - p.x, 64 - p.y, 0.5 - p.z) } },
      blockAt,
      tool: { equipForBlock: async (): Promise<void> => {} },
      dig: vi.fn(async (): Promise<void> => {}),
      stopDigging: vi.fn(),
      targetDigBlock: null,
      inventory: { items: () => [] },
    };
  }

  it('isFootingBlock：脚那一格和它下面一格算承重，前方/侧方/头顶不算', () => {
    const feet = { x: 0.5, y: 64, z: 0.5 };
    expect(isFootingBlock(feet, { x: 0, y: 64, z: 0 })).toBe(true);
    expect(isFootingBlock(feet, { x: 0, y: 63, z: 0 })).toBe(true);
    expect(isFootingBlock(feet, { x: 0, y: 64, z: 1 })).toBe(false);
    expect(isFootingBlock(feet, { x: 1, y: 64, z: 0 })).toBe(false);
    expect(isFootingBlock(feet, { x: 0, y: 65, z: 0 })).toBe(false);
    // 坐标读不到时不许误伤（返回 false = 放行）。
    expect(isFootingBlock(undefined, { x: 0, y: 64, z: 0 })).toBe(false);
    expect(isFootingBlock(feet, undefined)).toBe(false);
  });

  it('脚下是 netherrack、下面是岩浆：拒绝挖，回执点名承重块并指向 digDown', async () => {
    const bot = lavaBelowBot();
    await expect(mineBlockAt(bot, 0, 64, 0)).resolves.toBe(false);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.output).toContain('承重');
    expect(bot.output).toContain('digDown');
    expect(bot.output).toContain('岩浆');
  });

  it('支撑自己的那一格（脚下一格）同样拒绝', async () => {
    const bot = lavaBelowBot();
    await expect(mineBlockAt(bot, 0, 63, 0)).resolves.toBe(false);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.output).toContain('承重');
  });

  it('D2 逃生不受影响：往前挖同高度的 netherrack 仍然放行（空手）', async () => {
    const bot = lavaBelowBot();
    await expect(mineBlockAt(bot, 0, 64, 1)).resolves.toBe(true);
    expect(bot.dig).toHaveBeenCalledTimes(1);
  });
});

describe('D2 徒手挖软方块', () => {
  it('isHandMineable：下界岩/泥土/沙/沙砾可以，石头/黑曜石/基岩不行', () => {
    expect(BARE_HAND_MAX_DIG_MS).toBe(3000);
    expect(isHandMineable(blockOf({ name: 'netherrack', hardness: 0.4, digTime: () => 2000 }))).toBe(true);
    expect(isHandMineable(blockOf({ name: 'dirt', hardness: 0.5, digTime: () => 2500 }))).toBe(true);
    expect(isHandMineable(blockOf({ name: 'sand', hardness: 0.5, digTime: () => 2500 }))).toBe(true);
    expect(isHandMineable(blockOf({ name: 'gravel', hardness: 0.6, digTime: () => 3000 }))).toBe(true);
    expect(isHandMineable(blockOf({ name: 'stone', hardness: 1.5, digTime: () => 7500 }))).toBe(false);
    expect(isHandMineable(blockOf({ name: 'obsidian', hardness: 50, digTime: () => 250000 }))).toBe(false);
    // 没有 digTime 时按 硬度 × 5s 兜底。
    expect(isHandMineable({ name: 'netherrack', hardness: 0.4 })).toBe(true);
    expect(isHandMineable({ name: 'stone', hardness: 1.5 })).toBe(false);
    // -1 = 不可破坏；digTime 为 Infinity 也不能放行。
    expect(isHandMineable({ name: 'bedrock', hardness: -1 })).toBe(false);
    expect(isHandMineable(blockOf({ digTime: () => Infinity }))).toBe(false);
    expect(isHandMineable(null)).toBe(false);
  });

  it('mineBlock 无镐挖下界岩：放行 + 空手回执 + 真的 dig 了', async () => {
    const bot = bareHandBot(blockOf());
    await expect(mineBlockAt(bot, 0, 0, 0)).resolves.toBe(true);
    expect(bot.dig).toHaveBeenCalledTimes(1);
    expect(bot.output).toContain('没有能挖 netherrack 的工具（手持 空手）');
    expect(bot.output).toContain('空手挖');
    expect(bot.output).toContain('挖掉了 netherrack');
  });

  it('mineBlock 无镐挖深板岩：仍旧拒绝，不白等超时', async () => {
    const bot = bareHandBot(blockOf({ name: 'deepslate', hardness: 3, digTime: () => 15000 }));
    await expect(mineBlockAt(bot, 0, 0, 0)).resolves.toBe(false);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.output).toContain('没有能挖 deepslate 的工具');
    expect(bot.output).not.toContain('空手挖');
  });

  it('breakBlockAt（digDown/pillarUp 的开路原语）同样允许徒手挖软方块', async () => {
    const bot = bareHandBot(blockOf());
    await expect(breakBlockAt(bot, 0, 0, 0)).resolves.toBe(true);
    expect(bot.output).toContain('它硬度低，改用空手挖');
    expect(bot.output).toContain('Broke netherrack');
  });

  it('breakBlockAt 对硬方块仍旧拒绝', async () => {
    const bot = bareHandBot(blockOf({ name: 'stone', hardness: 1.5, digTime: () => 7500 }));
    await expect(breakBlockAt(bot, 0, 0, 0)).resolves.toBe(false);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.output).toContain('没有能挖 stone 的工具');
  });
});

describe('A 寻路看门狗只问"挖不挖得穿"，不问"有没有掉落"', () => {
  it('无镐挖得动的软方块（下界岩）不打断寻路', () => {
    expect(pathfindingDigAbort(blockOf({ name: 'netherrack', hardness: 0.4, digTime: () => 2000 }))).toBe(false);
    // 石头只是慢（徒手 7.5s），不是挖不动：也不该把路判死。
    expect(pathfindingDigAbort(blockOf({ name: 'stone', hardness: 1.5, digTime: () => 7500 }))).toBe(false);
  });

  it('真挖不动才停：基岩 / diggable=false / digTime=Infinity', () => {
    expect(pathfindingDigAbort(blockOf({ name: 'bedrock', hardness: -1, digTime: () => Infinity }))).toBe(true);
    expect(pathfindingDigAbort(blockOf({ name: 'barrier', hardness: -1, diggable: false }))).toBe(true);
    expect(pathfindingDigAbort(blockOf({ name: 'bogus', diggable: false }))).toBe(true);
  });
});

describe('D3 equip 三分法回执', () => {
  function botWith(slots: unknown[], held: unknown = null): any {
    return {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: held,
      inventory: {
        slots,
        findInventoryItem: (name: string) => slots.find((s: any) => s?.name === name) ?? null,
        items: () => slots.filter((s: any) => s != null),
      },
      equip: vi.fn(async (): Promise<void> => {}),
    };
  }

  it('东西不在背包也不在快捷栏：明说是真的没有，不是"没换到手"', async () => {
    const bot = botWith([]);
    await expect(equip(bot, 'iron_pickaxe')).resolves.toBe(false);
    expect(bot.output).toContain('你根本没有 iron_pickaxe');
    expect(bot.output).toContain('背包和快捷栏');
  });

  it('东西在主背包（9-35）：说清是从背包拿到手上，并且真的换了手', async () => {
    const item = { name: 'iron_pickaxe', count: 1, slot: 12 };
    const bot = botWith([item]);
    await expect(equip(bot, 'iron_pickaxe')).resolves.toBe(true);
    expect(bot.equip).toHaveBeenCalledWith(item, 'hand');
    expect(bot.output).toContain('从背包把 iron_pickaxe 拿到手上');
  });

  it('东西在快捷栏（36-44）：说清是从快捷栏拿的', async () => {
    const item = { name: 'iron_pickaxe', count: 1, slot: 40 };
    const bot = botWith([item]);
    await expect(equip(bot, 'iron_pickaxe')).resolves.toBe(true);
    expect(bot.equip).toHaveBeenCalledWith(item, 'hand');
    expect(bot.output).toContain('从快捷栏把 iron_pickaxe 拿到手上');
  });

  it('已经拿在手上：不用再换一次', async () => {
    const held = { name: 'iron_pickaxe', count: 1 };
    const bot = botWith([held], held);
    await expect(equip(bot, 'iron_pickaxe')).resolves.toBe(true);
    expect(bot.equip).not.toHaveBeenCalled();
    expect(bot.output).toContain('已经拿在手上');
  });
});

describe('D4 垫脚材料按数量选', () => {
  it('100 个深板岩 vs 2 个木板：选深板岩（不再挑只剩 2 个的）', () => {
    const items = [{ name: 'oak_planks', count: 2 }, { name: 'cobbled_deepslate', count: 100 }];
    expect(choosePillarMaterial(items, 6)).toBe('cobbled_deepslate');
  });

  it('同一物品的多个堆要合并计数', () => {
    const items = [{ name: 'cobblestone', count: 30 }, { name: 'cobblestone', count: 34 }, { name: 'oak_planks', count: 40 }];
    const choice = choosePillarMaterialChoice(items, 6);
    expect(choice?.name).toBe('cobblestone');
    expect(choice?.count).toBe(64);
    expect(choice?.shortfall).toBe(false);
  });

  it('不够步数的材料要排除；全都不够时退而选最多的并标记 shortfall', () => {
    const items = [{ name: 'oak_planks', count: 2 }, { name: 'dirt', count: 3 }];
    const choice = choosePillarMaterialChoice(items, 6);
    expect(choice?.name).toBe('dirt');
    expect(choice?.count).toBe(3);
    expect(choice?.shortfall).toBe(true);
  });

  it('非方块（煤/铁锭/燧石）不能当垫脚材料', () => {
    // 运行时真源是 bot.registry.blocksByName（带 boundingBox）：表里没有就不是方块。
    const registry = {
      cobblestone: { boundingBox: 'block' },
      torch: { boundingBox: 'empty' },
    };
    const items = [{ name: 'coal', count: 64 }, { name: 'raw_iron', count: 32 }, { name: 'flint', count: 10 }];
    expect(choosePillarMaterial(items, 2, registry)).toBeNull();
    // 火把在注册表里但放不成整块，也要排除。
    expect(choosePillarMaterial([{ name: 'torch', count: 64 }, { name: 'cobblestone', count: 2 }], 2, registry)).toBe('cobblestone');
  });

  it('火把/水桶/食物仍然排除，空背包返回 null', () => {
    expect(choosePillarMaterial([{ name: 'torch', count: 3 }, { name: 'cobblestone', count: 2 }])).toBe('cobblestone');
    expect(choosePillarMaterial([{ name: 'water_bucket', count: 1 }, { name: 'bread', count: 5 }])).toBeNull();
    expect(choosePillarMaterial([])).toBeNull();
    expect(choosePillarMaterial(null)).toBeNull();
  });
});

describe('D7 工具坏了要有一句话', () => {
  it('耐久耗尽消失且背包没存货：报出物品名和耐久读数', () => {
    const before = { name: 'iron_pickaxe', used: 250, max: 251, count: 1 };
    const bot = { heldItem: null, inventory: { items: () => [] } };
    const notice = toolBreakNotice(before as any, bot);
    expect(notice).toContain('iron_pickaxe');
    expect(notice).toContain('250/251');
    expect(notice).toContain('耐久耗尽');
  });

  it('自动拾取顶掉主手（物品还在背包里）：不误报成损坏', () => {
    const before = { name: 'iron_pickaxe', used: 250, max: 251, count: 1 };
    const bot = {
      heldItem: { name: 'flint_and_steel', count: 1 },
      inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    };
    expect(toolBreakNotice(before as any, bot)).toBeNull();
  });

  it('背包数读不到：宁可漏报', () => {
    const before = { name: 'iron_pickaxe', used: 250, max: 251, count: null };
    expect(toolBreakNotice(before as any, { heldItem: null })).toBeNull();
  });

  it('heldToolState 汇总同名堆', () => {
    const bot = {
      heldItem: { name: 'iron_pickaxe', count: 1, durabilityUsed: 10, maxDurability: 251 },
      inventory: { items: () => [{ name: 'iron_pickaxe', count: 2 }, { name: 'coal', count: 5 }] },
    };
    expect(heldToolState(bot)).toEqual({ name: 'iron_pickaxe', used: 10, max: 251, count: 2 });
  });

  it('max=1（真机读数）回退注册表拿到真上限，保护不静默失效', () => {
    const bot = {
      heldItem: { name: 'stone_pickaxe', count: 1, durabilityUsed: 95, maxDurability: 1 },
      inventory: { items: () => [{ name: 'stone_pickaxe', count: 1 }] },
      registry: { itemsByName: { stone_pickaxe: { maxDurability: 131 } } },
    };
    expect(heldToolState(bot).max).toBe(131);
    expect(toolDurabilityGuard(bot).remaining).toBe(36);
    expect(toolDurabilityGuard(bot).low).toBe(false);
  });

  it('max 完全读不到：不编数，低耐久保护也不误报', () => {
    const bot = {
      heldItem: { name: 'stone_pickaxe', count: 1, durabilityUsed: 95 },
      inventory: { items: () => [] },
    };
    expect(heldToolState(bot).max).toBeNull();
    expect(toolDurabilityGuard(bot).remaining).toBeNull();
    expect(toolDurabilityGuard(bot).low).toBe(false);
  });
});

describe('E 破坏性寻路别烧光工具', () => {
  it('toolDurabilityGuard：剩余 <=20 次或 <15% 算低', () => {
    const low = toolDurabilityGuard({ heldItem: { name: 'wooden_pickaxe', durabilityUsed: 50, maxDurability: 60 } });
    expect(low.remaining).toBe(10);
    expect(low.low).toBe(true);

    const healthy = toolDurabilityGuard({ heldItem: { name: 'iron_pickaxe', durabilityUsed: 50, maxDurability: 251 } });
    expect(healthy.remaining).toBe(201);
    expect(healthy.low).toBe(false);

    // 上限读不到（读到的是 stackSize）不算数，不能据此报警。
    const junk = toolDurabilityGuard({ heldItem: { name: 'stone_pickaxe', durabilityUsed: 35, maxDurability: 1 } });
    expect(junk.remaining).toBeNull();
    expect(junk.low).toBe(false);
    expect(toolDurabilityGuard({}).low).toBe(false);
  });

  it('pathfindDigPolicy：低耐久不选破坏性路线、挖格代价抬高', () => {
    const policy = pathfindDigPolicy(
      toolDurabilityGuard({ heldItem: { name: 'wooden_pickaxe', durabilityUsed: 59, maxDurability: 60 } }),
    );
    expect(policy.allowDestructiveProbe).toBe(false);
    expect(policy.digCost).toBeGreaterThan(10);
    expect(policy.note).toContain('不破坏地形');
    expect(policy.note).toContain('wooden_pickaxe');

    const healthy = pathfindDigPolicy(
      toolDurabilityGuard({ heldItem: { name: 'iron_pickaxe', durabilityUsed: 10, maxDurability: 251 } }),
    );
    expect(healthy.allowDestructiveProbe).toBe(true);
    expect(healthy.digCost).toBe(5);
    expect(healthy.note).toBeNull();

    // 空手不拦：没有耐久可烧，徒手挖软方块正是 D2 的逃生路径。
    expect(pathfindDigPolicy(toolDurabilityGuard({})).allowDestructiveProbe).toBe(true);
  });

  it('warnLowDurabilityOnce：第一次跌破报一次，换回健康工具后复位', () => {
    const bot: any = {
      output: '',
      heldItem: { name: 'golden_pickaxe', durabilityUsed: 30, maxDurability: 33 },
      inventory: { items: () => [] },
    };
    const first = warnLowDurabilityOnce(bot);
    expect(first).toContain('耐久不多了');
    expect(bot.output).toContain('耐久不多了');

    // 同一次低耐久不刷屏。
    bot.output = '';
    expect(warnLowDurabilityOnce(bot)).toBeNull();
    expect(bot.output).toBe('');

    // 换回健康工具：复位，之后再跌破还会报。
    bot.heldItem = { name: 'iron_pickaxe', durabilityUsed: 10, maxDurability: 251 };
    expect(warnLowDurabilityOnce(bot)).toBeNull();
    bot.heldItem = { name: 'golden_pickaxe', durabilityUsed: 28, maxDurability: 33 };
    expect(warnLowDurabilityOnce(bot)).toContain('还剩 5 次');
  });

  it('寻路中工具坏了：回执说清哪把、挖了几格、下一步怎么办', async () => {
    let items: Array<{ name: string; count: number }> = [{ name: 'wooden_pickaxe', count: 1 }];
    let dugHandler: (() => void) | null = null;
    const bot: any = {
      output: '',
      interrupt_code: false,
      heldItem: { name: 'wooden_pickaxe', count: 1, durabilityUsed: 59, maxDurability: 60 },
      inventory: { items: () => items },
      on: (event: string, fn: () => void): void => {
        if (event === 'diggingCompleted') dugHandler = fn;
      },
      removeListener: (): void => {
        dugHandler = null;
      },
      pathfinder: {
        goto: async (): Promise<void> => {
          dugHandler?.();
          dugHandler?.();
          items = [];
          bot.heldItem = null;
        },
      },
    };
    await expect(runPathfindingInterruptibly(bot, {})).resolves.toBe(true);
    expect(bot.output).toContain('wooden_pickaxe');
    expect(bot.output).toContain('耐久耗尽');
    expect(bot.output).toContain('挖了约 2 格');
    // 计数器要摘掉，不能影响下一次寻路。
    expect(dugHandler).toBeNull();
  });

  it('寻路正常（工具没坏）：不产生噪音', async () => {
    const bot: any = {
      output: '',
      interrupt_code: false,
      heldItem: { name: 'iron_pickaxe', count: 1, durabilityUsed: 10, maxDurability: 251 },
      inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
      on: (): void => {},
      removeListener: (): void => {},
      pathfinder: { goto: async (): Promise<void> => {} },
    };
    await expect(runPathfindingInterruptibly(bot, {})).resolves.toBe(true);
    expect(bot.output).not.toContain('耐久耗尽');
    expect(bot.output).not.toContain('坏掉');
  });
});

describe('F-10 垂直上行：2 格高通道里为什么跳不上去', () => {
  const accessor = (blocks: Record<string, string>) => (x: number, y: number, z: number) =>
    blocks[x + ',' + y + ',' + z] ? { name: blocks[x + ',' + y + ',' + z] } : null;

  it('原地头顶第 2 格是实心：先挖开自己的天花板腾跳跃空间', () => {
    const plan = planStairStep(
      accessor({ '0,1,0': 'air', '0,2,0': 'netherrack', '1,1,0': 'air', '1,0,0': 'air' }),
      { x: 0, y: 0, z: 0 },
      1,
      0,
    );
    expect(plan).toEqual({ kind: 'mine', target: { x: 0, y: 2, z: 0 } });
  });

  it('落点上方那一格是实心：挖它（站上去要占两格）', () => {
    const plan = planStairStep(
      accessor({ '0,1,0': 'air', '0,2,0': 'air', '1,1,0': 'air', '1,0,0': 'stone', '1,2,0': 'netherrack' }),
      { x: 0, y: 0, z: 0 },
      1,
      0,
    );
    expect(plan).toEqual({ kind: 'mine', target: { x: 1, y: 2, z: 0 } });
  });

  it('头顶读不到（null）时不预判，照原样继续', () => {
    const plan = planStairStep(
      accessor({ '0,1,0': 'air', '1,1,0': 'air', '1,0,0': 'air' }),
      { x: 0, y: 0, z: 0 },
      1,
      0,
    );
    expect(plan.kind).toBe('place_step');
  });

  it('失败回执说出真原因：天花板不够高，而不是"可能被挡"', () => {
    const twoHigh = describeStairJumpFailure(
      accessor({ '0,2,0': 'netherrack', '1,2,0': 'netherrack' }),
      { x: 0, y: 0, z: 0 },
      1,
      0,
    );
    expect(twoHigh).toContain('头顶第 2 格是 netherrack');
    expect(twoHigh).toContain('3 格净空');
    expect(twoHigh).toContain('mineBlock');

    const open = describeStairJumpFailure(accessor({}), { x: 0, y: 0, z: 0 }, 1, 0);
    expect(open).toContain('前方被挡或落差太大');
  });
});

describe('F-10 第二半：前方放不下就改用 pillarUp 直着垫', () => {
  /** 窄通道/悬空：前方那一格六个面都是空气（nothing to place on），只有脚下是实心。 */
  function fallbackBot(opts: { noSupport?: boolean } = {}): any {
    const placedAt = new Set<string>();
    const slots: any[] = [];
    slots[40] = { name: 'netherrack', count: 5, slot: 40 };
    const items = [{ name: 'netherrack', count: 5 }];
    const mkPos = (x: number, y: number, z: number): any => {
      const p: any = { x, y, z };
      p.plus = (v: any): any => mkPos(p.x + v.x, p.y + v.y, p.z + v.z);
      p.distanceTo = (o: any): number => Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z);
      p.clone = (): any => mkPos(p.x, p.y, p.z);
      p.offset = (dx: number, dy: number, dz: number): any => mkPos(p.x + dx, p.y + dy, p.z + dz);
      return p;
    };
    const bot: any = {
      output: '',
      interrupt_code: false,
      game: { gameMode: 'survival' },
      entity: { position: mkPos(0.5, 64, 0.5), yaw: 0, onGround: true },
      inventory: {
        items: () => items,
        slots,
        findInventoryItem: (n: string) => slots.find((s: any) => s?.name === n) ?? null,
      },
      heldItem: null,
      tool: { equipForBlock: async (): Promise<void> => {} },
      registry: { blocksByName: { netherrack: { boundingBox: 'block' }, bedrock: { boundingBox: 'block' } } },
      blockAt: (p: any) => {
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        const z = Math.floor(p.z);
        const key = `${x},${y},${z}`;
        const position = mkPos(x, y, z);
        if (placedAt.has(key)) return { name: 'netherrack', position };
        // 脚下那一格是唯一实心：pillarUp 依附它，stairUp 的前方那一格四周全空。
        // noSupport：连脚下都没有——两条路都放不下，用来测"两次都失败"。
        if (opts.noSupport !== true && key === '0,63,0') return { name: 'netherrack', position };
        return { name: 'air', position };
      },
      setControlState: (control: string, on: boolean) => {
        if (control === 'jump' && on) {
          bot.entity.position.y = 65.3;   // 起跳后 >1.1 格，避开"太近先走开"分支
          bot.entity.onGround = false;
        }
        if (control === 'jump' && !on) bot.entity.onGround = true;
      },
      equip: async (item: any): Promise<void> => {
        bot.heldItem = item;
      },
      placeBlock: async (): Promise<void> => {
        placedAt.add('0,64,0');
      },
      pathfinder: { setMovements: (): void => {}, stop: (): void => {} },
      on: (): void => {},
      removeListener: (): void => {},
    };
    return bot;
  }

  it('前方垫不上（nothing to place on）：自动 pillarUp 垫高 1 格并计入进度', async () => {
    const bot = fallbackBot();
    await expect(stairUp(bot, 1)).resolves.toBe(true);
    expect(bot.output).toContain('nothing to place on');
    expect(bot.output).toContain('nothing to place on');
    expect(bot.output).toContain('改用 pillarUp');
    expect(bot.output).toContain('pillarUp 完成：上升 1 格');
    expect(bot.output).toContain('stairUp 完成：上升 1 格');
  });

  it('pillarUp 也不成（连脚下都没有依附面）：停下并说清两条路都失败', async () => {
    const bot = fallbackBot({ noSupport: true });
    await expect(stairUp(bot, 1)).resolves.toBe(false);
    expect(bot.output).toContain('改用 pillarUp');
    expect(bot.output).toContain('pillarUp 第 1 格失败');
    expect(bot.output).toContain('stairUp 停止：垫脚失败，pillarUp 也没能上升');
  });
});

describe('D5 放置 vs 清障的意图区分', () => {
  function placeBot(nameAt: (key: string) => string): any {
    const blockAt = (p: any): any => {
      const x = Math.floor(p.x);
      const y = Math.floor(p.y);
      const z = Math.floor(p.z);
      return { name: nameAt(`${x},${y},${z}`), position: { x, y, z } };
    };
    return {
      output: '',
      game: { gameMode: 'survival' },
      entity: { position: { x: 0.5, y: 64, z: 0.5 } },
      blockAt,
      inventory: { findInventoryItem: (n: string) => ({ name: n, count: 1, slot: 36 }) },
      equip: async (): Promise<void> => {},
    };
  }

  it('cave_air / void_air 也是空格（洞穴里的空格不叫 air）', () => {
    expect(PLACE_TARGET_EMPTY_BLOCKS).toContain('air');
    expect(PLACE_TARGET_EMPTY_BLOCKS).toContain('cave_air');
    expect(PLACE_TARGET_EMPTY_BLOCKS).toContain('void_air');
  });

  it('放置请求被清障安全规则拒绝：说"放置"、给别的落点，不再推荐 placeHere', async () => {
    const bot = placeBot((key) => (key === '0,63,0' ? 'deepslate' : key === '0,62,0' ? 'stone' : 'air'));
    await expect(placeBlock(bot, 'cobblestone', 0, 63, 0)).resolves.toBe(false);
    expect(bot.output).toContain('拒绝清障');
    expect(bot.output).toContain('**放置**请求');
    expect(bot.output).toContain('placeBlock 指定别的坐标');
    expect(bot.output).not.toContain('或用 placeHere');
  });

  it('拆方块请求被拒：说"拆"，与放置意图分开', async () => {
    const bot = placeBot((key) => (key === '0,63,0' ? 'deepslate' : key === '0,62,0' ? 'stone' : 'air'));
    await expect(placeBlock(bot, 'air', 0, 63, 0)).resolves.toBe(false);
    expect(bot.output).toContain('拒绝拆掉');
    expect(bot.output).toContain('拆方块');
  });

  it('站在 cave_air 里 placeHere：不再被误判成"拆承重块"', async () => {
    const bot = placeBot(() => 'cave_air');
    await expect(placeBlock(bot, 'netherrack', 0, 64, 0)).resolves.toBe(false);
    expect(bot.output).not.toContain('拒绝清障');
    expect(bot.output).toContain('nothing to place on');
  });
});

// ─────────── consume：超时不许只丢一段堆栈（overnight_b 15:58 反馈） ───────────
//
// 真机：`consume(mutton)` → `!!Action threw exception!! Promise timed out`，同时
// 手上 mutton 还在、food 仍 14/sat 0。模型没有事实可判断（换食物？跑？），只能在
// 挨打时原地重复。这里钉的就是"失败也要给事实 + 一条下一步"。

/** 假 bot：只实现 consume 用到的表面（food/sat 可读写，背包可读）。 */
function consumeBot(
  options: {
    held?: Array<{ name: string; count: number }>;
    food?: number;
    saturation?: number;
    consume?: () => Promise<void>;
  } = {},
): any {
  const items = options.held ?? [];
  return {
    output: '',
    food: options.food ?? 14,
    foodSaturation: options.saturation ?? 0,
    inventory: {
      items: () => items,
      findInventoryItem: (name: string) => items.find((i) => i.name === name),
    },
    equip: vi.fn(async (): Promise<void> => {}),
    consume: vi.fn(options.consume ?? (async (): Promise<void> => {})),
  };
}

/** 测试里不真的等同步/退避。 */
const NO_WAIT = { resyncMs: 0, retryBackoffMs: 0 };

describe('consume：失败也要给事实，不给堆栈', () => {
  it('吃成了：数量 -1、饱食度真的涨了（判定靠事实，不是"没抛错"）', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 1 }] });
    bot.consume = vi.fn(async () => {
      bot.food = 20;
      bot.foodSaturation = 9.6;
      bot.inventory.items()[0].count = 0;
    });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(true);
    expect(bot.output).toContain('吃成了');
    expect(bot.output).toContain('手上 1 → 0');
    expect(bot.output).toContain('food 14/sat 0 → food 20/sat 9.6');
  });

  it('同步超时且东西还在 → "没吃成/还在手上/可重试"，且回执里没有堆栈', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 1 }] });
    bot.consume = vi.fn(async () => {
      throw new Error('Promise timed out.');
    });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('没吃成');
    expect(bot.output).toContain('还在手上');
    expect(bot.output).toContain('可以重试');
    expect(bot.output).toContain('等待服务端回应超时');
    expect(bot.output).toContain('food 14/sat 0 → food 14/sat 0（没有变化）');
    // **绝不把原始异常/堆栈当回执**
    expect(bot.output).not.toContain('!!Action threw exception!!');
    expect(bot.output).not.toContain('Stack trace');
    expect(bot.output).not.toContain('at Object.');
    // 自动重试了一次（1 次正常 + 1 次重试）
    expect(bot.consume).toHaveBeenCalledTimes(2);
    // 下一步是**一条**能照抄的调用
    expect(bot.output.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：consume(item_name="mutton")');
  });

  it('第一次超时 + 第二次成功 → 回执写明"重试后吃成了"，且重试前重新 equip', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 2 }] });
    let calls = 0;
    bot.consume = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Promise timed out.');
      bot.food = 20;
      bot.foodSaturation = 9.6;
    });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(bot.output).toContain('重试');
    expect(bot.output).toContain('吃成了');
    expect(bot.output).toContain('food 14/sat 0 → food 20/sat 9.6');
    // 重试前确认食物还在手上 → 再 equip 一次
    expect(bot.equip).toHaveBeenCalledTimes(2);
  });

  it('手里没有该食物 → 点名缺什么，并给"换一种"的一条调用', async () => {
    const bot = consumeBot({ held: [{ name: 'bread', count: 2 }] });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('背包里没有 mutton');
    expect(bot.output).toContain('breadx2');
    expect(bot.output.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：consume(item_name="bread")');
    expect(bot.consume).not.toHaveBeenCalled();
  });

  it('调用没报错但数值没变 → 如实说"没生效"，且不重复吃', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 2 }] });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('没生效');
    expect(bot.output).not.toContain('吃成了');
    expect(bot.output).toContain('手上 2 → 2');
    expect(bot.output).toContain('food 14/sat 0 → food 14/sat 0（没有变化）');
    // 没报错就不重试：重复吃会白白浪费食物
    expect(bot.consume).toHaveBeenCalledTimes(1);
  });

  it('读不到饥饿值也读不到数量 → 说"无法确认"，不假装吃成了', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 1 }] });
    delete bot.food;
    delete bot.foodSaturation;
    bot.inventory.items = () => undefined;

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('无法确认');
    expect(bot.output).not.toContain('吃成了');
  });

  it('饱食度读不到但手上确实少了一个 → 按"少了一个"的事实算吃成（说明读数没同步）', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 1 }] });
    delete bot.food;
    delete bot.foodSaturation;
    bot.consume = vi.fn(async () => {
      bot.inventory.items()[0].count = 0;
    });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(true);
    expect(bot.output).toContain('手上 1 → 0');
    expect(bot.output).toContain('饱食度读数没变');
  });
});

describe('consume 的食物判定（纯函数）', () => {
  it('mutton / raw_mutton 两个版本的命名都认', () => {
    expect(foodValueOf('mutton')).toEqual([2, 1.8]);
    expect(foodValueOf('raw_mutton')).toEqual([2, 1.8]);
    expect(foodValueOf('minecraft:cooked_beef')).toEqual([8, 12.8]);
    expect(foodValueOf('porkchop')).toEqual([3, 1.8]);
    expect(foodValueOf('stone')).toBeNull();
    expect(foodValueOf('')).toBeNull();
  });

  it('ateByFacts：只有真实变化才算吃进去，读不到不算证据', () => {
    expect(ateByFacts({ food: 14, saturation: 0 }, { food: 20, saturation: 0 }, 1, 1)).toBe(true);
    expect(ateByFacts({ food: 20, saturation: 0 }, { food: 20, saturation: 9.6 }, 1, 1)).toBe(true);
    expect(ateByFacts({ food: 14, saturation: 0 }, { food: 14, saturation: 0 }, 2, 1)).toBe(true);
    expect(ateByFacts({ food: 14, saturation: 0 }, { food: 14, saturation: 0 }, 1, 1)).toBe(false);
    expect(ateByFacts({ food: null, saturation: null }, { food: null, saturation: null }, null, null)).toBe(false);
  });

  it('回执格式：吃前→吃后逐字可核，没变化要明说', () => {
    expect(formatFoodDelta({ food: 14, saturation: 0 }, { food: 20, saturation: 9.6 })).toBe(
      'food 14/sat 0 → food 20/sat 9.6',
    );
    expect(formatFoodDelta({ food: 14, saturation: 0 }, { food: 14, saturation: 0 })).toBe(
      'food 14/sat 0 → food 14/sat 0（没有变化）',
    );
    expect(formatFoodState({ food: null, saturation: null })).toBe('food 读不到/sat 读不到');
  });

  it('listEdibleItems：只列能吃的，按"值不值得吃"排序，带数量', () => {
    const bot = consumeBot({
      held: [
        { name: 'stone', count: 64 },
        { name: 'mutton', count: 2 },
        { name: 'cooked_beef', count: 1 },
      ],
    });
    expect(listEdibleItems(bot).map((e) => `${e.name}x${e.count}`)).toEqual(['cooked_beefx1', 'muttonx2']);
  });
});
