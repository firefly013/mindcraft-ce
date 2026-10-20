/**
 * `craft` 回执：未知 id 要给出**具体注册名**（不是只说"没这个物品"），且不许夹带无关句子
 * （真机 A：`craft(type="bed")` 的回执莫名写了「金装备注册名是 golden_*」）。
 * 另：**染色配方要同色**——做床需要 3 块同色羊毛，`white_wool×2 + black_wool×1` 不满足。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeDyedShortfall,
  dyedRecipeRequirement,
  formatUnknownItemReceipt,
  suggestItemFamilyIds,
} from '../src/body/library/item_names.js';

describe('suggestItemFamilyIds：family 名字要列具体 id', () => {
  it('bed ⇒ 16 种颜色床（white_bed/black_bed 在内）', () => {
    const ids = suggestItemFamilyIds('bed');
    expect(ids.length).toBeGreaterThanOrEqual(16);
    expect(ids).toContain('white_bed');
    expect(ids).toContain('black_bed');
  });
  it('wool ⇒ 具体颜色羊毛；planks ⇒ 各木种木板', () => {
    expect(suggestItemFamilyIds('wool')).toContain('white_wool');
    expect(suggestItemFamilyIds('planks').join(',')).toContain('oak_planks');
  });
  it('乱七八糟的名字 ⇒ []（不猜）', () => {
    expect(suggestItemFamilyIds('zzz_not_a_thing')).toEqual([]);
  });
});

describe('formatUnknownItemReceipt：给下一步 + 不夹无关句子', () => {
  it('bed：列出颜色 bed 的 id，且**不出现** golden_*（02:41 的噪音）', () => {
    const text = formatUnknownItemReceipt('bed');
    expect(text).toContain('没有 bed 这个物品');
    expect(text).toContain('white_bed');
    expect(text).toContain('你是想找这些吗');
    expect(text).not.toContain('golden_');
  });
  it('gold_boots 这种明显相关的才提示 golden_*（有用的别名，不删干净）', () => {
    expect(formatUnknownItemReceipt('gold_boots')).toContain('golden_*');
  });
});

describe('染色配方：同色数量要求是可测的', () => {
  it('bed = 3 同色 wool；carpet = 2；banner = 6', () => {
    expect(dyedRecipeRequirement('white_bed')).toMatchObject({ count: 3, colourPrefix: 'white' });
    expect(dyedRecipeRequirement('red_carpet')).toMatchObject({ count: 2 });
    expect(dyedRecipeRequirement('blue_banner')).toMatchObject({ count: 6 });
    expect(dyedRecipeRequirement('oak_planks')).toBeNull();
  });
  it('真机 A 的背包（white_wool×2 + black_wool×1）⇒ 明说差 1 块白的、混色不行', () => {
    const counts: Record<string, number> = { white_wool: 2, black_wool: 1 };
    const text = describeDyedShortfall('white_bed', (name) => counts[name] ?? 0, ['white_wool', 'black_wool']);
    expect(text).toContain('3 块同色的 white_wool');
    expect(text).toContain('混色不行');
    expect(text).toContain('white_wool 只有 2 块');
    expect(text).toContain('再去弄 1 块**white**');
  });
  it('同色羊毛够 ⇒ 不报短（让合成照常走）', () => {
    const counts: Record<string, number> = { white_wool: 3 };
    expect(describeDyedShortfall('white_bed', (name) => counts[name] ?? 0, ['white_wool'])).toBeNull();
  });
});

describe('接线守卫', () => {
  const src = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
  it('未知物品回执改用统一 helper；旧的 golden 括注已删除', () => {
    const code = src();
    expect(code).toContain('formatUnknownItemReceipt(itemName)');
    expect(code).toContain('formatUnknownItemReceipt(wanted.name)');
    expect(code).not.toContain('金装备的注册名是 golden_*（如 golden_boots）；` +');
  });
  it('合成前先查染色同色缺口（craftSmartDetailed）', () => {
    expect(src()).toContain('const shortfall = describeDyedShortfall(');
  });
});
