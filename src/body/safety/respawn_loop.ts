/**
 * **重生循环破解器**（Lead 2026-10-21：真机 overnight_a「重生点就在骷髅射程内，出生即被射杀
 * 几十次；escape 只会放弃并交还身体不跑」）。
 *
 * 关键判断不是"有没有危险"，而是「**我是不是刚死在这里，又一次？**」——正常战斗里
 * escape 让位给模型是对的；重生循环里等模型的一轮推理=再死一次。所以这条是独立状态，
 * **不经过普通 yield 逻辑**，也不需要模型回合来启动。
 *
 * 优先级：(a) 沿"远离攻击者"的方向猛跑（方向是量出来的，不是随机）；
 *          (b) 跑不掉且还在掉血 ⇒ **直下 2–3 格再封顶**（骷髅跟不下来）；
 *          (c) 两条都做不到 ⇒ 明说「我在重生循环里，无法自救」+ 原因。
 * 有界：时间/步数；脱离（>24 格或无怪在 16 格内）立刻交还身体并写清经过。
 */
export interface RespawnRecord {
    /** 死亡时刻（ms）。 */
    at: number;
    /** 死亡位置。 */
    x: number;
    y: number;
    z: number;
}

export const RESPAWN_LOOP_WINDOW_MS = 90_000;
/** 同一个小圈里死两次也算循环（防止"跑两步又死"那种原地打转）。 */
export const RESPAWN_LOOP_RADIUS = 10;
/** 认为"已经脱离危险"的直线距离（格）。 */
export const RESPAWN_SAFE_DISTANCE = 24;
/** "还危险"的检测半径（格）。 */
export const RESPAWN_DANGER_RADIUS = 16;

/** 记录一次死亡（有界保存最近 8 条）。纯函数，便于测试。 */
export function appendDeath(deaths: RespawnRecord[], record: RespawnRecord): RespawnRecord[] {
    const next = [...deaths, record].sort((a, b) => a.at - b.at);
    return next.slice(-8);
}

/**
 * 现在是不是在重生循环里？条件是「窗口内死过 ≥2 次」：
 * - 两次都在 `RESPAWN_LOOP_WINDOW_MS` 内；**或者**
 * - 两次都发生在当前位置 `RESPAWN_LOOP_RADIUS` 内（还会被同一个点反复杀）。
 * 读不到当前位置 ⇒ 只按时间窗口判定（宁可早一点自救，也不等第三次死亡）。
 */
export function respawnLoopVerdict(input: {
    deaths: RespawnRecord[];
    now: number;
    position?: { x: number; y: number; z: number } | null;
}): { inLoop: boolean; deathsInWindow: number; reason: string } {
    const recent = input.deaths.filter((death) => input.now - death.at <= RESPAWN_LOOP_WINDOW_MS);
    const last = input.deaths[input.deaths.length - 1] ?? null;
    const previous = input.deaths[input.deaths.length - 2] ?? null;
    if (last == null || previous == null) {
        return { inLoop: false, deathsInWindow: recent.length, reason: 'fewer-than-two-deaths' };
    }
    const pos = input.position ?? null;
    // **同一个点反复死**：只看最近两次死亡是否都在当前位置附近（时间放宽到 10 个窗口，
    // 因为"跑两步又死回原地"本来就可能隔几分钟）。
    const nearSamePoint =
        pos != null &&
        input.now - previous.at <= RESPAWN_LOOP_WINDOW_MS * 10 &&
        Math.hypot(last.x - pos.x, last.z - pos.z) <= RESPAWN_LOOP_RADIUS &&
        Math.hypot(previous.x - pos.x, previous.z - pos.z) <= RESPAWN_LOOP_RADIUS;
    const sameWindow =
        recent.length >= 2 &&
        recent[recent.length - 1]!.at - recent[recent.length - 2]!.at <= RESPAWN_LOOP_WINDOW_MS;
    if (sameWindow || nearSamePoint) {
        return {
            inLoop: true,
            deathsInWindow: Math.max(recent.length, 2),
            reason: sameWindow ? 'two-deaths-within-window' : 'two-deaths-near-same-point',
        };
    }
    return { inLoop: false, deathsInWindow: recent.length, reason: 'deaths-too-far-apart' };
}

/** 循环 verdict 为真时，普通 yield（如 empty-after-death）**不许赢**。 */
export function shouldYieldBePreempted(input: { inLoop: boolean; yieldReason: string }): boolean {
    return input.inLoop === true && input.yieldReason.length > 0;
}

export type RespawnEscapeAction = 'sprint-away' | 'dig-seal' | 'give-up';

export interface RespawnEscapePlan {
    action: RespawnEscapeAction;
    /** 远离攻击者的水平方向（单位向量）；没有攻击者时为 null。 */
    away: { x: number; z: number } | null;
    reason: string;
}

/**
 * 循环中的行动顺序（纯函数）：
 * - 有怪且能跑 ⇒ sprint-away；
 * - 有怪但跑不掉（没体力/被围/血很低）且能挖 ⇒ dig-seal；
 * - 都不行 ⇒ give-up（带原因）。
 */
export function planRespawnEscape(input: {
    /** 空手（重生后没装备）：贴脸怪面前跑不掉，标准解法是**立刻挖脚下自封**。 */
    handEmpty?: boolean;
    threats: Array<{ x: number; z: number; distance: number }>;
    health: number | null;
    canDig: boolean;
    canPlace: boolean;
}): RespawnEscapePlan {
    const threat = [...input.threats].sort((a, b) => a.distance - b.distance)[0] ?? null;
    const away =
        threat == null
            ? null
            : (() => {
                  const dx = -threat.x;
                  const dz = -threat.z;
                  const len = Math.hypot(dx, dz) || 1;
                  return { x: dx / len, z: dz / len };
              })();
    if (threat != null && away != null) {
        // **空手 + 贴脸（≤3 格）**：speed 相同跑不掉，挖脚下自封是唯一可行动作。
        if (input.handEmpty === true && threat.distance <= 3 && input.canDig) {
            return { action: 'dig-seal', away, reason: '空手且怪贴身（' + Math.round(threat.distance) + ' 格）：立刻挖脚下自封' };
        }
        const desperate = input.health != null && input.health <= 6;
        if (!desperate) return { action: 'sprint-away', away, reason: `远离 ${Math.round(threat.distance)} 格外的敌对生物` };
        if (input.canDig) return { action: 'dig-seal', away, reason: '血太低跑不掉：直下 2 格再封顶' };
        return { action: 'give-up', away, reason: '血太低、跑不掉也挖不了' };
    }
    if (input.canDig && input.canPlace) return { action: 'dig-seal', away, reason: '看不到攻击者但刚死过两次：直下封顶' };
    return { action: 'give-up', away, reason: '无攻击者可测、也无法挖洞' };
}

/** 给模型的回执：说清"连死几次、我把你带到哪、别马上回去"。 */
export function formatRespawnEscapeReceipt(input: {
    deaths: number;
    action: RespawnEscapeAction;
    position: { x: number; y: number; z: number };
    nearestThreatDistance: number | null;
    gaveUpReason?: string | null;
}): string {
    const pos = `(${Math.floor(input.position.x)}, ${Math.floor(input.position.y)}, ${Math.floor(input.position.z)})`;
    if (input.action === 'give-up') {
        return (
            `**我在重生循环里，无法自救**（原因：${input.gaveUpReason ?? '未知'}）。` +
            `刚才 ${input.deaths} 次死亡都发生在这个点附近；我已经尽力跑到 ${pos}。` +
            '请用 Stop 接管，或明确告诉我往哪个方向走/挖哪一格——**别在原地等下一箭**。'
        );
    }
    const how = input.action === 'dig-seal' ? '直下挖了个洞并封住顶上' : '往远离攻击者的方向跑开了';
    const threat =
        input.nearestThreatDistance == null ? '' : `，最近敌对生物 ${Math.round(input.nearestThreatDistance)} 格`;
    return (
        `你刚才在 90 秒内连着死了 ${input.deaths} 次——我**没有等你下令**，直接${how}，现在在 ${pos}${threat}。` +
        '**别马上回去**：先确认周围没怪、天黑就躲；要回去也换个方向绕过去。'
    );
}
