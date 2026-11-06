/**
 * **"僵尸状态"**：活着、但**没有任何合法的自救动作能带来进展**。
 *
 * 真机 2026-10-19（两个 bot 都撞上）：overnight_a `health 0.375, food 0, saturation 0`、
 * 背包**完全空**、站在地下不动，持续十多分钟（`task.stuck → full-stop`）。
 *   - 不能自然回血（原版自然恢复需要饱食度）；
 *   - 不能打怪（重伤守卫正确地拒绝 `attack`）；
 *   - 不能吃（没有食物）。
 * 于是每个合法动作都不产生进展。引擎能做的是**把这条事实说清楚**，并指出
 * 唯一还有进展的方向（去找吃的），而不是让模型在原地反复试同一个动作。
 *
 * 关键纪律：
 *   - **不提供任何"主动结束"的出口**：引擎只陈述"不能回血、不能吃、背包里没有食物"，
 *     以及"唯一的进展是去找吃的"；怎么找、去哪找由模型自己决定；
 *   - **不是拒绝、不是锁**：所有动作照旧合法，这条只是让模型别再空转；
 *   - **一个状态只说一次**（同 `shouldEmitFallNotice` 的形状），且带上"已持续多久"。
 */

const EDIBLE = new Set<string>([
    'apple',
    'golden_apple',
    'enchanted_golden_apple',
    'bread',
    'carrot',
    'golden_carrot',
    'potato',
    'baked_potato',
    'beetroot',
    'beetroot_soup',
    'dried_kelp',
    'melon_slice',
    'mushroom_stew',
    'rabbit_stew',
    'beef',
    'cooked_beef',
    'porkchop',
    'cooked_porkchop',
    'chicken',
    'cooked_chicken',
    'mutton',
    'cooked_mutton',
    'rabbit',
    'cooked_rabbit',
    'cod',
    'cooked_cod',
    'salmon',
    'cooked_salmon',
    'tropical_fish',
    'pufferfish',
    'sweet_berries',
    'glow_berries',
    'honey_bottle',
    'cookie',
    'cake',
    'pumpkin_pie',
    'rotten_flesh',
    'spider_eye',
    'poisonous_potato',
    'suspicious_stew',
    'chorus_fruit',
    'kelp',
    'raw_iron',
]);

/** 这个物品能不能吃（**只认真能恢复饱食度的**；原料/工具不算）。 */
export function isEdibleName(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const value = name.trim().toLowerCase();
    if (value === '') return false;
    if (EDIBLE.has(value)) return true;
    // 兼容老注册名：raw_beef / raw_porkchop 之类。
    const aliased = value.startsWith('raw_') ? value.slice(4) : null;
    return aliased != null && EDIBLE.has(aliased);
}

export interface UnrecoverableFacts {
    health: number | null;
    food: number | null;
    /** 背包里所有物品名（用 isEdibleName 过滤）。 */
    itemNames: string[] | null;
    /** 已经在不可恢复状态里待了多久（秒），用于回执行尾。 */
    elapsedSec?: number;
}

export interface UnrecoverableVerdict {
    unrecoverable: boolean;
    /** 要写给模型的那段话；不可恢复时为非空。 */
    advice: string | null;
}

const NO_HEAL_HEALTH = 4;

/**
 * 判定"无法自愈"并给出**有条件的**建议。
 *
 * 谓词很窄：`health ≤ 4` **且** `food == 0` **且** 背包里没有任何可吃的东西
 * （外加"食物读不到"也算不可判定 ⇒ 不触发，避免拿"读不到"当理由）。
 */
export function unrecoverableVerdict(facts: UnrecoverableFacts): UnrecoverableVerdict {
    const health = facts.health;
    const food = facts.food;
    if (health == null || food == null) return { unrecoverable: false, advice: null };
    if (health > NO_HEAL_HEALTH) return { unrecoverable: false, advice: null };
    if (food > 0) return { unrecoverable: false, advice: null };
    if (facts.itemNames == null) return { unrecoverable: false, advice: null }; // 背包读不到 ⇒ 不判定
    const edible = facts.itemNames.filter((name) => isEdibleName(name));
    if (edible.length > 0) return { unrecoverable: false, advice: null };

    const elapsed = Math.max(0, Math.round(Number(facts.elapsedSec ?? 0)));
    const core =
        `你现在**无法自愈**：${Math.round(health * 100) / 100} 血、食物 0、背包里没有任何食物，` +
        '而这个世界**没有食物就不会回血**（自然恢复需要饱食度）。';
    const honest = '（这不是拒绝，也不是锁：你所有动作照旧合法——只是别再空转了。）';
    const tail = elapsed > 0 ? `（已持续 ${elapsed >= 60 ? `${Math.round(elapsed / 60)} 分钟` : `${elapsed} 秒`}）` : '';
    return {
        unrecoverable: true,
        advice:
            `${core}现在能做的只有去找吃的，` +
            '先确认背包里有没有能吃的（有就直接 consume），或者往已知有食物的地方走（村庄、箱子、动物）；' +
            '也可以先找个安全角落待着，别在空血时继续探索。' +
            `\n    ${honest}${tail}`,
    };
}

/**
 * 同一条"无法自愈"提示的播报节奏：进入状态立刻说，之后最多每 `minIntervalMs` 说一次。
 * （形状与 `shouldEmitFallNotice` 一致；真机教训：同一条回执在日志里出现 152 次。）
 */
export function shouldEmitUnrecoverable(
    prev: { at: number } | null,
    now: number,
    minIntervalMs = 45_000,
): boolean {
    if (prev == null) return true;
    return now - prev.at >= Math.max(1, minIntervalMs);
}
