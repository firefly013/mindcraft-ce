/**
 * void 预检：**走路工具不许把 bot 走进没有支撑的空间**（Lead 2026-10-19 ②-3）。
 *
 * 真机 overnight_b：「末地：移动/保命都没有虚空检查，我已经因此摔死 2 次」。
 * 边界必须显式（不然会把"搭桥过坑"也禁掉，那是 A 唯一过末地缺口的办法）：
 *
 *   **走路工具（`move` / `goToCoordinates`）拒绝"必须跨越无支撑空间"的目标；
 *   搭桥工具（`travelTo` / `placeBlock`）才是过缺口的合法手段。**
 *
 * 另外：**已经在空中就不拦**——在空中是保命反射的事，走路拒绝帮不上忙，只会挡路。
 */
export type VoidProbe = (x: number, y: number, z: number) => { name?: unknown } | null;

const WALKING_TOOLS = new Set(['move', 'goToCoordinates']);

function isSolidName(name: unknown): boolean {
    const value = String(name ?? '');
    if (value === '') return false;
    return value !== 'air' && value !== 'cave_air' && value !== 'void_air';
}

/** 目标格下方（含自身往下 1..depth）有没有能站的支撑。 */
function hasSupport(blockAt: VoidProbe, x: number, y: number, z: number, depth = 4): boolean {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    for (let d = 1; d <= depth; d++) {
        if (isSolidName(blockAt(bx, by - d, bz)?.name)) return true;
    }
    return false;
}

export interface VoidWalkVerdict {
    refuse: boolean;
    /** 拒绝时给模型看的话（含替代方案）；不拒绝为 null。 */
    text: string | null;
}

/**
 * 走之前判一次：目标本身没支撑、或者直线路径上有一段的脚下是空的。
 * **只在"走路工具 + 不在空中"时生效**；其它工具原样放行。
 */
export function voidWalkVerdict(input: {
    tool: string;
    from: { x: number; y: number; z: number };
    to: { x: number; y: number; z: number };
    blockAt: VoidProbe;
    /** 已在空中（下坠/跳跃中）⇒ 不拦。 */
    airborne: boolean;
}): VoidWalkVerdict {
    const tool = String(input.tool ?? '');
    if (!WALKING_TOOLS.has(tool)) return { refuse: false, text: null };
    if (input.airborne) return { refuse: false, text: null };

    const from = input.from;
    const to = input.to;
    const blockAt = input.blockAt;

    // 目标自己脚下没东西 ⇒ 走过去就是悬空。这是最直接的一种。
    const targetSupported = hasSupport(blockAt, to.x, to.y, to.z);
    // 路径上有没有"跨过去"的缺口：沿水平直线按 1 格采样，看每个采样点的脚下。
    const dx = Number(to.x) - Number(from.x);
    const dz = Number(to.z) - Number(from.z);
    const horizontal = Math.hypot(dx, dz);
    const steps = Math.min(64, Math.max(1, Math.ceil(horizontal)));
    let gapAt: { x: number; z: number } | null = null;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = Number(from.x) + dx * t;
        const z = Number(from.z) + dz * t;
        if (!hasSupport(blockAt, x, Number(from.y), z)) {
            gapAt = { x, z };
            break;
        }
    }

    if (!targetSupported) {
        return {
            refuse: true,
            text:
                `**拒绝走**：目标 (${Math.round(Number(to.x))},${Math.round(Number(to.y))},${Math.round(Number(to.z))}) ` +
                '**脚下没有方块**（是空气/虚空）——走过去就是悬空。\n' +
                '    要走这种地方，用**搭桥工具**：`travelTo(...)`（会铺路/垫方块）或先 `placeBlock` 铺出落脚点，再用 `move`。',
        };
    }
    if (gapAt != null) {
        return {
            refuse: true,
            text:
                '**拒绝走**：这条直线路上有一段**没有支撑**' +
                `（大约 x=${Math.round(gapAt.x)} z=${Math.round(gapAt.z)} 附近是空中/虚空），` +
                '`move`/`goToCoordinates` 只会走、不会铺路，跨过去就是摔下去。\n' +
                '    过缺口用**搭桥工具**：`travelTo(...)`（会边铺边过）或先 `placeBlock` 铺一条路。',
        };
    }
    return { refuse: false, text: null };
}
