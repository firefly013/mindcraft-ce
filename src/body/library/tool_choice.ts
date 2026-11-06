/**
 * **工具选择的唯一决策函数**。
 *
 * ## 便宜优先（用户 2026-10-28 定稿）
 *
 * 快断的镐不是坏工具，是**便宜工具**——**先用它，断了再换下一把**。
 * 耐久**不参与筛选**：拿"这活要约几次耐久"去挡，是在替模型判断"值不值得冒断的风险"，
 * 而且那个数本来就是我们猜的（挖一格≈1 次耐久，实际还看方块/附魔/工具）。
 *
 * ## 附魔工具保护（用户 2026-11-01 追加）
 *
 * 有附魔的工具是**资产**，不能当耗材：用到**安全线**就停手，留一点耐久
 * （修/再附魔都还来得及）。所以自动选择里：
 *   - 附魔工具剩余耐久到线（≤ 20 次或 < 15%）⇒ **不参与自动选择**（`isToolProtected`）；
 *   - 未附魔工具**照旧用到爆**（便宜优先规则不变）；
 *   - 附魔工具被禁用时**自动换下一把可用工具**（`chooseToolForJob` 选下一个候选，
 *     `ensureHarvestTool` 换手）；换不到就如实说"保护了、不会自动用"，不硬来。
 *
 * 规则：
 *   candidates = 档位达标 且 **没被保护线禁用**
 *   choice     = 其中最**便宜**的（档位最低 → 剩余耐久最少）
 * 没有候选：档位不够 ⇒ "档位不够"；都被本次排除过 ⇒ "在互相让位"；
 *           都被保护线禁用 ⇒ "附魔工具已保护"。
 * `excluded` = 本动作里被安全门拒绝过的工具（不许选回，否则结构性震荡）。
 */
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword';
export type ToolTier = 'netherite' | 'diamond' | 'iron' | 'stone' | 'golden' | 'wooden';

export interface ToolCandidate {
    name?: unknown;
    count?: unknown;
    maxDurability?: unknown;
    durability?: unknown;
    durabilityUsed?: unknown;
    /** prismarine-item 的附魔表（`{name, lvl}[]`）；没有/读不到 = 空。 */
    enchants?: unknown;
}

/**
 * 附魔工具的**保护线**：剩余可用次数 ≤ 20，或剩余比例 < 15%，就算"到线"。
 *
 * 与技能层"低耐久安全线"是同一条线（那边只用来提醒，这边对附魔工具是硬禁用）。
 * 留这点耐久是为了"还能修/再附魔"，不是为了让模型继续拿它冒险。
 */
export const ENCHANTED_RESERVE_USES = 20;
export const ENCHANTED_RESERVE_FRACTION = 0.15;

const TIER_ORDER: ToolTier[] = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

export function toolRemainingUses(item: ToolCandidate): number | null {
    const max = Number(item?.maxDurability);
    const used = Number(item?.durabilityUsed);
    const remaining = Number(item?.durability);
    if (Number.isFinite(max) && Number.isFinite(used) && max > 0) return Math.max(0, max - used);
    if (Number.isFinite(remaining) && remaining >= 0) return remaining;
    return null;
}

/** 耐久上限（**<=1 视为读不到**：Fabric/模组注册表下真机报过 `max=1`）。 */
function toolMaxDurability(item: ToolCandidate): number | null {
    const max = Number(item?.maxDurability);
    return Number.isFinite(max) && max > 1 ? max : null;
}

/**
 * 这件物品有没有附魔。`item.enchants` 是 prismarine-item 的 getter，**可能抛**
 * （不认识的版本），所以一律吞掉异常当作"没附魔"——不能因为读不出附魔就把工具锁死。
 */
export function hasEnchantment(item: ToolCandidate | null | undefined): boolean {
    try {
        const enchants = (item as { enchants?: unknown } | null | undefined)?.enchants;
        return Array.isArray(enchants) && enchants.length > 0;
    } catch {
        return false;
    }
}

/**
 * 这件工具是否**被保护线禁用**（只对附魔工具生效）。
 *
 * 读不到耐久 ⇒ 不保护（不能因为测不出就排除可用工具；与"读不到耐久不排除"同一条原则）。
 */
export function isToolProtected(item: ToolCandidate | null | undefined): boolean {
    if (!hasEnchantment(item)) return false;
    const remaining = toolRemainingUses(item ?? {});
    if (remaining == null) return false;
    if (remaining <= ENCHANTED_RESERVE_USES) return true;
    const max = toolMaxDurability(item ?? {});
    return max != null && remaining / max < ENCHANTED_RESERVE_FRACTION;
}

function tierOf(name: string): number {
    const index = TIER_ORDER.findIndex((prefix) => name.startsWith(prefix));
    return index < 0 ? TIER_ORDER.length : index;
}

export type ToolChoiceFailure = 'no-tool' | 'tier-too-low' | 'excluded-oscillation' | 'reserve-protected';

export interface ToolChoice {
    name: string | null;
    remaining: number | null;
    tier: ToolTier | null;
    failure: ToolChoiceFailure | null;
    /** 回执：说清"用哪个、为什么"。 */
    message: string;
}

/**
 * 为一件具体的活选工具。**不看耐久够不够**（未附魔工具不够也先用着，断了由执行层换）；
 * 但**附魔工具到保护线就不参与选择**——那是资产，不是耗材。
 * 读不到耐久的工具当作"无所谓"（不能因为测不出就排除可用工具）。
 */
export function chooseToolForJob(input: {
    tools: ToolCandidate[];
    kind?: ToolKind;
    minimumTier?: ToolTier;
    excluded?: string[];
}): ToolChoice {
    const kind = input.kind ?? 'pickaxe';
    const minimumTier = input.minimumTier ?? 'wooden';
    const excluded = new Set(input.excluded ?? []);
    const minimumIndex = TIER_ORDER.indexOf(minimumTier);
    const tools = input.tools
        .filter((item) => typeof item?.name === 'string' && String(item.name).includes(kind))
        .filter((item) => (typeof item.count === 'number' ? item.count : 0) > 0)
        .map((item) => ({
            name: String(item.name),
            remaining: toolRemainingUses(item),
            tierIndex: tierOf(String(item.name)),
            enchanted: hasEnchantment(item),
            protected: isToolProtected(item),
        }));
    if (tools.length === 0) {
        return { name: null, remaining: null, tier: null, failure: 'no-tool', message: `背包里没有 ${kind}。` };
    }
    const tierOk = tools.filter((tool) => tool.tierIndex <= minimumIndex);
    if (tierOk.length === 0) {
        return {
            name: null,
            remaining: null,
            tier: null,
            failure: 'tier-too-low',
            message: `背包里没有可用的 ${kind}，这个动作至少需要 ${minimumTier} 级别的。`,
        };
    }
    // **附魔工具到保护线：不参与自动选择**（用户 2026-11-01）。
    // 未附魔工具不受影响——它们照旧"便宜优先、用到爆"。
    const usable = tierOk.filter((tool) => !tool.protected);
    if (usable.length === 0) {
        const names = [...new Set(tierOk.map((tool) => `${tool.name}（${tool.remaining == null ? '耐久读不到' : `剩 ${tool.remaining} 次`}）`))].join('、');
        return {
            name: null,
            remaining: null,
            tier: null,
            failure: 'reserve-protected',
            message:
                `没有可用的 ${kind}：${names} 已到附魔保护线（≤ ${ENCHANTED_RESERVE_USES} 次或 < ${Math.round(ENCHANTED_RESERVE_FRACTION * 100)}% 耐久）。`,
        };
    }
    // **本动作里被拒绝过的工具不许再选回**
    const available = usable.filter((tool) => !excluded.has(tool.name));
    if (available.length === 0) {
        const names = [...new Set(tierOk.map((tool) => tool.name))].join('、');
        return {
            name: null,
            remaining: null,
            tier: null,
            failure: 'excluded-oscillation',
            message: `没有可用的 ${kind}，${names} 都被这次动作排除过了。`,
        };
    }
    // **便宜优先**：档位最低，然后剩余耐久最少——先把它用掉，断了再换下一把。
    available.sort((a, b) => (b.tierIndex !== a.tierIndex ? b.tierIndex - a.tierIndex : (a.remaining ?? 0) - (b.remaining ?? 0)));
    const chosen = available[0];
    if (chosen == null) {
        // 上面 `usable.length === 0` 已经返回过；这里只是让类型收窄（不变量：至少一把）。
        return { name: null, remaining: null, tier: null, failure: 'no-tool', message: `背包里没有 ${kind}。` };
    }
    const tierName = TIER_ORDER[chosen.tierIndex] ?? '';
    return {
        name: chosen.name,
        remaining: chosen.remaining,
        tier: (tierName as ToolTier) ?? null,
        failure: null,
        message: `用 ${chosen.name}` + (chosen.remaining != null ? `（耐久 ${chosen.remaining}）` : ''),
    };
}
