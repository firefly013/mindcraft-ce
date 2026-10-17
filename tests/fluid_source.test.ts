/**
 * task-13：流体源头搜索与水桶装填。
 * 核心：只认源方块（level 0），流动水/岩浆不能当源；没有源时明确说"只有流动水"。
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import {
  fillBucketFromSourceSkill,
  findFluidSource,
  findStandNearFluid,
  fluidKindOf,
  fluidSourceReport,
  isFluidSourceBlock,
  readFluidLevel,
  scanFluidSources,
} from '../src/body/library/survival.js';
import { parseFluidArgs } from '../src/body/commands/survival.js';

function fluidBot(blocks: Record<string, any>, pos = { x: 0.5, y: 64, z: 0.5 }) {
  return {
    entity: { position: new Vec3(pos.x, pos.y, pos.z) },
    blockAt: (p: any) => blocks[`${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`] ?? { name: 'air' },
  };
}

describe('流体种类与层级读取', () => {
  it('fluidKindOf 认 water/lava 和 flowing_*', () => {
    expect(fluidKindOf('water')).toBe('water');
    expect(fluidKindOf('flowing_water')).toBe('water');
    expect(fluidKindOf('lava')).toBe('lava');
    expect(fluidKindOf('flowing_lava')).toBe('lava');
    expect(fluidKindOf('stone')).toBeNull();
    expect(fluidKindOf(null)).toBeNull();
  });

  it('readFluidLevel 依次从 getProperties / _properties / properties / metadata 读', () => {
    expect(readFluidLevel({ getProperties: () => ({ level: 0 }) })).toBe(0);
    expect(readFluidLevel({ _properties: { level: 3 } })).toBe(3);
    expect(readFluidLevel({ properties: { level: 7 } })).toBe(7);
    expect(readFluidLevel({ metadata: 0 })).toBe(0);
    expect(readFluidLevel({})).toBeNull();
    expect(readFluidLevel(null)).toBeNull();
  });
});

describe('★只认 level 0 的源方块', () => {
  it('level 0 是源；level>0 是流动，不算源', () => {
    expect(isFluidSourceBlock({ name: 'water', _properties: { level: 0 } }, 'water')).toBe(true);
    expect(isFluidSourceBlock({ name: 'water', _properties: { level: 3 } }, 'water')).toBe(false);
    expect(isFluidSourceBlock({ name: 'water', metadata: 0 }, 'water')).toBe(true);
    expect(isFluidSourceBlock({ name: 'water', metadata: 7 }, 'water')).toBe(false);
  });

  it('flowing_* 名字一定是流动；种类要对得上；石头不是流体', () => {
    expect(isFluidSourceBlock({ name: 'flowing_water' }, 'water')).toBe(false);
    expect(isFluidSourceBlock({ name: 'flowing_lava' }, 'any')).toBe(false);
    expect(isFluidSourceBlock({ name: 'lava', _properties: { level: 0 } }, 'water')).toBe(false);
    expect(isFluidSourceBlock({ name: 'stone', metadata: 0 }, 'any')).toBe(false);
  });

  it('层级读不到且名字不是 flowing_* 时按源处理（老版本兼容）', () => {
    expect(isFluidSourceBlock({ name: 'water' }, 'water')).toBe(true);
  });
});

describe('scanFluidSources / findFluidSource', () => {
  it('找到最近的源，同时记下更近的流动水', () => {
    const bot = fluidBot({
      '1,64,0': { name: 'water', _properties: { level: 7 } }, // 流动，更近
      '3,64,0': { name: 'water', _properties: { level: 0 } }, // 源
    });
    const scan = scanFluidSources(bot, 'water', 8);
    expect(scan.source?.x).toBe(3);
    expect(scan.flowing?.x).toBe(1);
    expect(findFluidSource(bot, 'water', 8)?.x).toBe(3);
  });

  it('★只有流动水：source=null 但 flowing 有值', () => {
    const bot = fluidBot({ '2,64,0': { name: 'water', _properties: { level: 4 } } });
    const scan = scanFluidSources(bot, 'water', 8);
    expect(scan.source).toBeNull();
    expect(scan.flowing?.x).toBe(2);
    expect(findFluidSource(bot, 'water', 8)).toBeNull();
  });

  it('什么都没找到时两者皆 null', () => {
    const scan = scanFluidSources(fluidBot({}), 'water', 4);
    expect(scan.source).toBeNull();
    expect(scan.flowing).toBeNull();
  });

  it('kind 过滤：只找 lava 时无视水', () => {
    const bot = fluidBot({
      '1,64,0': { name: 'water', _properties: { level: 0 } },
      '2,64,0': { name: 'lava', _properties: { level: 0 } },
    });
    expect(findFluidSource(bot, 'lava', 6)?.x).toBe(2);
    expect(findFluidSource(bot, 'water', 6)?.x).toBe(1);
  });
});

describe('fluidSourceReport', () => {
  it('只有流动水时明确回报"没有源头，只有流动水"并给出坐标', () => {
    const bot = fluidBot({ '2,64,0': { name: 'water', _properties: { level: 4 } } });
    const text = fluidSourceReport(bot, 'water', 8);
    expect(text).toContain('只有流动水');
    expect(text).toContain('(2,64,0)');
    expect(text).toContain('装不进桶');
  });

  it('有源时报坐标/距离/能装桶', () => {
    const bot = fluidBot({ '3,64,0': { name: 'water', _properties: { level: 0 } } });
    const text = fluidSourceReport(bot, 'water', 8);
    expect(text).toContain('水源源头');
    expect(text).toContain('(3,64,0)');
    expect(text).toContain('能装桶');
  });
});

describe('findStandNearFluid', () => {
  it('找到源旁边能站的格子', () => {
    const bot = fluidBot({
      '3,64,0': { name: 'water', _properties: { level: 0 } },
      '2,64,0': { name: 'air' },
      '2,65,0': { name: 'air' },
      '2,63,0': { name: 'stone' },
    });
    expect(findStandNearFluid(bot, 3, 64, 0)).toEqual({ x: 2, y: 64, z: 0 });
  });
});

describe('fillBucketFromSourceSkill', () => {
  function bucketBot(counts: Record<string, number>, blocks: Record<string, any>) {
    const bot: any = {
      entity: { position: new Vec3(0.5, 64, 0.5) },
      blockAt: (p: any) => blocks[`${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`] ?? { name: 'air' },
      get inventory() {
        return { slots: Object.entries(counts).map(([name, count]) => ({ name, count })) };
      },
    };
    return bot;
  }

  it('没有空桶时明确说，不乱装', async () => {
    const bot = bucketBot({ water_bucket: 1 }, {});
    const text = await fillBucketFromSourceSkill(bot, 'water', 8, { useOnBlock: () => Promise.resolve(true), sleep: () => Promise.resolve() });
    expect(text).toContain('没有空桶');
  });

  it('★只有流动水时不装，明确回报"只有流动水"', async () => {
    const bot = bucketBot({ bucket: 1 }, { '2,64,0': { name: 'water', _properties: { level: 4 } } });
    const text = await fillBucketFromSourceSkill(bot, 'water', 8, { useOnBlock: () => Promise.resolve(true), sleep: () => Promise.resolve() });
    expect(text).toContain('只有流动水');
    expect(text).toContain('(2,64,0)');
  });

  it('有源时装桶，核对手上真的出现 water_bucket', async () => {
    const counts: Record<string, number> = { bucket: 1 };
    const bot = bucketBot(counts, { '2,64,0': { name: 'water', _properties: { level: 0 } } });
    const text = await fillBucketFromSourceSkill(bot, 'water', 8, {
      goTo: () => Promise.resolve(true),
      useOnBlock: () => {
        counts.bucket = 0;
        counts.water_bucket = (counts.water_bucket ?? 0) + 1;
        return Promise.resolve(true);
      },
      sleep: () => Promise.resolve(),
    });
    expect(text).toContain('已装满');
    expect(text).toContain('water_bucket 0 → 1');
    expect(text).toContain('(2,64,0)');
  });

  it('装填动作失败时说明原因，不假报成功', async () => {
    const bot = bucketBot({ bucket: 1 }, { '2,64,0': { name: 'water', _properties: { level: 0 } } });
    const text = await fillBucketFromSourceSkill(bot, 'water', 8, {
      goTo: () => Promise.resolve(true),
      useOnBlock: () => Promise.resolve(false),
      sleep: () => Promise.resolve(),
    });
    expect(text).toContain('失败');
    expect(text).not.toContain('已装满');
  });
});

describe('parseFluidArgs', () => {
  it('默认 water / 32；接受 lava / any 和数字半径', () => {
    expect(parseFluidArgs(undefined, undefined)).toEqual({ kind: 'water', radius: 32 });
    expect(parseFluidArgs('lava', '64')).toEqual({ kind: 'lava', radius: 64 });
    expect(parseFluidArgs('any', 10)).toEqual({ kind: 'any', radius: 10 });
  });

  it('非法 type 报错；半径夹到 1~128', () => {
    expect(parseFluidArgs('stone', 10).error).toContain('water / lava / any');
    expect(parseFluidArgs('water', 999).radius).toBe(128);
    expect(parseFluidArgs('water', -5).radius).toBe(1);
  });
});
