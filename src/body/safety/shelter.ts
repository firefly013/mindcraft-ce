/**
 * **天黑 / 庇护所辅助**（Lead 2026-10-21：两小时内两次满盘重置，A 死前有铁剑+2 铁锭+打火石，
 * 一次还有钻石镐——"小心一点"这种话没用，模型看不见太阳落山跨了多少轮）。
 *
 * 这是 **assist，不是 gate**（用户原话：「LLM 反应慢我就加保命，LLM 不擅长啥我就帮助它」）：
 * 天快黑/已黑 + 不在密封点亮空间 ⇒ 身体主动挖个 1×2 洞躲进去、封口、放火把，并把
 * 「我在哪、为什么、你可以做什么」写进回执。**有界、可让位**（模型动作/Stop/保命反射
 * 一律优先），**读不到任何关键输入 ⇒ 什么都不做**（坏掉的辅助不许变成墙）。
 */
export interface ShelterFacts {
    /** 世界时间（tick，0..24000）。 */
    timeOfDay: number | null;
    /** 头顶是否有实心方块（密封感），null = 读不到。 */
    hasRoof: boolean | null;
    /** 附近（≈6 格）有没有火把类光源。 */
    hasLight: boolean | null;
    health: number | null;
    /** 背包里有火把吗（有就能点亮）。 */
    hasTorch: boolean;
    /** 背包里的可放置方块数（封口用；≤1 不封，避免把自己砌死）。 */
    placeableBlocks: number;
}

export type ShelterAction = 'shelter' | 'light-only' | 'none';

export interface ShelterPlan {
    action: ShelterAction;
    reason:
        | 'day'
        | 'already-safe'
        | 'unreadable'
        | 'night'
        | 'night-soon'
        | 'too-dark-no-material'
        | 'no-bed-no-roof';
    /** 给模型/日志的一句话（none 时为空）。 */
    detail: string;
}

/** 夜晚开始/结束（Minecraft 1.21：13000 入夜，23000 天亮前）。 */
export const NIGHT_START = 13000;
export const NIGHT_END = 23000;
/** 提前这么多 tick 开始找庇护所（1200 tick = 60 秒）。 */
export const SHELTER_LEAD_TICKS = 1200;
/** 每天最多主动躲几次（防止刷屏/反复挖洞）。 */
export const SHELTER_MAX_PER_NIGHT = 2;

export function isNight(timeOfDay: number): boolean {
    return timeOfDay >= NIGHT_START || timeOfDay < 1000;
}

/** 距离天黑还有多少 tick（已经黑了 = 0）。 */
export function ticksToNight(timeOfDay: number): number {
    if (isNight(timeOfDay)) return 0;
    return Math.max(0, NIGHT_START - timeOfDay);
}

/**
 * 决策（纯函数，全部输入都是**测量值**；任一关键项读不到 ⇒ none + unreadable）。
 * 顺序：白天/已安全 → 什么都不做；天快黑/已黑 + 没屋顶/没光 → 行动。
 */
export function planShelter(facts: ShelterFacts): ShelterPlan {
    const { timeOfDay, hasRoof, hasLight } = facts;
    if (timeOfDay == null || hasRoof == null || hasLight == null) {
        return { action: 'none', reason: 'unreadable', detail: '' };
    }
    const night = isNight(timeOfDay);
    const soon = ticksToNight(timeOfDay) <= SHELTER_LEAD_TICKS;
    if (!night && !soon) return { action: 'none', reason: 'day', detail: '' };
    const sealed = hasRoof === true;
    if (sealed && hasLight === true) return { action: 'none', reason: 'already-safe', detail: '' };
    // 已经封顶只缺光：点一支火把（不挖洞、不移动，最省）。
    if (sealed && hasLight === false) {
        if (facts.hasTorch) {
            return {
                action: 'light-only',
                reason: night ? 'night' : 'night-soon',
                detail: '天黑了、帽子盖着但没光：点一支火把（怪会刷在暗处）。',
            };
        }
        return { action: 'none', reason: 'too-dark-no-material', detail: '' };
    }
    // 没封顶：有方块就挖洞封口；没有就只点个火把（如果恰好有火把+能封的方块都没有就什么也不做）。
    if (facts.placeableBlocks >= 2) {
        return {
            action: 'shelter',
            reason: night ? 'night' : 'night-soon',
            detail: '天黑了/快黑了，你头上没有遮蔽：挖个 1×2 洞、封住入口、放火把，等天亮再出去。',
        };
    }
    if (facts.hasTorch) {
        return {
            action: 'light-only',
            reason: night ? 'night' : 'night-soon',
            detail: '天黑了，你没有可封口的方块：至少把火把插在脚边（不要站在纯黑里过夜）。',
        };
    }
    return { action: 'none', reason: 'too-dark-no-material', detail: '' };
}

/** 行动成功后的回执（模型要能据此规划：我在哪、能做什么、什么时候出去）。 */
export function formatShelterReceipt(input: {
    position: { x: number; y: number; z: number };
    action: 'shelter' | 'light-only';
    health: number | null;
    ticksToDawn: number;
    sealed: boolean;
    lit: boolean;
}): string {
    const pos = `(${Math.floor(input.position.x)}, ${Math.floor(input.position.y)}, ${Math.floor(input.position.z)})`;
    const dawn = Math.max(0, Math.ceil(input.ticksToDawn / 20));
    const head = `天黑了，我在 ${pos} ${input.action === 'shelter' ? '挖了个洞先躲着' : '点了火把'}（血 ${input.health ?? '?'}）。`;
    const state =
        `${input.sealed ? '入口已封住' : '入口没封住（手上没有可封的方块）'}、` +
        `${input.lit ? '洞里有光' : '洞里没光——别在这里久留，至少别在视野死角背对门口'}`;
    return (
        head +
        state +
        `，还有约 ${dawn} 秒天亮。赶紧趁着安全：合成、整理背包、吃一口，天一亮就走。` +
        '如果你有更重要的计划，直接下指令即可（Stop 会把身体立刻还给你）。'
    );
}
