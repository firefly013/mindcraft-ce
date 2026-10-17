/**
 * task-22：3×3 合成 + null 配方崩溃。
 *
 * 真机：4 金锭却合成 gold_boots 报 `Cannot read properties of null (reading 'length')`。
 * 根因：`skills.craftRecipe` 对 `getItemCraftingRecipes()` 的 null 直接 `.length`。
 * 这组用假 body + mock 世界驱动**真实的 craftRecipe**：3×3 金靴走工作台、材料不够、
 * 没有工作台、非法名字四条路径都要有明确回执且不抛。
 */
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';

vi.mock('../src/body/data/mcdata.js', () => {
  const ids: Record<string, number> = {
    golden_boots: 500, gold_ingot: 400, crafting_table: 300, stick: 200, oak_planks: 100,
  };
  const recipes: Record<string, any> = {
    golden_boots: [[{ gold_ingot: 4 }, { craftedCount: 1 }]],
    stick: [[{ oak_planks: 2 }, { craftedCount: 4 }]],
  };
  return {
    getItemId: (n: string) => ids[n] ?? null,
    getItemName: (id: number) => Object.keys(ids).find((k) => ids[k] === id) ?? null,
    getItemCraftingRecipes: (n: string) => recipes[n] ?? null,
    ingredientsFromPrismarineRecipe: () => ({ gold_ingot: 4 }),
    calculateLimitingResource: (inventory: Record<string, number>, required: Record<string, number>) => {
      let num = Infinity;
      let limitingResource: string | null = null;
      for (const [key, need] of Object.entries(required)) {
        const n = Number(inventory[key] ?? 0) / need;
        if (n < num) { num = n; limitingResource = key; }
      }
      return { num, limitingResource };
    },
    getFuelSmeltOutput: () => 0,
    isSmeltable: () => false,
    getBlockId: () => 0,
    getAllBlockIds: () => [],
  };
});

vi.mock('../src/body/library/world.js', () => ({
  getNearestBlock: (bot: any) => bot.__table ?? null,
  getInventoryCounts: (bot: any) => bot.__counts(),
  getNearestFreeSpace: () => ({ x: 0, y: 0, z: 0 }),
}));

import { craftRecipe } from '../src/body/library/skills.js';

function makeBot(counts: Record<string, number>, opts: { table?: boolean } = {}) {
  const inv: Record<string, number> = { ...counts };
  const table = opts.table === false ? null : { name: 'crafting_table', position: new Vec3(1, 64, 0) };
  const crafted: Array<{ n: number; table: unknown }> = [];
  const bot: any = {
    output: '',
    __table: table,
    __counts: () => ({ ...inv }),
    entity: { position: new Vec3(0.5, 64, 0.5) },
    recipesFor: (_id: number, _meta: unknown, _min: number, tableArg: unknown) => {
      if (!tableArg) return [];
      return [{
        result: { id: 500, count: 1 },
        inShape: [[{ id: 400 }, { id: 400 }], [{ id: 400 }, { id: 400 }]],
        requiresTable: true,
      }];
    },
    craft: (_recipe: unknown, n: number, tableArg: unknown) => {
      crafted.push({ n, table: tableArg });
      inv.golden_boots = (inv.golden_boots ?? 0) + n;
      inv.gold_ingot = (inv.gold_ingot ?? 0) - 4 * n;
      return Promise.resolve();
    },
    armorManager: { equipAll: () => undefined },
    _crafted: crafted,
  };
  return bot;
}

describe('skills.craftRecipe：3×3 金靴（工作台路径）', () => {
  it('4 金锭 + 附近工作台 → 合成 golden_boots，走的是工作台', async () => {
    const bot = makeBot({ gold_ingot: 4 });
    const ok = await craftRecipe(bot, 'golden_boots', 1);
    expect(ok).toBe(true);
    expect(bot.__counts().golden_boots).toBe(1);
    expect(bot.__counts().gold_ingot).toBe(0);
    expect(bot._crafted).toHaveLength(1);
    expect(bot._crafted[0].table).not.toBeNull();
  });

  it('4 金锭但没工作台 → 明确说需要工作台，不崩', async () => {
    const bot = makeBot({ gold_ingot: 4 }, { table: false });
    const ok = await craftRecipe(bot, 'golden_boots', 1);
    expect(ok).toBe(false);
    expect(String(bot.output)).toContain('requires a crafting table');
    expect(bot._crafted).toHaveLength(0);
  });

  it('★非法名字（gold_boots 未别名）不再崩：返回 false 并说明没有配方', async () => {
    const bot = makeBot({});
    const ok = await craftRecipe(bot, 'gold_boots', 1);
    expect(ok).toBe(false);
    expect(String(bot.output)).toContain('not an item');
  });

  it('金锭不够 → 写清材料不够，且不调用 craft', async () => {
    const bot = makeBot({ gold_ingot: 2 });
    const ok = await craftRecipe(bot, 'golden_boots', 1);
    expect(ok).toBe(false);
    expect(String(bot.output)).toContain('材料不够');
    expect(bot._crafted).toHaveLength(0);
  });
});
