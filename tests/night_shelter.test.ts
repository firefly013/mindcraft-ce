/**
 * 天黑庇护所辅助（Lead 2026-10-21）：两小时内两次满盘重置——重建→死亡→归零，
 * 所有其他改进都被抹掉。"小心一点"没用：模型看不见太阳落山跨了多少轮。
 *
 * 这是 **assist**（用户原话「LLM 不擅长啥我就帮助它」），不是 gate：
 * 天快黑/已黑 + 不在密封点亮空间 ⇒ 挖洞/封口/点把火，并写清「我在哪、你能做什么」。
 * 读不到关键输入 ⇒ **什么都不做**（坏掉的辅助不许变成墙）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatShelterReceipt,
  isNight,
  NIGHT_START,
  planShelter,
  ticksToNight,
} from '../src/body/safety/shelter.js';

const base = {
  timeOfDay: NIGHT_START + 500, // 夜里
  hasRoof: false,
  hasLight: false,
  health: 18,
  hasTorch: true,
  placeableBlocks: 10,
};

describe('planShelter：白天不动、夜里才动', () => {
  it('白天（离天黑还早）⇒ none/day：已经安全时**一句话都不说**', () => {
    const plan = planShelter({ ...base, timeOfDay: 3000 });
    expect(plan.action).toBe('none');
    expect(plan.reason).toBe('day');
    expect(plan.detail).toBe('');
  });

  it('天快黑了（≤ 60 秒）+ 没屋顶 ⇒ shelter', () => {
    const plan = planShelter({ ...base, timeOfDay: NIGHT_START - 600 });
    expect(plan.action).toBe('shelter');
    expect(plan.reason).toBe('night-soon');
  });

  it('已经黑了 + 没屋顶 ⇒ shelter（这是要救命的场景）', () => {
    expect(planShelter(base).action).toBe('shelter');
  });

  it('**读不到时间/屋顶/光** ⇒ none/unreadable（坏的辅助不许变成墙）', () => {
    expect(planShelter({ ...base, timeOfDay: null }).reason).toBe('unreadable');
    expect(planShelter({ ...base, hasRoof: null }).reason).toBe('unreadable');
    expect(planShelter({ ...base, hasLight: null }).reason).toBe('unreadable');
  });
});

describe('planShelter：最小动作，绝不砌死自己', () => {
  it('已经有屋顶和光 ⇒ none/already-safe（不打扰）', () => {
    const plan = planShelter({ ...base, hasRoof: true, hasLight: true });
    expect(plan.action).toBe('none');
    expect(plan.reason).toBe('already-safe');
  });

  it('有屋顶但没光 + 有火把 ⇒ light-only（不挖洞、不移动，最省）', () => {
    const plan = planShelter({ ...base, hasRoof: true, hasLight: false });
    expect(plan.action).toBe('light-only');
  });

  it('没屋顶且**只剩 1 块**方块 ⇒ 不许砌死：最多点灯，不封口', () => {
    const plan = planShelter({ ...base, placeableBlocks: 1 });
    expect(plan.action).toBe('light-only'); // 有火把 ⇒ 只点灯
    const noTorch = planShelter({ ...base, placeableBlocks: 1, hasTorch: false });
    expect(noTorch.action).toBe('none');
    expect(noTorch.reason).toBe('too-dark-no-material');
  });
});

describe('formatShelterReceipt：说清"我在哪、能做什么、什么时候出去"', () => {
  it('回执含坐标 / 血 / 封口与光照状态 / 天亮倒计时 / 可执行下一步', () => {
    const text = formatShelterReceipt({
      position: { x: 12.7, y: 64.2, z: -3.9 },
      action: 'shelter',
      health: 17,
      ticksToDawn: 2400,
      sealed: true,
      lit: true,
    });
    expect(text).toContain('(12, 64, -4)');
    expect(text).toContain('挖了个洞先躲着');
    expect(text).toContain('入口已封住');
    expect(text).toContain('洞里有光');
    expect(text).toContain('约 120 秒天亮');
    expect(text).toContain('合成');
    expect(text).toContain('Stop');
  });

  it('没封住/没光时如实说（不许假装安全）', () => {
    const text = formatShelterReceipt({
      position: { x: 0, y: 64, z: 0 },
      action: 'light-only',
      health: null,
      ticksToDawn: 600,
      sealed: false,
      lit: false,
    });
    expect(text).toContain('入口没封住');
    expect(text).toContain('洞里没光');
    expect(text).toContain('血 ?');
  });
});

describe('接线：身体每 tick 检查，但有界、可让位、可观测', () => {
  const src = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('update() 里调用，且反射/中断/生死状时让位', () => {
    const code = src();
    expect(code).toContain('this.perhapsNightShelter();');
    expect(code).toContain('if (this.reflexRunning === true) return;');
    expect(code).toContain('if (this.reflexAbortRequested === true) return;');
    expect(code).toContain('if (safeguards.isSuppressed(Date.now())) return;');
  });

  it('每晚上限 2 次、最短间隔 8 秒（不刷屏、不反复挖洞）', () => {
    const code = src();
    expect(code).toContain('this.shelterCountTonight >= 2');
    expect(code).toContain('now - this.shelterLastAt < 8_000');
  });

  it('行动有界：挖头/挖脚各自走 digWithTimeout，封口前要求 ≥2 块', () => {
    const code = src();
    expect(code).toContain('digWithTimeout(bot, head');
    expect(code).toContain('this.shelterPlaceableCount() >= 2');
    expect(code).toContain('formatShelterReceipt(');
  });
});

describe('时间工具', () => {
  it('isNight / ticksToNight 与 1.21 的世界时间一致', () => {
    expect(isNight(13000)).toBe(true);
    expect(isNight(23000)).toBe(true);
    expect(isNight(600)).toBe(true);
    expect(isNight(6000)).toBe(false);
    expect(ticksToNight(12000)).toBe(1000);
    expect(ticksToNight(14000)).toBe(0);
  });
});
