import { describe, expect, it } from 'vitest';
import {
  assessObsidianKit,
  chooseLavaScaffoldMaterial,
  chooseSafeLavaTargets,
  chooseSafeWaterSources,
  evaluateLavaTarget,
  evaluateWaterSource,
  failureReceipt,
  findLavaMineStand,
  findLavaScaffoldStand,
  findLavaStandWithinReach,
  findMineStand,
  findScaffoldStand,
  findWaterStandWithinReach,
  isStandingSafelyAt,
  formatPoint,
  nearestLavaInfo,
  planLavaStand,
  planWaterStand,
  makeObsidian,
  makeObsidianActionList,
  type Point,
} from '../src/body/commands/make_obsidian.js';
import { findCommand, toolDeclarations } from '../src/body/commands/registry.js';
import { TOOL_TEXT, td } from '../src/shared/prompts.js';

function key(p: Point): string {
  return String(Math.floor(p.x)) + ',' + String(Math.floor(p.y)) + ',' + String(Math.floor(p.z));
}

function mapProbe(entries: Record<string, string>) {
  return (x: number, y: number, z: number): string | null =>
    entries[key({ x, y, z })] ?? 'air';
}

function validLavaWorld(lava: Point, floorName = 'stone'): Record<string, string> {
  const entries: Record<string, string> = {};
  entries[key(lava)] = 'lava';
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as Array<[number, number]>) {
    entries[key({ x: lava.x + dx, y: lava.y, z: lava.z + dz })] = floorName;
    entries[key({ x: lava.x + dx, y: lava.y + 1, z: lava.z + dz })] = 'air';
    entries[key({ x: lava.x + dx, y: lava.y + 2, z: lava.z + dz })] = 'air';
  }
  return entries;
}

function validWaterWorld(water: Point): Record<string, string> {
  const entries = validLavaWorld(water);
  entries[key(water)] = 'water';
  return entries;
}

describe('makeObsidian 装备检查', () => {
  it('水桶 + 钻石镐就绪；空桶 + 下界合金镐也算就绪', () => {
    const a = assessObsidianKit({ water_bucket: 1, diamond_pickaxe: 1 });
    expect(a.ok).toBe(true);
    expect(a.waterBuckets).toBe(1);
    expect(a.diamondPickaxes).toBe(1);
    expect(a.message).toContain('启动条件满足');

    const b = assessObsidianKit({ bucket: 2, netherite_pickaxe: 1 });
    expect(b.ok).toBe(true);
    expect(b.emptyBuckets).toBe(2);
  });

  it('缺桶或缺钻石镐要分别说清楚', () => {
    const noBucket = assessObsidianKit({ diamond_pickaxe: 1 });
    expect(noBucket.ok).toBe(false);
    expect(noBucket.missing.join('、')).toContain('水桶');

    const noPick = assessObsidianKit({ water_bucket: 1 });
    expect(noPick.ok).toBe(false);
    expect(noPick.missing.join('、')).toContain('钻石镐');

    const none = assessObsidianKit({});
    expect(none.ok).toBe(false);
    expect(none.missing).toHaveLength(2);
  });
});

describe('安全岩浆/水源选址（纯函数）', () => {
  it('岩浆旁有高一格实心岸、脚头空气：通过并给出站位', () => {
    const lava: Point = { x: 0, y: 60, z: 0 };
    const result = evaluateLavaTarget(lava, mapProbe(validLavaWorld(lava)));
    expect(result.ok).toBe(true);
    expect(result.stand?.y).toBe(61);
    expect(Math.abs(result.stand?.x ?? 0)).toBe(2);
    expect(result.stand?.z).toBe(0);
  });

  it('岩浆旁没有干燥实心岸：拒绝并说明', () => {
    const lava: Point = { x: 0, y: 60, z: 0 };
    const result = evaluateLavaTarget(lava, mapProbe({ '0,60,0': 'lava' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('高一格');
  });

  it('水源同样要有安全装水位；流动水/岩浆不是水源', () => {
    const water: Point = { x: 4, y: 60, z: 4 };
    const result = evaluateWaterSource(water, mapProbe(validWaterWorld(water)));
    expect(result.ok).toBe(true);
    expect(result.stand).not.toBeNull();

    expect(evaluateWaterSource(water, mapProbe({ '4,60,4': 'flowing_water' })).ok).toBe(false);
  });

  it('候选目标按距离排序，跳过没有安全岸边的岩浆', () => {
    const nearBad: Point = { x: 0, y: 60, z: 0 };
    const farGood: Point = { x: 10, y: 60, z: 0 };
    const entries: Record<string, string> = { '0,60,0': 'lava' };
    for (const [k, v] of Object.entries(validLavaWorld(farGood))) entries[k] = v;
    const chosen = chooseSafeLavaTargets([nearBad, farGood], { x: 0, y: 60, z: 0 }, mapProbe(entries));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.liquid).toEqual(farGood);
    expect([{ x: 12, y: 61, z: 0 }, { x: 8, y: 61, z: 0 }, { x: 10, y: 61, z: -2 }, { x: 10, y: 61, z: 2 }]).toContainEqual(chosen[0]?.stand);
  });

  it('安全水源候选会过滤真的无岸边目标', () => {
    const good: Point = { x: 10, y: 60, z: 10 };
    const bad: Point = { x: 0, y: 60, z: 0 };
    const entries: Record<string, string> = {};
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -1; dy <= 2; dy++) {
        for (let dz = -5; dz <= 5; dz++) {
          entries[key({ x: bad.x + dx, y: bad.y + dy, z: bad.z + dz })] = 'bedrock';
        }
      }
    }
    entries[key(bad)] = 'water';
    for (const [k, v] of Object.entries(validLavaWorld(good))) entries[k] = v;
    entries[key(good)] = 'water';
    const chosen = chooseSafeWaterSources([bad, good], { x: 0, y: 60, z: 0 }, mapProbe(entries));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.liquid).toEqual(good);
  });
});

describe('makeObsidian 早退路径', () => {
  it('背包已有 10 块黑曜石：直接成功，不需要工具或岩浆', async () => {
    const bot = { inventory: { slots: [{ name: 'obsidian', count: 10 }] } };
    const result = await makeObsidian(bot);
    expect(result.ok).toBe(true);
    expect(result.produced).toBe(0);
    expect(result.message).toContain('已获得 10/10');
  });

  it('缺桶/缺钻石镐：在找岩浆前返回，现场不动', async () => {
    const bot = { inventory: { slots: [] } };
    const result = await makeObsidian(bot);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('装备检查');
    expect(result.message).toContain('水桶');
    expect(result.message).toContain('钻石镐');
    expect(result.message).toContain('阶段：检查装备');
    expect(result.message).toContain('下一步');
  });
});

describe('makeObsidian 命令注册契约', () => {
  it('命令是 action 且标记 longRunning，描述来自 prompts', () => {
    const command = makeObsidianActionList.find((c) => c.name === '!makeObsidian');
    expect(command).toBeDefined();
    expect(command?.perform.longRunning).toBe(true);
    expect(command?.description).toBe(td('makeObsidian'));

    const declaration = toolDeclarations().find((d) => d.name === 'makeObsidian');
    expect(declaration).toBeDefined();
    expect(declaration?.kind).toBe('action');
    expect(declaration?.longRunning).toBe(true);
    expect(declaration?.params).toEqual({});
    expect(declaration?.description).toBe(TOOL_TEXT.makeObsidian.description);
    expect(findCommand('makeObsidian')?.description).toBe(td('makeObsidian'));
  });

  it('描述里写清危险操作授权和坐标回执', () => {
    expect(TOOL_TEXT.makeObsidian.description).toContain('allowDangerousOps');
    expect(TOOL_TEXT.makeObsidian.description).toContain('岩浆');
    expect(TOOL_TEXT.makeObsidian.description).toContain('坐标');
    expect(formatPoint({ x: 1.9, y: 2.2, z: -3.1 })).toBe('(1,2,-4)');
  });
});

describe('task-14 装水位放宽与可行动回执', () => {
  it('同层干燥点也能装水：4.5 格内不再只认高一格岸边', () => {
    const water: Point = { x: 0, y: 60, z: 0 };
    const entries: Record<string, string> = { '0,60,0': 'water', '1,59,0': 'stone' };
    const stand = findWaterStandWithinReach(water, mapProbe(entries));
    expect(stand).toEqual({ x: 1, y: 60, z: 0 });
    const evaluation = evaluateWaterSource(water, mapProbe(entries));
    expect(evaluation.ok).toBe(true);
    expect(evaluation.stand).toEqual({ x: 1, y: 60, z: 0 });
  });

  it('没有现成站位时，纯函数给出圆石垫脚方案', () => {
    const water: Point = { x: 0, y: 60, z: 0 };
    const entries: Record<string, string> = { '0,60,0': 'water', '2,60,0': 'stone', '2,61,0': 'stone' };
    const plan = findScaffoldStand(water, mapProbe(entries));
    expect(plan?.floor).toEqual({ x: 1, y: 60, z: 0 });
    expect(plan?.stand).toEqual({ x: 1, y: 61, z: 0 });
    expect(planWaterStand(water, mapProbe(entries)).mode).toBe('scaffold');
  });

  it('没有站位但有一格可挖遮挡时，纯函数给出挖取方案', () => {
    const water: Point = { x: 0, y: 60, z: 0 };
    const entries: Record<string, string> = {
      '0,60,0': 'water',
      '1,59,0': 'stone',
      '1,60,0': 'short_grass',
    };
    const plan = findMineStand(water, mapProbe(entries));
    expect(plan?.stand).toEqual({ x: 1, y: 60, z: 0 });
    expect(plan?.mines).toEqual([{ x: 1, y: 60, z: 0 }]);
  });

  it('回执会报最近岩浆源坐标和距离', () => {
    const info = nearestLavaInfo([{ x: 10, y: 60, z: 0 }, { x: 0, y: 60, z: 0 }], { x: 0, y: 60, z: 0 });
    expect(info).toContain('最近岩浆源');
    expect(info).toContain('(0,60,0)');
    expect(info).toContain('距离 0 格');
  });

  it('failureReceipt 支持分阶段细节和下一步命令', () => {
    const text = failureReceipt(3, 0, [], [], '阶段：准备装水位。建议坐标：(1,60,0)。', 'goToCoordinates(1,60,0) 后重试 makeObsidian。');
    expect(text).toContain('阶段：准备装水位');
    expect(text).toContain('下一步：goToCoordinates');
  });
});

describe('task-23 岩浆操作位自动创造与硬校验', () => {
  it('岩浆安全位放宽到 4.5 格内任意高一格实心岸，不再只认相邻一格', () => {
    const lava: Point = { x: 0, y: 60, z: 0 };
    const entries: Record<string, string> = { '0,60,0': 'lava', '2,60,0': 'stone' };
    const stand = findLavaStandWithinReach(lava, mapProbe(entries));
    expect(stand).toEqual({ x: 2, y: 61, z: 0 });
    const evaluation = evaluateLavaTarget(lava, mapProbe(entries));
    expect(evaluation.ok).toBe(true);
    expect(evaluation.stand).toEqual({ x: 2, y: 61, z: 0 });
  });

  it('没有现成岩浆操作位时，纯函数给出具体圆石垫脚坐标', () => {
    const lava: Point = { x: 0, y: 60, z: 0 };
    const entries: Record<string, string> = { '0,60,0': 'lava', '3,60,0': 'stone' };
    const plan = findLavaScaffoldStand(lava, mapProbe(entries));
    expect(plan?.floor).toEqual({ x: 2, y: 60, z: 0 });
    expect(plan?.stand).toEqual({ x: 2, y: 61, z: 0 });
  });

  it('没有站位但可挖遮挡时，纯函数给出具体 mineBlock 坐标', () => {
    const lava: Point = { x: 0, y: 60, z: 0 };
    const entries: Record<string, string> = {
      '0,60,0': 'lava',
      '2,60,0': 'stone',
      '2,61,0': 'short_grass',
    };
    const plan = findLavaMineStand(lava, mapProbe(entries));
    expect(plan?.stand).toEqual({ x: 2, y: 61, z: 0 });
    expect(plan?.mines).toEqual([{ x: 2, y: 61, z: 0 }]);
  });

  it('完全无解时也要给建议坐标，不让模型猜', () => {
    const lava: Point = { x: 0, y: 60, z: 0 };
    const plan = planLavaStand(lava, mapProbe({ '0,60,0': 'lava' }));
    expect(plan.mode).toBe('none');
    expect(plan.suggestedStand).not.toBeNull();
    expect(plan.suggestedFloor).not.toBeNull();
  });
});

  it('倒水前硬校验：脚/头必须是空气、脚下必须是高一格实心岸', () => {
    const lava: Point = { x: 0, y: 60, z: 0 };
    const stand: Point = { x: 2, y: 61, z: 0 };
    const target = { liquid: lava, stand, distance: 0 };
    const entries: Record<string, string> = {
      '2,61,0': 'air',
      '2,62,0': 'air',
      '2,60,0': 'stone',
    };
    const bot: any = {
      entity: { position: { x: 2.2, y: 61, z: 0.2 } },
      blockAt: (p: any) => ({ name: entries[key({ x: p.x, y: p.y, z: p.z })] ?? 'air' }),
    };
    expect(isStandingSafelyAt(bot, target)).toBe(true);
    entries['2,60,0'] = 'air';
    expect(isStandingSafelyAt(bot, target)).toBe(false);

    const closeEntries: Record<string, string> = { '1,61,0': 'air', '1,62,0': 'air', '1,60,0': 'stone' };
    const closeBot: any = {
      entity: { position: { x: 1.2, y: 61, z: 0.2 } },
      blockAt: (p: any) => ({ name: closeEntries[key({ x: p.x, y: p.y, z: p.z })] ?? 'air' }),
    };
    const tooClose = { liquid: lava, stand: { x: 1, y: 61, z: 0 }, distance: 0 };
    expect(isStandingSafelyAt(closeBot, tooClose)).toBe(false);
  });

  it('垫块材料优先 cobblestone，也接受深板岩', () => {
    expect(chooseLavaScaffoldMaterial({ cobblestone: 1 })).toBe('cobblestone');
    expect(chooseLavaScaffoldMaterial({ cobbled_deepslate: 1 })).toBe('cobbled_deepslate');
    expect(chooseLavaScaffoldMaterial({ deepslate: 2 })).toBe('deepslate');
    expect(chooseLavaScaffoldMaterial({})).toBeNull();
  });
