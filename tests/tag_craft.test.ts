/**
 * task-17：合成支持同类标签（任何木板/原木/煤炭/羊毛）。
 * 真机：oak×2 + birch×3 却做不出 crafting_table。这里钉住：
 *  - family 识别 / 同类合计 / 缺什么现有多少；
 *  - 把配方格子按背包实际成员分配（混用 oak+birch）；
 *  - 失败回执写明「同类可混用也还差多少」。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/body/library/skills.js', () => ({
  craftRecipe: () => Promise.resolve(false), // 强制走同类混用回退
  log: () => undefined,
}));

vi.mock('../src/body/data/mcdata.js', () => {
  const ids: Record<string, number> = {
    oak_planks: 100, birch_planks: 101,
    crafting_table: 1, stick: 200, coal: 300, charcoal: 301, torch: 400,
  };
  const recipes: Record<string, any> = {
    crafting_table: [[{ oak_planks: 4 }, { craftedCount: 1 }]],
    stick: [[{ oak_planks: 2 }, { craftedCount: 4 }]],
    torch: [[{ coal: 1, stick: 1 }, { craftedCount: 4 }]],
  };
  return {
    getItemId: (n: string) => ids[n] ?? null,
    getItemName: (id: number) => Object.keys(ids).find((k) => ids[k] === id) ?? null,
    getItemCraftingRecipes: (n: string) => recipes[n] ?? null,
    getFuelSmeltOutput: (n: string) => (n === 'coal' || n === 'charcoal' ? 8 : 0),
  };
});

import {
  assignRecipeToInventory,
  craftRecipeWithTags,
  craftSmartDetailed,
  familyTagOf,
  formatUsedItems,
  planTagCraft,
  sameFamily,
} from '../src/body/commands/interact.js';

describe('familyTagOf / sameFamily', () => {
  it('识别木板 / 原木 / 煤炭 / 羊毛，普通物品返回 null', () => {
    expect(familyTagOf('oak_planks')).toBe('planks');
    expect(familyTagOf('birch_planks')).toBe('planks');
    expect(familyTagOf('oak_log')).toBe('logs');
    expect(familyTagOf('stripped_oak_log')).toBe('logs');
    expect(familyTagOf('birch_wood')).toBe('logs');
    expect(familyTagOf('coal')).toBe('coals');
    expect(familyTagOf('charcoal')).toBe('coals');
    expect(familyTagOf('white_wool')).toBe('wool');
    expect(familyTagOf('stick')).toBeNull();
  });

  it('sameFamily 只看 family', () => {
    expect(sameFamily('oak_planks', 'birch_planks')).toBe(true);
    expect(sameFamily('coal', 'charcoal')).toBe(true);
    expect(sameFamily('oak_planks', 'oak_log')).toBe(false);
    expect(sameFamily('stick', 'stick')).toBe(false);
  });
});

describe('planTagCraft：按同类合计判断', () => {
  it('★oak×2 + birch×3 做 crafting_table：合计 5 ≥ 4，需要混用', () => {
    const plan = planTagCraft({ oak_planks: 4 }, { oak_planks: 2, birch_planks: 3 });
    expect(plan.ok).toBe(true);
    expect(plan.missingText).toBe('');
    const group = plan.groups[0];
    expect(group.tag).toBe('planks');
    expect(group.available).toBe(5);
    expect(group.needsMixing).toBe(true);
    expect(group.members[0]?.name).toBe('birch_planks'); // 多的排前面
  });

  it('同类合计仍不够：写清缺多少、现有多少、混用也差多少', () => {
    const plan = planTagCraft({ oak_planks: 4 }, { oak_planks: 2, birch_planks: 1 });
    expect(plan.ok).toBe(false);
    expect(plan.groups[0].missing).toBe(1);
    expect(plan.missingText).toContain('还缺 1');
    expect(plan.missingText).toContain('oak_planks×2');
    expect(plan.missingText).toContain('birch_planks×1');
    expect(plan.missingText).toContain('合计 3');
    expect(plan.missingText).toContain('同类可混用也还差 1');
  });

  it('火把：coal 可以用 charcoal 顶', () => {
    const plan = planTagCraft({ coal: 1, stick: 1 }, { charcoal: 1, stick: 2 });
    expect(plan.ok).toBe(true);
    const coalGroup = plan.groups.find((g) => g.tag === 'coals');
    expect(coalGroup?.available).toBe(1);
    expect(coalGroup?.needsMixing).toBe(false);
  });

  it('普通物品按精确名字算', () => {
    const plan = planTagCraft({ cobblestone: 8 }, { cobblestone: 5 });
    expect(plan.ok).toBe(false);
    expect(plan.missingText).toContain('还缺 3');
  });
});

describe('assignRecipeToInventory：把配方格子换成背包实际成员', () => {
  const tableRecipe = {
    result: { id: 1, count: 1 },
    inShape: [[{ id: 100 }, { id: 100 }], [{ id: 100 }, { id: 100 }]],
  };
  const idToName = (id: number) => ({ 100: 'oak_planks', 101: 'birch_planks', 1: 'crafting_table' } as Record<string, string>)[String(id)] ?? null;
  const nameToId = (name: string) => ({ oak_planks: 100, birch_planks: 101, crafting_table: 1 } as Record<string, number>)[name] ?? null;

  it('★oak×2+birch×2：四个格子分到两种木板，mixed=true', () => {
    const assigned = assignRecipeToInventory(tableRecipe, { oak_planks: 2, birch_planks: 3 }, idToName, nameToId);
    expect(assigned).not.toBeNull();
    expect(assigned?.mixed).toBe(true);
    expect(assigned?.used).toEqual({ oak_planks: 2, birch_planks: 2 });
    const flatIds = (assigned?.recipe.inShape as any[]).flat().map((c) => c.id);
    expect(flatIds).toContain(100);
    expect(flatIds).toContain(101);
  });

  it('同一种够时用同一种，mixed=false', () => {
    const assigned = assignRecipeToInventory(tableRecipe, { oak_planks: 4 }, idToName, nameToId);
    expect(assigned?.mixed).toBe(false);
    expect(assigned?.used).toEqual({ oak_planks: 4 });
  });

  it('数量不够返回 null', () => {
    expect(assignRecipeToInventory(tableRecipe, { oak_planks: 2, birch_planks: 1 }, idToName, nameToId)).toBeNull();
  });

  it('煤炭能被 charcoal 顶替（shapeless ingredients）', () => {
    const torch = { result: { id: 400, count: 4 }, ingredients: [{ id: 300 }, { id: 200 }] };
    const idName = (id: number) => ({ 300: 'coal', 301: 'charcoal', 200: 'stick', 400: 'torch' } as Record<string, string>)[String(id)] ?? null;
    const nameId = (name: string) => ({ coal: 300, charcoal: 301, stick: 200, torch: 400 } as Record<string, number>)[name] ?? null;
    const assigned = assignRecipeToInventory(torch, { charcoal: 1, stick: 1 }, idName, nameId);
    expect(assigned).not.toBeNull();
    expect(assigned?.recipe.ingredients[0].id).toBe(301);
    expect(assigned?.used).toEqual({ charcoal: 1, stick: 1 });
  });
});

describe('craftRecipeWithTags：真去合成混用配方', () => {
  function fakeBot(counts: Record<string, number>, base: any) {
    const crafted: any[] = [];
    const bot: any = {
      recipesAll: () => [base],
      craft: (recipe: any) => { crafted.push(recipe); return Promise.resolve(); },
      get inventory() {
        return { slots: Object.entries(counts).map(([name, count]) => ({ name, count })) };
      },
    };
    return { bot, crafted };
  }

  it('★oak×2+birch×3：成功合成 crafting_table，回执写明混用', async () => {
    const base = { result: { id: 1, count: 1 }, inShape: [[{ id: 100 }, { id: 100 }], [{ id: 100 }, { id: 100 }]] };
    const { bot, crafted } = fakeBot({ oak_planks: 2, birch_planks: 3 }, base);
    const outcome = await craftRecipeWithTags(bot, 'crafting_table', 1);
    expect(outcome.ok).toBe(true);
    expect(outcome.mixed).toBe(true);
    expect(outcome.detail).toContain('混用同类材料');
    expect(outcome.detail).toContain('oak_planks×2');
    expect(outcome.detail).toContain('birch_planks×2');
    expect(crafted).toHaveLength(1);
    const ids = (crafted[0].inShape as any[]).flat().map((c) => c.id);
    expect(new Set(ids)).toEqual(new Set([100, 101]));
  });

  it('同类合计不够：ok=false 且写明缺什么、现有多少', async () => {
    const base = { result: { id: 1, count: 1 }, inShape: [[{ id: 100 }, { id: 100 }], [{ id: 100 }, { id: 100 }]] };
    const { bot } = fakeBot({ oak_planks: 2, birch_planks: 1 }, base);
    const outcome = await craftRecipeWithTags(bot, 'crafting_table', 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('还缺 1');
    expect(outcome.detail).toContain('oak_planks×2');
    expect(outcome.detail).toContain('birch_planks×1');
  });

  it('没有配方时明确说没有配方', async () => {
    const { bot } = fakeBot({}, { result: { id: 1, count: 1 } });
    const outcome = await craftRecipeWithTags(bot, 'dirt', 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('没有 dirt 的合成配方');
  });
});

describe('formatUsedItems', () => {
  it('列出实际用掉的同类材料', () => {
    expect(formatUsedItems({ oak_planks: 2, birch_planks: 2 })).toBe('oak_planks×2、birch_planks×2');
  });
});

describe('craftSmartDetailed：原配方失败后自动走同类混用', () => {
  function botWith(counts: Record<string, number>, base: any) {
    return {
      recipesAll: () => [base],
      craft: () => Promise.resolve(),
      get inventory() {
        return { slots: Object.entries(counts).map(([name, count]) => ({ name, count })) };
      },
    };
  }

  it('oak×2+birch×3 成功，detail 写明混用', async () => {
    const base = { result: { id: 1, count: 1 }, inShape: [[{ id: 100 }, { id: 100 }], [{ id: 100 }, { id: 100 }]] };
    const res = await craftSmartDetailed(botWith({ oak_planks: 2, birch_planks: 3 }, base), 'crafting_table', 1);
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('混用同类材料');
  });

  it('同类合计不够时 detail 写清缺什么/现有多少', async () => {
    const base = { result: { id: 1, count: 1 }, inShape: [[{ id: 100 }, { id: 100 }], [{ id: 100 }, { id: 100 }]] };
    const res = await craftSmartDetailed(botWith({ oak_planks: 2, birch_planks: 1 }, base), 'crafting_table', 1);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('还缺 1');
    expect(res.detail).toContain('oak_planks×2');
    expect(res.detail).toContain('birch_planks×1');
  });
});
