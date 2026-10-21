/**
 * **苦力怕反射**（用户 spec：有盾就用盾挡一下；没盾就抓紧跑路；Lead 2026-10-21）。
 * 身体层、tick 驱动，**不是模型调用的工具，也不是门**：模型来不及（爆炸引信 ~1.5s，
 * LLM 一回合几秒）。已经 3 次因为"低血穿苦力怕"丢满包（含钻石镐）。
 *
 * 本模块是纯决策 + 回执格式；动作由 body 执行（举盾 activateItem / 远离移动）。
 * 原则：只报实测——举盾后掉血、跑出后距离、被炸了掉多少，**没有证据不许说"躲过了"**。
 */
/** 8 格起反应（Lead 2026-10-21 真机：盾分支 3.9 格才触发时已吃到 1.8 伤害——举盾不是瞬发，必须更早）。 */
export const CREEPER_ALERT_RANGE = 8;
export const CREEPER_SAFE_DISTANCE = 10;
export const CREEPER_BLOCK_MAX_MS = 2500;
export const CREEPER_REFLEX_COOLDOWN_MS = 3000;
export const CREEPER_RUN_MAX_STEPS = 20;
export const CREEPER_RUN_MAX_MS = 20_000;

export type CreeperAction = 'block' | 'run' | 'yield' | 'none';
export type CreeperOutcome = 'blocked' | 'tookDamage' | 'ran' | 'tooLate';

export interface CreeperCandidate {
    name?: string;
    distance: number;
    /** 上一次观测到的距离；null = 第一次看到（不判靠近）。 */
    prevDistance?: number | null;
}

export interface CreeperPlanInput {
    health: number | null;
    /** 当前视野里的苦力怕（只传 6 格内的更省事，但函数自己再过滤）。 */
    creepers: CreeperCandidate[];
    hasShield: boolean;
    sheltered: boolean;
    cooldownActive: boolean;
    /** recoverAfterDeath / respawnLoop 等更高优先级反射进行中。 */
    otherReflexActive: boolean;
}

export interface CreeperPlan {
    action: CreeperAction;
    /** 触发的那只苦力怕距离。 */
    distance: number | null;
    /** 逃逸方向（远离苦力怕的归一化水平向量）；run 时用。 */
    away: { x: number; z: number } | null;
    reason: string;
}

/** 是否正在逼近：距离 ≤ 上次观测，或首次进入范围（保守触发）。 */
function approaching(creeper: CreeperCandidate): boolean {
    if (typeof creeper.prevDistance !== 'number') return true;
    return creeper.distance <= creeper.prevDistance + 0.25;
}

export function planCreeperResponse(input: CreeperPlanInput, creeperPos: { x: number; z: number } | null = null): CreeperPlan {
    const none = (reason: string): CreeperPlan => ({ action: 'none', distance: null, away: null, reason });
    if (input.otherReflexActive) return { action: 'yield', distance: null, away: null, reason: '更高优先级反射（死亡恢复/重生循环）占用身体' };
    if (input.cooldownActive) return none('冷却中');
    const threat = input.creepers
        .filter((creeper) => (creeper.name ?? 'creeper').toLowerCase().includes('creeper'))
        .filter((creeper) => creeper.distance <= CREEPER_ALERT_RANGE)
        .filter((creeper) => creeper.distance <= CREEPER_SAFE_DISTANCE)
        .filter(approaching)
        .sort((a, b) => a.distance - b.distance)[0];
    if (threat == null) return none('没有逼近的苦力怕');
    if (input.sheltered) return none('已经在封闭空间里（有掩体/被挡住）');
    const away =
        creeperPos == null
            ? null
            : { x: 0 - creeperPos.x, z: 0 - creeperPos.z };
    const normalized =
        away == null
            ? null
            : (() => {
                  const length = Math.hypot(away.x, away.z) || 1;
                  return { x: away.x / length, z: away.z / length };
              })();
    return input.hasShield
        ? { action: 'block', distance: threat.distance, away: null, reason: `苦力怕 ${threat.distance.toFixed(1)} 格逼近，有盾：举盾` }
        : { action: 'run', distance: threat.distance, away: normalized, reason: `苦力怕 ${threat.distance.toFixed(1)} 格逼近，没盾：跑` };
}

export interface CreeperResult {
    action: CreeperAction | 'cover';
    /** 威胁类别（骷髅/僵尸/苦力怕），回执要点名。 */
    threatClass?: ThreatClass | null;
    outcome: CreeperOutcome;
    distance: number | null;
    healthBefore: number | null;
    healthAfter: number | null;
    ranBlocks?: number | null;
    steps?: number | null;
    elapsedMs?: number | null;
}

/** 事实回执：**只在证据支持时才说挡住了/跑了**，掉血就掉血。 */
export function formatCreeperReflexReceipt(result: CreeperResult): string {
    const healthBefore = result.healthBefore;
    const healthAfter = result.healthAfter;
    const damage = healthBefore != null && healthAfter != null ? Math.max(0, Math.round((healthBefore - healthAfter) * 10) / 10) : null;
    const dist = result.distance != null ? `${result.distance.toFixed(1)} 格` : '很近';
    const cls =
        result.threatClass === 'skeleton'
            ? '骷髅'
            : result.threatClass === 'zombie'
              ? '僵尸'
              : result.threatClass === 'creeper'
                ? '苦力怕'
                : '威胁';
    if (result.action === 'yield') return '威胁逼近，但身体被更高优先级反射占用（死亡恢复/重生循环）——反射让位。';
    if (result.action === 'cover') {
        const damageText =
            damage == null ? '掉血读不到' : damage === 0 ? '这一轮没再中箭' : `中箭掉血 ${damage}`;
        const slowNote = result.outcome === 'tooLate' ? '——慢了一步' : '';
        return `${cls} ${dist}、血 ${healthAfter ?? '读不到'}：退到掩体（${damageText}）${slowNote}。`;
    }
    if (result.outcome === 'blocked') {
        return `苦力怕 ${dist} 扑过来：举盾挡住（掉血 ${damage == null ? '读不到' : damage === 0 ? '0' : damage}）。`;
    }
    if (result.outcome === 'tooLate') {
        return `来不及，被炸了（掉血 ${damage == null ? '读不到' : damage}）。`;
    }
    if (result.outcome === 'tookDamage') {
        return `苦力怕 ${dist}：盾没完全挡住/被炸到（掉血 ${damage == null ? '读不到' : damage}）。`;
    }
    // ran：只报实测距离，不说"躲过了"
    return `没盾，跑了 ${result.ranBlocks == null ? '（距离读不到）' : `${Math.round(result.ranBlocks)} 格`}${result.steps != null ? `（${result.steps} 步）` : ''}；苦力怕是否炸/炸在原地没有观测到` +
        `${damage != null && damage > 0 ? `（掉血 ${damage}）` : ''}。`;
}

// ─────────────────────────── 威胁分类：同一个反射，不再只认苦力怕 ───────────────────────────
//
// 真机 2026-10-21 08:52 之后：苦力怕反射在线且有效（96 次触发、0 次被苦力怕炸死），
// 但 A 接着死在 **骷髅**（钻×6+青金石×7 全丢）和 **僵尸**（72 秒后第二次死）手里。
// 原因：反射只筛了 name.includes('creeper')。前提"僵尸/骷髅可以跑掉"只在有血、有退路时成立。
// 设计不变：一个反射、一个 owner flag、一个冷却、一条回执通道、让位给死亡恢复。

export type ThreatClass = 'creeper' | 'skeleton' | 'zombie';
export const SKELETON_ALERT_RANGE = 12;
/** 骷髅是远程：能把你射死，所以血 ≤14 才打断动作（满血不制造噪音）。 */
export const SKELETON_LOW_HEALTH = 14;
export const ZOMBIE_ALERT_RANGE = 5;
/** 僵尸慢，但低血挨一下也致命：血 ≤10 才跑。 */
export const ZOMBIE_LOW_HEALTH = 10;

export interface ThreatCandidate extends CreeperCandidate {
    threatClass: ThreatClass;
}

export interface ThreatPlanInput {
    health: number | null;
    /** 视野里的敌对生物（只传近处的省事，函数自己再按类别阈值过滤）。 */
    hostiles: ThreatCandidate[];
    hasShield: boolean;
    sheltered: boolean;
    cooldownActive: boolean;
    otherReflexActive: boolean;
}

export type ThreatAction = 'block' | 'run' | 'cover' | 'yield' | 'none';

export interface ThreatPlan {
    action: ThreatAction;
    threatClass: ThreatClass | null;
    distance: number | null;
    away: { x: number; z: number } | null;
    /** 为什么现在动（含健康门槛），给模型看。 */
    reason: string;
}

/** 统一威胁决策：苦力怕优先（不变），其次低血骷髅（找掩体），再次低血僵尸（跑开）。 */
export function planThreatResponse(
    input: ThreatPlanInput,
    selfPosition: { x: number; z: number } | null = null,
): ThreatPlan {
    if (input.otherReflexActive) {
        return { action: 'yield', threatClass: null, distance: null, away: null, reason: '更高优先级反射（死亡恢复/重生循环）占用身体' };
    }
    if (input.cooldownActive) return { action: 'none', threatClass: null, distance: null, away: null, reason: '冷却中' };
    const health = input.health;
    const approaching = (threat: ThreatCandidate): boolean =>
        typeof threat.prevDistance !== 'number' ? true : threat.distance <= threat.prevDistance + 0.25;
    const awayFrom = (threatPosition: { x: number; z: number } | null): { x: number; z: number } | null => {
        if (threatPosition == null || selfPosition == null) return null;
        const dx = selfPosition.x - threatPosition.x;
        const dz = selfPosition.z - threatPosition.z;
        const length = Math.hypot(dx, dz) || 1;
        return { x: dx / length, z: dz / length };
    };
    const nearest = (cls: ThreatClass): ThreatCandidate | null =>
        input.hostiles
            .filter((threat) => threat.threatClass === cls && approaching(threat))
            .sort((a, b) => a.distance - b.distance)[0] ?? null;

    // 1) 苦力怕：**不变**——≤8 格逼近，有盾举盾、没盾跑；与血量无关（一击毙命）。
    const creeper = nearest('creeper');
    if (creeper != null && creeper.distance <= CREEPER_ALERT_RANGE && !input.sheltered) {
        return {
            action: input.hasShield ? 'block' : 'run',
            threatClass: 'creeper',
            distance: creeper.distance,
            away: input.hasShield ? null : awayFrom((creeper as { position?: { x: number; z: number } }).position ?? null),
            reason: `苦力怕 ${creeper.distance.toFixed(1)} 格逼近${input.hasShield ? '，有盾：举盾' : '，没盾：跑'}`,
        };
    }
    // 2) 骷髅：远程、能隔着空地打死你 ⇒ 低血时找掩体（不直着冲空地），满血不动。
    const skeleton = nearest('skeleton');
    if (
        skeleton != null &&
        health != null &&
        health <= SKELETON_LOW_HEALTH &&
        skeleton.distance <= SKELETON_ALERT_RANGE &&
        !input.sheltered
    ) {
        return {
            action: 'cover',
            threatClass: 'skeleton',
            distance: skeleton.distance,
            away: awayFrom((skeleton as { position?: { x: number; z: number } }).position ?? null),
            reason:
                `骷髅 ${skeleton.distance.toFixed(1)} 格、血 ${Math.round(health)}（≤${SKELETON_LOW_HEALTH}）：` +
                '它是远程，别在空地跑直线——退到掩体/封住视线',
        };
    }
    // 3) 僵尸：低血 + 很近才跑（不近战）。
    const zombie = nearest('zombie');
    if (zombie != null && health != null && health <= ZOMBIE_LOW_HEALTH && zombie.distance <= ZOMBIE_ALERT_RANGE && !input.sheltered) {
        return {
            action: 'run',
            threatClass: 'zombie',
            distance: zombie.distance,
            away: awayFrom((zombie as { position?: { x: number; z: number } }).position ?? null),
            reason: `僵尸 ${zombie.distance.toFixed(1)} 格、血 ${Math.round(health)}（≤${ZOMBIE_LOW_HEALTH}）：跑开，不近战`,
        };
    }
    return { action: 'none', threatClass: null, distance: null, away: null, reason: '没有需要反应的威胁' };
}
