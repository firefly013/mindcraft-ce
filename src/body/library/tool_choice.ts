/**
 * **工具选择的唯一决策函数**（用户 2026-10-28 定稿；推翻了"会半途断掉就拒"那版）：
 *
 * 快断的镐不是坏工具，是**便宜工具**——**先用它，断了再换下一把**。
 * 耐久**不参与筛选**：拿"这活要约几次耐久"去挡，是在替模型判断"值不值得冒断的风险"，
 * 而且那个数本来就是我们猜的（挖一格≈1 次耐久，实际还看方块/附魔/工具）。
 *
 * 规则：
 *   candidates = 档位达标（够不够挖这类方块）
 *   choice     = 其中最**便宜**的（档位最低 → 剩余耐久最少）
 * 没有候选：档位不够 ⇒ "档位不够"；都被本次排除过 ⇒ "在互相让位"。
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
}

const TIER_ORDER: ToolTier[] = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

export function toolRemainingUses(item: ToolCandidate): number | null {
    const max = Number(item?.maxDurability);
    const used = Number(item?.durabilityUsed);
    const remaining = Number(item?.durability);
    if (Number.isFinite(max) && Number.isFinite(used) && max > 0) return Math.max(0, max - used);
    if (Number.isFinite(remaining) && remaining >= 0) return remaining;
    return null;
}

function tierOf(name: string): number {
    const index = TIER_ORDER.findIndex((prefix) => name.startsWith(prefix));
    return index < 0 ? TIER_ORDER.length : index;
}

export type ToolChoiceFailure = 'no-tool' | 'tier-too-low' | 'excluded-oscillation';

export interface ToolChoice {
    name: string | null;
    remaining: number | null;
    tier: ToolTier | null;
    failure: ToolChoiceFailure | null;
    /** 回执：说清"用哪个、为什么"。 */
    message: string;
}

/**
 * 为一件具体的活选工具。**不看耐久够不够**——不够也先用着，断了由执行层换下一把
 * （`digWithTimeout` 断了会 `ensureHarvestTool` 再补一次）。
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
            message: `档位不够：这活至少需要 ${minimumTier} 的 ${kind}，背包里的都不够。`,
        };
    }
    // **本动作里被拒绝过的工具不许再选回**
    const available = tierOk.filter((tool) => !excluded.has(tool.name));
    if (available.length === 0) {
        const names = [...new Set(tierOk.map((tool) => tool.name))].join('、');
        return {
            name: null,
            remaining: null,
            tier: null,
            failure: 'excluded-oscillation',
            message:
                `两把${kind}在互相让位（${names} 都被本次动作拒绝过）——不在这两个之间来回换：` +
                `先 Stop 拿回身体，手动 equip 一把，或改用更便宜的活/绕路。`,
        };
    }
    // **便宜优先**：档位最低，然后剩余耐久最少——先把它用掉，断了再换下一把。
    available.sort((a, b) => (b.tierIndex !== a.tierIndex ? b.tierIndex - a.tierIndex : (a.remaining ?? 0) - (b.remaining ?? 0)));
    const chosen = available[0]!;
    const tierName = TIER_ORDER[chosen.tierIndex] ?? '';
    return {
        name: chosen.name,
        remaining: chosen.remaining,
        tier: (tierName as ToolTier) ?? null,
        failure: null,
        message:
            `用 ${chosen.name}` +
            (chosen.remaining != null ? `（耐久 ${chosen.remaining}）` : '') +
            '——档位最低、剩得最少的一把；先用它，断了再换下一把。',
    };
}
