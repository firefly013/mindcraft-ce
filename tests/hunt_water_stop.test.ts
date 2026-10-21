/**
 * huntFor 岸上追水里：早停（Lead 2026-10-21 真机 A：60 秒零移动零命中）。
 * 判据是纯函数；循环里只做测量与打断，不禁止下水/岸上目标。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAquaticTarget, isLandAnimal, planWaterHuntStop } from '../src/body/library/hunt_reach.js';

const base = {
  elapsedMs: 21_000,
  distance: 15,
  attempts: 1,
  landAnimals: 0,
  botInWater: false,
  targetInWater: true,
  targetName: 'salmon',
};

describe('纯判据', () => {
  it('岸上 + 鱼在水里 + 20 秒空转 + 附近无陆生动物 ⇒ 早停，含距离/时间/两个选项', () => {
    const verdict = planWaterHuntStop(base);
    expect(verdict.stop).toBe(true);
    expect(verdict.text).toContain('salmon 在水里 15 格');
    expect(verdict.text).toContain('我在岸上');
    expect(verdict.text).toContain('附近 48 格内陆生动物：无');
    expect(verdict.text).toContain('放弃水生猎物');
    expect(verdict.text).toContain('换个方向找岸上的动物');
  });
  it('不到 20 秒 ⇒ 不早停（给动作留出正常时间）', () => {
    expect(planWaterHuntStop({ ...base, elapsedMs: 5_000 }).stop).toBe(false);
  });
  it('人已经在水里 ⇒ 不早停（照常追）', () => {
    expect(planWaterHuntStop({ ...base, botInWater: true }).stop).toBe(false);
  });
  it('附近有陆生动物 ⇒ 不早停（那条路更有希望）', () => {
    expect(planWaterHuntStop({ ...base, landAnimals: 2 }).stop).toBe(false);
  });
  it('目标不在水里 ⇒ 不早停', () => {
    expect(planWaterHuntStop({ ...base, targetInWater: false }).stop).toBe(false);
  });
  it('重复空转 ⇒ 回执说"第 N 次空转"，第一次不说', () => {
    expect(planWaterHuntStop({ ...base, attempts: 1 }).text).not.toContain('第 1 次空转');
    expect(planWaterHuntStop({ ...base, attempts: 3 }).text).toContain('第 3 次空转');
  });
  it('类别识别：salmon 是水生、cow 是陆生', () => {
    expect(isAquaticTarget('salmon')).toBe(true);
    expect(isAquaticTarget('minecraft:cod')).toBe(true);
    expect(isLandAnimal('cow')).toBe(true);
    expect(isLandAnimal('salmon')).toBe(false);
  });
});

describe('huntForSkill 实跑：20 秒级早停（假时钟）', () => {
  it('岸上/鱼在水里/无陆生动物 ⇒ 停止码 water_unreachable，回执含距离与两个选项', async () => {
    const { huntForSkill } = await import('../src/body/library/progression.js');
    let clock = 0;
    const bot: any = {
      entity: { position: { x: 0, y: 64, z: 0 } },
      entities: {},
      inventory: { items: () => [] },
      blockAt: (p: any) => ({ name: p?.x >= 10 ? 'water' : 'grass_block' }),
      interrupt_code: false,
    };
    const result = await huntForSkill(bot, 'salmon', 4, 48, 600_000, {
      now: () => {
        clock += 30_000;
        return clock;
      },
      health: () => 20,
      findEntity: () => ({ id: 1, name: 'salmon', position: { x: 15, y: 63, z: 0 } }),
      findDrop: () => null,
      attack: async () => false,
      entityPresent: () => true,
    });
    expect(result).toContain('下水追不到');
    expect(result).toContain('水里 15 格');
    expect(result).toContain('放弃水生猎物');
  });
});

describe('接线守卫', () => {
  it('progression 的 huntFor 循环里调用 planWaterHuntStop，且有 water_unreachable 停止码', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'library', 'progression.ts'), 'utf8');
    expect(code).toContain('planWaterHuntStop({');
    expect(code).toContain("stopReason = 'water_unreachable';");
    expect(code).toContain("water_unreachable: '目标在水里、我在岸上，追不到——早停（不烧完整段预算）'");
    expect(code).toContain('waterStallSince');
  });
});
