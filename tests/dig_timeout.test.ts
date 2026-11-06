/**
 * task-21：挖方块动态超时 + 超时续挖。
 */
import { describe, expect, it, vi } from 'vitest';
import { estimateDigTimeoutMs, digWithTimeout, mineBlockAt } from '../src/body/library/skills.js';

function block(name: string, digMs: number, hardness = 1, bareMs?: number): any {
  return {
    name,
    hardness,
    position: { x: 0, y: 0, z: 0 },
    canHarvest: () => true,
    // **替身必须和真方块一样"看工具说话"**：`digTime(itemId)` 的 `null` 参数是**徒手**，
    // 给仪表就是"用这件工具要多久"。以前这一版对谁都返回同一个数，于是造出
    // "黑曜石徒手 9.4 秒"这种假事实，正好喂给"卡住就徒手硬挖"的逃生分支 ——
    // 用一个假数字让机器人去啃 250 秒才碎、且毫不可能掉落的方块。
    digTime: (itemId?: number | null) => (itemId == null ? (bareMs ?? digMs) : digMs),
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
  it('第一次超时后继续第二次，成功后不再写过程日志', async () => {
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
      expect(bot.output).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('两次都超时才返回 false，并写清失败与累计时长', async () => {
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
      expect(bot.output).toContain('没挖到 obsidian @(0,0,0)，2 次都超时了，累计等了 24');
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
  });

  it('工具不够：不白等动态超时，明确报工具不对', async () => {
    // 黑曜石：钻石镐 9.4 秒，**徒手 250 秒**（硬度 50 × 5 秒/硬度）。
    const target = block('obsidian', 9400, 50, 250_000);
    target.canHarvest = () => false;
    // **要工具的方块必须照原版声明 `harvestTools`**：planDig 的能力判据读它。
    // 只把它标成"非空"（=这块必须有工具），`canHarvest` 上面已经固定成 false。
    target.harvestTools = { 9999: true };
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

  // 回归：**被封住也不能拿空手去啃黑曜石**。2026-10-23 加的"卡住就徒手硬挖"出路
  // 有 12 秒的上限，黑曜石徒手 250 秒必须被拦住——否则机器人会在一个永远挖不穿的
  // 方块前耗到超时，还以为自己在脱身。
  it('卡住了也不等于可以硬啃：黑曜石徒手 250 秒，照样拒绝', async () => {
    const target = block('obsidian', 9400, 50, 250_000);
    target.canHarvest = () => false;
    // **要工具的方块必须照原版声明 `harvestTools`**：planDig 的能力判据读它。
    // 只把它标成"非空"（=这块必须有工具），`canHarvest` 上面已经固定成 false。
    target.harvestTools = { 9999: true };
    const bot = {
      output: '',
      game: { gameMode: 'survival' },
      heldItem: { type: 1, name: 'wooden_pickaxe' },
      entity: { position: { distanceTo: () => 2 } },
      // 四面八方都是目标方块 ⇒ `isStuckInPlace` 为真（真的被封住了）
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
  it('bot.dig 永不返回，但目标方块已经变空气：判成功且不写过程日志', async () => {
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
      // 看门狗每 200ms 查一次；第 6 次（1.2s）开始返回空气。
      await vi.advanceTimersByTimeAsync(1_200);
      await expect(pending).resolves.toBe(true);
      expect(bot.output).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('外部 stopDigging 正常中断', () => {
  it('bot.dig 抛 Digging aborted：当正常中断返回 false，不重试不抛', async () => {
    const bot: any = {
      output: '',
      dig: vi.fn(() => Promise.reject(new Error('Digging aborted'))),
      stopDigging: vi.fn(),
      heldItem: { type: 1, name: 'diamond_pickaxe' },
      targetDigBlock: null,
    };
    await expect(digWithTimeout(bot, block('iron_ore', 4600, 3), '@(0,0,0)')).resolves.toBe(false);
    expect(bot.output).toBe('');
    expect(bot.dig).toHaveBeenCalledTimes(1);
  });
});

