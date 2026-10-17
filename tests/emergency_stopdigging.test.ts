/**
 * task-35：stopDigging reject 不再 fatal；受控安全作业不被 emergency 选中。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MineflayerBody,
  forceStopBody,
  isControlledSafeLavaOperation,
} from '../src/body/mineflayer_body.js';

function fakeLogger(): any {
  return { with: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
}

function safeBot(): any {
  return {
    controlledLavaOperation: true,
    health: 20,
    interrupt_code: false,
    entity: {
      position: {
        x: 0.5,
        y: 0.5,
        z: 0.5,
        offset(dx: number, dy: number, dz: number) {
          return { x: 0.5 + dx, y: 0.5 + dy, z: 0.5 + dz };
        },
      },
    },
    blockAt: (p: { x: number; y: number; z: number }) => {
      if (p.y === -0.5) return { name: 'stone' };
      return { name: 'air' };
    },
  };
}

describe('isControlledSafeLavaOperation', () => {
  it('受控 + 脚下实心 + 不在岩浆/水：安全', () => {
    expect(isControlledSafeLavaOperation(safeBot())).toBe(true);
  });

  it('脚下没有支撑 / 受伤 / 没有 flag：不安全', () => {
    const noSupport = safeBot();
    noSupport.blockAt = () => ({ name: 'air' });
    expect(isControlledSafeLavaOperation(noSupport)).toBe(false);

    const lowHp = safeBot();
    lowHp.health = 6;
    expect(isControlledSafeLavaOperation(lowHp)).toBe(false);

    const noFlag = safeBot();
    noFlag.controlledLavaOperation = false;
    expect(isControlledSafeLavaOperation(noFlag)).toBe(false);
  });
});

describe('中断路径对 stopDigging 的异常免疫', () => {
  it('requestInterrupt：stopDigging 同步 throw、cancelTask reject 都不会逃逸', async () => {
    const bot: any = {
      interrupt_code: false,
      stopDigging: () => {
        throw new Error('Digging aborted');
      },
      collectBlock: { cancelTask: () => Promise.reject(new Error('cancel failed')) },
      pathfinder: {
        stop: () => {
          throw new Error('pathfinder stop failed');
        },
      },
    };
    const body: any = Object.create(MineflayerBody.prototype);
    body.bot = bot;
    body.log = fakeLogger();
    expect(() => body.requestInterrupt()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(bot.interrupt_code).toBe(true);
  });

  it('forceStopBody：只置 interrupt_code + 清控制/停寻路，不直接 stopDigging', () => {
    const bot: any = {
      interrupt_code: false,
      stopDigging: vi.fn(),
      clearControlStates: vi.fn(),
      pathfinder: { stop: vi.fn() },
      collectBlock: { cancelTask: vi.fn(() => Promise.resolve()) },
    };
    forceStopBody({ bot });
    expect(bot.interrupt_code).toBe(true);
    expect(bot.clearControlStates).toHaveBeenCalled();
    expect(bot.pathfinder.stop).toHaveBeenCalled();
    // 挖矿交给 digWithTimeout 轮询 interrupt_code 自己停；这里不直接 cancel dig Promise。
    expect(bot.stopDigging).not.toHaveBeenCalled();
  });
});

describe('emergency 受控安全豁免', () => {
  it('controlled safe lava 作业：emergency 直接返回，不 forceStopBody/不 notify', () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.bot = safeBot();
    body.log = fakeLogger();
    body.notify = vi.fn();
    body.reflexQueue = [];
    body.drainReflexes = vi.fn();
    body.emergency('world.lava.nearby', {}, 'escape', 'lava');
    expect(body.notify).not.toHaveBeenCalled();
    expect(body.bot.interrupt_code).not.toBe(true);
    expect(body.reflexQueue).toEqual([]);
  });
});
