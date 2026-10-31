/**
 * "僵尸状态"：活着但无法自愈（真机 2026-10-19：0.375 血 / 食物 0 / 空背包 / 站了十多分钟）。
 *
 * 引擎只做一件事：把这个状态说清楚，并指出唯一还有进展的方向（去找吃的）。
 * **它不提供任何"主动结束"的出口**——这一条测试钉住"回执里不许出现送死建议"。
 */
import { describe, expect, it } from 'vitest';
import {
  isEdibleName,
  shouldEmitUnrecoverable,
  unrecoverableVerdict,
} from '../src/body/safety/unrecoverable.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const facts = (over: Partial<Parameters<typeof unrecoverableVerdict>[0]> = {}) => ({
  health: 0.375,
  food: 0,
  itemNames: ['dirt', 'cobblestone', 'iron_pickaxe'],
  elapsedSec: 660,
  ...over,
});

describe('判定：什么时候算"无法自愈"', () => {
  it('0.375 血 / 食物 0 / 背包无食物 ⇒ 触发，内容只讲事实 + 去找吃的', () => {
    const verdict = unrecoverableVerdict(facts());
    expect(verdict.unrecoverable).toBe(true);
    expect(verdict.advice).toContain('无法自愈');
    expect(verdict.advice).toContain('0.38 血');
    expect(verdict.advice).toContain('getFood');
    expect(verdict.advice).toContain('已持续 11 分钟');
    expect(verdict.advice).toContain('不是拒绝');
  });

  it('**任何情况下都不许出现"主动死/送死/结束"这类建议**', () => {
    for (const over of [{}, { health: 1, food: 0 }, { elapsedSec: 0 }]) {
      const advice = String(unrecoverableVerdict(facts(over)).advice ?? '');
      expect(advice).not.toContain('主动死');
      expect(advice).not.toContain('故意死');
      expect(advice).not.toContain('主动结束');
      expect(advice).not.toContain('重生');
    }
  });

  it('血 3 但食物 8 ⇒ **不触发**（它能自己回血）', () => {    expect(unrecoverableVerdict(facts({ health: 3, food: 8 })).unrecoverable).toBe(false);
  });

  it('食物 0 但背包里有 cooked_beef ⇒ **不触发**（它能吃）', () => {
    const verdict = unrecoverableVerdict(facts({ itemNames: ['cooked_beef', 'dirt'] }));
    expect(verdict.unrecoverable).toBe(false);
  });

  it('血量/食物/背包任意一项读不到 ⇒ 不触发（宁可不说，也不基于猜测给"去死"的建议）', () => {
    expect(unrecoverableVerdict(facts({ health: null })).unrecoverable).toBe(false);
    expect(unrecoverableVerdict(facts({ food: null })).unrecoverable).toBe(false);
    expect(unrecoverableVerdict(facts({ itemNames: null })).unrecoverable).toBe(false);
  });

  it('食物判定只认真能吃的（工具/原料不算，raw_ 老名字兼容）', () => {
    expect(isEdibleName('cooked_beef')).toBe(true);
    expect(isEdibleName('bread')).toBe(true);
    expect(isEdibleName('raw_beef')).toBe(true);
    expect(isEdibleName('beef')).toBe(true);
    expect(isEdibleName('iron_pickaxe')).toBe(false);
    expect(isEdibleName('dirt')).toBe(false);
  });
});

describe('播报节奏：进入状态立刻说，之后最多每 45 秒一次', () => {
  it('第一次说；45 秒内不说；之后再说', () => {
    expect(shouldEmitUnrecoverable(null, 1_000)).toBe(true);
    expect(shouldEmitUnrecoverable({ at: 1_000 }, 2_000)).toBe(false);
    expect(shouldEmitUnrecoverable({ at: 1_000 }, 45_999)).toBe(false);
    expect(shouldEmitUnrecoverable({ at: 1_000 }, 46_000)).toBe(true);
  });

  it('接线：sample 路径会检测、日志字段齐全、且**不拦任何工具**（源码守卫）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain('this.checkUnrecoverableState();');
    expect(src).toContain("event: 'unrecoverable-state'");
    expect(src).toContain('unrecoverableVerdict({');
    expect(src).toContain('elapsedSec,');
    // 建议写进 output，而不是变成拒绝：动作入口里没有针对它的 return/false
    const adviceBlock = src.slice(src.indexOf('checkUnrecoverableState(): void'), src.indexOf('private async writeAdvice'));
    expect(adviceBlock).not.toContain('stopAll');
    expect(adviceBlock).not.toContain('abortReflexes');
    expect(adviceBlock).not.toContain('return false');
  });
});
