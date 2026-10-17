import { describe, expect, it } from 'vitest';
import {
  NETHER_PORTAL_OBSIDIAN_COST,
  assessPortalMaterials,
  chooseScaffoldMaterial,
  dimensionChanged,
  dimensionOf,
  enterNether,
  evaluatePortalSite,
  formatPoint,
  isAirBlock,
  isNetherDimension,
  isSafeFloorBlock,
  planPortal,
  pointKey,
  portalReceipt,
  selectPortalPlan,
  type PortalPlan,
  type PortalPoint,
} from '../src/body/library/nether_portal.js';
import { TOOL_TEXT, td } from '../src/shared/prompts.js';
import { findCommand, toolDeclarations } from '../src/body/commands/registry.js';

/** 用一个 Map 当作只读方块世界；没写的格子默认空气。 */
function mapProbe(map: Map<string, string>, fallback: string | null = 'air') {
  return (x: number, y: number, z: number): string | null =>
    map.get(pointKey({ x, y, z })) ?? fallback;
}

/** 给一个门框铺出最小可建造现场：框内空气、底边有地、两侧入口可站。 */
function validWorld(plan: PortalPlan): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of plan.frameBlocks) map.set(pointKey(p), 'air');
  for (const p of plan.interiorBlocks) map.set(pointKey(p), 'air');
  for (const p of plan.frameBlocks.slice(0, 2)) {
    map.set(pointKey({ x: p.x, y: p.y - 1, z: p.z }), 'stone');
  }
  for (const approach of plan.approaches) {
    for (const p of [...approach.standBlocks, ...approach.headBlocks]) map.set(pointKey(p), 'air');
    for (const p of approach.standBlocks) {
      map.set(pointKey({ x: p.x, y: p.y - 1, z: p.z }), 'stone');
    }
  }
  return map;
}

describe('材料判断（纯函数）', () => {
  it('10 黑曜石 + 1 打火石才够，并给出准确缺额', () => {
    const ok = assessPortalMaterials({ obsidian: 10, flint_and_steel: 1, dirt: 64 });
    expect(ok.ok).toBe(true);
    expect(ok.requiredObsidian).toBe(NETHER_PORTAL_OBSIDIAN_COST);
    expect(ok.missingObsidian).toBe(0);
    expect(ok.missingFlintAndSteel).toBe(0);
    expect(ok.message).toContain('材料足够');
    expect(ok.message).toContain('黑曜石 10/10');

    const short = assessPortalMaterials({ obsidian: 7 });
    expect(short.ok).toBe(false);
    expect(short.missingObsidian).toBe(3);
    expect(short.missingFlintAndSteel).toBe(1);
    expect(short.message).toContain('黑曜石 7/10');
    expect(short.message).toContain('还缺 3');
    expect(short.message).toContain('打火石 0/1');
  });

  it('重复调用时允许按剩余门框降门槛', () => {
    const partial = assessPortalMaterials({ obsidian: 3, flint_and_steel: 1 }, 3);
    expect(partial.ok).toBe(true);
    expect(partial.requiredObsidian).toBe(3);
    expect(partial.message).toContain('黑曜石 3/3');
  });

  it('背包读不到/非法数值按 0 算，绝不猜成够', () => {
    expect(assessPortalMaterials(null).ok).toBe(false);
    expect(assessPortalMaterials({ obsidian: Number.NaN, flint_and_steel: -1 }).obsidian).toBe(0);
    expect(assessPortalMaterials({ obsidian: 12, flint_and_steel: 2 }).ok).toBe(true);
  });
});

describe('门框几何（纯函数）', () => {
  it('axis=x：10 块唯一门框、2×3 内部、入口在 z 两侧', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');
    expect(plan.frameBlocks).toHaveLength(10);
    expect(new Set(plan.frameBlocks.map(pointKey)).size).toBe(10);
    expect(plan.interiorBlocks).toHaveLength(6);
    expect(new Set(plan.interiorBlocks.map(pointKey)).size).toBe(6);
    expect(plan.frameBlocks[0]).toEqual({ x: 11, y: 64, z: 20 });
    expect(plan.frameBlocks[1]).toEqual({ x: 12, y: 64, z: 20 });
    expect(plan.ignitionBlock).toEqual(plan.frameBlocks[0]);
    expect(plan.entryTarget).toEqual({ x: 11.5, y: 65, z: 20.5 });
    expect(plan.supportCorners).toHaveLength(4);
    expect(plan.approaches.map((a) => a.side)).toEqual([-1, 1]);
    expect(plan.approaches[0]?.standBlocks).toEqual([
      { x: 11, y: 64, z: 19 },
      { x: 12, y: 64, z: 19 },
    ]);
  });

  it('axis=z：门面沿 z 展开，入口在 x 两侧', () => {
    const plan = planPortal({ x: -3, y: 70, z: 4 }, 'z');
    expect(plan.frameBlocks).toHaveLength(10);
    expect(plan.interiorBlocks).toHaveLength(6);
    expect(plan.entryTarget).toEqual({ x: -2.5, y: 71, z: 5.5 });
    expect(plan.approaches[1]?.standBlocks).toEqual([
      { x: -2, y: 70, z: 5 },
      { x: -2, y: 70, z: 6 },
    ]);
  });

  it('背包垫块选择：优先常见建材，数量不够就换下一种', () => {
    expect(chooseScaffoldMaterial({ dirt: 4 }, 4)).toEqual({ material: 'dirt', count: 4 });
    expect(chooseScaffoldMaterial({ dirt: 3, cobblestone: 9 }, 4)).toEqual({
      material: 'cobblestone',
      count: 4,
    });
    expect(chooseScaffoldMaterial({ dirt: 3 }, 4)).toBeNull();
    expect(chooseScaffoldMaterial({ dirt: 99 }, 0)).toBeNull();
  });
  it('门框坐标永远是整数（防止把 10.5 这种坐标交给 placeBlock）', () => {
    const plan = planPortal({ x: 10.9, y: 64.8, z: 20.2 }, 'x');
    expect(plan.base).toEqual({ x: 10, y: 64, z: 20 });
    expect(plan.frameBlocks.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z))).toBe(true);
  });
});

describe('选址预检（纯函数）', () => {
  it('完整现场通过，并返回第一条可站立入口', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');
    const result = evaluatePortalSite(plan, mapProbe(validWorld(plan)));
    expect(result.ok).toBe(true);
    expect(result.existingObsidian).toBe(0);
    expect(result.existingPortal).toBe(false);
    expect(result.approach?.side).toBe(-1);
    expect(result.scaffoldBlocks).toHaveLength(4);
  });

  it('门框格被占用时拒绝，不假设 placeBlock 会替我们清理', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');
    const map = validWorld(plan);
    map.set(pointKey(plan.frameBlocks[4] as PortalPoint), 'stone');
    const result = evaluatePortalSite(plan, mapProbe(map));
    expect(result.ok).toBe(false);
    expect(result.blockedAt).toEqual(plan.frameBlocks[4]);
    expect(result.reason).toContain('不是空气');
    expect(result.reason).toContain('避免挖掉现场');
  });

  it('门内被堵、底边悬空、两侧入口都被堵都要分别拒绝', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');

    const interior = validWorld(plan);
    interior.set(pointKey(plan.interiorBlocks[2] as PortalPoint), 'dirt');
    expect(evaluatePortalSite(plan, mapProbe(interior)).reason).toContain('门内');

    const floor = validWorld(plan);
    const bottom = plan.frameBlocks[0] as PortalPoint;
    floor.set(pointKey({ x: bottom.x, y: bottom.y - 1, z: bottom.z }), 'air');
    expect(evaluatePortalSite(plan, mapProbe(floor)).reason).toContain('下方不是安全地面');

    const entry = validWorld(plan);
    for (const approach of plan.approaches) {
      entry.set(pointKey(approach.standBlocks[0] as PortalPoint), 'stone');
    }
    expect(evaluatePortalSite(plan, mapProbe(entry)).reason).toContain('没有可站立的入口');
  });

  it('半成品门框会计入已有黑曜石；已点燃的传送门也能识别', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');
    const map = validWorld(plan);
    for (const p of plan.frameBlocks.slice(0, 4)) map.set(pointKey(p), 'obsidian');
    map.set(pointKey(plan.interiorBlocks[0] as PortalPoint), 'nether_portal');
    const result = evaluatePortalSite(plan, mapProbe(map));
    expect(result.ok).toBe(true);
    expect(result.existingObsidian).toBe(4);
    expect(result.existingPortal).toBe(true);
  });

  it('施工顺序保证每个垫块/门框块都有相邻面可依附（不靠拆方块悬空放）', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');
    const solids = new Set<string>();
    const addFloor = (p: PortalPoint): void => {
      solids.add(pointKey({ x: p.x, y: p.y - 1, z: p.z }));
    };
    for (const p of plan.frameBlocks.slice(0, 2)) addFloor(p);
    for (const p of plan.supportCorners) addFloor(p);

    const neighborKeys = (p: PortalPoint): string[] => [
      pointKey({ x: p.x + 1, y: p.y, z: p.z }),
      pointKey({ x: p.x - 1, y: p.y, z: p.z }),
      pointKey({ x: p.x, y: p.y + 1, z: p.z }),
      pointKey({ x: p.x, y: p.y - 1, z: p.z }),
      pointKey({ x: p.x, y: p.y, z: p.z + 1 }),
      pointKey({ x: p.x, y: p.y, z: p.z - 1 }),
    ];
    const placeWithSupport = (p: PortalPoint): void => {
      expect(neighborKeys(p).some((key) => solids.has(key))).toBe(true);
      solids.add(pointKey(p));
    };

    for (const p of plan.supportCorners.filter((q) => q.y === plan.base.y)) placeWithSupport(p);
    for (const p of plan.frameBlocks.slice(0, 8)) placeWithSupport(p);
    for (const p of plan.supportCorners.filter((q) => q.y === plan.base.y + 4)) placeWithSupport(p);
    for (const p of plan.frameBlocks.slice(8)) placeWithSupport(p);
  });
  it('门角是危险方块时拒绝；空气门角列入临时垫块清单', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');
    const unsafe = validWorld(plan);
    unsafe.set(pointKey(plan.supportCorners[0] as PortalPoint), 'lava');
    const result = evaluatePortalSite(plan, mapProbe(unsafe));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('不能作为临时支撑');
  });
  it('方块读不到时明确失败，不默认当空气', () => {
    const plan = planPortal({ x: 10, y: 64, z: 20 }, 'x');
    const result = evaluatePortalSite(plan, () => null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('无法读取');
  });

  it('空气/安全地面判定覆盖常见危险方块', () => {
    expect(isAirBlock('air')).toBe(true);
    expect(isAirBlock('cave_air')).toBe(true);
    expect(isAirBlock('stone')).toBe(false);
    expect(isSafeFloorBlock('stone')).toBe(true);
    expect(isSafeFloorBlock('water')).toBe(false);
    expect(isSafeFloorBlock('magma_block')).toBe(false);
    expect(isSafeFloorBlock('air')).toBe(false);
  });
});

describe('候选选址（纯函数）', () => {
  it('半径 0 时找到并返回唯一可用门址', () => {
    const base = { x: 2, y: 64, z: 0 };
    const expected = planPortal(base, 'x');
    const probe = mapProbe(validWorld(expected));
    const feet = { x: base.x, y: 64, z: base.z };
    const selected = selectPortalPlan(feet, probe, { radius: 0 });
    expect(selected.plan?.base).toEqual(base);
    expect(selected.plan?.axis).toBe('x');
    expect(selected.evaluation?.ok).toBe(true);
  });

  it('所有候选都被实心方块占住时返回 null 和可读原因', () => {
    const selected = selectPortalPlan({ x: 0, y: 64, z: 0 }, () => 'stone', { radius: 2 });
    expect(selected.plan).toBeNull();
    expect(selected.reason).toContain('没有找到');
  });

  it('forbiddenBlocks 会阻止把门框盖在 bot 身上', () => {
    const base = { x: 2, y: 64, z: 0 };
    const expected = planPortal(base, 'x');
    const probe = mapProbe(validWorld(expected));
    const feet = { x: base.x, y: 64, z: base.z };
    const selected = selectPortalPlan(feet, probe, {
      radius: 0,
      forbiddenBlocks: [{ x: 3, y: 64, z: 0 }],
    });
    // x 轴候选被 forbidden 跳过；z 轴候选在同一 base 上继续评估。
    expect(selected.plan?.axis === 'x' && selected.plan.base.x === 2).toBe(false);
  });
});

describe('维度与回执辅助', () => {
  it('规范化维度并识别下界', () => {
    expect(dimensionOf({ game: { dimension: 'minecraft:the_nether' } })).toBe('the_nether');
    expect(dimensionOf(null)).toBeNull();
    expect(isNetherDimension('minecraft:the_nether')).toBe(true);
    expect(isNetherDimension('overworld')).toBe(false);
    expect(dimensionChanged('overworld', 'the_nether')).toBe(true);
    expect(dimensionChanged('overworld', 'overworld')).toBe(false);
    expect(dimensionChanged(null, 'the_nether')).toBe(false);
  });

  it('回执过滤空行并保留所有非空细节', () => {
    expect(portalReceipt('标题', ['一行', '', '二行'])).toBe('标题\n一行\n二行');
    expect(formatPoint({ x: 1.9, y: 2.2, z: -3.1 })).toBe('(1,2,-4)');
  });
});

describe('enterNether 早退路径（不碰真实世界）', () => {
  it('已经在下界：直接成功，不需要材料或动作', async () => {
    const result = await enterNether({ game: { dimension: 'minecraft:the_nether' } });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('已经在下界');
  });

  it('材料不足：在第一次动手前返回，明确说现场未改动', async () => {
    const bot = {
      game: { dimension: 'overworld' },
      inventory: { slots: [] },
      entity: { position: { x: 0, y: 64, z: 0 } },
    };
    const result = await enterNether(bot);
    expect(result.ok).toBe(false);
    expect(result.step).toBe('检查材料');
    expect(result.message).toContain('材料不足');
    expect(result.message).toContain('现场未改动');
    expect(result.message).toContain('黑曜石 0/10');
    expect(result.message).toContain('打火石 0/1');
  });
});
describe('工具注册与提示词契约', () => {
  it('enterNether 出现在握手声明里，是带超时的动作工具', () => {
    const declaration = toolDeclarations().find((d) => d.name === 'enterNether');
    expect(declaration).toBeDefined();
    expect(declaration?.kind).toBe('action');
    expect(declaration?.longRunning).toBe(true);
    expect(declaration?.params).toEqual({});
    expect(declaration?.description).toBe(td('enterNether'));
  });

  it('命令实现可查找，描述写进 TOOL_TEXT', () => {
    const command = findCommand('enterNether');
    expect(command).toBeDefined();
    expect(command?.description).toBe(TOOL_TEXT.enterNether.description);
    expect(command?.perform.longRunning).toBe(true);
    expect(TOOL_TEXT.enterNether.description).toContain('10 块黑曜石');
    expect(TOOL_TEXT.enterNether.description).toContain('打火石');
    expect(TOOL_TEXT.enterNether.description).toContain('不会挖掉');
    expect(TOOL_TEXT.enterNether.description).toContain('allowDangerousOps');
  });
});
