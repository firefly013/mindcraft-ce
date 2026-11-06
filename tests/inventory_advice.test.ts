/**
 * inventoryLossAdvice：把东西弄出背包之后，只报背包变化的事实。
 *
 * 背景：存箱子/丢弃之后，模型需要知道"背包少了什么、可放置方块还剩几个"，
 * 但不需要引擎替它写"该留什么、怎么腾格子"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLACEABLE_KEEP_MIN, inventoryLossAdvice } from '../src/shared/inventory_advice.js';
import { FOOD_VALUE } from '../src/body/safety/emergency.js';

const FOOD = (name: string): boolean => ['bread', 'cooked_beef', 'apple', 'mutton'].includes(name);
const PLACEABLE = (name: string): boolean =>
  ['cobblestone', 'stone', 'dirt', 'granite', 'andesite', 'diorite', 'netherrack', 'sand'].includes(name);

const advise = (before: Record<string, number>, after: Record<string, number>) =>
  inventoryLossAdvice({ before, after, isFood: FOOD, isPlaceable: PLACEABLE });

describe('inventoryLossAdvice：背包变化只报事实', () => {
  it('把最后一把镐存了 → 报背包减少与数量', () => {
    const advice = advise(
      { diamond_pickaxe: 1, torch: 8, bread: 3, cobblestone: 64 },
      { torch: 8, bread: 3, cobblestone: 64 },
    );
    expect(advice.level).toBe('warn');
    expect(advice.text).toBe('背包里少了diamond_pickaxe 1 个。');
  });

  it('把最后的食物存了 → 报"食物 0 个"和减少的物品', () => {
    const advice = advise({ bread: 3, stone: 40 }, { stone: 40 });
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('背包里少了bread 3 个，食物已经没有了。');
    expect(advice.text).toContain('背包里少了bread 3 个，食物已经没有了。');
  });

  it('只存垃圾（石头/泥土）→ 不输出', () => {
    const before = { stone: 64, dirt: 32, cobblestone: 64, diamond_pickaxe: 1, bread: 3, torch: 4 };
    const after = { cobblestone: 64, diamond_pickaxe: 1, bread: 3, torch: 4 };
    const advice = advise(before, after);
    expect(advice.level).toBe('none');
    expect(advice.text).toBe('');
  });

  it('背包被清空 + 没有食物 → 最响的一档，文案仍是事实', () => {
    const advice = advise({ diamond_pickaxe: 1, bread: 3, cobblestone: 32, stone: 10 }, {});
    expect(advice.level).toBe('loud');
    expect(advice.text).toContain('背包里少了diamond_pickaxe 1 个，bread 3 个，co');
    expect(advice.text).toContain('背包里少了diamond_pickaxe 1 个，bread 3 个，co');
    expect(advice.text).toContain(`可放置的方块还剩 0 个`);
    expect(advice.text).not.toContain('⚠️');
  });

  it('每样都留了一件 → 保持沉默', () => {
    const before = { diamond_pickaxe: 1, shield: 1, bread: 3, torch: 8, cobblestone: 64, stone: 32 };
    const after = { diamond_pickaxe: 1, shield: 1, bread: 3, torch: 8, cobblestone: 64 };
    const advice = advise(before, after);
    expect(advice.level).toBe('none');
    expect(advice.text).toBe('');
  });

  it('可放置方块掉到门槛以下 → 报实测剩余数量', () => {
    const advice = advise({ diamond_pickaxe: 1, bread: 3, dirt: 64 }, { diamond_pickaxe: 1, bread: 3 });
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain(`可放置的方块还剩 0 个`);
    expect(advice.text).not.toContain(String(PLACEABLE_KEEP_MIN));
  });

  it('物品减少按名称与数量逐个列出（最多 8 项）', () => {
    const advice = advise(
      { shield: 1, torch: 16, flint_and_steel: 1, iron_chestplate: 1, bread: 2, cobblestone: 64 },
      { bread: 2, cobblestone: 64 },
    );
    expect(advice.level).toBe('warn');
    for (const name of ['背包里少了shield 1 个，torch 16 个，flint_and_', '背包里少了shield 1 个，torch 16 个，flint_and_', '背包里少了shield 1 个，torch 16 个，flint_and_', '背包里少了shield 1 个，torch 16 个，flint_and_']) {
      expect(advice.text).toContain(name);
    }
  });

  it('同一类还有备份 → 只报实际减少的那一个', () => {
    const advice = advise(
      { stone_pickaxe: 2, bread: 3, cobblestone: 64 },
      { stone_pickaxe: 1, bread: 3, cobblestone: 64 },
    );
    expect(advice.level).toBe('warn');
    expect(advice.text).toContain('背包里少了stone_pickaxe 1 个。');
  });

  it('不再输出"留着的/可以存的"这类策略清单', () => {
    const advice = advise({ diamond_pickaxe: 1, bread: 3, cobblestone: 64 }, { bread: 3, cobblestone: 64 });
    expect(advice.text).not.toContain('留着的');
    expect(advice.text).not.toContain('可以存的');
    expect(advice.text).not.toContain('别存');
    expect(advice.text).not.toContain('建议');
  });

  it('用真实的 FOOD_VALUE 判断食物（面包/熟牛肉都算）', () => {
    const advice = inventoryLossAdvice({
      before: { diamond_pickaxe: 1, bread: 2, cooked_beef: 1 },
      after: { diamond_pickaxe: 1 },
      isFood: (name) => FOOD_VALUE[name] != null,
      isPlaceable: PLACEABLE,
    });
    expect(advice.text).toContain('背包里少了bread 2 个，cooked_beef 1 个，食物已经没有');
  });

  it('**丢掉**（不是存）也报同一套事实（不写"存进去"）', () => {
    const advice = inventoryLossAdvice({
      action: 'discard',
      before: { stone_pickaxe: 1, bread: 2, cobblestone: 64 },
      after: { bread: 2, cobblestone: 64 },
      isFood: FOOD,
      isPlaceable: PLACEABLE,
    });
    expect(advice.text).toContain('背包里少了stone_pickaxe 1 个。');
    expect(advice.text).not.toContain('存');
    expect(advice.text).not.toContain('别丢');
  });
});

describe('接线守卫：存物/丢弃路径给事实', () => {
  it('skills.putInChest / discard 接了 inventoryLossAdvice（interact 的 useBlock 不再追加建议）', () => {
    const root = process.cwd();
    const interactSrc = readFileSync(join(root, 'src', 'body', 'commands', 'interact.ts'), 'utf8');
    const skillsSrc = readFileSync(join(root, 'src', 'body', 'library', 'skills.ts'), 'utf8');
    expect(interactSrc).not.toContain("from '../../shared/inventory_advice.js'");
    expect(skillsSrc).toContain('inventoryLossAdvice(');
  });
});
