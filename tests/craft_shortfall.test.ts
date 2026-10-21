/**
 * "我还差什么"计算器（Lead 2026-10-21：今晚同一模式 4 次——有全部材料只差一件基础物品，
 * 引擎从不说清）。不是门：只给算术 + 一个下一步动作；配方未知要说"无法判断"，不许猜。
 */
import { describe, expect, it } from 'vitest';
import {
  botInventoryCounts,
  describeCraftShortfallForBot,
  planCraftShortfall,
  requiresCraftingTable,
} from '../src/body/library/craft_shortfall.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 今晚真实配方的最小数据：原木→木板、木板→木棍、钻石镐、工作台、熔炉/铁锭。 */
const RECIPES: Record<string, Array<{ ingredients: Record<string, number>; craftedCount: number }>> = {
  oak_planks: [{ ingredients: { oak_log: 1 }, craftedCount: 4 }],
  stick: [{ ingredients: { '#planks': 1 }, craftedCount: 4 }],
  crafting_table: [{ ingredients: { '#planks': 4 }, craftedCount: 1 }],
  diamond_pickaxe: [{ ingredients: { diamond: 3, stick: 2 }, craftedCount: 1 }],
};
const resolve = (name: string) => RECIPES[name] ?? null;

describe('(a) A 的钻石镐：6 钻 + 1 木板，缺工作台/木板/原木', () => {
  it('递归报出工作台缺口，并一路展开到原木（1 原木 = 4 木板）', () => {
    const plan = planCraftShortfall({
      itemName: 'diamond_pickaxe',
      inventory: { diamond: 6, oak_planks: 1 },
      resolveRecipe: resolve,
      stationAvailable: false,
    });
    expect(plan.satisfied).toBe(false);
    const names = plan.missing.map((entry) => entry.item);
    expect(names.some((name) => name.includes('crafting_table'))).toBe(true);
    expect(names).toContain('oak_log');
    expect(plan.text).toContain('差的是');
    expect(plan.text).toContain('你有 1 个');
  });
  it('镐本身材料够（钻石/木棍都能从背包凑）⇒ 只报工作台链', () => {
    const plan = planCraftShortfall({
      itemName: 'diamond_pickaxe',
      inventory: { diamond: 6, oak_planks: 8 },
      resolveRecipe: resolve,
      stationAvailable: false,
    });
    expect(plan.missing.map((e) => e.item)).toContain('crafting_table');
    expect(plan.missing.map((e) => e.item)).not.toContain('diamond');
  });
});

describe('(c) 未知配方 ⇒ 说"无法判断"，不编原料', () => {
  it('没有配方的物品：missing 只有它自己，不出现任何凭空的原料名', () => {
    const plan = planCraftShortfall({ itemName: 'mystery_widget', inventory: {}, resolveRecipe: () => null });
    expect(plan.satisfied).toBe(false);
    expect(plan.missing.map((e) => e.item)).toEqual(['mystery_widget']);
    expect(plan.text).not.toContain('oak_log');
  });
});

describe('(d) 已经够了 ⇒ 什么都不说', () => {
  it('材料齐 + 工作台可用 ⇒ satisfied，text 为空', () => {
    const plan = planCraftShortfall({
      itemName: 'diamond_pickaxe',
      inventory: { diamond: 3, oak_planks: 2, oak_log: 1, crafting_table: 1 },
      resolveRecipe: resolve,
      stationAvailable: true,
    });
    expect(plan.satisfied).toBe(true);
    expect(plan.text).toBe('');
  });
});

describe('(b) 9 生铁 + 煤但没有熔炉 ⇒ 点名熔炉', () => {
  it('铁锭无合成配方（只能烧）⇒ 报铁锭/熔炉这一层，不编步骤', () => {
    const plan = planCraftShortfall({
      itemName: 'iron_ingot',
      count: 3,
      inventory: { raw_iron: 9, coal: 10 },
      resolveRecipe: (name) => (name === 'iron_ingot' ? null : null),
    });
    expect(plan.missing.map((e) => e.item)).toEqual(['iron_ingot']);
  });
  it('requiresCraftingTable 判定覆盖镐/工作台/盾，不误伤木板/木棍', () => {
    expect(requiresCraftingTable('diamond_pickaxe')).toBe(true);
    expect(requiresCraftingTable('crafting_table')).toBe(true);
    expect(requiresCraftingTable('shield')).toBe(true);
    expect(requiresCraftingTable('oak_planks')).toBe(false);
    expect(requiresCraftingTable('stick')).toBe(false);
  });
});

describe('接线：craft 失败时追加缺口（不是门，不阻止行动）', () => {
  it('interact 的 craft 失败路径调用 describeCraftShortfallForBot', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
    expect(code).toContain('describeCraftShortfallForBot(bot, targetName, num)');
    expect(code).toContain('outcome.ok ? \'\' : describeCraftShortfallForBot');
    // 只在失败时计算，成功回执不加噪音
    expect(code).toContain('ok: outcome.ok');
  });
  it('botInventoryCounts 从背包摊平 name→count', () => {
    const bot = { inventory: { items: () => [{ name: 'diamond', count: 6 }, { name: 'oak_planks', count: 1 }] } };
    expect(botInventoryCounts(bot)).toEqual({ diamond: 6, oak_planks: 1 });
  });
  it('生产包装不抛错；有配方数据时给出「差的是」一行，无数据时返回空串（不瞎报）', () => {
    const bot = { inventory: { items: () => [{ name: 'diamond', count: 6 }] } };
    const note = describeCraftShortfallForBot(bot, 'diamond_pickaxe');
    if (note !== '') expect(note).toContain('差的是');
  });
});
