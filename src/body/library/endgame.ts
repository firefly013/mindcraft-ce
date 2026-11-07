/**
 * 末地相关纯逻辑：末影之眼的方向几何、死亡回收、药水识别与查找。
 *
 * 和环境里 `nether_portal.ts` 同一个套路：
 * - 这里只吃坐标 / 物品这类普通数据，所以 `tests/endgame.test.ts` 不需要起
 *   MC 服务端，也不烧模型 token；
 * - 真正碰世界的那层在 `endgame_routine.ts`。
 *
 * 拆水晶、床炸龙、躲龙息、复活龙的决策函数已经按用户要求删除。
 */

// ============================ 一、常量（已核验，附出处） ============================

/** 进入末地时的落点：5×5 黑曜石平台中心 (100,49,0)，玩家面朝西。 */
export const END_PLATFORM = Object.freeze({ x: 100, y: 49, z: 0 });

/** 掉落物 5 分钟（6000 tick）后消失；但**只在所在区块被加载时才计时**。 */
export const ITEM_DESPAWN_SECONDS = 300;

// ============================ 二、基础向量/数学 ============================

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

export function vec(x: number, y: number, z: number): Vec3 {
    return { x, y, z };
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
 * 1.20.5+ 的药水在组件里是**数字注册表 id**，不是名字。
 *
 * 这里按原版 `minecraft:potion` 注册表的顺序换算（1.21.x，含风弹/织网/渗浆/寄生
 * 四种新药水）。换版本或加模组药水时认不出的 id 会显示成 `potion#N`——如实报，
 * 不猜成某一种。
 */
const POTION_ID_BY_REGISTRY: readonly string[] = Object.freeze([
    'water', 'mundane', 'thick', 'awkward',
    'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility',
    'leaping', 'long_leaping', 'strong_leaping',
    'fire_resistance', 'long_fire_resistance',
    'swiftness', 'long_swiftness', 'strong_swiftness',
    'slowness', 'long_slowness', 'strong_slowness',
    'turtle_master', 'long_turtle_master', 'strong_turtle_master',
    'water_breathing', 'long_water_breathing',
    'healing', 'strong_healing', 'harming', 'strong_harming',
    'poison', 'long_poison', 'strong_poison',
    'regeneration', 'long_regeneration', 'strong_regeneration',
    'strength', 'long_strength', 'strong_strength',
    'slow_falling', 'long_slow_falling',
    'wind_charged', 'weaving', 'oozing', 'infested',
]);

function potionNameFromRegistryId(id: number): string {
    return POTION_ID_BY_REGISTRY[id] ?? `potion#${id}`;
}

/** 从组件值里读药水名（字符串 id、数字注册表 id、或 `{potion|potionId}` 包一层都认）。 */
function potionNameFromComponentValue(value: unknown): string | null {
    if (typeof value === 'string') return normalizeName(value);
    if (typeof value === 'number') return potionNameFromRegistryId(value);
    if (value == null || typeof value !== 'object') return null;
    const data = value as Record<string, unknown>;
    if (typeof data['potion'] === 'string') return normalizeName(data['potion']);
    const raw = data['potionId'] ?? data['potion_id'] ?? data['id'];
    if (typeof raw === 'string') return normalizeName(raw);
    if (typeof raw === 'number') return potionNameFromRegistryId(raw);
    return null;
}

/** 读 `potion_contents` 组件的数据（兼容 componentMap / components 数组 / 对象）。 */
function potionComponentDataOf(item: any): unknown {
    const map = item?.componentMap;
    if (map != null && typeof map.get === 'function') {
        const component = map.get('potion_contents');
        if (component != null) return component.data ?? component;
    }
    const components = item?.components;
    if (Array.isArray(components)) {
        for (const component of components) {
            if (component?.type === 'potion_contents') return component.data ?? component;
        }
        return null;
    }
    if (components != null && typeof components === 'object') {
        const component = (components as Record<string, any>).potion_contents;
        if (component != null) return component.data ?? component;
    }
    return null;
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

    const fromComponent = potionNameFromComponentValue(potionComponentDataOf(item));
    if (fromComponent != null) return fromComponent;
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
        steps.push('死因：掉进虚空（Y<-60），掉落物当场消失。');
    }

    const secondsLeft = input.chunkLoadedSinceDeath === true ? Math.max(0, ITEM_DESPAWN_SECONDS - input.secondsSinceDeath) : null;

    let itemOutlook: RecoveryPlan['itemOutlook'];
    if (input.fellOutOfWorld === true) itemOutlook = 'lost';
    else if (secondsLeft != null && secondsLeft <= 0) itemOutlook = 'lost';
    else if (secondsLeft != null && secondsLeft < 60) itemOutlook = 'medium';
    else itemOutlook = 'high';

    if (itemOutlook === 'lost') {
        steps.push('掉落物已超时消失。');
    } else {
        steps.push(`尸体在 ${dimension === 'the_end' ? '末地' : dimension} (${Math.round(input.deathPosition.x)},${Math.round(input.deathPosition.y)},${Math.round(input.deathPosition.z)})，掉落物还有 ${secondsLeft == null ? '不确定（区块没加载就不倒计时，基本等于不会消失）' : `${secondsLeft}s`}。`);
        if (dimension === 'the_end') {
            steps.push(
                input.overworldPortal != null
                    ? `主世界传送门 (${Math.round(input.overworldPortal.x)},${Math.round(input.overworldPortal.y)},${Math.round(input.overworldPortal.z)})，激活过就一直亮着。`
                    : '主世界要塞的末地传送门（激活后一直亮着）。'
            );
            steps.push('进末地时龙还在、水晶可能掉了；龙头顶下方的掉落物在龙低头时捡不到。');
        } else {
            steps.push('掉落物在原地。');
        }
        steps.push('捡回的物品清单以背包实测为准。');
    }

    if (input.respawnPoint == null) {
        steps.push('重生点未设置：重生落在世界出生点。');
    } else {
        steps.push(`重生点在 (${Math.round(input.respawnPoint.x)},${Math.round(input.respawnPoint.y)},${Math.round(input.respawnPoint.z)})，从这里出发。`);
    }

    const message =
        itemOutlook === 'lost'
            ? '掉落物已消失。'
            : `掉落物${itemOutlook === 'high' ? '还在' : '快消失'}，${secondsLeft == null ? '区块未加载，未计时' : `剩 ${secondsLeft}s`}。`;

    return { itemOutlook, secondsLeft, steps, message };
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

/** 按**完整药水 id** 在背包里找一瓶能喝的药水（喷溅/滞留药水不收）。 */
export function findPotionById(items: any[], potionId: unknown): any | null {
    if (!Array.isArray(items)) return null;
    const wanted = normalizeName(potionId);
    if (wanted === '') return null;
    for (const item of items) {
        if (normalizeName(item?.name) !== 'potion') continue;
        if (normalizeName(potionIdOf(item)) === wanted) return item;
    }
    return null;
}

/** 背包里可饮用药水的清单（按**完整药水 id** 计数），没有就是空串。 */
export function potionInventorySummary(items: any[]): string {
    if (!Array.isArray(items)) return '';
    const counts = new Map<string, number>();
    for (const item of items) {
        if (normalizeName(item?.name) !== 'potion') continue;
        const id = normalizeName(potionIdOf(item));
        const label = id === '' ? 'unknown' : id;
        const n = typeof item?.count === 'number' && Number.isFinite(item.count) ? Math.max(1, item.count) : 1;
        counts.set(label, (counts.get(label) ?? 0) + n);
    }
    return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join('、');
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
