/**
 * **工具选择的唯一决策函数**（Lead 2026-10-21，用户推翻了"排除快断工具"那版规则）：
 * 快断的镐不是坏工具，是**便宜工具**——挖 1~2 格石头就该用它，把满耐久的留给硬活；
 * 而且 4 次耐久的**铁镐**仍是唯一能挖钻石的档位。真正该禁止的只有一件事：
 * **选一个会在活干到一半断掉的工具**（把可用工具变成必然半途而废）。
 *
 * 规则：
 *   requirement = { minimumTier, usesNeeded }
 *   candidates = 档位达标 且 剩余耐久 >= usesNeeded
 *   choice = 其中最**便宜**的（档位最低 → 剩余耐久最少）
 * 没有候选：档位达标但耐久不够 ⇒ "能挖但会断"；否则 ⇒ "档位不够"。
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

export type ToolChoiceFailure = 'no-tool' | 'tier-too-low' | 'tier-ok-but-will-break' | 'excluded-oscillation';

export interface ToolChoice {
    name: string | null;
    remaining: number | null;
    tier: ToolTier | null;
    failure: ToolChoiceFailure | null;
    /** 回执：说清"用哪个、为什么、留哪个"。 */
    message: string;
}

/**
 * 为一件具体的活选工具。`usesNeeded` 是**这活大约要消耗几次耐久**（挖 1 格 ≈ 1 次）。
 * 读不到耐久的工具当作"够用"（不能因为测不出就排除可用工具）。
 */
export function chooseToolForJob(input: {
    tools: ToolCandidate[];
    kind?: ToolKind;
    minimumTier?: ToolTier;
    usesNeeded?: number;
    excluded?: string[];
}): ToolChoice {
    const kind = input.kind ?? 'pickaxe';
    const minimumTier = input.minimumTier ?? 'wooden';
    const usesNeeded = Math.max(1, Math.floor(Number(input.usesNeeded ?? 1) || 1));
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
    const sufficient = tierOk.filter((tool) => tool.remaining == null || tool.remaining >= usesNeeded);
    // **本动作里被拒绝过的工具不许再选回**
    const available = sufficient.filter((tool) => !excluded.has(tool.name));
    if (available.length === 0) {
        if (sufficient.length > 0) {
            const names = [...new Set(sufficient.map((tool) => tool.name))].join('、');
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
        const best = [...tierOk].sort((a, b) => (b.remaining ?? 0) - (a.remaining ?? 0))[0]!;
        return {
            name: null,
            remaining: best.remaining,
            tier: TIER_ORDER[best.tierIndex] ?? null,
            failure: 'tier-ok-but-will-break',
            message:
                `这活能挖，但镐只剩 ${best.remaining ?? '?'} 次、这活要约 ${usesNeeded} 次——` +
                '**挖到一半会断**。先换一把（或分几次做、先绕开）。',
        };
    }
    // **便宜优先**：档位最低，然后剩余耐久最少（它正好适合这点活，且能顺手用掉）。
    available.sort((a, b) => (b.tierIndex !== a.tierIndex ? b.tierIndex - a.tierIndex : (a.remaining ?? 0) - (b.remaining ?? 0)));
    const chosen = available[0]!;
    const reserved = tierOk
        .filter((tool) => tool.remaining != null && tool.remaining < (chosen.remaining ?? Number.POSITIVE_INFINITY))
        .slice(0, 2);
    const tierName = TIER_ORDER[chosen.tierIndex] ?? '';
    return {
        name: chosen.name,
        remaining: chosen.remaining,
        tier: (tierName as ToolTier) ?? null,
        failure: null,
        message:
            `用 ${chosen.name}` +
            (chosen.remaining != null ? `（耐久 ${chosen.remaining}）` : '') +
            `——这活约要 ${usesNeeded} 次，够用；满耐久的那把留给硬活` +
            (reserved.length > 0 ? `（${[...new Set(reserved.map((tool) => `${tool.name} 剩 ${tool.remaining}`))].join('、')} 留着）` : '') +
            '。',
    };
}
