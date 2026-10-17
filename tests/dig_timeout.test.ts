/**
 * task-21：挖方块动态超时 + 超时续挖。
 */
import { describe, expect, it, vi } from 'vitest';
import { estimateDigTimeoutMs, digWithTimeout, mineBlockAt } from '../src/body/library/skills.js';

function block(name: string, digMs: number, hardness = 1): any {
  return {
    name,
    hardness,
    position: { x: 0, y: 0, z: 0 },
    canHarvest: () => true,
    digTime: () => digMs,
  };
}

describe('estimateDigTimeoutMs', () => {
  it('黑曜石按挖取时间 ×4 + buffer，覆盖实测 2.6×', () => {
    const plan = estimateDigTimeoutMs(block('obsidian', 9400, 50), 1);
    expect(plan.expectedMs).toBe(9400);
    expect(plan.timeoutMs).toBe(9400 * 4 + 3000);
  });

  it('digWithTimeout 优先用 bot.digTime(block) 的实测口径', async () => {
    vi.useFakeTimers();
    try {
      const bot = {
        output: '',
        dig: vi.fn(() => new Promise<never>(() => {})),
        stopDigging: vi.fn(),
        heldItem: { type: 1, name: 'diamond_pickaxe' },
        targetDigBlock: null,
        digTime: () => 15_000,
      };
      const pending = digWithTimeout(bot, block('obsidian', 9400, 50), '@(0,0,0)');
      // 15s × 4 + 3s = 63s；到 40s 时还不该超时。
      await vi.advanceTimersByTimeAsync(40_000);
      expect(bot.stopDigging).not.toHaveBeenCalled();
      // 第一次超时（63s）+ 续挖第二次再超时（63s）+ 200ms 间隔。
      await vi.advanceTimersByTimeAsync(200_000);
      await expect(pending).resolves.toBe(false);
      expect(bot.stopDigging).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('钻石矿 0.75s：至少给 minMs，不会 9 秒不到就放弃', () => {
    const plan = estimateDigTimeoutMs(block('deepslate_diamond_ore', 750, 3), 1);
    expect(plan.timeoutMs).toBeGreaterThanOrEqual(12_000);
  });

  it('没有 digTime 时按硬度兜底', () => {
    const plan = estimateDigTimeoutMs({ name: 'obsidian', hardness: 50 }, 1);
    expect(plan.expectedMs).toBe(45_000);
    expect(plan.timeoutMs).toBeGreaterThan(45_000);
  });

  it('不可破坏方块单独标记', () => {
    const plan = estimateDigTimeoutMs({ name: 'bedrock', hardness: -1, digTime: () => Infinity }, null);
    expect(plan.unbreakable).toBe(true);
  });
});

describe('digWithTimeout 超时续挖', () => {
  it('第一次超时后继续第二次，成功回报实际用时', async () => {
    vi.useFakeTimers();
    try {
      const dig = vi.fn()
        .mockImplementationOnce(() => new Promise<never>(() => {}))
        .mockResolvedValueOnce(undefined);
      const bot = {
        output: '',
        dig,
        stopDigging: vi.fn(),
        heldItem: { type: 1, name: 'diamond_pickaxe' },
        targetDigBlock: null,
      };
      const target = block('obsidian', 100, 50);
      const pending = digWithTimeout(bot, target, '@(0,0,0)');
      await vi.advanceTimersByTimeAsync(12_100);
      await vi.advanceTimersByTimeAsync(300);
      await pending;
      expect(dig).toHaveBeenCalledTimes(2);
      expect(bot.output).toContain('续挖');
      expect(bot.output).toContain('完成');
      expect(bot.output).toContain('用时');
    } finally {
      vi.useRealTimers();
    }
  });

  it('两次都超时才返回 false，并写清仍在挖 / 累计时长', async () => {
    vi.useFakeTimers();
    try {
      const bot = {
        output: '',
        dig: vi.fn(() => new Promise<never>(() => {})),
        stopDigging: vi.fn(),
        heldItem: { type: 1 },
        targetDigBlock: { name: 'obsidian' },
      };
      const pending = digWithTimeout(bot, block('obsidian', 100, 50), '@(0,0,0)');
      await vi.advanceTimersByTimeAsync(12_100);
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(12_100);
      await expect(pending).resolves.toBe(false);
      expect(bot.output).toContain('仍在挖');
      expect(bot.output).toContain('累计');
      expect(bot.stopDigging).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mineBlockAt 共用动态超时', () => {
  it('正确工具：正常挖掉', async () => {
    const target = block('obsidian', 50, 50);
    const bot = {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: { type: 1, name: 'diamond_pickaxe' },
      entity: { position: { distanceTo: () => 2 } },
      blockAt: () => target,
      tool: { equipForBlock: async () => {} },
      dig: async () => {},
      stopDigging: () => {},
      targetDigBlock: null,
    };
    await expect(mineBlockAt(bot, 0, 0, 0)).resolves.toBe(true);
    expect(bot.output).toContain('挖掉了');
    expect(bot.output).toContain('用时');
  });

  it('工具不够：不白等动态超时，明确报工具不对', async () => {
    const target = block('obsidian', 9400, 50);
    target.canHarvest = () => false;
    const bot = {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: { type: 1, name: 'wooden_pickaxe' },
      entity: { position: { distanceTo: () => 2 } },
      blockAt: () => target,
      tool: { equipForBlock: async () => {} },
      dig: vi.fn(),
      stopDigging: vi.fn(),
      targetDigBlock: null,
    };
    await expect(mineBlockAt(bot, 0, 0, 0)).resolves.toBe(false);
    expect(bot.output).toContain('没有能挖');
    expect(bot.dig).not.toHaveBeenCalled();
  });
});

describe('dig 看门狗：目标变空气就停止等待', () => {
  it('bot.dig 永不返回，但目标方块已经变空气：判成功并回报看门狗', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const target: any = {
        name: 'iron_ore',
        hardness: 3,
        position: { x: 0, y: 0, z: 0 },
        canHarvest: () => true,
        digTime: () => 4600,
      };
      const bot: any = {
        output: '',
        dig: vi.fn(() => new Promise<never>(() => {})),
        stopDigging: vi.fn(),
        heldItem: { type: 1, name: 'diamond_pickaxe' },
        targetDigBlock: { name: 'iron_ore' },
        blockAt: () => {
          calls += 1;
          return calls > 5 ? { name: 'air' } : { name: 'iron_ore' };
        },
      };
      const pending = digWithTimeout(bot, target, '@(0,0,0)');
      // 看门狗每 200ms 查一次；推进 1 秒足够它发现目标已经空。
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe(true);
      expect(bot.output).toContain('看门狗');
      expect(bot.output).toContain('iron_ore');
    } finally {
      vi.useRealTimers();
    }
  });
});

