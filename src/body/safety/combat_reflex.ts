/**
 * **战斗反射**：遇怪时不再等模型决策，身体自己算一次"打还是跑"。
 *
 * 背景（用户 2026-10-31 的 spec）：机器人很多次死法是"遇到怪、VLM 还没反应过来"。
 * 模型一回合几秒，而怪从 16 格到贴脸只要一两秒——这段必须由身体接管。
 *
 * 本模块只做**纯决策 + 回执**，动作由 `MineflayerBody` 执行：
 *   - 打：`skills.attackEntity`（custom-pvp）；
 *   - 跑：复用现有 `escape` 保命反射；
 *   - 其余情况什么都不做。
 *
 * 纪律（和 `creeper_reflex.ts` 同源）：
 *   - **不是模型工具，也不是门**：模型看不到它、也不能调用它；
 *   - 每 episode 只报一次回执（不刷屏），结论和数值都写清楚；
 *   - 苦力怕不归它管（引信 1.5s，由 `creeper_reflex` 独立处理）。
 */
import { isHostile } from '../data/mcdata.js';
import {
    armorFromItems,
    assessCombat,
    isKnownWeapon,
    mobProfileOf,
    normalizeMobName,
    weaponProfileOf,
    type ArmorProfile,
    type CombatAssessment,
    type CombatEnemyFacts,
    type CombatSelfFacts,
    type CombatVerdict,
    type WeaponProfile,
} from './combat_power.js';
import { isToolProtected } from '../library/tool_choice.js';

/** 战斗策略配置（`settings.combatPolicy`）。 */
export interface CombatPolicy {
    /** off = 完全关闭；shadow = 只算只报、不动身体；on = 真的接管。 */
    mode: 'off' | 'shadow' | 'on';
    /** 进入交战的余量：ttd > margin × ttk 才打。 */
    margin: number;
    /** 已经在打时，低于这个余量就改判跑。 */
    exitMargin: number;
    /** 评估半径（格）。24 在感知半径 32 以内，又比"怪物靠近"事件的 16 更早。 */
    scanRadius: number;
    /** 一次交战最多占身体多久（毫秒）。 */
    maxEngageMs: number;
}

export const DEFAULT_COMBAT_POLICY: Readonly<CombatPolicy> = Object.freeze({
    mode: 'on',
    margin: 1.6,
    exitMargin: 1.0,
    scanRadius: 24,
    maxEngageMs: 20_000,
});

/** 一次交战结束后的冷却：刚打完不立刻再开一场（同一只怪还在附近时尤其重要）。 */
export const COMBAT_REFLEX_COOLDOWN_MS = 3_000;
/** shadow 模式写回执的最小间隔（只记账，不动作）。 */
export const COMBAT_SHADOW_NOTICE_MS = 5_000;

/** 从 settings 里读策略：任何字段缺失/非法都退回默认值（不因为读不到就关闭功能）。 */
export function readCombatPolicy(raw: unknown): CombatPolicy {
    const src = raw != null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const mode = src['mode'];
    const num = (value: unknown, fallback: number): number => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    return {
        mode: mode === 'off' || mode === 'shadow' || mode === 'on' ? mode : DEFAULT_COMBAT_POLICY.mode,
        margin: num(src['margin'], DEFAULT_COMBAT_POLICY.margin),
        exitMargin: num(src['exitMargin'], DEFAULT_COMBAT_POLICY.exitMargin),
        scanRadius: num(src['scanRadius'], DEFAULT_COMBAT_POLICY.scanRadius),
        maxEngageMs: num(src['maxEngageMs'], DEFAULT_COMBAT_POLICY.maxEngageMs),
    };
}

// ── 读事实（只读 bot，不改任何东西）────────────────────────────────────────

/** 药水 id → 我们关心的效果名（1.20.5 的 id，见 minecraft-data effects.json）。 */
const EFFECT_IDS: Readonly<Record<number, string>> = Object.freeze({
    0: 'speed',
    4: 'strength',
    9: 'regeneration',
    10: 'resistance',
    11: 'fireResistance',
    21: 'absorption',
    17: 'weakness',
});

/** 读药水等级（amplifier + 1）；读不到就是 0。 */
function readEffects(bot: any): CombatSelfFacts['effects'] {
    const out: CombatSelfFacts['effects'] = {
        strength: 0,
        resistance: 0,
        regeneration: 0,
        absorption: 0,
        weakness: 0,
        fireResistance: false,
    };
    const effects = bot?.entity?.effects;
    if (effects == null || typeof effects !== 'object') return out;
    for (const [rawId, rawEffect] of Object.entries(effects as Record<string, unknown>)) {
        const id = Number(rawId);
        const name = EFFECT_IDS[id];
        if (name == null) continue;
        const amplifier = Number((rawEffect as { amplifier?: unknown })?.amplifier);
        const level = Number.isFinite(amplifier) ? Math.max(1, amplifier + 1) : 1;
        if (name === 'fireResistance') {
            out.fireResistance = true;
            continue;
        }
        out[name as Exclude<keyof CombatSelfFacts['effects'], 'fireResistance'>] = level;
    }
    return out;
}

/** 物品上的保护附魔等级（读不到就 0）。 */
function protectionLevelOf(item: any): number {
    try {
        const enchants = item?.enchants;
        if (!Array.isArray(enchants)) return 0;
        const found = enchants.find((e: any) => String(e?.name ?? '').toLowerCase() === 'protection');
        const level = Number(found?.lvl ?? found?.level ?? 0);
        return Number.isFinite(level) ? level : 0;
    } catch {
        return 0;
    }
}

/** 锋利等级（读不到就 0）。 */
function sharpnessLevelOf(item: any): number {
    try {
        const enchants = item?.enchants;
        if (!Array.isArray(enchants)) return 0;
        const found = enchants.find((e: any) => String(e?.name ?? '').toLowerCase() === 'sharpness');
        const level = Number(found?.lvl ?? found?.level ?? 0);
        return Number.isFinite(level) ? level : 0;
    } catch {
        return 0;
    }
}

/**
 * 背包里**能打**的那件武器（按 DPS 选，不是按单次伤害）。
 *
 * 以前 `equipHighestAttack` 按 `attackDamage` 排序，而那个字段在现在的依赖里
 * 根本不存在——等于"按背包顺序拿第一把剑/斧"。这里按 DPS 选，顺带把
 * "下界合金斧 10 伤/1.0s = 10 DPS 排在钻石剑 7 伤/1.6s = 11.2 DPS 前面"
 * 那个坑绕开。
 */
function bestWeaponFrom(items: any[]): WeaponProfile | null {
    let best: WeaponProfile | null = null;
    for (const item of items) {
        const name = String(item?.name ?? '');
        if (name === '') continue;
        // **附魔武器保护**（用户 2026-11-01）：到保护线的不参与战力估算——
        // 实际换手（equipHighestAttack）也不会用它，两边必须同一套判据，
        // 否则会"按附魔剑的 DPS 决定打，打起来却是空手"。
        if (isToolProtected(item)) continue;
        if (!isKnownWeapon(name)) continue; // 面包/圆石不是武器，别按"铁剑估值"混进来
        const profile = weaponProfileOf(name, sharpnessLevelOf(item));
        if (profile.kind === 'bow' || profile.kind === 'crossbow') continue; // 反射里不用远程
        if (profile.kind === 'fist') continue;
        const dps = profile.damage * profile.attacksPerSec;
        const bestDps = best == null ? -1 : best.damage * best.attacksPerSec;
        if (dps > bestDps) best = profile;
    }
    return best;
}

/** 读"我"这一侧的事实。读不到的字段按保守方向填（空手、无甲、未知难度）。 */
export function readSelfFacts(bot: any): CombatSelfFacts {
    const items: any[] = (() => {
        try {
            return (bot?.inventory?.items?.() ?? []) as any[];
        } catch {
            return [];
        }
    })();
    const slots = (bot?.inventory?.slots ?? []) as any[];
    const worn = [slots[5], slots[6], slots[7], slots[8]].filter((item) => item != null);
    const armor: ArmorProfile | null =
        worn.length > 0 ? armorFromItems(worn.map((item) => item?.name), worn.map(protectionLevelOf)) : null;
    const health = Number(bot?.health);
    const food = Number(bot?.food);
    const saturation = Number(bot?.foodSaturation);
    // mineflayer 的 `bot.game.difficulty` 是 0..3 的数字（0=和平），也兼容字符串。
    const rawDifficulty = bot?.game?.difficulty;
    const difficulty = typeof rawDifficulty === 'number'
        ? (['peaceful', 'easy', 'normal', 'hard'][rawDifficulty] ?? 'unknown')
        : String(rawDifficulty ?? 'unknown').toLowerCase();
    return {
        health: Number.isFinite(health) ? health : 20,
        maxHealth: 20,
        food: Number.isFinite(food) ? food : 20,
        saturation: Number.isFinite(saturation) ? saturation : 0,
        armor,
        weapon: bestWeaponFrom(items),
        shield: items.some((item) => String(item?.name ?? '') === 'shield'),
        effects: readEffects(bot),
        difficulty:
            difficulty === 'peaceful' || difficulty === 'easy' || difficulty === 'normal' || difficulty === 'hard'
                ? difficulty
                : 'unknown',
        inWater: bot?.entity?.isInWater === true,
        onGround: bot?.entity?.onGround === true,
    };
}

/** 读一只怪的血量：优先 metadata 的 `health` 字段，读不到就是 null。 */
function readMobHealth(bot: any, entity: any): number | null {
    try {
        const name = normalizeMobName(entity?.name);
        const keys = (bot?.registry?.entitiesByName?.[name]?.metadataKeys ?? bot?.registry?.entitiesByName?.[entity?.name]?.metadataKeys) as
            | string[]
            | undefined;
        if (!Array.isArray(keys)) return null;
        const index = keys.indexOf('health');
        if (index < 0) return null;
        const metadata = entity?.metadata;
        const value = metadata == null ? null : metadata[index];
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
        return null;
    }
}

/** 读服务端下发的属性值。 */
function attributeValue(entity: any, key: string): number | null {
    try {
        const value = entity?.attributes?.[key]?.value;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/** 它是否正对着我（yaw 差 ≤30°）。和 `edges.ts` 的 lockedOn 同一套坐标约定。 */
function isLockedOn(entity: any, feet: { x: number; z: number }): boolean {
    const yaw = Number(entity?.yaw);
    const p = entity?.position;
    if (!Number.isFinite(yaw) || p == null) return false;
    const dx = Number(feet.x) - Number(p.x);
    const dz = Number(feet.z) - Number(p.z);
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return false;
    // mineflayer: 0 = 北(-Z)，朝向向量是 (-sin, -cos)。
    const facingX = -Math.sin(yaw);
    const facingZ = -Math.cos(yaw);
    const length = Math.hypot(dx, dz) || 1;
    const dot = (facingX * dx + facingZ * dz) / length;
    return dot >= Math.cos((30 * Math.PI) / 180);
}

/** 读附近的敌对生物（玩家不算；读不到位置/名字的跳过）。 */
export function readCombatEnemies(
    bot: any,
    radius: number,
    lastAttackerName: string | null = null,
): CombatEnemyFacts[] {
    const feet = bot?.entity?.position;
    if (feet == null) return [];
    const selfId = bot?.entity?.id;
    const attacker = normalizeMobName(lastAttackerName ?? '');
    const out: CombatEnemyFacts[] = [];
    try {
        for (const raw of Object.values((bot?.entities ?? {}) as Record<string, any>)) {
            const entity = raw as any;
            if (entity == null || entity.id === selfId) continue;
            const p = entity.position;
            if (p == null) continue;
            const name = normalizeMobName(entity.name ?? entity.displayName);
            if (name === '' || name === 'item' || name === 'experience_orb' || name === 'arrow') continue;
            const isPlayer = String(entity.type ?? '').toLowerCase() === 'player' || name === 'player';
            // `isHostile` 依赖登录后才有的 mcdata；测试夹具/模拟里用 `type: 'hostile'` 兜底。
            const hostile =
                isHostile(entity) || String(entity.type ?? '').toLowerCase() === 'hostile';
            if (!isPlayer && !hostile) continue;
            const distance = Math.hypot(Number(p.x) - Number(feet.x), Number(p.y) - Number(feet.y), Number(p.z) - Number(feet.z));
            if (!Number.isFinite(distance) || distance > radius) continue;
            out.push({
                id: typeof entity.id === 'number' ? entity.id : -1,
                name: isPlayer ? 'player' : name,
                distance,
                health: readMobHealth(bot, entity),
                maxHealth: attributeValue(entity, 'generic.max_health'),
                attackDamage: attributeValue(entity, 'generic.attack_damage'),
                movementSpeed: attributeValue(entity, 'generic.movement_speed'),
                lockedOn: !isPlayer && isLockedOn(entity, { x: Number(feet.x), z: Number(feet.z) }),
                attackingMe: !isPlayer && attacker !== '' && name === attacker,
                isPlayer,
            });
        }
    } catch {
        // 实体表读不到就当没看见（保守：不接管）。
    }
    return out;
}

// ── 决策 ────────────────────────────────────────────────────────────────────

export interface CombatReflexInput {
    self: CombatSelfFacts;
    enemies: readonly CombatEnemyFacts[];
    policy: CombatPolicy;
    now: number;
    /** 这一 episode 是否已经在打。 */
    engaged: boolean;
    engagedSince: number | null;
    cooldownUntil: number;
    /** 保命反射（escape/surface/lava…）正在跑。 */
    otherReflexActive: boolean;
    /** 苦力怕反射正在跑（它优先）。 */
    creeperReflexActive: boolean;
    /** 模型关掉了保命程序：身体归模型。 */
    safeguardsSuppressed: boolean;
}

export interface CombatPlan {
    action: 'engage' | 'flee' | 'hold' | 'none' | 'yield';
    targetId: number | null;
    reason: string;
    assessment: CombatAssessment | null;
}

const NONE = (reason: string): CombatPlan => ({ action: 'none', targetId: null, reason, assessment: null });

/** 它现在算不算"会威胁到我"：在它自己的警戒距离内、盯着我、或刚打过我。 */
function actionable(enemy: CombatEnemyFacts): boolean {
    if (enemy.attackingMe) return true;
    const profile = mobProfileOf(enemy.name);
    const range = profile?.aggroRange ?? 8;
    return enemy.distance <= range || (enemy.lockedOn && enemy.distance <= Math.max(range, 16));
}

/**
 * 一次判决。
 *
 * 顺序：
 *   1. 模型关了保命 / 别的反射在跑 / 苦力怕反射在跑 ⇒ yield（让位，不抢）；
 *   2. 冷却中 ⇒ none；
 *   3. 已经在打且超时 ⇒ flee（交还身体）；
 *   4. 苦力怕在 14 格内 ⇒ none（它归 `creeper_reflex`）；
 *   5. 没有"会威胁到我"的怪 ⇒ none；
 *   6. 战力公式（entry/hold 两档阈值）⇒ engage / flee / hold。
 */
export function planCombatResponse(input: CombatReflexInput): CombatPlan {
    const { policy } = input;
    if (policy.mode === 'off') return NONE('战斗反射已关闭');
    if (input.safeguardsSuppressed) return { action: 'yield', targetId: null, reason: '模型关闭了保命程序，身体归模型', assessment: null };
    if (input.creeperReflexActive) return { action: 'yield', targetId: null, reason: '苦力怕反射正在处理', assessment: null };
    if (input.otherReflexActive) return { action: 'yield', targetId: null, reason: '更高优先级的保命反射正在跑', assessment: null };
    if (input.now < input.cooldownUntil) return NONE('冷却中');

    const inRange = input.enemies.filter((enemy) => !enemy.isPlayer && enemy.distance <= policy.scanRadius);
    // 苦力怕交给 creeper_reflex：它 14 格就开始处理，战斗反射不跟它抢。
    const creeperNear = inRange.some((enemy) => {
        const profile = mobProfileOf(enemy.name);
        return profile?.archetype === 'explosive' && enemy.distance <= 14;
    });
    if (creeperNear) return NONE('苦力怕在 14 格内，归 creeper_reflex 处理');

    // 只有"会威胁到我"的怪参与战力计算；远处的怪不该把 TTK 撑大。
    const threats = inRange.filter((enemy) => {
        const profile = mobProfileOf(enemy.name);
        const groupRange = Math.max(12, profile?.aggroRange ?? 8);
        return enemy.distance <= groupRange || enemy.attackingMe || enemy.lockedOn;
    });
    if (threats.length === 0) return NONE('附近没有会威胁到我的怪');

    const anyActionable = threats.some(actionable);
    if (!input.engaged && !anyActionable) return NONE('怪还没进入警戒范围');

    if (input.engaged && input.engagedSince != null && input.now - input.engagedSince > policy.maxEngageMs) {
        return { action: 'flee', targetId: null, reason: `交战超过 ${Math.round(policy.maxEngageMs / 1000)} 秒，交还身体`, assessment: null };
    }

    const assessment = assessCombat(input.self, threats, {
        mode: input.engaged ? 'hold' : 'entry',
        margin: policy.margin,
        exitMargin: policy.exitMargin,
    });

    if (assessment.verdict === 'fight') {
        // 已经在打：'fight' 的含义是"继续打"，不是"重新发起一次交战"。
        return input.engaged
            ? { action: 'hold', targetId: assessment.targetId, reason: assessment.reason, assessment }
            : { action: 'engage', targetId: assessment.targetId, reason: assessment.reason, assessment };
    }
    if (assessment.verdict === 'flee') {
        return { action: 'flee', targetId: assessment.targetId, reason: assessment.reason, assessment };
    }
    if (assessment.verdict === 'ignore') return NONE(assessment.reason);
    // hold：已经在打就继续打（不重新决策），没在打就观望。
    return input.engaged
        ? { action: 'hold', targetId: assessment.targetId, reason: assessment.reason, assessment }
        : NONE(`观望：${assessment.reason}`);
}

// ── 回执 ────────────────────────────────────────────────────────────────────

/** 决策回执（一行，给模型看）。 */
export function formatCombatDecision(plan: CombatPlan): string {
    if (plan.assessment == null) return plan.reason;
    const a = plan.assessment;
    const label = plan.action === 'engage' ? '打' : plan.action === 'flee' ? '跑' : '观望';
    const detail = a.breakdown.length > 0 ? `，${a.breakdown.join('，')}` : '';
    return `我判断现在应该${label}，因为${plan.reason}${detail}。`;
}

export interface CombatResultInput {
    targetName: string;
    outcome: 'killed' | 'fled' | 'aborted' | 'timeout' | 'target-gone';
    healthBefore: number | null;
    healthAfter: number | null;
    ms: number;
    detail?: string;
}

/** 结果回执（一行，给模型看）。**只报实测**，没证据不说"打死了"。 */
export function formatCombatResult(result: CombatResultInput): string {
    const hp =
        result.healthBefore != null && result.healthAfter != null
            ? `，我掉了 ${Math.round((result.healthBefore - result.healthAfter) * 10) / 10} 点血`
            : '';
    const seconds = Math.round(result.ms / 100) / 10;
    const tail = result.detail != null && result.detail !== '' ? `，另外${result.detail}` : '';
    switch (result.outcome) {
        case 'killed':
            return `战斗结束了，我击杀了 ${result.targetName}${hp}，一共用了 ${seconds} 秒${tail}。`;
        case 'fled':
            return `战斗结束了，我放弃交战，拉开了距离${hp}，一共用了 ${seconds} 秒${tail}。`;
        case 'target-gone':
            return `战斗结束了，${result.targetName} 已经不在${hp}，一共用了 ${seconds} 秒${tail}。`;
        case 'timeout':
            return `战斗结束了，${seconds} 秒内没有解决 ${result.targetName}，身体还给了我${hp}${tail}。`;
        case 'aborted':
        default:
            return `战斗结束了，${result.targetName} 没打完我就收手了${hp}，一共用了 ${seconds} 秒${tail}。`;
    }
}

export default {
    DEFAULT_COMBAT_POLICY,
    readCombatPolicy,
    readSelfFacts,
    readCombatEnemies,
    planCombatResponse,
    formatCombatDecision,
    formatCombatResult,
};
