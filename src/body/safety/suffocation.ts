/**
 * **窒息自救 + 垫块占位判定**（Lead 2026-10-21：`pillarUp(14)` 把方块放进自己身体里，
 * 血 19→0 憋死，损失 82 件；在 Hard + keepInventory=false 里等于每小时重开一次）。
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
    if (!input.healthDropped) return { action: 'none', reason: 'health-stable' };
    if (input.feetBlock == null && input.headBlock == null) return { action: 'none', reason: 'unreadable' };
    if (solid(input.feetBlock)) return { action: 'break-feet', reason: `脚那格是 ${input.feetBlock}` };
    if (solid(input.headBlock)) return { action: 'break-head', reason: `头那格是 ${input.headBlock}` };
    return { action: 'none', reason: 'not-in-wall' };
}

/** 给模型看的自救回执（说清：我在方块里、哪一格、血在掉、正在挖开）。 */
export function formatSuffocationReceipt(input: {
    position: BodyCell;
    which: '脚' | '头';
    blockName: string;
    health: number | null;
    broke: boolean;
}): string {
    const pos = `(${input.position.x}, ${input.position.y}, ${input.position.z})`;
    const head = `**我在方块里**：${input.which}那格是 ${input.blockName}，血在掉（现在 ${input.health ?? '?'}）——我在 ${pos}。`;
    return input.broke
        ? head + '已经把那一格挖开了，血应该会停；继续挖/走之前先确认脚下和头顶是空的。'
        : head + '**挖开失败**：先 Stop 把身体拿回来，再用 mineBlock 挖脚/头那一格——别继续垫方块或往前挤。';
}
