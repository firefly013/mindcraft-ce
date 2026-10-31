/**
 * 空手 bootstrap 链的第一环：**木头必须能挖**。
 *
 * 真机 2026-10-19/20（overnight_a）「空手死锁全链」：`enterNether` 要武器、
 * `collectBlocks` 要镐、`craft` 要材料、箱子 server 端打不开 ⇒ **四条路全堵**。
 * 唯一的破局口是"空手砍木头 → 木板 → 工作台 → 木剑/木镐"。
 *
 * 2026-10-27 判据修正后，这一环由**原版数据**保证：原木的 `harvestTools` 是空的
 * ⇒ 不需要工具 ⇒ 空手就有掉落。不再靠"徒手耗时 ≤3.2 秒"那种快慢阈值
 * （它会把"背里有镐、手上没举起来"误判成没工具）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planDig, requiresHarvestTool } from '../src/body/library/skills.js';

const PICK = { name: 'wooden_pickaxe', type: 11 };

/** 仿 prismarine-block：`harvestTools` 缺失 = 空手也有掉落。 */
const block = (name: string, hardness: number, harvestTools?: Record<number, boolean>): any => {
  const b: any = {
    name,
    hardness,
    diggable: true,
    harvestTools,
    digTime: () => hardness * 5000,
  };
  b.canHarvest = (id: number | null) => (harvestTools == null ? true : id != null && harvestTools[id] === true);
  return b;
};

const bare = (pack: Array<{ name: string; type: number }> = []): any => ({
  game: { gameMode: 'survival' },
  heldItem: null,
  inventory: { items: () => pack },
});

describe('空手 bootstrap：第一步必须走得通', () => {
  it('原木**不需要工具** ⇒ 空手直接挖，而且有掉落', () => {
    for (const name of ['oak_log', 'spruce_log', 'birch_log']) {
      const plan = planDig(bare(), block(name, 2));
      expect(requiresHarvestTool(block(name, 2))).toBe(false);
      expect(plan.ok).toBe(true);
      expect(plan.drops).toBe(true);
    }
  });

  it('泥土/沙子/砂砾同理（都不需要工具）', () => {
    for (const [name, hardness] of [
      ['dirt', 0.5],
      ['sand', 0.5],
      ['gravel', 0.6],
    ] as const) {
      const plan = planDig(bare(), block(name, hardness));
      expect(plan.ok).toBe(true);
      expect(plan.drops).toBe(true);
    }
  });

  // 回归：**下界岩要镐**（原版 harvestTools 有 6 种镐）。空手能把它挖开，
  // 但一个也不掉——所以采集意图下必须拒绝，让模型加 force 或先弄镐。
  it('下界岩：要镐 ⇒ 空手拒绝 + force；包里有镐就放行', () => {
    const netherrack = block('netherrack', 0.4, { [PICK.type]: true });
    expect(requiresHarvestTool(netherrack)).toBe(true);
    const plan = planDig(bare(), netherrack);
    expect(plan.ok).toBe(false);
    expect(plan.note).toContain('force=true');
    expect(planDig(bare([PICK]), netherrack).ok).toBe(true);
  });

  it('石头/铁矿**要工具**：空手时拒绝，并要求 force', () => {
    for (const [name, hardness] of [
      ['stone', 1.5],
      ['iron_ore', 3],
    ] as const) {
      const b = block(name, hardness, { [PICK.type]: true });
      const plan = planDig(bare(), b);
      expect(plan.ok).toBe(false);
      expect(plan.note).toContain('force=true');
      // 背包里有镐就立刻放行（同一条规则的另一半）
      expect(planDig(bare([PICK]), b).ok).toBe(true);
    }
  });

  it('不可破坏的一律拒绝（基岩/屏障），force 也没用', () => {
    const bedrock = { name: 'bedrock', hardness: -1, diggable: false, digTime: () => Infinity, canHarvest: () => false } as any;
    expect(planDig(bare(), bedrock).ok).toBe(false);
    expect(planDig(bare(), bedrock, true).ok).toBe(false);
  });
});

describe('bootstrap 链的可执行性（源码守卫 + 材料账）', () => {
  const skills = () => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

  it('挖掘门只有一处裁判（planDig），且判据是"背包里能不能收获"', () => {
    const src = skills();
    // mineBlockAt / breakBlockAt(stairUp·digDown·pillarUp) / digLine 都必须来问它，
    // 不许各自抄一份门槛——真机 2026-10-23 就是只改了一边，两个工具互相矛盾。
    const calls = src.match(/planDig\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain('export function planDig(');
    expect(src).toContain('export function bestHarvestTool(');
    expect(src).toContain('const best = bestHarvestTool(bot, block);');
    // **不许再有"徒手耗时"判据**：那条判的是快慢，不是能不能掉落（2026-10-27 用户裁定）。
    // 注释里可以提这个名字解释历史，但不许有定义、不许有调用。
    expect(src).not.toContain('export const BARE_HAND_MAX_DIG_MS');
    expect(src).not.toContain('export function isHandMineable');
    expect(src).not.toMatch(/isHandMineable\(/);
    // **不许再出现"猜意图"的开关**：判据只能来自 force，不能来自世界状态。
    // （注释里可以留 `isStuckInPlace` 这个名字解释历史，但不许有定义、不许有调用。）
    expect(src).not.toContain('export function isStuckInPlace');
    expect(src).not.toMatch(/isStuckInPlace\(/);
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
