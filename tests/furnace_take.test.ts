/**
 * 熔炉取物契约（Lead 裁定，2026-10-19）：**产物槽里有什么取什么，并报数量**。
 *
 * 真机报告：「useBlock 从熔炉取物一次只取 1 个」——根因是 `output` 不带数量时
 * `parseItems` 给的默认 `count=1` 被当成了"只要 1 个"。原版熔炉界面是整叠拿走的。
 *
 * 契约：不指定数量 ⇒ 取走产物槽现有全部；指定数量 ⇒ 按数量取（数量小于整叠时
 * 诚实说做不到，因为 mineflayer 只支持整叠取）；**绝不碰原料槽/燃料槽**；
 * 取到的数量来自**背包实际增量**，不是"我打算取几个"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseItems, takeFromFurnace } from '../src/body/commands/interact.js';

const located = { x: 1, y: 64, z: 1 };

function furnaceBot(
  output: { name: string; count: number } | null,
  opts: { inventory?: Record<string, number>; blockName?: string } = {},
): any {
  const inv: Record<string, number> = { ...(opts.inventory ?? {}) };
  let slot = output == null ? null : { ...output };
  const state = { input: { name: 'raw_iron', count: 2 }, fuel: { name: 'coal', count: 3 } };
  const bot: any = {
    inventory: { items: () => Object.entries(inv).map(([name, count]) => ({ name, count })) },
    blockAt: () => ({ name: opts.blockName ?? 'furnace' }),
    closeWindow: vi.fn(),
  };
  bot.openFurnace = vi.fn(async () => ({
    outputItem: () => slot,
    inputItem: () => state.input,
    fuelItem: () => state.fuel,
    takeOutput: async () => {
      if (slot == null) return null;
      const taken = { ...slot };
      inv[slot.name] = (inv[slot.name] ?? 0) + slot.count;
      slot = null;
      return taken;
    },
    takeInput: vi.fn(),
    takeFuel: vi.fn(),
  }));
  return bot;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('parseItems：不写数量 ≠ 只要 1 个', () => {
  it('裸名字 ⇒ countGiven=false（默认 1 只是占位）', () => {
    expect(parseItems('iron_ingot').items[0]).toMatchObject({ name: 'iron_ingot', count: 1, countGiven: false });
  });
  it('显式数量 ⇒ countGiven=true（"3 iron_ingot" 与 {name,count} 都算）', () => {
    expect(parseItems('3 iron_ingot').items[0]).toMatchObject({ name: 'iron_ingot', count: 3, countGiven: true });
    expect(parseItems({ name: 'iron_ingot', count: 3 }).items[0]).toMatchObject({ count: 3, countGiven: true });
  });
});

describe('产物槽有 3 ⇒ 全部取走并说 3（默认行为）', () => {
  it('报"取出 3 个"、来源是背包增量、只动产牛槽', async () => {
    const bot = furnaceBot({ name: 'iron_ingot', count: 3 });
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 1, countGiven: false }, 'furnace');
    const text = lines.join('\n');
    expect(text).toContain('取出 3 个 iron_ingot');
    expect(text).toContain('只动了产物槽');
    expect(text).toContain('原料槽/燃料槽没动');
    // 绝不碰 input/fuel
    const furnace = await bot.openFurnace();
    expect(furnace.takeInput).not.toHaveBeenCalled();
    expect(furnace.takeFuel).not.toHaveBeenCalled();
  });
});

describe('产物槽只有 1 个（其余还在烧）⇒ 取 1 并明说只有 1 个', () => {
  it('小数不等于失败：回执说"只有 1 个（其余还在烧）"', async () => {
    const bot = furnaceBot({ name: 'iron_ingot', count: 1 });
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 1, countGiven: false }, 'furnace');
    const text = lines.join('\n');
    expect(text).toContain('取出 1 个 iron_ingot');
    expect(text).toContain('只有 1 个');
    expect(text).toContain('还在烧');
    expect(text).toContain('不是失败');
  });
});

describe('显式数量：整叠取不了小份时必须说清，而不是偷偷全拿', () => {
  it('产物槽 5 个、要求 2 个 ⇒ 不动任何槽位，明说只能整叠取 + 提示正确做法', async () => {
    const bot = furnaceBot({ name: 'iron_ingot', count: 5 });
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 2, countGiven: true }, 'furnace');
    const text = lines.join('\n');
    expect(text).toContain('只能**整叠取**');
    expect(text).toContain('没动**任何槽位');
    expect(text).toContain('5 个仍在产物槽里');
    expect(text).toContain('不带数量');
  });

  it('要求数量 ≥ 槽内数量 ⇒ 整叠取走并说清这次取了几个', async () => {
    const bot = furnaceBot({ name: 'iron_ingot', count: 2 });
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 5, countGiven: true }, 'furnace');
    const text = lines.join('\n');
    expect(text).toContain('取出 2 个 iron_ingot');
    expect(text).toContain('这次取 2 个');
  });
});

describe('诚实失败路径', () => {
  it('产物槽空 ⇒ 明说"空的、没东西可取"，不是静默成功', async () => {
    const bot = furnaceBot(null);
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 1, countGiven: false }, 'furnace');
    const text = lines.join('\n');
    expect(text).toContain('产物槽是空的');
    expect(text).toContain('没有东西可取');
  });

  it('产物槽是别的东西 ⇒ 不拿错，并给出正确写法', async () => {
    const bot = furnaceBot({ name: 'gold_ingot', count: 2 });
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 1, countGiven: false }, 'furnace');
    const text = lines.join('\n');
    expect(text).toContain('不是 iron_ingot');
    expect(text).toContain('gold_ingot');
    expect(text).toContain('output="gold_ingot"');
  });

  it('打不开熔炉 ⇒ 明说"打不开，不是里面没有"', async () => {
    const bot: any = {
      inventory: { items: () => [] },
      blockAt: () => ({ name: 'furnace' }),
      openFurnace: async () => {
        throw new Error('windowOpen did not fire within timeout');
      },
      closeWindow: vi.fn(),
    };
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 1, countGiven: false }, 'furnace');
    const text = lines.join('\n');
    expect(text).toContain('打不开');
    expect(text).toContain('不是"里面没有"');
  });

  it('目标格读不到方块 ⇒ 直接说清，没动槽位', async () => {
    const bot: any = { inventory: { items: () => [] }, blockAt: () => null, closeWindow: vi.fn() };
    const lines = await takeFromFurnace(bot, located, { name: 'iron_ingot', count: 1, countGiven: false }, 'furnace');
    expect(lines.join('\n')).toContain('这次没动任何槽位');
  });
});
