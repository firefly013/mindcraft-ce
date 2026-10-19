/**
 * 空手 bootstrap 链的第一环：**木头必须徒手可挖**。
 *
 * 真机 2026-10-19/20（overnight_a）「空手死锁全链」：`enterNether` 要武器、
 * `collectBlocks` 要镐、`craft` 要材料、箱子 server 端打不开 ⇒ **四条路全堵**。
 * 唯一的破局口是"空手砍木头 → 木板 → 工作台 → 木剑/木镐"，而这条路的第一步
 * 就卡在 `isHandMineable` 的阈值上：`oak_log` 徒手正好 3000ms，判定是 `<= 3000`，
 * **零余量**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BARE_HAND_MAX_DIG_MS, isHandMineable } from '../src/body/library/skills.js';

/** 仿 mineflayer 的 block：只需要 isHandMineable 会读的字段。 */
const block = (name: string, hardness: number, ms: number | null = null) =>
    ({
        name,
        hardness,
        diggable: true,
        digTime: () => (ms == null ? hardness * 1500 : ms),
    }) as any;

describe('isHandMineable：空手能挖穿的方块', () => {
  it('木头（徒手 3000ms）**必须过**——这是空手 bootstrap 的第一步', () => {
    expect(isHandMineable(block('oak_log', 2, 3000))).toBe(true);
    expect(isHandMineable(block('spruce_log', 2, 3000))).toBe(true);
  });

  it('阈值留了余量（3000 贴着旧上限，浮点抖动会把它挤出去）', () => {
    expect(BARE_HAND_MAX_DIG_MS).toBeGreaterThan(3000);
    // 3000.9ms（浮点/版本数据抖动）也必须过
    expect(isHandMineable(block('birch_log', 2, 3000.9))).toBe(true);
  });

  it('软方块照旧可挖：泥土/沙子/砂砾/下界岩', () => {
    expect(isHandMineable(block('dirt', 0.5, 750))).toBe(true);
    expect(isHandMineable(block('sand', 0.5, 750))).toBe(true);
    expect(isHandMineable(block('gravel', 0.6, 900))).toBe(true);
    expect(isHandMineable(block('netherrack', 0.4, 600))).toBe(true);
  });

  it('硬方块仍然拒绝（不许为了 bootstrap 把徒手挖石头放进来）', () => {
    expect(isHandMineable(block('stone', 1.5, 7500))).toBe(false);
    expect(isHandMineable(block('iron_ore', 3, 15000))).toBe(false);
  });

  it('不可破坏的一律拒绝（基岩/屏障）', () => {
    expect(isHandMineable({ name: 'bedrock', hardness: -1, diggable: false, digTime: () => Infinity } as any)).toBe(false);
  });

  it('读不到数据时不撒谎（返回 false 而不是"能挖"）', () => {
    expect(isHandMineable(null)).toBe(false);
    expect(isHandMineable({ name: 'mystery', hardness: null } as any)).toBe(false);
  });
});

describe('bootstrap 链的可执行性（源码守卫 + 材料账）', () => {
  const skills = () => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

  it('挖掘门用 isHandMineable 判"挖得穿"，不用 canHarvest（那会让空手永远挖不了）', () => {
    const src = skills();
    expect(src).toContain('if (!isHandMineable(block)) {');
    expect(src).toContain('if (!isHandMineable(target)) {');
  });

  it('`craft` 自带放/收工作台（所以链里不需要手动 placeHere/useBlock）', () => {
    const src = skills();
    expect(src).toContain("world.getNearestBlock(bot, 'crafting_table', craftingTableRange)");
    expect(src).toContain("await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);");
  });

  it('材料账：2 根原木刚好（桌 4 板 + 棍 2 板 + 剑 2 板 = 8 板），1 根不够', () => {
    // 这只是把"回执里承诺的链"钉在测试里，防止以后有人以为 1 根够。
    const planksPerLog = 4;
    const tablePlanks = 4;
    const swordPlanks = 2;
    const stickPlanks = 2;
    expect(tablePlanks + swordPlanks + stickPlanks).toBe(8);
    expect(8 / planksPerLog).toBe(2);
    expect(Math.ceil((tablePlanks + swordPlanks + stickPlanks) / planksPerLog)).toBeGreaterThan(1);
  });
});
