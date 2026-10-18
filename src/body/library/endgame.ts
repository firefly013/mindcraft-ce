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

/** 爆炸威力：末地水晶 6（= 高压苦力怕），床 5，TNT 4（拆笼中水晶用）。 */
export const EXPLOSION_POWER = Object.freeze({ endCrystal: 6, bed: 5, tnt: 4 });

/**
 * 原版"够得着"的距离：生存模式下玩家对**方块**的交互距离是 4.5 格。
 *
 * 为什么它必须进床炸闸门：床炸的动作是"右键点床"，而点床要够得着。
 * 站到 10 格（爆炸半径）之外确实不会挨炸，但**也点不着那张床**——
 * 这种"看起来安全"的方案是假的，所以在闸门里直接判不通过。
 */
export const BLOCK_REACH_DISTANCE = 4.5;

/** TNT 引信 4 秒（80 tick）。点火后撤离的时间窗就是这个数。 */
export const TNT_FUSE_SECONDS = 4;

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

// ============================ 二·B、末影之眼：飞行方向（8 方位罗盘） ============================
/**
 * 8 方位罗盘。**Minecraft 的坐标约定**：+X = 东，-X = 西，+Z = 南，-Z = 北。
 * 所以方位角 0° = 正北，顺时针增加（90° = 正东）。
 */
export const COMPASS_POINTS = Object.freeze([
    'north',
    'northeast',
    'east',
    'southeast',
    'south',
    'southwest',
    'west',
    'northwest',
] as const);
export type CompassPoint = (typeof COMPASS_POINTS)[number];

export interface CompassBearing {
    point: CompassPoint;
    /** 0~360，0 = 正北，顺时针。 */
    degrees: number;
    /** 两点之间的**水平**距离（格）。 */
    distance: number;
}

/**
 * `from` → `to` 的 8 方位罗盘。两点水平重合（或数据坏了）时返回 **null**——
 * 返回 null 是"看不出方向"，绝不允许拿它编一个方向出来。
 */
export function compassBearing(from: Vec3, to: Vec3): CompassBearing | null {
    if (from == null || to == null) return null;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if (![dx, dz].every((n) => Number.isFinite(n))) return null;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (!(distance > 0)) return null;
    const degrees = (Math.atan2(dx, -dz) * 180) / Math.PI;
    const normalized = (degrees + 360) % 360;
    const index = Math.round(normalized / 45) % COMPASS_POINTS.length;
    return { point: COMPASS_POINTS[index], degrees: normalized, distance };
}

/** 方位角 → 中文说法（回执用；模型看得懂，也方便人读日志）。 */
export const COMPASS_LABELS: Record<CompassPoint, string> = Object.freeze({
    north: '北（-Z）',
    northeast: '东北（+X-Z）',
    east: '东（+X）',
    southeast: '东南（+X+Z）',
    south: '南（+Z）',
    southwest: '西南（-X+Z）',
    west: '西（-X）',
    northwest: '西北（-X-Z）',
});

export interface EyeSample {
    position: Vec3;
    /** 采样时刻（毫秒，只用于排序/诊断）。 */
    atMs?: number;
}

export interface EyeFlightTrack {
    /** 眼睛飞行的 8 方位方向。 */
    point: CompassPoint;
    degrees: number;
    /** 首末采样之间的水平位移（眼睛实际飞了多远）。**不是"到要塞的距离"**。 */
    travelled: number;
    samples: number;
    /** 最后一次看到眼睛的位置（可以走过去再扔一颗做三角定位）。 */
    lastPosition: Vec3;
}

/** 少于这个水平位移就不算"看得出方向"（眼睛还在手上/原地打转）。 */
export const MIN_EYE_TRAVEL = 0.75;

/**
 * 从末影之眼的**采样轨迹**推方向。
 *
 * 为什么要做成纯函数：末影之眼实体只活 1~2 秒，方向信息**过期不候**；
 * 而"眼睛往哪飞"是模型找要塞的唯一可编程线索。这段几何必须能离线钉死，
 * 不能埋在 `bot.entities` 的轮询里靠真机试。
 *
 * 取"最早 vs 最晚"两个采样；如果这两个点几乎重合（眼睛刚出手就消失了），
 * 就退而求其次找**位移最大的一对**；还是不够 `MIN_EYE_TRAVEL` → 返回 null
 * （"没看清"，由调用方如实报出来，不许瞎指方向）。
 */
export function trackEyeFlight(samples: EyeSample[]): EyeFlightTrack | null {
    const usable = (Array.isArray(samples) ? samples : []).filter(
        (sample) =>
            sample?.position != null &&
            [sample.position.x, sample.position.y, sample.position.z].every((n) => Number.isFinite(n))
    );
    if (usable.length < 2) return null;

    const lastPosition = usable[usable.length - 1].position;
    const firstLast = compassBearing(usable[0].position, lastPosition);
    if (firstLast != null && firstLast.distance >= MIN_EYE_TRAVEL) {
        return {
            point: firstLast.point,
            degrees: firstLast.degrees,
            travelled: firstLast.distance,
            samples: usable.length,
            lastPosition,
        };
    }

    let best: CompassBearing | null = null;
    for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
            const bearing = compassBearing(usable[i].position, usable[j].position);
            if (bearing == null) continue;
            if (best == null || bearing.distance > best.distance) best = bearing;
        }
    }
    if (best == null || best.distance < MIN_EYE_TRAVEL) return null;
    return {
        point: best.point,
        degrees: best.degrees,
        travelled: best.distance,
        samples: usable.length,
        lastPosition,
    };
}

/** 把方位角转成"跟着走的下一步"人话。 */
export function describeEyeDirection(track: EyeFlightTrack): string {
    return (
        `眼睛朝**${COMPASS_LABELS[track.point]}**飞（方位角 ${track.degrees.toFixed(0)}°），` +
        `在视野里飞了约 ${track.travelled.toFixed(1)} 格就消失了（这是眼睛的位移，**不是到要塞的距离**）。` +
        `最后看到它在 (${Math.round(track.lastPosition.x)},${Math.round(track.lastPosition.y)},${Math.round(track.lastPosition.z)})。`
    );
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
    /** 龙还剩多少血；读不到就别给（默认按满血 200 算"还要几张床"）。 */
    dragonHealth?: number | null;
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
    /** 点到床的距离（脚到床）。 */
    standDistance: number;
    /**
     * 有没有**能兑现的**掩体：`coverCells` 是调用方验过的实体方块，或者确认钻进了传送门结构。
     * 注意这是"配置声明"，**纯逻辑层不探世界**——探世界是 routine 的事。
     */
    coverVerified: boolean;
    /** 站得够不够近：够不着床就点不着（4.5 格）。 */
    canReachBed: boolean;
    /** 自伤超过一半血（不是当场死，但下一发龙息/摔伤就能收掉）。 */
    tooRisky: boolean;
    /** 'run' 方案要退到哪、退多远（blastRadius(5)=10 格）。 */
    retreat?: Vec3;
    retreatDistance: number;
    warnings: string[];
    reason: string;
}

/**
 * 规划一次床炸。**安全闸门是硬的**（判定顺序就是下面 if 的顺序）：
 *
 * 1. `自伤 ≥ 当前血量` → lethal、`ok=false`（"床炸会打死自己"）；
 * 2. `自伤 > 一半血` → `ok=false`（没当场死也会被下一发龙息/摔伤收掉）；
 * 3. **没有能兑现的掩体** → `ok=false`（"退到 10 格外"这个借口不成立：10 格外够不着床）；
 * 4. 够不着床（> {@link BLOCK_REACH_DISTANCE}） → `ok=false`；
 * 5. 龙离床 > 3 格（打不掉血） → `ok=false`。
 *
 * ⚠️ 历史教训（真机前必须记住）：这里原来写的是
 * `enoughRoom = method === 'cover' || standDistance >= safeDistance || retreatDistance >= safeDistance`，
 * 而 `retreatDistance` 的定义就是 `max(standDistance, safeDistance)` —— 第三个分支**恒为真**，
 * 于是"无掩体"这条闸门从来没生效过，`reason` 里的"退路不够"分支是死代码。
 * 现在改成显式三条独立判据，且掩体必须由调用方探世界后声明。
 */
export function planBedBombing(input: BedBombInput): BedBombPlan {
    const warnings: string[] = [];
    const power = EXPLOSION_POWER.bed;
    const dragonDistance = distance(input.bedCell, input.dragonHead);
    const expectedDragonDamage = bedDamageVsDragon(dragonDistance);

    const coverCells = input.coverCells ?? [];
    const coverVerified = coverCells.length > 0 || input.inTrench === true;
    // 经验暴露度：有掩体/在坑里 0.15，完全裸奔 1。
    const exposure = input.exposure ?? (coverVerified ? 0.15 : 1);
    const standDistance = distance(input.bedCell, input.standCell);
    const selfRawDamage = explosionDamage(power, standDistance, exposure);
    const selfFinalDamage = explosionDamageToPlayer(
        power,
        standDistance,
        exposure,
        input.mitigation ?? {}
    );
    const health = input.health ?? PLAYER_MAX_HEALTH;

    const method: BedBombMethod = coverVerified ? 'cover' : 'run';
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
    if (!coverVerified) {
        warnings.push('没有掩体也没钻进传送门结构：床炸几乎是自杀。');
    }

    const lethal = selfFinalDamage >= health;
    const tooRisky = !lethal && selfFinalDamage * 2 > health;
    const canReachBed = standDistance <= BLOCK_REACH_DISTANCE;
    const ok = !lethal && !tooRisky && coverVerified && canReachBed && expectedDragonDamage > 0;

    const reason = !ok
        ? lethal
            ? `床炸会打死自己（预计 ${selfFinalDamage.toFixed(1)} HP ≥ ${health} HP），需要掩体或先退到 ${safeDistance} 格外。`
            : tooRisky
                ? `自伤 ${selfFinalDamage.toFixed(1)} HP 超过你 ${health} HP 的一半：先回血 / 补掩体（床边放一块方块或钻进出口传送门结构），别赌。`
                : !coverVerified
                    ? `没有能兑现的掩体：先退到 ${safeDistance} 格外就够不着床了（交互距离 ${BLOCK_REACH_DISTANCE} 格），先在床和你之间放一块方块、或钻进出口传送门结构再点。`
                    : !canReachBed
                        ? `床离你 ${standDistance.toFixed(1)} 格，够不着（上限 ${BLOCK_REACH_DISTANCE} 格）：走近到床边再放/点。`
                        : `床离龙头 ${dragonDistance.toFixed(1)} 格太远，打不到龙。`
        : method === 'cover'
            ? `有掩体（暴露度 ${exposure}），预计打掉龙 ${expectedDragonDamage.toFixed(0)} HP、自伤 ${selfFinalDamage.toFixed(1)} HP。`
            : `点完床立刻沿远离床的方向退到 ${safeDistance} 格外，预计打掉龙 ${expectedDragonDamage.toFixed(0)} HP。`;

    const dragonHealth = typeof input.dragonHealth === 'number' && Number.isFinite(input.dragonHealth)
        ? Math.max(0, input.dragonHealth)
        : DRAGON_MAX_HEALTH;

    return {
        ok,
        method,
        dragonDistance,
        expectedDragonDamage,
        bedsNeeded: bedsNeeded(dragonHealth),
        selfRawDamage,
        selfFinalDamage,
        lethal,
        standDistance,
        coverVerified,
        canReachBed,
        tooRisky,
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
    /** 这次撤离是被什么驱动的：`cloud` = 地上的云；`perch` = 龙低头 + 20 格内；`none` = 不用动。 */
    escapeMode: 'cloud' | 'perch' | 'none';
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
 *
 * ⚠️ 历史教训：原来"8 个方向都试不出更远的格子"时会把目标格留在**原地**
 * （`clearance` 全是 `Infinity` 时 `>` 永远不成立），而外层调用者（`dodgeDragonBreathSkill`）
 * 会照样报"已经挪开了" —— 一次都没动，回执却说动了。
 * 现在补了**方向兜底**：云比不出来就朝"远离传送门"的方向走（龙低头时的 20 格规则），
 * 实在没有方向可用时至少给一个确定方向，并且 `escapeMode` 如实标出这次是被什么驱动的。
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

    const podiumDistance = horizontalDistance(input.self, END_PODIUM);
    const dragonPerched = input.dragonPerched === true;
    const dangerFromPerch = dragonPerched && podiumDistance < PERCH_BREATH_RANGE;

    let best: { dx: number; dz: number; clearance: number } = { dx: 0, dz: 0, clearance: clearanceAt(input.self) };
    for (const dir of EIGHT_WAYS) {
        const candidate = offset(input.self, dir.dx * step, 0, dir.dz * step);
        const clearance = clearanceAt(candidate);
        if (clearance > best.clearance) best = { dx: dir.dx, dz: dir.dz, clearance };
    }

    const needsMove = inside || dangerFromPerch || (Number.isFinite(nearestCloudDistance) && nearestCloudDistance < step);
    let escapeMode: BreathEscape['escapeMode'] = 'none';

    if (needsMove) {
        if (best.dx !== 0 || best.dz !== 0) {
            escapeMode = inside || Number.isFinite(nearestCloudDistance) ? 'cloud' : 'perch';
        } else {
            // 兜底 1：朝"离最近那团云"的反方向走。
            let fallback: { dx: number; dz: number } | null = null;
            let nearestCloud: BreathCloud | null = null;
            let nearestCloudDist = Infinity;
            for (const cloud of sameLayer) {
                const d = horizontalDistance(input.self, cloud.position);
                if (d < nearestCloudDist) {
                    nearestCloudDist = d;
                    nearestCloud = cloud;
                }
            }
            if (nearestCloud != null) {
                const dir = horizontalDirection(nearestCloud.position, input.self);
                if (dir.length > 0) {
                    fallback = { dx: dir.dx, dz: dir.dz };
                    escapeMode = 'cloud';
                }
            }
            // 兜底 2：龙低头时的 20 格规则——朝远离传送门的方向走。
            if (fallback == null && dangerFromPerch) {
                const dir = horizontalDirection(END_PODIUM, input.self);
                if (dir.length > 0) {
                    fallback = { dx: dir.dx, dz: dir.dz };
                    escapeMode = 'perch';
                }
            }
            // 兜底 3：站在传送门正中 / 云心正中，方向退化——至少给一个确定方向，别假装动了。
            if (fallback == null) {
                fallback = { dx: EIGHT_WAYS[0].dx, dz: EIGHT_WAYS[0].dz };
                escapeMode = dangerFromPerch ? 'perch' : 'cloud';
            }
            const candidate = offset(input.self, fallback.dx * step, 0, fallback.dz * step);
            best = { dx: fallback.dx, dz: fallback.dz, clearance: clearanceAt(candidate) };
        }
    }

    const escapeTarget = offset(input.self, best.dx * step, 0, best.dz * step);

    let urgency: BreathEscape['urgency'] = 'none';
    let reason = `周围没有龙息云（最近 ${Number.isFinite(nearestCloudDistance) ? nearestCloudDistance.toFixed(1) : '∞'} 格）。`;
    if (inside) {
        urgency = 'sprint';
        reason = `正站在龙息掉血区里（离云心 ${(nearestCloudDistance + BREATH_HARM_RADIUS).toFixed(1)} 格），立刻往 (${Math.round(escapeTarget.x)},${Math.round(escapeTarget.z)}) 方向冲刺。`;
    } else if (dangerFromPerch) {
        urgency = 'move';
        reason = `龙正低头停在传送门上，而你在它 ${podiumDistance.toFixed(1)} 格内（<${PERCH_BREATH_RANGE}）——下一发龙息就是冲你来的，先撤出 ${PERCH_BREATH_RANGE} 格：往 (${Math.round(escapeTarget.x)},${Math.round(escapeTarget.z)}) 走。`;
    } else if (Number.isFinite(nearestCloudDistance) && nearestCloudDistance < step) {
        urgency = 'move';
        reason = `最近的龙息云还剩 ${nearestCloudDistance.toFixed(1)} 格余量，先挪到 (${Math.round(escapeTarget.x)},${Math.round(escapeTarget.z)})。`;
    } else {
        escapeMode = 'none';
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
        escapeMode: urgency === 'none' ? 'none' : escapeMode,
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
 * 进末地前的装备检查。**硬缺口（fatal）只有两条**（设计稿 §3.5）：
 * "没有任何伤龙手段（没床、没 TNT、没弓+箭）" 和 "一个方块都没有"。
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
        {
            // 笼中那 2 颗水晶：有 TNT 就从笼顶掏（推荐），没 TNT 只能上柱子拆栏杆（得有镐 + 缓降）。
            // 两样都没有时地面对射基本无效 → **这一项必须出现在清单里**，否则"清单全绿"是假的。
            key: 'cage_kit',
            label: 'TNT 或镐（拆笼中水晶）',
            have: tnt + (pickaxes > 0 ? 1 : 0),
            need: 1,
            ok: tnt + (pickaxes > 0 ? 1 : 0) >= 1,
        },
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
    if (!checkOk('cage_kit')) {
        warnings.push('既没有 TNT 也没有镐：笼中那 2 颗水晶拆不掉（从地面射栏杆基本无效），只要还剩一颗龙就持续回血。带 TNT 去笼顶掏，或带镐上柱子拆栏杆（必须先喝缓降）。');
    }
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

// ============================ 九·B、复活末影龙（把打完的世界变回能打） ============================
/**
 * 复活仪式要 **4 颗末影水晶**，放在返回门基座环上的四个缺口里。
 *
 * 为什么需要它：这个世界**已经通关了**（`DragonFight.DragonKilled=1`），
 * 正常流程会直接走到 `done` —— 也就是说拆水晶和床炸这段代码在真机上**永远跑不到**。
 * 原版给了唯一一条回去的路：往返回门的四个缺口各放一颗末影水晶，龙就会重新出现
 * （10 根柱子上的水晶也会一起回来）。
 */
export const DRAGON_REVIVE_CRYSTALS = 4;

/** 4 颗末影水晶的材料（1 颗 = 1 恶魂之泪 + 1 末影之眼 + 7 玻璃）。 */
export const END_CRYSTAL_RECIPE = Object.freeze({ ghastTears: 4, eyesOfEnder: 4, glass: 28 });

/** 缺材料时给模型看的采购清单（话写全，它才知道去哪儿弄）。 */
export const END_CRYSTAL_SHOPPING_LIST: readonly string[] = Object.freeze([
    '恶魂之泪 ×4（下界打恶魂）',
    '末影之眼 ×4（= 末影珍珠 ×4，打末影人 + 烈焰粉 ×4 → 烈焰棒 ×2，打烈焰人）',
    '玻璃 ×28（= 沙子 ×28 烧出来）',
]);

export type CardinalDirection = 'north' | 'east' | 'south' | 'west';

/** 四个正方向（Minecraft：-Z 北，+X 东，+Z 南，-X 西）。 */
export const CARDINAL_DIRECTIONS: ReadonlyArray<{ point: CardinalDirection; dx: number; dz: number }> = Object.freeze([
    { point: 'east', dx: 1, dz: 0 },
    { point: 'west', dx: -1, dz: 0 },
    { point: 'south', dx: 0, dz: 1 },
    { point: 'north', dx: 0, dz: -1 },
]);

export const CARDINAL_LABELS: Record<CardinalDirection, string> = Object.freeze({
    north: '北(-Z)',
    east: '东(+X)',
    south: '南(+Z)',
    west: '西(-X)',
});

/**
 * 一个可放水晶的格子的"像不像标准位置"分档（越靠前越可信）。
 *
 * - `cardinal_middle`：半径 3 的四个正方向中点（`(±3,y+1,0)`、`(0,y+1,±3)`）——**本世界**
 *   的激活返回门就是这一档：y=62 那层是 20 个 `end_portal`，只有环外沿的基座上方才是空气；
 * - `diagonal_corner`：半径 2 的四个对角（`(±2,y+1,±2)`）；
 * - `outer_ring`：半径 3 环上的其它格子；
 * - `ring_gap`：**课本形状**的缺口（空气 + 底下基座 + 垂直于半径的两侧也是基座）；
 * - `air_over_base`：兜底——"空气 + 底下是基座"，形状不像标准位置。
 *
 * 为什么要分档而不是"先到先得"：只按"空气+底下基座"扫，**环上方那一层**会先被选中
 * （`(±1,y+1,0)`：空气、底下正是基座），水晶就被放到错的高度了。分档把"标准位置"
 * 排在前面，兜底档只在标准档凑不齐 4 个时才用，并且回执里会**明说这是在猜**。
 */
export type ReviveSpotTier = 'cardinal_middle' | 'diagonal_corner' | 'outer_ring' | 'ring_gap' | 'air_over_base';

const TIER_ORDER: readonly ReviveSpotTier[] = [
    'cardinal_middle',
    'diagonal_corner',
    'outer_ring',
    'ring_gap',
    'air_over_base',
];

/** 标准档（前三档 + 课本缺口）；`air_over_base` 是兜底，不算标准。 */
const STANDARD_TIERS: readonly ReviveSpotTier[] = ['cardinal_middle', 'diagonal_corner', 'outer_ring', 'ring_gap'];

export interface ReviveSpotPlan {
    ok: boolean;
    /** 用到的传送门中心（**观察值**，不是写死的常量）。 */
    center: Vec3;
    /** 选中的格子（不足 4 个时就是找到的那几个）。 */
    spots: Vec3[];
    /** 每个选中的格子属于哪一档（和 `spots` 一一对应）。 */
    tiers: ReviveSpotTier[];
    /** 标准档一共找到几个。 */
    standardCount: number;
    /** 哪几个格子的形状"像标准位置"但不是空气（被占了）——诊断"这门为什么推不出来"。 */
    blocked: Array<{ cell: Vec3; block: string | null; tier: ReviveSpotTier }>;
    /** 哪个方向没找到格子（按主方向归类）。 */
    missing: CardinalDirection[];
    /** 搜索范围内非空气方块的统计（最多 4 条）——结构性不匹配时就靠它解释。 */
    census: Array<{ block: string; count: number }>;
    reason: string;
}

/** 兜底档拿到 4 个格子时，回执必须提醒"这是在猜"。 */
export function tierIsGuess(tier: ReviveSpotTier): boolean {
    return tier === 'air_over_base';
}

function dominantDirection(dx: number, dz: number): CardinalDirection {
    if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 'east' : 'west';
    return dz >= 0 ? 'south' : 'north';
}

/**
 * 从**真实方块**推出可放水晶的格子（按 `ReviveSpotTier` 分档，标准档优先）。
 *
 * 判据全部来自读到的方块，**不写死坐标、也不写死"就在 y+1"**：
 * 1. 在中心附近（默认切比雪夫半径 3、y ±2 层）扫所有格子；
 * 2. 只收**空气**格，且**正下方是基座**（默认 `bedrock`）；
 * 3. 按形状分档排序，取最靠前的 4 个（彼此至少隔开 2 格，保证分布在四个方向）。
 *
 * "读不到方块（null）"一律跳过：宁可说"找不到"，也不把水晶放到猜的位置。
 *
 * **标准档凑不齐时**：如果缺的那一格是被方块占着的标准位置 → 直接拒绝并点名那一格
 * （清掉它就好，别浪费水晶）；否则退回兜底档，并在 `reason` 里说清"这不是标准形状"。
 */
export function planDragonReviveSpots(input: {
    center: Vec3;
    probe: (p: Vec3) => string | null;
    /** 基座方块名，默认 `bedrock`。 */
    baseName?: string;
    /** 中心 y 往上/往下各搜几层，默认 2（中心 y 常有一两格的观测误差）。 */
    yTolerance?: number;
    /** 水平搜索半径（切比雪夫距离），默认 3。 */
    radius?: number;
}): ReviveSpotPlan {
    const base = input.baseName ?? 'bedrock';
    const tolerance = Math.max(0, Math.floor(input.yTolerance ?? 2));
    const radius = Math.min(5, Math.max(1, Math.floor(input.radius ?? 3)));
    const cx = Math.floor(input.center.x);
    const cz = Math.floor(input.center.z);
    const cy = Math.floor(input.center.y);
    const center = vec(cx, cy, cz);
    const nameAt = (p: Vec3): string | null => input.probe(p);
    const isAir = (name: string | null): boolean => name === 'air' || name === 'cave_air' || name === 'void_air';

    const buckets = new Map<ReviveSpotTier, Vec3[]>(TIER_ORDER.map((tier) => [tier, [] as Vec3[]]));
    const blocked: ReviveSpotPlan['blocked'] = [];
    const census = new Map<string, number>();

    for (let dy = -tolerance; dy <= tolerance; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (dx === 0 && dz === 0) continue;
                const cell = vec(cx + dx, cy + dy, cz + dz);
                const here = nameAt(cell);
                if (here == null) continue; // 读不到 → 不猜
                const cheb = Math.max(Math.abs(dx), Math.abs(dz));
                // 只有"环上基座的正上方"才是可放格：底下必须是基座。
                if (!isAir(here)) {
                    census.set(here, (census.get(here) ?? 0) + 1);
                    // 课本缺口的签名（空气/非空气都先算形状）：底下基座 + 垂直于半径的两侧也是基座
                    const perp =
                        Math.abs(dx) >= Math.abs(dz)
                            ? [vec(cell.x, cell.y, cell.z - 1), vec(cell.x, cell.y, cell.z + 1)]
                            : [vec(cell.x - 1, cell.y, cell.z), vec(cell.x + 1, cell.y, cell.z)];
                    const shaped =
                        nameAt(vec(cell.x, cell.y - 1, cell.z)) === base &&
                        perp.every((p) => nameAt(p) === base);
                    if (shaped) blocked.push({ cell, block: here, tier: 'ring_gap' });
                    continue;
                }
                if (nameAt(vec(cell.x, cell.y - 1, cell.z)) !== base) continue; // 底下不是基座 → 不算
                let tier: ReviveSpotTier = 'air_over_base';
                if (dy === 1 && Math.abs(dx) === 3 && dz === 0) tier = 'cardinal_middle';
                else if (dy === 1 && dx === 0 && Math.abs(dz) === 3) tier = 'cardinal_middle';
                else if (dy === 1 && Math.abs(dx) === 2 && Math.abs(dz) === 2) tier = 'diagonal_corner';
                else if (dy === 1 && cheb === 3) tier = 'outer_ring';
                else {
                    const perp =
                        Math.abs(dx) >= Math.abs(dz)
                            ? [vec(cell.x, cell.y, cell.z - 1), vec(cell.x, cell.y, cell.z + 1)]
                            : [vec(cell.x - 1, cell.y, cell.z), vec(cell.x + 1, cell.y, cell.z)];
                    if (perp.every((p) => nameAt(p) === base)) tier = 'ring_gap';
                }
                buckets.get(tier)?.push(cell);
            }
        }
    }

    // 逐档取格子，彼此至少隔开 2 格（保证落在四个方向上而不是挤在一侧）。
    const chosen: Vec3[] = [];
    const chosenTiers: ReviveSpotTier[] = [];
    const farEnough = (cell: Vec3): boolean =>
        chosen.every((c) => Math.max(Math.abs(c.x - cell.x), Math.abs(c.z - cell.z)) >= 2);
    const standardSpots: Vec3[] = [];
    for (const tier of TIER_ORDER) {
        const list = (buckets.get(tier) ?? []).slice().sort((a, b) => {
            const da = Math.abs(a.y - (cy + 1)) * 100 + Math.max(Math.abs(a.x - cx), Math.abs(a.z - cz)) * 10;
            const db = Math.abs(b.y - (cy + 1)) * 100 + Math.max(Math.abs(b.x - cx), Math.abs(b.z - cz)) * 10;
            return da - db || a.x - b.x || a.z - b.z;
        });
        if (STANDARD_TIERS.includes(tier)) standardSpots.push(...list);
        for (const cell of list) {
            if (chosen.length >= DRAGON_REVIVE_CRYSTALS) break;
            if (!farEnough(cell)) continue;
            chosen.push(cell);
            chosenTiers.push(tier);
        }
        if (chosen.length >= DRAGON_REVIVE_CRYSTALS) break;
    }

    const standardCount = standardSpots.length;
    const missingSet = new Set<CardinalDirection>(['north', 'east', 'south', 'west']);
    for (const cell of chosen) missingSet.delete(dominantDirection(cell.x - cx, cell.z - cz));
    const missing = [...missingSet];
    const censusList = [...census.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([block, count]) => ({ block, count }));
    const censusText =
        censusList.length > 0 ? `搜索范围内见到的方块：${censusList.map((c) => `${c.block}×${c.count}`).join('、')}。` : '';
    const spotText = chosen.map((s) => `(${s.x},${s.y},${s.z})`).join('、');

    // —— 结论 ——
    if (standardCount >= DRAGON_REVIVE_CRYSTALS) {
        return {
            ok: true,
            center,
            spots: chosen,
            tiers: chosenTiers,
            standardCount,
            blocked,
            missing,
            census: censusList,
            reason: `返回门 (${cx},${cy},${cz}) 找到 ${standardCount} 个标准位置，用这四个：${spotText}。`,
        };
    }
    if (standardCount > 0 && blocked.length > 0) {
        return {
            ok: false,
            center,
            spots: chosen,
            tiers: chosenTiers,
            standardCount,
            blocked,
            missing,
            census: censusList,
            reason:
                `标准位置只找到 ${standardCount}/${DRAGON_REVIVE_CRYSTALS} 个，而且缺的格子**被占着**：` +
                `${blocked.map((b) => `(${b.cell.x},${b.cell.y},${b.cell.z}) 是 ${b.block}`).join('、')}。` +
                `先把这几格清成空气（底下留基座）再复活，别用别的格子顶替。${censusText}`,
        };
    }
    if (chosen.length >= DRAGON_REVIVE_CRYSTALS) {
        return {
            ok: true,
            center,
            spots: chosen,
            tiers: chosenTiers,
            standardCount,
            blocked,
            missing,
            census: censusList,
            reason:
                `这个返回门**不是课本形状**（标准位置 0 个），按兜底规则选了 ${chosen.length} 个"空气 + 底下基座"的格子：${spotText}。` +
                `能不能触发复活**不确定**，放完看龙回不回来。${censusText}`,
        };
    }
    return {
        ok: false,
        center,
        spots: chosen,
        tiers: chosenTiers,
        standardCount,
        blocked,
        missing,
        census: censusList,
        reason:
            `这个返回门的结构对不上：只找到 ${chosen.length}/${DRAGON_REVIVE_CRYSTALS} 个"空气 + 底下基座"的格子。` +
            `用 spots 参数**显式指定**四个格子（例如 "3,63,0;-3,63,0;0,63,3;0,63,-3"）就能照做。${censusText}`,
    };
}

export interface ReviveSpotOverride {
    ok: boolean;
    spots: Vec3[];
    /** 人话的错误说明（`ok=false` 时给模型看）。 */
    error: string;
}

/**
 * 解析 `spots` 参数：`"3,63,0;-3,63,0;0,63,3;0,63,-3"`（绝对坐标，分号/换行分隔，逗号或空格分列）。
 *
 * 为什么要这个参数：这个世界**已经通关**，返回门是激活状态（环里那层是 `end_portal`），
 * 结构可能和课本不一样。人能直接从存档里算出正确的四格 —— 得给一条**不用改代码**的路。
 */
export function parseReviveSpotOverride(spec: unknown): ReviveSpotOverride {
    if (typeof spec !== 'string' || spec.trim() === '') return { ok: false, spots: [], error: '' };
    const tokens = spec
        .split(/[;\n]+/)
        .map((t) => t.trim())
        .filter((t) => t !== '');
    if (tokens.length === 0) return { ok: false, spots: [], error: 'spots 是空的。' };
    const spots: Vec3[] = [];
    for (const token of tokens) {
        const parts = token.split(/[,\s]+/).map((n) => Number(n));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
            return {
                ok: false,
                spots: [],
                error: `spots 里有一段看不懂："${token}"——要三段数字（x,y,z），段之间用分号隔开，例如 "3,63,0;-3,63,0;0,63,3;0,63,-3"。`,
            };
        }
        spots.push(vec(Math.floor(parts[0] as number), Math.floor(parts[1] as number), Math.floor(parts[2] as number)));
    }
    if (spots.length < DRAGON_REVIVE_CRYSTALS) {
        return {
            ok: false,
            spots,
            error: `spots 只给了 ${spots.length} 个格子，复活要 ${DRAGON_REVIVE_CRYSTALS} 个（四个方向各一个）。`,
        };
    }
    return { ok: true, spots: spots.slice(0, DRAGON_REVIVE_CRYSTALS), error: '' };
}

// ============================ 十、阶段状态机（接主循环用） ============================
/**
 * 全流程阶段：**从"什么都没有"到"龙死"**。
 *
 * 为什么中段（下界 → 烈焰棒 → 珍珠 → 眼）必须在这里：决策层是模型唯一能看到的
 * "下一步"来源。原来只有 prepare → travel_stronghold，**从"没有烈焰棒"到"有烈焰棒"
 * 之间没有任何阶段** —— 模型在下界刷烈焰人这件事，状态机表达不出来，只能靠模型自己
 * 记得（feedback-analyst 的 triage 第 4 条）。现在这一段由真实能力驱动：
 * `exploreFor(block="nether_bricks")` 找要塞、`huntFor(entity="blaze"|"enderman")` 刷掉落。
 */
export type EndgamePhase =
    | 'recover'
    | 'prepare'
    | 'nether_fortress'
    | 'nether_blaze'
    | 'overworld_pearls'
    | 'craft_eyes'
    | 'travel_stronghold'
    | 'activate_portal'
    | 'enter_end'
    | 'clear_crystals'
    | 'fight_dragon'
    | 'done';

/** 填满末地传送门要 **12 颗眼**（12 格框架全有眼才激活）。 */
export const END_PORTAL_EYES = 12;
/** 12 颗眼 = 12 份烈焰粉 = 6 根烈焰棒；要 7 根是容错（掷眼会碎、多出的粉能炼药）。 */
export const BLAZE_RODS_FOR_EYES = 7;
/** 一颗眼一颗珍珠 → 12 颗眼要 12 颗末影珍珠。 */
export const PEARLS_FOR_EYES = 12;

export interface EndgameState {
    /** 死亡后还有东西在地上 → 强制进入 recover。 */
    itemOnGround?: boolean;
    /** 装备清单过没过（`assessEndGear().ok`）。 */
    gearReady?: boolean;
    /** 在下界里（`bot.game.dimension`）。读不到就别填。 */
    inNether?: boolean;
    /** 下界要塞找到没有。读不到就别填（默认按"先 exploreFor 找"处理）。 */
    fortressFound?: boolean;
    /** 烈焰棒数量。**读不到就别填**（这一环就不介入）。 */
    blazeRods?: number;
    /** 烈焰粉数量（和烈焰棒一起折算）。 */
    blazePowder?: number;
    /** 末影珍珠数量。 */
    enderPearls?: number;
    /** 末影之眼数量。 */
    eyesOfEnder?: number;
    /** 箭的数量（末地里没箭就拆不了水晶）。 */
    arrows?: number;
    /** 床的数量（没床就只能用箭/砍头打龙）。 */
    beds?: number;
    /** 末影水晶（复活龙用）的数量。读不到就别填。 */
    endCrystals?: number;
    /** 要塞找到了没有。 */
    strongholdFound?: boolean;
    /** 12 颗眼填满了没有。 */
    portalActivated?: boolean;
    inEnd?: boolean;
    /** 还剩几颗水晶；**读不到就别填**（在末地按"还没拆完"保守处理）。 */
    crystalsAlive?: number;
    /** 龙血读得到就给数字；读不到给 null。 */
    dragonHealth?: number | null;
    /**
     * 末影龙实体还在不在。
     *
     * 为什么单独要这个信号：龙一死 **boss bar 就消失**，`dragonHealth` 变成 null ——
     * 而 null 的语义是"读不到"，不能当成"打完了"。没有这一位时状态机会在龙死后
     * **永远停在 fight_dragon**，让 bot 对着一具尸体继续放床。
     */
    dragonAlive?: boolean;
}

export interface EndgameStepAdvice {
    phase: EndgamePhase;
    /** 这一步该干嘛（给模型看的一句话，**要点名缺什么**）。 */
    action: string;
    /** 建议调用的工具名（不带 `!`）。 */
    tool?: string;
    /** 做完之后应该进入哪个阶段。 */
    nextPhase: EndgamePhase;
    reason: string;
}

/** 把"烈焰棒 + 烈焰粉"折算成能用的粉量（1 根棒 = 2 份粉）。坏数据当 0。 */
export function blazePowderAvailable(rods?: number | null, powder?: number | null): number {
    const r = typeof rods === 'number' && Number.isFinite(rods) ? Math.max(0, rods) : 0;
    const p = typeof powder === 'number' && Number.isFinite(powder) ? Math.max(0, powder) : 0;
    return r * 2 + p;
}

/**
 * 中段材料链：**只判断调用方明确给了数量的那一环**，读不到的环直接跳过（不猜）。
 * 顺序就是真实的依赖顺序：粉（下界）→ 珍珠 → 眼。
 */
function eyeMaterialAdvice(state: EndgameState): EndgameStepAdvice | null {
    const powderKnown = state.blazeRods != null || state.blazePowder != null;
    const pearlsKnown = state.enderPearls != null;
    const eyesKnown = state.eyesOfEnder != null;
    if (!powderKnown && !pearlsKnown && !eyesKnown) return null;

    const powder = blazePowderAvailable(state.blazeRods, state.blazePowder);
    if (powderKnown && powder < END_PORTAL_EYES) {
        if (state.inNether !== true) {
            return {
                phase: 'nether_fortress',
                action:
                    `还没有烈焰粉（${powder}/${END_PORTAL_EYES}），而合末影之眼必须要它：先 enterNether 去下界，` +
                    '到了之后 exploreFor(block="nether_bricks") 找要塞、huntFor(entity="blaze") 刷烈焰棒。',
                tool: 'enterNether',
                nextPhase: 'nether_fortress',
                reason: '烈焰粉只有烈焰人掉；你现在不在下界，留在主世界刷不出眼。',
            };
        }
        if (state.fortressFound !== true) {
            return {
                phase: 'nether_fortress',
                action:
                    `在下界但还没找到要塞（烈焰粉 ${powder}/${END_PORTAL_EYES}）：exploreFor(block="nether_bricks", max_steps=12, step=32) ` +
                    '螺旋探索找要塞，找到 nether_bricks 就说明到了。',
                tool: 'exploreFor',
                nextPhase: 'nether_blaze',
                reason: '烈焰人只在要塞里刷；找不到要塞，刷棒就无从谈起。',
            };
        }
        const rods = typeof state.blazeRods === 'number' && Number.isFinite(state.blazeRods) ? Math.max(0, state.blazeRods) : 0;
        // 按**缺口**算要几根：1 根棒 = 2 份粉，多要 1 根做容错（掷眼会碎、粉还能炼药）。
        // 不要写死 7：已经有 11 份粉时再刷 7 根纯属浪费时间。
        const want = Math.max(1, Math.ceil(Math.max(0, END_PORTAL_EYES - powder) / 2) + 1);
        void rods;
        return {
            phase: 'nether_blaze',
            action: `要塞找到了，去刷烈焰棒：huntFor(entity="blaze", want=${want})（现在能用的粉 ${powder}/${END_PORTAL_EYES}）。`,
            tool: 'huntFor',
            nextPhase: 'nether_blaze',
            reason: `${END_PORTAL_EYES} 颗眼要 ${END_PORTAL_EYES} 份粉（至少 ${BLAZE_RODS_FOR_EYES - 1} 根棒），现在只有 ${powder} 份。`,
        };
    }

    if (pearlsKnown && (state.enderPearls as number) < PEARLS_FOR_EYES) {
        const have = Math.max(0, state.enderPearls as number);
        return {
            phase: 'overworld_pearls',
            action: `刷末影珍珠：huntFor(entity="enderman", want=${PEARLS_FOR_EYES - have})（现在 ${have}/${PEARLS_FOR_EYES}）。`,
            tool: 'huntFor',
            nextPhase: 'overworld_pearls',
            reason: `一颗眼一颗珍珠：${END_PORTAL_EYES} 颗眼还差 ${PEARLS_FOR_EYES - have} 颗珍珠。`,
        };
    }

    if (eyesKnown && (state.eyesOfEnder as number) < END_PORTAL_EYES && state.strongholdFound !== true) {
        const have = Math.max(0, state.eyesOfEnder as number);
        return {
            phase: 'craft_eyes',
            action:
                `合成末影之眼：craft(ender_eye) 再做 ${END_PORTAL_EYES - have} 颗（现在 ${have}/${END_PORTAL_EYES}）。` +
                '另外多留 2~3 颗用来掷眼（每次 20% 概率碎）——只留 12 颗的话，找完要塞就不够填门了。',
            tool: 'craft',
            nextPhase: 'craft_eyes',
            reason: `传送门要 ${END_PORTAL_EYES} 颗眼全填上才激活，现在只有 ${have} 颗。`,
        };
    }
    return null;
}

/**
 * 末地通关的**单步决策**：吃当前状态，吐"下一步干什么"。
 * 故意做成纯函数——主循环每轮调一次就行，不用把流程写死在一个几百行的 async 里。
 *
 * 排布上有一条硬规矩：**末地里的状态不能被主世界的前置卡住**。
 * 原实现把 `strongholdFound`/`portalActivated` 排在 `inEnd` 前面，而 `endFightStatus`
 * 在末地里根本读不到这两个标记（它们是主世界概念）—— 于是模型站在末地中央，报告却让它
 * "掷末影之眼找要塞"。现在 `inEnd === true` 时整段主世界流程直接跳过。
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
        return state.inEnd === true
            ? {
                  phase: 'prepare',
                  action:
                      '你**已经在末地**，但清单有硬缺口：就地解决——挖末地石/黑曜石当方块和掩体，别贴脸；床/弓/药水这些只能等这波打完或死了回主世界再补。',
                  tool: 'endFightStatus',
                  nextPhase: 'prepare',
                  reason: '装备有硬缺口，在末地硬打就是送（先看报告里缺哪一项）。',
              }
            : {
                  phase: 'prepare',
                  action:
                      '补齐进末地清单：床（炸龙）、方块（搭路/掩体）、弓+箭（拆水晶）、水桶、缓降药水、牛奶、抗性/再生药水、金苹果、末影珍珠、镐。',
                  tool: 'endFightStatus',
                  nextPhase: 'prepare',
                  reason: '装备有硬缺口，进去就是送（先看报告里缺哪一项）。',
              };
    }

    // —— 主世界/下界段：材料链 → 找要塞 → 激活 → 进末地 ——
    if (state.inEnd !== true) {
        // 门**已经激活**了就不用再刷眼：末影之眼只有"填门"这一个用途，
        // 再让人回下界刷烈焰棒纯属浪费（而且会挡住"进门去复活龙/回收尸体"这类正当理由）。
        if (state.portalActivated !== true) {
            const materials = eyeMaterialAdvice(state);
            if (materials != null) return materials;
        }

        if (state.strongholdFound !== true) {
            const eyes = state.eyesOfEnder;
            const eyeText =
                eyes == null ? '' : eyes <= 0 ? '（**注意：眼已经用光了**，先回去合成/刷珍珠）' : `（还有 ${eyes} 颗眼）`;
            return {
                phase: 'travel_stronghold',
                // 工具名必须是**注册表里真的存在**的：原来这里写 `locateStronghold`，
                // 而 registry 里没有这条命令，模型照着调只会拿到"未知工具"。
                action: `掷末影之眼找要塞${eyeText}：先 equip 把 ender_eye 拿到手上，再 throwHeld（它会量出眼睛的飞行方向）；跟着走，直到眼睛开始往下钻 → 往下挖到传送门房。`,
                tool: 'throwHeld',
                nextPhase: 'activate_portal',
                reason: '还没定位要塞。末地传送门在要塞里。',
            };
        }
        if (state.portalActivated !== true) {
            const eyes = state.eyesOfEnder;
            if (eyes != null && eyes <= 0) {
                return {
                    phase: 'activate_portal',
                    action:
                        '要塞找到了，但**一颗末影之眼都没有**：先补眼——珍珠不够就 huntFor(entity="enderman")，粉不够就回下界 huntFor(entity="blaze")，材料齐了 craft(ender_eye) 合成。',
                    tool: 'huntFor',
                    nextPhase: 'activate_portal',
                    reason: '12 个框架全有眼才激活；没眼就只能先去补。',
                };
            }
            return {
                phase: 'activate_portal',
                action: `站在要塞传送门房里调 enterEnd：它会把空框架都用末影之眼填满（12 格全有眼才激活，天然自带约 10%），填满后直接走进去${eyes == null ? '' : `（现在 ${eyes} 颗眼）`}。`,
                tool: 'enterEnd',
                nextPhase: 'enter_end',
                reason: '传送门没激活就进不去末地（原来这里写的是不存在的 activateEndPortal）。',
            };
        }
        return {
            phase: 'enter_end',
            action: '走进末地传送门。进去会落在 (100,49,0) 的黑曜石平台上，面朝西——平台和主岛之间的空隙需要搭桥或扔珍珠。',
            tool: 'enterEnd',
            nextPhase: 'clear_crystals',
            reason: '传送门已激活，该过去了。',
        };
    }

    // —— 末地段：水晶 → 龙 → 收尾 ——
    if (state.crystalsAlive == null || state.crystalsAlive > 0) {
        const unknown = state.crystalsAlive == null;
        const noArrows = state.arrows != null && state.arrows <= 0;
        return {
            phase: 'clear_crystals',
            action: unknown
                ? '水晶数量读不到（实体没加载？）：先调 endFightStatus 看治疗光束/实体，确认拆干净之前不要贴脸打龙——只要还剩一颗，龙就一直回血。'
                : noArrows
                    ? `还剩 ${state.crystalsAlive} 颗水晶，但**箭是 0**：弓箭打不了。把射出去的箭捡回来，或者只剩笼中水晶时用 TNT 掏（allowDangerousOps(ops="ignite", calls=1)）；没有箭就别贴脸。`
                    : `先拆水晶，还剩 ${state.crystalsAlive} 颗：站在离水晶 ≥12 格外用弓射；笼中那两颗最后处理（TNT 或上柱子拆栏杆）。全拆完再贴脸打龙。`,
            tool: 'clearEndCrystals',
            nextPhase: 'fight_dragon',
            reason: '只要还有一颗水晶，龙就会一直回血，打了也白打。',
        };
    }
    // 龙死了（实体消失）或血量读到 0 —— 两个信号任一成立就算打完。
    if (state.dragonAlive === false || state.dragonHealth === 0) {
        const crystals = state.endCrystals;
        const hasCrystals = crystals != null && crystals >= DRAGON_REVIVE_CRYSTALS;
        const crystalText = crystals == null ? '（末影水晶数量读不到）' : `你现在有 ${crystals} 个末影水晶`;
        const shopping = `要凑 ${DRAGON_REVIVE_CRYSTALS} 颗末影水晶：${END_CRYSTAL_SHOPPING_LIST.join('；')}`;
        const reviveDoor = hasCrystals
            ? `**要再打一次（验证拆水晶/床炸流程）就往返回门的四个缺口各放一颗末影水晶**（${crystalText}）——龙会重新出现，柱子上的 10 颗水晶也一起回来。`
            : `要再打一次得先凑够 4 颗末影水晶（${crystalText}）：${shopping}。`;
        const reasonTail =
            state.dragonHealth === 0
                ? 'Boss 已经打完（血量 0）。'
                : '龙实体和 boss bar 都不在了，按"打完"处理；**如果还能看见它在飞，先调 endFightStatus 复核**再走。';
        return {
            phase: 'done',
            action: `龙已经死了。两个选择：**要走**就进 (0,62,0) 的出口传送门（返回门）回主世界（会放终末之诗，别忘了捡龙蛋和 12000 经验）；${reviveDoor}`,
            tool: hasCrystals ? 'reviveDragon' : 'craft',
            nextPhase: 'done',
            reason: reasonTail,
        };
    }
    if (state.beds != null && state.beds <= 0) {
        // 没床 = 主输出没了。在末地出不去（出口要龙死才开），所以只能改打法。
        return {
            phase: 'fight_dragon',
            action: state.inEnd === true
                ? '**床已经用光了**：末地出不去，改打法——用 attack 在它低头时砍头，或者飞着的时候在飞行轨迹前面放箭；别贴脸站着。'
                : '**一张床都没有**：先 craft(white_bed)（3 羊毛 + 3 木板）或去搜刮床，凑 4 张再来炸龙；没床就只能弓箭慢慢磨。',
            tool: state.inEnd === true ? 'attack' : 'craft',
            nextPhase: 'done',
            reason: '床炸是主输出（一张最多打掉 1/4 血）；没有床，输出效率差一个数量级。',
        };
    }
    return {
        phase: 'fight_dragon',
        action: '打龙：它低头停在 (0,64,0) 传送门上时用床炸（站到掩体后面再点）或砍头；飞着的时候在它飞行轨迹前面放箭。随时留一颗心喝再生。',
        tool: 'bedBombDragon',
        nextPhase: 'done',
        reason: '水晶拆完、龙还活着，进入收割阶段。',
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
// ============================ 十一、按优先级喝药（纯决策） ============================
/**
 * 值得"用牛奶清掉"的负面效果（设计稿 §3.5：牛奶只在中了负面效果时用）。
 * 缓降/再生/抗性这些**好** Buff 不在这个表里 —— 喝奶会把它们一起清掉，所以有它们在时不喝。
 */
export const NEGATIVE_EFFECTS: readonly string[] = Object.freeze([
    'poison',
    'wither',
    'weakness',
    'slowness',
    'mining_fatigue',
    'hunger',
    'blindness',
    'nausea',
    'levitation',
    'unluck',
    'darkness',
    'instant_damage',
    'bad_omen',
]);

/** 身上有没有负面效果；返回第一个命中的名字（给回执用）。 */
export function findNegativeEffect(effects: EffectInfo[] | undefined): string | null {
    if (!Array.isArray(effects)) return null;
    for (const effect of effects) {
        const name = normalizeName(effect?.name);
        if (NEGATIVE_EFFECTS.includes(name)) return name;
    }
    return null;
}

export interface DrinkDecisionInput {
    effects?: EffectInfo[];
    stock: PotionStock;
    /** 当前血量 0~20；读不到给 null。 */
    health?: number | null;
    /** 在末地：摔落风险和龙息风险都拉满。 */
    inEnd?: boolean;
    /** 现在在空中/正在下坠。 */
    airborne?: boolean;
    /** 缓降剩多少秒算"快没了"，默认 30。 */
    refreshBelowSeconds?: number;
}

export interface DrinkDecision {
    /** 该喝哪一类；null = 现在不需要喝。 */
    kind: PotionKind | 'milk' | null;
    reason: string;
    /** 逐项诊断（没喝时告诉模型背包里都有什么）。 */
    considered: string[];
}

/**
 * 末地喝药的优先级。做成纯函数是为了能离线测：**决策和"怎么喝"是两件事**。
 *
 * 为什么需要它：所有药水在背包里都叫 `potion`，现有 `consume(item_name)` 按物品名找，
 * 模型没法表达"喝缓降"。这里替模型把顺序定死（并写在工具描述里，不是隐藏规则）：
 *
 * 1. **缓降**：在末地/空中，且没 Buff 或剩余 < 30s → 立刻补。摔死是末地头号死法。
 * 2. **再生 / 治疗**：血量 ≤ 10（半血）时先回血。
 * 3. **抗性提升**：在末地且没有抗性 Buff → 顶一个（爆炸和撞击都能减）。
 * 4. **牛奶（只在中毒/虚弱这类负面效果时）**：且身上**没有**缓降/再生/抗性时才喝
 *    —— 牛奶清的是全部效果，为解一个中毒把刚喝的缓降清掉是拿命换。
 * 5. 都不满足 → 不喝，回执里列出背包还有哪些药。
 */
export function choosePotionToDrink(input: DrinkDecisionInput): DrinkDecision {
    const stock = input.stock;
    const refresh = input.refreshBelowSeconds ?? 30;
    const considered: string[] = [];
    const fallRisk = input.inEnd === true || input.airborne === true;
    const slowFallingLeft = activeEffectSeconds(input.effects, 'slow_falling');

    if (stock.slow_falling > 0 && fallRisk && (slowFallingLeft == null || slowFallingLeft < refresh)) {
        return {
            kind: 'slow_falling',
            reason:
                slowFallingLeft == null
                    ? `没有缓降 Buff，而${input.airborne === true ? '你现在在空中' : '你在末地'}——龙的翅膀能把你掀到几十格高空，先补缓降。`
                    : `缓降只剩 ${slowFallingLeft}s（少于 ${refresh}s），被掀飞前先续上。`,
            considered,
        };
    }
    considered.push(`缓降：库存 ${stock.slow_falling} 瓶，Buff ${slowFallingLeft == null ? '无' : `${slowFallingLeft}s`}`);

    const health = input.health ?? null;
    if (health != null && health <= 10) {
        if (stock.regeneration > 0) {
            return { kind: 'regeneration', reason: `血量只剩 ${health}/20：先喝再生，把血线拉回来。`, considered };
        }
        if (stock.healing > 0) {
            return { kind: 'healing', reason: `血量只剩 ${health}/20：没有再生，先用治疗顶一口。`, considered };
        }
        considered.push('再生/治疗：低血但库存为 0');
    } else {
        considered.push(`再生/治疗：血量 ${health == null ? '读不到' : `${health}/20`}，还没到半血`);
    }

    if (input.inEnd === true && !hasActiveEffect(input.effects, 'resistance') && stock.resistance > 0) {
        return { kind: 'resistance', reason: '在末地且没有抗性提升：先顶一瓶，爆炸和撞击都按这个减。', considered };
    }
    considered.push(`抗性：库存 ${stock.resistance} 瓶，Buff ${hasActiveEffect(input.effects, 'resistance') ? '有' : '无'}`);

    // 牛奶：**只在中了负面效果时**喝。而且身上有好 Buff（缓降/再生/抗性）时不喝——
    // 牛奶清的是"全部"效果，为解一个中毒把刚喝的缓降一起清掉，等于把命交给下坠。
    const negative = findNegativeEffect(input.effects);
    if (negative != null) {
        const sacrificial = ['slow_falling', 'regeneration', 'resistance'].filter((kind) =>
            hasActiveEffect(input.effects, kind)
        );
        if (stock.milk > 0 && sacrificial.length === 0) {
            return {
                kind: 'milk',
                reason: `身上有 ${negative}：喝牛奶立刻清掉全部负面效果（现在没有会被一起清掉的好 Buff）。牛奶不能灭火。`,
                considered,
            };
        }
        considered.push(
            stock.milk > 0
                ? `中了 ${negative}，但身上还有 ${sacrificial.join('/')}：喝奶会一起清掉，先不喝（等它们过期或确认值得换）。`
                : `中了 ${negative}，但没有牛奶桶。`,
        );
    }

    const stockText = POTION_KINDS.filter((kind) => kind !== 'other' && stock[kind] > 0)
        .map((kind) => `${kind}×${stock[kind]}`)
        .join('、');
    return {
        kind: null,
        reason: `按末地优先级现在不需要喝药。背包里的药水：${stockText === '' ? '（一瓶都没有）' : stockText}。`,
        considered,
    };
}
