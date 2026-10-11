/**
 * 配方家族展开：补上 minecraft-data 丢掉的 **tag** 信息。
 *
 * ## 为什么必须补
 *
 * `minecraft-data` 的 `recipes` 把 `#planks` 这类**标签**解析成了**一个具体物品**：
 *
 *     crafting_table 的 inShape = [[36,36],[36,36]]   // 36 写死是 oak_planks
 *     chest          的 inShape = [[36,...,36],[...]]  // 同样写死
 *
 * 既没有 `delta`、也没有 tags 表（都验证过）。于是"背包里有 4 块桦木板"被判成
 * "没有橡木板"——模型真机上就是这么卡住的：`craftable()` 里没有 crafting_table /
 * chest / shield，`craft("4 birch_planks" → crafting_table)` 直接失败，
 * 而 `input="oak_planks, oak_planks"` 就能做出木棍。它自己把这条定位成
 * "疑似木板只认 oak_planks"，完全正确。
 *
 * 做不出箱子 = 协作的公共仓库搭不起来，所以这条必须修。
 *
 * ## 做法
 *
 * 把配方里出现的**家族代表物品**替换成同家族的其它成员，各复制一份变体。
 * mineflayer 的 `bot.recipesFor` 读的是它自己的 registry，所以在建好 bot 之后
 * 对着 `bot.registry.recipes` 调用这个函数才有效。
 */

/** 会被 minecraft-data 当成标签代表的家族。第一项是它默认选中的那个。 */
const FAMILIES: readonly (readonly string[])[] = [
  [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'cherry_planks', 'dark_oak_planks', 'mangrove_planks', 'bamboo_planks',
    'crimson_planks', 'warped_planks',
  ],
  [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'cherry_log',
    'dark_oak_log', 'mangrove_log',
  ],
  [
    'white_wool', 'orange_wool', 'magenta_wool', 'light_blue_wool', 'yellow_wool',
    'lime_wool', 'pink_wool', 'gray_wool', 'light_gray_wool', 'cyan_wool',
    'purple_wool', 'blue_wool', 'brown_wool', 'green_wool', 'red_wool', 'black_wool',
  ],
];

interface Registry {
  itemsByName?: Record<string, { id?: number } | undefined>;
  recipes?: Record<string, Array<Record<string, unknown>>>;
}

/** 这个 id 属于哪个家族（不属于就返回 null）。 */
function familyOf(id: number, registry: Registry): readonly string[] | null {
  for (const family of FAMILIES) {
    for (const name of family) {
      if (registry.itemsByName?.[name]?.id === id) return family;
    }
  }
  return null;
}

/** 配方里参与合成的所有物品 id（`inShape` 或 `ingredients`）。 */
function ingredientIds(recipe: Record<string, unknown>): number[] {
  const raw = recipe['ingredients'] ?? (recipe['inShape'] as unknown[] | undefined)?.flat?.();
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is number => typeof id === 'number');
}

/**
 * 给 `registry.recipes` 补上家族变体。**幂等**：重复调用不会重复添加。
 *
 * @returns 新增的配方条数（诊断用）。
 */
export function expandTagRecipes(registry: unknown): number {
  const reg = registry as Registry | null | undefined;
  if (reg?.recipes == null || reg.itemsByName == null) return 0;
  const byName = reg.itemsByName;
  const recipes = reg.recipes;
  let added = 0;
  for (const [resultId, list] of Object.entries(recipes)) {
    if (!Array.isArray(list)) continue;
    for (const recipe of [...list]) {
      const ids = ingredientIds(recipe);
      // 每个家族代表各展开一次（只展开第一个出现的，避免组合爆炸）
      for (const family of FAMILIES) {
        const representative = family.find((name) => {
          const id: number | undefined = byName[name]?.id;
          return id != null && ids.includes(id);
        });
        if (representative == null) continue;
        const repId: number | undefined = byName[representative]?.id;
        if (repId == null) continue;
        for (const member of family) {
          if (member === representative) continue;
          const memberId: number | undefined = byName[member]?.id;
          if (memberId == null) continue;
          const clone = JSON.parse(JSON.stringify(recipe)) as Record<string, unknown>;
          if (Array.isArray(clone['ingredients'])) {
            clone['ingredients'] = (clone['ingredients'] as unknown[]).map((v) => (v === repId ? memberId : v));
          }
          if (Array.isArray(clone['inShape'])) {
            clone['inShape'] = (clone['inShape'] as unknown[][]).map((row) =>
              row.map((v) => (v === repId ? memberId : v)),
            );
          }
          list.push(clone);
          added++;
        }
      }
    }
    void resultId;
  }
  return added;
}
