/**
 * task-22：gold_boots → golden_boots 别名 + craftSmartDetailed 回执。
 * mcdata / skills 都 mock，只验证交互层的名字解析与调用参数。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/body/data/mcdata.js', () => {
  const ids: Record<string, number> = { golden_boots: 500, gold_ingot: 400, crafting_table: 300 };
  return {
    getItemId: (n: string) => ids[n] ?? null,
    getItemName: (id: number) => Object.keys(ids).find((k) => ids[k] === id) ?? null,
    getItemCraftingRecipes: (n: string) => (n === 'golden_boots' ? [[{ gold_ingot: 4 }, { craftedCount: 1 }]] : null),
    ingredientsFromPrismarineRecipe: () => ({ gold_ingot: 4 }),
    calculateLimitingResource: () => ({ num: 1, limitingResource: null }),
    getFuelSmeltOutput: () => 0,
    getBlockId: () => 0,
    getAllBlockIds: () => [],
  };
});

vi.mock('../src/body/library/skills.js', () => ({
  craftRecipe: vi.fn(() => Promise.resolve(true)),
  log: () => undefined,
}));

import * as skills from '../src/body/library/skills.js';
import { craftSmartDetailed, resolveCraftItemName } from '../src/body/commands/interact.js';

function fakeBot() {
  return {
    entity: { position: { distanceTo: () => 1 } },
    inventory: { slots: [] },
    recipesAll: () => [],
    craft: () => Promise.resolve(),
    armorManager: { equipAll: () => undefined },
    output: '',
  };
}

describe('resolveCraftItemName：金装备别名', () => {
  it('gold_boots 映射到 golden_boots 并标记 aliasOf', () => {
    expect(resolveCraftItemName('gold_boots')).toEqual({ name: 'golden_boots', aliasOf: 'gold_boots', valid: true });
    expect(resolveCraftItemName('golden_boots')).toEqual({ name: 'golden_boots', aliasOf: null, valid: true });
    expect(resolveCraftItemName('not_a_real_item')).toEqual({
      name: 'not_a_real_item',
      aliasOf: null,
      valid: false,
    });
  });
});

describe('craftSmartDetailed：别名接线与失败回执', () => {
  it('gold_boots 会以 golden_boots 去合成，回执写明别名', async () => {
    vi.mocked(skills.craftRecipe).mockClear();
    const bot = fakeBot();
    const res = await craftSmartDetailed(bot, 'gold_boots', 1);
    expect(res.ok).toBe(true);
    expect(vi.mocked(skills.craftRecipe)).toHaveBeenCalledWith(bot, 'golden_boots', 1);
    expect(res.detail).toContain('golden_boots');
    expect(res.detail).toContain('gold_boots');
  });

  it('不存在的物品：给明确回执且不调用 craftRecipe', async () => {
    vi.mocked(skills.craftRecipe).mockClear();
    const bot = fakeBot();
    const res = await craftSmartDetailed(bot, 'not_a_real_item', 1);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('没有');
    expect(res.detail).toContain('golden_*');
    expect(vi.mocked(skills.craftRecipe)).not.toHaveBeenCalled();
  });
});
