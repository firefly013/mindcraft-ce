/*
 * 存/丢之后背包变化的**事实回执**。
 *
 * 这里只陈述实测变化（减少了什么、可放置方块还剩几个、食物还有没有），
 * 不写"该留什么""建议怎么腾格子"这类策略。
 */

/** 可放置方块低于这个数时，把剩余数量写进回执（事实门槛，不做劝告）。 */
export const PLACEABLE_KEEP_MIN = 32;

/** "可以存"的廉价方块（只用于区分垃圾与装备，回执不渲染这个清单）。 */
export const JUNK_BLOCKS: ReadonlySet<string> = new Set([
  'stone',
  'dirt',
  'sand',
  'red_sand',
  'gravel',
  'granite',
  'diorite',
  'andesite',
  'netherrack',
  'tuff',
  'deepslate',
  'cobbled_deepslate',
  'blackstone',
  'basalt',
  'sandstone',
  'clay',
  'flint',
  'rotten_flesh',
  'bone',
  'string',
  'feather',
  'wheat_seeds',
  'beetroot_seeds',
  'melon_seeds',
  'pumpkin_seeds',
  'poppy',
  'dandelion',
  'stick',
]);

/** 装备类判定：用来回答"这次是不是把最后一类装备清空了"。 */
const KEEP_MATCHERS: ReadonlyArray<(name: string) => boolean> = [
  (n) => n.endsWith('_pickaxe'),
  (n) => n.endsWith('_sword'),
  (n) => n === 'shield',
  (n) => n.endsWith('_axe'),
  (n) => n.endsWith('_shovel'),
  (n) => n === 'torch' || n === 'soul_torch',
  (n) => n === 'flint_and_steel',
  (n) => /_(helmet|chestplate|leggings|boots)$/.test(n),
];

export interface InventoryCounts {
  [name: string]: number;
}

export interface InventoryLossAdviceInput {
  /** 存之前 / 之后的**全背包**账目（物品名 → 数量）。 */
  before: InventoryCounts;
  after: InventoryCounts;
  /** 保留字段：回执不区分"存"与"丢"，只报背包变化。 */
  action?: 'deposit' | 'discard';
  /** 是不是食物（由调用方注入，避免共享层依赖身体数据）。 */
  isFood?: (name: string) => boolean;
  /** 是不是可放置的整方块（同上）。 */
  isPlaceable?: (name: string) => boolean;
}

export type InventoryLossAdviceLevel = 'none' | 'warn' | 'loud';

export interface InventoryLossAdvice {
  level: InventoryLossAdviceLevel;
  /** 直接追加到回执里的文本；level === 'none' 时为空串。 */
  text: string;
}

function totalItems(counts: InventoryCounts): number {
  let total = 0;
  for (const count of Object.values(counts)) {
    if (Number.isFinite(count) && count > 0) total += count;
  }
  return total;
}

function foodCount(counts: InventoryCounts, isFood: (name: string) => boolean): number {
  let total = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (count > 0 && isFood(name)) total += count;
  }
  return total;
}

function placeableCount(counts: InventoryCounts, isPlaceable: (name: string) => boolean): number {
  let total = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (count > 0 && isPlaceable(name)) total += count;
  }
  return total;
}

/**
 * 这次"把东西弄出背包"之后，背包发生了什么变化。
 *
 * 只返回事实：
 * - `背包减少：名称×数量、…`（所有实测减少的物品，最多列 8 项）；
 * - `食物 N 个`（只有降到 0 时才写进 loss 文案的触发条件里）；
 * - `可放置方块 N 个`（低于 `PLACEABLE_KEEP_MIN` 时才报）。
 *
 * `level` 仍然按"丢掉的严重程度"分档，供调用方决定是否输出；文案不随档位变化。
 */
export function inventoryLossAdvice(input: InventoryLossAdviceInput): InventoryLossAdvice {
  const before = input.before ?? {};
  const after = input.after ?? {};
  const isFood = input.isFood ?? ((): boolean => false);
  const isPlaceable = input.isPlaceable ?? ((): boolean => false);

  const decreased: string[] = [];
  for (const [name, rawBefore] of Object.entries(before)) {
    const b = Number(rawBefore);
    const a = Number(after[name] ?? 0);
    const delta = Number.isFinite(b) && Number.isFinite(a) ? Math.max(0, b - a) : 0;
    if (delta > 0) decreased.push(`${name} ${delta} 个`);
  }

  const foodBefore = foodCount(before, isFood);
  const foodAfter = foodCount(after, isFood);
  const foodGone = foodBefore > 0 && foodAfter === 0;
  const placeableAfter = placeableCount(after, isPlaceable);
  const placeableShort = placeableAfter < PLACEABLE_KEEP_MIN;

  // 只有"装备/食物/垫脚方块"的减少才值得说；单纯存掉石头/泥土保持沉默。
  const keepLost = decreased.some((entry) =>
    KEEP_MATCHERS.some((match) => match(entry.replace(/ \d+ 个$/, ''))) || isFood(entry.replace(/ \d+ 个$/, '')),
  );
  if (!keepLost && !foodGone && !placeableShort) {
    return { level: 'none', text: '' };
  }

  const namesAfter = Object.entries(after)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);
  const toolGone = namesAfter.every((name) => !KEEP_MATCHERS.some((match) => match(name)));
  const packEmpty = totalItems(after) === 0;
  const loud = foodGone && (packEmpty || (toolGone && placeableShort));

  const facts: string[] = [];
  if (decreased.length > 0) facts.push(`背包里少了${decreased.slice(0, 8).join('，')}`);
  if (foodGone) facts.push('食物已经没有了');
  if (placeableShort) facts.push(`可放置的方块还剩 ${placeableAfter} 个`);

  return { level: loud ? 'loud' : 'warn', text: `${facts.join('，')}。` };
}

export default { inventoryLossAdvice, PLACEABLE_KEEP_MIN, JUNK_BLOCKS };
