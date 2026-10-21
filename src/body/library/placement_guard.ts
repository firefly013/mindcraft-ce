/**
 * **放置验证 + 刚放下的方块不许被自己捡回**（Lead 2026-10-21，真机 overnight_b）：
 * `placeBlock` 回执「Placed furnace at (43, 56, 10)」，紧接着 autoPickup 把 furnace
 * 捡回背包，`stats blocks` 里根本没有 furnace ⇒ **放置没留在世界里，回执却说成功**。
 * 这条链解释了「Placed furnace 但那格是 air、熔炉又回到背包」以及"基地总是建不起来"。
 */
export type PlacementVerdict = 'ok' | 'placed-but-item-not-consumed' | 'block-missing' | 'uncertain';

/**
 * 放置是否真的成功。只认两项**测量**：
 * - `blockRead`：目标格现在读到的方块名（下方 caller 已做 waitForBlockAt）；
 * - 材料在背包里的数量 before/after（判断物品有没有被消耗）。
 *
 * 契约：
 * - 世界里没有该方块 ⇒ `block-missing`（**绝不能报成功**，要重试一次再说实话）；
 * - 世界里有了、但背包数量没减少 ⇒ `placed-but-item-not-consumed`（服务端延迟/复制风险：
 *   成功但必须写一句警告，且这个位置的掉落实体暂时别捡）；
 * - 方块名读不到 ⇒ `uncertain`。
 */
export function placementVerdict(input: {
    blockRead: string | null;
    /** 期望的方块裸名（去掉 `[facing=…]`、`wall_` 前缀归一化由调用方做）。 */
    expected: string;
    countBefore: number | null;
    countAfter: number | null;
}): PlacementVerdict {
    const read = input.blockRead == null ? '' : String(input.blockRead);
    if (read === '') return 'uncertain';
    const matches = read === input.expected || read.endsWith(input.expected) || input.expected.endsWith(read);
    if (!matches) return 'block-missing';
    if (input.countBefore != null && input.countAfter != null && input.countAfter >= input.countBefore) {
        return 'placed-but-item-not-consumed';
    }
    return 'ok';
}

/** 刚放下的方块，"掉落物"豁免窗口（毫秒）：足够覆盖服务端把它当实体推回来的延迟。 */
export const PLACED_DROP_GUARD_MS = 3_000;
export const PLACED_DROP_GUARD_RADIUS = 2;

interface PlacedRecord {
    name: string;
    x: number;
    y: number;
    z: number;
    until: number;
}

let placedRecords: PlacedRecord[] = [];

/** 放置前登记（技能层调用）：这一格刚放的东西不是"掉落物"。 */
export function markPlaced(name: string, position: { x?: unknown; y?: unknown; z?: unknown } | null | undefined, now = Date.now()): void {
    const x = Number(position?.x);
    const y = Number(position?.y);
    const z = Number(position?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    placedRecords = placedRecords.filter((record) => record.until > now).slice(-16);
    placedRecords.push({ name, x, y, z, until: now + PLACED_DROP_GUARD_MS });
}

/** 这个掉落物是不是"我刚放下的那个方块"？是的话拾取必须**静默跳过**（不抢占、不回执）。 */
export function isJustPlacedDrop(
    name: string,
    position: { x?: unknown; y?: unknown; z?: unknown } | null | undefined,
    now = Date.now(),
): boolean {
    const x = Number(position?.x);
    const y = Number(position?.y);
    const z = Number(position?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    placedRecords = placedRecords.filter((record) => record.until > now);
    return placedRecords.some(
        (record) =>
            (record.name === name || record.name.endsWith(name) || name.endsWith(record.name)) &&
            Math.hypot(record.x - x, record.z - z) <= PLACED_DROP_GUARD_RADIUS &&
            Math.abs(record.y - y) <= PLACED_DROP_GUARD_RADIUS,
    );
}

/** 测试用：清空登记表。 */
export function clearPlacedRecords(): void {
    placedRecords = [];
}

/**
 * `placeHere` 的回执（Lead 2026-10-21 ①）：**不许报计划，只报回读**。
 * `placeHere` 把"当前位置格"当目标——而当前位置格通常就是**身体所在格**，放进去必然被
 * 占位守卫拒绝（或根本放不上）。所以先把两种现实说清：
 * - 目标格与身体相交 ⇒ 直接说"这就是我现在站的位置"，给两条可执行替代；
 * - 否则按回读说成功/失败，不写"Placed"除非回读确认。
 */
export function formatPlaceHereReceipt(input: {
    /** placeBlock 的返回值。 */
    ok: boolean;
    target: { x: number; y: number; z: number };
    expected: string;
    /** 放置后目标格读回的方块名；读不到 = null。 */
    readBack: string | null;
    /** 目标格是否就是身体所在格（feet/head 占的那一格）。 */
    bodyCell: boolean;
}): string {
    const cell = `${input.target.x},${input.target.y},${input.target.z}`;
    const read = input.readBack == null ? '' : String(input.readBack);
    const matches = read !== '' && (read === input.expected || read.endsWith(input.expected) || input.expected.endsWith(read));
    if (input.bodyCell) {
        return (
            `**placeHere 放不下**：(${cell}) 就是我现在站的位置（feet/head 都在里面），方块放进去会被占位守卫拒绝。` +
            '改用：① 先跳起来在最高点放（pillarUp 会做），或 ② 用 placeBlock 指定旁边一格坐标（先 goToCoordinates 挪开也可以）。'
        );
    }
    if (input.ok && matches) {
        return `placeHere 确认：(${cell}) 现在是 ${read}（回读确认）。`;
    }
    return (
        `placeHere **没有生效**：(${cell}) 读到的是 ${read === '' ? '读不到' : read}，不是 ${input.expected}` +
        '——可能被 autoPickup 抢回/够不着/那一格不是空气；先用 stats 核对，再 placeBlock 重试。'
    );
}
