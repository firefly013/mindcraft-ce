import { describe, expect, it } from 'vitest';
import {
  assessObsidianKit,
  chooseSafeLavaTargets,
  chooseSafeWaterSources,
  evaluateLavaTarget,
  evaluateWaterSource,
  failureReceipt,
  findMineStand,
  findScaffoldStand,
  findWaterStandWithinReach,
  formatPoint,
  nearestLavaInfo,
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
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
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
    expect(result.stand).toEqual({ x: 1, y: 61, z: 0 });
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
    expect(chosen[0]?.stand).toEqual({ x: 11, y: 61, z: 0 });
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
