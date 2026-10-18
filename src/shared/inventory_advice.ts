/*
 * 存箱子前的**保命清单提醒**。
 *
 * 真机 2026-10-18 19:20（overnight_a）：出发去给饿着的队友找食物之前"整理背包"，
 * 回来时背包**全空**（`Backpack (free 36): empty`、`Held: main empty`）——
 * 镐、剑、食物、垫脚方块全存进箱子了。它自己后来说"这样出门没用"，
 * 而队友 food 0 在原地等一场**出发不了**的救援。
 *
 * 这一层只做一件事：**在那个决定发生的回执里**把后果说清楚。不是拒绝、不是拦住，
 * 也不替模型做决定——工具不该跟用户对着干，但必须让"我把镐存了"这件事
 * 在按下按钮的那一刻就看得见。
 *
 * 纯逻辑：只吃两份背包账目（物品名 → 数量）+ 两个判断回调（是不是食物、
 * 是不是可放置方块），不 import 身体实现，方便单测。
 */

/** 至少要留多少个可放置方块（垫脚/搭桥/堵岩浆）。 */
export const PLACEABLE_KEEP_MIN = 32;

/** "可以存"的廉价方块（真机上模型清理背包时囤的就是这些）。 */
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

/** 该留着的"装备类"：名字后缀 → 丢光之后的后果。 */
const KEEP_RULES: ReadonlyArray<{
  label: string;
  match: (name: string) => boolean;
  why: string;
}> = [
  { label: '镐', match: (n) => n.endsWith('_pickaxe'), why: '你就**挖不动**了' },
  { label: '剑', match: (n) => n.endsWith('_sword'), why: '你就**没法自卫**了' },
  { label: '盾', match: (n) => n === 'shield', why: '你**挡不住攻击**了' },
  { label: '斧', match: (n) => n.endsWith('_axe'), why: '你**砍不了树/打不了怪**了' },
  { label: '锹', match: (n) => n.endsWith('_shovel'), why: '你**挖土/沙子变慢**了' },
  { label: '火把', match: (n) => n === 'torch' || n === 'soul_torch', why: '你就**看不见路**了（洞里/下界全靠它）' },
  { label: '打火石', match: (n) => n === 'flint_and_steel', why: '你**开不了下界门**' },
  {
    label: '护甲',
    match: (n) => /_(helmet|chestplate|leggings|boots)$/.test(n),
    why: '你**少一层保护**',
  },
];

export interface InventoryCounts {
  [name: string]: number;
}

export interface InventoryLossAdviceInput {
  /** 存之前 / 之后的**全背包**账目（物品名 → 数量）。 */
  before: InventoryCounts;
  after: InventoryCounts;
  /** 这些东西是**存进箱子**还是**丢在地上**；只影响措辞。 */
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

function hasFood(counts: InventoryCounts, isFood: (name: string) => boolean): boolean {
  return Object.entries(counts).some(([name, count]) => count > 0 && isFood(name));
}

function placeableCount(counts: InventoryCounts, isPlaceable: (name: string) => boolean): number {
  let total = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (count > 0 && isPlaceable(name)) total += count;
  }
  return total;
}

function namesOf(counts: InventoryCounts): string[] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name]) => name);
}

/**
 * 这次"把东西弄出背包"该不该提醒、提醒什么。
 *
 * 存进箱子和**丢掉**是同一个决定的两个版本（都是为了腾格子），所以同一个函数
 * 服务两条路：`action` 只影响措辞（存进去 vs 丢出去）。
 *
 * 规则（对齐真机需求）：
 *   - `loud`：弄完**没有食物**，而且工具/垫脚方块也基本没了（背包被清空）——
 *     这就是 19:20 那次事故；
 *   - `warn`：把某类"最后一件"存没了（最后一把镐/剑/盾/火把/打火石/护甲、
 *     最后的食物、或可放置方块掉到 32 以下）；
 *   - `none`：只存了石头/泥土这类垃圾，且该留的都还在——不唠叨。
 */
export function inventoryLossAdvice(input: InventoryLossAdviceInput): InventoryLossAdvice {
  const before = input.before ?? {};
  const after = input.after ?? {};
  const isFood = input.isFood ?? ((): boolean => false);
  const isPlaceable = input.isPlaceable ?? ((): boolean => false);
  const deposit = (input.action ?? 'deposit') === 'deposit';
  // 措辞：存进去还能取回来，丢出去就没了——后果不一样，话就不一样。
  const verb = deposit ? '存进去' : '丢掉';
  const doneVerb = deposit ? '存完' : '丢完';
  const remedy = deposit ? '先取回来再出门' : '捡不回来了（除非还记得丢在哪）';

  const lost: Array<{ name: string; label: string; why: string }> = [];
  for (const rule of KEEP_RULES) {
    const hadBefore = namesOf(before).filter(rule.match);
    if (hadBefore.length === 0) continue;
    const stillHas = namesOf(after).filter(rule.match);
    if (stillHas.length > 0) continue;
    // 这一类的最后一件被存走了：点名具体是哪一件（可能多件一起没）。
    for (const name of hadBefore) lost.push({ name, label: rule.label, why: rule.why });
  }

  const foodBefore = hasFood(before, isFood);
  const foodAfter = hasFood(after, isFood);
  const foodGone = foodBefore && !foodAfter;
  const placeableAfter = placeableCount(after, isPlaceable);
  const placeableShort = placeableAfter < PLACEABLE_KEEP_MIN;
  const toolGone = namesOf(after).every((name) => !KEEP_RULES.some((rule) => rule.match(name)));
  const packEmpty = totalItems(after) === 0;

  // 事前就该闭嘴的情况：什么都没丢、食物还在、垫脚方块够。
  if (lost.length === 0 && !foodGone && !placeableShort) return { level: 'none', text: '' };

  const parts: string[] = [];
  const loud = foodGone && (packEmpty || (toolGone && placeableShort));
  if (loud) {
    parts.push(
      `⚠️⚠️ **这次${doneVerb}你既没有食物、也没有工具/垫脚方块**——真机上就是这么把自己清空、` +
        '然后饿着出门的（队友还在原地等一场出发不了的救援）。',
    );
  }

  if (lost.length > 0) {
    const head = lost
      .map((item) => `${item.name}（${item.label}）`)
      .join('、');
    parts.push(
      `⚠️ 这次${verb}的有你的最后${lost.length > 1 ? '几件' : '一件'}：${head}——${doneVerb}${lost[0]?.why ?? ''}。` +
        (deposit ? '建议留着，先把石头/泥土这类丢掉腾格子。' : '要腾格子就丢石头/泥土这类，别丢保命的。'),
    );
  }
  if (foodGone) {
    parts.push(`⚠️ ${doneVerb}背包里**没有吃的了**：饿了就只能等下一位队友，或者${remedy}。`);
  }
  if (placeableShort) {
    parts.push(
      `⚠️ ${doneVerb}可放置方块只剩 ${placeableAfter} 个（少于 ${PLACEABLE_KEEP_MIN} 个）：` +
        '垫脚、搭桥、堵岩浆都要用，出门前留够。',
    );
  }

  parts.push(
    `留着的（别${verb === '丢掉' ? '丢' : '存'}）：工具/武器/护甲、火把、食物、打火石，以及**至少 ` +
      PLACEABLE_KEEP_MIN +
      ' 个可放置方块**；可以' + (deposit ? '存' : '丢') + '的：石头/泥土/沙/沙砾/花岗岩/闪长岩/安山岩/下界岩这类。',
  );

  return { level: loud ? 'loud' : 'warn', text: parts.join('\n    ') };
}

export default { inventoryLossAdvice, PLACEABLE_KEEP_MIN, JUNK_BLOCKS };
