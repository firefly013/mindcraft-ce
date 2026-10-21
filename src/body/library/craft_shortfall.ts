import { getItemCraftingRecipes } from '../data/mcdata.js';



/**
 * **"我还差什么"计算器**（Lead 2026-10-21：同一个模式今晚出现 4 次——机器人有全部材料，
 * 只差一件基础物品，引擎从不说清是哪一件）。模型记不住 40 格背包；引擎能精确算。
 *
 * 原则（用户两次纠正过）：**不是门**。只在失败/询问计划时把算术写进回执，
 * 给"缺什么、差多少、下一步一个动作"，绝不阻止模型行动、不新增"你必须做 X"规则。
 */
export interface RecipeEntry {
    /** 每个配方的原料：原料名 → 数量。 */
    ingredients: Record<string, number>;

    /** 这个配方产出几个。 */
    craftedCount: number;
}

export type RecipeResolver = (itemName: string) => RecipeEntry[] | null;

export interface Shortfall {
    item: string;
    need: number;
    have: number;
}

export interface ShortfallPlan {

/** 目标本身是否已经够（不需要任何提示）。 */
    satisfied: boolean;

/** 缺的物品（按递归展开后的**基础/中间物品**列出）。 */
    missing: Shortfall[];

/** 一句话结论（含数量与一个下一步动作）；satisfied 时为空串。 */
    text: string;

/** 无法判断（配方未知）时为 true——**不许猜**。 */
    unknown: boolean;
}


/** 需要工作台的物品（3×3 配方；工作台/熔炉本身也是 3×3）。 */
const NEEDS_TABLE = new Set([
    'crafting_table', 'furnace', 'chest', 'barrel', 'blast_furnace', 'smoker', 'anvil',
    'shield', 'bow', 'crossbow', 'fishing_rod', 'flint_and_steel', 'shears', 'bucket',
    'iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_hoe', 'iron_sword', 'iron_helmet',
    'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_pickaxe', 'diamond_axe',
    'diamond_shovel', 'diamond_hoe', 'diamond_sword', 'diamond_helmet', 'diamond_chestplate',
    'diamond_leggings', 'diamond_boots', 'golden_pickaxe', 'stone_pickaxe', 'stone_axe',
]);

export function requiresCraftingTable(itemName: string): boolean {
    const name = String(itemName ?? '').toLowerCase();
    return NEEDS_TABLE.has(name);
}


/** 标签族（#planks 等）→ 具体代表名；背包里有该族成员时优先用实际的。 */
const FAMILY_SAMPLES: Record<string, string> = {
    planks: 'oak_planks',
    logs: 'oak_log',
    logs_that_burn: 'oak_log',
    wooden_slabs: 'oak_slab',
    stone_crafting_materials: 'cobblestone',
};

function countOf(inventory: Record<string, number>, name: string): number {
    return Number(inventory[name] ?? 0);
}


/**
 * 递归计算目标 itemName × count 的缺口。`stationAvailable` 表示工作台是否可用
 * （手上/附近）。深度上限默认 4（planks←logs 这类链够用），超过就说"算不到那么深"。
 */
export function planCraftShortfall(input: {
    itemName: string;
    count?: number;
    inventory: Record<string, number>;
    resolveRecipe: RecipeResolver;
    stationAvailable?: boolean;
    maxDepth?: number;
}): ShortfallPlan {
    const target = String(input.itemName ?? '').toLowerCase();
    const want = Math.max(1, Math.floor(input.count ?? 1));
    const inventory = input.inventory ?? {};
    const maxDepth = Math.min(6, Math.max(1, input.maxDepth ?? 4));
    const missing: Shortfall[] = [];
    const seen = new Set<string>();
    let unknown = false;

    const addMissing = (item: string, need: number, have: number): void => {
        const existing = missing.find((entry) => entry.item === item);
        if (existing != null) {
            existing.need = Math.max(existing.need, need);
            existing.have = Math.max(existing.have, have);
        } else {
            missing.push({ item, need, have });
        }
    };

    const explain = (item: string, need: number, depth: number): void => {
        const have = countOf(inventory, item);
        if (have >= need) return;
        if (seen.has(item) || depth >= maxDepth) {
            addMissing(item, need, have);
            return;
        }
        seen.add(item);
        const recipes = input.resolveRecipe(item);
        if (recipes == null || recipes.length === 0) {
            // 没有配方（它是基础材料）⇒ 就报"差这个基础物品"。
            addMissing(item, need, have);
            seen.delete(item);
            return;
        }
        // 先判断这一层能否直接补齐：原料都够 ⇒ 不算缺口（能现场做出来）。
        const recipe = recipes[0]!;
        const craftsNeeded = Math.max(1, Math.ceil((need - have) / Math.max(1, recipe.craftedCount)));
        const shortages: Array<{ name: string; need: number }> = [];
        for (const [ingredient, perCraft] of Object.entries(recipe.ingredients ?? {})) {
            const rawIngredient = String(ingredient);
            const isTag = rawIngredient.startsWith('#');
            const family = rawIngredient.replace(/^#/, '');
            // 标签族（#planks）→ 优先用背包里实际有的族成员，否则用代表名。
            let ingredientName = family;
            if (isTag) {
                const familyMembers = Object.keys(inventory).filter(
                    (name) => name.endsWith(`_${family}`) || name === family,
                );
                const concrete = familyMembers.sort((a, b) => countOf(inventory, b) - countOf(inventory, a))[0];
                ingredientName = concrete ?? FAMILY_SAMPLES[family] ?? family;
            }
            const ingredientNeed = Math.max(1, Math.ceil(Number(perCraft) || 1)) * craftsNeeded;
            if (countOf(inventory, ingredientName) < ingredientNeed) {
                shortages.push({ name: ingredientName, need: ingredientNeed });
            }
        }
        if (shortages.length === 0) {
            seen.delete(item);
            return;
        }
        // 先看原料能不能只靠**更底层**的缺口解释：如果原料本身都齐（可现场合成），
        // 这个中间物品不算缺口（例如 2 块木板就够做 4 根木棍）。
        const before = missing.length;
        for (const shortage of shortages) explain(shortage.name, shortage.need, depth + 1);
        if (missing.length === before) {
            seen.delete(item);
            return;
        }
        // **中间物品也要点名**（"差的是工作台：你有 1 块木板，需要 4 块 → 先砍 1 个原木"）。
        addMissing(item, need, have);
        seen.delete(item);
    };

    explain(target, want, 0);
    // 工作台本身也要算：目标需要 3×3 且当前不可用 ⇒ 缺 crafting_table（再递归它的料）。
    if (requiresCraftingTable(target) && input.stationAvailable === false) {
        // 工作台不在手上 ⇒ 这是**要坐下来的那件东西**，无论木板够不够都点名。
        addMissing('crafting_table', 1, countOf(inventory, 'crafting_table'));
        explain('crafting_table', 1, 0);
    }
    // 去重并排序（基础物品在前由递归顺序天然保证）。
    const deduped: Shortfall[] = [];
    for (const entry of missing) {
        const existing = deduped.find((item) => item.item === entry.item);
        if (existing == null) deduped.push({ ...entry });
        else existing.need = Math.max(existing.need, entry.need);
    }
    if (deduped.length === 0) {
        return { satisfied: true, missing: [], text: '', unknown: false };
    }
    if (unknown) {
        return { satisfied: false, missing: deduped, text: '算不出来：配方数据里没有这个物品的做法。', unknown: true };
    }
    const parts = deduped.map((entry) => {
        const have = Math.max(0, Math.floor(entry.have));
        return `${entry.item} 需要 ${entry.need} 个，你有 ${have} 个（差 ${Math.max(0, entry.need - have)}）`;
    });
    return {
        satisfied: false,
        missing: deduped,
        text: `差的是：${parts.join('；')}。`,
        unknown: false,
    };
}

// ─────────────────────────── 接线：从 bot 背包 + minecraft-data 计算 ───────────────────────────


/** 把 bot 背包摊成 name→count（读不到返回空表，不猜）。 */
export function botInventoryCounts(bot: unknown): Record<string, number> {
    const counts: Record<string, number> = {};
    try {
        const items = (bot as { inventory?: { items?: () => Array<{ name?: unknown; count?: unknown }> } })?.inventory?.items?.() ?? [];
        for (const item of items) {
            const name = String(item?.name ?? '');
            if (name === '') continue;
            counts[name] = (counts[name] ?? 0) + Number(item?.count ?? 0);
        }
    } catch {
        return {};
    }
    return counts;
}


/** 用 minecraft-data 的配方表解析配方；没有数据/未知物品返回 null（不猜）。 */
export function mcShortfallResolver(itemName: string): RecipeEntry[] | null {
    try {
        const list = getItemCraftingRecipes(itemName);
        if (list == null || list.length === 0) return null;
        return list.map((entry) => ({
            ingredients: entry[0] as Record<string, number>,
            craftedCount: Number(entry[1]?.craftedCount ?? 1) || 1,
        }));
    } catch {
        return null;
    }
}


/** 一句话缺口（只在失败时调用；已满足/算不出返回空串，避免噪音）。 */
export function describeCraftShortfallForBot(bot: unknown, itemName: string, count = 1): string {
    try {
        const inventory = botInventoryCounts(bot);
        const stationAvailable = Number(inventory['crafting_table'] ?? 0) > 0;
        const plan = planCraftShortfall({
            itemName,
            count,
            inventory,
            resolveRecipe: mcShortfallResolver,
            stationAvailable,
        });
        if (plan.satisfied) return '';
        return `缺什么：${plan.text}`;
    } catch {
        return '';
    }
}
