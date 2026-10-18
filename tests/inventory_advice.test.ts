/**
 * 存箱子前的保命清单提醒 —— 真机 2026-10-18 19:20（overnight_a）的回归。
 *
 * 事故：出发给饿着的队友找食物之前"整理背包"，回来时背包**全空**
 * （`Backpack (free 36): empty`、`Held: main empty`）——镐、剑、食物、
 * 垫脚方块全存进箱子了；它自己后来说"这样出门没用"，而队友 food 0
 * 在原地等一场**出发不了**的救援。
 *
 * 要求：在那个决定发生的回执里把后果说清楚（警告，不是拒绝），
 * 并且分清"垃圾"和"装备"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLACEABLE_KEEP_MIN,
  inventoryLossAdvice,
} from '../src/shared/inventory_advice.js';
import { FOOD_VALUE } from '../src/body/safety/emergency.js';

const FOOD = (name: string): boolean => ['bread', 'cooked_beef', 'apple', 'mutton'].includes(name);
const PLACEABLE = (name: string): boolean =>
  ['cobblestone', 'stone', 'dirt', 'granite', 'andesite', 'diorite', 'netherrack', 'sand'].includes(name);

const advise = (before: Record<string, number>, after: Record<string, number>) =>
  inventoryLossAdvice({ before, after, isFood: FOOD, isPlaceable: PLACEABLE });

describe('inventoryLossAdvice：存箱子前的保命清单', () => {
  it('把最后一把镐存了 → 警告并点名（存完就挖不动了）', () => {
    const advice = advise(
      { diamond_pickaxe: 1, torch: 8, bread: 3, cobblestone: 64 },
      { torch: 8, bread: 3, cobblestone: 64 },
    );
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('diamond_pickaxe');
    expect(advice.text).toContain('镐');
    expect(advice.text).toContain('挖不动');
    expect(advice.text).toContain('建议留着');
  });

  it('把最后的食物存了 → 警告（存完就没吃的了）', () => {
    const advice = advise({ bread: 3, stone: 40 }, { stone: 40 });
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('没有吃的');
    expect(advice.text).toContain('食物');
  });

  it('只存垃圾（石头/泥土）→ **不唠叨**', () => {
    const before = { stone: 64, dirt: 32, cobblestone: 64, diamond_pickaxe: 1, bread: 3, torch: 4 };
    const after = { cobblestone: 64, diamond_pickaxe: 1, bread: 3, torch: 4 };
    const advice = advise(before, after);
    expect(advice.level).toBe('none');
    expect(advice.text).toBe('');
  });

  it('背包被清空 + 没有食物 → **最响的一档**（19:20 那次）', () => {
    const advice = advise({ diamond_pickaxe: 1, bread: 3, cobblestone: 32, stone: 10 }, {});
    expect(advice.level).toBe('loud');
    expect(advice.text).toContain('⚠️⚠️');
    expect(advice.text).toContain('既没有食物');
    expect(advice.text).toContain('出发不了的救援');
  });

  it('"没吃的 + 没工具 + 垫脚方块不够"也算最响的一档（包没全空也一样）', () => {
    const advice = advise({ stone_pickaxe: 1, bread: 2, cobblestone: 32 }, { stone: 5 });
    expect(advice.level).toBe('loud');
  });

  it('每样都留了一件 → 保持沉默', () => {
    const before = { diamond_pickaxe: 1, shield: 1, bread: 3, torch: 8, cobblestone: 64, stone: 32 };
    const after = { diamond_pickaxe: 1, shield: 1, bread: 3, torch: 8, cobblestone: 64 };
    const advice = advise(before, after);
    expect(advice.level).toBe('none');
    expect(advice.text).toBe('');
  });

  it('可放置方块掉到 32 以下 → 警告（垫脚/搭桥要用）', () => {
    const advice = advise({ diamond_pickaxe: 1, bread: 3, dirt: 64 }, { diamond_pickaxe: 1, bread: 3 });
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('可放置方块只剩 0 个');
    expect(advice.text).toContain(String(PLACEABLE_KEEP_MIN));
  });

  it('盾/火把/打火石/护甲的最后一件也会被点名', () => {
    const advice = advise(
      { shield: 1, torch: 16, flint_and_steel: 1, iron_chestplate: 1, bread: 2, cobblestone: 64 },
      { bread: 2, cobblestone: 64 },
    );
    expect(advice.level).toBe('warn');
    for (const name of ['shield', 'torch', 'flint_and_steel', 'iron_chestplate']) {
      expect(advice.text, `${name} 该被点名`).toContain(name);
    }
  });

  it('同一类还有备份 → 不点名（有 2 把镐，存 1 把没事）', () => {
    const advice = advise(
      { stone_pickaxe: 2, bread: 3, cobblestone: 64 },
      { stone_pickaxe: 1, bread: 3, cobblestone: 64 },
    );
    expect(advice.level).toBe('none');
  });

  it('回执里一直分清"留着的"和"可以存的"（垃圾 vs 装备）', () => {
    const advice = advise({ diamond_pickaxe: 1, bread: 3, cobblestone: 64 }, { bread: 3, cobblestone: 64 });
    expect(advice.text).toContain('留着的（别存）');
    expect(advice.text).toContain('可以存的');
    expect(advice.text).toContain('石头');
    expect(advice.text).toContain('下界岩');
  });

  it('用真实的 FOOD_VALUE 判断食物（面包/熟牛肉都算）', () => {
    const advice = inventoryLossAdvice({
      before: { diamond_pickaxe: 1, bread: 2, cooked_beef: 1 },
      after: { diamond_pickaxe: 1 },
      isFood: (name) => FOOD_VALUE[name] != null,
      isPlaceable: PLACEABLE,
    });
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('没有吃的');
  });

  it('**丢掉**（不是存）也吃同一套提醒，措辞如实说"丢"（丢出去捡不回来）', () => {
    const advice = inventoryLossAdvice({
      action: 'discard',
      before: { stone_pickaxe: 1, bread: 2, cobblestone: 64 },
      after: { bread: 2, cobblestone: 64 },
      isFood: FOOD,
      isPlaceable: PLACEABLE,
    });
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('丢掉');
    expect(advice.text).not.toContain('存进去');
    expect(advice.text).toContain('别丢保命的');
  });
});

describe('接线守卫：两条存物路径都必须给提醒（架构守卫）', () => {
  it('useBlock 的 deposit 分支与 skills.putInChest 都调了 inventoryLossAdvice', () => {
    const root = process.cwd();
    const interactSrc = readFileSync(join(root, 'src', 'body', 'commands', 'interact.ts'), 'utf8');
    const skillsSrc = readFileSync(join(root, 'src', 'body', 'library', 'skills.ts'), 'utf8');
    expect(interactSrc).toContain('inventoryLossAdvice(');
    expect(skillsSrc).toContain('inventoryLossAdvice(');
    // deposit 分支要拿**整包**账目，否则回答不了"我还剩什么"。
    expect(interactSrc).toMatch(/packBefore[\s\S]{0,400}packAfter/);
  });
});
