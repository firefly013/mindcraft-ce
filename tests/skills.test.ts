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
  BOT_OUTPUT_HEAD_CHARS,
  KILL_WAIT_BUDGET_MS,
  MAX_BOT_OUTPUT_CHARS,
  PLACE_TARGET_EMPTY_BLOCKS,
  ateByFacts,
  attackEntity,
  bestWeaponInInventory,
  breakBlockAt,
  capBotOutput,
  choosePillarMaterial,
  choosePillarMaterialChoice,
  consume,
  describeKillGiveUp,
  describeStairJumpFailure,
  digWithTimeout,
  equip,
  foodValueOf,
  formatFoodDelta,
  formatFoodState,
  heldToolState,
  isFootingBlock,
  requiresHarvestTool,
  listEdibleItems,
  log,
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
  entityPresentById,
  classifyKillEvidence,
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
    expect(bot.output).toContain('脚下的承重方块');
    expect(bot.output).not.toContain('digDown');
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
  it('判据是「要不要工具」，不是「徒手快不快」', () => {
    // 不需要工具（原版 harvestTools 为空）：空手也有掉落，直接挖。
    expect(requiresHarvestTool(blockOf({ name: 'dirt', hardness: 0.5 }))).toBe(false);
    expect(requiresHarvestTool(blockOf({ name: 'sand', hardness: 0.5 }))).toBe(false);
    expect(requiresHarvestTool(blockOf({ name: 'oak_log', hardness: 2 }))).toBe(false);
    // 需要工具（**下界岩要镐**——空手挖得开但一个也不掉；石头同理）。
    expect(requiresHarvestTool(blockOf({ name: 'netherrack', hardness: 0.4, harvestTools: { 11: true } }))).toBe(true);
    expect(requiresHarvestTool(blockOf({ name: 'stone', hardness: 1.5, harvestTools: { 11: true } }))).toBe(true);
    // 读不到就当作"不需要工具"：宁可让 dig 自己试，也不凭读不到的数封路。
    expect(requiresHarvestTool(null)).toBe(false);
    expect(requiresHarvestTool({ name: 'mystery' })).toBe(false);
  });

  it('mineBlock 无镐挖泥土：放行（不需要工具）+ 真的 dig 了', async () => {
    const bot = bareHandBot(blockOf({ name: 'dirt', hardness: 0.5, harvestTools: undefined }));
    await expect(mineBlockAt(bot, 0, 0, 0)).resolves.toBe(true);
    expect(bot.dig).toHaveBeenCalledTimes(1);
    expect(bot.output).toContain('挖掉了 dirt');
  });

  it('mineBlock 无镐挖下界岩：**拒**（它要镐），并给出 force 这条出路', async () => {
    const bot = bareHandBot(blockOf({ name: 'netherrack', hardness: 0.4, harvestTools: { 11: true } }));
    await expect(mineBlockAt(bot, 0, 0, 0)).resolves.toBe(false);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.output).toContain('没有能挖 netherrack 的工具');
    expect(bot.output).not.toContain('force=true');
  });

  it('mineBlock 无镐挖深板岩：仍旧拒绝，不白等超时', async () => {
    const bot = bareHandBot(blockOf({ name: 'deepslate', hardness: 3, harvestTools: { 11: true }, digTime: () => 15000 }));
    await expect(mineBlockAt(bot, 0, 0, 0)).resolves.toBe(false);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.output).toContain('没有能挖 deepslate 的工具');
    expect(bot.output).not.toContain('挖掉了');
  });

  it('breakBlockAt（digDown/pillarUp 的开路原语）同样放行不需要工具的方块', async () => {
    const bot = bareHandBot(blockOf({ name: 'dirt', hardness: 0.5, harvestTools: undefined }));
    await expect(breakBlockAt(bot, 0, 0, 0)).resolves.toBe(true);
    expect(bot.output).toContain('Broke dirt');
  });

  it('breakBlockAt 对硬方块仍旧拒绝', async () => {
    const bot = bareHandBot(blockOf({ name: 'stone', hardness: 1.5, harvestTools: { 11: true }, digTime: () => 7500 }));
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
    expect(bot.output).toContain('背包和快捷栏里都没有 iron_pickaxe，并不是没有换到手。');
    expect(bot.output).toContain('背包和快捷栏');
  });

  it('东西在主背包（9-35）：说清是从背包拿到手上，并且真的换了手', async () => {
    const item = { name: 'iron_pickaxe', count: 1, slot: 12 };
    const bot = botWith([item]);
    await expect(equip(bot, 'iron_pickaxe')).resolves.toBe(true);
    expect(bot.equip).toHaveBeenCalledWith(item, 'hand');
    expect(bot.output).toContain('把 iron_pickaxe 装备到了手上上，它是从背包里拿出来的。');
  });

  it('东西在快捷栏（36-44）：说清是从快捷栏拿的', async () => {
    const item = { name: 'iron_pickaxe', count: 1, slot: 40 };
    const bot = botWith([item]);
    await expect(equip(bot, 'iron_pickaxe')).resolves.toBe(true);
    expect(bot.equip).toHaveBeenCalledWith(item, 'hand');
    expect(bot.output).toContain('把 iron_pickaxe 装备到了手上上，它是从快捷栏里拿出来的。');
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
    expect(notice).toContain('手上的 iron_pickaxe 耐久耗尽了，用掉 250 点，一共 25');
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

// 用户 2026-10-28：**耐久不够也先用着，爆了再换**。
// 耐久是每挖完一块扣 1，所以"换"只发生在**下一块开始前**——`digWithTimeout` 一进来
// 就 `ensureHarvestTool`（手里这把能收获就只查一次、不换手）。不存在"挖到一半镐断了"。
describe('D7b 爆了再换：下一块开始前换下一把', () => {
  function miningBot(state: { name: string }) {
    const inv: any[] = [
      { name: 'iron_pickaxe', type: 11, count: 1, durabilityUsed: 250, maxDurability: 251 },
      { name: 'diamond_pickaxe', type: 13, count: 1 },
    ];
    const bot: any = {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: { ...inv[0] },
      entity: { position: { distanceTo: () => 1 } },
      digTime: () => 400,
      blockAt: () => ({
        name: state.name,
        hardness: 1.5,
        diggable: true,
        position: { x: 0, y: 0, z: 0 },
        harvestTools: { 11: true, 13: true },
        canHarvest: (id: number | null) => id === 11 || id === 13,
        digTime: () => 400,
      }),
      inventory: {
        slots: inv,
        items: () => inv.filter((item) => item.count > 0),
        findInventoryItem: (name: string) => inv.find((item) => item.name === name && item.count > 0) ?? null,
      },
      equip: vi.fn(async (item: any) => {
        bot.heldItem = { ...item };
      }),
      dig: vi.fn(async () => {
        // 挖完这一块：铁镐同时烧掉（原版就是挖完扣 1 点耐久，归零即碎，不报错）
        if (bot.heldItem?.name === 'iron_pickaxe') {
          inv[0].count = 0;
          bot.heldItem = null;
        }
        state.name = 'air';
      }),
      stopDigging: vi.fn(),
      targetDigBlock: null,
    };
    return { bot, inv };
  }

  function pickBot(state: { name: string }, digImpl: () => Promise<void>) {
    const inv: any[] = [{ name: 'iron_pickaxe', type: 11, count: 1, durabilityUsed: 10, maxDurability: 251 }];
    return {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: { ...inv[0] },
      entity: { position: { distanceTo: () => 1 } },
      digTime: () => 400,
      blockAt: () => ({
        name: state.name,
        hardness: 1.5,
        diggable: true,
        position: { x: 0, y: 0, z: 0 },
        harvestTools: { 11: true },
        canHarvest: (id: number | null) => id === 11,
        digTime: () => 400,
      }),
      inventory: { slots: inv, items: () => inv, findInventoryItem: () => null },
      equip: vi.fn(async () => {}),
      dig: vi.fn(digImpl),
      stopDigging: vi.fn(),
      targetDigBlock: null,
    } as any;
  }

  it('第一块把铁镐用碎 ⇒ 第二块开始前自动换上钻石镐', async () => {
    const state = { name: 'stone' };
    const { bot } = miningBot(state);

    await expect(digWithTimeout(bot, bot.blockAt(), '@(0,0,0)')).resolves.toBe(true);
    expect(bot.output).toContain('耐久耗尽');
    expect(bot.heldItem).toBeNull();

    state.name = 'stone'; // 下一块
    await expect(digWithTimeout(bot, bot.blockAt(), '@(0,1,0)')).resolves.toBe(true);
    expect(bot.heldItem?.name).toBe('diamond_pickaxe');
    expect(bot.dig).toHaveBeenCalledTimes(2);
  });

  it('空手挖不需要工具的方块（泥土）⇒ 不为了"换手"而换手，也不拦', async () => {
    const state = { name: 'dirt' };
    const bot: any = {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: null,
      entity: { position: { distanceTo: () => 1 } },
      digTime: () => 400,
      blockAt: () => ({
        name: state.name,
        hardness: 0.5,
        diggable: true,
        position: { x: 0, y: 0, z: 0 },
        canHarvest: () => true,
        digTime: () => 400,
      }),
      inventory: { slots: [], items: () => [], findInventoryItem: () => null },
      equip: vi.fn(async () => {}),
      dig: vi.fn(async () => {
        state.name = 'air';
      }),
      stopDigging: vi.fn(),
      targetDigBlock: null,
    };

    await expect(digWithTimeout(bot, bot.blockAt(), '@(0,0,0)')).resolves.toBe(true);
    expect(bot.equip).not.toHaveBeenCalled();
  });

  it('"Digging aborted" 但那一格已经是空气 ⇒ 按挖掉算，不报失败', async () => {
    const state = { name: 'stone' };
    const bot = pickBot(state, async () => {
      state.name = 'air'; // 方块其实已经掉了，只是中断先到
      throw new Error('Digging aborted');
    });

    await expect(digWithTimeout(bot, bot.blockAt(), '@(0,0,0)')).resolves.toBe(true);
    expect(bot.output).toBe('');
  });

  it('"Digging aborted" 且方块还在 ⇒ 照旧返回 false，不写过程日志', async () => {
    const state = { name: 'stone' };
    const bot = pickBot(state, async () => {
      throw new Error('Digging aborted');
    });

    await expect(digWithTimeout(bot, bot.blockAt(), '@(0,0,0)')).resolves.toBe(false);
    expect(bot.output).toBe('');
    expect(state.name).toBe('stone');
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
    expect(policy.note).not.toContain('不破坏地形');
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
    expect(warnLowDurabilityOnce(bot)).toContain('手上的 golden_pickaxe 耐久不多了，还能用 5 次，读数是用');
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
    expect(bot.output).toContain('手上的 wooden_pickaxe 耐久耗尽了，用掉 59 点，一共 6');
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
    expect(bot.output).toContain('stairUp 完成');
  });

  it('y 实测没升 ⇒ 不许报完成（Lead 2026-10-21：进度里 y 不变却写"上升 10 格"）', async () => {
    const bot = fallbackBot();
    const base = bot.entity.position;
    const frozenClone = (): any => Object.assign(Object.create(Object.getPrototypeOf(base)), base, { x: base.x, y: base.y, z: base.z });
    Object.defineProperty(bot.entity, 'position', { get: frozenClone, set: () => {} });
    const result = await stairUp(bot, 1);
    expect(result).toBe(false);
    // 走哪条失败分支都可（blocked/plan/mine），**关键是不许声称完成**。
    expect(bot.output).not.toContain('stairUp 完成');
  });

  it('pillarUp 也不成（连脚下都没有依附面）：停下并说清两条路都失败', async () => {
    const bot = fallbackBot({ noSupport: true });
    await expect(stairUp(bot, 1)).resolves.toBe(false);
    expect(bot.output).toContain('Cannot place netherrack at [object Ob');
    expect(bot.output).toContain('Cannot place netherrack at [object Ob');
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

  // **2026-10-19 收紧**：这一格的坐标 (0,63,0) 正是 bot 站着的承重块 —— 现在由
  // "绝不清掉自己的落脚点"的守卫**先**拒绝（真机 overnight_b 在虚空上方就是这么被拆掉
  // 落脚点的）。原来那条"清障意图"回执仍然存在，但只对**不是自己落脚点**的格子生效。
  it('要清的那一格是自己的落脚点 ⇒ 由落脚点守卫拒绝（比清障规则更早）', async () => {
    const bot = placeBot((key) => (key === '0,63,0' ? 'deepslate' : key === '0,62,0' ? 'stone' : 'air'));
    await expect(placeBlock(bot, 'cobblestone', 0, 63, 0)).resolves.toBe(false);
    expect(bot.output).toContain('拒绝清掉');
    expect(bot.output).toContain('拒绝清掉 deepslate，[object Object] 这一格是当前');
    expect(bot.output).not.toContain('或用 placeHere');
  });

  it('放置请求被清障安全规则拒绝（目标格不是自己脚下）：说"放置"、给别的落点，不再推荐 placeHere', async () => {
    const bot = placeBot((key) => (key === '1,63,1' ? 'deepslate' : key === '0,62,0' ? 'stone' : 'air'));
    await expect(placeBlock(bot, 'cobblestone', 1, 63, 1)).resolves.toBe(false);
    expect(bot.output).toContain('拒绝清障');
    expect(bot.output).not.toContain('或用 placeHere');
  });

  it('拆方块请求被拒：说"拆"，与放置意图分开', async () => {
    const bot = placeBot((key) => (key === '0,63,0' ? 'deepslate' : key === '0,62,0' ? 'stone' : 'air'));
    await expect(placeBlock(bot, 'air', 0, 63, 0)).resolves.toBe(false);
    expect(bot.output).toContain('拒绝拆掉');
    expect(bot.output).toContain('承重');
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
    // 默认 food=10（有点饿）：新规矩下 food ≥ 14 且背包只剩 ≤2 份时 consume 会**拒绝动存粮**，
    // 所以"吃"的机制用例用默认值就能走到真正的吃；存粮规则单独有用例。
    food: options.food ?? 10,
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
    expect(bot.output).toContain('吃掉了 mutton，手上从 1 个变成 0 个，饱食度从 10 变成 2');
    expect(bot.output).toContain('吃掉了 mutton，手上从 1 个变成 0 个，饱食度从 10 变成 2');
    expect(bot.output).toContain('吃掉了 mutton，手上从 1 个变成 0 个，饱食度从 10 变成 2');
  });

  it('同步超时且东西还在 → "没吃成/还在手上/可重试"，且回执里没有堆栈', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 1 }] });
    bot.consume = vi.fn(async () => {
      throw new Error('Promise timed out.');
    });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('吃 mutton 没有成功，试了 2 次，原因是 2 次都是等待服务端回应');
    expect(bot.output).toContain('吃 mutton 没有成功，试了 2 次，原因是 2 次都是等待服务端回应');
    expect(bot.output).toContain('等待服务端回应超时');
    expect(bot.output).toContain('吃 mutton 没有成功，试了 2 次，原因是 2 次都是等待服务端回应');
    // **绝不把原始异常/堆栈当回执**
    expect(bot.output).not.toContain('!!Action threw exception!!');
    expect(bot.output).not.toContain('Stack trace');
    expect(bot.output).not.toContain('at Object.');
    // 自动重试了一次（1 次正常 + 1 次重试）
    expect(bot.consume).toHaveBeenCalledTimes(2);
    // 2026-10-30：不再补"下一步"——重试还是换一种，是模型的判断
    expect(bot.output).not.toContain('照做即可');
    expect(bot.output).toContain('吃 mutton 没有成功，试了 2 次，原因是 2 次都是等待服务端回应');
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
    expect(bot.output).toContain('第 1 次同步超时了，等待服务端回应超时（mineflayer: Prom');
    expect(bot.output).toContain('第 1 次同步超时了，等待服务端回应超时（mineflayer: Prom');
    // 重试前确认食物还在手上 → 再 equip 一次
    expect(bot.equip).toHaveBeenCalledTimes(2);
  });

  it('手里没有该食物 → 点名缺什么 + 还有什么能吃的，不指定换哪一样', async () => {
    const bot = consumeBot({ held: [{ name: 'bread', count: 2 }] });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('背包里没有 mutton');
    expect(bot.output).toContain('breadx2');
    expect(bot.output).not.toContain('照做即可');
    expect(bot.consume).not.toHaveBeenCalled();
  });

  it('调用没报错但数值没变 → 如实说"没生效"，且不重复吃', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 2 }] });

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('吃 mutton 没有生效，手上从 2 个变成 2 个，饱食度从 10 变');
    expect(bot.output).not.toContain('吃成了');
    expect(bot.output).toContain('吃 mutton 没有生效，手上从 2 个变成 2 个，饱食度从 10 变');
    expect(bot.output).toContain('吃 mutton 没有生效，手上从 2 个变成 2 个，饱食度从 10 变');
    // 没报错就不重试：重复吃会白白浪费食物
    expect(bot.consume).toHaveBeenCalledTimes(1);
  });

  it('读不到饥饿值也读不到数量 → 说"无法确认"，不假装吃成了', async () => {
    const bot = consumeBot({ held: [{ name: 'mutton', count: 1 }] });
    delete bot.food;
    delete bot.foodSaturation;
    bot.inventory.items = () => undefined;

    await expect(consume(bot, 'mutton', NO_WAIT)).resolves.toBe(false);
    expect(bot.output).toContain('没法确认 mutton 吃没吃进去，饥饿值和背包数量都读不到。');
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
    expect(bot.output).toContain('吃掉了 mutton，手上从 1 个变成 0 个，饱食度读数没变，服务端可');
    expect(bot.output).toContain('饱食度读数没变');
  });

  // ── 存粮规则：别把最后一口吃掉（真机：五小时吃光全世界，然后血 1.68 无法回血） ──
  // **契约 2026-10-24 改**：模型明确说"吃"，工具就吃。存粮的风险只**警告**，
  // 不拒绝——"你现在不饿"这个判断只有模型能做（它知道接下来是去打怪还是回城）。
  // 以前这里是 `resolves.toBe(false)` + `bot.consume` 一次都没调，
  // 还为此打过 `lowHealthEmergency` 补丁；打补丁正是"工具在猜"的症状。
  it('**只剩 ≤2 份且不饿（food ≥ 14）→ 照吃，但回执里带存粮警告**', async () => {
    const bot = consumeBot({ held: [{ name: 'cooked_beef', count: 2 }], food: 16 });
    bot.consume = vi.fn(async () => {
      bot.food = 21;
    });

    await expect(consume(bot, 'cooked_beef', NO_WAIT)).resolves.toBe(true);
    expect(bot.consume).toHaveBeenCalled(); // 说了就执行
    expect(bot.output).toContain('背包里只剩 2 份能吃的，有 cooked_beefx2。');
    expect(bot.output).toContain('2 份能吃的');
    expect(bot.output).toContain('cooked_beefx2');
  });

  it('真饿（food < 14）时照吃：存粮规则不该把人饿死', async () => {
    const bot = consumeBot({ held: [{ name: 'cooked_beef', count: 2 }], food: 13 });
    bot.consume = vi.fn(async () => {
      bot.food = 21;
    });

    await expect(consume(bot, 'cooked_beef', NO_WAIT)).resolves.toBe(true);
    expect(bot.output).toContain('吃掉了 cooked_beef，饱食度从 13 变成 21，饱和度从 0');
    expect(bot.consume).toHaveBeenCalledTimes(1);
  });

  it('还有 3 份以上时照常吃（存粮规则只管"最后两口"）', async () => {
    const bot = consumeBot({ held: [{ name: 'cooked_beef', count: 3 }], food: 16 });
    bot.consume = vi.fn(async () => {
      bot.food = 20;
    });

    await expect(consume(bot, 'cooked_beef', NO_WAIT)).resolves.toBe(true);
    expect(bot.output).toContain('吃掉了 cooked_beef，饱食度从 16 变成 20，饱和度从 0');
  });

  it('吃生肉不再附"下次先烤"的建议（回执只留事实）', async () => {
    const bot = consumeBot({ held: [{ name: 'raw_beef', count: 5 }], food: 6 });
    bot.consume = vi.fn(async () => {
      bot.food = 9;
    });

    await expect(consume(bot, 'raw_beef', NO_WAIT)).resolves.toBe(true);
    expect(bot.output).toContain('吃掉了 raw_beef，饱食度从 6 变成 9，饱和度从 0 变成 0。');
    expect(bot.output).not.toContain('是生的');
    expect(bot.output).not.toContain('furnace');
  });

  // 2026-10-24：存粮规则从"拒绝"改成"照吃 + 警告"。模型说了吃就吃，
  // 风险只在回执里说清——"该不该动存粮"只有模型能判断。
  it('存粮是生肉时，警告只说剩余份数（不再给烹饪建议）', async () => {
    const bot = consumeBot({ held: [{ name: 'raw_beef', count: 1 }], food: 18 });
    bot.consume = vi.fn(async () => {
      bot.food = 21;
    });

    await expect(consume(bot, 'raw_beef', NO_WAIT)).resolves.toBe(true);
    expect(bot.output).toContain('背包里只剩 1 份能吃的');
    expect(bot.output).not.toContain('cooked_beef');
  });

  it('存粮提醒里带难度说明（Easy 饿不死：别恐慌性清空存粮）', async () => {
    const bot = consumeBot({ held: [{ name: 'cooked_beef', count: 2 }], food: 16 });
    bot.game = { difficulty: 1 };
    bot.consume = vi.fn(async () => {
      bot.food = 21;
    });

    await expect(consume(bot, 'cooked_beef', NO_WAIT)).resolves.toBe(true);
    expect(bot.output).toContain('背包里只剩 2 份能吃的');
    expect(bot.output).toContain('背包里只剩 2 份能吃的，有 cooked_beefx2。这是简单难度，饿');
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
      '饱食度从 14 变成 20，饱和度从 0 变成 9.6',
    );
    expect(formatFoodDelta({ food: 14, saturation: 0 }, { food: 14, saturation: 0 })).toBe(
      '饱食度从 14 变成 14，饱和度从 0 变成 0，没有变化',
    );
    expect(formatFoodState({ food: null, saturation: null })).toBe('饱食度读不到，饱和度读不到');
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

// ─────────────────────────────────────────────────────────────────────────────
// bot.output 硬上限：真机 2026-10-18 19:19 的 1.35 亿字符就是从这里涨出来的
// （huntFor 参数写错 → 315 万次 log → bot.output 爆炸）。下游 clamp 只能事后掩盖，
// 所以在**唯一写入点**上闸，把这一整类病堵死。
// ─────────────────────────────────────────────────────────────────────────────
describe('log 与 bot.output 硬上限', () => {
  it('单条超长：留头 + 省略标记 + 尾，总长不超上限', () => {
    const bot: any = { output: '' };
    log(bot, 'A'.repeat(5_000), 'B'.repeat(50_000));

    expect(bot.output.length).toBeLessThanOrEqual(MAX_BOT_OUTPUT_CHARS);
    expect(bot.output).toContain('输出过长');
    expect(bot.output.startsWith('A')).toBe(true); // 头部（起因/警告）还在
    expect(bot.output.trimEnd().endsWith('B')).toBe(true); // 尾部（回执）还在
    expect(BOT_OUTPUT_HEAD_CHARS).toBeLessThan(MAX_BOT_OUTPUT_CHARS);
  });

  it('反复累加（315 万行那一路）也不会超上限，且最新一行还在', () => {
    const bot: any = { output: '' };
    for (let i = 0; i < 2_000; i++) log(bot, `第 ${i} 行 ` + 'x'.repeat(100));

    expect(bot.output.length).toBeLessThanOrEqual(MAX_BOT_OUTPUT_CHARS);
    expect(bot.output).toContain('输出过长');
    expect(bot.output).toContain('第 1999 行'); // 模型靠最新输出拿"下一步"
  });

  it('假身没有 output 字段也不炸（防御式）', () => {
    const bot: any = {};
    expect(() => log(bot, 'hi')).not.toThrow();
    expect(bot.output).toBe('hi\n');
    // 非字符串也归一成字符串（真机上被别处写坏过就会静默拼成 "undefined…"）
    const weird: any = { output: undefined };
    log(weird, 'a');
    expect(weird.output).toBe('a\n');
  });

  it('capBotOutput 是纯函数：没超上限原样返回', () => {
    expect(capBotOutput('short')).toBe('short');
    expect(capBotOutput('y'.repeat(30_000)).length).toBeLessThanOrEqual(MAX_BOT_OUTPUT_CHARS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attackEntity 的击杀等待：**有界 + 诊断**
// 原来 `while (还在 24 格内) { sleep(1000) }` 没有上限——打不死的目标（隔墙/水里/有甲）
// 就是静默死等，模型只会拿到一句"已强制释放动作通道"。上限要宽（默认 90 秒），
// 但必须存在；放弃时要说清"等了多久 / 掉没掉血 / 打不打得到"并给一条不同的出路。
// ─────────────────────────────────────────────────────────────────────────────
describe('attackEntity 击杀等待：有界 + 诊断', () => {
  function fightBot(options: { health?: number | null; interrupt?: boolean } = {}) {
    const entity: any = {
      id: 7,
      name: 'zombie',
      health: options.health === undefined ? 20 : options.health,
      position: { x: 1, y: 64, z: 0, distanceTo: () => 3 },
    };
    let stops = 0;
    const bot: any = {
      output: '',
      heldItem: null,
      interrupt_code: options.interrupt === true,
      entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 3 } },
      entities: { 7: entity },
      inventory: { items: () => [{ name: 'iron_sword', count: 1 }] },
      equip: async (): Promise<void> => {},
      nearestEntity: (): any => null,
      swordpvp: {
        weaponOfChoice: '',
        attack: async (): Promise<void> => {},
        stop: (): void => {
          stops += 1;
        },
      },
    };
    return {
      bot,
      entity,
      get stops() {
        return stops;
      },
    };
  }

  /** 短预算版（真机默认 90 秒，测试用几百毫秒，语义一样）。 */
  const FAST = { budgetMs: 120, pollMs: 20 };

  it('打不死的目标：到预算就放弃（不再静默死等），并给出诊断回执', async () => {
    const h = fightBot({ health: 20 });
    const started = Date.now();
    const killed = await attackEntity(h.bot, h.entity, true, FAST);

    expect(killed).toBe(false);
    expect(Date.now() - started).toBeLessThan(KILL_WAIT_BUDGET_MS); // 绝不等满 90 秒
    expect(h.stops).toBe(1); // 停手，不把 pvp 挂着
    expect(h.bot.output).toContain('还没打死 zombie');
    expect(h.bot.output).toContain('一点没掉');
    expect(h.bot.output).not.toContain('照做即可');
    expect(h.bot.output).not.toContain('Successfully killed');
  });

  it('掉血但没死：诊断说"在掉血，只是慢"，不替它决定要不要补刀', async () => {
    const h = fightBot({ health: 20 });
    // 打了两轮后掉到 12 血，但一直不死
    setTimeout(() => {
      h.entity.health = 12;
    }, 50);
    const killed = await attackEntity(h.bot, h.entity, true, FAST);

    expect(killed).toBe(false);
    expect(h.bot.output).toMatch(/打了 0\.1 秒还没打死 zombie，轮询了 \d+ 次，现在距离 3\.0/);
    expect(h.bot.output).toMatch(/打了 0\.1 秒还没打死 zombie，轮询了 \d+ 次，现在距离 3\.0/);
    expect(h.bot.output).not.toContain('照做即可');
  });

  it('血量读不到：如实说"看不出掉没掉血"，不编一条下一步', async () => {
    const h = fightBot({ health: null });
    const killed = await attackEntity(h.bot, h.entity, true, FAST);

    expect(killed).toBe(false);
    expect(h.bot.output).toMatch(/打了 0\.1 秒还没打死 zombie，轮询了 \d+ 次，现在距离 3\.0/);
    expect(h.bot.output).not.toContain('照做即可');
  });

  it('最后一刻打死了：仍然算击杀（返回 true、写 Successfully killed）', async () => {
    const h = fightBot({ health: 20 });
    // 60ms 后从实体表移除（预算 300ms，但要连续几轮确认——见 KILL_CONFIRM_POLLS）
    setTimeout(() => {
      delete h.bot.entities[7];
    }, 60);
    const killed = await attackEntity(h.bot, h.entity, true, { budgetMs: 300, pollMs: 20 });

    expect(killed).toBe(true);
    expect(h.bot.output).toContain('打死了 zombie。');
    expect(h.bot.output).not.toContain('还没打死');
  });

  it('**瞬移不算死**：消失一轮又回来 → 不判击杀，继续等（真机 enderman 事故）', async () => {
    const h = fightBot({ health: 20 });
    // 20ms 消失、45ms 又出现、100ms 起永久消失
    setTimeout(() => {
      delete h.bot.entities[7];
    }, 20);
    setTimeout(() => {
      h.bot.entities[7] = h.entity;
    }, 45);
    setTimeout(() => {
      delete h.bot.entities[7];
    }, 100);
    const killed = await attackEntity(h.bot, h.entity, true, { budgetMs: 400, pollMs: 20 });

    expect(killed).toBe(true);
    expect(h.bot.output).toContain('打死了 zombie，过程中它瞬移了 1 次。');
    expect(h.bot.output).toContain('打死了 zombie，过程中它瞬移了 1 次。'); // 如实记录中途瞬移过
  });

  it('**瞬移 30 格：离开 24 格扫描但还在全局实体表里 → 不算击杀**（旧逻辑在这里撒谎）', async () => {
    const h = fightBot({ health: 20 });
    // 还在 bot.entities 里，但已经瞬移到 30 格外（= 离开 24 格扫描）
    h.entity.position = { x: 30, y: 64, z: 0, distanceTo: () => 30 };
    const killed = await attackEntity(h.bot, h.entity, true, { budgetMs: 200, pollMs: 20 });

    expect(killed).toBe(false);
    expect(h.bot.output).toContain('还没打死');
    expect(h.bot.output).not.toContain('Successfully killed');
  });

  it('击杀证据是纯函数：血量 0 = 死；还在表里 = 活；两处都没有 = 待确认；读不到 = 不知道', () => {
    const bot: any = { entities: { 7: { id: 7 } } };
    expect(entityPresentById(bot, 7)).toBe(true);
    expect(entityPresentById({ entities: {} }, 7)).toBe(false);
    expect(entityPresentById({}, 7)).toBeNull(); // 没有全局实体表 = 读不到，不猜
    expect(entityPresentById(bot, null)).toBeNull();

    expect(classifyKillEvidence({ entities: { 7: { id: 7 } } }, { id: 7, health: 0 })).toBe('dead');
    expect(classifyKillEvidence({ entities: { 7: { id: 7 } } }, { id: 7, health: 12 })).toBe('alive');
    expect(classifyKillEvidence({ entities: {} }, { id: 7, health: 12 })).toBe('gone');
    expect(classifyKillEvidence({}, { id: 7, health: 12 })).toBe('unknown'); // 读不到 ≠ 死
  });

  it('目标离开 24 格列表：行为与今天一致（算打完，返回 true）', async () => {
    const h = fightBot({ health: 20 });
    delete h.bot.entities[7]; // 一开始就不在列表里 → 不等
    const started = Date.now();
    const killed = await attackEntity(h.bot, h.entity, true, FAST);

    expect(killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('Stop / 保命：立刻停手，绝不等预算', async () => {
    const h = fightBot({ interrupt: true });
    const started = Date.now();
    // 预算 5 秒：如果 interrupt 没被尊重，这里会等 5 秒
    const killed = await attackEntity(h.bot, h.entity, true, { budgetMs: 5_000, pollMs: 20 });

    expect(killed).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
    expect(h.stops).toBe(1);
    expect(h.bot.output).not.toContain('还没打死'); // 不是超时放弃，是被 Stop 打断
  });

  it('describeKillGiveUp 是纯渲染：远距离说清"打不到"，不塞坐标处方', () => {
    const bot: any = { entity: { position: { x: 0, y: 64, z: 0, distanceTo: () => 14.7 } } };
    const entity: any = { name: 'zombie', health: 20, position: { x: 14, y: 64, z: 0, distanceTo: () => 14.7 } };
    const text = describeKillGiveUp(bot, entity, { waitedMs: 90_000, polls: 90, healthBefore: 20 });
    expect(text).toContain('打了 90.0 秒还没打死 zombie');
    expect(text).toContain('你打不到它');
    // 2026-10-30：距离是事实（head 里已经报了），怎么接近由模型决定
    expect(text).not.toContain('goToCoordinates');
    expect(text).not.toContain('照做即可');
  });
});

describe('bestWeaponInInventory', () => {
  const mk = (items: any[]): any => ({ inventory: { items: () => items } });

  it('按 attackDamage 挑最好的武器（和 equipHighestAttack 同一套排序）', () => {
    expect(
      bestWeaponInInventory(mk([{ name: 'iron_sword', attackDamage: 4 }, { name: 'diamond_sword', attackDamage: 7 }])),
    ).toBe('diamond_sword');
    // 斧头也算武器，镐不算（只有没剑/斧时才退而求其次）
    expect(
      bestWeaponInInventory(mk([{ name: 'iron_pickaxe', attackDamage: 2 }, { name: 'stone_axe', attackDamage: 9 }])),
    ).toBe('stone_axe');
    expect(bestWeaponInInventory(mk([{ name: 'iron_pickaxe', attackDamage: 2 }]))).toBe('iron_pickaxe');
  });

  it('没有武器 / 读不到背包 → null（不抛）', () => {
    expect(bestWeaponInInventory(mk([]))).toBeNull();
    expect(bestWeaponInInventory({} as any)).toBeNull();
    expect(bestWeaponInInventory(mk([{ name: 'dirt', count: 64 }]))).toBeNull();
  });

  it('攻击力读不到时也不炸（取第一个，不编数值）', () => {
    expect(bestWeaponInInventory(mk([{ name: 'wooden_sword' }]))).toBe('wooden_sword');
  });
});
