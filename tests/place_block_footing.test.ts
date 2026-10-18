/**
 * 「绝不清掉自己的落脚点」 —— 真机 2026-10-19（overnight_b，虚空上方）。
 *
 * verbatim：「placeBlock 把目标格的承重方块挖掉后放置失败，没补回去 —— 我在虚空上方
 * 照它建议垫脚，反而被拆了落脚点」。工具亲手拆了自己的立足点，离坠入虚空一步之差。
 *
 * 两道防线：① 要清的那一格是（或托着）脚底 ⇒ **在任何破坏之前拒绝**；
 * ② 万一已经拆了、后面又失败 ⇒ **补回去**；补不回去就点名"哪一格现在是空的"。
 */
import { describe, expect, it, vi } from 'vitest';
import { failPlacementAfterClear, isFootingCell } from '../src/body/library/skills.js';

describe('落脚点判定：脚所在格 + 托着脚的那一格', () => {
  const feet = { x: 10.7, y: 64.2, z: -3.4 };

  it('目标格 = 脚所在格（向下取整后）⇒ 是落脚点', () => {
    expect(isFootingCell({ x: 10, y: 64, z: -4 }, feet)).toBe(true);
  });

  it('目标格 = 脚下面那一格（承重块）⇒ 是落脚点', () => {
    expect(isFootingCell({ x: 10, y: 63, z: -4 }, feet)).toBe(true);
  });

  it('相邻格 / 同列但高一格 / 别的列 ⇒ 不是落脚点（垫桥正是这种情况）', () => {
    expect(isFootingCell({ x: 11, y: 64, z: -4 }, feet)).toBe(false); // 旁边一格：正常搭桥
    expect(isFootingCell({ x: 10, y: 65, z: -4 }, feet)).toBe(false); // 头顶
    expect(isFootingCell({ x: 10, y: 63, z: -3 }, feet)).toBe(false); // 别的列
  });

  it('读不到脚的位置 ⇒ 不拦（守卫读不到就不许拦人）', () => {
    expect(isFootingCell({ x: 10, y: 63, z: -4 }, null)).toBe(false);
    expect(isFootingCell({ x: 10, y: 63, z: -4 }, { x: NaN, y: 1, z: 2 })).toBe(false);
  });
});

describe('放置失败后的补回：补得回/补不回都要说清世界净变化', () => {
  const cleared = { name: 'dirt', x: 10, y: 63, z: -4 };

  function botFor(restoreWorks: boolean, opts: { hasBlockItem?: boolean } = {}): any {
    const world: Record<string, { name: string }> = {
      '10,63,-4': { name: 'air' },
      '10,62,-4': { name: 'stone' }, // 下方是实心：可以作为依托面
    };
    const bot: any = {
      output: '',
      blockAt: (pos: any) => world[`${pos.x},${pos.y},${pos.z}`] ?? null,
      inventory: { findInventoryItem: () => (opts.hasBlockItem === false ? null : { name: 'dirt', type: 3 }) },
      equip: vi.fn(async () => undefined),
      placeBlock: vi.fn(async () => {
        if (restoreWorks) world['10,63,-4'] = { name: 'dirt' };
      }),
    };
    return bot;
  }

  it('补回成功 ⇒ 回执说"已补回"、点名坐标与"净变化等于没变"', async () => {
    const bot = botFor(true);
    await failPlacementAfterClear(bot, cleared, '放 dirt 到 (10,63,-4)：周围没有可依托的面');
    const text = String(bot.output);
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
    expect(text).toContain('已经把你为了放置拆掉的 dirt @(10,63,-4) 补回去了');
    expect(text).toContain('净变化');
    expect(text).toContain('没有留下空洞');
  });

  it('补不回（背包里没有那种方块）⇒ 明确点名"那一格现在是空的、别往那踩"', async () => {
    const bot = botFor(true, { hasBlockItem: false });
    await failPlacementAfterClear(bot, cleared, '放 dirt 到 (10,63,-4) 失败');
    const text = String(bot.output);
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(text).toContain('现在是空的、没能补回');
    expect(text).toContain('别往那一格踩');
  });

  it('补不回（放回去也失败）⇒ 同样点名，不许沉默', async () => {
    const bot = botFor(false);
    await failPlacementAfterClear(bot, cleared, '放 dirt 到 (10,63,-4) 失败');
    expect(String(bot.output)).toContain('没能补回');
  });

  it('没拆过东西 ⇒ 一个字都不说（不许给正常路径加噪音）', async () => {
    const bot = botFor(true);
    await failPlacementAfterClear(bot, null, '放 dirt 失败');
    expect(String(bot.output)).toBe('');
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });

  it('补回时**绝不再走 placeBlock 的清障逻辑**（不递归拆别的东西）：只调 bot.placeBlock', async () => {
    const bot = botFor(true);
    await failPlacementAfterClear(bot, cleared, 'x');
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
    // 只 equip 了要补回去的那种方块
    expect(bot.equip).toHaveBeenCalledTimes(1);
  });
});
