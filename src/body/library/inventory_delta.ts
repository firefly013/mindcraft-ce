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
            note: `这次的背包读数不可用，${before == null ? '开始前' : '结束后'}的读数没有拿到。`,
        };
    }
    const names = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    const gained: string[] = [];
    const lost: string[] = [];
    const gainedPairs: Array<{ name: string; count: number }> = [];
    const lostPairs: Array<{ name: string; count: number }> = [];
    for (const name of names) {
        const delta = Number(after[name] ?? 0) - Number(before[name] ?? 0);
        // 结构化字段只用"名字×数量"，符号由前面的词承担（避免"减少 -2"）。
        if (delta > 0) {
            gained.push(`${name}×${delta}`);
            gainedPairs.push({ name, count: delta });
        } else if (delta < 0) {
            lost.push(`${name}×${-delta}`);
            lostPairs.push({ name, count: -delta });
        }
    }
    const changed = gained.length > 0 || lost.length > 0;
    const targetGain = Number(after[targetName] ?? 0) - Number(before[targetName] ?? 0);
    const describe = (verb: string, pairs: Array<{ name: string; count: number }>): string =>
        `${verb} ${pairs
            .slice(0, 8)
            .map((pair) => `${pair.count} 个 ${pair.name}`)
            .join('、')}`;
    const parts: string[] = [];
    if (gainedPairs.length > 0) parts.push(describe('背包里多了', gainedPairs));
    if (lostPairs.length > 0) parts.push(describe('背包里少了', lostPairs));
    if (!changed && targetGain <= 0) parts.push('背包没有变化，目标物品也没有增加');
    return { changed, gained, lost, note: parts.join('，') };
}
