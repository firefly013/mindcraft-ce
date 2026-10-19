/**
 * **三方互锁**（真机 2026-10-19，第 6/7 次复发，overnight_a）：
 *
 * > 「保命 `surface` 反射与溺水互锁：每 1 秒被推上水面呼吸，想死也死不了」
 * > 「被困 1×1×1 封闭空气格：**挖不动/走不动/溺不死** 三重互锁」
 *
 * 现场：`health 0.375, food 0, backpack empty`、同一坐标约 40 分钟、`pose sneaking`、
 * 试过 `disableSafeguards` 被正确拒绝。三个出口全被堵死：
 *   挖出去——没镐；走出去——1×1×1 封闭；淹死——**我们自己的 `surface` 反射每秒把它顶上去**。
 *
 * 这是**引擎造出来的墙**，所以要由引擎拆：检测到这个精确的锁之后，
 * **只让 `surface` 这一条反射停手 60 秒**（有界、响亮的日志），其它保命照旧；
 * 不是"允许 bot 随便关保命"，而是"承认这一条规则此刻就是那堵墙"。
 */

export interface DeadlockFacts {
    /** 同一个坐标待了多久（秒）。 */
    stuckSec: number;
    health: number | null;
    food: number | null;
    /** 背包里有没有能挖的工具（镐/铲/斧…）。 */
    hasDigTool: boolean;
    /** 身边有没有可挖的邻居方块（挖出去这条路是否真的成立）。 */
    hasDiggableNeighbour: boolean;
    /** 最近 3 分钟里 `surface` 反射被触发的次数（我们把它顶上去的证据）。 */
    surfaceTriggers: number;
    /** 这个存档死亡是否真的零成本（keepInventory 实时读数）。 */
    keepInventory?: boolean | null;
    immediateRespawn?: boolean | null;
}

export interface DeadlockVerdict {
    deadlocked: boolean;
    /** 给模型的说明（deadlocked 时非空）。 */
    text: string | null;
    /** 建议只让 `surface` 停手多久（毫秒）；0 = 不停手。 */
    standDownSurfaceMs: number;
}

/** 判定阈值（都可调，但都是"分钟级"，不允许瞬时状态触发）。 */
export const DEADLOCK_STUCK_SEC = 180;
export const DEADLOCK_SURFACE_TRIGGERS = 8;
export const DEADLOCK_STAND_DOWN_MS = 60_000;

export function deadlockVerdict(facts: DeadlockFacts): DeadlockVerdict {
    const stuck = Number.isFinite(facts.stuckSec) && facts.stuckSec >= DEADLOCK_STUCK_SEC;
    const weak = facts.health != null && facts.health <= 4 && facts.food === 0;
    const cannotDig = !facts.hasDigTool || !facts.hasDiggableNeighbour;
    const pushingUp = facts.surfaceTriggers >= DEADLOCK_SURFACE_TRIGGERS;
    if (!(stuck && weak && cannotDig && pushingUp)) return { deadlocked: false, text: null, standDownSurfaceMs: 0 };

    const minutes = Math.round(facts.stuckSec / 60);
    const zeroCost = facts.keepInventory === true;
    const exit = zeroCost
        ? '**这个存档死亡只花一次重生**（物品和经验都保留）：所以让 `surface` 停手 60 秒，你就能按开发者说的"潜水憋死"走出去。'
        : facts.keepInventory === false
          ? '注意：这个存档 **keepInventory=false**，死了会掉东西——所以**不要**指望"憋死"当出路，先想办法挖/走（哪怕用仅有的材料垫出去）。'
          : '注意：`keepInventory` **读不到**——在没确认死亡不掉东西之前，"憋死"不是一条可以推荐的出路。';
    return {
        deadlocked: true,
        standDownSurfaceMs: zeroCost ? DEADLOCK_STAND_DOWN_MS : 0,
        text:
            `你被卡死了（第 ${minutes} 分钟同一坐标）：**挖不动**（没工具/没可挖的邻居）、` +
            '**走不动**（封闭空间）、**溺不死**（保命 `surface` 反射每秒把你顶上去）。' +
            '**这不是你的错，是引擎的死锁——我们自己的规则成了那堵墙。**' +
            exit +
            (zeroCost
                ? '已经**只让 surface 这一条规则停手 ' +
                  `${Math.round(DEADLOCK_STAND_DOWN_MS / 1000)} 秒**（其它保命照常）；别急着 disableSafeguards，等这 60 秒。`
                : '（这是说明，不是拒绝：其它动作照旧合法。）'),
    };
}
