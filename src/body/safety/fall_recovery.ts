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
    /** brake = 只停止平移（保守）；lateral = 朝安全落点横移；
     *  mlg = 准备水桶落地；place = 朝身边实心方块**在脚下垫一块**（末地虚空那档）。 */
    rung: 'brake' | 'lateral' | 'mlg' | 'place';
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
    /** 背包里有没有可垫的方块（末地虚空那一档要用它）。 */
    hasPlaceableBlocks?: boolean;
    /** 身边够得着的实心方块（垫脚要靠在它侧面）——必须是**已验证可站/实心**的。 */
    placeAgainst?: { x: number; y: number; z: number } | null;
    /** 到下方介质/地面的距离（格），用于判断还有没有时间做 MLG。 */
    dropDistance: number | null;
}): FallRecoveryPlan {
    if (input.onSolidGround) {
        return { rung: 'brake', target: null, text: '我脚下是实心地面，下坠恢复不会触发。' };
    }
    const evidence = (): string => {
        const at = input.mediumAtY == null ? '' : `，y=${input.mediumAtY} 那一格读到的方块是 ${input.mediumName ?? '?'}`;
        switch (input.medium) {
            case 'lava':
                return `下方是岩浆${at}`;
            case 'water':
                return `下方是水${at}`;
            case 'void':
                return '下方是虚空';
            case 'solid':
                return `下方 ${input.dropDistance ?? '?'} 格内有实心地面${at}`;
            default:
                return '下方是什么介质读不到';
        }
    };

    // 介质**读不到**：保守，只刹车。
    if (input.medium === 'unknown') {
        return {
            rung: 'brake',
            target: null,
            text: `我正在往下掉，${evidence()}，所以只刹车。`,
        };
    }

    if (
        input.medium === 'void' &&
        input.hasPlaceableBlocks === true &&
        input.placeAgainst != null
    ) {
        return {
            rung: 'place',
            target: input.placeAgainst,
            text: '我正在往下掉，下方是虚空，所以我在脚下垫了一块方块。',
        };
    }
    if (input.medium === 'void') {
        return {
            rung: 'brake',
            target: null,
            text:
                `我正在往下掉，${evidence()}` +
                (input.hasPlaceableBlocks === true ? '，旁边也没有可以依托的面' : '，背包里也没有能垫的方块') +
                '，所以只刹车。',
        };
    }

    // 岩浆/水：先找安全落点横移。
    if (input.safeLanding != null) {
        const dx = input.safeLanding.x - input.feet.x;
        const dz = input.safeLanding.z - input.feet.z;
        const meters = Math.hypot(dx, dz);
        return {
            rung: 'lateral',
            target: input.safeLanding,
            text: `${evidence()}，我刹车之后朝 ${meters.toFixed(1)} 格外那块实心落点横移。`,
        };
    }

    if (input.hasWaterBucket && (input.dropDistance == null || input.dropDistance >= 6)) {
        return {
            rung: 'mlg',
            target: null,
            text: `${evidence()}，没有找到能落脚的地方，我试着用水桶落地。`,
        };
    }
    return {
        rung: 'brake',
        target: null,
        text:
            `我正在往下掉，${evidence()}，没有能落脚的安全点` +
            `${input.hasWaterBucket ? '' : '，也没有水桶'}，所以只刹车。`,
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
