/**
 * 合成必须**核对产物**（Lead 2026-10-21 真机）：请求 `wooden_pickaxe`，背包里多出来的是
 * `oak_pressure_plate`（3 条木板一排＝压力板配方），回执却报成功。框架的"完成"不是证据，
 * 背包实测才是；窗口事件超时也不许报"成功"。
 */
import { describe, expect, it } from 'vitest';
import { craftWithStaleWindowGuard } from '../src/body/library/skills.js';

function fakeBot(craftImpl: (items: Array<{ name: string; count: number }>) => void): any {
  const items: Array<{ name: string; count: number }> = [
    { name: 'oak_planks', count: 3 },
    { name: 'stick', count: 2 },
  ];
  const bot: any = {
    output: '',
    currentWindow: null,
    inventory: { items: () => items },
    craft: async () => {
      craftImpl(items);
    },
    closeWindow: () => {},
    once: () => {},
    removeListener: () => {},
  };
  return bot;
}

const table = { position: { x: 0, y: 64, z: 0 } };
const recipe = { result: { id: 'wooden_pickaxe', count: 1 } };

describe('产物核对：跑偏就说跑偏', () => {
  it('实际多出来的是 oak_pressure_plate ⇒ **不报成功**，明说做出来的是什么', async () => {
    const bot = fakeBot((items) => {
      items.push({ name: 'oak_pressure_plate', count: 1 });
    });
    await expect(craftWithStaleWindowGuard(bot, recipe, 1, table)).rejects.toThrow(/oak_pressure_plate/);
    await expect(craftWithStaleWindowGuard(bot, recipe, 1, table)).rejects.toThrow(/不是 wooden_pickaxe/);
  });

  it('产物正确（wooden_pickaxe +1）⇒ 正常返回、没有"跑偏"', async () => {
    const bot = fakeBot((items) => {
      items.push({ name: 'wooden_pickaxe', count: 1 });
    });
    await expect(craftWithStaleWindowGuard(bot, recipe, 1, table)).resolves.toBeUndefined();
  });
});

describe('窗口事件超时：不许出现"成功"字样', () => {
  it('两次都超时 ⇒ 抛错且文案不含"成功"，明说窗口没打开', async () => {
    const bot = fakeBot(() => {
      // 什么都不产出
    });
    bot.craft = async () => {
      throw new Error('windowOpen timeout after 6000ms');
    };
    let message = '';
    try {
      await craftWithStaleWindowGuard(bot, recipe, 1, table, { retries: 1, timeoutMs: 20 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('成功');
    expect(message).toMatch(/窗口|window/i);
  });
});
