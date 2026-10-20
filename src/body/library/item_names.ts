/**
 * **未知物品 id 要告诉模型"该用什么名字"**（Lead 2026-10-21，A 的 `craft(type="bed")`）：
 * 回执只写"没有 bed 这个物品"没用——注册名是 `white_bed`/`black_bed`…；还莫名拼了
 * 「金装备注册名是 golden_*」这种与请求无关的句子（噪音，且读起来像答非所问）。
 *
 * 另外一条**配方正确性**：床需要 **3 块同色羊毛**。A 有 `white_wool×2 + black_wool×1`，
 * 混色不行——拒绝时要把这个事实说出来，而不是只说"没这个物品"。
 */
import * as mc from '../data/mcdata.js';

/** 名字族后缀 → 该族实际注册名前缀（用于 "没有 X，你是想找这些吗"）。 */
const COLOURS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
const STATIC_FAMILY_IDS: Array<{ suffix: string; ids: string[] }> = [
    { suffix: '_bed', ids: COLOURS.map((colour) => `${colour}_bed`) },
    { suffix: '_wool', ids: COLOURS.map((colour) => `${colour}_wool`) },
    { suffix: '_carpet', ids: COLOURS.map((colour) => `${colour}_carpet`) },
    { suffix: '_banner', ids: COLOURS.map((colour) => `${colour}_banner`) },
    { suffix: '_concrete', ids: COLOURS.map((colour) => `${colour}_concrete`) },
    { suffix: '_planks', ids: WOOD_TYPES.map((wood) => `${wood}_planks`) },
    { suffix: '_sapling', ids: WOOD_TYPES.map((wood) => `${wood}_sapling`) },
];
function suffixFallback(name: string): string | null {
    const direct = FAMILY_SUFFIXES.find((suffix) => name === suffix.replace(/^_/, '') || name.endsWith(suffix));
    if (direct != null) return direct;
    const family = FAMILY_SUFFIXES.find((suffix) => suffix.endsWith(`_${name}`));
    return family ?? null;
}

const FAMILY_SUFFIXES = [
    '_bed', '_wool', '_planks', '_concrete', '_concrete_powder', '_terracotta',
    '_carpet', '_stained_glass', '_stained_glass_pane', '_shulker_box', '_banner',
    '_candle', '_sapling', '_log', '_wood', '_stairs', '_slab', '_fence', '_door',
];

/**
 * 找出 "raw 是某一族的前缀/后部" 的**具体注册名**。
 * 例：`bed` ⇒ white_bed…black_bed（16）；`planks` ⇒ oak_planks…（8）。
 * 找不到就返回 []（不猜）。
 */
export function suggestItemFamilyIds(raw: string, max = 16): string[] {
    const name = String(raw ?? '').trim().toLowerCase().replace(/^minecraft:/, '');
    if (name === '') return [];
    let all: string[] = [];
    try {
        all = ((mc.getAllItems?.() ?? []) as Array<unknown>).map((entry) => {
            if (typeof entry === 'string') return entry;
            const name = (entry as { name?: unknown } | null)?.name;
            return typeof name === 'string' ? name : '';
        }).filter((name) => name !== '');
    } catch {
        all = [];
    }
    if (!Array.isArray(all) || all.length === 0) {
        // mcdata 还没就绪（单元测试/刚启动）：用已知族的静态表兜底，仍然给出具体 id。
        const staticFamily = STATIC_FAMILY_IDS.find((entry) => entry.suffix === suffixFallback(name));
        if (staticFamily != null) return staticFamily.ids.slice(0, max);
        return [];
    }
    const suffixHit = FAMILY_SUFFIXES.find((suffix) => name.endsWith(suffix) || suffix.endsWith(`_${name}`));
    if (suffixHit != null) {
        const hits = all.filter((id) => id.endsWith(suffixHit));
        if (hits.length > 0) return hits.slice(0, max);
    }
    const tail = all.filter((id) => id.endsWith(`_${name}`));
    return tail.slice(0, max);
}

/** 染色配方需要的"同色原料"数量（床 = 3 块同色羊毛）。未知配方返回 null。 */
export function dyedRecipeRequirement(itemName: string): { ingredientSuffix: string; count: number; colourPrefix: string } | null {
    const name = String(itemName ?? '').toLowerCase();
    const bed = /^([a-z_]+)_bed$/.exec(name);
    if (bed != null) return { ingredientSuffix: '_wool', count: 3, colourPrefix: bed[1]! };
    const carpet = /^([a-z_]+)_carpet$/.exec(name);
    if (carpet != null) return { ingredientSuffix: '_wool', count: 2, colourPrefix: carpet[1]! };
    const banner = /^([a-z_]+)_banner$/.exec(name);
    if (banner != null) return { ingredientSuffix: '_wool', count: 6, colourPrefix: banner[1]! };
    const concrete = /^([a-z_]+)_concrete(_powder)?$/.exec(name);
    if (concrete != null) return { ingredientSuffix: '_sand', count: 4, colourPrefix: concrete[1]! };
    return null;
}

/**
 * 给"做不了这个染色物品"的人话：数量 + **同色**要求 + 背包里现在有什么。
 * `countOf(name)` 由调用方提供（读背包）；读不到返回 null 时如实说读不到。
 */
export function describeDyedShortfall(
    itemName: string,
    countOf: (name: string) => number | null,
    inventoryNames: string[],
): string | null {
    const requirement = dyedRecipeRequirement(itemName);
    if (requirement == null) return null;
    const ingredient = `${requirement.colourPrefix}${requirement.ingredientSuffix}`;
    const have = countOf(ingredient);
    if (have != null && have >= requirement.count) return null;
    const carried = inventoryNames.filter((name) => name.endsWith(requirement.ingredientSuffix));
    const carriedText = carried.length > 0 ? `你现在带着 ${carried.join('、')}` : '你现在没带同色原料';
    return (
        `做 ${itemName} 需要 **${requirement.count} 块同色的 ${ingredient}**（` +
        `${requirement.ingredientSuffix.replace('_', '')}混色不行）；${carriedText}` +
        (have == null ? '（数量读不到）' : `，${ingredient} 只有 ${have} 块`) +
        `——再去弄 ${requirement.count - (have ?? 0)} 块**${requirement.colourPrefix}**${requirement.ingredientSuffix}。`
    );
}

/** 未知物品 id 的统一回执（家庭建议 + 只有在明显相关时才提金装备别名）。 */
export function formatUnknownItemReceipt(raw: string): string {
    const name = String(raw ?? '').trim();
    const suggestions = suggestItemFamilyIds(name);
    const family =
        suggestions.length > 0
            ? `你是想找这些吗：${suggestions.join('、')}（共 ${suggestions.length} 种）。`
            : '';
    const golden =
        name.startsWith('gold_') && name !== 'gold_ingot'
            ? `提示：金装备的注册名是 golden_*（如 golden_boots）。`
            : '';
    return (
        `没有 ${name} 这个物品（配方表里也没有）。` +
        family +
        golden +
        '先用 getCraftingPlan / searchWiki 确认注册名，再试。'
    );
}
