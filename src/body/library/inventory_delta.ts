/**
 * **背包 delta 的措辞**（Lead 2026-10-21：A 收到「减少 -oak_log×N」——一个负数"减少"）。
 * 规则：**词和数字必须一致**：「增加 2」「减少 2」，绝不「减少 -2」；读不到就写读不到，
 * 不把"未知"当成"没变化"。
 */
export type InventoryCounts = Record<string, number>;

export interface InventoryDeltaNote {
    changed: boolean;
    gained: string[];
    lost: string[];
    note: string;
}

export function formatInventoryDeltaNote(
    before: InventoryCounts | null,
    after: InventoryCounts | null,
    targetName = '',
): InventoryDeltaNote {
    if (before == null || after == null) {
        return {
            changed: false,
            gained: [],
            lost: [],
            note: `读数不可用（${before == null ? '之前' : '之后'}读不到，可能是刚重连还没同步）——不能据此判断捡没捡到`,
        };
    }
    const names = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    const gained: string[] = [];
    const lost: string[] = [];
    for (const name of names) {
        const delta = Number(after[name] ?? 0) - Number(before[name] ?? 0);
        // **只放"名字×数量"，符号由前面的词承担**（避免"减少 -2"）。
        if (delta > 0) gained.push(`${name}×${delta}`);
        else if (delta < 0) lost.push(`${name}×${-delta}`);
    }
    const changed = gained.length > 0 || lost.length > 0;
    const targetGain = Number(after[targetName] ?? 0) - Number(before[targetName] ?? 0);
    const parts: string[] = [];
    if (gained.length > 0) parts.push(`增加 ${gained.slice(0, 8).join('、')}`);
    if (lost.length > 0) parts.push(`**减少 ${lost.slice(0, 8).join('、')}**`);
    if (lost.length > 0) {
        parts.push('（**有物品减少**——这不是"没捡到"，是背包真的被改动了，先用 stats 核对再行动）');
    } else if (targetGain <= 0) {
        parts.push('（目标物品并没有增加）');
    }
    return { changed, gained, lost, note: parts.join('') };
}
