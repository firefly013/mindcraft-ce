/**
 * **"僵尸状态"**：活着、但**没有任何合法的自救动作能带来进展**。
 *
 * 真机 2026-10-19（两个 bot 都撞上）：overnight_a `health 0.375, food 0, saturation 0`、
 * 背包**完全空**、站在地下不动，持续十多分钟（`task.stuck → full-stop`）。
 *   - 不能自然回血（原版自然恢复需要饱食度）；
 *   - 不能打怪（重伤守卫正确地拒绝 `attack`）；
 *   - 不能吃（没有食物）。
 * 于是每个合法动作都不产生进展。而**这个存档正好有一个便宜的出口**：
 * `keepInventory=true` + `doImmediateRespawn=true` ⇒ 主动死一次只花一次重生、
 * 物品与经验全留、血和饱食度回满。
 *
 * 关键纪律（Lead 2026-10-19 的裁定）：
 *   - **"可以主动死"这句话只在死亡代价确实为零时才允许说**——`keepInventory`
 *     必须是**当场读到的 true**；false 或读不到 ⇒ 一律不给这条建议，改成指路找吃的；
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
    /** `settings.gameplay.keepInventoryOnDeath` 的当场读数（true/false/null）。 */
    keepInventory: boolean | null;
    immediateRespawn?: boolean | null;
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

    if (facts.keepInventory === true) {
        const respawnNote =
            facts.immediateRespawn === true
                ? '这个存档 **keepInventory=true + doImmediateRespawn=true**：死亡只花一次重生，**物品和经验都保留**、立刻满血满食物。'
                : '这个存档 **keepInventory=true**：死亡只花一次重生，物品和经验都保留。';
        return {
            unrecoverable: true,
            advice:
                `${core}**最快的出路是主动死一次**：${respawnNote}` +
                '走到最近的敌对生物旁边站着不动，或者跳进岩浆/从高处掉下去。' +
                '重生后第一件事是 `getFood(want=3)`。' +
                `\n    ${honest}${tail}`,
        };
    }
    // keepInventory=false 或读不到：**绝不说"主动死"**（东西会掉在地上，是完全不同的事）。
    return {
        unrecoverable: true,
        advice:
            `${core}` +
            (facts.keepInventory === false
                ? '**不要主动死——这个存档 keepInventory=false，死了会掉光背包。**'
                : '**不要主动死**——`keepInventory` 现在读不到（没确认过死亡不掉东西之前，不许拿命去赌）。') +
            '现在只能去**找吃的**：`getFood()`（附近/背包里找食物），或者往已知有食物的地方走（村庄/箱子/动物）；' +
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
