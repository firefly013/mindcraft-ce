/*
 * `searchWiki` 的**离线兜底**：wiki 打不通时，用 minecraft-data 回答
 * "这是什么 / 怎么做 / 要多少"。
 *
 * 为什么必须有：真机（overnight_a）报 `searchWiki 连「弓」这种最基础的东西都报 not found`。
 * 排查结论是**工具在这台机器上永远不可能成功**：`https://minecraft.wiki/w/Bow`
 * 从这里访问是 **HTTP 403**（带正常浏览器 UA/Accept 也照样 403），而 example.com 是 200
 * ——网络没问题，是那个站点把我们挡了。于是模型每次"不知道怎么合成"就去 searchWiki，
 * 每次都被"not found"打发走，一整晚都在浪费这种回合。
 *
 * 所以网络失败时改用**本地数据**：物品/方块是否存在、一组多少个、耐久、以及
 * 归一化后的合成配方。本文件是纯逻辑（只吃数据，不碰网络、不 import 身体实现），
 * 方便单测。
 *
 * 两条纪律：
 *   1. 本地答案必须**明确标注**"不是 wiki 原文"——不能让人以为抓到了网页；
 *   2. 兜底也答不上来时，**如实说没有**，并指向真正能离线的工具，不许编内容。
 */

/** 本地兜底答案的标签（回执里原样出现，测试直接断言它）。 */
export const LOCAL_WIKI_LABEL = '本地资料（离线兜底，不是 wiki 原文）';

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 把模型的提问归一化成 snake_case 形式。
 *
 * `"Bow"` / `"bow "` / `"minecraft:bow"` / `"how do I craft a bow"` → 先各自归一，
 * 真正的名字匹配见 `matchWikiName`。
 */
export function normalizeWikiQuery(raw: unknown): string {
    return String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * 从一句自然语言里找出**真实存在的**物品/方块名。
 *
 * 模型的真实提问不是干净的 id：`"how do I craft a bow"`、`"what is a crafting table"`。
 * 顺序：① 归一化后整串精确匹配；② 相邻 1~3 个词拼起来匹配（长的优先，`oak_planks`
 * 这类多词名才认得出来）；③ 整串里包含某个名字（取最长的那个）。
 * 找不到返回 null——**不许猜**。
 */
export function matchWikiName(query: unknown, names: Iterable<string>): string | null {
    const set = new Set<string>();
    for (const name of names) set.add(String(name).toLowerCase());
    if (set.size === 0) return null;

    const normalized = normalizeWikiQuery(query);
    if (normalized === '') return null;
    if (set.has(normalized)) return normalized;

    const tokens = String(query ?? '')
        .trim()
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .split(/[^a-z0-9]+/)
        .filter((t) => t !== '');
    // 相邻 3 词 → 2 词 → 1 词，长的优先。
    for (const span of [3, 2, 1]) {
        for (let i = 0; i + span <= tokens.length; i++) {
            const candidate = tokens.slice(i, i + span).join('_');
            if (set.has(candidate)) return candidate;
        }
    }
    // 兜底：整串里按词边界包含某名字，取最长命中（"the bow item" 这种）。
    let best: string | null = null;
    for (const name of set) {
        if (name.length < 3) continue;
        if (!normalized.includes(name)) continue;
        if (best == null || name.length > best.length) best = name;
    }
    return best;
}

export interface WikiLocalItem {
    displayName?: unknown;
    stackSize?: unknown;
    maxDurability?: unknown;
}

export interface WikiLocalBlock {
    displayName?: unknown;
    hardness?: unknown;
    diggable?: unknown;
}

export interface WikiLocalInput {
    /** 原始提问（回执里引用）。 */
    query: string;
    /** 命中后的规范名（snake_case）。 */
    name: string;
    item?: WikiLocalItem | null;
    block?: WikiLocalBlock | null;
    /** 归一化配方：材料名 → 数量，以及产出数量。 */
    recipes?: Array<[Record<string, number>, { craftedCount: number }]> | null;
    /** 物品名 → 显示名（渲染材料用）。 */
    displayName?: (name: string) => string;
    /** 网络侧为什么没拿到（会原样写进回执）；没有就只说"没拿到"。 */
    why?: string | null;
}

/**
 * 渲染本地答案。**永远带标签**，并且永远给出一个能离线做的下一步。
 */
export function renderLocalWikiAnswer(input: WikiLocalInput): string {
    const display = input.displayName ?? ((n: string) => n);
    const shownRaw = input.item?.displayName ?? input.block?.displayName ?? input.name;
    const shown = typeof shownRaw === 'string' && shownRaw !== '' ? shownRaw : input.name;
    const lines: string[] = [];

    const why = input.why != null && input.why !== '' ? input.why : '网络查询没成功';
    lines.push(`searchWiki 没拿到 wiki 内容（${why}）。以下是${LOCAL_WIKI_LABEL}：`);

    const kinds: string[] = [];
    if (input.item != null) kinds.push('物品');
    if (input.block != null) kinds.push('方块');
    const facts: string[] = [`${shown}（${input.name}）是${kinds.join(' + ') || '一个名字'}`];
    const stack = num(input.item?.stackSize);
    if (stack != null && stack > 1) facts.push(`一组 ${stack} 个`);
    // ⚠️ 只报 >1 的耐久：这份数据里 bow 的 maxDurability 是 1（占位值），
    // 报出来就是假数字（和 D7 那次"max=1 的假上限"同一类坑）。
    const durability = num(input.item?.maxDurability);
    if (durability != null && durability > 1) facts.push(`耐久 ${durability}`);
    lines.push('- ' + facts.join('，') + '。');

    if (input.block != null) {
        const blockBits: string[] = [];
        const hardness = num(input.block.hardness);
        if (hardness != null) blockBits.push(`硬度 ${hardness}`);
        if (input.block.diggable === false) blockBits.push('不可破坏');
        if (blockBits.length > 0) lines.push('- 方块属性：' + blockBits.join('，') + '。');
    }

    const recipes = (input.recipes ?? []).filter((r) => r != null);
    if (recipes.length > 0) {
        const rendered = recipes.slice(0, 3).map(([ingredients, meta]) => {
            const parts = Object.entries(ingredients)
                .filter(([n, c]) => n !== '' && num(c) != null && (c as number) > 0)
                .map(([n, c]) => `${c} 个 ${display(n)}（${n}）`);
            const count = num(meta?.craftedCount) ?? 1;
            return `${parts.join(' + ')} → ${count} 个 ${shown}（工作台）`;
        });
        lines.push('- 合成：' + rendered.join('；或 ') + '。');
    } else if (input.item != null) {
        lines.push(
            '- 本地配方表里没有它的合成配方：要么只能靠打怪/挖矿/交易/熔炉拿到，' +
                '要么它的配方在别的名字下（例如木板是 oak_planks 这类具体木种）。',
        );
    }

    lines.push(`- 想知道"还缺什么、一共要多少"，用 getCraftingPlan(targetItem=${input.name}, quantity=<数量>)——它离线可用。`);
    return lines.join('\n');
}
