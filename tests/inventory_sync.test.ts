/**
 * ① 重启后背包"读成空"的回归 —— 真机 2026-10-18。
 *
 * 事故：进程重启（当晚第 3 次）后第一份快照读成 `Held: main empty` /
 * `Backpack (free 36): empty`，模型据此以为丢了全部家当，从零重新采集。
 * Lead 解码 playerdata 证实：`.dat_old` 里 **dirt×11** 好端端躺着（xp=8），
 * 物品从来没丢——丢的是"我们把它读成了空"这个**状态**。
 *
 * 要求：`empty` 和 `unknown` 必须可区分；未知时不许让任何"我有几个 X?"的判断
 * 把它当成 0。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderLiveState } from '../src/shared/live_state.js';
import { sampleLiveState } from '../src/body/live_state.js';
import { countInInventory, countInInventoryWithSync } from '../src/body/commands/interact.js';

function botWithItems(items: Array<{ name: string; count: number }>, held: { name: string; count: number } | null): any {
  const slots: Array<{ name: string; count: number } | null> = Array.from({ length: 46 }, () => null);
  items.forEach((item, i) => {
    slots[36 + i] = item;
  });
  if (held != null) slots[36] = held;
  return {
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    experience: { level: 0, progress: 0 },
    inventory: {
      slots,
      items: () => slots.filter((slot) => slot != null),
    },
    heldItem: held,
    registry: { blocksByName: {}, itemsByName: {} },
    game: { dimension: 'overworld' },
    entities: {},
    players: {},
  };
}

const render = (bot: any, inventorySynced: boolean): string =>
  renderLiveState(sampleLiveState({ bot, inventorySynced }));

describe('① 背包还没同步：说"还没同步"，不许说"空"', () => {
  it('刚重连（还没收到背包包）：渲染层明确说"还没同步上来 / 不是空的"，且不出现 empty', () => {
    const text = render(botWithItems([], null), false);
    expect(text).toContain('Held: main 还没同步上来');
    expect(text).toContain('不是空的');
    expect(text).not.toContain('Held: main empty');
    expect(text).not.toContain('Backpack (free 36): empty');
  });

  it('同步之后：报真实内容（dirt×11 这类）', () => {
    const text = render(botWithItems([{ name: 'dirt', count: 11 }], { name: 'dirt', count: 11 }), true);
    expect(text).toContain('dirtx11');
    expect(text).toContain('Backpack');
    expect(text).not.toContain('还没同步');
  });

  it('**真的**是空包（已同步）→ 才可以说 empty', () => {
    const text = render(botWithItems([], null), true);
    expect(text).toContain('Held: main empty');
    expect(text).toContain('empty');
    expect(text).not.toContain('还没同步');
  });

  it('决策路径：未同步时 countInInventory 返回 null（不是 0）', () => {
    const bot = botWithItems([{ name: 'dirt', count: 11 }], null);
    bot.__inventorySynced = false;
    expect(countInInventory(bot, 'dirt')).toBeNull();
    expect(countInInventory(bot, 'diamond')).toBeNull(); // 缺东西也不许报 0
    // 同步后才给真值
    bot.__inventorySynced = true;
    expect(countInInventory(bot, 'dirt')).toBe(11);
    expect(countInInventory(bot, 'diamond')).toBe(0);
  });

  it('countInInventoryWithSync：未同步时最多等到上限，然后如实返回 null', async () => {
    const bot = botWithItems([{ name: 'dirt', count: 11 }], null);
    bot.__inventorySynced = false;
    expect(await countInInventoryWithSync(bot, 'dirt', 1, 0)).toBeNull();
  });

  it('没挂 __inventorySynced 的老调用方行为不变（兼容）', () => {
    const bot = botWithItems([{ name: 'dirt', count: 11 }], null);
    expect(countInInventory(bot, 'dirt')).toBe(11);
  });
});

describe('开窗/关窗不许把背包渲染成"空"（真机 2026-10-19「一开 crafting_table 背包立刻被清空」）', () => {
  const src = () => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('windowOpen ⇒ 标成未同步（只影响渲染口径，不是物品丢了）', () => {
    const code = src();
    expect(code).toContain("this.bot.on('windowOpen', () => {");
    expect(code).toContain("why: 'window-open'");
  });

  it('windowClose ⇒ 先标未同步，再按"关窗后的读数"采信（有界 300ms，窗口还开着就继续未知）', () => {
    const code = src();
    expect(code).toContain("this.bot.on('windowClose', () => {");
    expect(code).toContain("why: 'window-close'");
    expect(code).toContain('if ((this.bot as any)?.currentWindow != null) return;');
    expect(code).toContain("event: 'inventory-resynced'");
  });

  it('渲染层契约未变：inventorySynced=false 时必须写"还没同步（不是空的）"', () => {
    const live = readFileSync(join(process.cwd(), 'src', 'body', 'live_state.ts'), 'utf8');
    expect(live).toContain('这个字段为 false 时，渲染层必须写"还没同步上来（**不是空的**）"');
  });
});
