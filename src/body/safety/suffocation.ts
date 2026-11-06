/**
 * **窒息自救 + 垫块占位判定**（Lead 2026-10-21：`pillarUp(14)` 把方块放进自己身体里，
 * 血 19→0 憋死，损失 82 件）。
 *
 * 两条都是**便宜、无歧义**的判定：
 * - `cellIntersectsBody`：这一格会不会和 bot 的 AABB 相交（放块前必须为 false）；
 * - `planSuffocationEscape`：血在掉 + 脚/头那格是实心 ⇒ **就地挖开那一格**（不是逃跑）。
 * 读不到任何一项 ⇒ 不下结论（可为 null）。
 */
export interface BodyCell {
    x: number;
    y: number;
    z: number;
}

/** 玩家站立时的 AABB 半宽（原版 0.6 宽/1.8 高），留一点余量防"刚好贴边"。 */
export const BODY_HALF_WIDTH = 0.31;
export const BODY_HEIGHT = 1.81;

/**
 * 这一格和 bot 的身体相交吗（含 y 方向：脚格与头格都算）。
 * 放块前的**硬前置**：为 true 就绝不能放（方块会生成在身体里 ⇒ 窒息）。
 */
export function cellIntersectsBody(
    position: { x?: unknown; y?: unknown; z?: unknown } | null | undefined,
    cell: BodyCell | null | undefined,
): boolean | null {
    const px = Number(position?.x);
    const py = Number(position?.y);
    const pz = Number(position?.z);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
    if (cell == null || !Number.isFinite(cell.x) || !Number.isFinite(cell.y) || !Number.isFinite(cell.z)) return null;
    const overlapAxis = (center: number, half: number, cellMin: number): boolean =>
        center + half > cellMin && center - half < cellMin + 1;
    const overlapX = overlapAxis(px, BODY_HALF_WIDTH, cell.x);
    const overlapZ = overlapAxis(pz, BODY_HALF_WIDTH, cell.z);
    const overlapY = py + BODY_HEIGHT > cell.y && py < cell.y + 1;
    return overlapX && overlapY && overlapZ;
}

/** 站进这一格安全吗（脚格与头格都不与身体冲突且都不是实心）。null = 读不到。 */
export function standingRoomOk(
    feetBlock: string | null,
    headBlock: string | null,
): boolean | null {
    if (feetBlock == null || headBlock == null) return null;
    const solid = (name: string): boolean =>
        name !== '' && name !== 'air' && name !== 'cave_air' && name !== 'void_air' &&
        name !== 'water' && name !== 'flowing_water' && name !== 'lava' && name !== 'flowing_lava';
    return !solid(feetBlock) && !solid(headBlock);
}

export type SuffocationAction = 'break-feet' | 'break-head' | 'none';

export interface SuffocationPlan {
    action: SuffocationAction;
    reason: string;
}

/**
 * 窒息自救判据（纯函数）：
 * - 血在掉 + 脚格实心 ⇒ `break-feet`（先挖脚，脚空出来血就停）；
 * - 脚空但头格实心 ⇒ `break-head`；
 * - 血没在掉，或两格都读不到 ⇒ none（不许瞎挖）。
 * 注意：**与怪物无关**——被埋住时逃到远处没有意义，正确动作是挖开那一格。
 */
export function planSuffocationEscape(input: {
    healthDropped: boolean;
    feetBlock: string | null;
    headBlock: string | null;
}): SuffocationPlan {
    const solid = (name: string | null): boolean =>
        name != null && name !== '' && name !== 'air' && name !== 'cave_air' && name !== 'void_air' &&
        name !== 'water' && name !== 'flowing_water' && name !== 'lava' && name !== 'flowing_lava';
    if (input.feetBlock == null && input.headBlock == null) return { action: 'none', reason: 'unreadable' };
    // **"身体嵌在方块里"本身就是证据，不需要等血掉**（真机 2026-10-23）：
    // 以前只在 `healthDropped` 时才挖，于是 bot 卡进 1 格高的缝里、服务器又没扣血时
    // **永远出不来**——第三人称看到的就是"原地晃、对着方块空挥、脚下冒粒子"，
    // 每次动作都零位移。脚/头那格是实心 ⇒ 它站都站不下，这不是猜测。
    if (solid(input.feetBlock)) return { action: 'break-feet', reason: `脚那格是 ${input.feetBlock}` };
    if (solid(input.headBlock)) return { action: 'break-head', reason: `头那格是 ${input.headBlock}` };
    return { action: 'none', reason: input.healthDropped ? 'not-in-wall' : 'health-stable' };
}

/** 给模型看的自救回执（说清：我在方块里、哪一格、正在挖开）。 */
export function formatSuffocationReceipt(input: {
    position: BodyCell;
    which: '脚' | '头';
    blockName: string;
    health: number | null;
    broke: boolean;
}): string {
    const pos = `(${input.position.x}, ${input.position.y}, ${input.position.z})`;
    // **别把"卡住"写成"血在掉"**：不一定在掉血（有时服务器根本不扣血），
    // 回执只报测得到的事实——身体那格是实心、以及现在血是多少。
    const head = `我卡在方块里，${input.which}那一格是 ${input.blockName}，血量是 ${input.health ?? '读不到'}，我在 ${pos}。`;
    return input.broke ? head + '我已经把那一格挖开了。' : head + '我试着挖开那一格，但没有成功。';
}
