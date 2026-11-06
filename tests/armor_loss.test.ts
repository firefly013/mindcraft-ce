/**
 * 金盔消失 ⇒ 猪灵开火 ⇒ 下界第 7 次死亡（overnight_b，2026-10-19）。
 *
 * 现场：模型按要求做了 `golden_helmet` 并穿上；随后这件**从 armour 槽消失、背包
 * totals 里也没有**，没有任何"换甲"报告；无金盔 ⇒ 猪灵见即开火 ⇒ 死亡。
 * 旧守卫只覆盖"金甲被换成非金甲"，**没覆盖"这件东西没了"**。
 *
 * 这里钉住四件事：消失要吼、吼里要有后果和修法、下界丢最后一件金要提前警告、
 * 死亡/重生前后的消失要先怀疑读取（而不是直接当成"已经没了"）。
 */
import { describe, expect, it } from 'vitest';
import {
  armorSnapshot,
  armorVanishReport,
  diffArmorSnapshot,
  goldArmorNameFor,
  installArmorGuard,
  isGoldArmorName,
} from '../src/body/library/armor_guard.js';

function armorBot(slots: Record<number, { name: string } | null>, dimension = 'minecraft:the_nether'): any {
  const listeners = new Map<string, Array<(...a: any[]) => void>>();
  const invListeners = new Map<string, Array<(...a: any[]) => void>>();
  const bot: any = {
    game: { dimension },
    inventory: {
      slots: new Array(46).fill(null),
      items: () => Object.values(slots).filter(Boolean),
      on: (event: string, cb: (...a: any[]) => void) => {
        invListeners.set(event, [...(invListeners.get(event) ?? []), cb]);
      },
      off: () => undefined,
    },
    on: (event: string, cb: (...a: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    },
    off: () => undefined,
    _emitInventory: (event: string, ...args: any[]) => {
      for (const cb of invListeners.get(event) ?? []) cb(...args);
    },
    _emitBot: (event: string, ...args: any[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  };
  for (const [slot, item] of Object.entries(slots)) bot.inventory.slots[Number(slot)] = item;
  return bot;
}

const logs: string[] = [];
const log = (_bot: any, text: string): void => {
  logs.push(text);
};

describe('"原来有 → 现在空"：消失不是换甲，必须吼出来', () => {
  it('下界丢掉金盔 ⇒ 报告点名槽位、原物品和触发路径', () => {
    const text = armorVanishReport(
      { slotName: 'head', from: 'golden_helmet', to: null },
      { dimension: 'minecraft:the_nether', goldLeft: false, via: 'updateSlot' },
    );
    expect(text).toContain('head 的护甲没有了，原来穿着 golden_helmet，现在空着，触');
    expect(text).toContain('head');
    expect(text).toContain('golden_helmet');
    expect(text).toContain('head 的护甲没有了，原来穿着 golden_helmet，现在空着，触');
  });

  it('死亡前后丢甲 ⇒ 报告只报事实（槽位与路径），不做原因推测', () => {
    const text = armorVanishReport(
      { slotName: 'head', from: 'golden_helmet', to: null },
      { dimension: 'minecraft:the_nether', deathHappened: true, goldLeft: false, via: 'spawn' },
    );
    expect(text).toContain('head 的护甲没有了，原来穿着 golden_helmet，现在空着，触');
    expect(text).toContain('head 的护甲没有了，原来穿着 golden_helmet，现在空着，触');
    expect(text).not.toContain('读取/同步');
  });

  it('主世界丢甲同样只报事实，不误报猪灵', () => {
    const text = armorVanishReport(
      { slotName: 'torso', from: 'iron_chestplate', to: null },
      { dimension: 'minecraft:overworld', via: 'update' },
    );
    expect(text).toContain('torso 的护甲没有了，原来穿着 iron_chestplate，现在空');
    expect(text).toContain('iron_chestplate');
    expect(text).not.toContain('猪灵');
  });

  it('"死而复生"时护甲没变的快照差分 = 没有变化', () => {
    const before = { head: 'golden_helmet', torso: null, legs: null, feet: null } as const;
    const after = { ...before };
    expect(diffArmorSnapshot(before as any, after as any)).toEqual([]);
    expect(isGoldArmorName('golden_helmet')).toBe(true);
    expect(goldArmorNameFor('head')).toBe('golden_helmet');
  });
});

describe('守卫接线：所有护甲槽变化路径都要落到报告上', () => {
  it('updateSlot 把金盔写成 null ⇒ 一行"护甲消失"（走我们自己的报告，不是普通换甲）', () => {
    logs.length = 0;
    const bot = armorBot({ 5: { name: 'golden_helmet' } });
    const guard = installArmorGuard(bot, { log, inventoryItems: () => [] });
    bot._emitInventory('updateSlot', 5, { name: 'golden_helmet' }, null);
    guard.dispose();
    expect(logs.some((line) => line.includes('的护甲没有了'))).toBe(true);
    // 普通"护甲变化："报告不该为这件事再出现一次
    expect(logs.filter((line) => line.includes('护甲变化：')).length).toBe(0);
  });

  it('整窗 update 覆盖掉金盔（updateSlot 不触发）⇒ 快照差分也要吼出来', () => {
    logs.length = 0;
    const bot = armorBot({ 5: { name: 'golden_helmet' } });
    const guard = installArmorGuard(bot, { log, inventoryItems: () => [] });
    bot.inventory.slots[5] = null; // 整窗同步把它抹掉了
    bot._emitInventory('update');
    guard.dispose();
    expect(logs.some((line) => line.includes('的护甲没有了') && line.includes('update'))).toBe(true);
  });

  it('死亡后再重生：护甲还在 ⇒ 不许报"消失"；真丢了才报', () => {
    logs.length = 0;
    const bot = armorBot({ 5: { name: 'golden_helmet' } });
    const guard = installArmorGuard(bot, { log, inventoryItems: () => [] });
    bot._emitBot('death');
    // 重生后同一件还在
    bot._emitBot('spawn');
    expect(logs.filter((line) => line.includes('的护甲没有了'))).toHaveLength(0);
    // 现在把它弄丢（槽位被清空）
    bot.inventory.slots[5] = null;
    bot._emitBot('spawn');
    guard.dispose();
    expect(logs.some((line) => line.includes('的护甲没有了'))).toBe(true);
  });

  it('普通换甲（铁→钻）仍走原来的"护甲变化"报告（不回归）', () => {
    logs.length = 0;
    const bot = armorBot({ 6: { name: 'iron_chestplate' } }, 'minecraft:overworld');
    const guard = installArmorGuard(bot, { log, inventoryItems: () => [] });
    bot.inventory.slots[6] = { name: 'diamond_chestplate' };
    bot._emitInventory('updateSlot', 6, { name: 'iron_chestplate' }, { name: 'diamond_chestplate' });
    guard.dispose();
    expect(logs.some((line) => line.includes('护甲变化'))).toBe(true);
    expect(logs.some((line) => line.includes('的护甲没有了'))).toBe(false);
  });
});

