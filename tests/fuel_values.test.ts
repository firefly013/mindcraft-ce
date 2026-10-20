/**
 * 燃料表必须是**完整**的（Lead 2026-10-21 真机 overnight_b）：
 * 背包 `oak_planks×1 + stick×4`（合计 3.5 个物品）却被判「燃料不够：需要 2 个 oak_planks」，
 * 卡在"有原料、有燃料、系统说没燃料"。一个白名单就是"窄工具"的形状。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFuelSmeltOutput } from '../src/body/data/mcdata.js';
import { planFuelTotals } from '../src/body/commands/interact.js';

const botWith = (items: Array<{ name: string; count: number }>) => ({
  inventory: { items: () => items },
});

describe('getFuelSmeltOutput：任何可烧的东西都要算', () => {
  it('stick = 0.5（4 根顶 2 个物品；B 的 case）', () => {
    expect(getFuelSmeltOutput('stick')).toBe(0.5);
  });
  it('木类兜底：planks/log/wood/stem 都是 1.5，树苗 0.5', () => {
    expect(getFuelSmeltOutput('oak_planks')).toBe(1.5);
    expect(getFuelSmeltOutput('spruce_log')).toBe(1.5);
    expect(getFuelSmeltOutput('oak_sapling')).toBe(0.5);
  });
  it('煤/木炭 8、煤块 80、烈焰棒 12、岩浆桶 100', () => {
    expect(getFuelSmeltOutput('coal')).toBe(8);
    expect(getFuelSmeltOutput('charcoal')).toBe(8);
    expect(getFuelSmeltOutput('coal_block')).toBe(80);
    expect(getFuelSmeltOutput('blaze_rod')).toBe(12);
    expect(getFuelSmeltOutput('lava_bucket')).toBe(100);
  });
  it('不是燃料 ⇒ 0（石头/铁锭）', () => {
    expect(getFuelSmeltOutput('cobblestone')).toBe(0);
    expect(getFuelSmeltOutput('iron_ingot')).toBe(0);
  });
});

describe('planFuelTotals：全背包求和，够就 ok', () => {
  it('真机 case：oak_planks×1 + stick×4 烧 2 个 ⇒ 够（合计 3.5）', () => {
    const totals = planFuelTotals(botWith([{ name: 'oak_planks', count: 1 }, { name: 'stick', count: 4 }]), 2);
    expect(totals).not.toBeNull();
    expect(totals!.ok).toBe(true);
    expect(totals!.capacity).toBeCloseTo(3.5);
    expect(totals!.entries.map((e) => e.name)).toContain('stick');
  });
  it('真的不够（1 根木棍烧 2 个）⇒ ok=false 且给出合计容量', () => {
    const totals = planFuelTotals(botWith([{ name: 'stick', count: 1 }]), 2);
    expect(totals!.ok).toBe(false);
    expect(totals!.capacity).toBeCloseTo(0.5);
  });
  it('没有燃料 ⇒ null', () => {
    expect(planFuelTotals(botWith([{ name: 'cobblestone', count: 64 }]), 1)).toBeNull();
  });
});

describe('接线守卫：回执打印燃料账本，不硬编码单个物品', () => {
  it('ensureAggregateFuel 用 planFuelTotals + 打印"可用燃料/合计只能烧"', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
    expect(code).toContain('const totals = planFuelTotals(bot, smeltCount);');
    expect(code).toContain('可用燃料：${ledger}');
    expect(code).toContain('合计只能烧 ${Math.round(totals.capacity');
  });
});
