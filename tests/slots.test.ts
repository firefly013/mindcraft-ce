/**
 * 实例类工具的槽位寻址。
 *
 * 名字只到“类型”，槽位才到“这一件”。这里钉住 equip / discard / useOn 三条
 * 最常用的实例操作，以及槽位越界、装备栏不能直接丢这两条边界。
 */
import { describe, expect, it, vi } from 'vitest';
import { findCommand } from '../src/body/commands/registry.js';
import {
  discardSlot,
  equipSlot,
  itemAtSlot,
  useToolOnSlot,
} from '../src/body/library/skills.js';

function makeBot(slots: Record<number, any> = {}): any {
  const inventorySlots: any[] = new Array(46).fill(null);
  for (const [slot, item] of Object.entries(slots)) inventorySlots[Number(slot)] = { slot: Number(slot), ...item };
  const bot: any = {
    output: '',
    inventory: { slots: inventorySlots },
    heldItem: null,
    registry: { blocksByName: {} },
    entity: { position: { x: 0, y: 64, z: 0 } },
    game: { gameMode: 'survival' },
    equip: vi.fn((item: any) => {
      bot.heldItem = item;
      return Promise.resolve();
    }),
    tossStack: vi.fn(() => Promise.resolve()),
    activateItem: vi.fn(() => Promise.resolve()),
  };
  return bot;
}

describe('槽位解析', () => {
  it('itemAtSlot 按绝对槽位取物品，越界和空槽都返回 null', () => {
    const bot = makeBot({ 5: { name: 'diamond_helmet', count: 1 }, 36: { name: 'diamond_pickaxe', count: 1 } });
    expect(itemAtSlot(bot, 5)?.name).toBe('diamond_helmet');
    expect(itemAtSlot(bot, 36)?.name).toBe('diamond_pickaxe');
    expect(itemAtSlot(bot, 45)).toBeNull();
    expect(itemAtSlot(bot, 46)).toBeNull();
    expect(itemAtSlot(bot, 'abc')).toBeNull();
  });
});

describe('equipSlot', () => {
  it('装备第 N 格那一件，不是同名的第一件', async () => {
    const bot = makeBot({
      20: { name: 'diamond_pickaxe', count: 1 },
      37: { name: 'diamond_pickaxe', count: 1, enchants: [{ name: 'mending', level: 1 }] },
    });
    const ok = await equipSlot(bot, 37);
    expect(ok).toBe(true);
    expect(bot.equip).toHaveBeenCalledTimes(1);
    expect(bot.equip.mock.calls[0][0].slot).toBe(37);
    expect(bot.output).toContain('第 37 格');
  });

  it('空槽给事实，不假装成功', async () => {
    const bot = makeBot();
    expect(await equipSlot(bot, 12)).toBe(false);
    expect(bot.output).toContain('第 12 格没有东西');
  });
});

describe('discardSlot', () => {
  it('整叠丢走 tossStack，精确到那一格', async () => {
    const bot = makeBot({ 21: { name: 'cobblestone', count: 32 } });
    expect(await discardSlot(bot, 21)).toBe(true);
    expect(bot.tossStack).toHaveBeenCalledTimes(1);
    expect(bot.tossStack.mock.calls[0][0].slot).toBe(21);
    expect(bot.output).toContain('从背包第 21 格丢了 32 个 cobblestone');
  });

  it('装备栏里的东西不直接丢，明确让先换到背包', async () => {
    const bot = makeBot({ 5: { name: 'diamond_helmet', count: 1 } });
    expect(await discardSlot(bot, 5)).toBe(false);
    expect(bot.tossStack).not.toHaveBeenCalled();
    expect(bot.output).toContain('先换到背包');
  });
});

describe('useToolOnSlot', () => {
  it('用指定槽位那一件，而不是同名的另一格', async () => {
    const bot = makeBot({
      20: { name: 'diamond_pickaxe', count: 1 },
      38: { name: 'diamond_pickaxe', count: 1 },
    });
    expect(await useToolOnSlot(bot, 38, 'nothing')).toBe(true);
    expect(bot.equip).toHaveBeenCalledTimes(1);
    expect(bot.equip.mock.calls[0][0].slot).toBe(38);
    expect(bot.activateItem).toHaveBeenCalledTimes(1);
  });

  it('工具槽已空 ⇒ 明确报，不拿同名的另一件顶替', async () => {
    const bot = makeBot({ 20: { name: 'diamond_pickaxe', count: 1 } });
    expect(await useToolOnSlot(bot, 38, 'nothing')).toBe(false);
    expect(bot.equip).not.toHaveBeenCalled();
  });
});

describe('命令参数统一成槽位', () => {
  it('equip / discard / consume / useOn 的声明里不再有 item_name 或 tool_name', () => {
    expect(Object.keys(findCommand('!equip')?.params ?? {})).toEqual(['slot']);
    expect(Object.keys(findCommand('!discard')?.params ?? {})).toEqual(['slot', 'num']);
    expect(Object.keys(findCommand('!consume')?.params ?? {})).toEqual(['slot']);
    expect(Object.keys(findCommand('!useOn')?.params ?? {})).toEqual(['tool_slot', 'target']);
    expect(Object.keys(findCommand('!throwItem')?.params ?? {})).toEqual(['slot', 'target_x', 'target_y', 'target_z']);
  });
});
