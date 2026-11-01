/**
 * **战力模型**：把"我"和"眼前的怪"折算成两条可比的时间线，输出打/跑/观望。
 *
 * 这是纯函数模块：不碰 bot、不发事件、不写日志，所有输入都是普通对象，
 * 所以每一条判据都能用真机快照直接单测。
 *
 * ## 为什么不是"一个战力值比大小"
 *
 * 单看 `血 × 攻击` 会把两种怪判反：20 血 0.5 DPS 的坦克显得很强，3 血 3 DPS 的
 * 脆皮显得很弱。真正决定生死的是**两条时间线**：
 *
 *   - `ttk`：我杀光它们要几秒 = Σ敌有效血 / 我的 DPS
 *   - `ttd`：它们杀我要几秒   = 我的有效血 / 它们的 DPS
 *
 * 判决就是 `ttd > margin × ttk`。它等价于比较 `DPS × 有效血` 这个"战力值"，
 * 但拆开之后每个乘数都有物理意义，回执里能逐项写清楚（模型能学）。
 *
 * ## 数据从哪来
 *
 * 优先用服务端下发的属性（`entity.attributes`：攻击力/最大生命/移速），
 * 读不到才退回 `MOB_PROFILES` 这张表。**表只是兜底**，不是权威——
 * 真机难度、版本、附魔都会让属性比表准。
 *
 * ## 边界
 *
 * - 苦力怕/监守者/凋灵/末影龙这些**不进公式**（爆炸是二值事件，监守者打不过）；
 * - 中立怪（末影人/猪灵）不主动开战；
 * - 读不到的数字一律按"更危险"的方向估，绝不因为读不到就判"能打"。
 */

export type CombatArchetype = 'melee' | 'ranged' | 'explosive' | 'special';

/** 一种怪的兜底数值（普通难度基准）。属性读得到时以属性为准。 */
export interface MobProfile {
    archetype: CombatArchetype;
    /** 最大生命。 */
    hp: number;
    /** 单次伤害（普通难度）。 */
    damage: number;
    /** 两次攻击之间的秒数。 */
    intervalSec: number;
    /** 它会主动盯上你的距离（"要不要先动手"的参考）。 */
    aggroRange: number;
    /** 中立：不主动开战，除非它先打我。 */
    neutral?: boolean;
    /** 永不交火：直接跑。 */
    neverFight?: boolean;
    /** 爆炸伤害（苦力怕）。 */
    burst?: number;
    /** 会回血/召唤/传送等，DPS 模型不适用，按"危险"处理。 */
    special?: string;
}

/**
 * 怪的兜底表。
 *
 * ⚠️ 这些数字是**普通难度**的基准，只用来在属性读不到时兜底。改它之前先想清楚：
 * 能用 `entity.attributes` 的地方不要用表；表里没有的怪走 `UNKNOWN_MOB`（保守）。
 */
export const MOB_PROFILES: Readonly<Record<string, MobProfile>> = Object.freeze({
    zombie: { archetype: 'melee', hp: 20, damage: 3, intervalSec: 1.0, aggroRange: 8 },
    husk: { archetype: 'melee', hp: 20, damage: 3, intervalSec: 1.0, aggroRange: 8 },
    drowned: { archetype: 'melee', hp: 20, damage: 3, intervalSec: 1.0, aggroRange: 8 },
    zombie_villager: { archetype: 'melee', hp: 20, damage: 3, intervalSec: 1.0, aggroRange: 8 },
    skeleton: { archetype: 'ranged', hp: 20, damage: 3, intervalSec: 2.0, aggroRange: 16 },
    stray: { archetype: 'ranged', hp: 20, damage: 3, intervalSec: 2.0, aggroRange: 16 },
    bogged: { archetype: 'ranged', hp: 16, damage: 3, intervalSec: 2.0, aggroRange: 16 },
    creeper: { archetype: 'explosive', hp: 20, damage: 0, intervalSec: 0, aggroRange: 4, burst: 49 },
    spider: { archetype: 'melee', hp: 16, damage: 2, intervalSec: 1.0, aggroRange: 8 },
    cave_spider: { archetype: 'melee', hp: 12, damage: 2, intervalSec: 1.0, aggroRange: 8, special: 'poison' },
    enderman: { archetype: 'melee', hp: 40, damage: 7, intervalSec: 1.0, aggroRange: 16, neutral: true },
    witch: { archetype: 'special', hp: 26, damage: 0, intervalSec: 0, aggroRange: 16, special: 'potion', neverFight: true },
    slime: { archetype: 'melee', hp: 16, damage: 2, intervalSec: 1.0, aggroRange: 8 },
    magma_cube: { archetype: 'melee', hp: 16, damage: 4, intervalSec: 1.0, aggroRange: 8 },
    blaze: { archetype: 'ranged', hp: 20, damage: 6, intervalSec: 1.0, aggroRange: 16, special: 'fire' },
    ghast: { archetype: 'ranged', hp: 10, damage: 17, intervalSec: 3.0, aggroRange: 32, special: 'fire' },
    piglin: { archetype: 'melee', hp: 16, damage: 5, intervalSec: 1.0, aggroRange: 16, neutral: true },
    zombified_piglin: { archetype: 'melee', hp: 20, damage: 5, intervalSec: 1.0, aggroRange: 16, neutral: true },
    piglin_brute: { archetype: 'melee', hp: 50, damage: 7, intervalSec: 1.0, aggroRange: 16, neverFight: true },
    hoglin: { archetype: 'melee', hp: 40, damage: 6, intervalSec: 1.0, aggroRange: 16 },
    zoglin: { archetype: 'melee', hp: 40, damage: 6, intervalSec: 1.0, aggroRange: 16 },
    phantom: { archetype: 'melee', hp: 20, damage: 4, intervalSec: 1.0, aggroRange: 32 },
    pillager: { archetype: 'ranged', hp: 24, damage: 4, intervalSec: 2.0, aggroRange: 16 },
    vindicator: { archetype: 'melee', hp: 24, damage: 8, intervalSec: 1.0, aggroRange: 16 },
    evoker: { archetype: 'special', hp: 24, damage: 0, intervalSec: 0, aggroRange: 16, special: 'fangs', neverFight: true },
    ravager: { archetype: 'melee', hp: 100, damage: 12, intervalSec: 1.0, aggroRange: 16, neverFight: true },
    vex: { archetype: 'melee', hp: 14, damage: 6, intervalSec: 1.0, aggroRange: 16 },
    guardian: { archetype: 'ranged', hp: 30, damage: 4, intervalSec: 2.0, aggroRange: 16 },
    elder_guardian: { archetype: 'special', hp: 80, damage: 8, intervalSec: 2.0, aggroRange: 16, neverFight: true },
    shulker: { archetype: 'special', hp: 30, damage: 4, intervalSec: 2.0, aggroRange: 16, neverFight: true },
    silverfish: { archetype: 'melee', hp: 8, damage: 1, intervalSec: 1.0, aggroRange: 8 },
    endermite: { archetype: 'melee', hp: 8, damage: 2, intervalSec: 1.0, aggroRange: 8 },
    wither_skeleton: { archetype: 'melee', hp: 20, damage: 5, intervalSec: 1.0, aggroRange: 16, special: 'wither' },
    breeze: { archetype: 'ranged', hp: 30, damage: 3, intervalSec: 2.0, aggroRange: 16, special: 'wind' },
    warden: { archetype: 'special', hp: 500, damage: 30, intervalSec: 1.0, aggroRange: 16, neverFight: true },
    wither: { archetype: 'special', hp: 300, damage: 15, intervalSec: 1.0, aggroRange: 32, neverFight: true },
    ender_dragon: { archetype: 'special', hp: 200, damage: 15, intervalSec: 1.0, aggroRange: 32, neverFight: true },
});

/** 表里没有的怪：按"普通近战怪"估，但**不主动开战**（未知 = 更危险）。 */
export const UNKNOWN_MOB: Readonly<MobProfile> = Object.freeze({
    archetype: 'melee',
    hp: 20,
    damage: 3,
    intervalSec: 1.0,
    aggroRange: 8,
    special: 'unknown',
});

/** 名字归一化：`minecraft:zombie` / `Zombie` / `zombie#123` → `zombie`。 */
export function normalizeMobName(name: unknown): string {
    const raw = String(name ?? '')
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .replace(/#.*$/, '')
        .trim();
    if (raw === '') return '';
    // 玩家实体的 name 是类型名 'player'，不算怪。
    return raw;
}

/** 查一种怪的兜底档案；表里没有返回 null（调用方决定怎么保守）。 */
export function mobProfileOf(name: unknown): MobProfile | null {
    const key = normalizeMobName(name);
    if (key === '') return null;
    return MOB_PROFILES[key] ?? null;
}

/** 武器档案。 */
export interface WeaponProfile {
    damage: number;
    attacksPerSec: number;
    kind: 'sword' | 'axe' | 'trident' | 'fist' | 'bow' | 'crossbow';
}

/** 武器兜底表（无附魔基准）。 */
const WEAPONS: Readonly<Record<string, WeaponProfile>> = Object.freeze({
    fists: { damage: 1, attacksPerSec: 4.0, kind: 'fist' },
    wooden_sword: { damage: 4, attacksPerSec: 1.6, kind: 'sword' },
    golden_sword: { damage: 4, attacksPerSec: 1.6, kind: 'sword' },
    stone_sword: { damage: 5, attacksPerSec: 1.6, kind: 'sword' },
    iron_sword: { damage: 6, attacksPerSec: 1.6, kind: 'sword' },
    diamond_sword: { damage: 7, attacksPerSec: 1.6, kind: 'sword' },
    netherite_sword: { damage: 8, attacksPerSec: 1.6, kind: 'sword' },
    wooden_axe: { damage: 7, attacksPerSec: 0.8, kind: 'axe' },
    golden_axe: { damage: 7, attacksPerSec: 1.0, kind: 'axe' },
    stone_axe: { damage: 9, attacksPerSec: 0.8, kind: 'axe' },
    iron_axe: { damage: 9, attacksPerSec: 0.9, kind: 'axe' },
    diamond_axe: { damage: 9, attacksPerSec: 1.0, kind: 'axe' },
    netherite_axe: { damage: 10, attacksPerSec: 1.0, kind: 'axe' },
    trident: { damage: 9, attacksPerSec: 1.1, kind: 'trident' },
    bow: { damage: 6, attacksPerSec: 0.8, kind: 'bow' },
    crossbow: { damage: 7, attacksPerSec: 0.5, kind: 'crossbow' },
});

/**
 * 这个名字是不是**已知的武器**（剑/斧/三叉戟/弓）。
 *
 * `weaponProfileOf` 对不认识的物品会退回"铁剑估值"，那是为了应对 mod 武器；
 * 但"背包里挑武器"时不能把面包当剑——所以挑之前先过这一关。
 */
export function isKnownWeapon(name: unknown): boolean {
    const key = normalizeMobName(name);
    return Object.prototype.hasOwnProperty.call(WEAPONS, key);
}

/**
 * 武器档案：材料表 + 锋利附魔。
 *
 * 锋利：`+0.5 × 等级 + 0.5`（1.9+ 的规则）。附魔读不到就当 0（不是"没有锋利"，
 * 是"不知道"——但武器伤害表本身已经够保守）。
 */
export function weaponProfileOf(name: unknown, sharpnessLevel = 0): WeaponProfile {
    const key = normalizeMobName(name);
    const base = WEAPONS[key] ?? null;
    if (base == null) {
        // 不认识的"武器"（比如 mod 物品）：按铁剑估，别当空手。
        return { damage: 6, attacksPerSec: 1.6, kind: 'sword' };
    }
    const sharp = Math.max(0, Math.floor(sharpnessLevel));
    const bonus = sharp > 0 ? 0.5 * sharp + 0.5 : 0;
    return { ...base, damage: base.damage + bonus };
}

/** 护甲档案（点数/韧性/保护等级）。 */
export interface ArmorProfile {
    points: number;
    toughness: number;
    protection: number;
}

/** 每件护甲的点数（普通材质）。 */
const ARMOR_POINTS: Readonly<Record<string, number>> = Object.freeze({
    leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
    golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
    chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
    iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
    diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
    netherite_helmet: 3, netherite_chestplate: 8, netherite_leggings: 6, netherite_boots: 3,
    turtle_helmet: 2,
});

/** 每件的韧性（只有钻石/下界合金有）。 */
const ARMOR_TOUGHNESS: Readonly<Record<string, number>> = Object.freeze({
    diamond_helmet: 2, diamond_chestplate: 2, diamond_leggings: 2, diamond_boots: 2,
    netherite_helmet: 3, netherite_chestplate: 3, netherite_leggings: 3, netherite_boots: 3,
});

/**
 * 从装备名列表算护甲档案。
 *
 * `protectionLevels` 是每件装备的保护附魔等级（读不到就传空）。
 */
export function armorFromItems(
    names: readonly unknown[],
    protectionLevels: readonly number[] = [],
): ArmorProfile {
    let points = 0;
    let toughness = 0;
    for (const raw of names) {
        const key = normalizeMobName(raw);
        points += ARMOR_POINTS[key] ?? 0;
        toughness += ARMOR_TOUGHNESS[key] ?? 0;
    }
    let protection = 0;
    for (const level of protectionLevels) {
        const n = Number(level);
        if (Number.isFinite(n) && n > 0) protection += Math.floor(n);
    }
    return { points: Math.min(20, points), toughness, protection: Math.min(4, protection) };
}

/** 我这一侧的事实。 */
export interface CombatSelfFacts {
    health: number;
    maxHealth: number;
    food: number;
    saturation: number;
    armor: ArmorProfile | null;
    /** 当前手上/背包里最好的武器；null = 空手。 */
    weapon: WeaponProfile | null;
    shield: boolean;
    /** 生效中的药水等级（0 = 没有）。 */
    effects: {
        strength: number;
        resistance: number;
        regeneration: number;
        absorption: number;
        weakness: number;
        fireResistance: boolean;
    };
    difficulty: 'peaceful' | 'easy' | 'normal' | 'hard' | 'unknown';
    inWater: boolean;
    onGround: boolean;
}

/** 怪这一侧的事实。 */
export interface CombatEnemyFacts {
    id: number;
    name: string;
    distance: number;
    /** 当前血量（读得到就用它算 TTK；读不到用 maxHealth）。 */
    health: number | null;
    maxHealth: number | null;
    /** 服务端下发的单次攻击伤害；读不到用表。 */
    attackDamage: number | null;
    /** 服务端下发的移速；只用于接近时间。 */
    movementSpeed: number | null;
    /** 它正对着我（yaw 差 ≤30°）。 */
    lockedOn: boolean;
    /** 最近一次伤害来源是它。 */
    attackingMe: boolean;
    /** 玩家（不参与怪的战力表）。 */
    isPlayer: boolean;
}

/** 评估参数。 */
export interface AssessOptions {
    /** entry = 还没打（进入阈值）；hold = 正在打（退出阈值）。 */
    mode: 'entry' | 'hold';
    /** 进入交战的余量：ttd 必须大于 margin × ttk 才开打。 */
    margin: number;
    /** 已经在打时，低于这个余量就改判逃跑。 */
    exitMargin: number;
    /** 同时能打到我身上的怪最多算几只（接触面）。 */
    contactCap?: number;
}

export type CombatVerdict = 'fight' | 'flee' | 'hold' | 'ignore';

export interface CombatAssessment {
    verdict: CombatVerdict;
    targetId: number | null;
    /** 我的 DPS（含命中率折损）。 */
    selfDps: number;
    /** 我的有效血量（含护甲/抗性/回血）。 */
    selfEffectiveHp: number;
    /** 它们的 DPS 之和（只算能打到我身上的）。 */
    enemyDps: number;
    /** 它们的有效血量之和。 */
    enemyEffectiveHp: number;
    ttkSec: number;
    ttdSec: number;
    /** ttd / ttk。> margin 打，< exitMargin 跑。 */
    ratio: number;
    /** 硬规则名（非空时 verdict 由它决定，公式只做记录）。 */
    hardRule: string | null;
    reason: string;
    /** 回执里要用的逐项说明。 */
    breakdown: string[];
}

const DEFAULT_CONTACT_CAP = 3;
/** 近战怪在开阔地的命中率（它们会被击退/绕路，打不满）。 */
const MELEE_HIT_RATE = 0.6;
const RANGED_HIT_RATE = 0.5;
/** 我的挥砍命中率（模型自己瞄，不是 100%）。 */
const SELF_HIT_RATE = 0.85;
/** 接近速度（格/秒）：双方都在动 vs 我单方面接近。 */
const CLOSING_SPEED_MELEE = 3.5;
const CLOSING_SPEED_RANGED = 3.0;
/** 自然回血速率（食物 ≥18 时）：有饱和度 1 HP/s，没有 0.25 HP/s。 */
const REGEN_WITH_SATURATION = 1.0;
const REGEN_WITHOUT_SATURATION = 0.25;
/** 再生药水每级约 0.4 HP/s。 */
const REGEN_PER_LEVEL = 0.4;
/** 难度对怪伤害的倍率（普通 = 1）。 */
const DIFFICULTY_FACTOR: Readonly<Record<string, number>> = Object.freeze({
    peaceful: 0,
    easy: 0.7,
    normal: 1.0,
    hard: 1.5,
    unknown: 1.5,
});

/** 护甲减伤（1.9+ 公式）。`damage` 是单次伤害。 */
export function armorDamageReduction(points: number, toughness: number, damage: number): number {
    const p = Math.max(0, points);
    const t = Math.max(0, toughness);
    const d = Math.max(0, damage);
    const reduction = Math.min(20, Math.max(p / 5, p - d / (2 + t / 4)));
    return Math.max(0, Math.min(1, reduction / 25));
}

/** 我受到的伤害倍率（护甲 + 保护附魔 + 抗性）。 */
export function damageTakenMultiplier(self: CombatSelfFacts, incomingDamage: number): number {
    const armor = self.armor ?? { points: 0, toughness: 0, protection: 0 };
    const armorReduction = armorDamageReduction(armor.points, armor.toughness, incomingDamage);
    const protectionReduction = Math.min(0.8, 0.04 * Math.max(0, armor.protection));
    const resistanceReduction = Math.min(1, 0.2 * Math.max(0, self.effects.resistance));
    return Math.max(0.05, (1 - armorReduction) * (1 - protectionReduction) * (1 - resistanceReduction));
}

/** 我的 DPS：武器伤害 × 攻速 × 命中率，力量/虚弱按 1.9+ 的 ±伤害算。 */
export function selfDps(self: CombatSelfFacts): number {
    const weapon = self.weapon;
    if (weapon == null) return 0;
    const strengthBonus = 3 * Math.max(0, self.effects.strength) - 4 * Math.max(0, self.effects.weakness);
    const damage = Math.max(1, weapon.damage + strengthBonus);
    return damage * weapon.attacksPerSec * SELF_HIT_RATE;
}

/** 我的有效血量：血 + 吸收 + 战斗期回血，再除以受伤倍率。 */
export function selfEffectiveHp(self: CombatSelfFacts, fightSeconds: number): number {
    const absorption = 4 * Math.max(0, self.effects.absorption);
    let regenPerSec = 0;
    if (self.food >= 18) {
        regenPerSec += self.saturation > 0 ? REGEN_WITH_SATURATION : REGEN_WITHOUT_SATURATION;
    }
    regenPerSec += REGEN_PER_LEVEL * Math.max(0, self.effects.regeneration);
    const regen = regenPerSec * Math.max(0, Math.min(fightSeconds, 10));
    const raw = Math.max(1, self.health) + absorption + regen;
    return raw / damageTakenMultiplier(self, 6);
}

/** 一只怪的基础 DPS（未考虑接近时间）。 */
export function enemyBaseDps(self: CombatSelfFacts, enemy: CombatEnemyFacts): number {
    const profile = mobProfileOf(enemy.name) ?? UNKNOWN_MOB;
    const difficulty = DIFFICULTY_FACTOR[self.difficulty] ?? 1.5;
    const damage = (enemy.attackDamage ?? profile.damage) * difficulty;
    const interval = profile.intervalSec > 0 ? profile.intervalSec : 1;
    const hitRate = profile.archetype === 'ranged' ? RANGED_HIT_RATE : MELEE_HIT_RATE;
    let dps = (damage / interval) * hitRate;
    // 火系怪 + 抗火：伤害按 0 算（火球/火焰）。
    if (profile.special === 'fire' && self.effects.fireResistance) dps = 0;
    return Math.max(0, dps);
}

/** 一只怪的有效血量（读不到血量就用最大血量，不假设它残血）。 */
export function enemyEffectiveHp(enemy: CombatEnemyFacts): number {
    const profile = mobProfileOf(enemy.name) ?? UNKNOWN_MOB;
    const hp = enemy.health != null && Number.isFinite(enemy.health) ? enemy.health : enemy.maxHealth ?? profile.hp;
    return Math.max(1, hp);
}

/** 接近一只怪要几秒（只对远程怪算"白挨打"的时间）。 */
function approachSeconds(enemy: CombatEnemyFacts): number {
    const profile = mobProfileOf(enemy.name) ?? UNKNOWN_MOB;
    const gap = Math.max(0, enemy.distance - 3);
    if (gap === 0) return 0;
    const speed = profile.archetype === 'ranged' ? CLOSING_SPEED_RANGED : CLOSING_SPEED_MELEE;
    return gap / speed;
}

/**
 * 核心判决。
 *
 * 硬规则（顺序敏感）优先于公式：
 *   1. 和平难度 ⇒ ignore；
 *   2. 中立怪没打我 ⇒ ignore（不主动开战）；
 *   3. 永不交火/未知怪贴脸 ⇒ flee；
 *   4. 苦力怕贴脸 ⇒ flee（爆炸是二值事件，不进公式）；
 *   5. 残血且没有回血手段 ⇒ flee；
 *   6. 公式：ttd > margin × ttk ⇒ fight；< exitMargin × ttk ⇒ flee；否则 hold。
 */
export function assessCombat(
    self: CombatSelfFacts,
    enemies: readonly CombatEnemyFacts[],
    options: AssessOptions,
): CombatAssessment {
    const margin = Number.isFinite(options.margin) && options.margin > 0 ? options.margin : 1.6;
    const exitMargin = Number.isFinite(options.exitMargin) && options.exitMargin > 0 ? options.exitMargin : 1.0;
    const contactCap = Math.max(1, Math.floor(options.contactCap ?? DEFAULT_CONTACT_CAP));
    const breakdown: string[] = [];
    const empty = (verdict: CombatVerdict, reason: string, hardRule: string | null = null): CombatAssessment => ({
        verdict,
        targetId: null,
        selfDps: selfDps(self),
        selfEffectiveHp: selfEffectiveHp(self, 1),
        enemyDps: 0,
        enemyEffectiveHp: 0,
        ttkSec: 0,
        ttdSec: 0,
        ratio: 0,
        hardRule,
        reason,
        breakdown,
    });

    if (self.difficulty === 'peaceful') return empty('ignore', '和平难度：不会刷敌对生物');
    if (self.health <= 0) return empty('ignore', '已经死了');

    const mobs = enemies.filter((e) => !e.isPlayer && normalizeMobName(e.name) !== 'player');
    if (mobs.length === 0) return empty('ignore', '附近没有敌对生物');

    // 中立怪：没打我 = 不当威胁；打我 = 当普通怪算。
    const threats = mobs.filter((enemy) => {
        const profile = mobProfileOf(enemy.name);
        if (profile?.neutral === true && !enemy.attackingMe) return false;
        return true;
    });
    if (threats.length === 0) return empty('ignore', '附近只有中立生物，它们没攻击我');

    // 最近的威胁：优先"正在打我"的，其次"盯着我"的，最后按距离。
    const sorted = [...threats].sort((a, b) => {
        const score = (e: CombatEnemyFacts): number => (e.attackingMe ? 0 : e.lockedOn ? 1 : 2);
        const byScore = score(a) - score(b);
        return byScore !== 0 ? byScore : a.distance - b.distance;
    });
    const target = sorted[0] ?? null;

    // ── 硬规则 ──────────────────────────────────────────────────────────
    const neverFight = threats.find((enemy) => {
        const profile = mobProfileOf(enemy.name);
        return profile?.neverFight === true;
    });
    if (neverFight != null && neverFight.distance <= 16) {
        const a = empty('flee', `${neverFight.name} 是打不过的怪（永不交火）`, 'never-fight');
        a.targetId = neverFight.id;
        a.breakdown.push(`${neverFight.name}：${MOB_PROFILES[normalizeMobName(neverFight.name)]?.special ?? '危险'}`);
        return a;
    }
    const creeper = threats.find((enemy) => {
        const profile = mobProfileOf(enemy.name);
        return profile?.archetype === 'explosive';
    });
    // 14 格 = `creeper_reflex` 的接管半径。苦力怕的爆炸是二值事件（要么不炸，
    // 要么 49 伤害），它永远不该进"打"的判决。
    if (creeper != null && creeper.distance <= 14) {
        const a = empty('flee', `苦力怕在 ${Math.round(creeper.distance)} 格内：爆炸是二值事件，不近战`, 'creeper');
        a.targetId = creeper.id;
        return a;
    }
    const unknownClose = threats.find((enemy) => {
        const profile = mobProfileOf(enemy.name);
        return profile == null && enemy.distance <= 12;
    });
    if (unknownClose != null) {
        const a = empty('flee', `不认识的怪（${unknownClose.name}）贴到 ${Math.round(unknownClose.distance)} 格：按危险处理`, 'unknown-mob');
        a.targetId = unknownClose.id;
        return a;
    }
    // 残血 + 没有回血手段：任何怪都不打（这条和重伤守卫同源）。
    if (self.health <= 6 && self.food < 18 && self.effects.regeneration <= 0) {
        const a = empty('flee', `只剩 ${Math.round(self.health * 10) / 10} 血、食物 ${Math.round(self.food)}（不回血）`, 'low-health');
        a.targetId = target?.id ?? null;
        return a;
    }

    // ── 公式 ────────────────────────────────────────────────────────────
    const selfDamageDps = selfDps(self);
    if (selfDamageDps <= 0.01) {
        const a = empty('flee', '手上没有能打的东西（空手/武器读不到）', 'no-weapon');
        a.targetId = target?.id ?? null;
        return a;
    }

    // 进入战斗后所有威胁都会围上来；按接触面截断。
    const contact = sorted.slice(0, contactCap);
    const enemyHpTotal = threats.reduce((sum, enemy) => sum + enemyEffectiveHp(enemy), 0);
    let enemyDps = 0;
    const approachDamage: number[] = [];
    for (const enemy of contact) {
        const base = enemyBaseDps(self, enemy);
        enemyDps += base;
        const profile = mobProfileOf(enemy.name) ?? UNKNOWN_MOB;
        if (profile.archetype === 'ranged') approachDamage.push(base * approachSeconds(enemy));
    }
    const approach = approachDamage.reduce((sum, n) => sum + n, 0);
    const ttkSec = enemyHpTotal / selfDamageDps;
    const selfEffective = selfEffectiveHp(self, ttkSec);
    // 接近路上白挨的伤害从有效血里先扣掉。
    const effectiveForFight = Math.max(1, selfEffective - approach);
    const ttdSec = enemyDps > 0.01 ? effectiveForFight / enemyDps : Number.POSITIVE_INFINITY;
    const ratio = ttkSec > 0.01 ? ttdSec / ttkSec : Number.POSITIVE_INFINITY;

    breakdown.push(
        `我 ${Math.round(selfDamageDps * 10) / 10} DPS / ${Math.round(selfEffective)} 有效血`,
        `它们 ${Math.round(enemyDps * 10) / 10} DPS / ${Math.round(enemyHpTotal)} 血`,
        `杀光 ${Math.round(ttkSec * 10) / 10}s，撑 ${Number.isFinite(ttdSec) ? Math.round(ttdSec * 10) / 10 + 's' : '∞'}`,
    );
    if (approach > 0) breakdown.push(`接近路上会白挨约 ${Math.round(approach)} 伤害`);

    const threshold = options.mode === 'hold' ? exitMargin : margin;
    let verdict: CombatVerdict;
    if (ratio > threshold) verdict = 'fight';
    else if (ratio < exitMargin || options.mode === 'entry') verdict = 'flee';
    else verdict = 'hold';

    const reason =
        `我 ${Math.round(selfDamageDps * 10) / 10} DPS / ${Math.round(selfEffective)} 有效血 vs ` +
        `${threats.length} 只怪 ${Math.round(enemyDps * 10) / 10} DPS / ${Math.round(enemyHpTotal)} 血` +
        `（杀光 ${Math.round(ttkSec * 10) / 10}s，撑 ${Number.isFinite(ttdSec) ? Math.round(ttdSec * 10) / 10 + 's' : '∞'}）`;
    return {
        verdict,
        targetId: target?.id ?? null,
        selfDps: selfDamageDps,
        selfEffectiveHp: selfEffective,
        enemyDps,
        enemyEffectiveHp: enemyHpTotal,
        ttkSec,
        ttdSec,
        ratio,
        hardRule: null,
        reason,
        breakdown,
    };
}

export default {
    MOB_PROFILES,
    UNKNOWN_MOB,
    mobProfileOf,
    weaponProfileOf,
    armorFromItems,
    armorDamageReduction,
    damageTakenMultiplier,
    selfDps,
    selfEffectiveHp,
    enemyBaseDps,
    enemyEffectiveHp,
    assessCombat,
};
