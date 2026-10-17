/**
 * 可中断寻路：pathfinder.goto 不认 interrupt_code，必须由我们轮询并主动 stop。
 * 这是 Feedback #22 那条 goToCoordinates 被 10 秒 cleanKill 的根因回归。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PATHFIND_INTERRUPT_POLL_MS,
  runPathfindingInterruptibly,
} from '../src/body/library/skills.js';

describe('runPathfindingInterruptibly', () => {
  it('已经置位 interrupt_code：不进 goto，直接 stop 并返回 false', async () => {
    const goto = vi.fn();
    const stop = vi.fn();
    const bot = { interrupt_code: true, pathfinder: { goto, stop } };
    await expect(runPathfindingInterruptibly(bot, {})).resolves.toBe(false);
    expect(goto).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('goto 卡住时，轮询到 interrupt_code 立刻 stop 并返回 false', async () => {
    vi.useFakeTimers();
    try {
      const goto = vi.fn(() => new Promise<never>(() => {}));
      const stop = vi.fn();
      const bot = { interrupt_code: false, pathfinder: { goto, stop } };
      const pending = runPathfindingInterruptibly(bot, {});
      await vi.advanceTimersByTimeAsync(PATHFIND_INTERRUPT_POLL_MS + 10);
      expect(bot.interrupt_code).toBe(false);
      bot.interrupt_code = true;
      await vi.advanceTimersByTimeAsync(PATHFIND_INTERRUPT_POLL_MS + 10);
      await expect(pending).resolves.toBe(false);
      expect(stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('正常到达：透传 true', async () => {
    const bot = {
      interrupt_code: false,
      pathfinder: { goto: () => Promise.resolve(), stop: vi.fn() },
    };
    await expect(runPathfindingInterruptibly(bot, {})).resolves.toBe(true);
  });

  it('goto 抛错：透传异常，不假装成功', async () => {
    const bot = {
      interrupt_code: false,
      pathfinder: { goto: () => Promise.reject(new Error('path blocked')), stop: vi.fn() },
    };
    await expect(runPathfindingInterruptibly(bot, {})).rejects.toThrow('path blocked');
  });
});
