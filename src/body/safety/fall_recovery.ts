/**
 * 下坠中的"最后一招"：**由下方介质决定**，不由"在下坠"决定。
 *
 * 真机 2026-10-19（overnight_b，第 3 次因反射致死）：从 y≈79 自由落体到 y≈25 的
 * 岩浆里烧死，x/z 一格没动——我加的刹车**生效了**（拒绝横向平移），但在"下方是
 * 岩浆"时，刹车本身就是死刑：末地那种"横向移动会走进虚空"的判据被错误地套用到了
 * 岩浆上。
 *
 * Lead 的裁定：
 *   - **下方是虚空 ⇒ 保持原样**（没有落点、没东西挂水桶，横向移动就是死法）；
 *   - **下方是岩浆/水 ⇒ 刹车之后要试**：先朝最近的安全落脚点横移（这时候横向移动
 *     正是救命动作），再考虑水桶 MLG，再考虑"贴着边缘落地"；
 *   - **介质是唯一判据**；读不到介质 ⇒ **保守（只刹车）**——猜"大概是水"会杀人；
 *   - 只许朝**验证过安全**的落点移动（复用 `assessStandingSpot` 的规则）；
 *   - 已经站在实地上时这条**永不触发**。
 */
import { assessStandingSpot } from './flee.js';

export type FallMedium = 'void' | 'lava' | 'water' | 'solid' | 'unknown';

/** 读脚下 `from`..`to` 格（相对脚），判定下方介质。读不到 = unknown。 */
export function readFallMedium(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
    probe: { from?: number; to?: number } = {},
): { medium: FallMedium; atY: number | null; name: string | null } {
    const fx = Math.floor(Number(feet.x));
    const fz = Math.floor(Number(feet.z));
    const fy = Math.floor(Number(feet.y));
    const from = Math.max(1, Math.floor(Number(probe.from ?? 2) || 2));
    const to = Math.max(from, Math.floor(Number(probe.to ?? 6) || 6));
    let sawUnknown = false;
    for (let d = from; d <= to; d++) {
        const block = blockAt(fx, fy - d, fz);
        const name = typeof block?.name === 'string' ? block.name : '';
        if (name === '') {
            sawUnknown = true;
            continue;
        }
        if (name === 'lava' || name === 'flowing_lava') return { medium: 'lava', atY: fy - d, name };
        if (name === 'water' || name === 'flowing_water') return { medium: 'water', atY: fy - d, name };
        if (name === 'air' || name === 'cave_air' || name === 'void_air') continue;
        // 第一块"非空气、非流体"的方块：是实心地面（在探测范围内）。
        return { medium: 'solid', atY: fy - d, name };
    }
    // 探测范围内一路是空气：下面要么是虚空、要么读不到。
    return { medium: sawUnknown ? 'unknown' : 'void', atY: null, name: null };
}

export interface FallRecoveryPlan {
    /** brake = 只停止平移（保守）；lateral = 朝安全落点横移；mlg = 准备水桶落地。 */
    rung: 'brake' | 'lateral' | 'mlg';
    target: { x: number; y: number; z: number } | null;
    /** 给模型看的回执（含证据：读到什么介质、为什么这么做）。 */
    text: string;
}

/**
 * 决定下坠时该走哪一档。**只在"已经在掉、且脚下没有实心支撑"时调用。**
 */
export function planFallRecovery(input: {
    feet: { x: number; y: number; z: number };
    medium: FallMedium;
    mediumAtY?: number | null;
    mediumName?: string | null;
    /** 站在实地上（调用方判定）⇒ 这条永不触发。 */
    onSolidGround: boolean;
    /** 3 格水平范围内、**验证过安全**的落脚点（调用方用 assessStandingSpot 找好）。 */
    safeLanding: { x: number; y: number; z: number } | null;
    hasWaterBucket: boolean;
    /** 到下方介质/地面的距离（格），用于判断还有没有时间做 MLG。 */
    dropDistance: number | null;
}): FallRecoveryPlan {
    if (input.onSolidGround) {
        return { rung: 'brake', target: null, text: '脚下是实心地面——下坠恢复这条不触发。' };
    }
    const evidence = (): string => {
        const at = input.mediumAtY == null ? '' : `（y=${input.mediumAtY} 读到 ${input.mediumName ?? '?'}）`;
        switch (input.medium) {
            case 'lava':
                return `下方是**岩浆**${at}`;
            case 'water':
                return `下方是**水**${at}`;
            case 'void':
                return '下方是**虚空/一路空气**';
            case 'solid':
                return `下方 ${input.dropDistance ?? '?'} 格内有实心地面${at}`;
            default:
                return '下方介质**读不到**';
        }
    };

    // 虚空 / 读不到：保守，只刹车（这正是末地那四条命的教训）。
    if (input.medium === 'void' || input.medium === 'unknown') {
        return {
            rung: 'brake',
            target: null,
            text: `脚下没有实心方块/**正在下坠**：${evidence()} ⇒ **保守：只刹车**（横向平移在那里是死法；虚空没有落点，也不该赌"大概是水"）。`,
        };
    }

    // 岩浆/水：先找安全落点横移——这时候横移就是救命动作。
    if (input.safeLanding != null) {
        const dx = input.safeLanding.x - input.feet.x;
        const dz = input.safeLanding.z - input.feet.z;
        const meters = Math.hypot(dx, dz);
        return {
            rung: 'lateral',
            target: input.safeLanding,
            text: `${evidence()} ⇒ 刹车后**改朝 ${meters.toFixed(1)} 格外那块实心落点横移**（落点已验证可站立，不是岩浆/虚空）。`,
        };
    }

    // 没有安全落点：如果还有高度且带水桶，试 MLG；否则诚实说"试过了，没办法"。
    if (input.hasWaterBucket && (input.dropDistance == null || input.dropDistance >= 6)) {
        return {
            rung: 'mlg',
            target: null,
            text: `${evidence()}，可落脚的地方都没找到 ⇒ 试**水桶 MLG**（有桶；落地前一格倒水）。`,
        };
    }
    return {
        rung: 'brake',
        target: null,
        text: `脚下没有实心方块/**正在下坠**：${evidence()}，而且**没有可落脚的安全点${input.hasWaterBucket ? '' : '、也没有水桶'}** ⇒ 只刹车。已经试过横移/落地手段，都不成立；这不是"反射没管你"，是确实没有可落脚处。`,
    };
}

/** 目标格是不是**致死的**（岩浆/虚空/流体）——任何下坠恢复都不许朝那里移动。 */
export function isLethalDestination(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    target: { x: number; y: number; z: number },
): boolean {
    const spot = assessStandingSpot(blockAt, target.x, target.y, target.z);
    return !spot.ok;
}

/**
 * 同一条下坠/刹车回执**不要每 tick 重复播报**。
 *
 * 真机审计（2026-10-19）：「逃生**刹车**」在 overnight_b 的日志里出现 **152 次**、
 * A 里 54 次——内容一模一样的行被反复送给模型，正是 Lead 说的那种"说太多等于没说"。
 * 判据：**状态（档位+介质+目标）变了立刻说；没变则最多每 `minIntervalMs` 说一次。**
 */
export function shouldEmitFallNotice(
    prev: { key: string; at: number } | null,
    key: string,
    now: number,
    minIntervalMs = 5_000,
): boolean {
    if (prev == null) return true;
    if (prev.key !== key) return true;
    return now - prev.at >= Math.max(1, minIntervalMs);
}
