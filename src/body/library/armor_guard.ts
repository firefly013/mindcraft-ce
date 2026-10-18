/*
 * 护甲守卫：给"自动穿甲"这个插件行为加上**下界金甲保护**和**可观测性**。
 *
 * 真机事故（overnight_b，2026-10-19）：`mineflayer-armor-manager` 按**材质等级**自动换甲，
 * 它的等级表是 leather < **golden** < **iron** < chainmail < …，于是捡到 iron_helmet 就
 * 把 golden_helmet 换掉了。**在下界金甲不是装饰**：穿着任意一件金装备，猪灵就保持中立；
 * 换掉之后它们会主动攻击。模型看不到这件事发生，也没要求它发生——和今晚杀掉的
 * "假进度""假击杀"是同一类：**状态变了，却没人说**。
 *
 * 三条规矩：
 *   ① 在下界**绝不把金甲换成非金甲**（保留金甲：遭遇战活下来 > 防御点数）；真被换走了就换回来；
 *   ② **任何护甲变化都要说出来**（`log` 到 bot.output，模型下一轮就能看到，包括"换不回来"这种坏消息）；
 *   ③ 主世界/末地照旧：更好的甲还是要换——**不许**变成"永不自动穿甲"。
 *
 * 插件自己那条路（`playerCollect` → `equipItem`）没法配置，所以这里做两件事：
 *   看住护甲槽的变化（`inventory.on('updateSlot')`）→ 报告 + 必要时换回；
 *   包住 `bot.armorManager.equipAll`，让插件的批量穿甲也走同一套判据。
 */

import * as skills from './skills.js';
import settings from '../../shared/settings.js';

/** 玩家背包窗口里的护甲槽（和插件 `inventory.slots.slice(5, 9)` 同一套）。 */
export const ARMOR_SLOTS: Readonly<Record<number, ArmorSlotName>> = Object.freeze({
    5: 'head',
    6: 'torso',
    7: 'legs',
    8: 'feet',
});

export type ArmorSlotName = 'head' | 'torso' | 'legs' | 'feet';

/** 槽位号 → 部位名（不是护甲槽就 null）。 */
export function armorSlotNameOf(slot: unknown): ArmorSlotName | null {
    const index = typeof slot === 'number' ? slot : Number(slot);
    if (!Number.isFinite(index)) return null;
    return ARMOR_SLOTS[index] ?? null;
}

/** 物品名 → 部位（按后缀，和插件 `DESTINATIONS` 同一套判据）。 */
export function armorSlotOfItemName(name: unknown): ArmorSlotName | null {
    if (typeof name !== 'string') return null;
    const value = name.trim().toLowerCase();
    if (value.endsWith('helmet') || value === 'turtle_helmet') return 'head';
    if (value.endsWith('chestplate') || value === 'elytra') return 'torso';
    if (value.endsWith('leggings')) return 'legs';
    if (value.endsWith('boots')) return 'feet';
    return null;
}

/**
 * 是不是**金**装备（下界里让猪灵保持中立的那件）。
 *
 * 金甲的实际注册名是 `golden_helmet` 这种；这里同时认 `gold_*`（老版本/别名），
 * 但**不认** `gold_nugget`/`gold_ingot` 这类非装备（必须有部位后缀才算）。
 */
export function isGoldArmorName(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const value = name.trim().toLowerCase();
    if (armorSlotOfItemName(value) == null) return false;
    return value.startsWith('golden_') || value.startsWith('gold_');
}

export function isInNetherDimension(dimension: unknown): boolean {
    return typeof dimension === 'string' && dimension.toLowerCase().includes('nether');
}

export interface ArmorSwapVerdict {
    /** `allow` = 放行（并如实报告）；`revert_gold` = 换回金甲。 */
    action: 'allow' | 'revert_gold';
    /** 要写进 bot.output 的那一行（**永远不为空**：变化必须说出来）。 */
    report: string;
    reason: string;
}

/**
 * 一次护甲变化该怎么处理（纯函数，可单测）。
 *
 * 判据只看两件事：**在不在下界**、**是不是"金 → 非金"**。
 */
export function armorSwapVerdict(input: {
    dimension: string | null;
    slotName: ArmorSlotName;
    from: string | null;
    to: string | null;
}): ArmorSwapVerdict {
    const { dimension, slotName, from, to } = input;
    const nether = isInNetherDimension(dimension);
    const change = `${slotName} ${from ?? '空'} → ${to ?? '空'}`;
    if (nether && isGoldArmorName(from) && !isGoldArmorName(to)) {
        return {
            action: 'revert_gold',
            reason: '在下界把金甲换掉会让猪灵从"中立"变成"主动攻击"',
            report:
                `⚠️ 护甲被自动更换：${change}——**在下界这会招来猪灵**（金甲是让它们保持中立的那件），` +
                `已经换回 ${from}。`,
        };
    }
    if (nether && !isGoldArmorName(from) && isGoldArmorName(to)) {
        return {
            action: 'allow',
            reason: '下界换上金甲是好事',
            report: `护甲变化：${change}（下界：换上金甲是对的，猪灵会保持中立）。`,
        };
    }
    return {
        action: 'allow',
        reason: nether ? '下界里不涉及金甲的更换' : '非下界：更好的甲照常换',
        report: `护甲变化：${change}（自动更换${nether ? '，下界但没动金甲' : ''}）。`,
    };
}

/**
 * 护甲快照 / 差分 / "凭空消失"报告。
 *
 * 真机事故（overnight_b，2026-10-19）：模型按要求做了 `golden_helmet` 并穿上，
 * 随后这件**从 armour 槽消失、背包 totals 里也没有**，无金盔 ⇒ 猪灵见即开火 ⇒
 * 下界第 7 次死亡。旧守卫只处理"金甲被换成非金甲"，**没有处理"这件东西没了"**。
 *
 * 所以：槽位变化要**快照差分**（也覆盖整窗 `update`、死亡、重生这几条路），
 * "原来有 → 现在空"必须单独吼出来，并说清后果与修法。
 */
export type ArmorSnapshot = Record<ArmorSlotName, string | null>;

export function armorSnapshot(bot: any, worn?: (bot: any, slotName: ArmorSlotName) => any | null): ArmorSnapshot {
    const read = worn ?? defaultWorn;
    const out = {} as ArmorSnapshot;
    for (const slotName of ['head', 'torso', 'legs', 'feet'] as ArmorSlotName[]) {
        const item = read(bot, slotName);
        out[slotName] = typeof item?.name === 'string' ? item.name : null;
    }
    return out;
}

export interface ArmorChange {
    slotName: ArmorSlotName;
    from: string | null;
    to: string | null;
}

export function diffArmorSnapshot(before: ArmorSnapshot, after: ArmorSnapshot): ArmorChange[] {
    const changes: ArmorChange[] = [];
    for (const slotName of ['head', 'torso', 'legs', 'feet'] as ArmorSlotName[]) {
        if (before[slotName] !== after[slotName]) {
            changes.push({ slotName, from: before[slotName], to: after[slotName] });
        }
    }
    return changes;
}

/** 这个部位的金甲该叫什么（用来给"重做一件"的具体建议）。 */
export function goldArmorNameFor(slotName: ArmorSlotName): string {
    switch (slotName) {
        case 'head':
            return 'golden_helmet';
        case 'torso':
            return 'golden_chestplate';
        case 'legs':
            return 'golden_leggings';
        default:
            return 'golden_boots';
    }
}

export interface ArmorVanishContext {
    dimension: string | null;
    /** 这次变化是不是发生在死亡/重生前后。 */
    deathHappened?: boolean;
    /** 这个存档是否 keepInventory（true 时死亡不该掉甲）。 */
    keepInventory?: boolean | null;
    /** 背包里是否还有任何金装备。 */
    goldLeft?: boolean;
    /** 从哪条路发现的：updateSlot / update / death / spawn / unequip。 */
    via?: string;
}

/**
 * "原来有、现在空了"的吼叫。**必须带上后果和修法**，不能只说"变化了"。
 * 返回一行文本（测试直接断言）。
 */
export function armorVanishReport(change: ArmorChange, ctx: ArmorVanishContext): string {
    const { slotName, from } = change;
    const nether = isInNetherDimension(ctx.dimension);
    const parts: string[] = [];
    parts.push(`⚠️ **护甲凭空消失**：${slotName} 上原本是 ${from ?? '空'}，现在**空了**（背包 totals 里也没有；触发路径：${ctx.via ?? '未知'}）。`);
    parts.push('这**不是自动换甲**——换甲会走"护甲变化"报告，这里没有任何替换动作。');
    // **我们分不清"真丢了"和"本地视图错位"**（Lead 2026-10-19 的要求）：
    // 一次容器操作可能在"窗口已经打开、客户端已经本地移物、随后失败/超时"的中间态里
    // 把我们的视图改掉，而真实背包里东西还在。所以报告不许断言真损失，必须给核对步骤。
    parts.push(
        '注意：这也**可能是一次容器/穿甲操作中途失败造成的本地视图错位**（东西可能还在真实背包或容器里）——' +
            '先用 stats / 重开容器核对，**不要**据此判定"已经没了"、更不要因此重做一件。',
    );
    if (ctx.deathHappened === true && ctx.keepInventory === true) {
        parts.push('它发生在死亡/重生前后，而**这个存档 keepInventory=true：死亡不应该掉护甲**——所以这是**我们读取/同步的问题**，不是世界规则，不要接受这个结果。');
    }
    if (nether && isGoldArmorName(from)) {
        parts.push(`**后果：下界没有金甲 ⇒ 猪灵见即开火**（这一条会直接致死）。修法：用 1 块金锭做一件 \`${goldArmorNameFor(slotName)}\`（craft output=${goldArmorNameFor(slotName)}），做好立刻穿上。`);
    } else if (nether && ctx.goldLeft === false) {
        parts.push('**后果：下界身上已经没有金装备 ⇒ 猪灵见即开火**。修法：用 1 块金锭做一件金盔（golden_helmet）立刻穿上，或先撤离下界。');
    } else if (nether) {
        parts.push('下界里先确认身上是否还有金装备（猪灵只认金）；没有就立刻做一件 golden_helmet。');
    } else {
        parts.push('下一步：先用 stats 核对背包；再从箱子/熔炉里找；找不到就重做一件。');
    }
    return parts.join('');
}

export interface ArmorGuardDeps {
    log?: (bot: any, text: string) => void;
    equip?: (bot: any, item: any, destination: ArmorSlotName) => Promise<boolean>;
    dimension?: (bot: any) => string | null;
    /** 某个部位现在穿着什么（默认读 `inventory.slots[5..8]`）。 */
    worn?: (bot: any, slotName: ArmorSlotName) => any | null;
    inventoryItems?: (bot: any) => Array<{ name?: unknown; type?: unknown; count?: unknown }>;
    /** 这个存档是否 keepInventory（用于"死亡后掉甲 = 我们的 bug"的判定）。 */
    keepInventory?: boolean | null;
}

function defaultWorn(bot: any, slotName: ArmorSlotName): any | null {
    try {
        const index = Number(Object.keys(ARMOR_SLOTS).find((key) => ARMOR_SLOTS[Number(key)] === slotName));
        return bot?.inventory?.slots?.[index] ?? null;
    } catch {
        return null;
    }
}

/** 背包里这个部位的金装备（没有就 null）。 */
export function findGoldArmorFor(
    items: Array<{ name?: unknown }>,
    slotName: ArmorSlotName,
): { name: string } | null {
    for (const item of items ?? []) {
        const name = typeof item?.name === 'string' ? item.name : null;
        if (name == null) continue;
        if (armorSlotOfItemName(name) !== slotName) continue;
        if (!isGoldArmorName(name)) continue;
        return { name };
    }
    return null;
}

/**
 * 在下界把被换走的金甲换回来（`equipAll` 包装与事件回调共用）。
 * 返回写出去的每一行（测试直接断言它，不依赖 bot.output）。
 */
export async function enforceGoldInNether(bot: any, deps: ArmorGuardDeps = {}): Promise<string[]> {
    const dimension = deps.dimension ?? ((b: any) => (typeof b?.game?.dimension === 'string' ? b.game.dimension : null));
    if (!isInNetherDimension(dimension(bot))) return [];
    const log = deps.log ?? ((b: any, text: string) => skills.log(b, text));
    const equip = deps.equip ?? ((b: any, item: any, destination: ArmorSlotName) => b.equip(item, destination));
    const worn = deps.worn ?? defaultWorn;
    const items = deps.inventoryItems ?? ((b: any) => (b?.inventory?.items?.() ?? []) as Array<{ name?: unknown }>);

    const lines: string[] = [];
    for (const slotName of ['head', 'torso', 'legs', 'feet'] as ArmorSlotName[]) {
        const current = worn(bot, slotName);
        const currentName = typeof current?.name === 'string' ? current.name : null;
        if (currentName != null && isGoldArmorName(currentName)) continue; // 金甲还在，不用管
        const gold = findGoldArmorFor(items(bot), slotName);
        if (gold == null) continue;
        try {
            await equip(bot, gold, slotName);
        } catch {
            /* 下面按**槽位实际内容**判定成败 */
        }
        // **证据，不是返回值**：`equip` 说成功不算，要真的看到金甲穿上了。
        const after = worn(bot, slotName);
        const ok = typeof after?.name === 'string' && isGoldArmorName(after.name);
        const line = ok
            ? `已把 ${gold.name} 换回 ${slotName}（下界：金甲让猪灵保持中立）。`
            : `想换回 ${gold.name} 但没成功——**下界现在没有金甲，猪灵会主动攻击**。`;
        log(bot, line);
        lines.push(line);
    }
    return lines;
}

/**
 * 装上护甲守卫：看住护甲槽 + 包住插件的 `equipAll`。返回 `dispose()` 方便测试收尾。
 */
export function installArmorGuard(
    bot: any,
    deps: ArmorGuardDeps = {},
): { dispose: () => void } {
    const dimension = deps.dimension ?? ((b: any) => (typeof b?.game?.dimension === 'string' ? b.game.dimension : null));
    const log = deps.log ?? ((b: any, text: string) => skills.log(b, text));
    const equip = deps.equip ?? ((b: any, item: any, destination: ArmorSlotName) => b.equip(item, destination));
    const inventoryItems =
        deps.inventoryItems ?? ((b: any) => (b?.inventory?.items?.() ?? []) as Array<{ name?: unknown }>);
    const worn = deps.worn ?? defaultWorn;
    let reverting = false;

    const handler = (slot: unknown, oldItem: any, newItem: any): void => {
        const slotName = armorSlotNameOf(slot);
        if (slotName == null) return;
        const from = typeof oldItem?.name === 'string' ? oldItem.name : null;
        const to = typeof newItem?.name === 'string' ? newItem.name : null;
        if (from === to) return;
        const verdict = armorSwapVerdict({ dimension: dimension(bot), slotName, from, to });
        // **"原来有 → 现在空"不是换甲，是东西没了。** 这条要吼，且带后果与修法；
        // 用 vanish 报告替换普通的"护甲变化"，免得同一件事说两遍而都不够响。
        if (from != null && to == null) {
            log(
                bot,
                armorVanishReport(
                    { slotName, from, to },
                    {
                        dimension: dimension(bot),
                        keepInventory: readKeepInventory(deps),
                        goldLeft: inventoryItems(bot).some((item) => isGoldArmorName(item?.name)),
                        via: 'updateSlot',
                    },
                ),
            );
        } else {
            log(bot, verdict.report);
        }
        if (verdict.action !== 'revert_gold' || reverting) return;
        reverting = true;
        void (async () => {
            try {
                const gold = findGoldArmorFor(inventoryItems(bot), slotName);
                if (gold == null) {
                    log(
                        bot,
                        '⚠️ 金甲已经被换掉、背包里也找不到金装备了：**下界现在没有金甲，猪灵会主动攻击**——' +
                            '赶紧找一块金锭做一件（或先撤离）。',
                    );
                    return;
                }
                let ok = false;
                try {
                    await equip(bot, gold, slotName);
                } catch {
                    /* 下面按槽位实际内容判定 */
                }
                // **证据，不是返回值**：看到金甲真的穿上了才算成功。
                const after = worn(bot, slotName);
                ok = typeof after?.name === 'string' && isGoldArmorName(after.name);
                log(
                    bot,
                    ok
                        ? `已把 ${gold.name} 换回 ${slotName}（下界：金甲让猪灵保持中立）。`
                        : `想换回 ${gold.name} 但没成功——**下界现在没有金甲，猪灵会主动攻击**。`,
                );
            } finally {
                reverting = false;
            }
        })();
    };

    try {
        bot?.inventory?.on?.('updateSlot', handler);
    } catch {
        /* 假身体没有事件总线也不该炸 */
    }

    // **快照差分**：整窗 `update`、死亡、重生这几条路都不走 `updateSlot`，
    // 而金盔"消失"很可能就是被整窗同步覆盖掉的（旧守卫看不到这条路）。
    // 冷启动时的一发读数是基线，不是"消失"。
    let lastArmor = armorSnapshot(bot, worn);
    let deathHappened = false;
    const checkVanish = (via: string): void => {
        const nowArmor = armorSnapshot(bot, worn);
        for (const change of diffArmorSnapshot(lastArmor, nowArmor)) {
            if (change.from == null || change.to != null) continue; // 只关心"有 → 空"
            log(
                bot,
                armorVanishReport(change, {
                    dimension: dimension(bot),
                    deathHappened,
                    keepInventory: readKeepInventory(deps),
                    goldLeft: inventoryItems(bot).some((item) => isGoldArmorName(item?.name)),
                    via,
                }),
            );
        }
        lastArmor = nowArmor;
    };
    const onInventoryUpdate = (): void => checkVanish('update');
    const onDeath = (): void => {
        deathHappened = true;
    };
    const onSpawn = (): void => {
        checkVanish('spawn');
        deathHappened = false;
    };
    try {
        bot?.inventory?.on?.('update', onInventoryUpdate);
        bot?.on?.('death', onDeath);
        bot?.on?.('spawn', onSpawn);
    } catch {
        /* 同上 */
    }

    // 插件自己的批量穿甲（`bot.armorManager.equipAll()`）也要过同一套判据。
    try {
        const manager = bot?.armorManager;
        if (manager != null && typeof manager.equipAll === 'function' && manager.__netherGoldGuarded !== true) {
            const original = manager.equipAll.bind(manager);
            manager.equipAll = async (...args: unknown[]) => {
                const result = await original(...args);
                await enforceGoldInNether(bot, { ...deps, log, equip, dimension, worn, inventoryItems });
                return result;
            };
            manager.__netherGoldGuarded = true;
        }
    } catch {
        /* 插件没装也不该炸 */
    }

    return {
        dispose: (): void => {
            try {
                bot?.inventory?.off?.('updateSlot', handler);
                bot?.inventory?.off?.('update', onInventoryUpdate);
                bot?.off?.('death', onDeath);
                bot?.off?.('spawn', onSpawn);
            } catch {
                /* ignore */
            }
        },
    };
}

/** keepInventory 的运行时值（deps 优先，其次 settings；读不到 = null，别硬说）。 */
function readKeepInventory(deps: ArmorGuardDeps): boolean | null {
    if (deps.keepInventory === true || deps.keepInventory === false) return deps.keepInventory;
    try {
        const gameplay = (settings as any)?.gameplay ?? {};
        const value = gameplay.keepInventoryOnDeath;
        if (value === true || value === false) return value;
    } catch {
        /* 读不到就说读不到 */
    }
    return null;
}
