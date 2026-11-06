import { describe, expect, it } from 'vitest';
import {
  componentDataOf,
  enchantParts,
  findInventoryItemByLabel,
  isAnvilBlockName,
  itemDisplayName,
  itemMatchesLabel,
  itemVariantParts,
} from '../src/body/library/item_variants.js';

const registry = {
  enchantmentsArray: [
    { name: 'mending' },
    { name: 'sharpness' },
    { name: 'unbreaking' },
    { name: 'efficiency' },
    { name: 'fortune' },
    { name: 'protection' },
  ],
  effectsArray: [{ name: 'Regeneration' }, { name: 'Speed' }, { name: 'Poison' }],
  instrumentsArray: [{ name: 'harp' }, { name: 'seek_goat_horn' }],
  itemsArray: [{ name: 'arrow' }, { name: 'spectral_arrow' }],
};

function componentMap(entries: Array<[string, any]>): Map<string, any> {
  return new Map(entries.map(([type, data]) => [type, { type, data }]));
}

describe('itemDisplayName：名称相同、靠附加数据区分的东西', () => {
  it('带附魔的装备把附魔列出来（不截断）', () => {
    const sword = {
      name: 'diamond_sword',
      enchants: [
        { name: 'sharpness', lvl: 5 },
        { name: 'unbreaking', lvl: 3 },
        { name: 'mending', lvl: 1 },
      ],
    };
    expect(itemDisplayName(sword, 'diamond_sword')).toBe('diamond_sword[sharpness 5; unbreaking 3; mending 1]');
  });

  it('附魔书读 stored_enchantments 组件（1.20.5+）', () => {
    const book = {
      name: 'enchanted_book',
      componentMap: componentMap([
        ['stored_enchantments', { enchantments: [{ id: 0, level: 1 }] }],
        ['enchantments', undefined],
      ]),
    };
    expect(itemDisplayName(book, 'enchanted_book', registry)).toBe('enchanted_book[mending 1]');
  });

  it('药水按数字注册表 id 换成完整 id（1.20.5+）', () => {
    const slow = { name: 'potion', componentMap: componentMap([['potion_contents', { potionId: 38 }]]) };
    expect(itemDisplayName(slow, 'potion')).toBe('long_slow_falling');
    const splash = { name: 'splash_potion', componentMap: componentMap([['potion_contents', { potionId: 13 }]]) };
    expect(itemDisplayName(splash, 'splash_potion')).toBe('splash_potion:swiftness');
    const unknown = { name: 'potion', componentMap: componentMap([['potion_contents', { potionId: 999 }]]) };
    expect(itemDisplayName(unknown, 'potion')).toBe('potion#999');
  });

  it('旧版 NBT 药水仍然认', () => {
    const potion = { name: 'potion', nbt: { value: { Potion: 'minecraft:strong_healing' } } };
    expect(itemDisplayName(potion, 'potion')).toBe('strong_healing');
  });

  it('药箭带药水效果', () => {
    const arrow = { name: 'tipped_arrow', componentMap: componentMap([['potion_contents', { potionId: 28 }]]) };
    expect(itemDisplayName(arrow, 'tipped_arrow')).toBe('tipped_arrow[poison]');
  });

  it('迷之炖菜带效果和秒数', () => {
    const stew = {
      name: 'suspicious_stew',
      componentMap: componentMap([['suspicious_stew_effects', { effects: [{ id: 0, duration: 120 }] }]]),
    };
    expect(itemDisplayName(stew, 'suspicious_stew', registry)).toBe('suspicious_stew[regeneration 6s]');
  });

  it('山羊角带乐器', () => {
    const horn = { name: 'goat_horn', componentMap: componentMap([['instrument', { instrumentId: 1 }]]) };
    expect(itemDisplayName(horn, 'goat_horn', registry)).toBe('goat_horn[seek_goat_horn]');
  });

  it('烟花带飞行时长', () => {
    const rocket = { name: 'firework_rocket', componentMap: componentMap([['fireworks', { flightDuration: 3 }]]) };
    expect(itemDisplayName(rocket, 'firework_rocket')).toBe('firework_rocket[flight 3]');
  });

  it('装填的弩带弹种', () => {
    const crossbow = {
      name: 'crossbow',
      componentMap: componentMap([['charged_projectiles', { projectiles: [{ name: 'arrow' }] }]]),
    };
    expect(itemDisplayName(crossbow, 'crossbow')).toBe('crossbow[loaded: arrow]');
    const empty = { name: 'crossbow', componentMap: componentMap([['charged_projectiles', { projectiles: [] }]]) };
    expect(itemDisplayName(empty, 'crossbow')).toBe('crossbow');
  });

  it('地图带编号', () => {
    const map = { name: 'filled_map', componentMap: componentMap([['map_id', 12]]) };
    expect(itemDisplayName(map, 'filled_map')).toBe('filled_map[map 12]');
  });

  it('读不到附加数据就退回裸名（不猜）', () => {
    expect(itemDisplayName({ name: 'diamond_sword' }, 'diamond_sword')).toBe('diamond_sword');
    expect(itemVariantParts({ name: 'stone' })).toEqual([]);
    expect(componentDataOf({ name: 'stone' }, 'enchantments')).toBeNull();
  });
});

describe('按显示标签找回具体一件', () => {
  const sword = { name: 'diamond_sword', enchants: [{ name: 'sharpness', lvl: 5 }], slot: 9 };
  const plain = { name: 'diamond_sword', slot: 10 };
  const mending = {
    name: 'enchanted_book',
    slot: 11,
    componentMap: componentMap([['stored_enchantments', { enchantments: [{ id: 0, level: 1 }] }]]),
  };
  const sharpBook = {
    name: 'enchanted_book',
    slot: 12,
    componentMap: componentMap([['stored_enchantments', { enchantments: [{ id: 1, level: 5 }] }]]),
  };
  const bot = { inventory: { items: () => [sword, plain, mending, sharpBook] } };

  it('带方括号的标签必须逐字匹配，变体不同不会误选', () => {
    expect(findInventoryItemByLabel(bot, 'diamond_sword[sharpness 5]', registry)).toBe(sword);
    expect(findInventoryItemByLabel(bot, 'enchanted_book[sharpness 5]', registry)).toBe(sharpBook);
    expect(findInventoryItemByLabel(bot, 'enchanted_book[mending 1]', registry)).toBe(mending);
    expect(findInventoryItemByLabel(bot, 'enchanted_book[efficiency 1]', registry)).toBeNull();
  });

  it('裸名字仍按物品名匹配（有就拿来用）', () => {
    expect(findInventoryItemByLabel(bot, 'diamond_sword', registry)).toBe(sword);
    expect(findInventoryItemByLabel(bot, 'long_slow_falling', registry)).toBeNull();
  });

  it('标签匹配不依赖逗号（多条变体用分号分隔）', () => {
    expect(itemMatchesLabel(sword, 'diamond_sword[sharpness 5]', registry)).toBe(true);
    expect(itemMatchesLabel(sword, 'diamond_sword[unbreaking 3]', registry)).toBe(false);
  });
});

describe('铁砧方块名', () => {
  it('普通/轻微损坏/严重损坏都算', () => {
    expect(isAnvilBlockName('anvil')).toBe(true);
    expect(isAnvilBlockName('chipped_anvil')).toBe(true);
    expect(isAnvilBlockName('damaged_anvil')).toBe(true);
    expect(isAnvilBlockName('furnace')).toBe(false);
  });
});
