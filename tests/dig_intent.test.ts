/**
 * 挖掘的两种意图（用户 2026-10-24 定的设计；判据 2026-10-27 修正）：
 *
 *   1. **采集**（默认）：我要掉落物。
 *      判据 =「**背包里**有没有能收获它的工具」（`block.canHarvest(item.type)`）。
 *      **手上举着什么不算数**，空手挖得快不快也不算数——2026-10-27 的裁定：
 *      手上没举起来 ≠ 没有工具；挖掘等级不够才叫没有。
 *   2. **挖穿**（`force=true`）：我不在乎掉落，用最好的工具硬挖开。可能很慢。
 *      只有真的挖不动（基岩/不可破坏）才拒绝。
 *
 * 历史：更早一版靠 `isStuckInPlace`（头顶/四面实心）**推断**"是不是卡住了"才放宽，
 * 那是替模型做决定；上一版换成"徒手 ≤3.2 秒"豁免，判的是**快慢**而不是**能不能掉落**
 * （背里有镐、手上没举起来时它会给出错误答案）。现在意图由 `force` 说，
 * 能力由 `harvestTools` 说，两边都不猜。
 */
import { describe, expect, it } from 'vitest';
import {
  bareHandDigMs,
  bestHarvestTool,
  harvestToolsFor,
  planDig,
  requiresHarvestTool,
} from '../src/body/library/skills.js';

const WOOD_PICK = { name: 'wooden_pickaxe', type: 11 };
const IRON_PICK = { name: 'iron_pickaxe', type: 12 };
const DIAMOND_PICK = { name: 'diamond_pickaxe', type: 13 };
const WOOD_AXE = { name: 'wooden_axe', type: 21 };

/**
 * 仿 prismarine-block 的方块：
 * - `harvestTools` 缺失/空表 = 空手也有掉落；
 * - 非空 = 只有表里的物品 type 才有掉落（`canHarvest` 的原版语义）；
 * - 空手 digTime = hardness × 5000（和 `bareHandDigMs` 的经验公式一致）。
 */
function block(name: string, hardness: number, harvestTools?: Record<number, boolean>): any {
  const b: any = {
    name,
    hardness,
    diggable: true,
    harvestTools,
    digTime: (id: number | null) =>
      id != null && harvestTools?.[id] ? (hardness * 5000) / 3 : hardness * 5000,
  };
  b.canHarvest = (id: number | null) => (harvestTools == null ? true : id != null && harvestTools[id] === true);
  return b;
}

const stone = block('stone', 1.5, {
  [WOOD_PICK.type]: true,
  [IRON_PICK.type]: true,
  [DIAMOND_PICK.type]: true,
});
const deepslate = block('deepslate', 3, { [WOOD_PICK.type]: true, [IRON_PICK.type]: true, [DIAMOND_PICK.type]: true });
const obsidian = block('obsidian', 50, { [DIAMOND_PICK.type]: true });
const dirt = block('dirt', 0.5);
const log = block('oak_log', 2);
const bedrock = {
  name: 'bedrock',
  hardness: -1,
  diggable: false,
  digTime: () => Infinity,
  canHarvest: () => false,
} as any;

/** 生存模式；`pack` 是背包，`held` 是手上那把（也可能不在 pack 里，模拟同步差异）。 */
function bot(opts: { held?: { name: string; type: number } | null; pack?: Array<{ name: string; type: number }> } = {}): any {
  return {
    game: { gameMode: 'survival' },
    heldItem: opts.held ?? null,
    inventory: { items: () => opts.pack ?? [] },
  };
}

describe('planDig：采集意图（默认）', () => {
  it('**背包里有镐、手上空着 ⇒ 直接挖**（手上没举起来 ≠ 没有工具）', () => {
    const plan = planDig(bot({ pack: [DIAMOND_PICK] }), stone);
    expect(plan.ok).toBe(true);
    expect(plan.drops).toBe(true);
    expect(plan.note).toContain('diamond_pickaxe');
    expect(plan.note).toContain('会先换上');
  });

  it('多把镐 ⇒ 挑档位最高的那把，并在回执里点名', () => {
    const plan = planDig(bot({ pack: [WOOD_PICK, IRON_PICK, DIAMOND_PICK] }), stone);
    expect(plan.note).toContain('diamond_pickaxe');
    expect(plan.note).not.toContain('wooden_pickaxe');
  });

  it('手上已经举着那把 ⇒ 回执一个字都不加', () => {
    const plan = planDig(bot({ held: DIAMOND_PICK, pack: [DIAMOND_PICK] }), stone);
    expect(plan.ok).toBe(true);
    expect(plan.drops).toBe(true);
    expect(plan.note).toBe('');
  });

  it('手上举着但背包读不到它 ⇒ 仍然算"有"（不能把举着镐的人判成没工具）', () => {
    const plan = planDig(bot({ held: DIAMOND_PICK, pack: [] }), stone);
    expect(plan.ok).toBe(true);
    expect(plan.drops).toBe(true);
  });

  it('**不需要工具的方块（泥土/原木）⇒ 空手直接挖，而且有掉落**', () => {
    for (const b of [dirt, log]) {
      const plan = planDig(bot(), b);
      expect(plan.ok).toBe(true);
      expect(plan.drops).toBe(true);
      expect(plan.note).toBe('');
    }
  });

  it('背包里只有斧子（不能收获石头）⇒ 拒绝，并告诉模型可以加 force', () => {
    const plan = planDig(bot({ held: WOOD_AXE, pack: [WOOD_AXE] }), stone);
    expect(plan.ok).toBe(false);
    expect(plan.drops).toBe(false);
    expect(plan.note).toContain('没有能挖 stone 的工具');
    // 关键：拒绝文案必须给出"下一步能照做"的出路，否则模型只会重发同一条命令
    expect(plan.note).toContain('force=true');
  });

  it('深板岩/黑曜石：等级不够就拒绝（黑曜石只认钻石镐）', () => {
    expect(planDig(bot(), deepslate).ok).toBe(false);
    expect(planDig(bot({ pack: [WOOD_PICK] }), obsidian).ok).toBe(false);
    expect(planDig(bot({ pack: [DIAMOND_PICK] }), obsidian).ok).toBe(true);
  });
});

describe('planDig：挖穿意图（force=true）', () => {
  it('石头：放行，明说约 7.5 秒、没有掉落', () => {
    const plan = planDig(bot(), stone, true);
    expect(plan.ok).toBe(true);
    expect(plan.drops).toBe(false);
    expect(plan.note).toContain('force 挖穿 stone');
    expect(plan.note).toContain('7.5 秒');
    expect(plan.note).toContain('没有掉落');
  });

  it('黑曜石：徒手 250 秒也放行（模型说了 force，工具不再替它嫌慢）', () => {
    const plan = planDig(bot(), obsidian, true);
    expect(plan.ok).toBe(true);
    expect(plan.drops).toBe(false);
    expect(plan.note).toContain('250 秒');
  });

  it('**只有挖不动才拒绝**：基岩 force 也没用', () => {
    const plan = planDig(bot(), bedrock, true);
    expect(plan.ok).toBe(false);
    expect(plan.note).toContain('挖不动');
    expect(plan.note).toContain('force 也帮不了你');
  });

  it('背包里有工具时 force 也放行，drops 按真实情况报 true', () => {
    const plan = planDig(bot({ pack: [DIAMOND_PICK] }), stone, true);
    expect(plan.ok).toBe(true);
    expect(plan.drops).toBe(true);
  });

  it('创造模式永远放行', () => {
    const plan = planDig({ game: { gameMode: 'creative' }, heldItem: null, inventory: { items: () => [] } }, stone);
    expect(plan.ok).toBe(true);
    expect(plan.drops).toBe(true);
  });
});

describe('判据只有一处：harvestTools 说了算', () => {
  it('requiresHarvestTool：泥土/原木不用，石头要', () => {
    expect(requiresHarvestTool(dirt)).toBe(false);
    expect(requiresHarvestTool(log)).toBe(false);
    expect(requiresHarvestTool(stone)).toBe(true);
    expect(requiresHarvestTool(null)).toBe(false);
  });

  it('harvestToolsFor：只留能收获的，按档位从高到低', () => {
    const tools = harvestToolsFor(bot({ pack: [WOOD_AXE, WOOD_PICK, DIAMOND_PICK] }), stone);
    expect(tools.map((t) => t.name)).toEqual(['diamond_pickaxe', 'wooden_pickaxe']);
    expect(bestHarvestTool(bot({ pack: [WOOD_AXE] }), stone)).toBeNull();
  });

  it('bareHandDigMs 仍然只回答"徒手多久"（给拒绝文案用，不再当判据）', () => {
    // 单独给显式 digTime 的夹具：这里的数是原版数量级，别拿上面的假公式凑。
    const bareStone = { name: 'stone', hardness: 1.5, diggable: true, digTime: () => 7_500 };
    const bareDirt = { name: 'dirt', hardness: 0.5, diggable: true, digTime: () => 750 };
    expect(bareHandDigMs(bareStone)).toBe(7_500);
    expect(bareHandDigMs(bareDirt)).toBe(750);
    expect(bareHandDigMs(bedrock)).toBeNull();
    expect(bareHandDigMs(null)).toBeNull();
  });

  it('同一块方块，两种意图给出不同答案——差别只来自 force，不来自世界状态', () => {
    // 这是重构的核心不变量：**换任何环境变量都不该改变答案**。
    const empty = bot();
    const sealed = { ...bot(), entity: { position: { x: 0.5, y: 64, z: 0.5 } }, blockAt: () => stone };
    for (const b of [empty, sealed]) {
      expect(planDig(b, stone).ok).toBe(false);
      expect(planDig(b, stone, true).ok).toBe(true);
    }
  });
});
