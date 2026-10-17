/**
 * task-15：敌人威胁要主动硬中断长动作，长寻路/长搜索要能感知 interrupt_code。
 */
import { describe, expect, it, vi } from 'vitest';
import { forceStopBody, shouldThreatEmergency } from '../src/body/mineflayer_body.js';
import { goToNearestBlock, runPathfindingInterruptibly, stay } from '../src/body/library/skills.js';
import { getNearestBlocksWhere } from '../src/body/library/world.js';

describe('shouldThreatEmergency', () => {
  const base = { threat: { name: 'skeleton', distance: 4 }, health: 14, damage: 2, msSinceLastEmergency: 100_000 };

  it('贴脸 + 刚受伤：触发保命', () => {
    expect(shouldThreatEmergency(base)).toBe(true);
  });

  it('贴脸 + 低血（没有新伤害）：也触发', () => {
    expect(shouldThreatEmergency({ ...base, damage: 0, health: 8 })).toBe(true);
  });

  it('连续小伤害不再受 hurt debounce 影响：只要冷却过了就触发', () => {
    expect(shouldThreatEmergency({ ...base, damage: 0.5, msSinceLastEmergency: 11_000 })).toBe(true);
  });

  it('冷却内不重复触发', () => {
    expect(shouldThreatEmergency({ ...base, msSinceLastEmergency: 9_000 })).toBe(false);
  });

  it('威胁太远 / 没有威胁 / 血还高且无伤害：不触发', () => {
    expect(shouldThreatEmergency({ ...base, threat: { name: 'skeleton', distance: 30 } })).toBe(false);
    expect(shouldThreatEmergency({ ...base, threat: null })).toBe(false);
    expect(shouldThreatEmergency({ ...base, damage: 0, health: 18 })).toBe(false);
  });
});

describe('forceStopBody', () => {
  it('主动取消寻路/清控制状态/停挖，并置 interrupt_code', () => {
    const bot = {
      interrupt_code: false,
      clearControlStates: vi.fn(),
      pathfinder: { stop: vi.fn() },
      stopDigging: vi.fn(),
    };
    const agent = { bot, requestInterrupt: vi.fn() };
    forceStopBody(agent);
    expect(agent.requestInterrupt).toHaveBeenCalledTimes(1);
    expect(bot.clearControlStates).toHaveBeenCalledTimes(1);
    expect(bot.pathfinder.stop).toHaveBeenCalledTimes(1);
    expect(bot.stopDigging).toHaveBeenCalledTimes(1);
    expect(bot.interrupt_code).toBe(true);
  });
});

describe('威胁中断长寻路', () => {
  it('forceStopBody 之后 runPathfindingInterruptibly 立即返回 false', async () => {
    const bot = {
      interrupt_code: false,
      pathfinder: { goto: vi.fn(() => new Promise<never>(() => {})), stop: vi.fn() },
    };
    const agent = { bot, requestInterrupt: () => { bot.interrupt_code = true; } };
    forceStopBody(agent);
    await expect(runPathfindingInterruptibly(bot, {})).resolves.toBe(false);
    expect(bot.pathfinder.stop).toHaveBeenCalled();
  });

  it('同步 findBlocks 匹配到一半时 interrupt_code 置位：立刻抛停，不继续扫 512 格', () => {
    const blockAt = vi.fn();
    const bot = {
      interrupt_code: true,
      findBlocks: (opts: { matching: (block: { name: string }) => boolean }) => {
        // 模拟 mineflayer 每匹配一个方块就调一次 matcher。
        opts.matching({ name: 'oak_log' });
        return [];
      },
      blockAt,
    };
    const blocks = getNearestBlocksWhere(bot, (b: { name: string }) => b.name === 'oak_log', 512, 1);
    expect(blocks).toEqual([]);
    expect(blockAt).not.toHaveBeenCalled();
  });

  it('goToNearestBlock 在 interrupt_code 已置位时不进同步扫描，直接回执保命打断', async () => {
    const bot = { output: '', interrupt_code: true };
    await expect(goToNearestBlock(bot, 'oak_log', 4, 64)).resolves.toBe(false);
    expect(bot.output).toContain('保命打断');
  });
});

describe('stay 被保命中断', () => {
  it('forceStopBody 后 stay 立刻返回，不被残留等待拖住', async () => {
    const bot = { output: '', interrupt_code: false };
    const agent = { bot, requestInterrupt: () => { bot.interrupt_code = true; } };
    forceStopBody(agent);
    const started = Date.now();
    await expect(stay(bot, -1)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(bot.output).toContain('Stayed for');
  });
});
