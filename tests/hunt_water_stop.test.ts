/**
 * huntFor 岸上追水里：**事实提示，不再替模型停手**（用户 2026-10-24 定原则：
 * 模型想干什么只有它自己知道）。
 *
 * 历史：2026-10-21 真机 A「60 秒零移动零命中」引出 20 秒早停（water_unreachable）；
 * 2026-10-24 认定那是用「耗了很久」猜「你拿不到」，改成只报事实、照常追，
 * 停不停由模型 Stop 或它自己设的预算/次数上限决定。判据仍是纯函数。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAquaticTarget, isLandAnimal, planWaterHuntNotice } from '../src/body/library/hunt_reach.js';

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
  it('岸上 + 鱼在水里 + 20 秒空转 + 附近无陆生动物 ⇒ 产出提示，含距离/时间/选项', () => {
    const verdict = planWaterHuntNotice(base);
    expect(verdict.notice).toBe(true);
    expect(verdict.text).toContain('salmon 在水里 15 格');
    expect(verdict.text).toContain('我在岸上');
    expect(verdict.text).toContain('附近 48 格内陆生动物：无');
    expect(verdict.text).toContain('没有移动也没有攻击命中');
    // 提示给选项，**不替模型做决定**
    expect(verdict.text).toContain('怎么选由你');
  });
  it('不到 20 秒 ⇒ 不提示（给动作留出正常时间）', () => {
    expect(planWaterHuntNotice({ ...base, elapsedMs: 5_000 }).notice).toBe(false);
  });
  it('人已经在水里 ⇒ 不提示（照常追）', () => {
    expect(planWaterHuntNotice({ ...base, botInWater: true }).notice).toBe(false);
  });
  it('附近有陆生动物 ⇒ 不提示（那条路更有希望）', () => {
    expect(planWaterHuntNotice({ ...base, landAnimals: 2 }).notice).toBe(false);
  });
  it('目标不在水里 ⇒ 不提示', () => {
    expect(planWaterHuntNotice({ ...base, targetInWater: false }).notice).toBe(false);
  });
  it('重复空转 ⇒ 提示说"第 N 次空转"，第一次不说', () => {
    expect(planWaterHuntNotice({ ...base, attempts: 1 }).text).not.toContain('第 1 次空转');
    expect(planWaterHuntNotice({ ...base, attempts: 3 }).text).toContain('第 3 次空转');
  });
  it('类别识别：salmon 是水生、cow 是陆生', () => {
    expect(isAquaticTarget('salmon')).toBe(true);
    expect(isAquaticTarget('minecraft:cod')).toBe(true);
    expect(isLandAnimal('cow')).toBe(true);
    expect(isLandAnimal('salmon')).toBe(false);
  });
});

describe('huntForSkill 实跑：提示照报，但**不再停手**（假时钟）', () => {
  it('岸上/鱼在水里/无陆生动物 ⇒ 进度里带提示，循环继续跑满预算，没有 water_unreachable 停止码', async () => {
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
    // 事实仍然要说
    expect(result).toContain('水里 15 格');
    // **但不是"停手"**：没有早停停止码，是预算跑满
    expect(result).not.toContain('water_unreachable');
    expect(result).not.toContain('下水追不到');
  });
});

describe('接线守卫', () => {
  it('progression 的 huntFor 循环里调用 planWaterHuntNotice，且**没有**替模型停手的分支', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'library', 'progression.ts'), 'utf8');
    expect(code).toContain('planWaterHuntNotice({');
    // 早停的停止码整个删掉了（零调用者即死代码）
    expect(code).not.toContain("stopReason = 'water_unreachable'");
    expect(code).not.toContain("water_unreachable: '");
    expect(code).toContain('waterStallNoticed');
    // exploreFor 的水里起手也从「拒绝」降级成「警告 + 照走」
    expect(code).not.toContain('先 escapeWater 上岸**再来。');
    expect(code).toContain('想先上岸就调 escapeWater 再来');
  });
});
