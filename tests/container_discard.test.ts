/**
 * task-27：容器读取只取 inventoryStart 区间；discard 原地丢并回精确落点。
 */
import { describe, expect, it, vi } from 'vitest';
import { containerContents } from '../src/body/library/skills.js';
import { findCommand } from '../src/body/commands/registry.js';

describe('containerContents：严格按 inventoryStart 分界', () => {
  it('63 槽箱子：只读 0..27，不把查看者背包 27..63 串进来', () => {
    const slots: Array<{ name: string; count: number } | null> = new Array(63).fill(null);
    slots[0] = { name: 'iron_ingot', count: 5 };
    slots[12] = { name: 'obsidian', count: 10 };
    slots[28] = { name: 'diamond_pickaxe', count: 1 };
    slots[40] = { name: 'water_bucket', count: 1 };
    const contents = containerContents({ inventoryStart: 27, slots });
    expect(contents.readable).toBe(true);
    expect(contents.invStart).toBe(27);
    expect(contents.lines).toContain('iron_ingot×5');
    expect(contents.lines).toContain('obsidian×10');
    expect(contents.lines.join('、')).not.toContain('diamond_pickaxe');
    expect(contents.lines.join('、')).not.toContain('water_bucket');
  });

  it('熔炉 inventoryStart=3：只读输入/燃料/产物三槽', () => {
    const slots = [
      { name: 'raw_iron', count: 2 },
      { name: 'coal', count: 1 },
      { name: 'iron_ingot', count: 6 },
      { name: 'bread', count: 3 },
    ];
    const contents = containerContents({ inventoryStart: 3, slots });
    expect(contents.lines).toEqual(['raw_iron×2', 'coal×1', 'iron_ingot×6']);
  });

  it('槽位表读不到：明确说读不到，不写空', () => {
    const contents = containerContents(null);
    expect(contents.readable).toBe(false);
    expect(contents.lines.join('、')).toContain('读不到');
  });
});

describe('discard：原地丢不移动，并回报落点', () => {
  it('不调用任何寻路/移动，toss 在当前位置发生，回执带起点/落点', async () => {
    const item = { type: 1, name: 'water_bucket', count: 1 };
    const bot: any = {
      output: '',
      inventory: { findInventoryItem: () => item },
      toss: vi.fn(async () => {}),
      entity: {
        yaw: 0,
        position: {
          x: 1.25,
          y: 64.5,
          z: -2.75,
          clone(): { x: number; y: number; z: number } {
            return { x: 1.25, y: 64.5, z: -2.75 };
          },
        },
      },
      pathfinder: { setGoal: vi.fn(), setMovements: vi.fn(), stop: vi.fn() },
    };
    const agent: any = {
      bot,
      actions: {
        runAction: async (_label: string, fn: () => Promise<void>) => {
          await fn();
          return { interrupted: false, timedout: false, message: '' };
        },
      },
    };
    const command = findCommand('discard');
    expect(command).toBeDefined();
    if (command == null) throw new Error('discard command missing');
    await command.perform(agent, 'water_bucket', 1);
    expect(bot.toss).toHaveBeenCalledTimes(1);
    expect(bot.pathfinder.setGoal).not.toHaveBeenCalled();
    expect(bot.pathfinder.setMovements).not.toHaveBeenCalled();
    expect(bot.output).toContain('原地扔掉');
    expect(bot.output).toContain('落点');
    expect(bot.output).toContain('1.25');
  });
});
