/**
 * 长动作必须"边做边说"（Lead 2026-10-21）：三条独立报告——collectBlocks 静默 73 秒、
 * mineBlock 117 秒无进度、smelt 45 秒超时后当"丢 1 个"。
 * 规则：静默 >10 秒 = 缺陷；到上限要说清完成 X/N、还剩 K；超时不准吞材料。
 */
import { describe, expect, it } from 'vitest';
import {
  formatProgressLine,
  formatTimeoutSummary,
  LONG_ACTION_MAX_MS,
  PROGRESS_INTERVAL_MS,
  shouldEmitProgress,
} from '../src/body/library/progress.js';

describe('shouldEmitProgress：静默不能超过 10 秒', () => {
  it('间隔阈值 ≤10 秒；第一次（lastEmitAt=0）立刻发', () => {
    expect(PROGRESS_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    expect(shouldEmitProgress(0, 1_000)).toBe(true);
  });
  it('未到间隔不发、到了就发', () => {
    expect(shouldEmitProgress(1_000, 1_000 + PROGRESS_INTERVAL_MS - 1)).toBe(false);
    expect(shouldEmitProgress(1_000, 1_000 + PROGRESS_INTERVAL_MS)).toBe(true);
  });
});

describe('formatProgressLine：有界内容（第几块/已用/还剩/距离）', () => {
  it('四项都有时全部写清（真机 collectBlocks 需要的正是这四个数）', () => {
    const line = formatProgressLine({ label: '挖矿', done: 2, total: 4, elapsedMs: 12_000, remaining: 2, distance: 1.7 });
    expect(line).toContain('挖矿已经完成 2 个，一共 4 个，已经用了 12 秒，还剩 2 个目标，');
    expect(line).toContain('挖矿已经完成 2 个，一共 4 个，已经用了 12 秒，还剩 2 个目标，');
    expect(line).toContain('还剩 2 个目标');
    expect(line).toContain('挖矿已经完成 2 个，一共 4 个，已经用了 12 秒，还剩 2 个目标，');
  });
  it('距离读不到时省略而不是编造', () => {
    const line = formatProgressLine({ label: '挖矿', done: 0, total: 1, elapsedMs: 1_000, remaining: 1, distance: null });
    expect(line).not.toContain('离目标');
  });
});

describe('formatTimeoutSummary：到上限说清剩余，不说"卡住"', () => {
  it('包含完成数/总数/剩余', () => {
    const text = formatTimeoutSummary({ label: '采集', done: 2, total: 4, elapsedMs: 150_000, remaining: 2 });
    expect(text).toContain('采集这次到了 150 秒的时间上限，已经完成 2 个，一共 4 个，还剩');
    expect(text).toContain('还剩 2 个');
    expect(text).not.toContain('卡住'); // 旧文案「stuck for N seconds」不许再出现
    expect(text).not.toContain('不是失败');
  });
});

describe('接线守卫', () => {
  it('LONG_ACTION_MAX_MS 有硬上限（不允许无限静默）', () => {
    expect(LONG_ACTION_MAX_MS).toBeLessThanOrEqual(300_000);
  });
});
