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
    action: CreeperAction;
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
    if (result.action === 'yield') return '苦力怕逼近，但身体被更高优先级反射占用（死亡恢复/重生循环）——反射让位。';
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
