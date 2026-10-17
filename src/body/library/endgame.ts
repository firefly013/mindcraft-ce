/**
 * 末地通关：**纯决策逻辑层**（不 import mineflayer、不接受 bot）。
 *
 * 和环境里 `nether_portal.ts` 同一个套路：
 * - 这里只吃坐标 / 物品 / 状态这类普通数据，所以 `tests/endgame.test.ts` 不需要起
 *   MC 服务端，也不烧模型 token；
 * - 真正碰世界的那层（放方块、右键、喝药、走位）在 `endgame_routine.ts`，它只负责
 *   把这里算出来的 plan 变成 bot 动作。
 *
 * 数值全部来自 Minecraft Wiki，出处见 `docs/endgame/02-research.md`。凡是"经验模型 /
 * 待真机标定"的地方都显式写了标注，**不假装是官方数值**。
 */

// ============================ 一、常量（已核验，附出处） ============================

/** 进入末地时的落点：5×5 黑曜石平台中心 (100,49,0)，玩家面朝西。 */
export const END_PLATFORM = Object.freeze({ x: 100, y: 49, z: 0 });

/** 末地中央出口传送门（End podium）中心：龙死后飞到这里 (0,64,0)。 */
export const END_PODIUM = Object.freeze({ x: 0, y: 64, z: 0 });

/** 10 根黑曜石柱绕着出口传送门排成半径 42 格的圆。 */
export const END_PILLAR_RADIUS = 42;

/** 自然生成的水晶：共 10 颗，其中 2 颗被铁栏杆罩住。 */
export const END_CRYSTAL_TOTAL = 10;
export const END_CAGED_CRYSTAL_TOTAL = 2;

/** 爆炸威力：末地水晶 6（= 高压苦力怕），床 5。 */
export const EXPLOSION_POWER = Object.freeze({ endCrystal: 6, bed: 5 });

/** 末影龙 200 HP（100 心）。 */
export const DRAGON_MAX_HEALTH = 200;

export type Difficulty = 'easy' | 'normal' | 'hard';

/** 龙直接撞人：撞头 / 被翅膀扫到。Peaceful 下都是 0（但仍会做攻击动作）。 */
export const DRAGON_MELEE: Record<'head' | 'wing', Record<Difficulty, number>> = Object.freeze({
    head: { easy: 6, normal: 10, hard: 15 },
    wing: { easy: 3.5, normal: 5, hard: 7.5 },
});

/**
 * 龙息 / 龙火球的每秒伤害。
 *
 * Wiki 两处不一致：信息框写「龙息 3 HP/s、龙火球 6 HP/s」，教程页写「龙息 6 HP/s」。
 * 规划时**按较差的一档（6）算**，多留一倍安全余量。见 docs 的"待验证"清单。
 */
export const BREATH_DAMAGE_PER_SECOND = Object.freeze({ infobox: 3, tutorial: 6 });
export const BREATH_PLANNING_DPS = 6;

/** 龙息可见圆盘直径 5~6 格（半径≈2.5），真正掉血的伤害区只有中间 3~4 格（半径≈2）。 */
export const BREATH_CLOUD_RADIUS = 2.5;
export const BREATH_HARM_RADIUS = 2;

/** 龙低头停在传送门上时，只要 20 格内有玩家就会喷息（Peaceful 不喷）。 */
export const PERCH_BREATH_RANGE = 20;

/** 一张床最多打掉龙 1/4 血（50 HP）。 */
export const BED_DAMAGE_FRACTION_MAX = 0.25;

/** 拆掉"正在给龙回血"的水晶，会给龙 10 HP 伤害。 */
export const CRYSTAL_CHARGE_DAMAGE = 10;

/** 掉落物 5 分钟（6000 tick）后消失；但**只在所在区块被加载时才计时**。 */
export const ITEM_DESPAWN_SECONDS = 300;

/** 玩家满血 20 HP。 */
export const PLAYER_MAX_HEALTH = 20;

/** 在地表/平台上"躲不开爆炸"的安全距离：离开爆炸中心 2×power 格。 */
export function blastRadius(power: number): number {
    return 2 * power;
}

// ============================ 二、基础向量/数学 ============================

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export function vec(x: number, y: number, z: number): Vec3 {
    return { x, y, z };
}

export function distance(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function horizontalDistance(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dz * dz);
}

export function offset(a: Vec3, dx: number, dy: number, dz: number): Vec3 {
    return { x: a.x + dx, y: a.y + dy, z: a.z + dz };
}

export function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

/** 从 from 指向 to 的**水平**单位向量；两点重合时返回 (0,0)（不做除零）。 */
export function horizontalDirection(from: Vec3, to: Vec3): { dx: number; dz: number; length: number } {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length === 0 || !Number.isFinite(length)) return { dx: 0, dz: 0, length: 0 };
    return { dx: dx / length, dz: dz / length, length };
}

export function cellKey(p: Vec3): string {
    return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

// ============================ 三、爆炸伤害（官方公式） ============================
/**
 * Wiki「Explosion § Damage」给出的原始公式（**已核验**）：
 *
 *     impact = (1 - distance / (2*power)) * exposure
 *     damage = 7*power*(impact^2 + impact) + 1
 *
 * 两点必须记住：
 * - 只要距离 < 2*power，哪怕完全被挡住也**至少吃 1 点伤害**（末尾的 +1）；
 * - 距离 ≥ 2*power 时没有任何伤害。
 *
 * exposure 是"暴露度" 0~1：0 = 方块全挡住，1 = 一点遮蔽都没有。
 */
export function explosionImpact(power: number, distanceToBlast: number, exposure = 1): number {
    if (!(power > 0) || !(distanceToBlast >= 0)) return 0;
    if (distanceToBlast >= 2 * power) return 0;
    return (1 - distanceToBlast / (2 * power)) * clamp01(exposure);
}

export function explosionDamage(power: number, distanceToBlast: number, exposure = 1): number {
    if (!(power > 0) || !(distanceToBlast >= 0)) return 0;
    if (distanceToBlast >= 2 * power) return 0;
    const impact = explosionImpact(power, distanceToBlast, exposure);
    return 7 * power * (impact * impact + impact) + 1;
}

export interface DamageMitigation {
    /** 护甲点数 0~20（铁 15 / 钻石 20）。 */
    armorPoints?: number;
    /** 爆炸保护等级 0~4，每级 -8% 爆炸伤害。 */
    blastProtectionLevel?: number;
    /** 抗性提升等级 0~2，每级 -20% 伤害。 */
    resistanceLevel?: number;
    difficulty?: Difficulty;
}

/** 简化模型：护甲点数封顶 20，满 20 点 = -80%。真实公式对高伤害近似如此。 */
export function armorReduction(armorPoints = 0): number {
    return Math.min(20, Math.max(0, armorPoints)) / 25;
}

/** 爆炸保护：每级 -8%，4 级 -32%。 */
export function blastProtectionReduction(level = 0): number {
    return Math.min(4, Math.max(0, level)) * 0.08;
}

/** 抗性提升：每级 -20%，2 级 -40%。 */
export function resistanceReduction(level = 0): number {
    return Math.min(2, Math.max(0, level)) * 0.2;
}

/** 难度对"玩家受到的伤害"的换算（Wiki：Easy = min(d/2+1, d)，Hard = d*1.5）。 */
export function applyDifficulty(raw: number, difficulty: Difficulty = 'normal'): number {
    if (difficulty === 'easy') return Math.min(raw / 2 + 1, raw);
    if (difficulty === 'hard') return raw * 1.5;
    return raw;
}

/**
 * 玩家实际吃到多少爆炸伤害：原始公式 → 护甲 → 爆炸保护 → 抗性 → 难度。
 * 注意 Wiki 明确说 4 项是**分别结算**的，所以这里是乘算而不是加算。
 */
export function explosionDamageToPlayer(
    power: number,
    distanceToBlast: number,
    exposure = 1,
    mitigation: DamageMitigation = {}
): number {
    const raw = explosionDamage(power, distanceToBlast, exposure);
    if (raw <= 0) return 0;
    const afterArmor = raw * (1 - armorReduction(mitigation.armorPoints));
    const afterBlast = afterArmor * (1 - blastProtectionReduction(mitigation.blastProtectionLevel));
    const afterResistance = afterBlast * (1 - resistanceReduction(mitigation.resistanceLevel));
    return applyDifficulty(afterResistance, mitigation.difficulty ?? 'normal');
}

// ============================ 四、床炸龙 ============================
/**
 * 床炸龙的**经验模型（待真机标定）**。
 *
 * 已核验的一句话是：*"在龙停在出口传送门上时引爆炸床，最多打掉龙 1/4 血"*。
 * 官方没给"距离-伤害"曲线，所以这里用一个明确单调、且在 1 格内给满伤害的近似：
 * 距离 ≤ 1 格 = 满伤，1~3 格线性衰减到 0。
 */
export function bedDamageVsDragon(distanceToHead: number): number {
    if (!(distanceToHead >= 0)) return 0;
    if (distanceToHead <= 1) return DRAGON_MAX_HEALTH * BED_DAMAGE_FRACTION_MAX;
    if (distanceToHead >= 3) return 0;
    const falloff = 1 - (distanceToHead - 1) / 2;
    return DRAGON_MAX_HEALTH * BED_DAMAGE_FRACTION_MAX * falloff;
}

/** 打掉 health 点龙血要几张床（按每张满伤 50 算，向上取整）。 */
export function bedsNeeded(health: number): number {
    const perBed = DRAGON_MAX_HEALTH * BED_DAMAGE_FRACTION_MAX;
    if (!(health > 0)) return 0;
    return Math.ceil(health / perBed);
}

export type BedBombMethod = 'cover' | 'run';

export interface BedBombInput {
    /** 龙低头时头部所在格（水平距离才是关键）。 */
    dragonHead: Vec3;
    /** 玩家点床时脚站的格。 */
    standCell: Vec3;
    /** 床放哪一格。 */
    bedCell: Vec3;
    /** 玩家和床之间用来挡爆风的方块（"床边放一块方块挡头"那一步）。 */
    coverCells?: Vec3[];
    /** 是否躲在传送门结构/坑里（wiki 的"safest：钻进出口传送门再点床"）。 */
    inTrench?: boolean;
    /** 如果你**自己**填暴露度，用它覆盖下面的推断。 */
    exposure?: number;
    mitigation?: DamageMitigation;
    /** 你自己还剩多少血（默认满血 20）。 */
    health?: number;
}

export interface BedBombPlan {
    ok: boolean;
    method: BedBombMethod;
    /** 龙到床的距离。 */
    dragonDistance: number;
    expectedDragonDamage: number;
    bedsNeeded: number;
    /** 自己大概吃多少（原始 / 结算后）。 */
    selfRawDamage: number;
    selfFinalDamage: number;
    lethal: boolean;
    /** 'run' 方案要退到哪、退多远（blastRadius(5)=10 格）。 */
    retreat?: Vec3;
    retreatDistance: number;
    warnings: string[];
    reason: string;
}

/**
 * 规划一次床炸。**安全闸门**是硬的：
 * - 没掩体、又不退到 10 格外 → 直接判 lethal、ok=false，只报告不执行；
 * - 龙离床 > 3 格 → 打不动龙，白炸一次还把自己搭进去，也判 ok=false。
 */
export function planBedBombing(input: BedBombInput): BedBombPlan {
    const warnings: string[] = [];
    const power = EXPLOSION_POWER.bed;
    const dragonDistance = distance(input.bedCell, input.dragonHead);
    const expectedDragonDamage = bedDamageVsDragon(dragonDistance);

    const coverCells = input.coverCells ?? [];
    const hasCover = coverCells.length > 0 || input.inTrench === true;
    // 经验暴露度：有掩体/在坑里 0.15，完全裸奔 1。
    const exposure = input.exposure ?? (hasCover ? 0.15 : 1);
    const standDistance = distance(input.bedCell, input.standCell);
    const selfRawDamage = explosionDamage(power, standDistance, exposure);
    const selfFinalDamage = explosionDamageToPlayer(
        power,
        standDistance,
        exposure,
        input.mitigation ?? {}
    );
    const health = input.health ?? PLAYER_MAX_HEALTH;

    const method: BedBombMethod = hasCover ? 'cover' : 'run';
    const safeDistance = blastRadius(power);
    const retreatDistance = standDistance >= safeDistance ? standDistance : safeDistance;
    const { dx, dz, length } = horizontalDirection(input.bedCell, input.standCell);
    const retreat: Vec3 =
        length === 0
            ? offset(input.standCell, safeDistance, 0, 0)
            : offset(input.standCell, dx * (retreatDistance - length), 0, dz * (retreatDistance - length));

    if (dragonDistance > 3) {
        warnings.push(`床离龙头 ${dragonDistance.toFixed(1)} 格（>3）：打不掉多少血，别浪费床。`);
    }
    if (method === 'run' && standDistance < safeDistance) {
        warnings.push(`退路不够：你在爆炸中心 ${standDistance.toFixed(1)} 格内，必须先退到 ${safeDistance} 格外。`);
    }
    if (selfFinalDamage >= 6) {
        warnings.push(`预计自伤 ${selfFinalDamage.toFixed(1)} HP——超过 6 点就要重新找掩体。`);
    }
    if (input.inTrench !== true && coverCells.length === 0) {
        warnings.push('没有掩体也没钻进传送门结构：床炸几乎是自杀。');
    }

    const lethal = selfFinalDamage >= health;
    const enoughRoom = method === 'cover' || standDistance >= safeDistance || retreatDistance >= safeDistance;
    const ok = !lethal && enoughRoom && expectedDragonDamage > 0;

    const reason = !ok
        ? lethal
            ? `床炸会打死自己（预计 ${selfFinalDamage.toFixed(1)} HP ≥ ${health} HP），需要掩体或先退到 ${safeDistance} 格外。`
            : expectedDragonDamage <= 0
                ? `床离龙头 ${dragonDistance.toFixed(1)} 格太远，打不到龙。`
                : `退路 ${standDistance.toFixed(1)} 格不够安全（要 ≥ ${safeDistance} 格）。`
        : method === 'cover'
            ? `有掩体（暴露度 ${exposure}），预计打掉龙 ${expectedDragonDamage.toFixed(0)} HP、自伤 ${selfFinalDamage.toFixed(1)} HP。`
            : `点完床立刻沿远离床的方向退到 ${safeDistance} 格外，预计打掉龙 ${expectedDragonDamage.toFixed(0)} HP。`;

    return {
        ok,
        method,
        dragonDistance,
        expectedDragonDamage,
        bedsNeeded: bedsNeeded(DRAGON_MAX_HEALTH),
        selfRawDamage,
        selfFinalDamage,
        lethal,
        retreat,
        retreatDistance,
        warnings,
        reason,
    };
}

// ============================ 五、躲龙息 ============================
export interface BreathCloud {
    position: Vec3;
    /** 伤害半径，默认用 BREATH_HARM_RADIUS。 */
    radius?: number;
    /** 已经存在几秒（云只活 3 秒）。 */
    ageSeconds?: number;
}

export interface BreathEscape {
    inside: boolean;
    /** 最近的云到玩家的水平距离。 */
    nearestCloudDistance: number;
    /** 离传送门多远（<20 且龙在低头 → 会再吃一发）。 */
    podiumDistance: number;
    dangerFromPerch: boolean;
    /** 往哪走：目标格（脚位）。 */
    escapeTarget: Vec3;
    /** 要移动的方向（水平单位向量）。 */
    escapeDirection: { dx: number; dz: number };
    distanceToMove: number;
    urgency: 'none' | 'move' | 'sprint';
    reason: string;
}

const EIGHT_WAYS: Array<{ dx: number; dz: number }> = [
    { dx: 1, dz: 0 },
    { dx: 0, dz: 1 },
    { dx: -1, dz: 0 },
    { dx: 0, dz: -1 },
    { dx: Math.SQRT1_2, dz: Math.SQRT1_2 },
    { dx: -Math.SQRT1_2, dz: Math.SQRT1_2 },
    { dx: Math.SQRT1_2, dz: -Math.SQRT1_2 },
    { dx: -Math.SQRT1_2, dz: -Math.SQRT1_2 },
];

/**
 * 龙息云是"一桶高、直径 5~6 格"的圆盘，掉血区只有中间 3~4 格。
 * 这里把云当成圆柱（y 差 ≤ 1 才算同一层），沿 8 个方向各试探 4 格，
 * 挑一个**离所有云最远**的格子走。
 */
export function planBreathEscape(input: {
    self: Vec3;
    clouds: BreathCloud[];
    /** 龙是否正低头停在传送门上（决定 20 格规则是否生效）。 */
    dragonPerched?: boolean;
    /** 一次移动的试探半径，默认 4 格。 */
    stepDistance?: number;
}): BreathEscape {
    const step = input.stepDistance ?? 4;
    const harmRadiusOf = (cloud: BreathCloud): number => cloud.radius ?? BREATH_HARM_RADIUS;

    const onSameLayer = (cloud: BreathCloud): boolean => Math.abs(cloud.position.y - input.self.y) <= 1;
    const clearanceAt = (p: Vec3): number => {
        let min = Infinity;
        for (const cloud of input.clouds) {
            if (!onSameLayer(cloud)) continue;
            min = Math.min(min, horizontalDistance(p, cloud.position) - harmRadiusOf(cloud));
        }
        return min === Infinity ? Infinity : min;
    };

    // 只有和玩家同一层的云才算数（云是"一桶高"的圆盘，头顶那团淋不到你）。
    const sameLayer = input.clouds.filter(onSameLayer);
    const nearest = sameLayer.reduce<number>(
        (acc, cloud) => Math.min(acc, horizontalDistance(input.self, cloud.position) - harmRadiusOf(cloud)),
        Infinity
    );
    const nearestCloudDistance = Number.isFinite(nearest) ? nearest : Infinity;
    const inside = nearestCloudDistance < 0;

    let best: { dx: number; dz: number; clearance: number } = { dx: 0, dz: 0, clearance: clearanceAt(input.self) };
    for (const dir of EIGHT_WAYS) {
        const candidate = offset(input.self, dir.dx * step, 0, dir.dz * step);
        const clearance = clearanceAt(candidate);
        if (clearance > best.clearance) best = { dx: dir.dx, dz: dir.dz, clearance };
    }

    const escapeTarget = offset(input.self, best.dx * step, 0, best.dz * step);
    const podiumDistance = horizontalDistance(input.self, END_PODIUM);
    const dragonPerched = input.dragonPerched === true;
    const dangerFromPerch = dragonPerched && podiumDistance < PERCH_BREATH_RANGE;

    let urgency: BreathEscape['urgency'] = 'none';
    let reason = `周围没有龙息云（最近 ${Number.isFinite(nearestCloudDistance) ? nearestCloudDistance.toFixed(1) : '∞'} 格）。`;
    if (inside) {
        urgency = 'sprint';
        reason = `正站在龙息掉血区里（离云心 ${(nearestCloudDistance + BREATH_HARM_RADIUS).toFixed(1)} 格），立刻往 (${Math.round(escapeTarget.x)},${Math.round(escapeTarget.z)}) 方向冲刺。`;
    } else if (dangerFromPerch) {
        urgency = 'move';
        reason = `龙正低头停在传送门上，而你在它 ${podiumDistance.toFixed(1)} 格内（<${PERCH_BREATH_RANGE}）——下一发龙息就是冲你来的，先撤出 ${PERCH_BREATH_RANGE} 格。`;
    } else if (Number.isFinite(nearestCloudDistance) && nearestCloudDistance < step) {
        urgency = 'move';
        reason = `最近的龙息云还剩 ${nearestCloudDistance.toFixed(1)} 格余量，先挪开。`;
    }

    return {
        inside,
        nearestCloudDistance,
        podiumDistance,
        dangerFromPerch,
        escapeTarget,
        escapeDirection: { dx: best.dx, dz: best.dz },
        distanceToMove: urgency === 'none' ? 0 : step,
        urgency,
        reason,
    };
}

// ============================ 六、掩体：躲到柱子后面 ============================
export interface CoverPlan {
    ok: boolean;
    /** 用来挡龙的柱子中心（取柱子底面坐标）。 */
    pillar?: Vec3;
    /** 建议站/蹲的格子：柱子背面、远离龙的那一侧。 */
    hideCell?: Vec3;
    pillarDistance: number;
    reason: string;
}

/**
 * 用黑曜石柱当掩体挡冲锋和龙火球：站在**柱子背面**（远离龙的那一侧）。
 * 纯几何：hideCell = pillar + normalize(pillar - dragon) * 1.5。
 */
export function planPillarCover(input: {
    self: Vec3;
    dragon: Vec3;
    pillars: Vec3[];
    /** 只考虑这个半径内的柱子。 */
    maxDistance?: number;
}): CoverPlan {
    const maxDistance = input.maxDistance ?? 32;
    let best: { pillar: Vec3; d: number } | null = null;
    for (const pillar of input.pillars) {
        const d = horizontalDistance(input.self, pillar);
        if (d > maxDistance) continue;
        if (best == null || d < best.d) best = { pillar, d };
    }
    if (best == null) {
        return { ok: false, pillarDistance: Infinity, reason: `周围 ${maxDistance} 格内没有黑曜石柱，找不到掩体——用随身方块现搭一堵墙。` };
    }
    const { dx, dz } = horizontalDirection(input.dragon, best.pillar);
    const hideCell = offset(best.pillar, dx * 1.5, 0, dz * 1.5);
    return {
        ok: true,
        pillar: best.pillar,
        hideCell,
        pillarDistance: best.d,
        reason: `躲到 (${Math.round(best.pillar.x)},${Math.round(best.pillar.z)}) 那根柱子的背面，站 (${Math.round(hideCell.x)},${Math.round(hideCell.z)})，让柱子挡在龙和你之间。`,
    };
}

// ============================ 七、拆水晶 ============================
export type CrystalMethod = 'shoot' | 'tnt_cage' | 'climb_cage';

export interface EndCrystalInfo {
    id?: string | number;
    position: Vec3;
    /** 是否被铁栏杆罩住（贴身拆不掉、要从外面打）。 */
    caged?: boolean;
    /** 柱子顶大概多高，用来估"这个目标好不好打"。 */
    pillarTopY?: number;
    alive?: boolean;
}

export interface CrystalTarget {
    crystal: EndCrystalInfo;
    method: CrystalMethod;
    distance: number;
    /** 推荐站位（射程内、且在爆炸半径之外）。 */
    standPoint: Vec3;
    /** 站在这里拆安全吗。 */
    safeDistance: boolean;
    risk: 'low' | 'medium' | 'high';
    note: string;
}

export interface CrystalAssaultPlan {
    targets: CrystalTarget[];
    total: number;
    cagedCount: number;
    /** 爆炸威力，提醒调用方保持距离。 */
    explosionPower: number;
    safeShootDistance: number;
    message: string;
}

/**
 * 拆水晶的顺序与打法。
 *
 * 已核验的取舍：
 * - 水晶爆炸威力 6，**水只能挡爆风、挡不住伤害和击退**，所以靠的是距离（≥12 格）而不是水；
 * - 笼子里那两颗从地面打不进去，要么贴脸拆铁栏杆（危险），要么从笼子顶上放 TNT（较安全）；
 * - 只要还剩一颗水晶，龙就能持续回血 → 必须**全部拆完再贴脸打龙**。
 */
export function planCrystalAssault(input: {
    crystals: EndCrystalInfo[];
    self: Vec3;
    hasPickaxe?: boolean;
    tntCount?: number;
    /** 你打算站的安全射程，默认 12（= blastRadius(6)）。 */
    shootDistance?: number;
}): CrystalAssaultPlan {
    const safeShootDistance = input.shootDistance ?? blastRadius(EXPLOSION_POWER.endCrystal);
    const pickaxe = input.hasPickaxe === true;
    const tntCount = input.tntCount ?? 0;
    const alive = input.crystals.filter((c) => c.alive !== false);

    const scored = alive.map((crystal) => {
        const d = horizontalDistance(input.self, crystal.position);
        return { crystal, d };
    });

    // 先拆"能从地面直接射"的（近的优先，早拆一颗龙就早停止局部回血），笼子里的留到最后。
    const exposed = scored.filter((s) => s.crystal.caged !== true).sort((a, b) => a.d - b.d);
    const caged = scored.filter((s) => s.crystal.caged === true).sort((a, b) => a.d - b.d);

    const targets: CrystalTarget[] = [];
    for (const { crystal, d } of [...exposed, ...caged]) {
        const isCaged = crystal.caged === true;
        let method: CrystalMethod = 'shoot';
        let risk: CrystalTarget['risk'] = 'low';
        let note = '从地面射：找能看见水晶的角度，往水晶上沿瞄。';

        if (isCaged) {
            if (tntCount > 0) {
                method = 'tnt_cage';
                risk = 'medium';
                note = '笼中水晶：在铁栏杆顶上放 1 个 TNT 点燃，然后立刻后撤/珍珠位移，别贴身。';
            } else if (pickaxe) {
                method = 'climb_cage';
                risk = 'high';
                note = '笼中水晶：得先上柱子拆栏杆再打；上去要带缓降药水，不然被龙扫下来就是摔死。';
            } else {
                method = 'climb_cage';
                risk = 'high';
                note = '笼中水晶：既没 TNT 也没镐 → 现在拆不掉。先去拿 TNT 或镐。';
            }
        } else if (crystal.pillarTopY != null && crystal.pillarTopY - input.self.y > 24) {
            risk = 'medium';
            note = '这根柱子很高，仰角大、箭容易歪；可以先用别的柱子垫高再从更高的点射。';
        }

        // 推荐站位：沿"水晶→我"的方向退到安全射程外（纯几何，落地是否可站由调用方校验）。
        const dir = horizontalDirection(crystal.position, input.self);
        const standPoint: Vec3 =
            dir.length === 0
                ? offset(input.self, safeShootDistance, 0, 0)
                : offset(crystal.position, dir.dx * safeShootDistance, 0, dir.dz * safeShootDistance);

        targets.push({
            crystal,
            method,
            distance: d,
            standPoint,
            safeDistance: d >= safeShootDistance,
            risk,
            note,
        });
    }

    const cagedCount = caged.length;
    const message =
        alive.length === 0
            ? '水晶已经全拆完了，可以直接打龙。'
            : `还有 ${alive.length} 颗水晶（笼中 ${cagedCount} 颗）。先射地面能打到的，笼中的留到最后用 TNT / 上柱子处理；` +
              `每颗爆炸威力 ${EXPLOSION_POWER.endCrystal}，站到 ${safeShootDistance} 格外再打。`;

    return {
        targets,
        total: alive.length,
        cagedCount,
        explosionPower: EXPLOSION_POWER.endCrystal,
        safeShootDistance,
        message,
    };
}

// ============================ 八、装备检查 ============================
export interface EffectInfo {
    /** 归一化后的效果名（小写、空格换成下划线），如 'slow_falling'。 */
    name: string;
    /** 剩余秒数；读不到给 null。 */
    seconds: number | null;
    amplifier: number;
}

export const POTION_KINDS = [
    'slow_falling',
    'resistance',
    'regeneration',
    'healing',
    'strength',
    'fire_resistance',
    'swiftness',
    'other',
] as const;
export type PotionKind = (typeof POTION_KINDS)[number];

/** 归一化物品/效果名：去 `minecraft:`、小写、空格与连字符换成下划线。 */
export function normalizeName(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return raw.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
}

/**
 * 从多种 NBT/组件形状里挖出药水 id。
 * 兼容：1.20.4 及以前的 `nbt.value.Potion`、1.20.5+ 的 `potion_contents` 组件、
 * 以及 prismarine-item 直接摊平的 `item.potion`。
 */
export function potionIdOf(item: any): string | null {
    if (item == null || typeof item !== 'object') return null;
    if (typeof item.potion === 'string') return normalizeName(item.potion);

    const nbtPotion = item.nbt?.value?.Potion;
    if (typeof nbtPotion === 'string') return normalizeName(nbtPotion);
    if (typeof nbtPotion?.value === 'string') return normalizeName(nbtPotion.value);

    const componentPotion = item.components?.potion_contents?.potion;
    if (typeof componentPotion === 'string') return normalizeName(componentPotion);

    if (Array.isArray(item.components)) {
        for (const component of item.components) {
            if (component?.type === 'potion_contents' && typeof component?.data?.potion === 'string') {
                return normalizeName(component.data.potion);
            }
        }
    }
    return null;
}

/** 把一个物品归到药水大类；不是药水/牛奶就返回 null。 */
export function potionKindOf(item: any): PotionKind | 'milk' | null {
    const name = normalizeName(item?.name);
    if (name === 'milk_bucket') return 'milk';
    if (!name.includes('potion')) return null;
    const id = potionIdOf(item);
    if (id == null) return 'other';
    // 注意顺序：`strong_healing` 要落在 healing，`long_slow_falling` 落在 slow_falling。
    if (id.includes('slow_falling')) return 'slow_falling';
    if (id.includes('fire_resistance')) return 'fire_resistance';
    if (id.includes('regeneration')) return 'regeneration';
    if (id.includes('resistance') || id.includes('turtle_master')) return 'resistance';
    if (id.includes('healing')) return 'healing';
    if (id.includes('strength')) return 'strength';
    if (id.includes('swiftness')) return 'swiftness';
    return 'other';
}

/** 按大类在物品列表里找第一瓶药水/牛奶。 */
export function findPotionItem(items: any[], kind: PotionKind | 'milk'): any | null {
    if (!Array.isArray(items)) return null;
    for (const item of items) {
        if (potionKindOf(item) === kind) return item;
    }
    return null;
}

export interface PotionStock {
    slow_falling: number;
    resistance: number;
    regeneration: number;
    healing: number;
    strength: number;
    fire_resistance: number;
    swiftness: number;
    other: number;
    milk: number;
}

export function potionStock(items: any[]): PotionStock {
    const stock: PotionStock = {
        slow_falling: 0,
        resistance: 0,
        regeneration: 0,
        healing: 0,
        strength: 0,
        fire_resistance: 0,
        swiftness: 0,
        other: 0,
        milk: 0,
    };
    if (!Array.isArray(items)) return stock;
    for (const item of items) {
        const kind = potionKindOf(item);
        if (kind == null) continue;
        stock[kind] += 1;
    }
    return stock;
}

export interface EndGearInput {
    /** world.getInventoryCounts(bot) 的结果：物品名 → 数量。 */
    inventory: Record<string, number>;
    /** bot.inventory.items() 的原始物品，用来读药水 NBT。 */
    items?: any[];
    /** 当前身上的 Buff。 */
    effects?: EffectInfo[];
    armorPoints?: number;
}

export interface GearCheck {
    key: string;
    label: string;
    have: number;
    need: number;
    ok: boolean;
    note?: string;
}

export interface EndGearAssessment {
    ok: boolean;
    /** 硬缺口：缺了就不该进末地。 */
    fatal: string[];
    warnings: string[];
    checks: GearCheck[];
    message: string;
}

/** 末地清单默认门槛。数值是"够打完一场"的量，不是"理论最少"。 */
export const END_GEAR_REQUIREMENTS = Object.freeze({
    beds: 4,
    blocks: 64,
    waterBuckets: 1,
    slowFalling: 2,
    milk: 1,
    resistance: 1,
    regeneration: 1,
    goldenApples: 2,
    arrows: 32,
    food: 8,
    enderPearls: 4,
    pickaxe: 1,
});

/** 能当平台/掩体/垫脚用的方块。 */
export const PLATFORM_BLOCKS: readonly string[] = Object.freeze([
    'obsidian',
    'end_stone',
    'cobblestone',
    'stone',
    'deepslate',
    'dirt',
    'netherrack',
    'blackstone',
    'andesite',
    'granite',
    'diorite',
    'sandstone',
    'oak_planks',
    'birch_planks',
]);

/** 能顶饱的食物（只列常见几种，够用就行）。 */
export const FOOD_ITEMS: readonly string[] = Object.freeze([
    'cooked_beef',
    'cooked_porkchop',
    'cooked_chicken',
    'cooked_mutton',
    'cooked_rabbit',
    'cooked_salmon',
    'cooked_cod',
    'bread',
    'golden_carrot',
    'baked_potato',
    'apple',
    'carrot',
    'melon_slice',
    'sweet_berries',
    'beef',
    'porkchop',
    'chicken',
    'mutton',
]);

function countNames(inventory: Record<string, number>, predicate: (name: string) => boolean): number {
    let total = 0;
    for (const [rawName, rawCount] of Object.entries(inventory)) {
        const name = normalizeName(rawName);
        const count = Number.isFinite(rawCount) ? Math.max(0, rawCount) : 0;
        if (predicate(name)) total += count;
    }
    return total;
}

export function countBedsIn(inventory: Record<string, number>): number {
    // 小心：不能写成 name.includes('bed')，那样 `bedrock` 会被算成床。
    return countNames(inventory, (name) => /(^|_)bed$/.test(name));
}

export function hasActiveEffect(effects: EffectInfo[] | undefined, kind: string): boolean {
    if (!Array.isArray(effects)) return false;
    const wanted = normalizeName(kind);
    return effects.some((e) => normalizeName(e.name).includes(wanted));
}

export function activeEffectSeconds(effects: EffectInfo[] | undefined, kind: string): number | null {
    if (!Array.isArray(effects)) return null;
    const wanted = normalizeName(kind);
    let best: number | null = null;
    for (const e of effects) {
        if (!normalizeName(e.name).includes(wanted)) continue;
        if (e.seconds == null) continue;
        best = best == null ? e.seconds : Math.max(best, e.seconds);
    }
    return best;
}

/**
 * 进末地前的装备检查。**硬缺口（fatal）只有一条**：既没有方块、又没有能伤龙的手段。
 * 血量类（缓降/再生/金苹果/牛奶）缺失只降级为警告 —— 但警告里会写清楚后果。
 */
export function assessEndGear(input: EndGearInput): EndGearAssessment {
    const inventory = input.inventory ?? {};
    const items = input.items ?? [];
    const stock = potionStock(items);
    const effects = input.effects ?? [];
    const req = END_GEAR_REQUIREMENTS;

    const beds = countBedsIn(inventory);
    const blocks = countNames(inventory, (name) => PLATFORM_BLOCKS.includes(name));
    const waterBuckets = countNames(inventory, (name) => name === 'water_bucket');
    const arrows = countNames(inventory, (name) => name === 'arrow' || name === 'spectral_arrow' || name === 'tipped_arrow');
    const bows = countNames(inventory, (name) => name === 'bow' || name === 'crossbow');
    const goldenApples = countNames(inventory, (name) => name === 'golden_apple' || name === 'enchanted_golden_apple');
    const food = countNames(inventory, (name) => FOOD_ITEMS.includes(name));
    const enderPearls = countNames(inventory, (name) => name === 'ender_pearl');
    const pickaxes = countNames(inventory, (name) => name.endsWith('_pickaxe'));
    const tnt = countNames(inventory, (name) => name === 'tnt');
    const totems = countNames(inventory, (name) => name === 'totem_of_undying');

    const slowFallingActive = hasActiveEffect(effects, 'slow_falling');
    const resistanceActive = hasActiveEffect(effects, 'resistance');
    const regenerationActive = hasActiveEffect(effects, 'regeneration');
    const slowFallingHave = stock.slow_falling + (slowFallingActive ? 1 : 0);

    const checks: GearCheck[] = [
        { key: 'beds', label: '床（炸龙用）', have: beds, need: req.beds, ok: beds >= req.beds },
        { key: 'blocks', label: '方块（平台/掩体/垫脚）', have: blocks, need: req.blocks, ok: blocks >= req.blocks },
        { key: 'water', label: '水桶', have: waterBuckets, need: req.waterBuckets, ok: waterBuckets >= req.waterBuckets },
        {
            key: 'slow_falling',
            label: '缓降药水（防摔死，最高优先级）',
            have: slowFallingHave,
            need: req.slowFalling,
            ok: slowFallingHave >= req.slowFalling,
        },
        { key: 'milk', label: '牛奶桶（清负面 Buff）', have: stock.milk, need: req.milk, ok: stock.milk >= req.milk },
        {
            key: 'resistance',
            label: '抗性提升药水',
            have: stock.resistance + (resistanceActive ? 1 : 0),
            need: req.resistance,
            ok: stock.resistance + (resistanceActive ? 1 : 0) >= req.resistance,
        },
        {
            key: 'regeneration',
            label: '再生药水',
            have: stock.regeneration + (regenerationActive ? 1 : 0),
            need: req.regeneration,
            ok: stock.regeneration + (regenerationActive ? 1 : 0) >= req.regeneration,
        },
        { key: 'golden_apple', label: '金苹果', have: goldenApples, need: req.goldenApples, ok: goldenApples >= req.goldenApples },
        { key: 'bow', label: '弓/弩（拆水晶）', have: bows, need: 1, ok: bows >= 1 },
        { key: 'arrows', label: '箭', have: arrows, need: req.arrows, ok: arrows >= req.arrows },
        { key: 'food', label: '食物', have: food, need: req.food, ok: food >= req.food },
        { key: 'ender_pearl', label: '末影珍珠（被掀飞时自救/位移）', have: enderPearls, need: req.enderPearls, ok: enderPearls >= req.enderPearls },
        { key: 'pickaxe', label: '镐（拆铁栏杆）', have: pickaxes, need: req.pickaxe, ok: pickaxes >= req.pickaxe },
    ];

    const checkByKey = new Map(checks.map((c) => [c.key, c] as const));
    const checkOk = (key: string): boolean => checkByKey.get(key)?.ok === true;

    const fatal: string[] = [];
    const warnings: string[] = [];

    const canDamageDragon = beds > 0 || tnt > 0 || (bows > 0 && arrows > 0);
    if (!canDamageDragon) fatal.push('没有任何能伤龙的手段（没床、没 TNT、也没有弓+箭）。');
    if (blocks <= 0) fatal.push('一个方块都没有：连落点/掩体都搭不出来。');

    if (!checkOk('slow_falling')) {
        warnings.push(
            `没带够缓降药水（有 ${slowFallingHave}，建议 ${req.slowFalling}）：龙的翅膀会把你掀到几十格高空，` +
                '没有缓降时摔死是末地最常见死法。'
        );
    }
    if (!checkOk('resistance')) warnings.push('没有抗性提升药水：爆炸和撞伤都按满额吃。');
    if (!checkOk('regeneration')) warnings.push('没有再生药水：龙息间隙回不满血，容易被连招带走。');
    if (!checkOk('milk')) warnings.push('没有牛奶桶：中了负面效果只能等它自己过期。');
    if (totems > 0) warnings.push(`带了 ${totems} 个不死图腾——记得拿在手上/副手，触发后立刻换第二个。`);
    if (input.armorPoints != null && input.armorPoints < 15) {
        warnings.push(`护甲只有 ${input.armorPoints} 点（钻石套是 20），爆炸里很吃亏。`);
    }

    const ok = fatal.length === 0;
    const message = ok
        ? `进末地前的清单没有硬缺口（缺 ${checks.filter((c) => !c.ok).length} 项建议装备，看 warnings）。`
        : `还差关键装备，**先别进末地**：${fatal.join('')}`;

    return { ok, fatal, warnings, checks, message };
}

// ============================ 九、死亡后回收 ============================
export interface RecoveryInput {
    /** 死在哪个维度：'the_end' / 'overworld' / 'the_nether'。 */
    deathDimension: string;
    deathPosition: Vec3;
    /** 重生点（床/重生锚坐标）。没有就给 null。 */
    respawnPoint?: Vec3 | null;
    /** 主世界里那个已激活的末地传送门坐标（进末地时记下来的）。 */
    overworldPortal?: Vec3 | null;
    /** 死了多久（秒）。 */
    secondsSinceDeath: number;
    /** 尸体所在区块是否有人（有人=物品在倒计时）。 */
    chunkLoadedSinceDeath?: boolean;
    /** 是否死在下界/末地的虚空里（掉出去了）。 */
    fellOutOfWorld?: boolean;
}

export interface RecoveryPlan {
    /** 物品还在的概率：high / medium / lost。 */
    itemOutlook: 'high' | 'medium' | 'lost';
    /** 还能安全回收的剩余秒数；null = 不确定（区块没加载就不倒计时）。 */
    secondsLeft: number | null;
    steps: string[];
    message: string;
}

/**
 * 死亡回收。已核验的两条关键机制：
 * 1. 末地**离开后状态不变**（末地传送门一直亮着），所以可以原路再进去捡尸；
 * 2. 掉落物 5 分钟消失，**但只在区块被加载时才计时**——尸体旁边没人，它就不倒计时。
 */
export function planRecovery(input: RecoveryInput): RecoveryPlan {
    const steps: string[] = [];
    const dimension = normalizeName(input.deathDimension);

    if (input.fellOutOfWorld === true) {
        steps.push('死因是掉进虚空：东西跟着你一起没了，别去捡，直接按下面的步骤重新备战。');
    }

    const secondsLeft = input.chunkLoadedSinceDeath === true ? Math.max(0, ITEM_DESPAWN_SECONDS - input.secondsSinceDeath) : null;

    let itemOutlook: RecoveryPlan['itemOutlook'];
    if (input.fellOutOfWorld === true) itemOutlook = 'lost';
    else if (secondsLeft != null && secondsLeft <= 0) itemOutlook = 'lost';
    else if (secondsLeft != null && secondsLeft < 60) itemOutlook = 'medium';
    else itemOutlook = 'high';

    if (itemOutlook === 'lost') {
        steps.push('掉落物已经超时消失（或被虚空吞了）：优先去仓库补一套装备，再去末地。');
    } else {
        steps.push(`尸体在 ${dimension === 'the_end' ? '末地' : dimension} (${Math.round(input.deathPosition.x)},${Math.round(input.deathPosition.y)},${Math.round(input.deathPosition.z)})，掉落物还有 ${secondsLeft == null ? '不确定（区块没加载就不倒计时，基本等于不会消失）' : `${secondsLeft}s`}。`);
        if (dimension === 'the_end') {
            steps.push(
                input.overworldPortal != null
                    ? `顺着记下来的主世界传送门 (${Math.round(input.overworldPortal.x)},${Math.round(input.overworldPortal.y)},${Math.round(input.overworldPortal.z)}) 再进末地——末地传送门只要激活过就一直亮着。`
                    : '回主世界要塞的末地传送门（激活后一直亮着）再进末地；找不到就用末影之眼重找要塞。'
            );
            steps.push('进末地先别急着打龙：龙还在、水晶可能掉了几颗，但**别去捡它头顶上的东西**，先确认附近没有龙再捡。');
        } else {
            steps.push('原地走过去捡；路上别打没必要的架。');
        }
        steps.push('捡完再决定要不要继续打——如果床/方块/药水掉了，先回去补，不要硬打。');
    }

    if (input.respawnPoint == null) {
        steps.push('**没有设重生点**：这次重生会回到世界出生点，路会很长——下次进末地前先在传送门附近放张床睡一觉。');
    } else {
        steps.push(`重生点在 (${Math.round(input.respawnPoint.x)},${Math.round(input.respawnPoint.y)},${Math.round(input.respawnPoint.z)})，从这里出发。`);
    }

    const message =
        itemOutlook === 'lost'
            ? '掉落物不在了，按"重新备战"走。'
            : `掉落物${itemOutlook === 'high' ? '基本还在' : '快消失了'}，${secondsLeft == null ? '先别慌，区块没加载不倒计时' : `剩 ${secondsLeft}s，抓紧`}。`;

    return { itemOutlook, secondsLeft, steps, message };
}

// ============================ 十、阶段状态机（接主循环用） ============================
export type EndgamePhase =
    | 'prepare'
    | 'travel_stronghold'
    | 'activate_portal'
    | 'enter_end'
    | 'clear_crystals'
    | 'fight_dragon'
    | 'recover'
    | 'done';

export interface EndgameState {
    /** 死亡后还有东西在地上 → 强制进入 recover。 */
    itemOnGround?: boolean;
    /** 装备清单过没过。 */
    gearReady?: boolean;
    /** 要塞找到了没有。 */
    strongholdFound?: boolean;
    /** 12 颗眼填满了没有。 */
    portalActivated?: boolean;
    inEnd?: boolean;
    /** 还剩几颗水晶。 */
    crystalsAlive?: number;
    /** 龙血读得到就给数字；读不到给 null。 */
    dragonHealth?: number | null;
}

export interface EndgameStepAdvice {
    phase: EndgamePhase;
    /** 这一步该干嘛（给模型看的一句话）。 */
    action: string;
    /** 建议调用的工具名（不带 `!`）。 */
    tool?: string;
    /** 做完之后应该进入哪个阶段。 */
    nextPhase: EndgamePhase;
    reason: string;
}

/**
 * 末地通关的**单步决策**：吃当前状态，吐"下一步干什么"。
 * 故意做成纯函数——主循环每轮调一次就行，不用把流程写死在一个几百行的 async 里。
 */
export function nextEndgameStep(state: EndgameState): EndgameStepAdvice {
    if (state.itemOnGround === true) {
        return {
            phase: 'recover',
            action: '先回收尸体：在记下来的坐标附近把掉落物捡回来，别急着继续打。',
            tool: 'recoverAfterDeath',
            nextPhase: 'recover',
            reason: '地上还有你的东西，5 分钟后就没（区块加载时才开始计时）。',
        };
    }
    if (state.gearReady !== true) {
        return {
            phase: 'prepare',
            action: '补齐进末地清单：床、方块、水桶、缓降药水、牛奶、抗性/再生药水、金苹果、弓+箭、末影珍珠、镐。',
            tool: 'endFightStatus',
            nextPhase: 'prepare',
            reason: '装备有硬缺口，进去就是送。',
        };
    }
    if (state.strongholdFound !== true) {
        return {
            phase: 'travel_stronghold',
            action: '掷末影之眼找要塞：眼飞 12 格指方向（20% 概率碎），跟着走，直到眼睛开始往下钻 → 往下挖。',
            tool: 'locateStronghold',
            nextPhase: 'activate_portal',
            reason: '还没定位要塞。末地传送门在要塞里。',
        };
    }
    if (state.portalActivated !== true) {
        return {
            phase: 'activate_portal',
            action: '在要塞传送门房里把 12 个框架都用末影之眼填满（天然自带约 10%），填满即激活。',
            tool: 'activateEndPortal',
            nextPhase: 'enter_end',
            reason: '传送门没激活就进不去末地。',
        };
    }
    if (state.inEnd !== true) {
        return {
            phase: 'enter_end',
            action: '走进末地传送门。进去会落在 (100,49,0) 的黑曜石平台上，面朝西——平台和主岛之间的空隙需要搭桥或扔珍珠。',
            tool: 'enterEnd',
            nextPhase: 'clear_crystals',
            reason: '传送门已激活，该过去了。',
        };
    }
    if ((state.crystalsAlive ?? 0) > 0) {
        return {
            phase: 'clear_crystals',
            action: `先拆水晶，还剩 ${state.crystalsAlive} 颗：站在离水晶 ≥12 格外用弓射；笼中那两颗最后处理（TNT 或上柱子拆栏杆）。全拆完再贴脸打龙。`,
            tool: 'clearEndCrystals',
            nextPhase: 'fight_dragon',
            reason: '只要还有一颗水晶，龙就会一直回血，打了也白打。',
        };
    }
    if (state.dragonHealth !== 0) {
        return {
            phase: 'fight_dragon',
            action: '打龙：它低头停在 (0,64,0) 传送门上时用床炸（站到掩体后面再点）或砍头；飞着的时候在它飞行轨迹前面放箭。随时留一颗心喝再生。',
            tool: 'bedBombDragon',
            nextPhase: 'done',
            reason: '水晶拆完、龙还活着，进入收割阶段。',
        };
    }
    return {
        phase: 'done',
        action: '龙死了：进 (0,64,0) 的出口传送门回主世界（会放终末之诗），记得捡龙蛋和 12000 经验。',
        nextPhase: 'done',
        reason: 'Boss 已经打完。',
    };
}

/** 把状态机建议 + 装备检查拼成一段给模型看的报告。 */
export function formatEndgameReport(assessment: EndGearAssessment, advice: EndgameStepAdvice): string {
    const lines = [`【末地通关·当前阶段】${advice.phase}`, advice.action, `——原因：${advice.reason}`];
    lines.push(`【装备】${assessment.message}`);
    for (const warning of assessment.warnings) lines.push(`⚠ ${warning}`);
    const missing = assessment.checks.filter((c) => !c.ok);
    if (missing.length > 0) {
        lines.push(`缺口：${missing.map((c) => `${c.label} ${c.have}/${c.need}`).join('；')}`);
    }
    return lines.join('\n');
}