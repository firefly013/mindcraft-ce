/**
 * **`disableSafeguards` 的自杀式调用必须被拒。**
 *
 * 真机事故 2026-10-19 01:48（overnight_b，生产）：
 * ```
 * 17:48:35 [reflex/info] escape
 * 17:48:35 [event/5] World/L5 {"health":3.87,"damage":1,"by":"creeper","threatMeters":15}
 * 17:48:53 [action/info] disableSafeguards   ← 3.87 血、15 米外有苦力怕时关掉保命
 * 17:48:53 [action/info] attack
 * 17:48:53 [event/2] {"reflex":"escape","outcome":"muted","detail":"…25 秒内保命不会…"}
 * 17:48:57 health 3.87 → 1.87
 * ```
 * 模型为了打一只怪，把**正在跑的保命 escape** 静音了，然后继续挨打。差一点就为了
 * 一个目标不需要的理由死掉。这个开关存在的意义就是防这种事，所以它必须在
 * **正是那种时刻**拒绝。
 *
 * 关闭仍然允许（挖岩浆旁边的矿、满血打怪这些正当用途不许被挡），只在下面
 * 三条里拒绝：
 *   1. **正在跑保命反射**——中途静音就是今晚已经修过一次的那个洞（F-23）；
 *   2. **血少 + 怪近**（≤6 血且有敌对生物 ≤16 米），或 **≤3 血**（不管周围有什么）;
 *   3. **身处致命介质**：岩浆里 / 正在溺水 / 正在掉进虚空。
 *
 * 另外一件事：
 *   - 回执**不再把模型自己写的理由当成正当理由**引用（那是我们的文本在替它的
 *     坏判断背书）。
 */
import Vec3 from 'vec3';
import { isHostile } from '../data/mcdata.js';
import { headInWater } from './water_safety.js';

/** 这些反射的名字/意图一旦在跑，就不许关保命。 */
export const LIFE_SAVING_REFLEXES: ReadonlySet<string> = new Set([
    'escape',
    'surface',
    'escapeWater',
    'lava',
    'drown',
    'drowning',
    'void',
    'fall',
]);

export interface OverrideFacts {
    health: number | null;
    food: number | null;
    /** 最近的敌对生物距离（米）；没有就是 null。 */
    hostileMeters: number | null;
    /** 正在跑的保命反射名（没有就是 null）。 */
    reflex: string | null;
    reflexMs: number;
    inLava: boolean;
    /** 头在水里（正在溺水）。 */
    submerged: boolean;
    belowVoid: boolean;
}

export interface OverrideVerdict {
    allowed: boolean;
    text: string;
}

const REFLEX_HOSTILE_RADIUS_M = 16;
/**
 * 到这个血量**一律拒**，不看周围有没有怪。
 *
 * Lead 给的是"≤3 血不论周围"，而真机现场是 **3.87 血**、苦力怕在 15 米外
 * （模型自己也是刚被打到才发现）。所以阈值放到 4：**几点血的时候"看起来没事"
 * 是最不可信的一种没事**（怪可能在墙后、在视线外）。
 */
const CRITICAL_HEALTH = 4;
const LOW_HEALTH = 6;

function blockNameAt(bot: any, x: number, y: number, z: number): string {
    try {
        return String(bot?.blockAt?.(new Vec3(x, y, z))?.name ?? '');
    } catch {
        return '';
    }
}

function isLavaName(name: string): boolean {
    return name === 'lava' || name === 'flowing_lava';
}

/** 从 agent（MineflayerBody）读事实；读不到的字段一律 null（判不出来就不拿它当理由）。 */
export function collectOverrideFacts(agent: any): OverrideFacts {
    const bot = agent?.bot;
    const pos = bot?.entity?.position;
    const health = Number(bot?.health);
    const food = Number(bot?.food);
    const feet = pos == null ? null : { x: Math.floor(Number(pos.x)), y: Math.floor(Number(pos.y)), z: Math.floor(Number(pos.z)) };
    let inLava = false;
    if (feet != null) {
        inLava = isLavaName(blockNameAt(bot, feet.x, feet.y, feet.z)) || isLavaName(blockNameAt(bot, feet.x, feet.y + 1, feet.z));
    }
    let hostileMeters: number | null = null;
    try {
        const self = bot?.entity;
        for (const raw of Object.values(bot?.entities ?? {}) as any[]) {
            if (raw == null || raw.id === self?.id) continue;
            if (!isHostile(raw)) continue;
            const p = raw.position ?? {};
            const meters = Math.hypot(Number(p.x) - Number(pos?.x), Number(p.y) - Number(pos?.y), Number(p.z) - Number(pos?.z));
            if (Number.isFinite(meters) && (hostileMeters == null || meters < hostileMeters)) hostileMeters = meters;
        }
    } catch {
        hostileMeters = null;
    }
    let reflex: string | null = null;
    let reflexMs = 0;
    try {
        const status = agent?.reflexStatus?.();
        if (status != null && typeof status.reflex === 'string' && status.reflex !== '') {
            reflex = status.reflex;
            reflexMs = Number(status.ms) || 0;
        }
    } catch {
        reflex = null;
    }
    const minY = Number(bot?.game?.minY);
    const y = Number(pos?.y);
    const belowVoid = Number.isFinite(y) && Number.isFinite(minY) && y <= minY + 2;
    return {
        health: Number.isFinite(health) ? health : null,
        food: Number.isFinite(food) ? food : null,
        hostileMeters,
        reflex,
        reflexMs,
        inLava,
        submerged: (() => {
            try {
                return headInWater(bot) === true;
            } catch {
                return false;
            }
        })(),
        belowVoid,
    };
}

/**
 * 能不能关保命。**拒绝时绝不改动 safeguards**（调用方拿到 allowed=false 就直接返回文本）。
 */
export function disableSafeguardsVerdict(facts: OverrideFacts): OverrideVerdict {
    // **只有"身体被保命反射占着"这一条给下一步**（2026-10-30 用户裁定）：
    // 那是这一步失败的唯一出口（不先 Stop 就拿不回身体），不是策略选择。
    // 其余拒绝只陈述原因——怎么绕开是模型的事。
    const refuse = (why: string, advice: string, nextCall?: string): OverrideVerdict => ({
        allowed: false,
        text:
            `**拒绝**：${why}，现在关掉保命等于自杀。${advice}` +
            (nextCall == null || nextCall === '' ? '' : `\n    下一步（照做即可）：${nextCall}`),
    });

    // ① 正在跑保命反射：中途静音就是 F-23 那个洞的另一扇门。
    if (facts.reflex != null && LIFE_SAVING_REFLEXES.has(facts.reflex)) {
        const seconds = Math.max(0, Math.round(facts.reflexMs / 1000));
        return refuse(
            `你的保命反射「${facts.reflex}」正在跑（已 ${seconds} 秒）`,
            '它跑完会自己交还身体（连续占用超过 45 秒会主动让位 25 秒）；真急着要用身体就先 Stop，而不是把保命关掉。',
            'stop()（先把保命停下来、身体给你），然后再决定要不要关',
        );
    }
    // ② 致命介质：岩浆 / 溺水 / 虚空——没有商量余地。
    if (facts.inLava) {
        return refuse(
            '你**在岩浆里**',
            '在岩浆里关掉保命，等于把唯一会把你拖出去的东西关掉。',
        );
    }
    if (facts.submerged) {
        return refuse(
            '你的**头在水里**（正在溺水）',
            '逃出水面的反射是你现在唯一的呼吸来源。',
        );
    }
    if (facts.belowVoid) {
        return refuse(
            '你正在**往虚空里掉**',
            '掉出去就是死，保命反射是唯一还在救你的东西。',
        );
    }
    // ③ 血少 + 怪近（或血极少，不看周围）。
    const health = facts.health;
    const hostileNear = facts.hostileMeters != null && facts.hostileMeters <= REFLEX_HOSTILE_RADIUS_M;
    if (health != null && (health <= CRITICAL_HEALTH || (health <= LOW_HEALTH && hostileNear))) {
        const meters = facts.hostileMeters == null ? null : Math.round(facts.hostileMeters * 10) / 10;
        const why =
            `你只剩 ${Math.round(health * 100) / 100} 血` +
            (hostileNear && meters != null ? `、${meters} 格外有敌对生物` : '') +
            (facts.food != null && facts.food <= 6 ? `、食物 ${Math.round(facts.food)}` : '');
        return refuse(why, '先把血回到 8 以上、或者离开危险，再谈关闭保命（挖岩浆边上的矿、满血打怪这些正常用途照样允许）。');
    }
    // ④ 其余情况照旧允许。
    return {
        allowed: true,
        text: `保命程序已关闭`,
    };
}

/** 进攻类工具：**重伤时一律拒**（其它动作不许被这条守卫挡住）。 */
export const OFFENSIVE_TOOL_NAMES: ReadonlySet<string> = new Set(['attack', 'huntFor']);

/** `dangerous_ops.ts` 里注册的授权项：模型显式点头才能带伤开打。 */
export const COMBAT_OP = 'attack_at_low_health';

export interface CombatFacts {
    health: number | null;
    food: number | null;
    /** 背包里能吃的食物名（有的话，回执必须先让人吃东西，而不是先谈死）。 */
    foodItems?: string[] | null;
    /** 最近的敌对生物距离（米）；null = 读不到 / 周围没有。 */
    hostileMeters: number | null;
    /** **这一下要打的目标会不会还手**（猪/牛/羊/鸡 = false）。null = 读不到。 */
    targetFightsBack?: boolean | null;
    /** 模型已经用 `allowDangerousOps(…, ops="attack_at_low_health")` 显式授权过这一次。 */
    authorized?: boolean;
}

const DISENGAGE_HEALTH = 4;
const DISENGAGE_HEALTH_WITHOUT_FOOD = 6;
const NO_FOOD = 6;

/**
 * **重伤撤退守卫**：血 ≤4（任何情况），或血 ≤6 且食物 ≤6（没有回血手段）时，
 * 拒绝进攻类动作。
 *
 * 真机 2026-10-19（overnight_b，下界第 8 次死亡）：血 **1.53**、食物 4，模型正在
 * `attack(target=357368)`——"attack 成功"的回执让它以为进展顺利，直到被打死。
 * 反射只在挨打之后才接管；**它拦不住"在濒死时主动选择开打"这件事**。
 *
 * 这条守卫只做一件事：**别让模型把命押在一次进攻上**。它**不是锁**：吃、`getFood`、
 * `moveAway`、垫方块、逃生反射全部照旧可用，回执会把这些说出来。
 *
 * **例外：目标不会还手时不拦**（2026-10-24 修）。
 * 真机死锁：血 3、食物 11（<18 ⇒ 不回血）、一头猪在 4 格外，`huntFor` 被这道守卫拒了。
 * 猪/牛/羊/鸡打不还手，**挨不到一下**——把它和僵尸一起拦，等于把"低血时唯一的回血路"封死，
 * 而 `huntFor` 内部本来就为无害食物动物开了豁免（`isHarmlessFoodMob`），只是被这道外层守卫盖掉了。
 * 危险来自"被反击"，不是来自"发起攻击"这个动作本身。
 *
 * **这道闸也能显式授权**（2026-10-30 用户裁定）：默认拒绝，但模型可以
 * `allowDangerousOps(…, ops="attack_at_low_health")` 点头一次。理由和 `departure_guard`
 * 一致——读数是算术，"这次值不值得赌"仍是模型的判断（比如它只想补最后一刀、或者
 * 那只怪已经残血）。引擎负责把代价写清楚，不负责替它决定。
 */
export function combatRefusalVerdict(facts: CombatFacts): { allowed: boolean; text: string } {
    const health = facts.health;
    if (health == null) return { allowed: true, text: '' };
    const food = facts.food;
    const noHeal = food != null && food <= NO_FOOD;
    const critical = health <= DISENGAGE_HEALTH;
    const lowAndNoHeal = health <= DISENGAGE_HEALTH_WITHOUT_FOOD && noHeal;
    if (!critical && !lowAndNoHeal) return { allowed: true, text: '' };
    // **目标不会还手 ⇒ 没有"挨一下就没了"这回事**，放行（读不到目标性质时照旧拦）。
    if (facts.targetFightsBack === false) return { allowed: true, text: '' };
    // 显式授权过就放行（`allowDangerousOps` 带次数/时间额度，用完自动回到默认拒绝）。
    if (facts.authorized === true) return { allowed: true, text: '' };

    const healthText = Math.round(health * 100) / 100;
    const foodText = food == null ? '食物读不到' : `食物 ${Math.round(food)}`;
    const threat =
        facts.hostileMeters == null ? null : Math.round(facts.hostileMeters * 10) / 10;
    const parts: string[] = [];
    parts.push(
        `**拒绝**：你只剩 ${healthText} 血、${foodText}` +
            (threat != null ? `、${threat} 格外有敌对生物` : '') +
            `——现在打怪是最快的死法（挨一下就没了，而你没有回血手段）。`,
    );
    parts.push('**逃跑、吃东西、垫方块、`escapeWater`、保命反射都不受这条限制**——它只拦进攻。');
    // **唯一出口**：这次就是想打。写明确切的授权调用（参数名猜错一次就白费一回合）。
    parts.push('硬要现在打就显式授权这一次：`allowDangerousOps(calls=1, reason="…", ops="attack_at_low_health")`。');
    // **不再排"下一步"**（2026-10-30 用户裁定）：吃哪样、先脱战还是先吃，是它自己的判断。
    // 回执只报事实：背包里有什么能吃的。
    const foodItems = (facts.foodItems ?? []).filter((name) => typeof name === 'string' && name !== '');
    if (foodItems.length > 0) {
        parts.push(`你背包里有能吃的：${foodItems.slice(0, 3).join('、')}。`);
    } else {
        parts.push('背包里没有能吃的。');
    }
    return { allowed: false, text: parts.join('\n    ') };
}