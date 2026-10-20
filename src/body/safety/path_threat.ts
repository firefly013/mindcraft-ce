/**
 * **走路前的路径威胁评估**（Lead 2026-10-21：A 血 10.6、背包 496 件含钻石镐，`useEntity`
 * 走 20 米去开箱子矿车，直线穿过三只苦力怕 ⇒ 被炸死，全丢）。
 *
 * 关键点：威胁**不在目的地**，而在**路上**。模型看不见跨回合的 11 米外苦力怕；引擎能。
 * 本模块只做判定与措辞，不做自动战斗：低血 + 路线旁有苦力怕 ⇒ **不直走**，把事实交给模型。
 */
export interface RouteThreat {
    name: string;
    x: number;
    z: number;
}

export const ROUTE_THREAT_RADIUS = 6;
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

/** 路线 `from→to` 旁（半径内）的敌对生物。只算水平距离——苦力怕/僵尸都是地面威胁。 */
export function threatsNearRoute(input: {
    from: { x: number; z: number };
    to: { x: number; z: number };
    hostiles: RouteThreat[];
    radius?: number;
}): Array<RouteThreat & { offRoute: number }> {
    const radius = input.radius ?? ROUTE_THREAT_RADIUS;
    return input.hostiles
        .map((hostile) => ({ ...hostile, offRoute: distanceToSegment(hostile, input.from, input.to) }))
        .filter((hostile) => hostile.offRoute <= radius)
        .sort((a, b) => a.offRoute - b.offRoute);
}

export interface RouteThreatVerdict {
    proceed: boolean;
    /** 路线旁的苦力怕（低血时会致命）。 */
    creepersOnRoute: number;
    message: string;
}

/**
 * 是否该走这条直线。规则（保守、可解释）：
 * - 血 > `LOW_HEALTH_FOR_CREEPER` ⇒ 允许（正常探索，不制造新墙）；
 * - 低血 + 路线上有苦力怕 ⇒ **不直走**，回执给三个可执行选项（绕路/先回血/放弃目标）。
 */
export function planRouteThreatResponse(input: {
    health: number | null;
    threats: Array<RouteThreat & { offRoute: number }>;
    from: { x: number; z: number };
    to: { x: number; z: number };
}): RouteThreatVerdict {
    const creepers = input.threats.filter((threat) => threat.name.toLowerCase().includes('creeper'));
    const health = input.health;
    const lowHealth = health != null && health <= LOW_HEALTH_FOR_CREEPER;
    if (!lowHealth || creepers.length === 0) {
        return { proceed: true, creepersOnRoute: creepers.length, message: '' };
    }
    const list = creepers
        .map((creeper) => `${creeper.name} @(${Math.round(creeper.x)}, ${Math.round(creeper.z)}) 离路线 ${creeper.offRoute.toFixed(1)} 格`)
        .join('、');
    return {
        proceed: false,
        creepersOnRoute: creepers.length,
        message:
            `**这条路我不直走**：从 (${Math.round(input.from.x)}, ${Math.round(input.from.z)}) 到 ` +
            `(${Math.round(input.to.x)}, ${Math.round(input.to.z)}) 的路上有 ${creepers.length} 只苦力怕（${list}），` +
            `而你血只有 ${health}——苦力怕炸一下就是一条命（这次会掉光背包）。` +
            '三个选择：① 先回血/吃食物；② 用 goToCoordinates 走**绕开它们**的方向再过去；' +
            '③ 放弃这个目标（命比箱子重要）。',
    };
}
