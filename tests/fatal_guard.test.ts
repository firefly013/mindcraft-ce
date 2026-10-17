/**
 * task-20：fatal 兜底要带 stack/完整对象；unhandledRejection 默认记录不杀 body。
 */
import { describe, expect, it, vi } from 'vitest';
import { ActionManager } from '../src/body/action_manager.js';
import { describeFatalReason, installSafeStopDigging, isDiggingAborted, shouldKillOnFatal } from '../src/body/mineflayer_body.js';

describe('describeFatalReason', () => {
  it('Error 落盘 message + stack + 序列化后的 stack', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at actionStay (mineflayer_body.ts:1:1)';
    const info = describeFatalReason(err);
    expect(info.message).toBe('boom');
    expect(info.stack).toContain('actionStay');
    expect(info.serialized).toContain('actionStay');
  });

  it('普通对象尽量完整序列化', () => {
    const info = describeFatalReason({ code: 'X', detail: { a: 1 } });
    expect(info.message).toContain('object');
    expect(info.serialized).toContain('"code":"X"');
    expect(info.serialized).toContain('"a":1');
  });

  it('循环引用标记 [circular]，不抛', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(describeFatalReason(circular).serialized).toContain('[circular]');
  });

  it('unhandledRejection 记录继续，uncaughtException 才杀', () => {
    expect(shouldKillOnFatal('unhandledRejection')).toBe(false);
    expect(shouldKillOnFatal('uncaughtException')).toBe(true);
  });
});

describe('ActionManager 超时兜底', () => {
  it('agent 没有 history 时 _startTimeout 不会抛 .add 的 TypeError', async () => {
    vi.useFakeTimers();
    try {
      const agent = {
        bot: { interrupt_code: false },
        requestInterrupt: vi.fn(),
        cleanKill: vi.fn(),
      };
      const manager = new ActionManager(agent);
      manager.executing = false;
      manager._startTimeout(0.0001);
      await vi.advanceTimersByTimeAsync(20);
      expect(agent.cleanKill).not.toHaveBeenCalled();
      expect(manager.timedout).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Digging aborted 非致命', () => {
  it('isDiggingAborted 识别 abort 文案', () => {
    expect(isDiggingAborted(new Error('Digging aborted'))).toBe(true);
    expect(isDiggingAborted('boom')).toBe(false);
  });

  it('installSafeStopDigging：同步 throw / Promise reject 都不逃逸', async () => {
    const bot: any = {
      stopDigging: () => {
        throw new Error('Digging aborted');
      },
    };
    installSafeStopDigging(bot);
    expect(() => bot.stopDigging()).not.toThrow();

    const rejecting: any = { stopDigging: () => Promise.reject(new Error('Digging aborted')) };
    installSafeStopDigging(rejecting);
    expect(() => rejecting.stopDigging()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

