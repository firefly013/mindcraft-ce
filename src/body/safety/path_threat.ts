/**
 * **走路前的走廊威胁评估**（2026-10-21 事故：A 血 10.6、背包 496 件含钻石镐，`useEntity`
 * 走 20 米去开箱子矿车，直线穿过三只苦力怕 ⇒ 被炸死，全丢）。
 *
 * 关键点：威胁**不在目的地**，而在**路上**。模型看不见跨回合的 11 米外苦力怕；引擎能。
 *
 * ## 2026-10-30 修正：算的是"直线走廊"，不是"路线"
 *
 * 原来的判据把"到 from→to 线段的垂距"当成"离路线的距离"，并在 6 格内就拒绝直走。
 * 那是一个**几何谎言**：pathfinder 会绕墙、绕水、绕岩浆，实际路径跟直线可以差很远。
 * 于是它两头都错——拦掉了一条本来会绕开的路线，也放过了一条为了绕墙正好擦着怪过去的路线。
 *
 * 现在：
 *   - 只**陈述事实**："直线走廊 6 格内有 N 只苦力怕、最近离直线 X 格"，
 *     并写明"这不是你实际会走的路线"；
 *   - 只有**低血 + 苦力怕几乎压在线旁**（≤ `CORRIDOR_BLOCK_RADIUS`）才否决——
 *     这个距离下任何绕行都得是故意的，而不是寻路器顺手拐一下；
 *   - 否决时给**一条**可执行的最小恢复动作（先侧向走开再从那里过去），不给三选一菜单。
 *
 * 不做的两件事：不算真实路径（那要把 pathfinder 的 goal/movements 复制一份，
 * 而这个仓库最忌两处 `new Movements`——见 `safety/movements.ts` 开头），
 * 也不替模型决定"要不要冒险"。
 */
export interface RouteThreat {
    name: string;
    x: number;
    z: number;
}

/** 陈述事实用的走廊半径（格）。 */
export const CORRIDOR_WARN_RADIUS = 6;
/**
 * 否决用的走廊半径（格）。
 *
 * 3 格的含义：苦力怕的爆炸半径就在这个量级，贴到这么近时"绕开"不再可能顺带发生。
 * 6 格否决（旧行为）会把"路从另一边绕墙过去"的合法路线一起拦掉。
 */
export const CORRIDOR_BLOCK_RADIUS = 3;
/** 低于这个血量，苦力怕等于一枪毙命（爆炸 ~49 点，低血必死）。 */
export const LOW_HEALTH_FOR_CREEPER = 14;

/** 点到线段（水平面）的距离。 */
export function distanceToSegment(
    point: { x: number; z: number },
    from: { x: number; z: number },
    to: { x: number; z: number },
): number {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq === 0) return Math.hypot(point.x - from.x, point.z - from.z);
    let t = ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const px = from.x + t * dx;
    const pz = from.z + t * dz;
    return Math.hypot(point.x - px, point.z - pz);
}

/** 直线走廊 `from→to` 旁（半径内）的敌对生物。只算水平距离——苦力怕/僵尸都是地面威胁。 */
export function threatsNearCorridor(input: {
    from: { x: number; z: number };
    to: { x: number; z: number };
    hostiles: RouteThreat[];
    radius?: number;
}): Array<RouteThreat & { offLine: number }> {
    const radius = input.radius ?? CORRIDOR_WARN_RADIUS;
    return input.hostiles
        .map((hostile) => ({ ...hostile, offLine: distanceToSegment(hostile, input.from, input.to) }))
        .filter((hostile) => hostile.offLine <= radius)
        .sort((a, b) => a.offLine - b.offLine);
}

export interface CorridorVerdict {
    proceed: boolean;
    /** 直线走廊里的苦力怕数量（**不是**"路线上的"）。 */
    creepersNear: number;
    /** 非空 = 要写进回执的事实句；`proceed=true` 时也可能有（只是提醒）。 */
    message: string;
}

/**
 * 这条走廊要不要走。规则（窄、可解释）：
 * - 血 > `LOW_HEALTH_FOR_CREEPER` ⇒ 放行，不制造新墙；
 * - 低血但苦力怕离直线 > `CORRIDOR_BLOCK_RADIUS` ⇒ 放行 + 事实句（不替它判风险）；
 * - 低血且苦力怕压在直线旁 ⇒ 否决 + 一条最小恢复动作。
 */
export function corridorThreatVerdict(input: {
    health: number | null;
    threats: Array<RouteThreat & { offLine: number }>;
    from: { x: number; z: number };
    to: { x: number; z: number };
}): CorridorVerdict {
    const creepers = input.threats.filter((threat) => threat.name.toLowerCase().includes('creeper'));
    const health = input.health;
    const lowHealth = health != null && health <= LOW_HEALTH_FOR_CREEPER;
    if (!lowHealth || creepers.length === 0) {
        return { proceed: true, creepersNear: creepers.length, message: '' };
    }
    const list = creepers
        .map(
            (creeper) =>
                `有几只在 (${Math.round(creeper.x)}, ${Math.round(creeper.z)})，离这条直线 ${creeper.offLine.toFixed(1)} 格`,
        )
        .join('，');
    const head =
        `从 (${Math.round(input.from.x)}, ${Math.round(input.from.z)}) 到 ` +
        `(${Math.round(input.to.x)}, ${Math.round(input.to.z)}) 的直线走廊 ` +
        `${CORRIDOR_WARN_RADIUS} 格内发现了 ${creepers.length} 只苦力怕，${list}。你的血量是 ${health}。`;
    const blockers = creepers.filter((creeper) => creeper.offLine <= CORRIDOR_BLOCK_RADIUS);
    if (blockers.length === 0) {
        return { proceed: true, creepersNear: creepers.length, message: head };
    }
    return {
        proceed: false,
        creepersNear: creepers.length,
        message: head + `其中 ${blockers.length} 只离这条直线不到 ${CORRIDOR_BLOCK_RADIUS + 1} 格。`,
    };
}
