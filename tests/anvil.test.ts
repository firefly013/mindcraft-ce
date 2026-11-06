import { describe, expect, it } from 'vitest';
import { findCommand } from '../src/body/commands/registry.js';
import { planUseBlock } from '../src/body/commands/interact.js';

function stack(name: string, count = 1, extra: Record<string, any> = {}) {
  return { name, count, ...extra };
}

function makeRegistry() {
  return {
    enchantmentsArray: [{ name: 'mending' }, { name: 'sharpness' }],
    effectsArray: [],
    instrumentsArray: [],
    itemsArray: [{ name: 'arrow' }],
  };
}

interface AnvilFixture {
  bot: any;
  placed: any[];
  inventoryItems: any[];
}

/**
 * 假身体：铁砧窗口只有 3 个槽（0=主物品、1=牺牲品、2=产物），
 * 背包槽 9/10/11 ... 通过 `inventoryStart` 折算到窗口槽。
 */
function makeAnvilBot(options: { sword?: any; books?: any[] } = {}): AnvilFixture {
  const sword = options.sword ?? stack('diamond_sword', 1, { slot: 9, enchants: [{ name: 'sharpness', lvl: 1 }] });
  const books = options.books ?? [
    stack('enchanted_book', 1, {
      slot: 10,
      componentMap: new Map([['stored_enchantments', { type: 'stored_enchantments', data: { enchantments: [{ id: 0, level: 1 }] } }]]),
    }),
    stack('enchanted_book', 1, {
      slot: 11,
      componentMap: new Map([['stored_enchantments', { type: 'stored_enchantments', data: { enchantments: [{ id: 1, level: 5 }] } }]]),
    }),
  ];
  const items: any[] = [sword, ...books];
  const slots: any[] = new Array(46).fill(null);
  for (const item of items) if (Number.isFinite(item.slot)) slots[item.slot] = item;
  const placed: any[] = [];

  const window: any = {
    inventoryStart: 3,
    selectedItem: null,
    slots: new Array(39).fill(null),
    close: () => Promise.resolve(),
  };
  // 背包区镜像到窗口槽：item.slot 9 → 窗口槽 3。
  slots.forEach((item, slot) => {
    if (item != null) window.slots[slot - 6] = item;
  });

  const tryProduce = (): void => {
    const a = window.slots[0];
    const b = window.slots[1];
    if (a == null || b == null) return;
    if (window.slots[2] == null) {
      window.slots[2] = stack('diamond_sword', 1, { enchants: [{ name: 'sharpness', lvl: 2 }] });
    }
  };

  const bot: any = {
    game: { dimension: 'overworld', gameMode: 'survival' },
    entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0, onGround: true },
    inventory: {
      slots,
      inventoryStart: 9,
      items: () => items,
    },
    registry: makeRegistry(),
    health: 20,
    food: 20,
    output: '',
    blockAt: () => ({ name: 'anvil', position: { x: 0, y: 64, z: 0 } }),
    openAnvil: () => Promise.resolve(window),
    waitForTicks: () => Promise.resolve(),
    clickWindow: (slot: number, button: number): Promise<void> => {
      if (slot === 2) return Promise.resolve();
      if (window.selectedItem == null) {
        window.selectedItem = window.slots[slot] ?? null;
        window.slots[slot] = null;
        if (window.selectedItem != null) placed.push(window.selectedItem);
        return Promise.resolve();
      }
      const dest = window.slots[slot];
      if (window.selectedItem != null && (dest == null || dest.name === window.selectedItem.name)) {
        if (button === 1) {
          if (dest == null) {
            window.slots[slot] = { ...window.selectedItem, count: 1 };
          } else {
            dest.count += 1;
          }
          window.selectedItem.count -= 1;
          if (window.selectedItem.count <= 0) window.selectedItem = null;
        } else {
          if (dest == null) {
            window.slots[slot] = window.selectedItem;
            window.selectedItem = null;
          } else {
            dest.count += window.selectedItem.count;
            window.selectedItem = null;
          }
        }
      }
      tryProduce();
      return Promise.resolve();
    },
    putAway: (slot: number): Promise<void> => {
      const product = window.slots[slot];
      if (product == null) return Promise.resolve();
      const freeSlot = slots.findIndex((s, i) => i >= 9 && s == null);
      if (freeSlot >= 0) slots[freeSlot] = product;
      items.push(product);
      window.slots[slot] = null;
      return Promise.resolve();
    },
  };

  return { bot, placed, inventoryItems: items };
}

function makeAgent(bot: any) {
  return {
    bot,
    actions: {
      runAction: async (_label: string, fn: () => Promise<void>) => {
        await fn();
        return { interrupted: false, timedout: false };
      },
    },
  };
}

describe('铁砧规划', () => {
  it('两件输入（有 output / 没 output）都算加工；损坏的铁砧也算', () => {
    expect(planUseBlock('anvil', true, true).kind).toBe('process');
    expect(planUseBlock('anvil', true, false).kind).toBe('process');
    expect(planUseBlock('chipped_anvil', true, false).kind).toBe('process');
    expect(planUseBlock('damaged_anvil', true, true).kind).toBe('process');
  });

  it('普通加工方块只给 input 仍然明确报错（不是铁砧）', () => {
    expect(planUseBlock('furnace', true, false).kind).toBe('unsupported');
  });
});

describe('useBlock 铁砧合成', () => {
  it('按显示标签选中那本附魔书，放进铁砧并取回产物', async () => {
    const { bot, placed } = makeAnvilBot();
    const mending = bot.inventory.items()[1];
    const sharpBook = bot.inventory.items()[2];
    const text = (await findCommand('!useBlock')?.perform(
      makeAgent(bot),
      'anvil',
      '0,64,0',
      'diamond_sword, enchanted_book[mending 1]',
      'diamond_sword',
    )) as string;
    expect(text).toContain('铁砧产出了 diamond_sword，一共 1 个。');
    expect(text).toContain('铁砧产出了 diamond_sword，一共 1 个。');
    expect(text).toContain('铁砧产出了 diamond_sword，一共 1 个。');
    // 放进去的是 mending 那本，不是 sharpness 那本。
    expect(placed).toContain(mending);
    expect(placed).not.toContain(sharpBook);
  });

  it('标签对不上 → 如实报背包里没有，不拿别的书凑数', async () => {
    const { bot } = makeAnvilBot();
    const text = (await findCommand('!useBlock')?.perform(
      makeAgent(bot),
      'anvil',
      '0,64,0',
      'diamond_sword, enchanted_book[efficiency 1]',
    )) as string;
    expect(text).toContain('背包里没有 enchanted_book[efficiency 1]');
  });

  it('只给一件输入 → 说清铁砧要两件（不是悄悄当合成台用）', async () => {
    const { bot } = makeAnvilBot();
    const text = (await findCommand('!useBlock')?.perform(makeAgent(bot), 'anvil', '0,64,0', 'diamond_sword')) as string;
    expect(text).toContain('需要 2 个输入');
  });
});
