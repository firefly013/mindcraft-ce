/**
 * 工具保护：附魔工具用到**安全线**就停手，留一点耐久（用户 2026-11-01）。
 *
 * 与 `tool_choice.test.ts`（纯选择）分开：这里测**执行层换手**——
 * `ensureHarvestTool` 换下一把、换不到时 `digWithTimeout` 拒绝下镐。
 */
import { describe, expect, it } from 'vitest';
import {
  digWithTimeout,
  ensureHarvestTool,
  isHeldToolProtected,
  protectedToolNotice,
} from '../src/body/library/skills.js';

interface FakeItem {
  name: string;
  type: number;
  count: number;
  maxDurability?: number;
  durabilityUsed?: number;
  enchants?: unknown;
}

/** 附魔铁镐：剩 11 次耐久（251 - 240）⇒ 到保护线。 */
const ENCHANTED_IRON: FakeItem = {
  name: 'iron_pickaxe',
  type: 1,
  count: 1,
  maxDurability: 251,
  durabilityUsed: 240,
  enchants: [{ name: 'efficiency', lvl: 3 }],
};
/** 未附魔石镐：剩 131 次 ⇒ 可用。 */
const PLAIN_STONE: FakeItem = { name: 'stone_pickaxe', type: 2, count: 1, maxDurability: 131, durabilityUsed: 0 };
/** 未附魔铁镐：也到安全线，但**没有附魔 ⇒ 照旧可用**。 */
const PLAIN_LOW_IRON: FakeItem = {
  name: 'iron_pickaxe',
  type: 1,
  count: 1,
  maxDurability: 251,
  durabilityUsed: 240,
};

/** 需要工具的方块：两种镐都能收获。 */
const STONE_BLOCK: any = {
  name: 'stone',
  harvestTools: { 1: true, 2: true },
  canHarvest: (type: number | null) => type === 1 || type === 2,
};

/** 不需要工具的方块（泥土/沙）：空手也能收获。 */
const DIRT_BLOCK: any = {
  name: 'dirt',
  harvestTools: {},
  canHarvest: () => true,
};

/**
 * 假 bot：够 `ensureHarvestTool` / `digWithTimeout` 用。
 *
 * `inventory.slots` 是 `equip()` 查找物品的地方；`equip`/`unequip` 只改 held，
 * 不做服务端交互。
 */
function makeBot(items: FakeItem[], heldName: string | null): any {
  const state: { held: FakeItem | null } = {
    held: heldName == null ? null : items.find((item) => item.name === heldName) ?? null,
  };
  const bot: any = {
    game: { gameMode: 'survival' },
    output: '',
    inventory: {
      slots: items,
      items: () => items,
      findInventoryItem: (name: string) => items.find((item) => item.name === name) ?? null,
    },
    get heldItem(): FakeItem | null {
      return state.held;
    },
    equip: (item: FakeItem): Promise<void> => {
      state.held = item;
      return Promise.resolve();
    },
    unequip: (): Promise<void> => {
      state.held = null;
      return Promise.resolve();
    },
    tool: {
      // mineflayer 的 equipForBlock 会"照着最快挑"；这里模拟成什么都不做，
      // 让候选兜底循环成为唯一的换手路径。
      equipForBlock: (): Promise<void> => Promise.resolve(),
    },
    dig: (): Promise<void> => {
      bot.__digs = (bot.__digs ?? 0) + 1;
      return Promise.resolve();
    },
    stopDigging: (): void => {},
  };
  return bot;
}

describe('isHeldToolProtected / protectedToolNotice', () => {
  it('附魔工具到线 ⇒ true；未附魔到线 ⇒ false', () => {
    const enchantedBot = makeBot([ENCHANTED_IRON], 'iron_pickaxe');
    const plainBot = makeBot([PLAIN_LOW_IRON], 'iron_pickaxe');
    expect(isHeldToolProtected(enchantedBot)).toBe(true);
    expect(isHeldToolProtected(plainBot)).toBe(false);
    expect(isHeldToolProtected(makeBot([PLAIN_STONE], null))).toBe(false);
  });

  it('回执说清哪把、还剩多少、保护线在哪、不自动用', () => {
    const bot = makeBot([ENCHANTED_IRON], 'iron_pickaxe');
    const notice = protectedToolNotice(bot, 'stone');
    expect(notice).toContain('iron_pickaxe');
    expect(notice).toContain('附魔工具');
    expect(notice).toContain('剩 11 次');
    expect(notice).toContain('iron_pickaxe 是附魔工具，只剩 11 次耐久，保护线是 20');
    expect(notice).toContain('stone');
  });
});

describe('ensureHarvestTool：保护线触发自动换手', () => {
  it('手持受保护附魔镐 + 背包有石镐 ⇒ 换成石镐（自动切换仍然有效）', async () => {
    const bot = makeBot([ENCHANTED_IRON, PLAIN_STONE], 'iron_pickaxe');
    await expect(ensureHarvestTool(bot, STONE_BLOCK)).resolves.toBe(true);
    expect(bot.heldItem?.name).toBe('stone_pickaxe');
  });

  it('只有受保护的附魔镐 ⇒ 返回 false，且不换手（留给 digWithTimeout 拦）', async () => {
    const bot = makeBot([ENCHANTED_IRON], 'iron_pickaxe');
    await expect(ensureHarvestTool(bot, STONE_BLOCK)).resolves.toBe(false);
    expect(bot.heldItem?.name).toBe('iron_pickaxe');
  });

  it('不需要工具的方块 ⇒ 放下保护工具、空手挖', async () => {
    const bot = makeBot([ENCHANTED_IRON], 'iron_pickaxe');
    await expect(ensureHarvestTool(bot, DIRT_BLOCK)).resolves.toBe(true);
    expect(bot.heldItem).toBeNull();
  });

  it('未附魔工具到安全线 ⇒ 照旧用（保护只针对附魔工具）', async () => {
    const bot = makeBot([PLAIN_LOW_IRON], 'iron_pickaxe');
    await expect(ensureHarvestTool(bot, STONE_BLOCK)).resolves.toBe(true);
    expect(bot.heldItem?.name).toBe('iron_pickaxe');
  });
});

describe('digWithTimeout：保护线拒绝下镐', () => {
  it('只有受保护附魔镐 ⇒ 不调用 dig，回执说清"已保护"', async () => {
    const bot = makeBot([ENCHANTED_IRON], 'iron_pickaxe');
    await expect(digWithTimeout(bot, STONE_BLOCK, '@(0,0,0)')).resolves.toBe(false);
    expect(bot.__digs ?? 0).toBe(0);
    expect(bot.output).toContain('附魔工具');
    expect(bot.output).toContain('iron_pickaxe 是附魔工具，只剩 11 次耐久，保护线是 20');
  });

  it('未附魔低耐久镐 ⇒ 照常下镐（便宜优先规则不变）', async () => {
    const bot = makeBot([PLAIN_LOW_IRON], 'iron_pickaxe');
    bot.blockAt = () => null;
    await digWithTimeout(bot, STONE_BLOCK, '@(0,0,0)');
    expect(bot.__digs ?? 0).toBe(1);
  });
});
