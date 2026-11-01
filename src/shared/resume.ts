/*
 * **续做**（resume）：反射抢走身体之后，怎么把模型原来那条指令接着做完。
 *
 * 用户 2026-10-31 的约束（原话）：
 *   - 决策只能掌握在模型手上：引擎只做"机械延续"，不做"接下来干什么"的判断；
 *   - 不设次数上限：被打断两次不是"交给模型"的理由，续做就是机械重试；
 *   - 自动续做对模型没有坏处：它省掉一次重发，而且中断回执会写清楚"已替你续做"。
 *
 * 所以这里只有三档标记，没有策略层：
 *   - `auto`       —— 原样重发一次就够（工具自己会重新找目标/重新算路）；
 *   - `checkpoint` —— 需要按进度折算参数（否则会把同一件事再做一遍）；
 *   - `manual`     —— 有不可回滚的副作用 / 没法机械重放，不自动续做（缺省值）。
 *
 * 本文件是纯数据/纯函数，不 import 身体或大脑的实现。
 */

/** 被反射打断后，这条动作能不能机械续做。 */
export type ResumePolicy = 'auto' | 'checkpoint' | 'manual';

/** `minecraft:oak_log` / `Oak_Log` → `oak_log`。 */
export function normalizeItemName(name: unknown): string {
    return String(name ?? '')
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .replace(/#.*$/, '')
        .trim();
}

/**
 * `collectBlocks` 的目标方块 → 实际进背包的物品。
 *
 * 续做要按"已经收了多少"折算剩余量，而背包里记的是**掉落物**：
 * 挖 `stone` 得到 `cobblestone`，挖 `iron_ore` 得到 `raw_iron`。没有这张表，
 * 进度会永远算成 0（然后把整批再挖一遍）。
 *
 * 表里没有的方块按"掉落物同名"处理（原木/沙子/沙砾/黑曜石等都是这样），
 * 所以这里只需要覆盖"名字和掉落物不一样"的那些。
 *
 * ⚠️ 身体侧有一份更权威的 `BLOCK_DROP_FALLBACK`（`body/data/mcdata.ts`，能从
 * minecraft-data 读真实掉落物）。大脑不能 import 身体代码，所以这里放一份
 * **只用于进度记账**的副本；改一边时记得对照另一边。
 */
export const BLOCK_DROPS: Readonly<Record<string, string>> = Object.freeze({
    stone: 'cobblestone',
    deepslate: 'cobbled_deepslate',
    grass_block: 'dirt',
    podzol: 'dirt',
    mycelium: 'dirt',
    coal_ore: 'coal',
    deepslate_coal_ore: 'coal',
    iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron',
    copper_ore: 'raw_copper',
    deepslate_copper_ore: 'raw_copper',
    gold_ore: 'raw_gold',
    deepslate_gold_ore: 'raw_gold',
    diamond_ore: 'diamond',
    deepslate_diamond_ore: 'diamond',
    emerald_ore: 'emerald',
    deepslate_emerald_ore: 'emerald',
    lapis_ore: 'lapis_lazuli',
    deepslate_lapis_ore: 'lapis_lazuli',
    redstone_ore: 'redstone',
    deepslate_redstone_ore: 'redstone',
    nether_quartz_ore: 'quartz',
    nether_gold_ore: 'gold_nugget',
    clay: 'clay_ball',
    melon: 'melon_slice',
    obsidian: 'obsidian',
    crying_obsidian: 'obsidian',
    ancient_debris: 'ancient_debris',
});

/** `collectBlocks` 的 `type` → 背包里用来数进度的物品名。 */
export function resumeItemForBlock(blockType: unknown): string {
    const key = normalizeItemName(blockType);
    return BLOCK_DROPS[key] ?? key;
}

/** 续做回执里给人看的一行参数（截断，回执不许无限长）。 */
export function describeResumeArgs(args: unknown): string {
    let body: string;
    try {
        body = JSON.stringify(args ?? {});
    } catch {
        body = '[unserializable]';
    }
    return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}

export default { BLOCK_DROPS, normalizeItemName, resumeItemForBlock, describeResumeArgs };
