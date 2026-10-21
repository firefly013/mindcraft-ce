import * as mc from "../data/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { cellIntersectsBody, standingRoomOk } from '../safety/suffocation.js';
import { isJustPlacedDrop, markPlaced, placementVerdict } from './placement_guard.js';
import { formatProgressLine, formatTimeoutSummary, LONG_ACTION_MAX_MS, recordActionProgress, shouldEmitProgress } from './progress.js';
import { estimateDigSeconds, formatNoObstacleDiagnosis, planClearStep } from '../safety/step_diagnosis.js';
/**
 * ⚠️ **必须读共享单例，不许读根目录那份 `settings.ts`。**
 *
 * 根 `settings.ts` 是**主进程**（MindServer 宿主）的配置字面量；身体进程拿到的是
 * 大脑转交过来的那一份，写在 `shared/settings.ts` 的单例里（`body/index.ts`
 * 的 `setSettings`）。以前这里 import 的是根那份，于是身体里的 `settings.cheat`
 * **永远是 false**——`/setblock`、瞬间放置这些 OP 快捷路径全是死代码，
 * 配了 `"cheat": true` 也不生效，而且没有任何报错。
 */
import settings from "../../shared/settings.js";
import { inventoryLossAdvice } from "../../shared/inventory_advice.js";
import { permits, opContextFor } from "../safety/permits.js";
import { refuseText } from "../safety/dangerous_ops.js";
import {
    blockAtFrom,
    waterUnderFeet,
    headInWater,
    dangerousWaterRefusal,
    type WaterClass,
} from "../safety/water_safety.js";
import { teleportRefusal } from "../safety/dangerous_blocks.js";
import { applyScaffoldingBlocks, movementsFor, MAX_DROP_DOWN } from "../safety/movements.js";
import { deepWaterAllowed } from "../safety/permits.js";
import { assessStandingSpot, chooseSafeFleeTarget } from "../safety/flee.js";
import { safeguards } from "../safety/safeguards.js";
import { cookedCounterpartOf, difficultyOf, foodValueOf, normalizeFoodName, starvationNote } from "../safety/emergency.js";

/**
 * `bot.output` 的硬上限（字符）。
 *
 * 为什么要在**唯一的写入点**上闸（真机 2026-10-18 19:19）：`huntFor` 内部 attack 参数写错 →
 * 每次攻击都被拒 → 每次拒绝都 `log()` → **315 万行、1.35 亿字符**塞进 `bot.output`，
 * 把整段上下文打爆（F-21 的上游原因）。下游的 clamp（动作通道 20k、回执 20k）只能事后掩盖，
 * 挡不住"已经烧掉的 315 万次迭代"。**在源头留头尾**才是把这一整类病堵死。
 */
export const MAX_BOT_OUTPUT_CHARS = 20_000;
/** 截断时头部保留多少（尾部保留剩下的；尾部通常是回执和"下一步"）。 */
export const BOT_OUTPUT_HEAD_CHARS = 4_000;

/**
 * 把超长的输出截成**头 + 省略标记 + 尾**（纯函数，可单测）。
 * 保留头是因为一轮动作的"起因/警告"往往在最前面，保留尾是因为回执在最后。
 */
export function capBotOutput(text: string, max: number = MAX_BOT_OUTPUT_CHARS): string {
    if (typeof text !== 'string' || text.length <= max) return text;
    const head = text.slice(0, BOT_OUTPUT_HEAD_CHARS);
    const notice = `…（本次动作输出过长：中间省略 ${text.length - max} 字符，共 ${text.length} 字符）…\n`;
    const tailBudget = Math.max(0, max - head.length - notice.length);
    return `${head}${notice}${text.slice(text.length - tailBudget)}`;
}

/**
 * 把回执写进 `bot.output`（模型的工具回执就是从这里来）。
 *
 * **唯一写入点 + 硬上限**：任何"循环里反复 log"的失控都不会再把上下文打爆。
 */
export function log(bot: any, ...messages: any[]): void {
    if (typeof bot?.output !== 'string') bot.output = '';
    bot.output += messages.join(' ') + '\n';
    if (bot.output.length > MAX_BOT_OUTPUT_CHARS) bot.output = capBotOutput(bot.output);
}

/**
 * 徒手能挖的最长耗时（毫秒）。
 *
 * 空手破坏"要镐才有掉落"的软方块——下界岩 0.4（约 2s）、沙子 0.5（2.5s）、
 * 沙砾 0.6（3s）——都在 3 秒内；石头 1.5 要 7.5s、深板岩 3 要 15s，
 * 不该鼓励徒手硬挖。门槛卡在 3s 正好把"挖得动"和"挖到天亮"分开。
 */
/**
 * 徒手挖穿的上限（毫秒）。
 *
 * **3000 → 3200 的理由（真机 2026-10-19/20）**：`oak_log` 徒手 digTime 正好
 * **3000ms**（hardness 2.0 × 1.5），而判定是 `ms <= 上限` ⇒ 零余量，
 * 浮点误差或数据版本一变就掉出去，木头的"空手可挖"承诺立刻失效
 * （而这是空手 bootstrap 链的第一步：木头 → 木板 → 工作台 → 木剑/木镐）。
 * 抬到 3200 只多放行"徒手 3.0–3.2 秒"这一档，等于把这几个原木的抖动吃掉。
 */
export const BARE_HAND_MAX_DIG_MS = 3200;

/**
 * 没有正确工具时，能不能徒手挖掉这个方块（只求挖开，不保证掉落）。
 *
 * 为什么需要：模型真机报告无镐的机器人在下界被封在实心 netherrack 口袋里
 * ——寻路器因为 `Cannot break netherrack with current tools` 不肯挖路，
 * `mineBlock` 又因为 `canHarvest` 为 false 直接拒绝，两边一夹就是永久卡死
 * （Feedback #38/#43：`move` 只挪 0.2 格、`goToCoordinates` 报寻路停、
 * `mineBlock` 报没有工具）。**挖穿不需要正确工具，只需要挖得动。**
 */
export function isHandMineable(block: any): boolean {
    if (block == null) return false;
    const hardness = typeof block.hardness === 'number' ? block.hardness : null;
    if (hardness == null || hardness < 0) return false;   // -1 = 不可破坏（基岩/屏障）
    if (block.diggable === false) return false;
    let ms: number | null = null;
    if (typeof block.digTime === 'function') {
        try {
            const t = block.digTime(null, false, false, false);
            if (Number.isFinite(t) && t > 0) ms = t;
            else if (t === Infinity) return false;
        } catch {
            ms = null;
        }
    }
    // 没有 digTime（替身/旧版本）：徒手基准 硬度 × 5 秒。
    if (ms == null) ms = hardness * 5000;
    return ms <= BARE_HAND_MAX_DIG_MS;
}

/**
 * 这个方块**到底能不能被挖穿**——与"有没有掉落"无关。
 *
 * 为什么必须和 `canHarvest` 分开：`canHarvest` 回答的是"挖了掉不掉落"，
 * 而"能不能挖开"是另一个问题。下界岩徒手挖得动（2 秒）但没有掉落；
 * 拿 `canHarvest` 当"能不能挖"用，就会在无镐时把路判死（真机原文：
 * `Pathfinding stopped: Cannot break netherrack with current tools`，
 * 人被困在实心口袋里出不来）。
 *
 * 只有**真挖不动**才返回 false：不可破坏（硬度 -1 / digTime Infinity）
 * 或 `diggable === false`。读不到数据时返回 true——宁可让 dig/寻路自己试，
 * 也不要凭一个读不到的数把路封死。
 */
export function isBreakable(block: any): boolean {
    if (block == null) return false;
    const hardness = typeof block.hardness === 'number' ? block.hardness : null;
    if (hardness != null && hardness < 0) return false;   // -1 = 不可破坏（基岩/屏障）
    if (block.diggable === false) return false;
    if (typeof block.digTime === 'function') {
        try {
            const t = block.digTime(null, false, false, false);
            if (t === Infinity) return false;
        } catch {
            // 读不到 digTime 不影响判断：下面按"能挖"处理。
        }
    }
    return true;
}

/**
 * 寻路挖路看门狗的判据：什么时候必须停下寻路。
 *
 * 抽成纯函数是为了能单测"掉落 vs 能挖"这条区分——真机上就是这里把
 * 无镐的人锁死在实心方块里的（`canHarvest` 是掉落判据，被当成了挖得动判据）。
 */
export function pathfindingDigAbort(block: any): boolean {
    return !isBreakable(block);
}

/** 主手工具的状态快照（含背包里同名物品总数），给"工具坏了"提示用。 */
export interface HeldToolState {
    name: string | null;
    used: number | null;
    max: number | null;
    /** 背包里同名物品的总数（含手上那件）；读不到就是 null。 */
    count: number | null;
}

export function heldToolState(bot: any): HeldToolState {
    const held = bot?.heldItem ?? null;
    const name = typeof held?.name === 'string' ? held.name : null;
    const used = typeof held?.durabilityUsed === 'number' ? held.durabilityUsed : null;
    const max = resolveToolMaxDurability(bot, held);
    return { name, used, max, count: name == null ? null : inventoryCountOf(bot, name) };
}

/**
 * 主手工具耐久上限：mineflayer 读数 → bot 注册表 → mcData 静态表。
 *
 * `<=1` 的读数一律当"不是耐久上限"（真机 `stone_pickaxe` 报 `max=1`，实际 131）。
 * 拿假上限去算"还能挖几次"，会让 E 的低耐久保护要么乱报、要么静默失效。
 */
function resolveToolMaxDurability(
    bot: any,
    held: { name?: unknown; maxDurability?: unknown } | null | undefined,
): number | null {
    const raw = typeof held?.maxDurability === 'number' && Number.isFinite(held.maxDurability)
        ? held.maxDurability
        : null;
    if (raw != null && raw > 1) return raw;
    const name = typeof held?.name === 'string' ? held.name : null;
    if (name == null) return null;
    try {
        const fromRegistry = bot?.registry?.itemsByName?.[name]?.maxDurability;
        if (typeof fromRegistry === 'number' && fromRegistry > 1) return fromRegistry;
    } catch {
        // 注册表读不到就退到静态表。
    }
    try {
        return mc.getItemMaxDurability(name);
    } catch {
        // mcdata 还没初始化：如实返回读不到。
        return null;
    }
}

/** 背包（含快捷栏与手上）里某个物品的总数；读不到返回 null。 */
export function inventoryCountOf(bot: any, itemName: string): number | null {
    try {
        const items = bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }> | undefined;
        if (!Array.isArray(items)) return null;
        let count = 0;
        for (const item of items) {
            if (item?.name === itemName) count += typeof item.count === 'number' ? item.count : 1;
        }
        return count;
    } catch {
        return null;
    }
}

/**
 * 主手工具**耐久耗尽消失**的提示；没发生就返回 null。
 *
 * 触发条件是"手持变了 **且** 背包里同名物品变少"——自动拾取顶掉主手
 * （物品还在背包里）不会误报成损坏。读不到背包数目就不报：宁可漏报，
 * 也不能冤枉一次正常换手（Feedback #40：铁镐用了几百格无声消失，模型
 * 只能靠"挖不动了"反推，需要一句交代）。
 */
export function toolBreakNotice(before: HeldToolState, bot: any): string | null {
    if (before.name == null || before.used == null || before.max == null || before.max <= 1) return null;
    const heldNow = typeof bot?.heldItem?.name === 'string' ? bot.heldItem.name : null;
    if (heldNow === before.name) return null;
    // **数的是"那把旧工具"还剩几件**，不是新手持物品的数量。
    const after = inventoryCountOf(bot, before.name);
    if (before.count == null || after == null || after >= before.count) return null;
    const remain = after > 0
        ? `背包里还剩 ${after} 个 ${before.name}，先换下一把。`
        : `背包里已经没有 ${before.name} 了——接下来挖石头/矿会挖不动；先找替代工具，或对软方块（泥土/沙砾/下界岩）改用空手挖。`;
    return `⚠ 手上的 ${before.name} 耐久耗尽坏掉了（${before.used}/${before.max}）。${remain}`;
}

/**
 * 低耐久安全线：剩余可用次数 <= 20，或剩余比例 < 15%，就算"快用完了"。
 *
 * 真机 Feedback（2026-10-18 12:47，overnight_b）：`goToCoordinates` 的破坏性
 * 寻路一分钟烧光木镐 60 耐久（40+ 格），全程无提示，人又被锁在下界。
 * 这条线的作用就是"在这把工具被烧光之前，先别拿它挖路"。
 */
export const LOW_DURABILITY_USES = 20;
export const LOW_DURABILITY_FRACTION = 0.15;

export interface ToolDurabilityGuard {
    name: string | null;
    used: number | null;
    max: number | null;
    /** 还能用几次（max - used，钳到 >= 0）；读不到就是 null。 */
    remaining: number | null;
    /** true = 已低于安全线。 */
    low: boolean;
}

export function toolDurabilityGuard(bot: any): ToolDurabilityGuard {
    const held = bot?.heldItem ?? null;
    const name = typeof held?.name === 'string' ? held.name : null;
    const used = typeof held?.durabilityUsed === 'number' ? held.durabilityUsed : null;
    // 上限走同一套回退（<=1 视为读不到）：否则 Fabric 下 max=1 会让低耐久保护静默失效。
    const max = resolveToolMaxDurability(bot, held);
    const remaining = used != null && max != null ? Math.max(0, max - used) : null;
    const low =
        remaining != null &&
        (remaining <= LOW_DURABILITY_USES || remaining / (max as number) < LOW_DURABILITY_FRACTION);
    return { name, used, max, remaining, low };
}

/** 低耐久只在"第一次跌破"时报一次；换回健康工具就复位。 */
let _lowDurabilityWarnedFor: string | null = null;

/**
 * 手上工具第一次跌破安全线时提醒一次。返回这次写出的文本（没写就是 null）。
 *
 * 为什么要有：模型只会在"挖不动了"的时候才发现镐快没了，而那时工具往往已经
 * 烧光（Feedback：木镐 60 耐久一分钟烧完，全程无提示）。
 */
export function warnLowDurabilityOnce(bot: any): string | null {
    const g = toolDurabilityGuard(bot);
    if (!g.low || g.name == null) {
        _lowDurabilityWarnedFor = null;
        return null;
    }
    const key = `${g.name}:${g.max ?? '?'}`;
    if (_lowDurabilityWarnedFor === key) return null;
    _lowDurabilityWarnedFor = key;
    const msg =
        `⚠ 手上的 ${g.name} 耐久不多了（还剩 ${g.remaining} 次，读数 ${g.used}/${g.max}）：` +
        '接下来寻路会尽量不挖方块（需要挖路的事改用别的工具/先补一把）；工具烧光就没得挖了。';
    log(bot, msg);
    return msg;
}

export interface PathfindDigPolicy {
    /** 还允许探测/选择"破坏性路线"吗。 */
    allowDestructiveProbe: boolean;
    /** 破坏性路线的 digCost：越高越倾向绕路。 */
    digCost: number;
    /** 给模型看的说明；健康工具时是 null（不打扰）。 */
    note: string | null;
}

/**
 * 破坏性寻路的耐久策略。
 *
 * 低耐久时：不探测破坏性路线，并把非破坏性路线的挖格代价抬到 40
 * （默认 10 / 破坏性 5）——只在真绕不过去时才动镐。
 * 工具是**空手**时不拦：没有耐久可烧，而且徒手挖软方块正是 D2 的逃生路径。
 */
export function pathfindDigPolicy(guard: ToolDurabilityGuard): PathfindDigPolicy {
    if (!guard.low || guard.name == null) {
        return { allowDestructiveProbe: true, digCost: 5, note: null };
    }
    return {
        allowDestructiveProbe: false,
        digCost: 40,
        note:
            `手上只有 ${guard.remaining} 次耐久的 ${guard.name}（读数 ${guard.used}/${guard.max}），` +
            '改走不破坏地形的路线；真绕不过去才挖，要强行挖路就先换把镐或补工具。',
    };
}

/**
 * 危险操作闸门。
 *
 * 默认禁止倒水/倒岩浆/点火/在下界或末地睡觉/进深水；只有三种例外：身上着火
 * （实时判定）、模型用 allowDangerousOps 授权、我们写死的保命代码。判据和记录
 * 全在 dangerous_ops/permits 里，这里只负责"问一句、不让就写回执"。
 *
 * 回执**必须带上怎么授权** —— 这一夜反复证明：把下一步写出来，模型才能自己走得通。
 */
function allowDangerousOp(bot: any, opId: string): boolean {
    const verdict = permits.isAllowed(opId, opContextFor(bot), Date.now());
    if (verdict.allowed) return true;
    log(bot, verdict.op != null ? refuseText(verdict.op) : `默认不允许这个操作（${opId}）。`);
    return false;
}

/** 脚下这滩水的判定（给强制出水和回执用）。 */
export function waterUnderFoot(bot: any): WaterClass {
    return waterUnderFeet(bot);
}

/**
 * 强制出水。
 *
 * 用户的要求是"其他情况，我们得想办法强制出水"——授权只管"模型想不想下去"，
 * 管不了"它已经站在水里了"。所以这里是**我们写死的反射**：发现脚下是危险的水，
 * 自己找岸、自己走上去。
 *
 * 为什么必须走 `bypassFor`：强制出水本身就要**穿过水**才能上岸，而寻路默认不
 * 下水。不给一张短票，这道闸会把自己的保命代码也拦在门外——这正是
 * `bypassFor` 存在的唯一理由，它是这里第一个真实调用者。
 *
 * 票是 30 秒：够走几格上岸，不够的话下一轮又会重新发（幂等，不会累积）。
 */
export async function forceExitWater(bot: any, urgency: 'oxygen-low' | 'drowning' = 'oxygen-low'): Promise<boolean> {
    // **这里不看任何危险操作许可——那是另一个层的闸门。**
    //
    // 分层（用户的原话）：
    // - **危险操作授权**（permits）管"动作能不能**把你带进**危险区"——倒岩浆、
    //   倒水、点火、寻路走深水。它们全在**动作执行前**生效（goToGoal 的目标闸门、
    //   activateItem 前的检查、寻路的 blocksToAvoid）。
    // - **保命**（L5，不经过模型）管"**已经在危险里**"——氧气将尽/开始掉血就接管。
    //   唯一豁免是 `disableSafeguards`（模型签生死状；工具存在但不常用）。
    //
    // prober 实测的死法就是这两层被混用的结果：它授权了 enter_deep_water
    // （为了让寻路走进深水做测试），然后被水淹——旧版这里有一行 `deepWaterAllowed`
    // 检查让保命让位，几百条 contact 伴着 bot.hurt 一路淹死，全程无人上浮。
    // "许可我进去"不等于"淹了别捞我"。
    if (safeguards.isSuppressed(Date.now())) return true;

    const info = waterUnderFeet(bot);
    const head = headInWater(bot);
    // 氧气只在**头**进水时消耗——脚湿、半身在水都没关系。
    if (!info.isWater && !head) return true;
    if (!info.dangerous && !head) return true;         // 1 格深的静水，踩着无所谓

    // **保命策略分两级（按紧迫程度），而不是一步到位乱抢：**
    //
    // ① **先按空格上浮**——最省事，浮起来氧气瞬间回满，什么都不用寻路。
    //    正常的开阔水域这级就解决了。
    // ② **上浮无效才寻路找岸**——头顶封死（被倒了一桶水盖住、在涵洞里）时，
    //    光按空格只能原地浮沉（prober 实测：y 在 60.5↔62.2 反复，x/z 一格不动，
    //    drowning 刷了十几次就是不往岸去），这时候必须**水平移动到没有水的地方**。
    //
    // `urgency` 只影响日志口径：'drowning'（已经开始掉血）说明氧气已耗尽，
    // 是最后的通牒；'oxygen-low' 还有一点点余量。
    if (head) {
        log(
            bot,
            urgency === 'drowning'
                ? '头在水下且正在掉血（溺水，或水下有别的伤害源比如岩浆块）——立刻处理：先上浮，浮不上去就往岸去。'
                : '氧气快用完了（水下待太久）——先上浮换气。',
        );
        const result = await swimToSurface(bot);
        if (result === 'surfaced') {
            log(bot, '头已露出水面。');
            return true;
        }
        if (result === 'slow') {
            // y 还在涨——上浮**有效**，只是深。继续按住空格等它出头，
            // 别切寻路把正在上升的身体拽去水平移动。第二轮总会落到
            // surfaced（出头）或 stuck（y 卡住），不会无限 'slow'。
            log(bot, '还在上浮中（水较深），继续。');
            const second = await swimToSurface(bot);
            if (second === 'surfaced') {
                log(bot, '头已露出水面。');
                return true;
            }
            if (second === 'slow') {
                // **不许把它说成成功。** 真机 overnight_b：「surface 反射反复报『已经把头
                // 露出水面』，我却一路窒息掉血淹死」——`'slow'` 的语义是"30 秒上限到了、
                // 头**还在水里**、只是 y 可能还在涨"，这也是一种尽力而为，**不是出水面**。
                // 所以这里如实说"还在水里、还在上浮"，并且返回 true 只表示"我尽力了、外层
                // 继续盯"，不能给模型一个"已经安全"的假信号。
                log(
                    bot,
                    '头**还在水里**（已尽力上浮，但没到出水面）——外层会继续盯；' +
                        '如果你看到血在掉，说明还在溺水，继续按住上浮或往岸上走。',
                );
                return true;
            }
            log(bot, '上浮无效：头顶上不去（被水或方块封住了）——改寻路，往没有水的地方去。');
        } else {
            // 'stuck'：y 卡住了——头顶封死，按空格只是原地浮沉。必须水平移动。
            log(bot, '上浮无效：头顶上不去（被水或方块封住了）——改寻路，往没有水的地方去。');
        }
    }
    if (urgency === 'drowning' || head) {
        try {
            bot.pathfinder?.stop?.();   // 打断当前寻路：保命优先于任何目标。
        } catch {
            // 没在寻路就无所谓。
        }
    }

    const pos: any = bot?.entity?.position;
    if (pos == null) return false;
    const at = blockAtFrom(bot);

    // 找最近的落脚点：脚下不是水也不是岩浆，而且它上面两格是空的（站得进去）。
    let land: { x: number; y: number; z: number } | null = null;
    for (let r = 1; r <= 12 && land == null; r++) {
        for (let dx = -r; dx <= r && land == null; dx++) {
            for (let dz = -r; dz <= r && land == null; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                for (let dy = -2; dy <= 3 && land == null; dy++) {
                    const x = Math.floor(pos.x) + dx;
                    const y = Math.floor(pos.y) + dy;
                    const z = Math.floor(pos.z) + dz;
                    const ground = at(x, y, z);
                    if (ground == null) continue;
                    const name = ground.name;
                    if (name === 'water' || name === 'lava' || name === 'air' || name == null) continue;
                    const above = at(x, y + 1, z);
                    const above2 = at(x, y + 2, z);
                    if (above?.name !== 'air' || above2?.name !== 'air') continue;
                    land = { x, y: y + 1, z };
                }
            }
        }
    }

    if (land == null) {
        // **纯水大陆（一眼望不到岸）** —— 这时候正确的目标不是"上岸"，而是
        // **"把头露出水面"**：淹死的条件是头进水，不是身体进水。找不到岸时后者
        // 仍然救得了命。
        //
        // 原来这里做的是"跳 1.5 秒然后松手"，配上外层 2 秒一轮的重试，效果是
        // 机器人**一直在原地上下浮动**，既上不了浮也沉不下去，直到耗死。而且每
        // 一轮都往 `bot.output` 里塞一条，后台调用产生的这些回执模型还不一定看得到。
        log(bot, `脚下是危险的水（${info.reason}），附近 12 格内找不到能上岸的地方——先浮起来把头露出水面。`);
        const floated = await swimToSurface(bot);
        // 'surfaced' = 真活下来了；'slow' = 仍在上升（尽力了）；'stuck' = 没救回来。
        // 返回值喂给外层的失败退避：true 不退避（继续保持浮着盯），false 退 30 秒。
        return floated !== 'stuck';
    }

    permits.bypassFor('enter_deep_water', 30_000, 'forceExitWater: 强制出水', Date.now());
    log(bot, `脚下是危险的水（${info.reason}），自动上岸：${land.x},${land.y},${land.z}。`);
    try {
        bot.pathfinder?.stop?.();
    } catch {
        // 没在寻路就无所谓。
    }
    return await goToGoal(bot, new (pf as any).goals.GoalNear(land.x, land.y, land.z, 1));
}

/**
 * 浮到**头露出水面**为止。
 *
 * 找不到岸时的活命办法：淹死的条件是头进水，不是身体进水。所以目标从上岸降级
 * 成浮头——做不到前者时后者仍然救得了命。
 *
 * 两处刻意的设计：
 * - **按结果停，不按时间停**：原来固定跳 1.5 秒就松手，配上外层 2 秒一轮的重试，
 *   机器人只会一直原地上下浮动。这里一直浮到 `headInWater` 变 false 为止。
 * - **结束时头还在水里就不松手**：那说明 L5 保命已经接管了（`runEmergency` 的
 *   `swimUp` 也按着 jump），这时候松手等于拆保命的台。
 */
/**
 * 上浮的结果——**三种，不是两种**。
 *
 * - `'surfaced'`：头露出了水面，氧气回满，完事。
 * - `'stuck'`：**y 不再上升**——头顶被水/方块封死（倒了一桶水盖头上、在涵洞里），
 *   继续按空格只是原地浮沉。这是"上浮无效"，该切换策略（水平寻路找岸）。
 * - `'slow'`：8 秒到了但 **y 还在涨**——多半是水太深，上浮有效只是慢。
 *   这时候**放弃上浮才是错的**：身体正在正确的路上，切去寻路反而把它拽偏。
 */
type SurfaceResult = 'surfaced' | 'stuck' | 'slow';

async function swimToSurface(bot: any): Promise<SurfaceResult> {
    const DEADLINE_MS = 8000;
    const STEP_MS = 250;
    // **"上浮无效"的判定是 y 停止上升，不是超时。** 以前是"8 秒头没出水 = 失败"，
    // 这在深水里会误判：从 60 格深处按着空格浮上来本来就要十几秒，y 明明一路在涨，
    // 却被判成"浮不出去"而切去寻路——身体正在正确的路上，反而被拽偏。
    // 正确的判据：持续按着空格，y 还有新高 = 上浮有效（继续等，放宽上限）；
    // y 卡住（2 秒没有新高）= 真被头顶封死，才切第二级。
    const STALL_MS = 2_000;
    const MAX_MS = 30_000; // 深水的兜底：30 秒还浮不上头，按 stuck 处理（总有别的祸）。
    const started = Date.now();
    let bestY: number | null = null;
    let bestAt = Date.now();
    try {
        bot.setControlState?.('jump', true);
        while (Date.now() - started < MAX_MS) {
            await new Promise((r) => setTimeout(r, STEP_MS));
            if (!headInWater(bot)) return 'surfaced';
            const y = Number(bot?.entity?.position?.y ?? 0);
            if (bestY == null || y > bestY + 0.05) {
                bestY = y;          // 新高：上浮在进行。
                bestAt = Date.now();
            } else if (Date.now() - bestAt > STALL_MS) {
                return 'stuck';     // 2 秒没有新高：头顶封死，继续按只是原地浮沉。
            }
            if (Date.now() - started > DEADLINE_MS && bestY != null) {
                // 超过初始预算但仍在上升：**不是失败**，继续浮（上限 MAX_MS）。
                // 深水上浮本来就要十几秒，别在这里判死。
            }
        }
        return 'slow'; // 30 秒兜底到了：头还没出水（极其罕见），按可上浮处理外层再试。
    } catch {
        return 'stuck';
    } finally {
        try {
            if (!headInWater(bot)) bot.setControlState?.('jump', false);
            // 头还在水里 → **保持按住继续浮**。松手就沉，而没人会接手这件事。
        } catch {
            // 拿不到 controlState 就算了。
        }
    }
}

async function autoLight(bot: any): Promise<boolean> {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos: any = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err: unknown) { return false; }
    }
    return false;
}

async function equipHighestAttack(bot: any): Promise<void> {
    let weapons: any[] = bot.inventory.items().filter((item: any) => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter((item: any) => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a: any, b: any) => b.attackDamage - a.attackDamage);
    const weapon: any = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

/**
 * 背包里"最能打"的那件武器名；没有武器返回 null。**和 `equipHighestAttack` 同一套排序**，
 * 只是把名字读出来——用来在"打不死"的回执里给一条 `equip(item_name=…)` 的具体建议。
 */
export function bestWeaponInInventory(bot: any): string | null {
    try {
        const items = (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; attackDamage?: unknown }>;
        if (!Array.isArray(items)) return null;
        const byName = (predicate: (name: string) => boolean): Array<{ name: string; attackDamage: number }> =>
            items
                .filter((item) => typeof item?.name === 'string' && predicate(item.name))
                .map((item) => ({
                    name: String(item.name),
                    attackDamage: Number.isFinite(Number(item?.attackDamage)) ? Number(item.attackDamage) : 0,
                }));
        let weapons = byName((name) => name.includes('sword') || (name.includes('axe') && !name.includes('pickaxe')));
        if (weapons.length === 0) weapons = byName((name) => name.includes('pickaxe') || name.includes('shovel'));
        if (weapons.length === 0) return null;
        weapons.sort((a, b) => b.attackDamage - a.attackDamage);
        return weapons[0]?.name ?? null;
    } catch {
        return null;
    }
}

/**
 * "想要 N 个成品" → "配方要跑几遍"。**这是被真机测出来的一条。**
 *
 * `num` 是**想要多少个**，不是"跑几遍配方"——一遍配方产多少由配方自己决定：
 * 1 原木 → 4 木板、2 木板 → 4 木棍。所以"给我 4 个木板"是**跑 1 遍**，不是 4 遍。
 *
 * 旧实现把 `num` 直接当次数交给 `bot.craft`，于是模型写 `output="4 oak_planks"`
 * （意思是"我要 4 个"）时被跑成 4 遍：吃掉 4 个原木、吐出 16 个木板。模型在
 * Feedback 里自己从材料消耗反推出了这个 4 倍，原话是"一次 craft 只执行一次配方
 * ……别默认 ×4"。
 *
 * 向上取整：`ceil` 而不是 `floor`——"要 3 个木板"跑 1 遍只有 4 个 ≥ 3，够；
 * 但"要 6 个木板"跑 1 遍只有 4 个，得跑 2 遍。少给不如多给，材料不够由
 * `craftLimit` 在调用方砍。
 */
export function craftsForRecipe(recipe: any, wanted: number): { perCraft: number; runs: number } {
    const perCraft = Math.max(1, Math.floor(Number(recipe?.result?.count ?? 1)) || 1);
    const want = Math.max(1, Math.floor(Number(wanted) || 1));
    return { perCraft, runs: Math.max(1, Math.ceil(want / perCraft)) };
}

export async function craftRecipe(bot: any, itemName: string, num: number = 1): Promise<boolean> {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    // **配方表可能返回 null**（itemId 不存在 / 没有 recipes 条目）。直接 `.length`
    // 会抛 `Cannot read properties of null (reading 'length')`——Feedback #31 的崩溃点。
    const recipeInfos: any = (mc as any).getItemCraftingRecipes(itemName);
    const itemId: any = (mc as any).getItemId(itemName);
    if (itemId == null || recipeInfos == null || recipeInfos.length === 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe.（金装备的注册名是 golden_*，例如 golden_boots）`);
        return false;
    }

    // 先找不需要工作台的配方；没有再看要不要 / 有没有工作台。
    let recipes: any[] = ((bot.recipesFor(itemId, null, 1, null) as any[]) ?? []);
    let craftingTable: any = null;
    const craftingTableRange = 16;
    placeTable: if (recipes.length === 0) {
        // `craftingTable=true` 只是让 mineflayer 假设有工作台来算材料够不够；
        // 真去合成时还必须找到或放下一个真的工作台。
        const tableRecipes: any[] = ((bot.recipesFor(itemId, null, 1, true) as any[]) ?? []);
        if (tableRecipes.length === 0) break placeTable;
        recipes = tableRecipes;

        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null) {
            const hasTable: boolean = Number(world.getInventoryCounts(bot)['crafting_table'] ?? 0) > 0;
            if (hasTable) {
                const pos: any = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = ((bot.recipesFor(itemId, null, 1, craftingTable) as any[]) ?? []);
                    placedTable = true;
                }
            } else {
                log(bot, `Crafting ${itemName} requires a crafting table: there is none nearby and none in the inventory. 先 placeHere 放一个工作台再合成。`);
                return false;
            }
        } else {
            recipes = ((bot.recipesFor(itemId, null, 1, craftingTable) as any[]) ?? []);
        }
    }
    if (recipes.length === 0) {
        const firstRequired = recipeInfos[0]?.[0] as Record<string, number> | undefined;
        const needText =
            firstRequired != null
                ? Object.entries(firstRequired).map(([key, value]) => `${key}: ${value}`).join(', ')
                : 'unknown';
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${needText}.`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }

    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe: any = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory: Record<string, number> = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients: Record<string, number> = (mc as any).ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit: any = (mc as any).calculateLimitingResource(inventory, requiredIngredients);

    const { perCraft, runs } = craftsForRecipe(recipe, num);
    const craftsWanted = runs;
    const limitNum = Number(craftLimit?.num);
    const crafts = Math.max(0, Math.floor(Math.min(Number.isFinite(limitNum) ? limitNum : craftsWanted, craftsWanted)));
    if (crafts <= 0) {
        const needText = Object.entries(requiredIngredients).map(([key, value]) => `${key}×${value}`).join('、');
        const haveText =
            Object.keys(requiredIngredients)
                .map((key) => `${key}×${Number(inventory[key] ?? 0)}`)
                .join('、') || '0';
        log(bot, `材料不够：做 ${num} 个 ${itemName} 需要 ${needText}；现有 ${haveText}。`);
        if (placedTable) await collectBlock(bot, 'crafting_table', 1);
        return false;
    }

    // 合成也要走"先清残留窗口 + 有界等待"：mineflayer 的 `craftOnce` 自己
    // `await once(bot, 'windowOpen')`（默认 20 秒硬等），残留窗口会让它同样卡死。
    await craftWithStaleWindowGuard(bot, recipe, crafts, craftingTable);
    const got = world.getInventoryCounts(bot)[itemName];
    if (crafts < craftsWanted) {
        log(bot, `材料不够：想做 ${num} 个 ${itemName}（需跑 ${craftsWanted} 遍配方，每遍出 ${perCraft} 个），只够跑 ${crafts} 遍；限料是 ${craftLimit.limitingResource}。`);

        // **"现在背包里有 N 个"是未测量的断言**（真机 2026-10-20：回执说 4 个火把、实际 0 个，coal/stick 被吃掉）。
        // 只报**实测**；测不出就如实说测不出，不替模型编造"有几个"。
        const craftMeasured = ((): number | null => {
            try {
                return Number((world.getInventoryCounts(bot) as Record<string, number>)[itemName] ?? 0);
            } catch {
                return null;
            }
        })();
        log(bot, `合成了 ${itemName}：跑 ${crafts} 遍配方（每遍出 ${perCraft} 个）；**背包实测** ${craftMeasured == null ? "读不到（以 stats 为准）" : `${itemName}×${craftMeasured}`}。`);
    }
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll();

    return true;
}

export async function wait(bot: any, milliseconds: number): Promise<boolean> {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    const startTime = Date.now();

    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;

        const waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        const elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot: any, itemName: string, num: number = 1): Promise<boolean> {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!(mc as any).isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock: any;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        const hasFurnace: boolean = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            const pos: any = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    await bot.lookAt(furnaceBlock.position.offset(0.5, 0.5, 0.5), true);

    console.log('smelting...');
    const furnace: any = await openBlockUi(bot, furnaceBlock);
    // check if the furnace is already smelting something
    const input_item: any = furnace.inputItem();
    if (input_item && input_item.type !== (mc as any).getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${(mc as any).getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    const inv_counts: Record<string, number> = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || (inv_counts[itemName] as number) < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        const fuel: any = (mc as any).getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel: number = Math.ceil(num / (mc as any).getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${(mc as any).getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${(mc as any).getItemName(fuel.type)} to furnace fuel.`);
    }
    // put the items in the furnace
    await furnace.putInput((mc as any).getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item: any = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${(mc as any).getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${(mc as any).getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot: any): Promise<boolean> {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    const furnaceBlock: any = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace: any = await openBlockUi(bot, furnaceBlock);
    console.log('opened furnace...');
    // take the items out of the furnace
    let smelted_item: any, intput_item: any, fuel_item: any;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item);
    const smelted_name: string = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    const input_name: string = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    const fuel_name: string = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


/** `target` 的解析结果：命中实体，或一条说清为什么没命中的原因。 */
export interface AttackTargetResult {
  entity: any | null;
  /** 人类可读的命中/失败说明，成功时用来告诉模型"打的是哪一只"。 */
  message: string;
}

/**
 * `target` 的语义类别——**必填，不给默认值**。
 *
 * - `id`：实体 ID，取 Live State 实体表里的 #编号。
 * - `player`：玩家名（`username`）。
 * - `mob`：实体类型名（`name`），取最近的。
 *
 * **为什么没有 `auto`**：靠字符串形状隐式猜（纯数字当 ID、其余先玩家名后类型名）
 * 等于把"玩家优先"这个人为约定藏起来——模型既不知道它存在，也无法覆盖它。
 * 曾经有个玩家就叫 `zombie`，而 `zombie` 也是最常见的怪物名。
 * 三个取值语义完全平级，谁也不压谁，所以让模型自己声明。
 */
export type AttackTargetType = 'id' | 'player' | 'mob';

const ATTACK_TARGET_TYPES: readonly AttackTargetType[] = ['id', 'player', 'mob'];

/**
 * 把模型给的 `target` 按 `targetType` 声明的语义解析成一个具体实体。
 *
 * - `id`：纯数字，直接取 `bot.entities[id]`。**不受 `maxDistance` 限制**——
 *   模型给的编号往往来自上一轮快照，现在可能已走出感知半径，但仍是能走过去的
 *   合法目标。
 * - `player`：按 `username` 匹配。玩家必须走这条——mineflayer 的玩家实体 `name`
 *   恒为 `'player'`（`entities.js:192`），按 `name` 找玩家永远落空。
 * - `mob`：按实体类型名（`name`）匹配，取最近的。
 */
export function resolveAttackTarget(
  bot: any,
  target: string,
  targetType: string,
  maxDistance: number = 64,
): AttackTargetResult {
  const raw = String(target ?? '').trim();
  const kind = String(targetType ?? '').trim().toLowerCase();

  if (!ATTACK_TARGET_TYPES.includes(kind as AttackTargetType)) {
    return {
      entity: null,
      message: `type 必填，且只认${ATTACK_TARGET_TYPES.join(' / ')}（收到 "${targetType ?? ''}"）。`,
    };
  }
  if (raw === '') {
    return {
      entity: null,
      message:
        kind === 'id' ? 'type=id 要的是实体编号（Live State 实体表里的 #数字）。'
        : kind === 'player' ? 'type=player 要的是玩家名。'
        : 'type=mob 要的是实体类型名（如 zombie）。',
    };
  }

  // ① 实体 ID。用 bot.entities 而不是"附近列表"——模型给的编号可能来自
  // 上一轮的快照，现在已经走出感知半径了，但仍是可以走过去的合法目标。
  if (kind === 'id') {
    if (!/^\d+$/.test(raw)) {
      return { entity: null, message: `type=id 要求 target 是纯数字的实体编号（收到 "${raw}"）。` };
    }
    const id = Number(raw);
    const direct = bot.entities?.[id];
    if (direct == null) {
      return { entity: null, message: `找不到实体 #${id}（可能已经死了或消失了）。看一眼 Live State 的实体表。` };
    }
    const distance = Math.round(bot.entity.position.distanceTo(direct.position) * 10) / 10;
    return {
      entity: direct,
      message: `锁定 #${id}（${describeEntity(direct)}，${distance}m），开打。`,
    };
  }

  const lower = raw.toLowerCase();
  const nearby: any[] = world.getNearbyEntities(bot, maxDistance);
  const describeWhat = kind === 'player' ? `叫 ${raw} 的玩家` : `${raw} 型实体`;

  // ② 玩家名（username）——只有 type=player 才走这条。
  if (kind === 'player') {
    const player: any = nearby.find((e: any) => typeof e.username === 'string' && e.username.toLowerCase() === lower);
    if (player) {
      return { entity: player, message: `锁定玩家 ${player.username}（#${player.id}），开打。` };
    }
  } else {
    // ③ 实体类型名。
    const mob: any = nearby.find((e: any) => typeof e.name === 'string' && e.name.toLowerCase() === lower);
    if (mob) {
      return {
        entity: mob,
        message: `锁定最近的 ${mob.name}#${mob.id}（${describeEntity(mob)}），开打。`,
      };
    }
  }

  // 没命中：把附近实际有什么列出来——模型真机报过"attack 报找不到 pig，
  // 而快照里 16 格内就有一只"，它无从自查。现在它能自己改目标。
  const seen = [
    ...new Set(
      nearby
        .map((e: any) => (typeof e.username === 'string' ? `${e.username}(player)` : e.name))
        .filter((n: unknown) => typeof n === 'string'),
    ),
  ];
  return {
    entity: null,
    message:
      `${maxDistance} 格内找不到可打的${describeWhat}。` +
      (seen.length > 0 ? `附近有：${seen.join('、')}。` : '附近什么都没有。'),
  };
}

/** 实体的一行式身份描述，给日志/回执用。 */
function describeEntity(entity: any): string {
  const name = typeof entity.username === 'string' ? entity.username : entity.name;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * 攻击 `target` 指向的实体，直到它死或跑掉。
 *
 * `targetType`（`id` / `player` / `mob`）**必填**，它决定 `target` 怎么解释。
 * 规则见 {@link resolveAttackTarget}。
 *
 * @returns true = 打到了并打死了；false = 没找到目标或被中断。
 */
export async function attackTarget(
  bot: any,
  target: string,
  targetType: string,
  kill: boolean = true,
): Promise<boolean> {
  const { entity, message } = resolveAttackTarget(bot, target, targetType);
  log(bot, message);
  if (entity == null) return false;
  const res: boolean | undefined = await attackEntity(bot, entity, kill);
  return res === true;
}

export function stopPvp(bot: any): void {
    // @nxg-org/mineflayer-custom-pvp：近战 swordpvp + 远程 bowpvp 都要停
    try { bot?.swordpvp?.stop?.(); } catch { /* best-effort: bot may lack pvp plugins */ }
    try { bot?.bowpvp?.stop?.(); } catch { /* best-effort: bot may lack pvp plugins */ }
}

/**
 * 一次击杀最多等多久（毫秒）。**上限要宽（真打一只坦克怪要时间），但绝不能没有。**
 *
 * 真机教训同源：无上限的等待 = 丢掉身体 + 模型拿到零解释，和"没有预算的反射""永远压不完的
 * 压缩""3.15 万次热循环"是同一类缺陷。所以到点**如实放弃**，并给一条能照抄的出路。
 */
export const KILL_WAIT_BUDGET_MS = 90_000;
/** 击杀等待的轮询间隔（原逻辑就是 1 秒一次）。 */
export const KILL_WAIT_POLL_MS = 1_000;
/** "目标还在附近"的判定半径（原逻辑就是 24 格；**但"离开这个半径"不等于死**，见下）。 */
export const KILL_WAIT_NEARBY_RADIUS = 24;
/**
 * "确认死了"要连续多少轮看到它消失。
 *
 * 真机事故（2026-10-19 01:20，overnight_a）：`huntFor(enderman)` 输出了 **12 次**
 * `Successfully killed enderman.`、同一个实体 id `enderman#286831`、0 个珍珠。
 * 原因就是这里原来只要目标离开 24 格扫描就宣布击杀——而**末影人被打会瞬移**，
 * 瞬移出扫描范围看起来就和"死了"一模一样。现在要求：消失必须**连续**几轮都成立，
 * 中途再出现（同一个 id）就算瞬移、不算死。
 */
export const KILL_CONFIRM_POLLS = 2;

export interface KillWaitOptions {
    /** 击杀死等的预算（毫秒，默认 90 秒；测试用小值）。 */
    budgetMs?: number;
    /** 轮询间隔（毫秒）。 */
    pollMs?: number;
    /** 取当前时间（测试注入假时钟）。 */
    now?: () => number;
    /** "确认死亡"需要连续消失几轮（默认 `KILL_CONFIRM_POLLS`）。 */
    confirmPolls?: number;
}

/** 实体是否还在**全局实体表**里（`bot.entities`，不是 24 格扫描）。读不到返回 null。 */
export function entityPresentById(bot: any, id: unknown): boolean | null {
    if (id == null) return null;
    try {
        const table = bot?.entities;
        if (table == null) return null;
        const key = String(id);
        if (typeof table === 'object') {
            if (Object.prototype.hasOwnProperty.call(table, key)) return (table as any)[key] != null;
            const get = (table as any).get;
            if (typeof get === 'function') {
                const found = get.call(table, Number(id));
                return found != null;
            }
            return false;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * 一次攻击之后，目标的证据是什么（纯函数，可单测）。
 *
 * - `dead`：血量读到 0/负（最硬的证据）
 * - `alive`：还在全局实体表里，或还在 24 格扫描里
 * - `gone`：两处都看不见了——**还要连续几轮都是 gone 才能算死**（瞬移也会 gone）
 * - `unknown`：什么都读不到（不猜）
 */
export type KillEvidence = 'dead' | 'alive' | 'gone' | 'unknown';

export function classifyKillEvidence(bot: any, entity: any): KillEvidence {
    const health = readEntityHealth(entity);
    if (health != null && health <= 0) return 'dead';
    const present = entityPresentById(bot, entity?.id);
    if (present === true) return 'alive';
    let nearby = false;
    try {
        nearby = world.getNearbyEntities(bot, KILL_WAIT_NEARBY_RADIUS).includes(entity);
    } catch {
        nearby = false;
    }
    if (nearby) return 'alive';
    if (present === false) return 'gone';
    return 'unknown';
}

function readEntityHealth(entity: any): number | null {
    // **null/undefined 必须先挡掉**：`Number(null) === 0`，否则"血量读不到"会被当成
    // "0 点血"（= 快死了），诊断就会给出完全相反的结论。
    const raw = entity?.health;
    if (raw == null) return null;
    const health = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(health) ? health : null;
}

/**
 * 打不死时的**诊断**回执（纯渲染，可单测）。模型只有靠它才能判断
 * 「快死了，再补两刀」和「你打不到它（隔着墙/在水里/在飞）」。
 *
 * 关于"挥了几刀"：`bot.swordpvp` 插件自己持续攻击，**没有可读的挥砍计数**——
 * 所以这里如实报"等了多久 + 轮询几次"，不编一个挥砍数。
 */
export function describeKillGiveUp(
    bot: any,
    entity: any,
    info: { waitedMs: number; polls: number; healthBefore: number | null; teleports?: number },
): string {
    const name = entity?.name ?? '目标';
    const after = readEntityHealth(entity);
    const distance = (() => {
        try {
            const own = bot?.entity?.position;
            const target = entity?.position;
            if (own == null || target == null) return null;
            if (typeof own.distanceTo === 'function') return own.distanceTo(target);
            return Math.hypot(target.x - own.x, target.y - own.y, target.z - own.z);
        } catch {
            return null;
        }
    })();
    const seconds = (info.waitedMs / 1000).toFixed(1);
    const distanceText = distance == null ? '距离读不到' : `现在距离 ${distance.toFixed(1)} 米`;
    const head = `打了 ${seconds} 秒还没打死 ${name}（轮询 ${info.polls} 次）；${distanceText}。`;
    const teleportNote =
        (info.teleports ?? 0) > 0
            ? `\n**它在这段时间里消失了又出现 ${info.teleports} 次——那是瞬移，不是死亡**（同一个实体 id 还在）。` +
              (name === 'enderman'
                  ? '\n末影人一被打就瞬移，**近战反复追是打不死的**；能用的打法是：① 用**船**把它困住（坐进船里的生物不能瞬移）再打 ② 用**弓**在远处耗。'
                  : '')
            : '';

    if (info.healthBefore == null || after == null) {
        return (
            `${head}${teleportNote}\n血量读不到（服务端没给），**看不出掉没掉血**——先看一眼实体表再决定。` +
            `\n下一步（照做即可）：stats(type="entities")`
        );
    }
    if (after < info.healthBefore) {
        return (
            `${head}${teleportNote}\n血量 ${info.healthBefore} → ${after}（**在掉血，只是慢**）：不是打不到，是没打死（护甲/回血/你输出不够）。` +
            `\n下一步（照做即可）：attack(target="${name}", type="mob")`
        );
    }
    if (distance != null && distance > 6) {
        const target = entity?.position ?? {};
        return (
            `${head}${teleportNote}\n血量 ${info.healthBefore} → ${after}（**一点没掉**）：**你打不到它**——太远/隔着方块，或者它在水里、在飞。` +
            `\n下一步（照做即可）：goToCoordinates(x=${Math.round(Number(target.x ?? 0))}, y=${Math.round(Number(target.y ?? 0))}, z=${Math.round(Number(target.z ?? 0))}, closeness=2)`
        );
    }
    return (
        `${head}${teleportNote}\n血量 ${info.healthBefore} → ${after}（**一点没掉**，而且就在手边）：它可能是无敌/被方块挡着/根本不在射程内。` +
        `换个目标，别对着它耗。\n下一步（照做即可）：stats(type="entities")`
    );
}

export async function attackEntity(
    bot: any,
    entity: any,
    kill: boolean = true,
    options: KillWaitOptions = {},
): Promise<boolean | undefined> {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    const pos: any = entity.position;
    await equipHighestAttack(bot);

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...');
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...');
        await bot.attack(entity);
    }
    else {
        // 用手里已装备的精确武器名，避免插件按子串拿错武器；空手则不指定
        if (bot.heldItem?.name) {
            bot.swordpvp.weaponOfChoice = bot.heldItem.name;
        }
        const healthBefore = readEntityHealth(entity);
        await bot.swordpvp.attack(entity);
        // **有界等待**：原来这里是 `while (还在附近) { sleep(1000) }`，没有上限——
        // 遇到打不死的目标（隔墙/水里/有甲）就是静默死等，直到动作超时或保险丝，
        // 模型只会拿到一句"已强制释放动作通道"。现在到点放弃并给诊断。
        const budgetMs = options.budgetMs ?? KILL_WAIT_BUDGET_MS;
        const pollMs = options.pollMs ?? KILL_WAIT_POLL_MS;
        const confirmPolls = Math.max(1, options.confirmPolls ?? KILL_CONFIRM_POLLS);
        const now = options.now ?? Date.now;
        const startedAt = now();
        let polls = 0;
        // **击杀必须由证据确认**（真机事故：末影人瞬移出 24 格扫描 → 12 次假的
        // "Successfully killed"、0 个珍珠）。证据规则见 `classifyKillEvidence`：
        // 血量归零 = 死；还在实体表/扫描里 = 活；两处都消失 = 待确认（连续 confirmPolls 轮）；
        // 消失过又回来 = **瞬移**，重新开始等，绝不算击杀。
        let goneStreak = 0;
        let teleports = 0;
        let verified = false;
        for (;;) {
            // Stop / 保命反射语义**原样**：立刻停手、立刻返回 false。
            if (bot.interrupt_code) {
                stopPvp(bot);
                return false;
            }
            if (now() - startedAt >= budgetMs) {
                log(
                    bot,
                    describeKillGiveUp(bot, entity, {
                        waitedMs: now() - startedAt,
                        polls,
                        healthBefore,
                        ...(teleports > 0 ? { teleports } : {}),
                    }),
                );
                stopPvp(bot);
                return false;
            }
            const evidence = classifyKillEvidence(bot, entity);
            if (evidence === 'dead') {
                verified = true;
                break;
            }
            if (evidence === 'gone') {
                goneStreak += 1;
                if (goneStreak >= confirmPolls) {
                    verified = true;
                    break;
                }
            } else {
                if (goneStreak > 0) teleports += 1; // 消失过又回来 = 瞬移，不是死
                goneStreak = 0;
            }
            await new Promise(resolve => setTimeout(resolve, pollMs));
            polls += 1;
        }
        log(
            bot,
            teleports > 0
                ? `Successfully killed ${entity.name}.（击杀已验证；不过在打的过程中它**瞬移了 ${teleports} 次**，不是一次打死的）`
                : `Successfully killed ${entity.name}.（击杀已验证：实体从世界里消失并保持消失）`,
        );
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot: any, range: number = 9): Promise<boolean> {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    let attacked = false;
    let enemy: any = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(movementsFor(bot));
                await runPathfindingInterruptibly(bot, new (pf as any).goals.GoalFollow(enemy, 3.5));
            } catch (err: unknown) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(movementsFor(bot));
                const inverted_goal: any = new (pf as any).goals.GoalInvert(new (pf as any).goals.GoalFollow(enemy, 2));
                await runPathfindingInterruptibly(bot, inverted_goal);
            } catch (err: unknown) {/* might error if entity dies, ignore */}
        }
        if (bot.heldItem?.name) {
            bot.swordpvp.weaponOfChoice = bot.heldItem.name;
        }
        await bot.swordpvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), range);
        if (bot.interrupt_code) {
            stopPvp(bot);
            return false;
        }
    }
    stopPvp(bot);
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot: any, blockType: string, num: number = 1, exclude: any = null): Promise<boolean> {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    const blocktypes: string[] = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;
    // **长动作：计时 + 进度 + 硬上限**（真机 2026-10-21：4 块铁矿在 1-1.7m 处，静默 73 秒）。
    const collectStartedAt = Date.now();
    let collectLastProgressAt = 0;
    // 工具在这轮采集里坏掉（耐久耗尽消失）要立刻说一声：模型只会看到
    // "挖不动了"，而原因可能是手上那把镐刚刚没了。
    const heldBefore = heldToolState(bot);
    const reportToolBreak = (): void => {
        const notice = toolBreakNotice(heldBefore, bot);
        if (notice != null) log(bot, notice);
        warnLowDurabilityOnce(bot);
    };

    const movements: any = movementsFor(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks: string[] = ['obsidian'];

    for (let i=0; i<num; i++) {
        const blocks: any[] = world.getNearestBlocksWhere(bot, (block: any) => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (const position of exclude as any[]) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }

            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        // 每轮先报进度（8 秒一次，有界内容：第几块/已用/还剩/离目标多远）。
        const collectElapsed = Date.now() - collectStartedAt;
        if (shouldEmitProgress(collectLastProgressAt, Date.now())) {
            collectLastProgressAt = Date.now();
            const nextBlock = blocks[0] as any;
            const nextDistance = nextBlock?.position != null ? bot.entity.position.distanceTo(nextBlock.position) : null;
            log(bot, 'collect-progress{' + JSON.stringify({ done: collected, total: num, elapsedMs: collectElapsed, remaining: Math.max(0, num - collected), distance: nextDistance }) + '} ' + formatProgressLine({ label: '挖矿', done: collected, total: num, elapsedMs: collectElapsed, remaining: Math.max(0, num - collected), distance: nextDistance }));
            recordActionProgress(bot, { label: '挖矿', done: collected, total: num });
        }
        if (collectElapsed >= LONG_ACTION_MAX_MS) {
            log(bot, formatTimeoutSummary({ label: '采集', done: collected, total: num, elapsedMs: collectElapsed, remaining: Math.max(0, num - collected) }));
            return collected > 0;
        }
        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block: any = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket: any = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                reportToolBreak();
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId: any = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) {
            // **说清"是没工具"，别让上层回执把原因说成"掉落被抢/不可达"。**
            // 模型真机（Feedback #36）对照过：mineBlock 的同类报错清楚，
            // 而 collectBlocks 只说"数量没变"，于是它去查掉落物和寻路，
            // 真正缺的那把镐反而没人提。措辞与 mineBlock 保持一致，便于回执层收口。
            log(
                bot,
                `没有能挖 ${block.name} 的工具（手持 ${bot?.heldItem?.name ?? '空手'}）；` +
                    '先换正确的工具（对应镐/铲/斧）再来；急着清路可以用 mineBlock 徒手挖软方块。',
            );
            reportToolBreak();
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if ((mc as any).mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                // 统一走 digWithTimeout：裸 bot.dig 会在方块中途变化时永不 resolve。
                if (!(await digWithTimeout(bot, block, `@(${block.position.x},${block.position.y},${block.position.z})`))) {
                    log(bot, `挖 ${blockType} 超时，跳过这一格。`);
                } else {
                    await pickupNearbyItems(bot);
                    success = true;
                }
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err: unknown) {
            const e = err as { name?: string } | null | undefined;
            if (e?.name === 'NoChests') {
                // **背包满不等于挖不了**。mineflayer 的 collectBlock 插件满包时会抛 NoChests，
                // 但挖方块本身跟背包没关系，掉落物还能并进已有的半栈——模型真机报过
                // "free 0 死锁：collectBlocks 只认空格子"，就是这里直接放弃造成的。
                // 同一个函数上面已经有能用的手动路径，回退过去就是了。
                try {
                    await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                    // 统一走 digWithTimeout：裸 bot.dig 会在方块中途变化时永不 resolve。
                    if (!(await digWithTimeout(bot, block, `@(${block.position.x},${block.position.y},${block.position.z})`))) {
                        log(bot, `挖 ${blockType} 超时，跳过这一格。`);
                        continue;
                    }
                    await pickupNearbyItems(bot);
                    collected++;
                    log(bot, `背包满了，改用"自己挖 + 捡"的方式收了 ${blockType}（掉落物能并进已有的半栈）。`);
                    continue;
                } catch (fallbackErr: unknown) {
                    const fmsg: string = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                    log(
                        bot,
                        `Failed to collect ${blockType}: 背包满了，而且手动挖也失败（${fmsg}）。先 discard 一批，或者找个箱子存起来。`,
                    );
                    break;
                }
            }
            else {
                const msg: string = err instanceof Error ? err.message : String(err);
                log(bot, `Failed to collect ${blockType}: ${msg}.`);
                continue;
            }
        }

        if (bot.interrupt_code)
            break;
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    reportToolBreak();
    return collected > 0;
}

export async function pickupNearbyItems(bot: any): Promise<boolean> {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = (b: any): any => b.nearestEntity((entity: any) => entity.name === 'item' && b.entity.position.distanceTo(entity.position) < distance);
    let nearestItem: any = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        const movements: any = movementsFor(bot);
        // **局部关闭，不是全局默认**（`Movements` 出厂 `canDig = true`）：
        // 走过去捡一件掉落物，不该顺手把地形拆了。远距离导航不走这条路径。
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new (pf as any).goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        const prev: any = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


/**
 * 挖一个方块，**带按硬度分档的超时**。
 *
 * 为什么必须分档：mineflayer 的 `bot.dig` promise 在方块中途被改、被打断、
 * 或者 bot 被 Stop 过之后会**永不 resolve**。固定 8 秒一刀切会两头不讨好——
 * 挖土嫌久，挖黑曜石（硬度 50，钻石镐也要 ~9.4 秒）又根本不够。
 *
 * 模型真机给的证据非常干净：同一格 `mineBlock(36,9,10)` 调了 3 次，
 * **空回执 ×2 + 卡死 280 秒 ×1**，而**同一片区域的另外 17 格全部正常**——
 * 唯一的差别就是"那一格是最难挖的黑曜石"。
 * （当时 8 秒超时只加在 `breakBlockAt` 上，`mineBlock` 走的是另一个入口，
 * 压根没有超时。）
 *
 * 分档：`5000 + 硬度 × 800`，下限 8 秒、上限 30 秒。
 * 黑曜石(50)→30 秒，远古残骸(30)→29 秒，石头(1.5)→8 秒，泥土(0.5)→8 秒。
 */
export interface DigTimeoutPlan {
    timeoutMs: number;
    expectedMs: number;
    hardness: number;
    toolId: number | null;
    unbreakable: boolean;
}

/**
 * 按方块硬度 + 当前工具动态估算挖穿超时。
 *
 * 真机 Feedback #30：黑曜石正常约 9.4 秒，旧的固定 9 秒/固定 8 秒超时让它
 * 永远挖不动，下界门在工具层直接堵死。这里优先用 mineflayer 的
 * `block.digTime(heldItemType)`（它已经算好工具倍率），再按
 * expected * multiplier + buffer，至少 minMs。
 */
export function estimateDigTimeoutMs(
    block: any,
    toolId: number | null = null,
    opts: { minMs?: number; bufferMs?: number; multiplier?: number; maxMs?: number; digTimeMs?: number } = {},
): DigTimeoutPlan {
    const hardness = typeof block?.hardness === 'number' ? block.hardness : 0;
    let expectedMs: number | null = null;
    if (opts.digTimeMs != null) {
        expectedMs = opts.digTimeMs;
    } else if (typeof block?.digTime === 'function') {
        try {
            const t = block.digTime(toolId, false, false, false);
            if (Number.isFinite(t) && t > 0) expectedMs = t;
            else if (t === Infinity) expectedMs = Infinity;
        } catch {
            expectedMs = null;
        }
    }
    const unbreakable = expectedMs === Infinity || hardness === -1;
    if (expectedMs == null) {
        // 没有 digTime 的替身/旧版本：用硬度粗略兜底（黑曜石 50 -> 45s）。
        expectedMs = hardness > 0 ? 5000 + hardness * 800 : 1000;
    }
    const minMs = opts.minMs ?? 12_000;
    const bufferMs = opts.bufferMs ?? 3_000;
    // 真机实测约 2.6×；给到 4× + buffer，黑曜石（预计 9.4s / 实测 24s）必须能过。
    const multiplier = opts.multiplier ?? 4;
    const maxMs = opts.maxMs ?? 180_000;
    const timeoutMs = unbreakable
        ? minMs
        : Math.min(maxMs, Math.max(minMs, expectedMs * multiplier + bufferMs));
    return { timeoutMs, expectedMs, hardness, toolId, unbreakable };
}

/** 等 ms 的 Promise（digWithTimeout 内部用，避免悬挂定时器）。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 挖方块并动态超时；一次超时后在已有进度上续挖，尽量挖穿而不是放弃。
 *
 * 回执写清：当前方块、实际用时、预计用时、第几次尝试、是否仍在挖、每 3 秒进度。
 */
export function isAirBlockName(name: string | null | undefined): boolean {
    return name != null && DIG_AIR_NAMES.has(name);
}

/** 挖取现场：目标当前方块名、手持工具、是否能挖。 */
export function digTargetState(bot: any, block: any): {
    name: string | null;
    heldName: string | null;
    heldType: number | null;
    canHarvest: boolean | null;
} {
    const name = ((): string | null => {
        try {
            return bot?.blockAt?.(block?.position)?.name ?? null;
        } catch {
            return null;
        }
    })();
    const heldName = typeof bot?.heldItem?.name === 'string' ? bot.heldItem.name : null;
    const heldType = typeof bot?.heldItem?.type === 'number' ? bot.heldItem.type : null;
    let canHarvest: boolean | null = null;
    try {
        if (typeof block?.canHarvest === 'function') canHarvest = block.canHarvest(heldType);
    } catch {
        canHarvest = null;
    }
    return { name, heldName, heldType, canHarvest };
}

/**
 * 挖方块并动态超时。
 *
 * **独立看门狗**：bot.dig 在方块中途变化/客户端不同步时会永不 resolve。
 * 这里每 200ms 直接读目标方块，一旦变成空气就停止等待并判成功——真机
 * Feedback #30 的 1.4m 铁矿 2 分钟不返回，就是 dig 永远不 resolve。
 * 超时后先 stopDigging 再续挖，并在回执里带目标方块/工具状态。
 */
export async function digWithTimeout(bot: any, block: any, where: string): Promise<boolean> {
    // **工具坏掉要留一句话。** bot.dig 不会因为镐子耐久耗尽而报错——它只是
    // 让那件东西从背包里消失，模型下一轮才发现"手上空了"（Feedback #40）。
    // 统一在这里对账：挖之前/之后同名物品数变少且手持换了人，就是坏了。
    const heldBefore = heldToolState(bot);
    const ok = await digOnce(bot, block, where);
    const notice = toolBreakNotice(heldBefore, bot);
    if (notice != null) log(bot, notice);
    // 没坏但已经跌破安全线：提醒一次，别等烧光。
    warnLowDurabilityOnce(bot);
    return ok;
}

async function digOnce(bot: any, block: any, where: string): Promise<boolean> {
    const name = block?.name ?? '?';
    const toolId: number | null = typeof bot?.heldItem?.type === 'number' ? bot.heldItem.type : null;
    let expectedOverride: number | undefined;
    if (typeof bot?.digTime === 'function') {
        try {
            const t = bot.digTime(block);
            if (Number.isFinite(t) && t > 0) expectedOverride = t;
            else if (t === Infinity) expectedOverride = Infinity;
        } catch {
            expectedOverride = undefined;
        }
    }
    const plan = estimateDigTimeoutMs(block, toolId, expectedOverride == null ? {} : { digTimeMs: expectedOverride });
    const attempts = 2;
    let totalMs = 0;
    const expectedText = plan.expectedMs === Infinity ? '不可破坏/工具不够' : Math.round(plan.expectedMs / 100) / 10 + 's';
    const stateText = (state: ReturnType<typeof digTargetState>): string =>
        '目标=' + (state.name ?? '读不到') + '，手持=' + (state.heldName ?? '空手') +
        '，canHarvest=' + (state.canHarvest == null ? '未知' : String(state.canHarvest));
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (bot?.interrupt_code) {
            log(bot, '挖 ' + name + ' ' + where + ' 被 Stop/保命打断，已放弃（累计 ' + Math.round(totalMs / 1000) + 's）。');
            try {
                bot.stopDigging?.();
            } catch {
                // 停不下来也如实返回。
            }
            return false;
        }
        const stateBefore = digTargetState(bot, block);
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let watcher: ReturnType<typeof setInterval> | undefined;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), plan.timeoutMs);
        });
        const gonePromise = new Promise<'gone'>((resolve) => {
            watcher = setInterval(() => {
                const current = digTargetState(bot, block).name;
                if (isAirBlockName(current)) resolve('gone');
            }, 200);
        });
        const progressTimer: ReturnType<typeof setInterval> = setInterval(() => {
            const elapsed = Date.now() - started;
            const state = digTargetState(bot, block);
            log(
                bot,
                '挖 ' + name + ' ' + where + ' 进度：已 ' + Math.round(elapsed / 1000) + 's，仍在挖=' +
                    (bot?.targetDigBlock != null) + '，' + stateText(state) + '。',
            );
        }, 3_000);
        let outcome: 'ok' | 'gone' | 'timeout' | 'error';
        try {
            outcome = await Promise.race([
                bot.dig(block, true).then(() => 'ok' as const),
                timeoutPromise,
                gonePromise,
            ]);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/Digging aborted/i.test(msg)) {
                // 外部 health/death/插件调 stopDigging 会走到这里：这是正常中断，不是故障。
                log(bot, '挖 ' + name + ' ' + where + ' 被外部 stopDigging 正常中断（Digging aborted），本次动作结束。');
                try {
                    bot.stopDigging?.();
                } catch {
                    // 已经中断了，停不下来也无所谓。
                }
                return false;
            }
            outcome = 'error';
            log(bot, '挖 ' + name + ' ' + where + ' 抛错：' + msg);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            clearInterval(progressTimer);
            if (watcher !== undefined) clearInterval(watcher);
        }
        const elapsed = Date.now() - started;
        totalMs += elapsed;
        const stateAfter = digTargetState(bot, block);
        const stillDigging = bot?.targetDigBlock != null;
        if (outcome === 'gone' || isAirBlockName(stateAfter.name)) {
            if (outcome === 'gone') {
                log(bot, '挖 ' + name + ' ' + where + ' 看门狗发现目标已变空气：dig 未返回也判成功（用时 ' +
                    Math.round(elapsed / 100) / 10 + 's）。' + stateText(stateBefore) + ' -> ' + stateText(stateAfter) + '。');
            } else {
                log(bot, '挖 ' + name + ' ' + where + ' 完成：用时 ' + Math.round(elapsed / 100) / 10 +
                    's（预计 ' + expectedText + '，第 ' + attempt + '/' + attempts + ' 次，硬度 ' + plan.hardness + '）。');
            }
            try {
                if (outcome === 'gone') bot.stopDigging?.();
            } catch {
                // 目标已空，stopDigging 失败不影响结果。
            }
            return true;
        }
        if (outcome === 'ok') {
            log(bot, '挖 ' + name + ' ' + where + ' 完成：用时 ' + Math.round(elapsed / 100) / 10 +
                's（预计 ' + expectedText + '，第 ' + attempt + '/' + attempts + ' 次，硬度 ' + plan.hardness + '）。');
            return true;
        }
        if (outcome === 'timeout') {
            log(bot, '挖 ' + name + ' ' + where + ' 第 ' + attempt + '/' + attempts + ' 次超时：实际 ' +
                Math.round(elapsed / 100) / 10 + 's，预计 ' + expectedText + '（硬度 ' + plan.hardness + '），仍在挖=' +
                stillDigging + '；' + stateText(stateAfter) + '。');
        }
        // 无论 dig 是否还挂着，续挖前先停一次，让下一轮从干净状态重新发起。
        try {
            bot.stopDigging?.();
        } catch {
            // 忽略。
        }
        if (attempt < attempts) {
            const refreshed = digTargetState(bot, block);
            if (isAirBlockName(refreshed.name)) {
                log(bot, '续挖前发现 ' + name + ' ' + where + ' 已经是空气，直接判成功。');
                return true;
            }
            log(bot, '续挖 ' + name + ' ' + where + '（第 ' + (attempt + 1) + ' 次；' + stateText(refreshed) + '）...');
            await sleep(200);
            continue;
        }
    }
    try {
        bot.stopDigging?.();
    } catch {
        // 忽略。
    }
    log(
        bot,
        '挖 ' + name + ' ' + where + ' 结束：连续 ' + attempts + ' 次超时/失败，累计 ' +
            Math.round(totalMs / 1000) + 's；仍在挖=' + (bot?.targetDigBlock != null) + '；' +
            stateText(digTargetState(bot, block)) + '。可稍后重试或换工具。',
    );
    return false;
}

export async function breakBlockAt(bot: any, x: number, y: number, z: number): Promise<boolean> {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    const block: any = bot.blockAt((Vec3 as any)(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (settings.cheat) {
            const msg: string = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            const pos: any = block.position;
            const movements: any = movementsFor(bot);
            // **局部关闭，不是全局默认**（出厂 `canPlaceOn = true`、`allow1by1towers = true`）：
            // 这一步只是"凑到方块旁边再挖它"，不该顺手搭塔/在别人方块上放东西。
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new (pf as any).goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId: any = bot.heldItem ? bot.heldItem.type : null;
            if (!block.canHarvest(itemId)) {
                // 硬方块仍旧拒绝；软方块（下界岩/沙/沙砾）允许徒手挖开——
                // 理由见 isHandMineable：无镐时被封在方块里，两边都不肯挖
                // 就是永久卡死（Feedback #38/#43）。
                if (!isHandMineable(block)) {
                    // **裸装的真话 + 实测哪条路真的能走**（Lead 2026-10-21 两次踩到）：
                    // 一开始只给三条通用建议（找软土/找洞穴/换个方向）。用 CLI 当玩家时发现
                    // **这三条可能一条都不可行**（周围全是石头、只有 2 个土、洞口已不记得），
                    // 于是模型读到一段"看起来有出路、实际没有"的文案，继续对 stone 发同一命令。
                    // 现在把建议换成**就地测出来的事实**：附近有没有软方块、有没有洞口、都没有就直说"没路"。
                    let softNearby = 0;
                    let softAt: string | null = null;
                    let caveNearby = 0;
                    try {
                        const origin = bot.entity?.position;
                        if (origin) {
                            for (let dx = -6; dx <= 6 && softNearby < 1; dx++) {
                                for (let dy = -4; dy <= 4 && softNearby < 1; dy++) {
                                    for (let dz = -6; dz <= 6; dz++) {
                                        const b = bot.blockAt?.(origin.offset(dx, dy, dz));
                                        if (!b) continue;
                                        if (b.name === 'dirt' || b.name === 'gravel' || b.name === 'sand'
                                            || b.name === 'red_sand' || b.name === 'clay') {
                                            softNearby += 1;
                                            softAt = `${b.name} @(${Math.round(origin.x + dx)},${Math.round(origin.y + dy)},${Math.round(origin.z + dz)})`;
                                            break;
                                        }
                                    }
                                }
                            }
                            // 洞口：附近有一格空气且它上方也是空气（能钻进去的那种）
                            for (let dx = -4; dx <= 4 && caveNearby < 1; dx++) {
                                for (let dy = -2; dy <= 3 && caveNearby < 1; dy++) {
                                    for (let dz = -4; dz <= 4; dz++) {
                                        const p = origin.offset(dx, dy, dz);
                                        const b = bot.blockAt?.(p);
                                        const up = bot.blockAt?.(p.offset(0, 1, 0));
                                        const up2 = bot.blockAt?.(p.offset(0, 2, 0));
                                        if (b?.name === 'air' && up?.name === 'air' && up2?.name === 'air') {
                                            caveNearby += 1;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    } catch {
                        // 读不到世界就退回"未测量"，不编数字。
                    }
                    const measured = softNearby > 0 || caveNearby > 0;
                    log(
                        bot,
                        `没有能挖 ${block.name} 的工具（手持 ${bot?.heldItem?.name ?? '空手'}），空手挖不动 ${block.name}。` +
                            (measured
                                ? `**附近实测**：软方块 ${softNearby > 0 ? `有（最近的 ${softAt}）` : '0 个'}；` +
                                  `可钻的洞口 ${caveNearby > 0 ? '有（4 格内有 3 格高的空腔）' : '0 个'}。` +
                                  (softNearby > 0
                                      ? '走那里挖软土是对的。'
                                      : '那就往洞口方向走，别在这一列凿石头。')
                                : '**附近实测：6 格内没有 dirt/gravel/sand，4 格内也没有能钻的洞口——这一列确实没路。**' +
                                  '别再对 stone 发 digDown（只会再得到这一行）：换个方向走远一点找软土/洞口，' +
                                  '或者用 pillarUp 垫着往上（有方块的话）。'),
                    );
                    return false;
                }
                log(bot, `没有能挖 ${block.name} 的工具（手持 ${bot?.heldItem?.name ?? '空手'}）；它硬度低，改用空手挖（更慢，而且可能不掉落）。`);
            }
        }
        // **给 dig 加超时**。mineflayer 的 `bot.dig` promise 在方块中途被改、
        // 被打断、或者 bot 被 Stop 过之后会**永不 resolve**——模型真机三次数据点：
        // digDown 静默卡死 115 / 140 / 152 秒（`task.stuck {action:"digDown",
        // stuckForSeconds:152}`，speed 0 一格没动），她的 workaround 是"Stop() 一下就继续"。
        // 有超时就不需要人肉 Stop 了。
        if (!(await digWithTimeout(bot, block, `@(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`))) return false;
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


/**
 * 等服务器把方块状态同步过来（`until` 为真即返回）。
 *
 * mineflayer 的 `placeBlock` / `breakBlockAt` **返回时什么都没发生**：只是把
 * 一个动作发给了服务端，客户端 `blockAt` 要等服务器处理完（1 tick = 50ms）
 * 再经网络广播才读得到。原来的写法是死等 200ms——那个数是猜的，网络好时
 * 纯浪费；而蓝图施工是 8000 块起步，200ms × 8000 就是 27 分钟纯等待。
 *
 * 改成轮询：确认到了**立刻**走人，慢的时候仍有上限兜底。
 * @param until 收到目标格的实际方块名，返回 true 表示成了
 */
async function waitForBlockAt(
    bot: any,
    pos: any,
    until: (name: string) => boolean,
    timeoutMs: number = 1000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let name: string | null = null;
        try {
            name = bot.blockAt(pos)?.name ?? null;
        } catch {
            // 方块还没进视野/未加载：当作还没到，继续等。
        }
        if (name != null && until(name)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/**
 * 放方块时"这一格算空的、可以直接放"的方块名。
 *
 * **必须包含 `cave_air` / `void_air`**：洞穴里的空格在 Minecraft 里报的是
 * `cave_air`，不是 `air`。漏了它，`placeHere(netherrack)` 站在洞穴里就会被
 * 当成"目标格有方块挡路"，进而被承重块安全规则拒绝——而回执还把"放置"
 * 说成"清障"，并建议再用一次 placeHere（Feedback #41 原文）。
 */
export const PLACE_TARGET_EMPTY_BLOCKS: readonly string[] = Object.freeze([
    'air', 'cave_air', 'void_air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern',
]);

/** placeBlock 清障前的风险判据。 */
export interface PlaceBlockRisk {
    ok: boolean;
    reason: string;
}

function blockName(block: { name?: unknown } | null | undefined): string | null {
    return typeof block?.name === 'string' ? block.name : null;
}

/**
 * 清障/放置前检查站位：绝不挖脚下承重块，目标旁有岩浆/水/悬崖就拒绝。
 *
 * 真机 Feedback #34：placeBlock 清障挖掉了机器人脚下的 deepslate，bot 掉
 * 进 y=-57 岩浆烧死。承重块不是障碍物，是命。
 */
export function assessPlaceBlockRisk(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
): PlaceBlockRisk {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const tx = Math.floor(target.x);
    const ty = Math.floor(target.y);
    const tz = Math.floor(target.z);
    const nameAt = (x: number, y: number, z: number): string | null => blockName(blockAt(x, y, z));

    // 1) 玩家站立格/脚下承重格：绝不能拆。
    if (tx === fx && tz === fz && (ty === fy || ty === fy - 1)) {
        return { ok: false, reason: '目标格是你脚下/站立格的承重方块，拆了会掉下去' };
    }
    const feetName = nameAt(fx, fy, fz);
    const supportName = nameAt(fx, fy - 1, fz);
    if (feetName === 'lava' || feetName === 'water') {
        return { ok: false, reason: '你正站在 ' + feetName + ' 里，先脱离再放/清障' };
    }
    if (supportName == null || supportName === 'air' || supportName === 'lava' || supportName === 'water') {
        return { ok: false, reason: '脚下没有实心支撑，先 goToCoordinates 站到安全地面' };
    }

    // 2) 目标格/目标下方紧邻格是危险流体或空：直接拒绝。
    const targetName = nameAt(tx, ty, tz);
    if (targetName === 'lava') return { ok: false, reason: '目标格就是岩浆，不能挖/放' };
    if (targetName === 'water') return { ok: false, reason: '目标格就是水，先处理水源' };
    const belowTarget = nameAt(tx, ty - 1, tz);
    if (belowTarget === 'lava' || belowTarget === 'water') {
        return { ok: false, reason: '目标格下方紧邻 ' + belowTarget + '，清障会挖穿到岩浆/水' };
    }
    // 3) 目标紧邻岩浆：清障可能放岩浆进来。
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0],[0,1,0]]) {
        const adjacent = nameAt(tx + dx, ty + dy, tz + dz);
        if (adjacent === 'lava') {
            return { ok: false, reason: '目标格紧邻岩浆，清障风险高；先换一格或换个站位' };
        }
    }
    return { ok: true, reason: '' };
}

export async function placeBlock(bot: any, blockType: string, x: number, y: number, z: number, placeOn: string = 'bottom', dontCheat: boolean = false): Promise<boolean> {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest: any = new (Vec3 as any)(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        const risk = assessPlaceBlockRisk(
            (bx, by, bz) => bot.blockAt(new Vec3(bx, by, bz)),
            bot.entity.position,
            { x, y, z },
        );
        if (!risk.ok) {
            // **意图是"拆"**：别把替代方案写成"用 placeHere"——那是另一个工具，
            // 而且同一格的承重规则不会因为换个工具就消失。
            log(
                bot,
                '拒绝拆掉 ' + target_dest + '：' + risk.reason + '。' +
                    '这次是**拆方块**的请求：换一格拆（placeBlock/mineBlock 指定别的坐标），' +
                    '或先 goToCoordinates 站到别的位置再拆。',
            );
            return false;
        }
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (settings.cheat && !dontCheat) {
        if (bot.restrict_to_inventory) {
            const block: any = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        const face: string = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        const msg: string = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    // 用桶"放水/放岩浆"是同一个危险操作，只是走 placeBlock 这条路。
    if (item_name === 'water_bucket' || item_name === 'lava_bucket') {
        if (!allowDangerousOp(bot, item_name === 'water_bucket' ? 'pour_water' : 'pour_lava')) return false;
    }
    let block_item: any = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, (mc as any).makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock: any = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    /** 为了放置而拆掉的方块（失败时必须补回或如实报告）。 */
    let clearedForPlacement: { name: string; x: number; y: number; z: number } | null = null;
    const empty_blocks: readonly string[] = PLACE_TARGET_EMPTY_BLOCKS;
    // **绝不清掉自己的落脚点。**
    // 真机 2026-10-19（overnight_b，虚空上方按我们的建议垫脚）：「placeBlock 把目标格的
    // 承重方块挖掉后放置失败，没补回去」——工具亲手拆掉了自己的落脚点，离掉进虚空只差一步。
    // 判定放在**任何破坏之前**：要清的那一格正好是（或正好托着）脚底 ⇒ 直接拒绝。
    if (!empty_blocks.includes(targetBlock.name) && isFootingCell({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, bot?.entity?.position)) {
        log(
            bot,
            '拒绝清掉 ' + targetBlock.name + ' @' + targetBlock.position + '：**那一格正是你现在的落脚点（或它的承重块）**——' +
                '把它挖掉再放失败，你就会踩空（虚空上方尤其致命）。' +
                '换一个目标格（placeBlock 指定别的坐标），或先 goToCoordinates 站到旁边的实心处再放；' +
                '要往上垫就先跳到下一格/站到稳固处，别从脚下拆。',
        );
        return false;
    }
    if (!empty_blocks.includes(targetBlock.name)) {
        const risk = assessPlaceBlockRisk(
            (bx, by, bz) => bot.blockAt(new Vec3(bx, by, bz)),
            bot.entity.position,
            { x, y, z },
        );
        if (!risk.ok) {
            // **意图是"放"**：说清这是清障这一步被拒，而不是"你要拆承重块"；
            // 替代方案里**不出现刚失败的那个工具**（Feedback #41：placeHere 被拒，
            // 建议里却写着"或用 placeHere"）。
            log(
                bot,
                '拒绝清障 ' + targetBlock.name + ' @' + targetBlock.position + '：' + risk.reason +
                    '。注意：这是**放置**请求（要先把那一格清出来），不是拆承重块的任务；' +
                    '换一个目标格（placeBlock 指定别的坐标）、或先 goToCoordinates 站到旁边的安全实心处再放；' +
                    '同一格再用 placeHere/placeBlock 也会被同一条规则拒绝。',
            );
            return false;
        }
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed: boolean = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        // **记下"为了放这一格拆了什么"**：后面的任何失败都必须先把它补回去，
        // 补不回去也要在回执里说清"哪一格现在是空的"（见 restoreClearedBlock）。
        clearedForPlacement = { name: String(targetBlock.name), x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
        // 拆完要确认那一格真的空了：紧接着就要往那儿放方块，
        // 服务端还没把破坏落地时 placeBlock 会撞上"格子里还有东西"。
        await waitForBlockAt(bot, target_dest, (name) => empty_blocks.includes(name));
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock: any = null;
    let faceVec: any = null;
    const dir_map: Record<string, any> = {
        'top': (Vec3 as any)(0, 1, 0),
        'bottom': (Vec3 as any)(0, -1, 0),
        'north': (Vec3 as any)(0, 0, -1),
        'south': (Vec3 as any)(0, 0, 1),
        'east': (Vec3 as any)(1, 0, 0),
        'west': (Vec3 as any)(-1, 0, 0),
    };
    const dirs: any[] = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter((d: any) => !dirs.includes(d)));

    for (const d of dirs) {
        const block: any = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new (Vec3 as any)(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        await failPlacementAfterClear(bot, clearedForPlacement, `放 ${blockType} 到 ${targetBlock.position}：周围没有可依托的面`);
        return false;
    }

    const pos: any = bot.entity.position;
    const pos_above: any = pos.plus((Vec3 as any)(0,1,0));
    const dont_move_for: string[] = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail',
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        const goal: any = new (pf as any).goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        const inverted_goal: any = new (pf as any).goals.GoalInvert(goal);
        bot.pathfinder.setMovements(movementsFor(bot));
        if (!(await runPathfindingInterruptibly(bot, inverted_goal))) {
            await failPlacementAfterClear(bot, clearedForPlacement, '让开目标格的寻路没走通');
            return false;
        }
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        const tpos: any = targetBlock.position;
        const movements: any = movementsFor(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new (pf as any).goals.GoalNear(tpos.x, tpos.y, tpos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await faceTarget(bot, buildOffBlock.position.offset(0.5, 0.5, 0.5), String(buildOffBlock.name));
            // **放置前登记**：刚放下的方块不是"掉落物"，autoPickup 不许把它当战利品捡回去
            // （真机 2026-10-21：熔炉刚放下就被自己捡回背包，回执却写 "Placed furnace"）。
            markPlaced(blockType, { x: target_dest.x, y: target_dest.y, z: target_dest.z });
            const countOf = (): number =>
                Number(
                    ((bot.inventory?.items?.() ?? []) as Array<{ name?: string; count?: number }>)
                        .filter((item) => String(item?.name ?? '').includes(blockType))
                        .reduce((sum, item) => sum + Number(item?.count ?? 0), 0),
                );
            const countBefore = countOf();
            await bot.placeBlock(buildOffBlock, faceVec);
            const countAfter = countOf();
            // 方块名要去掉 `[facing=…]` 之类后缀：blockType 在上面被改写过
            // （torch → wall_torch、stairs → stairs[facing=north]），而 blockAt 报的是裸名。
            const bareName = blockType.split('[')[0] ?? blockType;
            let confirmed = await waitForBlockAt(bot, target_dest, (name) => name === bareName);
            let readBack: string | null = null;
            try {
                readBack = String(bot?.blockAt?.(target_dest)?.name ?? '');
            } catch {
                readBack = null;
            }
            let verdict = placementVerdict({ blockRead: readBack, expected: bareName, countBefore, countAfter });
            // **世界里没有它就不叫 Placed**：重试一次，仍没有就如实报失败（不假装成功）。
            if (verdict === 'block-missing' || verdict === 'uncertain') {
                try {
                    await bot.equip(block_item, 'hand');
                    await bot.placeBlock(buildOffBlock, faceVec);
                    confirmed = await waitForBlockAt(bot, target_dest, (name) => name === bareName);
                    readBack = String(bot?.blockAt?.(target_dest)?.name ?? '');
                } catch {
                    confirmed = false;
                }
                verdict = placementVerdict({ blockRead: readBack, expected: bareName, countBefore: null, countAfter: null });
                if (verdict !== 'ok' || !confirmed) {
                    log(
                        bot,
                        `**放置没有生效**：${blockType} @${target_dest} 现在读到的仍然是 ${readBack === '' ? '读不到' : readBack}（不是 ${bareName}）——` +
                            `这一格**不是** ${blockType}，别据此继续施工；先确认脚下/旁边能站人，再试一次或换一格。`,
                    );
                    await failPlacementAfterClear(bot, clearedForPlacement, `放 ${blockType} 到 ${target_dest} 没有生效`);
                    return false;
                }
            }
            if (verdict === 'placed-but-item-not-consumed') {
                log(
                    bot,
                    `放置已落地，但背包里的 ${blockType} 数量没有减少（${countBefore} → ${countAfter}）：` +
                        '服务端可能还在同步；这一格的掉落物 3 秒内不会被 autoPickup 捡（不会"放下去又被自己捡回来"）。',
                );
            }
            log(
                bot,
                confirmed
                    ? `Placed ${blockType} at ${target_dest}（回读确认 ${readBack || bareName}）。`
                    : `Placed ${blockType} at ${target_dest}（回读 ${readBack === '' ? '读不到' : readBack}，已重试一次）。`,
            );
            return true;
        }
    } catch (err: unknown) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        await failPlacementAfterClear(bot, clearedForPlacement, `放 ${blockType} 到 ${target_dest} 失败`);
        return false;
    }
    await failPlacementAfterClear(bot, clearedForPlacement, `放 ${blockType} 到 ${target_dest} 没成功`);
    return false;
}

/** 目标格是不是**自己的落脚点**（脚所在格）或**托着脚的承重格**。 */
export function isFootingCell(
    target: { x: number; y: number; z: number },
    feet: { x: number; y: number; z: number } | null | undefined,
): boolean {
    if (feet == null) return false;
    const fx = Math.floor(Number(feet.x));
    const fy = Math.floor(Number(feet.y));
    const fz = Math.floor(Number(feet.z));
    if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fz)) return false;
    if (target.x !== fx || target.z !== fz) return false;
    return target.y === fy || target.y === fy - 1;
}

/**
 * 放置失败后**把为了放置而拆掉的方块补回去**，并如实写清世界的净变化。
 *
 * 真机 2026-10-19（虚空上方）：拆了落脚点、放置失败、没补回去 —— 一步之差就是坠入虚空。
 * 补不回去时**绝不能沉默**：回执必须点名"哪一格现在是空的"，让模型别往前踩。
 */
export async function failPlacementAfterClear(
    bot: any,
    cleared: { name: string; x: number; y: number; z: number } | null,
    reason: string,
): Promise<void> {
    if (cleared == null) return; // 没拆过东西：什么都不用补，也没什么可说
    let restored = false;
    try {
        const target = new Vec3(cleared.x, cleared.y, cleared.z);
        // 直接从相邻实心面把原来的方块放回去（不再走 placeBlock 的"清障"逻辑，
        // 免得为了补一格又去拆别的东西）。
        const dirs: any[] = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
        for (const d of dirs) {
            const neighbour: any = bot?.blockAt?.(target.plus(d));
            if (neighbour == null || PLACE_TARGET_EMPTY_BLOCKS.includes(neighbour.name)) continue;
            const item: any = bot?.inventory?.findInventoryItem?.(cleared.name);
            if (item == null) break;
            await bot.equip(item, 'hand');
            await bot.placeBlock(neighbour, new Vec3(-d.x, -d.y, -d.z));
            await waitForBlockAt(bot, target, (name) => name === cleared.name);
            restored = String(bot?.blockAt?.(target)?.name ?? '') === cleared.name;
            if (restored) break;
        }
    } catch {
        restored = false;
    }
    if (restored) {
        log(
            bot,
            `${reason}；**已经把你为了放置拆掉的 ${cleared.name} @(${cleared.x},${cleared.y},${cleared.z}) 补回去了**——` +
                '世界净变化：拆了 1 格、放回 1 格（等于没变），没有留下空洞。',
        );
    } else {
        log(
            bot,
            `${reason}；**注意：为了放置拆掉的 ${cleared.name} @(${cleared.x},${cleared.y},${cleared.z}) 现在是空的、没能补回**——` +
                '世界净变化：那一格被移除了。**别往那一格踩**；先 goToCoordinates 站到实心处，或重新 placeBlock 把它填上。',
        );
    }
}

export async function equip(bot: any, itemName: string): Promise<boolean> {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    // **已经拿在手上**：不用再换一次，也别说成失败（模型反复 equip 同一件
    // 东西时，它需要的是"已经是它了"，不是又一条动作记录）。
    if (bot?.heldItem?.name === itemName) {
        log(bot, `已经拿在手上：${itemName}（不用再换）。`);
        return true;
    }
    let item: any = bot.inventory.slots.find((slot: any) => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, (mc as any).makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            // **区分"没有"和"没换到手"**：`inventory.slots` 覆盖主背包 + 快捷栏，
            // 所以走到这里就是真的没有。Feedback #37 里模型看到
            // "You do not have any diamond_pickaxe" 时无法判断是"没换手"还是"真丢了"，
            // 只能再拍一次 stats 对账。
            log(
                bot,
                `你根本没有 ${itemName}：背包和快捷栏里都没有这个东西，不是"没换到手"。` +
                    '先采集/合成，或者去箱子里拿（拿到后 stats 能看到）。',
            );
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    // 说清"从哪拿的、装到哪"：主背包和快捷栏是两回事，模型自己数格子容易数错。
    const slot = typeof item?.slot === 'number' ? item.slot : null;
    const where = slot != null && slot >= 36 && slot <= 44 ? '快捷栏' : slot != null && slot >= 5 && slot <= 8 ? '装备栏' : '背包';
    const bodyPart = itemName.includes('leggings') ? '腿上'
        : itemName.includes('boots') ? '脚上'
            : itemName.includes('helmet') ? '头上'
                : itemName.includes('chestplate') || itemName.includes('elytra') ? '身上'
                    : itemName.includes('shield') ? '副手' : '手上';
    log(bot, `Equipped ${itemName}.（从${where}把 ${itemName} 拿到${bodyPart}）`);
    return true;
}

export async function discard(bot: any, itemName: string, num: number = -1): Promise<boolean> {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    // 丢掉和存进箱子是**同一个决定**：都是"为了腾格子把保命的东西弄没"。
    // 真机里队友正是靠丢垃圾腾位置的（19:20 那次是存箱子清空了自己），
    // 所以丢之前先记一份整包账目，丢完把后果说出来。
    const packBefore = world.getInventoryCounts(bot);
    while (true) {
        const item: any = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        const to_discard: number = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    const advice = inventoryLossAdvice({
        action: 'discard',
        before: packBefore,
        after: world.getInventoryCounts(bot),
        isFood: (name) => foodValueOf(name) != null,
        isPlaceable: (name) => bot?.registry?.blocksByName?.[name]?.boundingBox === 'block',
    });
    if (advice.text !== '') log(bot, advice.text);
    return true;
}

export async function putInChest(bot: any, itemName: string, num: number = -1): Promise<boolean> {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    const chest: any = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const item: any = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    const to_put: number = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    // **存之前的整包账目**：存完要能说清"你还剩什么"（真机 19:20 把镐、剑、
    // 食物、垫脚方块一起存了，回执只说"存了 X 个"，等到出门才发现包是空的）。
    const packBefore = world.getInventoryCounts(bot);
    const chestContainer: any = await openBlockUi(bot, chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    const advice = inventoryLossAdvice({
        before: packBefore,
        after: world.getInventoryCounts(bot),
        isFood: (name) => foodValueOf(name) != null,
        isPlaceable: (name) => bot?.registry?.blocksByName?.[name]?.boundingBox === 'block',
    });
    if (advice.text !== '') log(bot, advice.text);
    return true;
}

export async function takeFromChest(bot: any, itemName: string, num: number = -1): Promise<boolean> {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    const chest: any = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer: any = await openBlockUi(bot, chest);

    // Find all matching items in the chest
    const matchingItems: any[] = chestContainer.containerItems().filter((item: any) => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }

    const totalAvailable: number = matchingItems.reduce((sum: number, item: any) => sum + item.count, 0);
    let remaining: number = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;

    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;

        const toTakeFromSlot: number = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);

        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }

    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

/**
 * 按 `inventoryStart` 分界读取容器内容，**只取容器区间**。
 *
 * 真机 Feedback #35：读箱子串进查看者背包，槽位从 12 跳到 28。
 * mineflayer 的 `containerItems()` 在不同版本/容器类型下口径不稳，
 * 这里直接拿 slots，严格用 inventoryStart 分界。
 */
export function containerContents(container: any): {
    readable: boolean;
    invStart: number;
    end: number;
    lines: string[];
} {
    const slots = Array.isArray(container?.slots) ? container.slots : null;
    if (slots == null) {
        return { readable: false, invStart: 0, end: 0, lines: ['容器槽位表读不到（不代表容器是空的）'] };
    }
    const rawStart = Number(container?.inventoryStart ?? 27);
    const invStart = Number.isFinite(rawStart) ? Math.max(0, Math.floor(rawStart)) : 27;
    const end = Math.min(slots.length, invStart);
    const lines: string[] = [];
    for (let i = 0; i < end; i++) {
        const slot = slots[i] as { name?: unknown; count?: unknown } | null | undefined;
        if (slot?.name == null) continue;
        lines.push(String(slot.name) + '×' + String(slot.count ?? 1));
    }
    return { readable: true, invStart, end, lines };
}

/** 一次"开箱拿东西"的实测结果（给回执用；**只装测量到的事实**）。 */
export interface LootOutcome {
    readable: boolean;
    /** 箱子里原本有什么。 */
    contents: Array<{ name: string; count: number }>;
    /** 实际进了背包的（用背包增量测出来，不是"我点了几个槽"）。 */
    taken: Array<{ name: string; count: number }>;
    /** 还留在箱子里的。 */
    left: Array<{ name: string; count: number }>;
    freeSlots: number | null;
    /** 拿不完/读不到的原因。 */
    reason: string | null;
}

/**
 * **把 `LootOutcome` 渲染成模型能照着做的话**（纯函数，便于测试）。
 *
 * 真机教训（旧世界）：「捡到 0 个」被读成"这种怪不掉东西"；「箱子是空的」被读成
 * "东西丢了"。所以这里三件事分开写：**箱子里有什么 / 实际拿走多少 / 剩下的为什么留下**。
 */
export function formatLootReport(outcome: LootOutcome): string[] {
    const lines: string[] = [];
    if (!outcome.readable) {
        lines.push(
            '箱子**槽位表读不到**（窗口没给内容）——**不能据此判断箱子是空的**。' +
                '先重试一次 `useBlock`（同一个箱子），或用 `stats` 核对；容器这条路不稳时别在这上面耗。',
        );
        return lines;
    }
    const contents = outcome.contents;
    const describe = (list: Array<{ name: string; count: number }>): string =>
        list.map((entry) => `${entry.name}×${entry.count}`).join('、');
    if (contents.length === 0) {
        lines.push('箱子是**空的**：没有拿任何东西（这不是失败，也不是"拿走 0 个"）。');
        return lines;
    }
    lines.push(`箱子里有：${describe(contents)}（共 ${contents.reduce((sum, e) => sum + e.count, 0)} 件）。`);
    if (outcome.taken.length === 0) {
        lines.push(
            `**一件都没拿走**${outcome.reason != null ? `：${outcome.reason}` : ''}。` +
                (outcome.freeSlots === 0 ? '背包没有空位——先 `discard` 或存掉点东西再回来。' : ''),
        );
    } else {
        lines.push(
            `拿走：${describe(outcome.taken)}` +
                (outcome.reason != null ? `（${outcome.reason}）` : '（背包实测增量，不是"点了几个槽"）。'),
        );
    }
    if (outcome.left.length > 0) {
        lines.push(
            `留在箱子里：${describe(outcome.left)}` +
                (outcome.freeSlots != null ? `（背包空位 ${outcome.freeSlots} 个，装不下就留在这儿，下次再来）。` : '。'),
        );
    }
    return lines;
}

/**
 * **开容器并把能装的都装走**（`useBlock(type="chest")` 的实际动作）。
 *
 * 为什么不是 `takeFromChest`：那个函数**不是工具**（模型调不到），只存在于 skills 里。
 * 用户的要求"把奖励箱拿走"必须走模型真的能调用的 `useBlock`，所以能力放在这里。
 */
export async function lootContainer(bot: any, block: any): Promise<LootOutcome> {
    const snapshot = (): Map<string, number> => {
        const map = new Map<string, number>();
        try {
            for (const item of (bot?.inventory?.items?.() ?? []) as Array<{ name?: string; count?: number }>) {
                const name = String(item?.name ?? '');
                if (name === '') continue;
                map.set(name, (map.get(name) ?? 0) + Number(item?.count ?? 0));
            }
        } catch {
            // 读不到就返回空表：调用方会把"测不出"说成测不出。
        }
        return map;
    };
    const before = snapshot();
    const container: any = await openBlockUi(bot, block);
    try {
        const slots: Array<{ name?: string; type?: number; count?: number } | null> = container?.slots ?? [];
        const invStart = Number(container?.inventoryStart ?? 9);
        if (!Array.isArray(slots) || slots.length === 0) {
            return { readable: false, contents: [], taken: [], left: [], freeSlots: null, reason: '槽位表为空' };
        }
        // **只读容器区间 [0, inventoryStart)**，绝不能把查看者背包算成箱子内容。
        const contents: Array<{ name: string; count: number; type: number }> = [];
        for (let i = 0; i < Math.min(invStart, slots.length); i++) {
            const slot = slots[i];
            const name = String(slot?.name ?? '');
            if (name === '') continue;
            contents.push({ name, count: Number(slot?.count ?? 1), type: Number(slot?.type ?? -1) });
        }
        const freeSlots = (() => {
            try {
                const value = Number(bot?.inventory?.emptySlotCount?.());
                return Number.isFinite(value) ? value : null;
            } catch {
                return null;
            }
        })();
        // 按名字合并（同一种物品可能在多个槽）。
        const merged = new Map<string, { name: string; count: number; type: number }>();
        for (const entry of contents) {
            const prev = merged.get(entry.name);
            if (prev == null) merged.set(entry.name, { ...entry });
            else prev.count += entry.count;
        }
        if (merged.size === 0) {
            return { readable: true, contents: [], taken: [], left: [], freeSlots, reason: null };
        }
        if (freeSlots === 0) {
            return {
                readable: true,
                contents: [...merged.values()].map(({ name, count }) => ({ name, count })),
                taken: [],
                left: [...merged.values()].map(({ name, count }) => ({ name, count })),
                freeSlots,
                reason: '背包没有空位',
            };
        }
        // 拿走：逐种整叠取（有指定物品时只取那种，由调用方过滤）。
        const wantedTotal = [...merged.values()].reduce((sum, entry) => sum + entry.count, 0);
        try {
            for (const entry of merged.values()) {
                await container.withdraw(entry.type, null, entry.count);
            }
        } catch {
            // 取物失败也要照实报告（下面的背包增量会说明实际拿到了多少）。
        }
        const after = snapshot();
        const taken: Array<{ name: string; count: number }> = [];
        for (const entry of merged.values()) {
            const gained = (after.get(entry.name) ?? 0) - (before.get(entry.name) ?? 0);
            if (gained > 0) taken.push({ name: entry.name, count: gained });
        }
        const takenByName = new Map(taken.map((entry) => [entry.name, entry.count]));
        const left = [...merged.values()]
            .map((entry) => ({ name: entry.name, count: entry.count - (takenByName.get(entry.name) ?? 0) }))
            .filter((entry) => entry.count > 0);
        const takenCount = taken.reduce((sum, entry) => sum + entry.count, 0);
        const reason =
            takenCount < wantedTotal
                ? taken.length === 0
                    ? '点了取物但背包增量是 0——可能是客户端同步延迟，用 stats 核对'
                    : '有一部分没装下/没取到：剩下的留在箱子里'
                : null;
        return {
            readable: true,
            contents: [...merged.values()].map(({ name, count }) => ({ name, count })),
            taken,
            left,
            freeSlots,
            reason,
        };
    } finally {
        try {
            await container?.close?.();
        } catch {
            // 关不上不影响已经拿到的结果。
        }
    }
}

export async function viewChest(bot: any): Promise<boolean> {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     **/
    const chest: any = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer: any = await openBlockUi(bot, chest);
    const contents = containerContents(chestContainer);
    if (!contents.readable) {
        log(bot, contents.lines.join('\n'));
    } else if (contents.lines.length === 0) {
        log(bot, '容器区间内没有物品（只读了槽位 0..' + contents.invStart + '，不含查看者背包）。');
    } else {
        log(bot, '容器内容（只读槽位 0..' + contents.invStart + '）：');
        for (const line of contents.lines) log(bot, line);
    }
    await chestContainer.close();
    return contents.readable;
}

// ──────────────────────────── 吃东西（consume） ────────────────────────────
//
// 真机反馈（overnight_b，15:58）：`consume(mutton)` 撞上 mineflayer 的
// "Promise timed out" 后，回执整段是 `!!Action threw exception!!` + 堆栈；
// 同时快照显示 mutton 还在手上、food 仍是 14/sat 0。模型拿不到任何能据以决策的
// 事实（该换食物还是该跑？），只能在被打的时候原地反复试同一件事。饱食度是回血的
// 唯一来源，所以这条路径必须给结论。
//
// 契约（和 AGENTS 的口径一致）：
//   1. **不抛异常**：任何失败都变成一段事实回执（堆栈只进控制台，不进回执）；
//   2. **判定靠真实变化**：饱食度/饱和度上升、**或**手上确实少了一个——都不是就是"没生效"；
//   3. **同步超时自动退避重试 1 次**，重试前重新取物品并 equip（确认东西还在手上）；
//   4. **回执永远带吃前/吃后的 food 与 saturation**，并给一条能照抄的下一步。

/** 吃一口之后等服务端把饱食度同步回来——**只在第一次读不到变化时才等**。 */
const CONSUME_RESYNC_MS = 700;
/** 同步超时后的退避时间。 */
const CONSUME_RETRY_BACKOFF_MS = 800;
/** 最多试几次（1 次正常 + 1 次重试）。 */
const CONSUME_MAX_ATTEMPTS = 2;

/**
 * 存粮下限：背包里能直接吃的 ≤ 这个数，就进入"别乱吃"模式。
 *
 * 真机教训：两个 bot 边打边吃，五小时吃光 1000 格内所有能吃的东西，最后 food 2 / 血 1.68、
 * 连箱子都是空的。**"现在就吃"和"一小时后饿死"之间只差这个判断。**
 */
export const FOOD_RESERVE_MIN = 2;
/** 不饿的界线：food ≥ 这个值时不值得动存粮（低于它才算真饿，可以吃）。 */
export const FOOD_RESERVE_COMFORT = 14;

export interface ConsumeOptions {
    /** 等数值同步的时间（测试里给 0）。 */
    resyncMs?: number;
    /** 重试前的退避（测试里给 0）。 */
    retryBackoffMs?: number;
    /** 最多尝试次数。 */
    maxAttempts?: number;
}

export interface FoodState {
    food: number | null;
    saturation: number | null;
}

export interface EdibleItem {
    name: string;
    count: number;
    food: number;
    saturation: number;
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 饿不饿、饱食度多少；读不到就是 null（回执如实写"读不到"，不编数字）。 */
export function readFoodState(bot: any): FoodState {
    return { food: finiteOrNull(bot?.food), saturation: finiteOrNull(bot?.foodSaturation) };
}

/** `food 14/sat 0`；读不到就写"读不到"。 */
export function formatFoodState(state: FoodState): string {
    const food = state.food == null ? '读不到' : String(state.food);
    const saturation = state.saturation == null ? '读不到' : String(Math.round(state.saturation * 10) / 10);
    return `food ${food}/sat ${saturation}`;
}

/** `food 14/sat 0 → food 20/sat 9.6`；一模一样时补一句"没有变化"。 */
export function formatFoodDelta(before: FoodState, after: FoodState): string {
    const same = before.food === after.food && before.saturation === after.saturation;
    return `${formatFoodState(before)} → ${formatFoodState(after)}${same ? '（没有变化）' : ''}`;
}

/**
 * 这个物品能不能吃（返回 `[饥饿值, 饱和度]`）——**转发 `safety/emergency.ts` 的唯一入口**。
 *
 * 教训（overnight_b 15:58 + 本轮根治）：我先前在本文件里抄过一份"1.13 短名"别名表来
 * 绕过 `FOOD_VALUE` 缺 `mutton` 的问题。两张表迟早漂移，而漂移的代价是**生存数值静默
 * 算错**（拿着食物报"没有食物"）。现在真源只有一处：`emergency.ts` 的
 * `FOOD_VALUE`（别名已展开）/ `foodValueOf` / `normalizeFoodName`。
 */
export { foodValueOf };

/** 背包里所有能吃的东西（按"值不值得吃"排序），带数量。 */
export function listEdibleItems(bot: any): EdibleItem[] {
    let items: Array<{ name?: unknown; count?: unknown }>;
    try {
        items = (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>;
    } catch {
        return [];
    }
    if (!Array.isArray(items)) return [];
    const out: EdibleItem[] = [];
    for (const item of items) {
        const name = typeof item?.name === 'string' ? item.name : '';
        const values = foodValueOf(name);
        const count = finiteOrNull(item?.count) ?? 0;
        if (values == null || count <= 0) continue;
        out.push({ name, count, food: values[0], saturation: values[1] });
    }
    return out.sort((a, b) => b.saturation * 100 + b.food - (a.saturation * 100 + a.food));
}

/** 错误的**要点**（不是堆栈）：回执里只出现模型能据以决策的信息。 */
export function describeConsumeError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const message = raw.replace(/\s+/g, ' ').trim();
    if (/timed?\s*out|timeout/i.test(message)) {
        return `等待服务端回应超时（mineflayer: ${message.slice(0, 80)}）`;
    }
    return message === '' ? '未知错误' : message.slice(0, 120);
}

/**
 * 用**可观测的事实**判断这一口有没有吃进去（而不是"调用没抛错"）。
 *
 * 三个事实任一成立就算吃进去了：饥饿值上升、饱和度上升、手上少了一个。
 * `null` 表示读不到——读不到的一律不当作证据（宁可说"无法确认"）。
 */
export function ateByFacts(
    before: FoodState,
    after: FoodState,
    countBefore: number | null,
    countAfter: number | null,
): boolean {
    if (before.food != null && after.food != null && after.food > before.food) return true;
    if (before.saturation != null && after.saturation != null && after.saturation > before.saturation) return true;
    if (countBefore != null && countAfter != null && countAfter < countBefore) return true;
    return false;
}

/** 供回执用的一句话：手上还有什么能吃的。 */
function describeEdibles(edibles: readonly EdibleItem[]): string {
    if (edibles.length === 0) return '背包里没有别的东西能吃。';
    return `能吃的还有：${edibles.map((e) => `${e.name}x${e.count}`).join('、')}。`;
}

/** 失败之后：说清换哪一种、够不够、要不要先烤/做，并给**一条**能照抄的调用。 */
function consumeAdvice(bot: any, wanted: string, edibles: readonly EdibleItem[]): { text: string; call: string } {
    const others = edibles.filter((e) => normalizeFoodName(e.name) !== normalizeFoodName(wanted));
    if (others.length > 0) {
        const best = others[0] as EdibleItem;
        return {
            text: `手里还有别的能吃（${others.map((e) => `${e.name}x${e.count}`).join('、')}）：**换一种**比重复同一次调用有用；生肉也能吃但补得少，有熔炉就先烤熟（熟食补得多）。`,
            call: `consume(item_name="${best.name}")`,
        };
    }
    const same = wanted === '' ? null : inventoryCountOf(bot, wanted);
    if (same != null && same > 0) {
        return {
            text: `背包里没有别的食物了，${wanted} 还有 ${same} 个：可以照下面这条再试一次；**如果还是超时，就别在原地反复吃**——先离开/找食物（生肉放熔炉烤熟更划算）。`,
            call: `consume(item_name="${wanted}")`,
        };
    }
    return {
        text: `背包里没有别的食物，${wanted || '这一种'}也没了：先去找或做吃的（打猎拿生肉→熔炉烤熟），别空着肚子打架。`,
        call: 'stats(type="inventory")',
    };
}

export async function consume(bot: any, itemName: string = "", options: ConsumeOptions = {}): Promise<boolean> {
    /**
     * Eat/drink the given item.
     *
     * **不抛异常**：失败也是回执（见本段上方契约）。返回值：`true` = 有事实证据表明吃进去了。
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @param {ConsumeOptions} options, 只在测试里用（把等待时间调成 0）。
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    const wanted = String(itemName ?? '').trim();
    const resyncMs = options.resyncMs ?? CONSUME_RESYNC_MS;
    const retryBackoffMs = options.retryBackoffMs ?? CONSUME_RETRY_BACKOFF_MS;
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? CONSUME_MAX_ATTEMPTS));
    const before = readFoodState(bot);
    const countBefore = wanted === '' ? null : inventoryCountOf(bot, wanted);
    const edibles = listEdibleItems(bot);

    /** 每次都重新取：重试前必须确认东西**真的还在背包里**。 */
    const findItem = (): any => {
        if (wanted === '') return null;
        try {
            const found = bot?.inventory?.findInventoryItem?.(wanted);
            if (found != null) return found;
            const alt = wanted.includes(':') ? wanted.replace(/^minecraft:/, '') : `minecraft:${wanted}`;
            return bot?.inventory?.findInventoryItem?.(alt) ?? null;
        } catch {
            return null;
        }
    };

    // 没有这个东西（或没给名字）：点名缺什么 + 说清还有什么能吃的，不抛异常。
    if (wanted === '' || findItem() == null) {
        const advice = consumeAdvice(bot, wanted, edibles);
        log(
            bot,
            `没吃成：背包里没有 ${wanted || '(没给物品名)'}。${describeEdibles(edibles)}` +
                `现在 ${formatFoodState(before)}。${advice.text}`,
        );
        log(bot, `下一步（照做即可）：${advice.call}`);
        return false;
    }

    // ── 存粮规则：**别把最后一口吃掉** ──
    // 真机教训（2026-10-18 晚）：两个 bot 边打边吃，五小时把 1000 格内能吃的东西全吃光，
    // 之后 food 2 / 血 1.68、背包和所有箱子里都没有食物——"现在吃了，一小时后饿死"。
    // 所以：包里能直接吃的只剩 ≤2 份、而自己并不饿（food ≥ 14）时，**拒绝动存粮**。
    const edibleTotal = edibles.reduce((sum, edible) => sum + edible.count, 0);
    const rawInPack = edibles.filter((edible) => cookedCounterpartOf(edible.name) != null);
    // **低血时存粮保护让位**（Lead 2026-10-21 真机 B：血 7、food 13、背包只剩 1 份腐肉，
    // `consume` 说"先留着——你现在不饿"，把最后一份也留着 ⇒ 6 分钟无法回血）。
    // 存粮规则的前提是"你不在危险里"；health ≤ 10 时回血比留粮重要。
    const lowHealthEmergency = typeof bot?.health === 'number' && bot.health <= 10;
    if (!lowHealthEmergency && edibleTotal > 0 && edibleTotal <= FOOD_RESERVE_MIN && before.food != null && before.food >= FOOD_RESERVE_COMFORT) {
        const keep = edibles.map((edible) => `${edible.name}x${edible.count}`).join('、');
        const rawHint =
            rawInPack.length > 0
                ? ` 生肉只有熟食的一半左右：有熔炉就先 useBlock(type="furnace", input="1 ${rawInPack[0].name}", output="1 ${cookedCounterpartOf(rawInPack[0].name)}") 再吃。`
                : '';
        // 难度说明：Easy/Normal 饿不死，真正致命的是"不能回血 + 挨打"——
        // 说清楚它才不会恐慌性清空存粮（真机原话：一捡到就吃掉，然后饿死）。
        const starving = starvationNote(difficultyOf(bot));
        log(
            bot,
            `consume ${wanted}：**先留着——你现在不饿**（${formatFoodState(before)}）。` +
                `背包里只剩 ${edibleTotal} 份能吃的（${keep}），这是低血期的救命粮：饿到 food ≤ ${FOOD_RESERVE_COMFORT - 1} 再吃。` +
                `${rawHint}${starving === '' ? '' : ` ${starving}`} 趁现在去补：钓鱼（工作台做 fishing_rod）／打猎／种小麦。`,
        );
        log(bot, `下一步（照做即可）：searchForBlock(type="water", search_range=128)`);
        return false;
    }

    let failures: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const item = findItem();
        if (item == null) {
            failures.push(`第 ${attempt} 次尝试前发现 ${wanted} 已经不在背包里`);
            break;
        }
        let failure: string | null = null;
        try {
            await bot.equip(item, 'hand');
            await bot.consume();
        } catch (err) {
            failure = describeConsumeError(err);
            // 堆栈给控制台（排障要），回执只给事实（模型要）。
            console.error(`[consume] ${wanted} 第 ${attempt} 次失败：`, err);
        }

        let after = readFoodState(bot);
        let countAfter = wanted === '' ? null : inventoryCountOf(bot, wanted);
        if (!ateByFacts(before, after, countBefore, countAfter)) {
            // 只有"读不到变化"时才等一次同步，成功路径不付这个时间。
            await sleep(resyncMs);
            after = readFoodState(bot);
            countAfter = wanted === '' ? null : inventoryCountOf(bot, wanted);
        }

        const ateByState =
            (before.food != null && after.food != null && after.food > before.food) ||
            (before.saturation != null && after.saturation != null && after.saturation > before.saturation);
        const ateByCount = countBefore != null && countAfter != null && countAfter < countBefore;
        const countText = countBefore == null || countAfter == null ? '数量读不到' : `手上 ${countBefore} → ${countAfter}`;
        const retried = failures.length > 0;

        if (ateByFacts(before, after, countBefore, countAfter)) {
            const how =
                ateByState && ateByCount
                    ? `${countText}，${formatFoodDelta(before, after)}`
                    : ateByState
                      ? formatFoodDelta(before, after)
                      : `${countText}（饱食度读数没变，服务端可能还没同步——别再连吃）`;
            const retryNote = retried ? `第 ${attempt - 1} 次同步超时（${failures.join('；')}），退避后重试成功——` : '';
            log(bot, `${retryNote}吃成了：${wanted}（${how}）。`);
            // 生肉只有熟食的一半左右：吃都吃了，但把"下次先烤"说清楚（有熔炉就直接给调用）。
            const cooked = cookedCounterpartOf(wanted);
            const rawValue = foodValueOf(wanted);
            const cookedValue = cooked == null ? null : foodValueOf(cooked);
            if (cooked != null && rawValue != null && cookedValue != null) {
                log(
                    bot,
                    `⚠️ ${wanted} 是生的：只有 ${rawValue[0]} 点食物，烤成 ${cooked} 是 ${cookedValue[0]} 点` +
                        `（约一倍）。下次先 useBlock(type="furnace", input="1 ${wanted}", output="1 ${cooked}") 再吃。`,
                );
            }
            return true;
        }

        if (failure == null) {
            // 调用没报错、但事实没变：如实说"没生效"，**不再重试**（免得重复吃）。
            const readable = after.food != null || countAfter != null;
            const advice = consumeAdvice(bot, wanted, edibles);
            log(
                bot,
                readable
                    ? `consume ${wanted}：**没生效**——调用没报错，但${countText}、${formatFoodDelta(before, after)}，` +
                          '说明这一口服务端没采纳。可以按下面这条再试一次；连续两次这样就别在原地反复吃。' +
                          ` ${advice.text}`
                    : `consume ${wanted}：**无法确认**——调用没报错，但饥饿值和背包数量都读不到，不能证明吃进去了。` +
                          ` 请用 stats(type="inventory") 核对。 ${advice.text}`,
            );
            log(bot, `下一步（照做即可）：${advice.call}`);
            return false;
        }
        failures.push(failure);
        if (attempt < maxAttempts) await sleep(retryBackoffMs);
    }

    const after = readFoodState(bot);
    const countAfter = wanted === '' ? null : inventoryCountOf(bot, wanted);
    const advice = consumeAdvice(bot, wanted, edibles);
    const stillHeld = countAfter != null && countAfter > 0;
    // 两次都是同一个原因时别复读两遍（真机回执要短、要能一眼看完）。
    const reason =
        failures.length > 1 && new Set(failures).size === 1
            ? `${failures.length} 次都是${failures[0]}`
            : failures.join('；') || '未知原因';
    log(
        bot,
        `consume ${wanted}：**没吃成**（试了 ${Math.max(1, failures.length)} 次）——${reason}。` +
            (stillHeld ? `东西**还在手上**（${countAfter} 个），可以重试。` : '东西已经不在手上了，先确认背包再决定。') +
            `饥饿值 ${formatFoodDelta(before, after)}——这一口没起效。${advice.text}`,
    );
    log(bot, `下一步（照做即可）：${advice.call}`);
    return false;
}


export async function giveToPlayer(bot: any, itemType: string, username: string, num: number = 1): Promise<boolean> {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    const player: any = bot.players[username].entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        const start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position, true);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector: any, collected: any) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        const start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

/**
 * 多远算"一步算不完"的远距离（格）。
 *
 * 跨矿洞的长路径要把"挖穿整段地形"的分支全展开，A* 的搜索量随距离指数涨——
 * 真机上 40+ 格的地下路径经常 20 秒都算不完（thinkTimeout 已经放宽过）。
 * 超过这个距离的 NoPath 先自动分一段再试，不直接报失败。
 */
export const SEGMENT_THRESHOLD = 48;

/**
 * 水平超过这个距离就**自己分段**（每段一次独立的 A*，搜索空间有界）。
 *
 * 用户真机抱怨（2026-10-18）："这个寻路器经常失败，不是找不到可行路径，就是
 * 提示什么路径太长之类的。" 日志侧同一晚：`Took to long to decide path to goal`
 * ×70、`NoPath` ×29、`Path was stopped before it could be completed` ×21。
 * 根因不是"没路"，是**把上百格的目标一次性丢给 A***：下界地形碎、要挖要绕，
 * 无界搜索直接把 20 秒算路预算烧光。分段后每一段都算得完，而且走一段就**真的**
 * 前进了一段（部分进度是实打实的）。
 */
export const PATH_CHUNK_THRESHOLD = 56;

/** 每段水平长度上限（格）。32 格在下界是 A* 能稳定算完的量级。 */
export const PATH_CHUNK_LENGTH = 32;

/**
 * A* 的搜索半径（代价上限，相对启发式的最多额外代价）。
 *
 * `mineflayer-pathfinder` 默认 `-1`（无界），正是"烧光预算"的直接原因。
 * 180 够走 32 格的路 + 绕几个弯 / 挖几格软方块（徒手挖一格下界岩 laborCost≈35），
 * 又不可能无限展开。
 */
export const PATH_SEARCH_RADIUS = 180;

export interface PathLeg {
    x: number;
    y: number;
    z: number;
}

/**
 * 把长目标拆成有界的腿（纯函数，便于单测）。
 *
 * - 水平 ≤ `threshold`：单腿，直接到目标（短距离不值得分段）。
 * - 否则：`ceil(水平距离 / chunkLength)` 条腿，每腿 ≤ chunkLength，
 *   高度按比例插值（和原来的"中途点"口径一致），**最后一条精确落在目标上**。
 */
export function planPathLegs(
    from: { x: number; y: number; z: number } | null | undefined,
    to: { x: number; y: number; z: number },
    chunkLength: number = PATH_CHUNK_LENGTH,
    threshold: number = PATH_CHUNK_THRESHOLD,
): PathLeg[] {
    const fx = Number(from?.x ?? 0);
    const fy = Number(from?.y ?? 0);
    const fz = Number(from?.z ?? 0);
    const dx = to.x - fx;
    const dy = to.y - fy;
    const dz = to.z - fz;
    const horizontal = Math.hypot(dx, dz);
    if (!Number.isFinite(horizontal) || horizontal <= threshold || chunkLength <= 0) {
        return [{ x: to.x, y: to.y, z: to.z }];
    }
    const legs = Math.max(2, Math.ceil(horizontal / chunkLength));
    const out: PathLeg[] = [];
    for (let i = 1; i <= legs; i++) {
        if (i === legs) {
            out.push({ x: to.x, y: to.y, z: to.z });
            continue;
        }
        const t = i / legs;
        out.push({ x: fx + dx * t, y: fy + dy * t, z: fz + dz * t });
    }
    return out;
}

/** 垂直方向的横向偏移航点（±distance 格）。纯函数。 */
export function lateralOffsetWaypoint(
    from: { x: number; y: number; z: number } | null | undefined,
    to: PathLeg,
    side: 1 | -1,
    distance: number = 3,
): PathLeg {
    const fx = Number(from?.x ?? to.x);
    const fz = Number(from?.z ?? to.z);
    const dx = to.x - fx;
    const dz = to.z - fz;
    const len = Math.hypot(dx, dz);
    if (!Number.isFinite(len) || len < 1e-6) return { x: to.x, y: to.y, z: to.z };
    return {
        x: to.x + (-dz / len) * distance * side,
        y: to.y,
        z: to.z + (dx / len) * distance * side,
    };
}

export interface PathLegAttemptPlan {
    /** 第几档（0 起）：goToGoal 据此决定算路预算与放宽开关。 */
    attempt: number;
    /** 0 = 不偏移；+1 / -1 = 垂直方向两侧各偏 3 格。 */
    side: 0 | 1 | -1;
    /** 这一档在干什么（进回执）。 */
    what: string;
}

/**
 * 每段失败后的**重试阶梯**（顺序即执行顺序，第一档成功就停）。
 *
 * 真机失败从来不是"一种失败"：算路预算不够、不会搭塔、挖不动、目标那一列
 * 恰好不可达。所以按代价从低到高逐档加码，而不是原样重试。
 */
export const PATH_LEG_LADDER: readonly PathLegAttemptPlan[] = Object.freeze([
    { attempt: 0, side: 0, what: '基准（20 秒算路）' },
    { attempt: 1, side: 0, what: '延长算路到 30 秒' },
    { attempt: 2, side: 0, what: '允许用背包方块 1x1 搭塔' },
    { attempt: 3, side: 0, what: '允许挖穿挡路的软方块（工具耐久够用时）' },
    { attempt: 4, side: 1, what: '横向偏移 +3 格' },
    { attempt: 4, side: -1, what: '横向偏移 -3 格' },
]);

/**
 * 落差限制能不能条件放宽（2 → 3 格）？
 *
 * `MAX_DROP_DOWN=2` 是保命值（真机被带着直落 12~13 格摔死过），**不许默默改掉**。
 * 但在下界崖壁/沟壑地形里它确实会吃掉大量下坡动作。只有同时满足
 * "血够多（≥16）+ 脚下 4 格内没有岩浆"才放宽，并在回执里说明。
 */
export function canRelaxDropDown(bot: any): boolean {
    const health = typeof bot?.health === 'number' ? bot.health : 20;
    if (!(health >= 16)) return false;
    const feet = bot?.entity?.position;
    if (feet == null) return false;
    const fx = Math.floor(Number(feet.x));
    const fy = Math.floor(Number(feet.y));
    const fz = Math.floor(Number(feet.z));
    for (let dy = -1; dy >= -4; dy--) {
        let block: { name?: unknown } | null = null;
        try {
            block = bot?.blockAt?.(new Vec3(fx, fy + dy, fz)) ?? null;
        } catch {
            block = null;
        }
        const name = typeof block?.name === 'string' ? block.name : '';
        if (name.includes('lava')) return false;
    }
    return true;
}

/** 有没有能挖的工具（镐/斧/锹/锄）：诊断"挖不动"用。 */
export function hasDigTool(bot: any): boolean {
    try {
        const items = (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown }>;
        return items.some((i) => typeof i?.name === 'string' && /_(pickaxe|axe|shovel|hoe)$/.test(i.name));
    } catch {
        return false;
    }
}

/**
 * 前方有没有"超过安全上限"的落差（诊断用，不改决策）。
 *
 * 沿目标方向看最多 6 格：找到每列第一个实心方块，落差 = 脚高度 - 落点高度。
 * 大于 `maxDropDown` 就说明 `MAX_DROP_DOWN` 很可能是这次失败的原因之一。
 */
export function findDropAhead(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    from: { x: number; y: number; z: number },
    to: PathLeg,
    maxDropDown: number = MAX_DROP_DOWN,
): number | null {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (!Number.isFinite(len) || len < 1e-6) return null;
    const ux = dx / len;
    const uz = dz / len;
    const fy = Math.floor(Number(from.y));
    for (let step = 1; step <= 6; step++) {
        const x = Math.floor(from.x + ux * step);
        const z = Math.floor(from.z + uz * step);
        for (let dy = 0; dy >= -6; dy--) {
            let block: { name?: unknown } | null = null;
            try {
                block = blockAt(x, fy + dy, z);
            } catch {
                block = null;
            }
            const name = typeof block?.name === 'string' ? block.name : '';
            const solid = name !== '' && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(name);
            if (solid) {
                const drop = -dy;
                if (drop > maxDropDown && drop <= 6) return drop;
                break;
            }
        }
    }
    return null;
}

export interface PathFailureDiagnosis {
    kind: 'probe' | 'timeout' | 'drop' | 'nodig' | 'inwater' | 'unknown';
    reason: string;
    next: string;
}

/**
 * bot 此刻是不是站在水里（脚或头那一格是 water）。
 *
 * 独立成函数是为了能单测，也为了让"水下结论"只有一处判据：避水规则一旦生效，
 * 站在水里的 bot 会得到"所有相邻格都危险"的寻路图，表现为 `No path to the goal`。
 * 读不到方块就当没在水里（fail-open，避免凭空给出错误诊断）。
 */
export function isStandingInWater(bot: unknown): boolean {
    const b = bot as { entity?: { position?: { x?: number; y?: number; z?: number } }; blockAt?: (p: unknown) => { name?: string } | null } | null;
    const pos = b?.entity?.position;
    if (pos == null || typeof b?.blockAt !== 'function') return false;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    for (const dy of [0, 1]) {
        try {
            const block = b.blockAt!(new Vec3(Math.floor(x), Math.floor(y) + dy, Math.floor(z)));
            if (block?.name === 'water') return true;
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * 把一次寻路失败翻译成模型能行动的**一类**原因。
 *
 * 以前所有失败都长一个样（"Took to long to decide path to goal!. 你在…物理正常。"），
 * 模型只能反复换招。四类分别给一句具体的下一步。
 */
export function classifyPathFailure(input: {
    message?: string | null;
    probeFailed?: boolean;
    dropAhead?: number | null;
    noTool?: boolean;
    /** 出发时 bot 自己站在水里（脚或头是 water）。 */
    inWater?: boolean;
}): PathFailureDiagnosis {
    const message = input.message ?? '';
    if (/Took to (o)?(long|longer)|timed? ?out|Execution timed out/i.test(message)) {
        return {
            kind: 'timeout',
            reason: `整段算路超时（A* 把算路预算用完了，通常因为目标太远或地形太碎）`,
            next: '把目标拆成更短的中间点（≤32 格）再走一次，别一次给上百格',
        };
    }
    // **站在水里时，避水规则会把这趟寻路变成"无解"**：所有相邻格都被判成危险，
    // A* 一步都迈不出去——但报出来只有干巴巴的 `No path to the goal`。
    // 真机（2026-10-18 14:56，overnight_b 掉进水里）：模型看到那句就开始乱换目标，
    // 其实解法只有一个——先上岸。所以这一条要排在 NoPath 之前，并且点名动作。
    if (input.inWater === true) {
        return {
            kind: 'inwater',
            reason: '你**正站在水里**：避水规则把所有相邻格都判成危险，A* 因此一步都走不出去（不是路不存在）',
            next: '先出水——朝最近的岸边走上去（或调 escapeWater），上岸之后再发 goToCoordinates；在水里重发同一个目标只会得到同一句失败',
        };
    }
    if (input.dropAhead != null && input.dropAhead > 0) {
        return {
            kind: 'drop',
            reason: `落差限制挡住了（前方有 ${input.dropAhead} 格落差，安全上限是 ${MAX_DROP_DOWN} 格）`,
            next: '往侧面挪 4~8 格找缓坡，或先 placeBlock 垫一层再往下走',
        };
    }
    if (input.noTool === true) {
        return {
            kind: 'nodig',
            reason: '挡路的方块手上没工具挖（徒手只挖得动下界岩/沙/沙砾这类软方块）',
            next: '先补一把镐（背包里有就 equip 到手上），或者绕开这段地形',
        };
    }
    if (input.probeFailed === true) {
        return {
            kind: 'probe',
            reason: '快速探测（1 秒预算）没算出路径——**这不代表走不到**',
            next: '会按完整算路继续走；还失败就把目标拆成 ≤32 格的中间点',
        };
    }
    if (/No path/i.test(message)) {
        return {
            kind: 'unknown',
            reason: 'A* 没找到可行路径（可能是夹角、封闭地形，或挖不动的方块挡着）',
            next: '换一个中间点、往侧面挪 2~4 格再试，或自己 mineBlock 开一条路',
        };
    }
    return {
        kind: 'unknown',
        reason: message === '' ? '寻路失败（没有具体错误信息）' : `寻路失败：${message}`,
        next: '先把目标拆小（≤32 格的中途点），或换一个中间点再试',
    };
}

/** 可中断寻路的轮询间隔（毫秒）。 */
export const PATHFIND_INTERRUPT_POLL_MS = 200;

/**
 * 寻路结束时对账主手工具：坏了就报"哪把、挖了几格、下一步怎么办"。
 * 没坏就不说话（不打扰）。数到的挖格数是**这次寻路调用**里 mineflayer 的
 * `diggingCompleted` 次数——pathfinder 挖的也算，因为走的是同一个 bot.dig。
 */
function reportPathfindingToolUse(bot: any, before: HeldToolState, dugBlocks: number): void {
    const notice = toolBreakNotice(before, bot);
    if (notice == null) return;
    const dugText = dugBlocks > 0 ? `这次寻路挖了约 ${dugBlocks} 格` : '这次寻路没有记录到挖掉的方块';
    log(
        bot,
        `${notice}（${dugText}；寻路挖路同样消耗耐久，长距离移动前先备好替换工具或改走不破坏地形的路线。）`,
    );
}

/**
 * 可中断的 `pathfinder.goto`。
 *
 * `bot.pathfinder.goto(goal)` 在计算/走路时**不认** `bot.interrupt_code`：
 * Stop 之后 `pathfinder.stop()` 可能只让它换个目标继续卡，于是 ActionManager.stop
 * 等 10 秒只能 cleanKill 杀 body（真机 13 分钟 3 次 goToCoordinates）。这里每
 * PATHFIND_INTERRUPT_POLL_MS 轮询一次 interrupt_code，一旦置位立刻 `pathfinder.stop()`
 * 并 resolve(false)，把控制权还给调用方，不再靠杀进程。
 */
export function runPathfindingInterruptibly(bot: any, goal: any): Promise<boolean> {
    if (bot?.interrupt_code) {
        try {
            bot.pathfinder?.stop?.();
        } catch {
            // 停不下来也要按中断返回。
        }
        return Promise.resolve(false);
    }
    // **寻路自己会挖路**（pathfinder 直接调 bot.dig，不经过 digWithTimeout），
    // 所以工具消耗的对账必须放在这里：数它挖了几格、坏的是哪把、还剩几把。
    // 真机就是这么烧光木镐的：1 分钟 40+ 格，坏了也没有一句话。
    const heldBefore = heldToolState(bot);
    let dugBlocks = 0;
    const onDug = (): void => { dugBlocks++; };
    const canCountDigs = typeof bot?.on === 'function' && typeof bot?.removeListener === 'function';
    if (canCountDigs) {
        try {
            bot.on('diggingCompleted', onDug);
        } catch {
            // 数不了就不数，不影响寻路本身。
        }
    }
    const detachDigCounter = (): void => {
        if (!canCountDigs) return;
        try {
            bot.removeListener('diggingCompleted', onDug);
        } catch {
            // 同上。
        }
    };
    return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            detachDigCounter();
            reportPathfindingToolUse(bot, heldBefore, dugBlocks);
            fn();
        };
        const timer: ReturnType<typeof setInterval> = setInterval(() => {
            // 耐久第一次跌破安全线就提醒，不等烧光。
            warnLowDurabilityOnce(bot);
            if (bot?.interrupt_code) {
                try {
                    bot.pathfinder?.stop?.();
                } catch {
                    // 忽略底层 stop 异常。
                }
                settle(() => resolve(false));
            }
        }, PATHFIND_INTERRUPT_POLL_MS);
        let gotoPromise: Promise<unknown>;
        try {
            gotoPromise = Promise.resolve(bot.pathfinder.goto(goal));
        } catch (err: unknown) {
            settle(() => reject(err));
            return;
        }
        gotoPromise.then(
            () => settle(() => resolve(true)),
            (err: unknown) => settle(() => reject(err)),
        );
    });
}

export interface PathfindGoalOptions {
    /** 重试阶梯第几档（0 起）：决定算路预算与放宽开关。 */
    attempt?: number;
    /** 条件放宽落差（血量 ≥16 + 脚下 4 格内无岩浆）。 */
    relaxDropDown?: boolean;
    /** 回执前缀（"第 2/4 段"）：分段/分档时让模型认得出这是哪一次。 */
    label?: string;
    /**
     * **逃生专用**：寻路时临时允许走水。
     *
     * 只有 `escapeWater` 这种"脚已经在水里"的动作才该传 true——避水规则会把
     * 水里那格的所有相邻格判成危险，A* 一步都迈不出去，工具等于自相矛盾
     * （真机 2026-10-18 21:37 overnight_b 卡 1×1 水坑）。普通移动一律不传。
     */
    allowWater?: boolean;
}

/** 一次寻路尝试的结果（阶梯需要知道"是探测失败还是算路失败"）。 */
export interface PathfindOutcome {
    arrived: boolean;
    /** 1 秒快速探测有没有失败（失败 ≠ 走不到，但回执要分开说）。 */
    probeFailed: boolean;
    /** 有具体错误信息时带上（超时/NoPath），没有就是 null。 */
    message: string | null;
}

export async function goToGoal(bot: any, goal: any, _persist?: boolean, options: PathfindGoalOptions = {}): Promise<boolean> {
    return (await goToGoalDetailed(bot, goal, options)).arrived;
}

export async function goToGoalDetailed(bot: any, goal: any, options: PathfindGoalOptions = {}): Promise<PathfindOutcome> {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * (`_persist` is ignored; it exists only because one legacy call site
     * passes a third argument.)
     **/

    // **深水闸门（第一道）：目标点本身是不是危险的水。**
    // 原来 `enter_deep_water` 只是登记表里的一行——着火豁免、拒绝文案都写着它，
    // 但**没有任何代码真的拿它去问许可**，等于这条规则从来没生效过。用户的原话
    // 是"禁止接触到深度超过一格的水"，所以先拦目标：那片水深 / 在流动 / 连着
    // 流动水，就别过去。
    // 只有给了明确坐标的 goal（GoalNear / GoalBlock / GoalXZ 那一类）才查得动；
    // GoalFollow 之类追实体的没有坐标，交给下面第二道闸（allowWater）。
    const g = goal as { x?: unknown; y?: unknown; z?: unknown } | null | undefined;
    const label = options.label != null && options.label !== '' ? options.label + '：' : '';
    const attempt = Number.isFinite(Number(options.attempt)) ? Number(options.attempt) : 0;
    const gx = g != null ? Number(g.x) : NaN;
    const gy = g != null ? Number(g.y) : NaN;
    const gz = g != null ? Number(g.z) : NaN;
    if (Number.isFinite(gx) && Number.isFinite(gy) && Number.isFinite(gz)) {
        const refusal = dangerousWaterRefusal(bot, gx, gy, gz, '走到');
        if (refusal != null) {
            log(bot, refusal);
            return { arrived: false, probeFailed: false, message: refusal };
        }
    }

    const nonDestructiveMovements: any = movementsFor(bot, { allowWater: options.allowWater === true });
    const dontBreakBlocks: string[] = ['glass', 'glass_pane'];
    for (const block of dontBreakBlocks) {
        // 某些 Movements 版本/替身没有 blocksCantBreak，add 时把这条兜住。
        //
        // **mcdata 还没初始化时 `getBlockId` 会抛**（没连服务器时 `mcdata` 是 null，
        // 报的是 `Cannot read properties of null (reading 'blocksByName')`）。
        // 这只影响"少一条不挖玻璃的偏好"，**不该让整次寻路失败**——真机重启后
        // 第一趟寻路正好会踩到，测试里也一样。
        try {
            const id = (mc as any)?.getBlockId?.(block);
            if (typeof id === 'number') nonDestructiveMovements.blocksCantBreak?.add?.(id);
        } catch {
            // 拿不到就算了：玻璃照样能挖，只是没有"优先不挖"这条偏好。
        }
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements: any = movementsFor(bot, { allowWater: options.allowWater === true });

    // **安全基线（落差 / 冲刺 / 跑酷 / 深水）不在这里设**——两套 Movements 都来自
    // `movementsFor()`，它在出厂时就套好了，见 `movements.ts`。
    //
    // 这里**故意**不再重复一遍：原先这段是唯一一处安全配置，其余 16 处 `new
    // Movements(bot)` 全是裸的——追怪、逃跑、保命 fleeTo 都从水里直穿过去。
    // 安全配置跟着"创建实例的地方"走，才谈得上"任何情况下都有效"。
    // 真机证据（为什么要这些值）也一并搬去 `movements.ts` 了，不复制第二份。
    // **算路超时也要放宽**：默认 thinkTimeout 只有 5 秒，长路径（从 100 格深的竖井
    // 爬出来、绕过大片水域）根本算不完，就直接报 'Took to long to decide path to goal!'
    // ——模型真机报的"goToCoordinates 完全不动"就是这个。物理诊断加上之后一眼就看到了。
    try {
        // 阶梯第 2 档起把算路预算抬到 30 秒（默认 20 秒）。
        bot.pathfinder.thinkTimeout = attempt >= 1 ? 30_000 : 20_000;
        bot.pathfinder.tickTimeout = 80;
        // **给 A* 一个搜索半径。** 默认 `-1`（无界）就是"烧光算路预算"的直接原因：
        // 上百格的下界地形一展开就是天文数字，20 秒也不够，于是报
        // `Took to long to decide path to goal`。180 够一段 32 格的路绕弯/挖几格，
        // 又不可能无限展开（见 PATH_SEARCH_RADIUS）。
        bot.pathfinder.searchRadius = PATH_SEARCH_RADIUS;
    } catch {
        // 老版本没有这几个字段就算了。
    }
    // **低耐久时别拿最后一点耐久去挖路。** 真机（2026-10-18 12:47，overnight_b）：
    // goToCoordinates 的破坏性寻路一分钟烧光木镐 60 耐久（40+ 格），全程没有
    // 一句提示，镐没了人又被锁在下界。策略见 pathfindDigPolicy。
    const digPolicy = pathfindDigPolicy(toolDurabilityGuard(bot));
    // 破坏性寻路也别太随便挖：让"挖"比"绕"贵，只有真绕不过去才动镐。
    destructiveMovements.digCost = 5;
    if (digPolicy.note != null) {
        nonDestructiveMovements.digCost = digPolicy.digCost;
        log(bot, digPolicy.note);
    }

    let final_movements: any = digPolicy.allowDestructiveProbe ? destructiveMovements : nonDestructiveMovements;

    // ── 重试阶梯的加码开关（attempt ≥ 2）────────────────────────────
    // 搭塔默认已开（`allow1by1towers` 出厂就是 true），垫脚方块也已在
    // `movementsFor()` 里按背包实际物品填好（见 `applyScaffoldingBlocks`：
    // 库默认只认 dirt/cobblestone，下界手上是 netherrack/深板岩，等于搭不起来）。
    // 这一档只是**再确认一次**并说明，让模型知道它现在能搭。
    if (attempt >= 2) {
        for (const m of [nonDestructiveMovements, destructiveMovements]) {
            m.allow1by1towers = true;
            applyScaffoldingBlocks(bot, m);
        }
        log(bot, label + '这一档确认允许 1x1 搭塔（垫脚方块来自背包里实际有的整方块）。');
    }
    // 第 4 档：允许挖穿挡路的软方块（徒手也能挖，只要不是"真挖不动"）。
    // 工具耐久低时**不降 digCost**——那正是 E 要防的"拿最后一点耐久挖路"。
    if (attempt >= 3) {
        if (digPolicy.note == null) {
            for (const m of [nonDestructiveMovements, destructiveMovements]) {
                m.canDig = true;
                m.digCost = Math.min(m.digCost, 3);
            }
            nonDestructiveMovements.blocksCantBreak?.clear?.();
            destructiveMovements.blocksCantBreak?.clear?.();
            log(bot, label + '这一档允许挖穿挡路的方块（含徒手挖软方块；不需要掉落）。');
        } else {
            log(bot, label + '工具耐久不够，这一档不放开挖掘：' + digPolicy.note);
        }
    }
    // 条件放宽落差：只在血够多、脚下 4 格内无岩浆时 +1 格，并说明。
    if (options.relaxDropDown === true && canRelaxDropDown(bot)) {
        for (const m of [nonDestructiveMovements, destructiveMovements]) {
            m.maxDropDown = MAX_DROP_DOWN + 1;
        }
        log(bot, label + `这一档把落差上限从 ${MAX_DROP_DOWN} 格放宽到 ${MAX_DROP_DOWN + 1} 格（血量 ≥16、脚下无岩浆）。`);
    }

    let probeFailed = false;
    const pathfind_timeout = 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, label + `探到一条不挖方块的路线。`);
    }
    else if (digPolicy.allowDestructiveProbe
        && await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, label + `探到一条需要挖方块的路线。`);
    }
    else if (!digPolicy.allowDestructiveProbe) {
        log(
            bot,
            label + '低耐久寻路：快速探测没找到完全不挖路的路线；只在绕不过去时才挖（每格都在烧耐久）。' +
                '要保住工具就先换/补一把，或者改去更近的目标。',
        );
    }
    else {
        probeFailed = true;
        // **探测失败 ≠ 走不到。** 模型读到 "Path not found" 就以为没路、开始换招；
        // 这里把"仍然会走"放在最前面，并标明这是 1 秒探测的结论。
        log(
            bot,
            label + `快速探测（1 秒预算）没算出完整路径——**这不代表走不到**；` +
                `接下来按完整算路实际走（${attempt >= 1 ? 30 : 20} 秒预算 + 需要时挖开挡路的方块）。`,
        );
    }

    const doorCheckInterval: ReturnType<typeof setInterval> = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        const arrived = await runPathfindingInterruptibly(bot, goal);
        clearInterval(doorCheckInterval);
        return { arrived, probeFailed, message: null };
    } catch (err: unknown) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    }
}

let _doorInterval: ReturnType<typeof setInterval> | null = null;
function startDoorInterval(bot: any): ReturnType<typeof setInterval> {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos: any = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval: ReturnType<typeof setInterval> = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }

        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions: any[] = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1),
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ];
            const elevated_positions: any[] = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet

            let currentIndex = positions.length;
            while (currentIndex != 0) {
                const randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }

            for (const position of positions) {
                const block: any = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor')))
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

/**
 * 寻路走不动时，把**物理现场**摊开。
 *
 * 模型真机报过"goToCoordinates 完全不动且被 task.stuck，原因不明"，还自己给了
 * 堆栈定位（pathfinder monitorMovement→resetPath，疑似客户端物理被禁）。与其猜，
 * 不如把"卡在哪、脚/头是什么方块、物理开没开"直接写出来——模型能据此改策略
 * （挖出来 / 搭脚点 / 换目标），排查的人也能一眼看出原因。
 */
export function describeStuck(bot: any): string {
    try {
        const p = bot.entity.position;
        const at = (dy: number): string => {
            const b = bot.blockAt?.(p.offset(0, dy, 0));
            return typeof b?.name === 'string' ? b.name : '?';
        };
        const physics = bot.physicsEnabled === false ? '**物理已关闭**' : '物理正常';
        const inBlock = at(0) !== 'air' && at(0) !== 'cave_air' && at(0) !== 'water';
        return (
            `你在 (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})，` +
            `脚 ${at(0)} / 头 ${at(1)}，${physics}` +
            (inBlock ? '——**脚下方块是实心的，你可能卡在方块里**：用 mineBlock 挖开再走。' : '。')
        );
    } catch {
        return '（读不到物理状态）';
    }
}

/**
 * "到了目标附近"这句话的**如实版本**。
 *
 * 以前是无条件的 `You have reached at x, y, z`——三个坐标一报，听起来就是"到位了"。
 * 但寻路器说的"到"只是"进了 min_distance 这个球"，模型真正要知道的是
 * "我够得着吗"：真机上它离目标还有 3.4 格、目标在**头顶上方 3 格**，照样被报成
 * reached（Feedback #7），于是它以为自己站到了方块旁边。
 *
 * 所以这里报三件事：直线还差多少、**水平与垂直分开**、目标在上还是在下。
 * 垂直差尤其重要——差 3 格水平很好走，差 3 格高度意味着得垫方块或者挖上去。
 */
export function describeArrival(
    bot: any,
    x: number,
    y: number,
    z: number,
    distance: number,
): string {
    const pos = bot?.entity?.position;
    const one = (n: number): number => Math.round(n * 10) / 10;
    if (pos == null) return `到了 ${x}, ${y}, ${z} 附近（读不到自己的位置）。`;
    const dx = pos.x - x;
    const dz = pos.z - z;
    const dy = pos.y - y;
    const horizontal = Math.hypot(dx, dz);
    const vertical = Math.abs(dy);
    // 垂直差超过 1.5 格就值得单独说——1 格是台阶，走上去就行。
    const where =
        vertical <= 1.5
            ? '同一层'
            : dy < 0
              ? `在你的头顶上方 ${one(vertical)} 格`
              : `在你的脚下下方 ${one(vertical)} 格`;
    const tail =
        vertical <= 1.5
            ? ''
            : `；要够到它得先${dy < 0 ? '垫方块往上、或者找路上去' : '往下挖或跳下去'}`;
    return (
        `到了 ${x}, ${y}, ${z} 附近：还差 ${one(distance)} 格（水平 ${one(horizontal)} / 垂直 ${one(vertical)}），` +
            `目标${where}${tail}。`
    );
}

export async function goToPosition(
    bot: any,
    x: number | null,
    y: number | null,
    z: number | null,
    min_distance: number = 2,
    options: { allowWater?: boolean } = {},
): Promise<boolean> {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (settings.cheat) {
        // **传送也要过深水闸门** —— `/tp` 是唯一一条完全绕开寻路的移动路径：
        // 第 1 层（`blocksToAvoid`）管的是"怎么走过去"，第 2 层（`goToGoal` 的
        // 目标点判定）在这条分支上**根本不会被调用**。闸门管路径，管不了落点，
        // 所以落点得在这里单独判一次。
        //
        // 这条不难想到，难在意识到它存在：正常分支有闸，所以"模型把自己送进水里"
        // 看起来不可能——直到 cheat 开着。
    const tpRefusal = teleportRefusal(bot, x, y, z);
    if (tpRefusal != null) {
        log(bot, tpRefusal);
        return false;
    }
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }

    const checkDigProgress = (): void => {
        if (bot.targetDigBlock) {
            const targetBlock: any = bot.targetDigBlock;
            // **只问"挖不挖得穿"，不问"有没有掉落"。**
            //
            // 老写法用 `!targetBlock.canHarvest(heldId)` 当"能不能挖"：那是**掉落**
            // 判据。无镐时下界岩 canHarvest=false，于是寻路器一开始挖路就被这里
            // 叫停，回执正是模型真机贴的那句
            // `Pathfinding stopped: Cannot break netherrack with current tools.`
            // ——人被实心方块包住，走不了也挖不了（Feedback #38/#43）。
            // 现在只有真挖不动的方块（不可破坏/不可挖）才值得打断寻路。
            if (pathfindingDigAbort(targetBlock)) {
                log(bot, `Pathfinding stopped: ${targetBlock.name} 挖不动（不可破坏/不可挖），换条路或用别的办法。`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };

    const progressInterval: ReturnType<typeof setInterval> = setInterval(checkDigProgress, 1000);

    try {
        const here: any = bot?.entity?.position;
        const legs = planPathLegs(here, { x, y, z });
        if (legs.length > 1) {
            const horizontal = Math.round(Math.hypot((x as number) - here.x, (z as number) - here.z));
            log(
                bot,
                `目标 ${horizontal} 格（水平），一次 A* 容易算不完——**分 ${legs.length} 段走**，` +
                    `每段 ≤ ${PATH_CHUNK_LENGTH} 格；先到 (${legs[0].x.toFixed(0)},${legs[0].y.toFixed(0)},${legs[0].z.toFixed(0)})。`,
            );
        }
        for (let i = 0; i < legs.length; i++) {
            const leg = legs[i] as PathLeg;
            const lastLeg = i === legs.length - 1;
            const label = legs.length > 1 ? `第 ${i + 1}/${legs.length} 段` : undefined;
            // 每一段**开始就报一行**：长导航静默几十秒时，模型至少知道自己在第几段。
            if (legs.length > 1 && i > 0) {
                const now: any = bot?.entity?.position;
                const left = now == null ? null : Math.round(Math.hypot((x as number) - now.x, (z as number) - now.z));
                log(
                    bot,
                    `${label}：开始走 (${Math.round(leg.x)},${Math.round(leg.y)},${Math.round(leg.z)})` +
                        (left == null ? '。' : `，还剩约 ${left} 格。`),
                );
            }
            // 中间段只要求"进到那一格附近"（1 格），最后一段才用调用方的 min_distance。
                const outcome = await navigateLegWithLadder(bot, leg, lastLeg ? min_distance : 1, label, options);
            if (outcome.ok) {
                if (legs.length > 1 && !lastLeg) {
                    const now: any = bot?.entity?.position;
                    const left = Math.round(Math.hypot((x as number) - now.x, (z as number) - now.z));
                    log(bot, `${label} 到了，还剩约 ${left} 格。`);
                }
                continue;
            }
            if (bot.interrupt_code) {
                log(bot, `走到 (${x},${y},${z}) 的路上被中断（Stop/急停，Navigation interrupted）——没有到达。`);
                return false;
            }
            log(
                bot,
                `走不到 (${x},${y},${z})：${label != null ? label + ' ' : ''}试了 ${PATH_LEG_LADDER.length} 档都没走通。` +
                    outcome.reason +
                    describeStuck(bot) +
                    '\n可行的做法：① 换一个中间点（往侧面挪 4~8 格再试，目标那一列常常恰好不可达）；' +
                    '② 自己挖——mineBlock / digDown 开一条通道；' +
                    '③ 若你在**地上**而目标在**地下**（或反过来），先找洞口/竖井下去，别指望平地寻路穿越。',
            );
            return false;
        }
        // 中断优先于"距离够近就算到了"：Stop/急停之后不能报成功。
        if (bot.interrupt_code) {
            log(bot, `走到 (${x},${y},${z}) 的路上被中断（Stop/急停，Navigation interrupted）——没有到达。`);
            return false;
        }
        const distance: number = bot.entity.position.distanceTo(new (Vec3 as any)(x, y, z));
        // **"到了"必须包含"站得住"。** 真机 2026-10-19（末地）：「goToCoordinates 在末地报
        // 「已到达」，实际我悬空掉进虚空摔死」——坐标对上了，脚下却是空的。
        const supported = ((): boolean => {
            try {
                if (bot?.entity?.onGround === true) return true;
                const p = bot.entity.position;
                const under = bot.blockAt(new (Vec3 as any)(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
                const name = String(under?.name ?? '');
                return name !== '' && name !== 'air' && name !== 'cave_air' && name !== 'void_air';
            } catch {
                return true; // 读不到就按旧行为（不因为守卫读不到而谎报失败）
            }
        })();
        if (distance <= min_distance+1 && supported) {
            // **不许再说"已到达"就完事。** 寻路器的"到了"是"进了 min_distance
            // 这个球"，而模型关心的是"我够得着那个东西吗"——这两个不是一回事：
            // 真机上它站在 (-34.5,50,-13.5)，目标 (-33,53,-13) 在**头顶上方 3 格**，
            // 直线 3.4 格 ≤ 5 就算 reached，模型于是以为自己到位了（Feedback #7）。
            //
            // 所以把水平/垂直分开报出来，并明说目标在上方还是下方——"还差 3 格、
            // 在头顶"和"到了"对模型的含义完全不同。
            log(bot, describeArrival(bot, x, y, z, distance));
            return true;
        }
        if (distance <= min_distance+1 && !supported) {
            // **坐标到了、人悬着**：末地虚空就是这么摔死的，这**不算到达**。
            log(
                bot,
                `到了 (${x},${y},${z}) 的坐标，但**脚下没有方块**（悬空/在虚空上方）——这不算到达。` +
                    '先 placeHere 垫一块、或退回到最近的实心处再继续；别从这里往前走。',
            );
            return false;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away. ${describeStuck(bot)}`);
            return false;
        }
    } catch (err: unknown) {
        const msg: string = err instanceof Error ? err.message : String(err);
        // **每一类失败都给一句能照做的下一步**（不再是清一色 "Pathfinding stopped"）。
        const diag = classifyPathFailure({
            message: msg,
            dropAhead: readDropAhead(bot, x as number, y as number, z as number),
            noTool: !hasDigTool(bot),
            inWater: isStandingInWater(bot),
        });
        log(
            bot,
            `走不到 (${x}, ${y}, ${z})：${diag.reason}。下一步：${diag.next}。${describeStuck(bot)}`,
        );
        return false;
    } finally {
        // 分段/阶梯都会走很多次，间隔一定得在所有出口上关掉。
        clearInterval(progressInterval);
    }
}

/** 前方落差（诊断用）：读不到就返回 null。 */
function readDropAhead(bot: any, x: number, y: number, z: number): number | null {
    const here: any = bot?.entity?.position;
    if (here == null) return null;
    return findDropAhead(
        (bx, by, bz) => {
            try {
                return bot.blockAt?.(new Vec3(bx, by, bz)) ?? null;
            } catch {
                return null;
            }
        },
        { x: here.x, y: here.y, z: here.z },
        { x, y, z },
    );
}

/**
 * 走**一段**，失败就按 `PATH_LEG_LADDER` 逐档加码（第一档成功即停）。
 *
 * 为什么不是"原样重试"：真机失败从来不是一种失败——算路预算不够、不会搭塔、
 * 挖不动、目标那一列恰好不可达。每一档换一个具体旋钮，最后两档换位置。
 */
async function navigateLegWithLadder(
    bot: any,
    leg: PathLeg,
    minDistance: number,
    label?: string,
    options: { allowWater?: boolean } = {},
): Promise<{ ok: boolean; reason: string }> {
    let reason = '寻路失败（没有具体错误信息）';
    for (const step of PATH_LEG_LADDER) {
        if (bot?.interrupt_code) return { ok: false, reason: '被 Stop/保命打断，停止重试。' };
        const here: any = bot?.entity?.position;
        const waypoint: PathLeg =
            step.side === 0 ? leg : lateralOffsetWaypoint(here, leg, step.side as 1 | -1);
        const goal = new (pf as any).goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, minDistance);
        const prefix = label != null ? label + '·第 ' + (step.attempt + 1) + ' 档' : '第 ' + (step.attempt + 1) + ' 档';
        // **换档立刻报一行**（不等这一档跑完）。真机反馈（overnight_b 15:16）：
        // goToCoordinates 静默 60 秒，只在心跳时回一句"还在跑"，模型分不清
        // "在慢慢走"和"彻底卡住"。第几段、第几档、这一档在试什么，身体此刻就知道。
        if (step.attempt > 0 || step.side !== 0) {
            log(bot, prefix + '：' + step.what + '（马上试这一档）。');
        }
        let outcome: PathfindOutcome;
        try {
            outcome = await goToGoalDetailed(bot, goal, {
                attempt: step.attempt,
                relaxDropDown: step.attempt >= 3,
                label: prefix + '（' + step.what + '）',
                allowWater: options.allowWater === true,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            reason = diagnosisText(bot, msg, waypoint);
            if (bot?.interrupt_code) return { ok: false, reason: '被 Stop/保命打断，停止重试。' };
            log(bot, prefix + '（' + step.what + '）没走通：' + reason + ' 换下一档。');
            continue;
        }
        if (outcome.arrived) {
            if (step.attempt > 0) log(bot, prefix + '走通了（' + step.what + '）。');
            return { ok: true, reason: '' };
        }
        if (bot?.interrupt_code) return { ok: false, reason: '被 Stop/保命打断，停止重试。' };
        reason = diagnosisText(bot, outcome.message, waypoint, outcome.probeFailed);
        log(bot, prefix + '（' + step.what + '）没走通：' + reason + ' 换下一档。');
    }
    return { ok: false, reason };
}

/** 把一次失败翻成"原因 + 下一步"的一句话（回执用）。 */
function diagnosisText(
    bot: any,
    message: string | null,
    waypoint: PathLeg,
    probeFailed: boolean = false,
): string {
    const diag = classifyPathFailure({
        message,
        probeFailed,
        dropAhead: readDropAhead(bot, waypoint.x, waypoint.y, waypoint.z),
        noTool: !hasDigTool(bot),
        inWater: isStandingInWater(bot),
    });
    // 分类是给人看的归纳，**原始错误**也留着：归纳错了才有得查。
    const raw = message != null && message !== '' && !diag.reason.includes(message) ? `（原始错误：${message}）` : '';
    return diag.reason + raw + '；下一步：' + diag.next + '。';
}

/**
 * 走到**能接触这个方块**的位置（相邻可站立格），而不是"离它几格就算到"。
 *
 * 为什么单独有这个函数：找方块（`searchForBlock` / `collectBlocks` 的第一步）的最终
 * 目的是**碰到那个方块**——挖它、放东西到它旁边、或者站上去。"距球心 4 格"这个
 * 判定既不能保证够得着，又会让回执说"已到达"，于是模型以为到位了（Feedback #7）。
 *
 * `GoalGetToBlock` 的 `isEnd` 就是"我站的位置能够到这个方块"，所以到达时**真的**
 * 就在旁边。走不到就返回 false，由调用方如实报"走不过去"。
 */
export async function goToBlockFace(bot: any, position: { x: number; y: number; z: number }): Promise<boolean> {
    if (bot?.entity?.position == null || position == null) return false;
    const goal = new (pf as any).goals.GoalGetToBlock(position.x, position.y, position.z);
    try {
        await goToGoal(bot, goal);
    } catch (err: unknown) {
        log(bot, `Pathfinding stopped: ${err instanceof Error ? err.message : String(err)}. ${describeStuck(bot)}`);
        return false;
    }
    // GoToBlock 到达即"够得着"，但仍有极少数情况（比如最后一步被挤开）——
    // 用实际的够得着距离再确认一次，免得又报一个假的"到了"。
    const distance = bot.entity.position.distanceTo(new (Vec3 as any)(position.x, position.y, position.z));
    if (distance <= 2.5) {
        log(bot, describeArrival(bot, position.x, position.y, position.z, distance));
        return true;
    }
    log(bot, `走到了 ${position.x}, ${position.y}, ${position.z} 边上但还差 ${Math.round(distance * 10) / 10} 格（够不着）。${describeStuck(bot)}`);
    return false;
}

export async function goToNearestBlock(bot: any, blockType: string, min_distance: number = 2, range: number = 64): Promise<boolean> {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    // **先说"开始搜了"**：`getNearestBlock` 是同步遍历，半径 512 时要扫几万个
    // 已加载方块，期间占住事件循环——一条日志都没有，模型看到的就是"给了
    // action_id 之后彻底静默"，只能靠 Stop（Feedback #16 原话）。
    // 先报一句，它至少知道是在搜、而不是卡死。
    log(bot, `Searching for ${blockType} within ${range} blocks...`);
    if (bot.interrupt_code) {
        log(bot, `Search interrupted before scanning ${blockType} (Stop/保命打断).`);
        return false;
    }
    let block: any;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks: any[] = world.getNearestBlocksWhere(bot, (block: any) => block.name === blockType && block.metadata === 0, range, 1);
        if (bot.interrupt_code) {
            log(bot, `Search interrupted while looking for ${blockType} (Stop/保命打断).`);
            return false;
        }
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, (b: any) => b.name === blockType, range, 1);
            if (bot.interrupt_code) {
                log(bot, `Search interrupted while looking for flowing ${blockType} (Stop/保命打断).`);
                return false;
            }
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
        if (bot.interrupt_code) {
            log(bot, `Search interrupted before navigation (Stop/保命打断).`);
            return false;
        }
    }
    if (!block) {
        // 找不到也要**给结论**——模型明确要求过：不管找没找到都要有回执，
        // "别让调用方只能靠猜"（Feedback #16：长距离搜索什么都不报，它只能 Stop）。
        log(bot, `Could not find any ${blockType} in ${range} blocks.（搜完了，范围内确实没有）`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    // **精确寻路到"够得着这个方块"的位置**，而不是"距它 4 格就算到"。
    //
    // 以前这里是 `goToPosition(..., min_distance)`，而 `searchForBlock` 传的
    // `min_distance` 是 **4**——这个 4 是 TS 迁移时从上游原样搬来的，没有任何
    // 设计理由（`git log -S` 只追到那次搬运）。于是寻路器只要进了"以目标为球心、
    // 半径 4 的球"就停下，并报 `You have reached`。真机上它在 (-34.5,50,-13.5)、
    // 目标 (-33,53,-13) 在头顶上方 3 格，直线 3.4 格 ≤ 5（4+1）就算到达——模型
    // 于是以为自己站到了方块旁边（Feedback #7）。
    //
    // `GoalGetToBlock` 的语义正是"站到能接触这个方块的位置"（相邻可站立格），
    // 它到达时人就在旁边，不需要再用一句"已到达"去圆。**真走不到就如实说走不到**，
    // 比假成功有用：模型还能改用 mineBlock（它的够得着阈值是 4.5 格）。
    const arrived = await goToBlockFace(bot, block.position);
    // **把结果如实返回**：原来无条件 return true;，路径不可达时工具照样报成功——
    // 模型反馈过"找不到目标时静默"，其实不是找不到，是找到了但走不过去，结果被吞了。
    if (!arrived) {
        if (bot.interrupt_code) {
            log(bot, `Found ${block.name} at ${block.position} but navigation was interrupted (Stop/保命打断).`);
        } else {
            log(bot, `Found ${block.name} at ${block.position} but could not reach it (path blocked or too far).`);
        }
    }
    return arrived;
}

export async function goToNearestEntity(bot: any, entityType: string, min_distance: number = 2, range: number = 64): Promise<boolean> {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    const entity: any = world.getNearestEntityWhere(bot, (entity: any) => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    const distance: number = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    const arrived = await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    // **把结果如实返回**：原来无条件 return true;，路径不可达时工具照样报成功——
    // 模型反馈过"找不到目标时静默"，其实不是找不到，是找到了但走不过去，结果被吞了。
    if (!arrived) log(bot, `Found ${entity.name} at ${entity.position} but could not reach it (path blocked or too far).`);
    return arrived;
}

export async function goToPlayer(bot: any, username: string, distance: number = 3): Promise<boolean | undefined> {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (settings.cheat) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    const player: any = bot.players[username].entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal: any = new (pf as any).goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot: any, username: string, distance: number = 4): Promise<boolean> {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    const player: any = bot.players[username].entity;
    if (!player)
        return false;

    const move: any = movementsFor(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval: ReturnType<typeof setInterval> | null = startDoorInterval(bot);

    bot.pathfinder.setGoal(new (pf as any).goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // with cheat enabled, if the distance is too far, teleport to the player
        const distance_from_player: number = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && settings.cheat) {
            // teleport with cheat enabled
            await goToPlayer(bot, username);
        }

        if (distance_from_player <= nearby_distance) {
            if (doorCheckInterval) clearInterval(doorCheckInterval);
            doorCheckInterval = null;
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
        }
    }
    if (doorCheckInterval) clearInterval(doorCheckInterval);
    return true;
}


/**
 * 安全逃跑：先选一个避开 lava/水/落差、有实心支撑的落点，再走。
 *
 * Feedback #60：旧 moveAway 用 GoalInvert 盲目远离当前位置，直接走进岩浆。
 * 找不到安全落点时不再硬走，改用 pillarUp 向上垫一格争取空间。
 */
async function moveAwaySafely(
    bot: any,
    awayFrom: { x: number; y: number; z: number } | null,
    distance: number,
    label: string,
): Promise<boolean> {
    const pos: any = bot.entity.position;
    const from = { x: pos.x, y: pos.y, z: pos.z };
    const blockAt = (x: number, y: number, z: number): { name?: unknown } | null => bot.blockAt(new Vec3(x, y, z));
    const choice = chooseSafeFleeTarget(blockAt, from, awayFrom, distance);
    if (!choice.ok) {
        log(bot, label + ' 找不到安全落点：' + choice.reason + '；不再硬走，改用 pillarUp 向上争取空间。');
        const climbed = await pillarUp(bot, 1);
        log(bot, climbed ? label + ' 已向上垫一格，请下一轮重新评估逃跑方向。' : label + ' 向上也失败，留在原地等安全时机。');
        return climbed;
    }
    log(bot, label + ' 选到安全落点 @(' + choice.target.x + ',' + choice.target.y + ',' + choice.target.z + ')（' + choice.reason + '）。');
    const moved = await goToPosition(bot, choice.target.x, choice.target.y, choice.target.z, 0);
    const check = assessStandingSpot(blockAt, choice.target.x, choice.target.y, choice.target.z);
    if (!moved || !check.ok) {
        log(bot, label + ' 到达/落点校验失败：' + (check.ok ? '路径没走通' : check.reason) + '；停在当前可控位置。');
        return false;
    }
    const newPos: any = bot.entity.position;
    log(bot, label + ' 安全到达 @(' + newPos.x.toFixed(1) + ',' + newPos.y.toFixed(1) + ',' + newPos.z.toFixed(1) + ')。');
    return true;
}

export async function moveAway(bot: any, distance: number): Promise<boolean> {
    return await moveAwaySafely(bot, null, distance, 'moveAway');
}

export async function moveAwayFromEntity(bot: any, entity: any, distance: number = 16): Promise<boolean> {
    const target = entity?.position ?? null;
    const awayFrom =
        target != null && typeof target.x === 'number' && typeof target.y === 'number' && typeof target.z === 'number'
            ? { x: target.x, y: target.y, z: target.z }
            : null;
    return await moveAwaySafely(bot, awayFrom, distance, 'moveAwayFromEntity');
}

export async function avoidEnemies(bot: any, distance: number = 16): Promise<boolean> {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    let enemy: any = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), distance);
    while (enemy) {
        const follow: any = new (pf as any).goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal: any = new (pf as any).goals.GoalInvert(follow);
        bot.pathfinder.setMovements(movementsFor(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot: any, seconds: number = 30): Promise<boolean> {
    /**
     * Stay in the current position until interrupted.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    const start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot: any, door_pos: any = null): Promise<boolean> {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    // Vec3-like position (mineflayer untyped) — `any`; may be null to auto-find.
    if (!door_pos) {
        for (const door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            const found: any = world.getNearestBlock(bot, door_type, 16);
            door_pos = found ? found.position : null;
            if (door_pos) break;
        }
    } else {
        door_pos = (Vec3 as any)(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new (pf as any).goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        if (bot.interrupt_code) {
            bot.pathfinder.stop();
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const door_block: any = bot.blockAt(door_pos);
    await bot.lookAt(door_pos, true);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);

    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot: any): Promise<boolean> {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    // 床在**下界和末地都会炸**（末地那个能一下把人秒了）。主世界睡觉不拦
    // —— op 的 when() 只在会炸的维度才判危险。
    if (!allowDangerousOp(bot, 'sleep_in_bed')) return false;

    const beds: any[] = bot.findBlocks({
        matching: (block: any) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    const loc: any = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed: any = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot: any, x: number, y: number, z: number, seedType: string | null = null): Promise<boolean> {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    const pos: any = new (Vec3 as any)(Math.floor(x), Math.floor(y), Math.floor(z));
    const block: any = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (settings.cheat) {
        const to_remove: string[] = ['_seed', '_seeds'];
        for (const remove of to_remove) {
            // Non-null assertion: original code assumes a seed name in cheat mode.
            if ((seedType as string).endsWith(remove)) {
                seedType = (seedType as string).replace(remove, '');
            }
        }
        await placeBlock(bot, 'farmland', x, y, z);
        await placeBlock(bot, seedType as string, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    const above: any = bot.blockAt(new (Vec3 as any)(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        const broken: boolean = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        const bpos: any = block.position;
        bot.pathfinder.setMovements(movementsFor(bot));
        await goToGoal(bot, new (pf as any).goals.GoalNear(bpos.x, bpos.y, bpos.z, 4));
    }
    if (block.name !== 'farmland') {
        const hoe: any = bot.inventory.items().find((item: any) => item.name.includes('hoe'));
        const to_equip: string = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }

    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        const equipped_seeds: boolean = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot: any, type: string): Promise<boolean> {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    const block: any = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        const pos: any = block.position;
        bot.pathfinder.setMovements(movementsFor(bot));
        await goToGoal(bot, new (pf as any).goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot: any, id: string | number): Promise<any> {
    id = id+"";
    const entity: any = bot.entities[id];

    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        const entities: any[] = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (const entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession: string = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }

    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }

    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }

    const distance: number = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            const goal: any = new (pf as any).goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);


            log(bot, 'Successfully reached villager');
        } catch (err: unknown) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        }
    }

    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot: any, id: string | number): Promise<boolean> {
    const villagerEntity: any = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }

    try {
        const villager: any = await bot.openVillager(villagerEntity);

        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }

        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade: string, i: number) => {
            const tradeInfo: string = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });

        villager.close();
        return true;
    } catch (err: unknown) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        const msg: string = err instanceof Error ? err.message : String(err);
        console.log('Villager trading error:', msg);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot: any, id: string | number, index: string | number, count: string | number): Promise<boolean> {
    const villagerEntity: any = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }

    try {
        const villager: any = await bot.openVillager(villagerEntity);

        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }

        const tradeIndex: number = parseInt(String(index)) - 1; // Convert to 0-based index
        const trade: any = villager.trades[tradeIndex];

        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }

        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2: string = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);

        const maxPossibleTrades: number = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount: number = Number(count);
        const actualCount: number = Math.min(requestedCount, maxPossibleTrades);

        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }

        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }

        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);

        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr: unknown) {
            log(bot, 'An error occurred while trying to execute the trade');
            const msg: string = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
            console.log('Trade execution error:', msg);
            villager.close();
            return false;
        }
    } catch (err: unknown) {
        log(bot, 'Failed to open villager trading interface');
        const msg: string = err instanceof Error ? err.message : String(err);
        console.log('Villager interface error:', msg);
        return false;
    }
}

function hasResources(window: any, trade: any, count: number): boolean {
    const first: boolean = enough(trade.inputItem1, count);
    const second: boolean = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item: any, count: number): boolean {
        let c = 0;
        (window as any[]).forEach((element: any) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot: any, trades: any[]): string[] {
    return trades.map((trade: any) => {
        let text: string = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot: any, item: any): string {
    if (!item) return 'nothing';
    let text: string = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench: any = item.nbt.value.ench;
        const StoredEnchantments: any = item.nbt.value.StoredEnchantments;
        const Potion: any = item.nbt.value.Potion;
        const display: any = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e: any) => {
                const lvl: any = e.lvl.value;
                const id: any = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

/**
 * `mineBlock` 的承重块判据：目标是"你正站着的那一格 / 支撑你的那一格"吗？
 *
 * 为什么必须有：D2 放行徒手挖软方块之后，`mineBlock` 也能挖**自己脚下**了——
 * 脚下是 netherrack、再下面就是岩浆海时，这一挖就是自杀。承重块的保护原本
 * 只写在 `assessPlaceBlockRisk`（placeBlock 用），挖的路径上没有任何检查。
 * 对抗验证给了可复现反例：站在 netherrack 上、下面就是岩浆、空手 →
 * 旧代码拒绝，新代码 `dug=true`。
 *
 * ⚠️ 只拦"正下方"两格（脚那一格 + 它下面一格）。**往前/往侧挖照旧放行**——
 * D2 的逃生场景挖的是前方的方块，不能被这条规则挡回去。想往下走请用 `digDown`：
 * 它自带 `classifyDigDownStep` 的岩浆/落差检查。
 */
export function isFootingBlock(
    feet: { x?: unknown; y?: unknown; z?: unknown } | null | undefined,
    target: { x?: unknown; y?: unknown; z?: unknown } | null | undefined,
): boolean {
    const fx = Math.floor(Number(feet?.x));
    const fy = Math.floor(Number(feet?.y));
    const fz = Math.floor(Number(feet?.z));
    const tx = Math.floor(Number(target?.x));
    const ty = Math.floor(Number(target?.y));
    const tz = Math.floor(Number(target?.z));
    if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(fz)) return false;
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) return false;
    return tx === fx && tz === fz && (ty === fy || ty === fy - 1);
}

export async function mineBlockAt(bot: any, x: number, y: number, z: number): Promise<boolean> {
    /**
     * 挖掉**指定坐标**的那一格。
     *
     * 为什么需要：`collectBlock` 是"自己找最近的并挖"（中层），`digDown` 只会往下。
     * 模型真机报过这个硬缺口："我在 100 格深的洞里**没有挖掉头顶方块的工具**，
     * 所以搭不了落脚点"——它要的是"挖我指定的那一格"这个原语。
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, y, z, 目标方块坐标。
     * @returns {Promise<boolean>} 挖掉了返回 true。
     **/
    // **入口探针**（Lead 2026-10-21：`eb29ade` 后 `mine-progress` 全仓为 0——必须先确定工具
    // 到底有没有进到这里、以及每次调用是"工具在跑 27 秒"还是"模型两轮之间隔了 27 秒"）。
    // 无条件写：即使下面 early-return（空气/够不着/承重方块）也能在回执里看见这一行。
    log(bot, 'mine-block-entry{' + JSON.stringify({ x, y, z }) + '}');
    const target: any = bot.blockAt(new Vec3(x, y, z));
    if (!target) {
        log(bot, `(${x},${y},${z}) 读不到方块。`);
        return false;
    }
    if (target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air') {
        log(bot, `(${x},${y},${z}) 是空气，不用挖。`);
        return false;
    }
    // **别挖自己的立足点。** 徒手挖软方块放行之后（D2），软方块正好是脚下那格时
    // 会连人带方块一起掉下去——下界岩下面常常就是岩浆海。往前往侧挖不受影响。
    if (isFootingBlock(bot?.entity?.position, target.position)) {
        log(
            bot,
            `不挖 ${target.name} @(${x},${y},${z})：**这是你脚下的承重方块**，拆了会掉下去（下面可能是岩浆或深井）。` +
                '要往下走用 digDown（它自带岩浆/落差检查）；只想换位置就先挪到旁边一格再挖。',
        );
        return false;
    }
    const dist: number = bot.entity.position.distanceTo(target.position);
    if (dist > 4.5) {
        log(bot, `${target.name} @(${x},${y},${z}) 离你 ${dist.toFixed(1)} 格，够不着（最多 4.5）。先走过去，或者用 placeBlock 搭个脚点。`);
        return false;
    }
    try {
        // 尽力换上合适的工具；换不上也让 dig 自己试（原版手也能挖土/木）。
        try { await bot.tool?.equipForBlock?.(target); } catch { /* best-effort */ }
        // 工具不够别急着拒绝：**挖穿不等于有掉落**。下界岩/沙/沙砾这类软方块
        // 徒手也能挖开，只是慢且不掉落；无镐的机器人被封在实心方块里时，
        // 这是唯一能自己走出来的路（Feedback #38/#43：寻路器报
        // `Cannot break netherrack with current tools`，mineBlock 又拒绝，
        // 于是永久卡死）。硬方块（石头/深板岩/黑曜石）仍旧明确拒绝，不白等超时。
        const heldId: number | null = typeof bot?.heldItem?.type === 'number' ? bot.heldItem.type : null;
        const heldName = bot?.heldItem?.name ?? '空手';
        if (
            bot?.game?.gameMode !== 'creative' &&
            typeof target.canHarvest === 'function' &&
            !target.canHarvest(heldId)
        ) {
            if (!isHandMineable(target)) {
                log(bot, '没有能挖 ' + target.name + ' 的工具（手持 ' + heldName + '）；先换镐/正确工具再来。');
                return false;
            }
            log(
                bot,
                '没有能挖 ' + target.name + ' 的工具（手持 ' + heldName + '）；它硬度低，改用**空手挖**' +
                    '（比用镐慢，而且可能不掉落；先挖开走出去，工具以后再补）。',
            );
        }
        // **同一个入口**：mineBlock 以前是裸的 await bot.dig()，8 秒超时没覆盖到它
        // （模型真机报"mineBlock 挖黑曜石空回执×2 + 卡死 280 秒"，而其他 17 格全正常）。
        // **长动作进度 + 硬上限**（Lead 2026-10-21：mineBlock 117 秒无进度）。
        const mineStartedAt = Date.now();
        let mineLastProgressAt = 0;
        if (shouldEmitProgress(mineLastProgressAt, Date.now())) {
            mineLastProgressAt = Date.now();
            log(bot, 'mine-progress{' + JSON.stringify({ block: target.name, x, y, z, elapsedMs: 0 }) + '} ' + formatProgressLine({ label: '挖方块 ', done: 0, total: 1, elapsedMs: 0 }));
            recordActionProgress(bot, { label: '挖方块', done: 0, total: 1 });
        }
        if (Date.now() - mineStartedAt >= LONG_ACTION_MAX_MS) {
            log(bot, formatTimeoutSummary({ label: '挖方块', done: 0, total: 1, elapsedMs: Date.now() - mineStartedAt, remaining: 1 }));
            return false;
        }
        if (!(await digWithTimeout(bot, target, `@(${x},${y},${z})`))) return false;
        log(bot, `挖掉了 ${target.name} @(${x},${y},${z})。`);
        return true;
    } catch (err: unknown) {
        log(bot, `挖 ${target.name} @(${x},${y},${z}) 失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/**
 * digDown 单步的判据结果。
 *
 * 抽成纯函数是为了能单测「水/岩浆/落差会不会提前停」——以前这些判定散在
 * 循环里，只能靠真机撞事故。
 */
export type DigStepVerdict =
    | { kind: 'stop'; reason: string }
    | { kind: 'skip_air'; target: { x: number; y: number; z: number } }
    | { kind: 'dig'; target: { x: number; y: number; z: number } };

const DIG_HAZARD_NAMES = new Set(['water', 'lava']);
const DIG_AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/** 连续挖下去最多容忍几格空气；达到这个数就按「落差 >=4」提前停。 */
export const MAX_DIG_FALL_BLOCKS = 4;

function isDigHazard(name: string | undefined | null): boolean {
    return name != null && DIG_HAZARD_NAMES.has(name);
}

/**
 * 判断 digDown 第 depth 格（depth=1 就是正下方那一格）能不能挖。
 *
 * 每轮都必须同时看：机器人当前所在方块、头顶、正下方、目标格、目标格
 * 下方。只查目标格会漏掉「脚下/身侧其实已经进水」「挖穿后会掉进岩浆或深井」
 * 这些真实停不下来的场景。
 */
export function classifyDigDownStep(
    blockAt: (x: number, y: number, z: number) => { name?: string } | null,
    feet: { x: number; y: number; z: number },
    depth: number,
): DigStepVerdict {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const nameAt = (x: number, y: number, z: number): string | null => blockAt(x, y, z)?.name ?? null;

    const atFeet = nameAt(fx, fy, fz);
    if (isDigHazard(atFeet)) return { kind: 'stop', reason: 'current block is ' + String(atFeet) };
    const atHead = nameAt(fx, fy + 1, fz);
    if (isDigHazard(atHead)) return { kind: 'stop', reason: 'head is in ' + String(atHead) };

    const targetY = fy - depth;
    const target = blockAt(fx, targetY, fz);
    if (!target) return { kind: 'stop', reason: 'reached the end of the world' };
    // 目标格是水/岩浆要先报：不能在下方读不到时伪装成 end of world。
    if (isDigHazard(target.name)) return { kind: 'stop', reason: 'reached ' + String(target.name) + ' (not digging into it)' };

    const below = blockAt(fx, targetY - 1, fz);
    if (!below) return { kind: 'stop', reason: 'reached the end of the world' };
    if (isDigHazard(below.name)) return { kind: 'stop', reason: String(below.name) + ' is directly below the target' };

    // 连续空气 = 挖掉目标后会往下掉的落差。达到 4 格就停，绝不冒险。
    let fall = 0;
    let probeY = targetY - 1;
    let probe: { name?: string } | null = below;
    while (probe != null && DIG_AIR_NAMES.has(probe.name ?? '') && fall < MAX_DIG_FALL_BLOCKS) {
        fall++;
        probeY--;
        probe = blockAt(fx, probeY, fz);
    }
    if (fall >= MAX_DIG_FALL_BLOCKS) {
        return { kind: 'stop', reason: 'a drop of ' + String(fall) + '+ blocks below the target' };
    }

    if (DIG_AIR_NAMES.has(target.name ?? '')) {
        return { kind: 'skip_air', target: { x: fx, y: targetY, z: fz } };
    }
    return { kind: 'dig', target: { x: fx, y: targetY, z: fz } };
}

/** 垂直上行单步判据。 */
export type VerticalStepPlan =
    | { kind: 'mine'; target: { x: number; y: number; z: number } }
    | { kind: 'step_forward'; target: { x: number; y: number; z: number } }
    | { kind: 'place_step'; target: { x: number; y: number; z: number } }
    | { kind: 'jump_place' }
    | { kind: 'blocked'; reason: string };

const VERTICAL_PASSABLE = new Set(['air', 'cave_air', 'void_air']);
const VERTICAL_HAZARD = new Set(['water', 'lava']);

function verticalName(block: { name?: unknown } | null | undefined): string | null {
    return typeof block?.name === 'string' ? block.name : null;
}

function isVerticalPassable(name: string | null): boolean {
    return name != null && VERTICAL_PASSABLE.has(name);
}

function verticalHazard(name: string | null): boolean {
    return name != null && VERTICAL_HAZARD.has(name);
}

/**
 * 在背包里挑一个能垫脚的方块。
 *
 * 优先圆石/石头/泥土/木板/原木；排除火把、水桶、岩浆桶、食物/工具这类
 * 放不下或放了没用的东西。
 *
 * **按数量选，不按名字的固定顺序选。** 真机 Feedback #39：模型有 100 块
 * 深板岩，却被派去用只剩 2 块的橡木木板，垫到第 2 格就断供。现在：
 * 多个堆先合并计数 → 材料要能放下（真方块、不是火把/铁轨这类）→
 * 优先"够这次步数"的材料里最多的那个；都不够才退而选最多的并标 shortfall。
 */
export interface PillarMaterialChoice {
    name: string;
    /** 背包里这个物品的总数（多个堆已合并）。 */
    count: number;
    /** 这次要垫几格。 */
    needed: number;
    /** true = 数量不够 needed，最多只够垫 count 格。 */
    shortfall: boolean;
}

/** 垫脚材料的黑名单（放了没用/根本放不下/是食物和工具）。 */
const SCAFFOLD_BLOCKED_WORDS = [
    'torch', 'water', 'lava', 'bucket', 'sapling', 'seed', 'potion', 'sword', 'pickaxe', 'axe',
    'shovel', 'hoe', 'bread', 'apple', 'carrot', 'potato', 'beef', 'porkchop', 'chicken', 'mutton',
    'cod', 'salmon', 'cookie', 'cake', 'stew', 'wheat', 'sugar_cane', 'vine', 'kelp', 'seagrass',
    'lily_pad', 'rail', 'string', 'flower', 'grass', 'fern', 'dead_bush', 'button', 'lever', 'door',
    'bed', 'sign', 'banner', 'redstone', 'repeater', 'comparator', 'tripwire', 'carpet', 'egg', 'bowl',
];

/** 同数量时的偏好顺序（决定并列谁先）。 */
const SCAFFOLD_PREFERRED = [
    'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'dirt', 'coarse_dirt', 'netherrack',
    'andesite', 'granite', 'diorite', 'tuff', 'basalt', 'blackstone', 'sandstone', 'end_stone',
    'nether_bricks', 'oak_planks', 'spruce_planks', 'birch_planks', 'oak_log', 'spruce_log', 'birch_log',
];

interface BlockDefLike {
    boundingBox?: unknown;
}

/**
 * 能不能当垫脚整块放下去。
 * `blockDefs`（bot.registry.blocksByName）优先——它带 boundingBox，能把
 * 火把/小麦/铁轨这种"名字是方块但放不成整块"的排掉。读不到注册表时退化成
 * 黑名单 + mcData 方块表。
 */
function isScaffoldBlock(name: string, blockDefs?: Record<string, BlockDefLike> | null): boolean {
    if (SCAFFOLD_BLOCKED_WORDS.some((word) => name.includes(word))) return false;
    if (blockDefs != null) {
        const def = blockDefs[name];
        if (def == null) return false;   // 注册表里没有 = 不是方块（煤/铁锭/燧石…）
        return def.boundingBox == null || def.boundingBox === 'block';
    }
    try {
        // mcdata 没初始化时会抛：这时只能按名字黑名单兜底（返回 true）。
        return mc.getBlockId(name) != null;
    } catch {
        return true;
    }
}

export function choosePillarMaterialChoice(
    items: Array<{ name?: unknown; count?: unknown }> | null | undefined,
    needed: number = 1,
    blockDefs?: Record<string, BlockDefLike> | null,
): PillarMaterialChoice | null {
    const counts = new Map<string, number>();
    for (const item of items ?? []) {
        const name = typeof item?.name === 'string' ? item.name : null;
        if (name == null) continue;
        const count = typeof item?.count === 'number' && item.count > 0 ? item.count : 1;
        counts.set(name, (counts.get(name) ?? 0) + count);
    }
    const wanted = Math.max(1, Math.floor(needed));
    const candidates: PillarMaterialChoice[] = [];
    for (const [name, count] of counts) {
        if (!isScaffoldBlock(name, blockDefs)) continue;
        candidates.push({ name, count, needed: wanted, shortfall: count < wanted });
    }
    if (candidates.length === 0) return null;
    const adequate = candidates.filter((c) => !c.shortfall);
    const pool = adequate.length > 0 ? adequate : candidates;
    const prefIndex = (name: string): number => {
        const i = SCAFFOLD_PREFERRED.indexOf(name);
        return i < 0 ? SCAFFOLD_PREFERRED.length : i;
    };
    pool.sort((a, b) => b.count - a.count || prefIndex(a.name) - prefIndex(b.name) || a.name.localeCompare(b.name));
    return pool[0] ?? null;
}

export function choosePillarMaterial(
    items: Array<{ name?: unknown; count?: unknown }> | null | undefined,
    needed: number = 1,
    blockDefs?: Record<string, BlockDefLike> | null,
): string | null {
    return choosePillarMaterialChoice(items, needed, blockDefs)?.name ?? null;
}

/** 柱子上行一步：先保证头顶两格是空的；否则先挖；水/岩浆直接 blocked。 */
export function planPillarStep(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
): VerticalStepPlan {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const head = blockAt(fx, fy + 1, fz);
    const head2 = blockAt(fx, fy + 2, fz);
    const headName = verticalName(head);
    const head2Name = verticalName(head2);
    if (verticalHazard(headName)) return { kind: 'blocked', reason: '头顶就是' + String(headName) };
    if (verticalHazard(head2Name)) return { kind: 'blocked', reason: '头顶上方是' + String(head2Name) };
    if (!isVerticalPassable(headName)) return { kind: 'mine', target: { x: fx, y: fy + 1, z: fz } };
    if (!isVerticalPassable(head2Name)) return { kind: 'mine', target: { x: fx, y: fy + 2, z: fz } };
    return { kind: 'jump_place' };
}

/** 台阶上行一步：优先挖开正前方/头顶，然后跳上前方实心格；空着就放一块垫脚。 */
export function planStairStep(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
    dx: number,
    dz: number,
): VerticalStepPlan {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const stepX = fx + Math.sign(dx);
    const stepZ = fz + Math.sign(dz);
    const head = blockAt(fx, fy + 1, fz);
    const head2 = blockAt(fx, fy + 2, fz);
    const headName = verticalName(head);
    const head2Name = verticalName(head2);
    if (verticalHazard(headName)) return { kind: 'blocked', reason: '头顶就是' + String(headName) };
    if (verticalHazard(head2Name)) return { kind: 'blocked', reason: '头顶上方是' + String(head2Name) };
    if (!isVerticalPassable(headName)) return { kind: 'mine', target: { x: fx, y: fy + 1, z: fz } };
    // **原地起跳要 3 格净空**：脚、头、头顶。真机（overnight_b 2026-10-18）在
    // 2 格高的通道里反复报 "第 1 格失败：跳不上去"——垫脚方块放好了，但头顶
    // 第 2 格是实心，起跳被天花板削掉高度，跳不上任何台阶。所以先把头顶挖开。
    // 读不到（null）时不预判：宁可跳一次试试，也不要凭缺数据乱挖。
    if (head2Name != null && !isVerticalPassable(head2Name)) {
        return { kind: 'mine', target: { x: fx, y: fy + 2, z: fz } };
    }

    const frontHead = blockAt(stepX, fy + 1, stepZ);
    const frontFeet = blockAt(stepX, fy, stepZ);
    const frontHead2 = blockAt(stepX, fy + 2, stepZ);
    const frontHeadName = verticalName(frontHead);
    const frontFeetName = verticalName(frontFeet);
    const frontHead2Name = verticalName(frontHead2);
    if (verticalHazard(frontHeadName)) return { kind: 'blocked', reason: '前方头顶是' + String(frontHeadName) };
    if (verticalHazard(frontFeetName)) return { kind: 'blocked', reason: '前方脚下是' + String(frontFeetName) };
    if (!isVerticalPassable(frontHeadName)) return { kind: 'mine', target: { x: stepX, y: fy + 1, z: stepZ } };
    // 落点上方那一格也要通：站上去之后人占 fy+1、fy+2 两格。
    if (frontHead2Name != null && !isVerticalPassable(frontHead2Name)) {
        return { kind: 'mine', target: { x: stepX, y: fy + 2, z: stepZ } };
    }
    if (frontFeetName == null) return { kind: 'blocked', reason: '前方区块读不到' };
    if (!isVerticalPassable(frontFeetName)) return { kind: 'step_forward', target: { x: stepX, y: fy, z: stepZ } };
    return { kind: 'place_step', target: { x: stepX, y: fy, z: stepZ } };
}

/**
 * "跳不上去"的原因诊断（stairUp 失败回执用）。
 *
 * 真机（overnight_b 2026-10-18）：2 格高的通道里 stairUp 垫好方块却反复报
 * 「第 1 格失败：跳不上去（前方可能被挡或高度太大）」——它连"是天花板不够高"
 * 都说不出来，模型只能自己猜。这里把三个真实原因分开报：原地头顶第 2 格、
 * 落点上方那一格、前方脚下那一格。
 */
export function describeStairJumpFailure(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
    dx: number,
    dz: number,
): string {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const stepX = fx + Math.sign(dx);
    const stepZ = fz + Math.sign(dz);
    const name = (x: number, y: number, z: number): string | null => verticalName(blockAt(x, y, z));
    const reasons: string[] = [];
    const hereTop = name(fx, fy + 2, fz);
    if (hereTop != null && !isVerticalPassable(hereTop)) {
        reasons.push('你头顶第 2 格是 ' + hereTop + '（原地起跳要 3 格净空，天花板会把跳跃削掉）');
    }
    const frontTop = name(stepX, fy + 2, stepZ);
    if (frontTop != null && !isVerticalPassable(frontTop)) reasons.push('落点上方是 ' + frontTop);
    const frontFeet = name(stepX, fy, stepZ);
    if (frontFeet != null && !isVerticalPassable(frontFeet)) reasons.push('前方脚下是 ' + frontFeet);
    if (reasons.length === 0) reasons.push('前方被挡或落差太大');
    return (
        '跳不上去：' + reasons.join('；') +
        '。先 mineBlock 挖开头顶/落点上方那一格腾出跳跃空间，或用 pillarUp 直着往上垫。'
    );
}

function forwardDelta(yaw: number): { dx: number; dz: number } {
    // 与项目其它地方一致：yaw=0 面朝南(+Z)，90 面朝西(-X)。
    const dx = -Math.round(Math.sin(yaw));
    const dz = Math.round(Math.cos(yaw));
    if (dx === 0 && dz === 0) return { dx: 0, dz: 1 };
    return { dx, dz };
}

/** 柱子上行：跳起后在脚下放块，适合 digDown 挖出的 1x1 竖井。 */
/** 一次调用最多垫/上多少格（再高就是调用方算错了——真机 2026-10-19 出现过 258 格）。 */
export const MAX_VERTICAL_CLIMB_PER_CALL = 64;

/**
 * **跳跃最高点的放置判据**（纯函数，供 pillarUp 用；Lead 2026-10-21）：
 * 旧实现只等 `y > startY+0.4` 就往"原站立格"放 ⇒ 身体 AABB 还在那格里 ⇒ 安全守卫必然拒绝，
 * 于是正常竖井 100% 失败。正确语义：
 * - `apexReached=false` ⇒ 「跳起来但位置没升」（**可执行**原因：头顶被挡），不放；
 * - `apexReached=true` 但放置瞬间仍与身体相交 ⇒ 「目标格 X 与身体重叠」，不放（守卫保留）；
 * - 否则可以放。
 */
export type PillarApexVerdict =
    | { canPlace: true; message: null }
    | { canPlace: false; message: string };

export function pillarApexVerdict(input: {
    apexReached: boolean;
    intersectsAtApex: boolean | null;
    target: { x: number; y: number; z: number };
    bodyY: number;
}): PillarApexVerdict {
    const cell = `${input.target.x},${input.target.y},${input.target.z}`;
    if (!input.apexReached) {
        return {
            canPlace: false,
            message:
                `pillarUp 停止：跳起来但位置没升（现在 y=${input.bodyY.toFixed(1)}，目标格 ${cell} 仍在身体里）——` +
                '头顶多半被挡。先 mineBlock 挖开头顶那一格，再 pillarUp；窄井里也可以改用 stairUp。',
        };
    }
    if (input.intersectsAtApex === true) {
        return {
            canPlace: false,
            message:
                `pillarUp 停止：**要放的格子就是我现在站的位置**（目标格 ${cell}，身体在 y=${input.bodyY.toFixed(1)}` +
                '——feet/head 都在里面），这一次不放；先 mineBlock 挖开头顶那一格，或换位置。',
        };
    }
    return { canPlace: true, message: null };
}

export async function pillarUp(bot: any, blocks: number = 1): Promise<boolean> {
    const pillarStartY = Number(bot?.entity?.position?.y ?? 0);
    const requested = Math.max(1, Math.floor(blocks));
    // **上限**：258 格柱子只花了 20 秒，是因为引擎允许；每一块都来自背包，
    // 而且"要爬这么多"本身就是上游判定出错的信号。超上限就只爬上限，并说清。
    const wanted = Math.min(requested, MAX_VERTICAL_CLIMB_PER_CALL);
    if (requested > wanted) {
        log(bot, `pillarUp：请求 ${requested} 格超过单次上限 ${MAX_VERTICAL_CLIMB_PER_CALL} 格，只垫 ${wanted} 格（要更高请分几次，或先确认目标高度是不是搞错了）。`);
    }
    const choice = choosePillarMaterialChoice(
        bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }>,
        wanted,
        (bot?.registry?.blocksByName ?? null) as Record<string, BlockDefLike> | null,
    );
    if (choice == null) {
        log(bot, 'pillarUp 失败：背包里没有可垫脚的方块（圆石/深板岩/泥土/木板/原木这类整块都行）。');
        return false;
    }
    const material = choice.name;
    // 数量不够就只垫得到的格数：比在第 N 格突然断供、回执还说不清强。
    const target = choice.shortfall ? choice.count : wanted;
    log(
        bot,
        'pillarUp 开始：目标 ' + wanted + ' 格，选了 ' + material +
            '（背包剩 ' + choice.count + ' 个，需要 ' + wanted + ' 个' +
            (choice.shortfall ? '——不够，最多垫 ' + choice.count + ' 格' : '') +
            '），当前 y=' + Number(bot?.entity?.position?.y ?? 0).toFixed(1) + '。',
    );
    if (bot?.interrupt_code) {
        log(bot, 'pillarUp 中断：Stop/保命打断，一步没走。');
        return false;
    }
    if (!(await equip(bot, material))) {
        log(bot, 'pillarUp 失败：拿不到 ' + material + '。');
        return false;
    }
    const deadline = Date.now() + Math.max(30_000, wanted * 8_000);
    let done = 0;
    while (done < target) {
        if (bot.interrupt_code) {
            log(bot, 'pillarUp 中断：Stop/保命打断，已完成 ' + done + '/' + wanted + ' 格。');
            return false;
        }
        if (Date.now() > deadline) {
            log(bot, 'pillarUp 超时：已完成 ' + done + '/' + wanted + ' 格，先停在这里。');
            return false;
        }
        const feet = bot.entity.position;
        const blockAt = (x: number, y: number, z: number): { name?: unknown } | null => bot.blockAt(new Vec3(x, y, z));
        const plan = planPillarStep(blockAt, { x: feet.x, y: feet.y, z: feet.z });
        if (plan.kind === 'blocked') {
            log(bot, 'pillarUp 停止：' + plan.reason + '（已完成 ' + done + '/' + wanted + ' 格）。');
            return false;
        }
        if (plan.kind === 'mine') {
            const dug = await breakBlockAt(bot, plan.target.x, plan.target.y, plan.target.z);
            if (!dug) {
                log(bot, 'pillarUp 停止：挖头顶方块失败（已完成 ' + done + '/' + wanted + ' 格）。');
                return false;
            }
            // **挖了却还是实心 ⇒ 不许原地循环重挖**（真机 A：回执只有 dig 行反复出现，
            // `planPillarStep` 又算出同一个 mine 目标，直到超时——看起来像"往自己脚下放"）。
            const stillThere = verticalName(blockAt(plan.target.x, plan.target.y, plan.target.z));
            if (stillThere != null && !isVerticalPassable(stillThere)) {
                log(
                    bot,
                    'pillarUp 停止：挖了 (' + plan.target.x + ',' + plan.target.y + ',' + plan.target.z + ') 的 ' +
                        stillThere + '，但那里**仍然是实心**（方块没更新/是挖不动的方块）——不再原地重挖。' +
                        '下一步：换位置重试，或先 mineBlock 那一格确认能挖掉。',
                );
                return false;
            }
            continue;
        }
        const startY = Number(feet.y);
        const startX = Math.floor(feet.x);
        const startZ = Math.floor(feet.z);
        bot.setControlState('jump', true);
        // **在跳跃最高点放块**（Lead 2026-10-21 真机：1×1 竖井里 100% 失败——旧代码只等
        // `y > startY+0.4` 就往"原站立格"放，那时身体 AABB 还没离开那格 ⇒ 安全守卫必然拒绝。
        // 正确做法是等身体**真的清空那一格**（cellIntersectsBody 为 false）或跳到足够高度）。
        const standingCell = { x: startX, y: Math.floor(startY), z: startZ };
        const apexReached = await waitFor(
            bot,
            () =>
                cellIntersectsBody(bot?.entity?.position, standingCell) === false ||
                Number(bot?.entity?.position?.y ?? 0) >= Math.floor(startY) + 1.0,
            1600,
            40,
        );
        let placed = false;
        if (apexReached) {
            // **守卫保留**：放的那一刻再验一次，方块绝不能落在身体里。
            if (cellIntersectsBody(bot?.entity?.position, standingCell) === true) {
                const p = bot.entity.position;
                log(
                    bot,
                    'pillarUp 停止：目标格 ' + standingCell.x + ',' + standingCell.y + ',' + standingCell.z +
                        ' 与身体重叠（身体在 ' + Number(p.x).toFixed(1) + ',' + Number(p.y).toFixed(1) + ',' + Number(p.z).toFixed(1) +
                        '），这一步不放——先 mine 头顶一格再试。',
                );
                bot.setControlState('jump', false);
                return false;
            }
            placed = await placeBlock(bot, material, standingCell.x, standingCell.y, standingCell.z, 'bottom', true);
        } else {
            // 跳了但没升起来：这是**不同**的可执行原因，不是"会窒息"。
            bot.setControlState('jump', false);
            const p = bot.entity.position;
            log(
                bot,
                'pillarUp 停止：跳起来但位置没升（现在 y=' + Number(p.y).toFixed(1) + '，目标格 ' +
                    standingCell.x + ',' + standingCell.y + ',' + standingCell.z + ' 仍在身体里）——' +
                    '头顶多半被挡。先 mineBlock 挖开头顶那一格，再 pillarUp；窄井里也可以改用 stairUp。',
            );
            return false;
        }
        bot.setControlState('jump', false);
        // 放完再验一次：万一位置抖动让方块落进身体，立刻挖掉它（**绝不把方块留在身体里继续垫**）。
        const placedCell = standingCell;
        if (placed && cellIntersectsBody(bot?.entity?.position, placedCell) === true) {
            const rescued = await breakBlockAt(bot, placedCell.x, placedCell.y, placedCell.z);
            log(bot, 'pillarUp 紧急自救：方块落进了身体里，' + (rescued ? '已立刻挖掉' : '**没能挖掉**——先 Stop 再 mineBlock') + '（位置 ' + placedCell.x + ',' + placedCell.y + ',' + placedCell.z + '）。');
            return false;
        }
        if (!placed) {
            log(bot, 'pillarUp 第 ' + (done + 1) + ' 格失败：没能把 ' + material + ' 垫到脚下。');
            return false;
        }
        await waitFor(bot, () => bot?.entity?.onGround === true, 2500, 50);
        done++;
        log(bot, 'pillarUp 进度 ' + done + '/' + wanted + '：现在 y=' + Number(bot.entity.position.y).toFixed(1) + '。');
    }
    if (done >= wanted) {
        // **"完成"=人站在柱子上**，不是"方块放下了"。真机 2026-10-19：报「pillarUp 完成/
        // 已到达」，实际人悬空掉进虚空。所以放完必须确认脚下有东西、且真的站住了。
        let standing = false;
        try {
            await waitFor(bot, () => bot?.entity?.onGround === true, 1500, 50);
            standing = bot?.entity?.onGround === true;
            if (!standing) {
                const p = bot.entity.position;
                const under = bot.blockAt(new (Vec3 as any)(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
                const name = String(under?.name ?? '');
                standing = name !== '' && name !== 'air' && name !== 'cave_air' && name !== 'void_air';
            }
        } catch {
            standing = true; // 读不到不谎报失败
        }
        if (!standing) {
            log(bot, 'pillarUp：垫了 ' + done + ' 格，但**人没有站在柱子上**（脚下仍然没有方块）——不算完成，别往前走。');
            return false;
        }
        // **完成也要由实测高度门控**（Lead 2026-10-21：与 stairUp 同款缺陷——报的是计划不是事实）。
        const pillarEndY = Number(bot?.entity?.position?.y ?? pillarStartY);
        const pillarClimb = Math.round((pillarEndY - pillarStartY) * 10) / 10;
        if (pillarClimb <= 0.4) {
            log(
                bot,
                'pillarUp **没有升上去**：垫了 ' + done + ' 格，y 仍是 ' + pillarEndY.toFixed(1) +
                    '（起点 ' + pillarStartY.toFixed(1) + '）——先 mineBlock 头顶那一格，或检查脚下依附面。',
            );
            return false;
        }
        log(bot, 'pillarUp 完成：实际上升 ' + pillarClimb + ' 格（目标 ' + wanted + '，已确认站在柱子上，现在 y=' + pillarEndY.toFixed(1) + '）。');
        return true;
    }
    log(bot, 'pillarUp 结束：只垫了 ' + done + '/' + wanted + ' 格（背包里的 ' + material + ' 用完了）。');
    return false;
}

/** 台阶上行：挖开前方/头顶，跳上高一层的实心格；空着就放一块垫脚。 */
export async function stairUp(bot: any, blocks: number = 1): Promise<boolean> {
    const requested = Math.max(1, Math.floor(blocks));
    // 同 pillarUp：单次上限（真机出现过 258 格的"上地表"）。
    const wanted = Math.min(requested, MAX_VERTICAL_CLIMB_PER_CALL);
    if (requested > wanted) {
        log(bot, `stairUp：请求 ${requested} 格超过单次上限 ${MAX_VERTICAL_CLIMB_PER_CALL} 格，只上 ${wanted} 格（要更高请分几次，或先确认目标高度是不是搞错了）。`);
    }
    const choice = choosePillarMaterialChoice(
        bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }>,
        wanted,
        (bot?.registry?.blocksByName ?? null) as Record<string, BlockDefLike> | null,
    );
    const material = choice?.name ?? null;
    // 数量不够就只垫得到的格数（同上：别在第 N 格断供）。
    const target = choice != null && choice.shortfall ? choice.count : wanted;
    log(
        bot,
        'stairUp 开始：目标 ' + wanted + ' 格，' + (choice == null
            ? '材质 无（只能挖台阶）'
            : '选了 ' + choice.name + '（背包剩 ' + choice.count + ' 个，需要 ' + wanted + ' 个' +
                (choice.shortfall ? '——不够，最多垫 ' + choice.count + ' 格' : '') + '）') +
            '，当前 y=' + Number(bot?.entity?.position?.y ?? 0).toFixed(1) + '。',
    );
    const deadline = Date.now() + Math.max(30_000, wanted * 8_000);
    let done = 0;
    const stairStartY = Number(bot?.entity?.position?.y ?? 0);
    while (done < target) {
        if (bot.interrupt_code) {
            log(bot, 'stairUp 中断：Stop/保命打断，已完成 ' + done + '/' + wanted + ' 格。');
            return false;
        }
        if (Date.now() > deadline) {
            log(bot, 'stairUp 超时：已完成 ' + done + '/' + wanted + ' 格，先停在这里。');
            return false;
        }
        const feet = bot.entity.position;
        const dir = forwardDelta(Number(bot?.entity?.yaw ?? 0));
        const blockAt = (x: number, y: number, z: number): { name?: unknown } | null => bot.blockAt(new Vec3(x, y, z));
        const plan = planStairStep(blockAt, { x: feet.x, y: feet.y, z: feet.z }, dir.dx, dir.dz);
        if (plan.kind === 'blocked') {
            log(bot, 'stairUp 停止：' + plan.reason + '（已完成 ' + done + '/' + wanted + ' 格）。');
            return false;
        }
        if (plan.kind === 'mine') {
            const dug = await breakBlockAt(bot, plan.target.x, plan.target.y, plan.target.z);
            if (!dug) {
                log(bot, 'stairUp 停止：挖 ' + plan.target.x + ',' + plan.target.y + ',' + plan.target.z + ' 失败（已完成 ' + done + '/' + wanted + ' 格）。');
                return false;
            }
            continue;
        }
        if (plan.kind === 'place_step') {
            if (material == null) {
                log(bot, 'stairUp 停止：前方要垫脚但背包里没有方块。');
                return false;
            }
            const placed = await placeBlock(bot, material, plan.target.x, plan.target.y, plan.target.z, 'bottom', true);
            if (!placed) {
                log(
                    bot,
                    'stairUp：往 (' + plan.target.x + ',' + plan.target.y + ',' + plan.target.z + ') 垫 ' + material +
                        ' 失败（那一格周围没有可依附的实心方块，或已经被占）。改用 pillarUp 在当前位置直着垫高 1 格。',
                );
                // **F-10 第二半：放不下就改成"原地往上垫"。** 真机里 stairUp 在窄通道/
                // 悬空处就是这么卡的（`Cannot place oak_planks at …: nothing to place on`）：
                // 前方没地方放，但脚下那一格通常能跳起来垫 —— 一样的垂直收益，
                // 而且 pillarUp 自己会先把头顶挖开（2 格高通道）。
                const climbed = await pillarUp(bot, 1);
                if (!climbed) {
                    log(bot, 'stairUp 停止：垫脚失败，pillarUp 也没能上升（已完成 ' + done + '/' + wanted + ' 格）。');
                    return false;
                }
                done++;
                log(
                    bot,
                    'stairUp 进度 ' + done + '/' + wanted + '：换 pillarUp 在脚下垫了 1 格，现在 y=' +
                        Number(bot.entity.position.y).toFixed(1) + '。',
                );
                continue;
            }
        }
        // **统一走到移动原语**：不再让寻路器钻进 1×1 的洞（四个工具同一个病）。
        const step = await stepIntoCellClearing(bot, { x: Math.floor(feet.x) + dir.dx, y: Math.floor(feet.y) + 1, z: Math.floor(feet.z) + dir.dz  });
        if (!step.moved) {
            log(bot, 'stairUp 第 ' + (done + 1) + ' 格失败：' + String(step.reason) + (step.cleared.length > 0 ? '（已顺手挖开：' + step.cleared.join('、') + '）' : '') + ' 建议：先 mineBlock 掉头上那一格，再用 pillarUp 原地垫高 1 格。');
            return false;
        }
        done++;
        log(bot, 'stairUp 进度 ' + done + '/' + wanted + '：现在 y=' + Number(bot.entity.position.y).toFixed(1) + '。');
    }
    // **"完成"必须由实测高度门控**（Lead 2026-10-21 真机 A：进度里 y 一直没变，
    // 最后却写「stairUp 完成 / 上升 10 格」——测的是计划不是事实）。
    const stairEndY = Number(bot?.entity?.position?.y ?? stairStartY);
    const measuredClimb = Math.round((stairEndY - stairStartY) * 10) / 10;
    if (done >= wanted && measuredClimb > 0.4) {
        log(bot, 'stairUp 完成：实际上升 ' + measuredClimb + ' 格（目标 ' + wanted + '），现在 y=' + stairEndY.toFixed(1) + '。');
        return true;
    }
    if (done >= wanted && measuredClimb <= 0.4) {
        log(
            bot,
            'stairUp **没有升上去**：y 仍是 ' + stairEndY.toFixed(1) + '（目标 ' + wanted + '，挖了 ' + done +
                ' 格但没走上去）——先确认头顶/脚下空间，用 mineBlock 挖开那一格，或改用 pillarUp。',
        );
        return false;
    }
    log(bot, 'stairUp 结束：只上了 ' + done + '/' + wanted + ' 格（实测 y=' + stairEndY.toFixed(1) + '，没材料也没能挖出台阶）。');
    return false;
}

export async function digDown(bot: any, distance: number = 10): Promise<boolean> {
    // **入口探针**（同上：区分"工具真在跑"与"两次调用之间的间隔"）。
    log(bot, 'dig-down-entry{' + JSON.stringify({ distance }) + '}');
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/
    const blockAt = (x: number, y: number, z: number): { name?: string } | null =>
        bot.blockAt(new Vec3(x, y, z));

    // **长动作进度 + 硬上限**（Lead 2026-10-21：digDown 88 秒零位移、零信息）。
    const digStartedAt = Date.now();
    let digLastProgressAt = 0;
    const digStartY = Number(bot?.entity?.position?.y ?? 0);
    for (let i = 1; i <= distance; i++) {
        // Stop / 保命打断要先于下一铲：不然 ActionManager.stop 只能等 10 秒
        // 再杀进程，整晚反复回出生点。
        if (bot.interrupt_code) {
            log(bot, 'Dug down ' + (i - 1) + ' blocks, but Stop was requested (stopping before digging further).');
            return false;
        }

        // 每一轮都从机器人「现在」的位置重新取列——挖下去会横向漂移，不能
        // 拿起点那一列去检查脚下的岩浆。
        const feet = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
        const verdict = classifyDigDownStep(blockAt, feet, i);

        if (verdict.kind === 'stop') {
            // **停下必须给一个真能成功的下一步**（真机：模型只被告知"停了"，然后原样重试）。
            // 水/岩浆这类挡住竖井的，正确动作是**横向绕开**再继续，而不是原地再挖一次。
            const reason = verdict.reason;
            const blockedByFluid = /water|lava|flowing_|not diggable/i.test(reason);
            const advice = blockedByFluid
                ? '水/岩浆挡在竖井下面，**原地重挖没有用**。绕行方案（按顺序试）：' +
                  '① 先横向走 2-3 格再 digDown（水不会跟着你走）：goToCoordinates 到旁边再挖；' +
                  '② 目标是往下的高度就用 stairUp/digDown 的斜台阶绕开水层；' +
                  '③ 水面上方要下去，先 placeHere 垫一块方块站上去再挖，别直接挖穿含水层。'
                : '';
            log(bot, 'Dug down ' + (i - 1) + ' blocks, but stopped: ' + reason + '.' + (advice ? ' ' + advice : ''));
            return false;
        }
        // 每轮先报进度：`dig-progress{done,total,elapsedMs,fromY,toY}` + 人话（复用统一格式）。
        if (shouldEmitProgress(digLastProgressAt, Date.now())) {
            digLastProgressAt = Date.now();
            const nowY = Number(bot?.entity?.position?.y ?? 0);
            const elapsed = Date.now() - digStartedAt;
            log(bot, 'dig-progress{' + JSON.stringify({ done: i - 1, total: distance, elapsedMs: elapsed, fromY: Math.round(digStartY * 10) / 10, toY: Math.round(nowY * 10) / 10 }) + '} ' + formatProgressLine({ label: '向下挖', done: i - 1, total: distance, elapsedMs: elapsed }));
            recordActionProgress(bot, { label: '向下挖', done: i - 1, total: distance, fromY: digStartY, toY: nowY });
        }
        if (Date.now() - digStartedAt >= LONG_ACTION_MAX_MS) {
            log(bot, formatTimeoutSummary({ label: '向下挖', done: i - 1, total: distance, elapsedMs: Date.now() - digStartedAt, remaining: distance - (i - 1) }));
            return false;
        }
        if (verdict.kind === 'skip_air') {
            log(bot, 'Skipping air block at (' + verdict.target.x + ',' + verdict.target.y + ',' + verdict.target.z + ').');
            continue;
        }

        const dug: boolean = await breakBlockAt(bot, verdict.target.x, verdict.target.y, verdict.target.z);
        if (!dug) {
            log(bot, 'Dug down ' + (i - 1) + ' blocks, failed to dig block at (' + verdict.target.x + ',' + verdict.target.y + ',' + verdict.target.z + ').');
            return false;
        }
        log(bot, 'Dug down ' + i + '/' + distance + ' blocks (broke (' + verdict.target.x + ',' + verdict.target.y + ',' + verdict.target.z + ')).');
        // **挖完必须真的下去**（真机 2026-10-20：「Skipping air block… 挖了 4/80 格」后 GoalChanged）。
        // 这一动作以前完全没有——只挖不走，于是人停在洞口、下一铲继续挖空气。
        const sunkInto = await stepIntoCellClearing(bot, { x: verdict.target.x, y: verdict.target.y, z: verdict.target.z });
        if (!sunkInto.moved) {
            log(bot, 'Dug down ' + (i - 1) + ' blocks 后**下不去**：' + String(sunkInto.reason) + '。');
            log(bot, '建议：先 mineBlock 掉那一格再走；若那是空气/水，改用 goToCoordinates 移到旁边再 digDown，或用 placeHere 垫一块站上去再挖。');
            return false;
        }
    }
    log(bot, 'Dug down ' + distance + ' blocks.');
    return true;
}
/** 地表候选往上最多允许的距离（格）。再高就不是"地表"，是人工结构/脚手架。 */
export const SURFACE_MAX_CLIMB = 64;
/** 判定"有支撑"时，往脚下看多少格要求至少有一个实心块。 */
export const SURFACE_SUPPORT_PROBE = 4;

export interface SurfaceCandidate {
    y: number;
    name: string;
    /** 从这个 y 往脚下看，几格内会遇到实心块（-1 = 一路是空）。 */
    supportWithin: number;
}

export interface SurfaceChoice {
    /** 选中的地表（blockAt 坐标 + 站立高度）。null = 认不出地表。 */
    chosen: { x: number; y: number; z: number; name: string; standY: number } | null;
    reason: string;
    /** 被判为"人工/无支撑"而拒绝的候选（用于回执，最多留几个）。 */
    rejected: Array<{ y: number; name: string; why: string }>;
}

/**
 * 从一列方块里挑出"真正的地表"。
 *
 * 真机 2026-10-19：`goToSurface` 在 (-1.5, 62, -9.5) 把 **y=319 的一块人工方块**
 * 当成地表，于是 `pillarUp` 把 bot 顶上 **y=320**（+258 格）——一个承诺"回到地表"
 * 的工具把 bot 送上了天，而且垫的每一块都来自它自己的背包。
 *
 * 两条判据：
 *   ① **不许无限爬**：候选比 bot 高出超过 `maxClimb` ⇒ 不是地表（人工结构/脚手架），
 *      继续往下找**够得着**的那个；
 *   ② **要看着像地面**：往脚下探 `SURFACE_SUPPORT_PROBE` 格，有实心块才算"有支撑"；
 *      悬空孤块不算地表（记进 rejected，回执里说明）。
 * 找不到合格候选 ⇒ `chosen = null`，调用方**如实报"认不出地表"**，不做任何攀爬。
 */
export function chooseSurfaceCandidate(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
    options: { maxClimb?: number; supportProbe?: number; topY?: number; bottomY?: number } = {},
): SurfaceChoice {
    const maxClimb = Math.max(0, Number(options.maxClimb ?? SURFACE_MAX_CLIMB) || 0);
    const probe = Math.max(1, Math.floor(Number(options.supportProbe ?? SURFACE_SUPPORT_PROBE) || 1));
    const topY = Math.floor(Number(options.topY ?? 360));
    const bottomY = Math.floor(Number(options.bottomY ?? -64));
    const fx = Math.floor(feet.x);
    const fz = Math.floor(feet.z);
    const fy = Math.floor(feet.y);
    const rejected: SurfaceChoice['rejected'] = [];
    /**
     * 正在跳过一整座"太高的人工结构"。
     *
     * 只跳过"太高的那一格"是不够的：一座 62 格高的实心塔，其**内部**每一格都满足
     * "有支撑 + 高差 ≤ 上限"，于是工具会挑到塔身中间（y=126 这种）——那不是地表，
     * 是站在别人脚手架上。所以一旦发现结构顶端超过上限，就把它**整座跳完**
     * （连续实心都算同一座），到它脚下再继续找真正的地面。
     */
    let skippingStructure = false;

    for (let y = topY; y > bottomY; y--) {
        const block = blockAt(fx, y, fz);
        const name = typeof block?.name === 'string' ? block.name : '';
        const solid = name !== '' && name !== 'air' && name !== 'cave_air' && name !== 'void_air';
        if (!solid) {
            skippingStructure = false;
            continue;
        }
        if (skippingStructure) continue; // 同一座结构的下面部分，一起跳过
        const standY = y + 1;
        const climb = standY - feet.y;
        // ① 够不着的（太高）先跳过，但要留一句解释——真机那次就是栽在这里。
        // 注意：**只限制记录条数，绝不停止扫描**（一条 100 格高的人工塔会有几十个
        // 被拒的候选；早期版本在这里 break，等于一见高楼就放弃找真正的地面）。
        if (climb > maxClimb) {
            if (rejected.length < 4) {
                rejected.push({ y: standY, name, why: `比你现在高 ${climb.toFixed(0)} 格，超过上限 ${maxClimb}——像是人工方块/脚手架，不当成地表` });
            }
            skippingStructure = true;
            continue;
        }
        // ② 悬空孤块不算地表：往脚下探几格，得有实心支撑。
        let supportWithin = -1;
        for (let d = 1; d <= probe; d++) {
            const under = blockAt(fx, y - d, fz);
            const underName = typeof under?.name === 'string' ? under.name : '';
            const solid = underName !== '' && underName !== 'air' && underName !== 'cave_air' && underName !== 'void_air';
            if (solid) {
                supportWithin = d;
                break;
            }
        }
        if (supportWithin < 0) {
            if (rejected.length < 4) {
                rejected.push({ y: standY, name, why: `脚下 ${probe} 格内没有支撑，是悬空的孤立方块` });
            }
            continue;
        }
        return {
            chosen: { x: fx, y, z: fz, name, standY },
            reason: `地表在 y=${standY}（${name}），高差 ${climb >= 0 ? '+' : ''}${climb.toFixed(0)} 格（脚下 ${supportWithin} 格内有支撑）`,
            rejected,
        };
    }
    return {
        chosen: null,
        reason:
            rejected.length > 0
                ? `认不出地表：只找到 ${rejected.map((r) => `y=${r.y}（${r.why}）`).join('；')}`
                : '认不出地表：当前竖列没有读到任何实心方块（区块可能没加载）',
        rejected,
    };
}

export async function goToSurface(bot: any): Promise<boolean> {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos: any = bot.entity.position;
    // **"地表"必须是够得着、且看着像地面的那一格**（见 chooseSurfaceCandidate）：
    // 真机 2026-10-19 这里曾把 y=319 的人工方块当地表，pillarUp 把 bot 顶到 y=320。
    const choice = chooseSurfaceCandidate(
        (bx, by, bz) => bot.blockAt(new (Vec3 as any)(bx, by, bz)),
        { x: pos.x, y: pos.y, z: pos.z },
    );
    if (choice.chosen == null) {
        log(bot, 'goToSurface 失败：' + choice.reason + '。没有做任何攀爬（不会把你往上垫）。');
        return false;
    }
    const block = { name: choice.chosen.name, position: { x: choice.chosen.x, y: choice.chosen.y, z: choice.chosen.z } };
    const targetY: number = choice.chosen.standY;
    const dy: number = targetY - pos.y;
    log(bot, 'goToSurface：' + choice.reason + '。');
    for (const rej of choice.rejected) {
        log(bot, 'goToSurface：y=' + rej.y + ' 那格上面没有当成地表——' + rej.why + '。');
    }
    if (bot.interrupt_code) {
        log(bot, 'goToSurface 中断：Stop/保命打断，一步没走。');
        return false;
    }
    if (dy >= 4) {
        // **再加上限**：即使判定通过，一次也不许垫超过 `SURFACE_MAX_CLIMB` 格
        // （每一块都来自背包，而且"爬 258 格"本身就是判定出错的信号）。
        const need = Math.min(Math.ceil(dy), SURFACE_MAX_CLIMB);
        const material = choosePillarMaterial(bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }>);
        log(bot, 'goToSurface：高差 ' + dy.toFixed(1) + ' 格，先用 ' + (material != null ? 'pillarUp' : 'stairUp') + ' 垂直上行 ' + need + ' 格（上限 ' + SURFACE_MAX_CLIMB + '）。');
        const climbed = material != null ? await pillarUp(bot, need) : await stairUp(bot, need);
        if (bot.interrupt_code) {
            log(bot, 'goToSurface 中断：垂直上行被 Stop/保命打断。');
            return false;
        }
        if (!climbed) {
            log(bot, 'goToSurface：垂直上行没能完成，继续尝试普通寻路（失败会说明卡在哪）。');
        }
    }
    const arrived = await goToPosition(bot, block.position.x, targetY, block.position.z, 0);
    if (!arrived) {
        log(
            bot,
            'Surface is at y=' + targetY + ' (' + block.name + ') but I could not get up there from here. 竖井/洞穴里常这样——用 stairUp/pillarUp 垂直上行，或者 mineBlock 挖头顶开路。',
        );
        return false;
    }
    log(bot, 'Reached the surface at y=' + targetY + '.');
    return true;
}
export async function useToolOn(bot: any, toolName: string, targetName: string): Promise<boolean> {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    // NOTE: `!bot.game.gameMode === 'creative'` is preserved verbatim from the JS
    // original (it evaluates `(!gameMode) === 'creative'`, always false); the cast
    // only silences TS2367 without changing runtime behavior.
    // **手上没有这个东西要立刻说。** 原来这里还挂了一个 `(!gameMode) === 'creative'`
    // 的条件——那是 `(!undefined) === 'creative'` 即 `true === 'creative'`，**恒为
    // false**，于是这个分支从来没进过。结果：模型没带桶却去装水，一条回执都没有
    // （"既不说成功也不说失败"，它因此白试了两次）。
    const hasItem: boolean = toolName === 'hand' ||
        ((bot.inventory?.slots ?? []) as Array<{ name?: string }>).some((slot) => slot?.name === toolName);
    if (!hasItem && bot.game?.gameMode !== 'creative') {
        log(bot, `You do not have any ${toolName} to use.（背包里没有这个东西，先拿到手再说）`);
        return false;
    }

    targetName = targetName.toLowerCase();

    // **危险操作闸门必须放在最前**，覆盖全部三个分支。
    // 教训来自真机：模型用 useOn(flint_and_steel, "nothing") 点火，那条走的是
    // `targetName === 'nothing'` 分支，**根本不经过 useToolOnBlock** —— 闸门加在下层
    // 就等于没加，回执直接是 "Equipped flint_and_steel. / Used flint_and_steel."，零拦截。
    if (toolName === 'water_bucket' || toolName === 'lava_bucket') {
        if (!allowDangerousOp(bot, toolName === 'water_bucket' ? 'pour_water' : 'pour_lava')) return false;
    }
    if (toolName === 'flint_and_steel' && !allowDangerousOp(bot, 'ignite')) return false;

    if (targetName === 'nothing') {
        const equipped: boolean = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity: any = world.getNearestEntityWhere(bot, (e: any) => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped: boolean = await equip(bot, toolName);
            if (!equipped) return false;
        }
        // **交互前自动面向目标**：不依赖模型先 turnView；1.2 格内失败很多时候只是没看它。
        await faceTarget(bot, entity.position.offset(0, (typeof entity.height === 'number' ? entity.height : 1.8) / 2, 0), String(targetName));
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block: any;
        if (targetName === 'water' || targetName === 'lava') {
            // **要水源方块**（流动水装不进桶），但**不能因为"够近的那格不是水源"就跑去远处**。
            //
            // 模型真机实测（成功率 1/4）：站在 (43.4,63,1.6)、**脚下 1.6 格就是水**，
            // useOn(bucket,"water") 却跑去 **16 格外的 (27,62,7)** 并失败。原因是这里只认
            // `metadata === 0` 的方块，近处那格没被匹配上，就一路找到远处去了。
            //
            // 改成：**近处的任何水/岩浆优先**（桶能不能装由服务端说了算，失败了下面会
            // 如实报），只有近处完全没有时才去找水源方块。
            const anyLiquid: any[] = world.getNearestBlocksWhere(bot, (b: any) => b.name === targetName, 64, 8);
            const source: any = anyLiquid.find((b: any) => b.metadata === 0) ?? null;
            const nearest: any = anyLiquid[0] ?? null;
            if (nearest == null && source == null) {
                log(bot, `Could not find any ${targetName} within 64 blocks.`);
                return false;
            }
            // **桶只认水源方块**——流动水（`metadata !== 0`）在原版里就装不进桶，
            // 用它是注定失败的。以前为了"别跑远"会优先选近处**任意**液体，结果
            // 常选中流动水：回执写着 NOT a source block，却还是对它用了桶，然后
            // 把失败归因成"准星没对准"——模型按这个提示连试 6 次（Feedback 实测）。
            //
            // 所以：**近处有水源就用近处的；近处只有流动水，就明说并去找水源**。
            const nearSource: any =
                source != null && bot.entity.position.distanceTo(source.position) <= 6 ? source : null;
            block = nearSource ?? source ?? nearest;
            const chosenDist: number = bot.entity.position.distanceTo(block.position);
            if (block.metadata !== 0) {
                log(
                    bot,
                    `附近只有流动${targetName === 'water' ? '水' : '岩浆'}（${block.position}，${chosenDist.toFixed(1)} 格）——` +
                        `流动水装不进桶，得找**源头方块**（平静的、不流动的那一格）。` +
                        `64 格内${source == null ? '也没有找到源头方块' : `最近的源头在 ${source.position}`}。`,
                );
            } else {
                log(bot, `Using ${block.name} at ${block.position} (${chosenDist.toFixed(1)} blocks away, source block).`);
            }
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

  export async function useToolOnBlock(bot: any, toolName: string, block: any): Promise<boolean> {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance: number = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    // **够得着就别走**。原来无条件先 goToPosition 走过去，而模型真机踩过这个坑：
    // "灌水失败时它为了够到水面重新寻路，结果把人带偏 20 多格"——本来站在水边
    // 1.5 格内，一走路反而走丢了。她的 workaround 就是"原地重试"，那本该是默认行为。
    const reach: number = bot.entity.position.distanceTo(block.position);
    if (reach > 4) {
        await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    } else {
        log(bot, `Already within ${reach.toFixed(1)} blocks of ${block.name}, using it from here.`);
    }
    await faceTarget(bot, block.position.offset(0.5, 0.5, 0.5), String(block.name));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = (): boolean => {
        const blockInView: any = bot.blockAtCursor(5);
        const headPos: any = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView &&
            !blockInView.position.equals(block.position) &&
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    };
    const blockInView: any = bot.blockAtCursor(5);
    if (viewBlocked()) {
        // **多试几个站位，别只随机试一个就放弃**。模型真机被这条卡过两次：
        // 'Block stone is in the way, not using water_bucket'——它在岩浆层上方倒水，
        // 准星被脚下的石头挡住，只试一个随机位置就返回失败，于是整条下界门链停住。
        // 围着目标绕一圈试 4 个方向，最后再退一步正对着看。
        log(bot, `Block ${blockInView.name} is in the way, trying other spots...`);
        const bx: number = block.position.x;
        const by: number = block.position.y;
        const bz: number = block.position.z;
        const spots: Array<[number, number, number]> = [
            [bx + 1, by, bz],
            [bx - 1, by, bz],
            [bx, by, bz + 1],
            [bx, by, bz - 1],
            [bx + 1, by, bz + 1],
            [bx - 1, by, bz - 1],
        ];
        for (const [sx, sy, sz] of spots) {
            try {
                await goToPosition(bot, sx, sy, sz, 1);
                await faceTarget(bot, block.position.offset(0.5, 0.5, 0.5), String(block.name));
            } catch {
                continue;
            }
            if (!viewBlocked()) break;
        }
        if (viewBlocked()) {
            const blocked: any = bot.blockAtCursor(5);
            log(
                bot,
                `Block ${blocked?.name ?? '?'} is in the way, not using ${toolName}. ` +
                    '试了目标四周 6 个站位都被挡——先 mineBlock 挖掉挡路的那一格，或者换一个能正对着的目标再来。',
            );
            return false;
        }
    }

    const equipped: boolean = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    // **倒水 / 倒岩浆 / 点火默认禁止**。注意区分：
    //   - 倒水/倒岩浆：传的是 water_bucket / lava_bucket
    //   - 打水（把空桶灌满）：传的是 bucket —— 这个闸门**不拦**，主线照常
    if (toolName === 'water_bucket' || toolName === 'lava_bucket') {
        if (!allowDangerousOp(bot, toolName === 'water_bucket' ? 'pour_water' : 'pour_lava')) return false;
    }
    if (toolName === 'flint_and_steel' && !allowDangerousOp(bot, 'ignite')) return false;

    if (toolName.includes('bucket')) {
        // **必须验证**：`activateItem` 只是发一个"用物品"包，服务端采不采纳要看
        // 十字准星是否真的对着目标。模型真机报过"连续两次 useOn(水桶, water)，
        // 回执都是 Used bucket on water，但背包里还是空桶"——原来这里无条件
        // log 成功 + return true，等于假成功，把整个下界门计划卡死了。
        const before: number = (world.getInventoryCounts(bot) as Record<string, number>)[toolName] ?? 0;
        await bot.activateItem();
        await new Promise((resolve) => setTimeout(resolve, 350));
        const after: number = (world.getInventoryCounts(bot) as Record<string, number>)[toolName] ?? 0;
        if (after >= before) {
            log(
                bot,
                // **归因要对。** 对流动水用桶本来就不可能成功，怪"准星没对准"
                // 会让模型一直对着它重试（它自述重试了 6 次）。
                block.metadata !== 0 && (block.name === 'water' || block.name === 'lava')
                    ? `对 ${block.name} 用了 ${toolName}，没装进去：**这是流动水/岩浆，桶装不了**——要找源头方块（不流动的那一格）。` +
                        `换一个目标，别对着它再试。`
                    : `对 ${block.name} 用了 ${toolName}，但物品没变化——准星多半没真的对着它（或者够不着/被方块挡住）。往目标挪近、正对着再来一次。`,
            );
            return false;
        }
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

// ── 原子动作 ────────────────────────────────────────────────────────────────
/**
 * 比 `goToXxx` / `collectBlocks` 低一档的动作：跳一下、挪几格、转个头、蹲下。
 *
 * 为什么要有这一层：高层命令（"去那里""挖这个"）解决的是"任务"，而模型经常
 * 卡在"我只要往前一步""我得先抬头看一眼"这种**单步**上。没有单步原语，它就只能
 * 用一个重得多的命令去表达一个轻动作，代价是每次都要占住身体好几秒。
 *
 * 两条规则是照着 VLM-Bot 的 vendored Baritone（`motionCommands.js` /
 * `observationCommands.js`）抄的，那两条的理由都写得很实在：
 *
 * 1. **键位随动作释放。** `moveBy(..., 'sneak')` 在动作结束（到达 / 被挡 / 被打断）
 *    时一定松手。让调用方自己记住"再站起来"的接口，调用方一定会忘——而忘了的
 *    后果是**永远蹲着走路**。长住的姿态另有 `setPosture`，与"这一次移动"分开。
 * 2. **一个动作占住身体，别人别抢。** 一边按着方向键、一边又有寻路器在驱动同一具
 *    身体，结果是"既没走向你指的地方，也没走向它要去的地方"。所以这些动作走
 *    身体通道（`runAsAction`），跑着的时候别人插不进来——这一条和 `lookAtXxx`
 *    要占通道是同一个理由。
 *
 * 另外：**这里没有"秒"这个参数。** 模型没有时钟（VLM-Bot 的原话），所以参数只有
 * 方向、距离、角度、次数。超时全是实现里的兜底，不进接口。
 */

/**
 * **能直接 `bot.openContainer()` 的方块**（mineflayer `chest.js` 的白名单）。
 * 不在这张表里的方块，`openContainer` 会抛
 * `containerToOpen is neither a block nor an entity`——**哪怕传进去的是完全正确的 Block**。
 */
export const CONTAINER_BLOCKS_OPENABLE = Object.freeze([
    'chest', 'trapped_chest', 'barrel', 'ender_chest', 'hopper', 'dispenser', 'dropper',
]);

/** **有自己入口的加工方块**（mineflayer `furnace.js` 的白名单）——走 `bot.openFurnace()`。 */
export const FURNACE_LIKE_BLOCKS = Object.freeze(['furnace', 'blast_furnace', 'smoker']);

/**
 * 打开容器的**单次等待上限**（毫秒）。
 *
 * mineflayer 自己的上限是 20 秒（`promise_utils.once(..., 20000)`），而且**只等一次**：
 * 真机 2026-10-18 18:18（overnight_a）`useBlock(type=chest)` 就这么干等了 20 秒，
 * 回执只有一句英文 `Event windowOpen did not fire within timeout of 20000ms`，
 * 模型既不知道发生了什么，也没有第二次机会——紧接着身体才在空闲时清掉那个
 * **残留界面**（`screen-closed: leaked-open-window`）。等待窗口内的状态本来
 * 一清就能开，所以这里把上限压到 6 秒，失败立刻清理 + 重试。
 */
export const CONTAINER_OPEN_TIMEOUT_MS = 6_000;

/** 打开失败后的重试次数（清掉残留界面再试一次，通常就成了）。 */
export const CONTAINER_OPEN_RETRIES = 1;

/**
 * 关掉"客户端以为还开着"的界面，并把引用清掉。
 *
 * **为什么每次开界面前都要做这一下**：进程重启（我们一晚上重启十几次）时，
 * 旧进程来不及发 `close_window` 就没了，服务端/客户端两边都可能还记着一个
 * 窗口；这种状态下再开箱子，`windowOpen` 事件可能永远不来，于是一路等到超时。
 * 真机日志的顺序正是这样：失败回执 → 0.26 秒后 `screen-closed: leaked-open-window`。
 *
 * @returns 是否真的清掉了一个残留界面（调用方据此上报）。
 */
export function closeStaleWindow(bot: any): boolean {
    // **单一判据：包级证据**（Lead 2026-10-21）：`currentWindow != null` 不是"界面对模型开着"
    // 的证据——mineflayer 在服务端没发 `close_window` 时会留下一个**过期引用**。身体在开窗/关窗
    // 包上计数，并通过 `__residualScreenOpen()` 暴露；只有"见过 open、没见到 close"才算残留。
    // 没有 provider（老调用方/纯单元测试）才回退到旧判据，行为不变。
    const provider = (bot as { __residualScreenOpen?: unknown } | null)?.__residualScreenOpen;
    if (typeof provider === 'function') {
        let verdict: unknown = null;
        try {
            verdict = (provider as () => unknown)();
        } catch {
            verdict = null;
        }
        // 读不到判据 ⇒ 不宣称"关掉了"（宁可少一句，也不说没有证据的话）。
        if (verdict !== true) return false;
    }
    const win = (bot as { currentWindow?: unknown } | null | undefined)?.currentWindow ?? null;
    if (win == null) return false;
    try {
        bot.closeWindow?.(win);
    } catch {
        // 关不掉（窗口早就无效）也要继续把引用清掉。
    }
    try {
        bot.currentWindow = null;
    } catch {
        // 只读实现也要能继续。
    }
    return true;
}

/**
 * 打开一个方块的界面。**必须按类型分路**——这是这条链上最要紧的一件事。
 *
 * ## 为什么非要有这个函数（被错误信息骗了两次）
 *
 * `bot.openContainer()` 内部有一张**白名单**（`mineflayer/lib/plugins/chest.js`）：
 *
 * ```
 * generic / chest / dispenser / ender_chest / shulker_box(各色) /
 * hopper / container / dropper / trapped_chest / barrel
 * ```
 *
 * **熔炉、高炉、烟熏炉、工作台、铁砧、酿造台、附魔台都不在里面。**
 * 所以 `openContainer(furnaceBlock)` **必然**抛错，抛的还是那句极误导的
 * `containerToOpen is neither a block nor an entity`：它把"参数不对"写进了错误信息，
 * 而真相是"这个方块类型不走这条路"。
 *
 * 这句误导线**骗过两次修复**（`ae8f04d` 怀疑"要传 Block 不能传裸坐标"、
 * `d045e86` 怀疑"`blockAt` 返回了 null"）——两次都合理，两次都不可能生效。
 * 模型在真机上连着报了几条 Feedback 说"熔炉 100% 用不了"，方向一直是对的。
 *
 * 熔炉族有自己的入口 `bot.openFurnace()`（`furnace.js` 里它自己那张白名单就是
 * furnace / blast_furnace / smoker），返回的对象带
 * `inputItem()/fuelItem()/outputItem()/putInput/putFuel/takeOutput`。
 *
 * 工作台**没有"打开"这一说**——合成要经 `bot.craft(recipe, n, tableBlock)`，
 * 也就是 `craftRecipe`。所以这里如实报错，而不是让调用方去开一个开不了的界面。
 *
 * ## 残留界面（重启后箱子打不开）
 *
 * 每次尝试**之前**都先 `closeStaleWindow`；超时也再清一次。失败**重试一次**，
 * 最后抛的是说人话的回执（原因 + 下一步 + 原始错误），不再是 mineflayer 那句
 * 英文超时。
 */
export async function openBlockUi(
    bot: any,
    block: any,
    options: { timeoutMs?: number; retries?: number } = {},
): Promise<any> {
    const name = String(block?.name ?? '');
    if (name === '') throw new Error('要打开的那一格读不到方块类型。');
    const furnaceLike = FURNACE_LIKE_BLOCKS.includes(name);
    const containerLike = CONTAINER_BLOCKS_OPENABLE.includes(name) || name.endsWith('shulker_box');
    if (!furnaceLike && !containerLike) {
        throw new Error(
            `${name} 没有"打开界面"这个操作。能打开的只有箱子/陷阱箱/木桶/末影箱/漏斗/发射器/投掷器/潜影盒；`
                + `熔炉/高炉/烟熏炉走 useBlock 的 input/output（投料、取货）。`
                + `工作台合成用 craft。`,
        );
    }
    if (furnaceLike && typeof bot?.openFurnace !== 'function') {
        throw new Error(`这个 mineflayer 版本没有 openFurnace，开不了 ${name}。`);
    }

    // 下限 100ms：允许调用方"快点失败"（重试策略/测试），但 0 会变成不等待。
    const timeoutMs = Math.max(100, Number(options.timeoutMs ?? CONTAINER_OPEN_TIMEOUT_MS) || CONTAINER_OPEN_TIMEOUT_MS);
    const retries = Math.max(0, Math.floor(Number(options.retries ?? CONTAINER_OPEN_RETRIES) || 0));

    // **已确证的失效条件 ⇒ 立刻失败，不烧 6 秒 × 重试。**
    // 真机 2026-10-19 04:47 确证：这个服务端对本 client **开窗但不发内容**
    // （`open_window` 到了，`window_items`/`set_content` 一个都没有），并且**零**协议
    // 解析错误 ⇒ mineflayer 等不到槽位数据、永不发 windowOpen ⇒ 开槽位容器必然超时。
    // 结论由身体在每次转储收尾时写入，**带 10 分钟 TTL**，且一旦真有窗口内容到达就
    // 立刻解除（见 `__slottedContainerStatus`）——结论会过期，不会把容器永久焊死。
    const slotted = (() => {
        try {
            const read = (
                bot as {
                    __slottedContainerStatus?: (name?: string) => { blocked?: boolean; reason?: string | null; msLeft?: number } | null;
                }
            ).__slottedContainerStatus;
            return typeof read === 'function' ? read(name) : null;
        } catch {
            return null;
        }
    })();
    if (slotted?.blocked === true) {
        const minutesLeft = Math.max(1, Math.round(Number(slotted.msLeft ?? 0) / 60_000));
        throw new Error(
            `打开 ${name} **直接失败（没有尝试、没有空等）**：**上一种方块**在这个服务端打开了窗却拿不到内容——` +
                `服务端会回"开窗"（open_window）但**从不发窗口内容**（window_items/set_content 一个都没有），` +
                `而且本进程**零协议解析错误**；mineflayer 要等槽位数据才会发 windowOpen，所以必然超时。` +
                `这是**那一种容器**在那一次尝试里的证据，重试同一种意义不大（但别的类型是别的路径）（这条结论约 ${minutesLeft} 分钟后自动失效，之后才值得再试一次）。` +
                `下一步（照做即可）：**换另一种容器类型再试**（箱子/熔炉/合成台是不同路径；真机 2026-10-20 熔炉产出过 21 块玻璃，别把一次箱子失败当成全局）——让队友把要用的东西丢在约定点自己捡，` +
                `取/存都用 useBlock(type="chest", …)；需要合成就直接 craft（工作台不需要窗口）。` +
                (slotted.reason ? `（判定依据：${slotted.reason}）` : ''),
        );
    }

    // **开界面前先松开 sneak、收起手上的东西。**
    // 真机 2026-10-19（overnight_a 的对照实验）：`crafting_table` 的 useBlock 完全正常，
    // 而 **chest / furnace 100% windowOpen 超时**，换方块/换位置/重启都一样。
    // 两者唯一的差别就是"要不要服务端开一个带槽位的界面"，而**潜行状态下用方块是
    // 放置而不是打开**（原版行为）——所以一条卡住的 sneak（搭桥/挖竖井留下的）
    // 正好只会打断这条路径，crafting_table 那条自己实现的路径完全不受影响。
    try {
        bot.setControlState?.('sneak', false);
    } catch {
        // 拿不到控制键就继续（这不是唯一原因，只是最可能的那条）。
    }
    try {
        bot.deactivateItem?.();
    } catch {
        // 同上。
    }
    // **只在开容器期间**武装包转储（失败/超时才落一行日志；成功立刻解除）。
    // 这是"0 个窗口包"那个诊断的下一级：直接记下我们发了什么、服务端有没有回。
    try {
        const arm = (bot as { __armContainerPacketDump?: (reason: string) => void }).__armContainerPacketDump;
        arm?.(`useBlock ${name}`);
    } catch {
        // 转储不是功能，武装失败不影响打开。
    }
    // 诊断计数：**这次尝试里到底有没有窗口包到达**（0 = 服务端根本没发；>0 = 到了没接住）。
    let windowPackets = 0;
    const onWindowOpen = (): void => {
        windowPackets += 1;
    };
    const onWindowClose = (): void => {
        windowPackets += 1;
    };
    try {
        bot.on?.('windowOpen', onWindowOpen);
        bot.on?.('windowClose', onWindowClose);
    } catch {
        // 挂不上监听就少一条证据，不影响打开。
    }
    const hadWindowOpenAlready = (bot as { currentWindow?: unknown } | null)?.currentWindow != null;
    let lastError: unknown = null;
    try {
        for (let attempt = 0; attempt <= retries; attempt++) {
            // 每次尝试前先把残留界面清掉（重启/上一次动作留下的那个）。
            const hadStale = closeStaleWindow(bot);
            if (hadStale) {
                log(bot, `开 ${name} 之前先关掉了残留的界面（上一次会话/动作留下的），这次从干净状态开始。`);
            }
            try {
                const opened = await openWithTimeout(bot, block, furnaceLike, timeoutMs);
                if (attempt > 0) log(bot, `清掉残留界面后重试成功，${name} 打开正常。`);
                recordContainerOpenResult(name, true);
                try {
                    const disarm = (bot as { __disarmContainerPacketDump?: (outcome: string) => void })
                        .__disarmContainerPacketDump;
                    disarm?.('opened');
                } catch {
                    // 解除失败最多多记几行，不影响结果。
                }
                return opened;
            } catch (err: unknown) {
                lastError = err;
                // 超时之后也清一次：别把脏状态留给下一个动作。
                closeStaleWindow(bot);
                // **不是"窗口事件没来"的错误原样抛**（例如方块类型不对）：
                // 重试没有意义，更不能把它包装成"残留窗口"的故事。
                if (!isWindowOpenTimeout(err)) throw err;
                if (attempt < retries) {
                    log(
                        bot,
                        `打开 ${name} 没等到窗口事件（${Math.round(timeoutMs / 1000)} 秒上限）；已清掉残留界面，重试一次。`,
                    );
                }
            }
        }
    } finally {
        try {
            bot.removeListener?.('windowOpen', onWindowOpen);
            bot.removeListener?.('windowClose', onWindowClose);
        } catch {
            // 摘不掉监听不影响结果。
        }
    }
    const raw = lastError instanceof Error ? lastError.message : String(lastError);
    const consecutive = recordContainerOpenResult(name, false);
    const position = (block as { position?: { x?: number; y?: number; z?: number } })?.position;
    const where = position == null ? '位置读不到' : `(${Math.round(Number(position.x))},${Math.round(Number(position.y))},${Math.round(Number(position.z))})`;
    // **协议解析失败 > 一切别的解释。** 真机 2026-10-19 04:10 的最终根因：
    // 服务端**发了** `open_window(windowId=1)`，但紧随其后的窗口内容包
    // 解不开（protodef `PartialReadError`）——`'packet'` 事件根本不触发，
    // 所以上面"窗口包计数"必然是 0，而**0 个包不代表服务端没发**。
    // 这是仪器撒谎的第三种形态：看不见 ≠ 没发生。
    const protocolFault = (() => {
        try {
            const read = (bot as { __containerProtocolFault?: (withinMs?: number) => { message: string; packetId: number | null } | null })
                .__containerProtocolFault;
            return typeof read === 'function' ? read(15_000) : null;
        } catch {
            return null;
        }
    })();
    // **诊断第一句先把"锅在谁身上"说清**，然后才给下一步。真机里模型被同一套
    // "换个位置再试"的建议喂了 18 次，白耗一整晚。
    const diagnosis =
        protocolFault != null
            ? `**协议解析失败**（protodef PartialReadError${protocolFault.packetId != null ? `，包 id ${protocolFault.packetId}` : ''}）：` +
              `服务端**开了窗**，但窗口内容包解不开，我们这边永远等不到槽位数据——` +
              `这不是"服务端没回话"、也不是站位/角度问题，是**这个服务端的容器协议和我们的定义对不上**。` +
              `原始错误：${protocolFault.message}`
            : windowPackets === 0
                ? `服务端**一个窗口包都没发**（${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`}内 windowOpen/windowClose 计数 = 0）：这不是站位或角度问题，是"带槽位容器"这条交互路径本身没走通`
                : `窗口包**到过 ${windowPackets} 次**但没接住（大概率是残留界面/竞态），不是服务端没响应`;
    const nextStep =
        protocolFault != null
            ? `下一步（照做即可）：**别再 useBlock 任何带槽位的容器了**（柜子/熔炉/箱子都一样，重试只是白耗回合）——` +
              `改走非容器路径（队友把东西丢在约定点后自己捡，取/存都用 useBlock），并把「容器协议解析失败」告诉人类。`
            : consecutive >= 2
            ? `下一步（照做即可）：这已经是连续第 ${consecutive} 次打不开容器了——**别再重发同一个 useBlock**（同样的调用只会得到同样的结果）。` +
              `改走非容器路径：让队友把东西丢在约定点后自己捡（或用 useBlock 由能开箱的那一方去取），` +
              `并把这条现象告诉人类（这是代码级故障）。`
            : `下一步（照做即可）：换**另一个**容器方块试一次（不同坐标或不同种类），仍然失败就别再试了；` +
              `同一个箱子重复 useBlock 不会变好。`;
    throw new Error(
        `打开 ${name} 失败：${diagnosis}。` +
            `现场：方块 ${name} @${where}，开之前${hadWindowOpenAlready ? '**已经有一个界面开着**' : '没有界面开着'}。` +
            `已经清掉残留界面并重试 ${retries} 次都没成。` +
            nextStep +
            `（原始错误：${raw}）`,
    );
}

/** 连续失败次数（按方块名）；用来让回执**换形状**，而不是第 18 次还劝它再试一遍。 */
const containerOpenFailures = new Map<string, number>();

function recordContainerOpenResult(name: string, ok: boolean): number {
    if (ok) {
        containerOpenFailures.delete(name);
        return 0;
    }
    const next = (containerOpenFailures.get(name) ?? 0) + 1;
    containerOpenFailures.set(name, next);
    return next;
}

/** 给测试/诊断用：清掉连续失败计数。 */
export function resetContainerOpenFailures(): void {
    containerOpenFailures.clear();
}

/** 这个错误是不是"窗口事件没来"那一类（只有这一类才值得重试 + 用残留窗口解释）。 */
export function isWindowOpenTimeout(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /windowOpen did not fire|did not fire within timeout/i.test(msg);
}

/**
 * 用一个**有界的**等待包住打开/合成：超时抛"窗口事件没来"，其余错误原样抛。
 */
async function withWindowTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 把底层 promise 接住：它在超时之后仍可能自己 reject（mineflayer 20 秒上限），
    // 不接就会变成 unhandledRejection。
    const settled = Promise.resolve(promise).then(
        (value) => ({ kind: 'ok' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const timedOut = new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    try {
        const raced = await Promise.race([settled, timedOut]);
        if (raced.kind === 'ok') return raced.value;
        if (raced.kind === 'error') throw raced.error;
        throw new Error(`Event windowOpen did not fire within timeout of ${timeoutMs}ms`);
    } finally {
        if (timer != null) clearTimeout(timer);
    }
}

/**
 * 单次打开（内部用）：超时口径统一在 `withWindowTimeout`。
 */
async function openWithTimeout(bot: any, block: any, furnaceLike: boolean, timeoutMs: number): Promise<any> {
    return withWindowTimeout(furnaceLike ? bot.openFurnace(block) : bot.openContainer(block), timeoutMs);
}

/**
 * `bot.craft` 的**残留窗口守卫**。
 *
 * 为什么不能直接 `await bot.craft(...)`：mineflayer 的 `craftOnce` 在工作台那一步
 * 自己做 `bot.activateBlock(table)` + `await once(bot, 'windowOpen')`——**默认 20 秒
 * 硬等**，一个残留窗口就能让它卡到超时（和开箱子同一个病）。
 * 这里合成前先清残留窗口；把 `craft` 放进有界等待里，**只有"窗口事件没来"才**
 * 清理 + 重试一次；别的错误（配方本身不对之类）原样抛，不许被包装成窗口问题。
 */
export async function craftWithStaleWindowGuard(
    bot: any,
    recipe: any,
    count: number,
    craftingTable: any,
    options: { timeoutMs?: number; retries?: number } = {},
): Promise<void> {
    if (typeof bot?.craft !== 'function') throw new Error('这个 mineflayer 版本没有 craft。');
    const timeoutMs = Math.max(100, Number(options.timeoutMs ?? CONTAINER_OPEN_TIMEOUT_MS) || CONTAINER_OPEN_TIMEOUT_MS);
    const retries = Math.max(0, Math.floor(Number(options.retries ?? CONTAINER_OPEN_RETRIES) || 0));
    let lastError: unknown = null;
    // **产物核对基线**（Lead 2026-10-21：真机 `wooden_pickaxe` 实际做出 `oak_pressure_plate`，
    // 回执却报成功——3 块木板一排正好是压力板配方）。合成前记一次全背包账目。
    const countInventory = (): Record<string, number> => {
        try {
            const counts: Record<string, number> = {};
            const items = ((bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>);
            for (const item of items) {
                const name = String(item?.name ?? '');
                if (name === '') continue;
                counts[name] = (counts[name] ?? 0) + Number(item?.count ?? 0);
            }
            return counts;
        } catch {
            return {};
        }
    };
    const inventoryBefore: Record<string, number> = countInventory();
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (closeStaleWindow(bot)) {
            log(bot, '合成之前先关掉了残留的界面（上一次会话/动作留下的）。');
        }
        try {
            // **合成窗口也要取证**（Lead 2026-10-19 ①）：`bot.craft` 自己开 3×3 窗口，
            // **不经过** `openBlockUi` 的那套转储，所以工作台 0/4 之前没有任何证据。
            // 武装同一套包转储，失败时由身体落一行 `craft-window-diagnosis{recipe,
            // verdict, openWindow, contents, protocolFaults}`，用来区分"两条 crafting
            // 实现一条死"和"偶发无内容"。
            try {
                const arm = (bot as { __armContainerPacketDump?: (reason: string, label?: 'container' | 'craft') => void })
                    .__armContainerPacketDump;
                arm?.(`craft ${String(recipe?.result?.id ?? count)}`, 'craft');
            } catch {
                // 取证不是功能，武装失败不影响合成。
            }
            await withWindowTimeout(Promise.resolve(bot.craft(recipe, count, craftingTable)), timeoutMs);
            try {
                const disarm = (bot as { __disarmContainerPacketDump?: (outcome: string) => void })
                    .__disarmContainerPacketDump;
                disarm?.('crafted');
            } catch {
                // 解除失败最多多记几行。
            }
            // **产物必须等于请求的产物**：不信任 `bot.craft` 的"完成"，只信任背包实测。
            // 真机 2026-10-21：请求 wooden_pickaxe，实际背包里多出来的是 oak_pressure_plate
            // （3 条木板一排就是压力板配方）——框架"成功"了，但合成的不是我们要的东西。
            try {
                const rawResultId = recipe?.result?.id;
                const targetName =
                    typeof rawResultId === 'string'
                        ? rawResultId
                        : String(mc.getItemName(Number(rawResultId)) ?? '');
                const after = countInventory();
                const wanted = Number(after[targetName] ?? 0) - Number(inventoryBefore[targetName] ?? 0);
                // **读不到背包就不许判定"跑偏"**：after 为空说明这次根本没读到背包，
                // 那不是"产物不对"，是"没测量"。假 bot 只实现注入式 accessor 时就会这样
                // （tests/craft_workbench.test.ts 用 __counts() 驱动，没有 inventory.items）。
                const inventoryReadable = Object.keys(after).length > 0
                    || Object.keys(inventoryBefore).length > 0;
                if (targetName !== '' && wanted <= 0 && inventoryReadable) {
                    const unexpected = Object.entries(after)
                        .map(([name, count]) => ({
                            name,
                            delta: Number(count ?? 0) - Number(inventoryBefore[name] ?? 0),
                        }))
                        .filter((entry) => entry.delta > 0 && entry.name !== targetName)
                        .sort((a, b) => b.delta - a.delta)[0] ?? null;
                    const wrong = unexpected != null ? `${unexpected.name}×${unexpected.delta}` : '别的东西';
                    throw new Error(
                        `合成跑偏：**背包里增加的是 ${wrong}，不是 ${targetName}**（这次的配方实际产出了别的东西）。` +
                            '先 stats 核对；要的东西没出来，别按"成功"继续下一步。',
                    );
                }
            } catch (verifyError: unknown) {
                // 产物核对本身失败（读不到背包）不判失败——但不许把异常吞成成功：
                // 只有"明确核对出跑偏"（我们自己抛的 Error）才向上抛。
                if (verifyError instanceof Error && verifyError.message.startsWith('合成跑偏')) throw verifyError;
            }
            return;
        } catch (err: unknown) {
            lastError = err;
            closeStaleWindow(bot);
            // **别的错误不是窗口问题**：原样抛（重试也没有意义）。
            if (!isWindowOpenTimeout(err)) throw err;
            if (attempt < retries) log(bot, `合成没等到工作台窗口事件（${Math.round(timeoutMs / 1000)} 秒上限）；已清残留，重试一次。`);
        }
    }
    const raw = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
        `合成失败（服务端没回工作台窗口事件，可能被上一次重启留下的窗口占着）。` +
            `已经清掉残留界面并重试 ${retries} 次都没成。` +
            `下一步（照做即可）：走到工作台旁边重新 craftRecipe（或先 placeHere 一个新工作台）；` +
            `还不行就等几秒再试。（原始错误：${raw}）`,
    );
}

/** 等一个条件成立；超时返回 false。轮询期间尊重打断。 */
export async function waitFor(
    bot: any,
    ready: () => boolean,
    timeoutMs: number,
    intervalMs: number = 50,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (bot?.interrupt_code) return false;
        try {
            if (ready()) return true;
        } catch {
            // 身体还没就绪（bot.entity 是 undefined）：当作条件不成立，继续等。
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

/** 水平位移（格）。竖直方向不算——跳起落下不该被算成"走了几格"。 */
function horizontalDistance(from: any, to: any): number {
    const dx = (to?.x ?? 0) - (from?.x ?? 0);
    const dz = (to?.z ?? 0) - (from?.z ?? 0);
    return Math.hypot(dx, dz);
}

/**
 * 跳一次。
 *
 * **离地就松开跳跃键**：一直按着会变成原地反复弹跳——模型看不出区别，但录像里
 * 很蠢，而且落点不可控。落地才算完成。
 */
export async function jump(bot: any): Promise<boolean> {
    if (bot == null || typeof bot.setControlState !== 'function') return false;
    bot.setControlState('jump', true);
    const leftGround = await waitFor(bot, () => bot.entity?.onGround === false, 1200);
    bot.setControlState('jump', false);
    if (!leftGround) {
        log(bot, '跳不起来：可能头顶被方块挡住了。');
        return false;
    }
    const landed = await waitFor(bot, () => bot.entity?.onGround === true, 3000);
    log(bot, landed ? '跳了一下，已经落地。' : '跳起来后 3 秒还没落地（可能掉进洞里了）。');
    return landed;
}

/** `moveBy` 认的方向。相对方向按当前朝向算，绝对方向按世界坐标算。 */
export const MOVE_DIRECTIONS = Object.freeze([
    'forward', 'back', 'left', 'right',
    'north', 'south', 'east', 'west',
] as const);

export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

/** 相对/绝对方向 → 世界坐标下的单位向量（+X 东，+Z 南，与 Minecraft 一致）。 */
function isLavaBlockName(name: unknown): boolean {
    return name === 'lava' || name === 'flowing_lava';
}

/** 朝某个方向前方 ahead 格是否有岩浆（脚/身/头三格任一）。 */
function moveHazardAhead(bot: any, vector: { x: number; z: number }, ahead = 1.2): string | null {
    const p = bot?.entity?.position;
    if (p == null || typeof bot?.blockAt !== 'function') return null;
    const fx = Math.floor(p.x + vector.x * ahead);
    const fz = Math.floor(p.z + vector.z * ahead);
    const fy = Math.floor(p.y);
    for (const dy of [-1, 0, 1]) {
        try {
            const name = bot.blockAt(new (Vec3 as any)(fx, fy + dy, fz))?.name;
            if (isLavaBlockName(name)) return `岩浆 @(${fx},${fy + dy},${fz})`;
        } catch {
            // 读不到就不猜。
        }
    }
    return null;
}

function worldVectorFor(bot: any, direction: MoveDirection): { x: number; z: number } {
    switch (direction) {
        case 'north': return { x: 0, z: -1 };
        case 'south': return { x: 0, z: 1 };
        case 'east': return { x: 1, z: 0 };
        case 'west': return { x: -1, z: 0 };
        default: break;
    }
    // 相对方向：把"我的前/右"投影到世界坐标。
    // 偏航角 0 面朝南（+Z），90 面朝西（-X）——Minecraft 的约定。
    const yaw = ((bot?.entity?.yaw ?? 0) * Math.PI) / 180;
    const forward = { x: -Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: -Math.cos(yaw), z: -Math.sin(yaw) };
    const sign = direction === 'back' ? -1 : 1;
    const axis = direction === 'forward' || direction === 'back' ? forward : right;
    return { x: axis.x * sign, z: axis.z * sign };
}

/**
 * 往某个方向挪一小段。**不改变朝向**——绝对方向也是靠换算成"前/后/左/右"来走，
 * 所以模型一边看某个方向一边挪是可能的。
 *
 * 结束条件三个（谁先到算谁）：走满距离、卡住（半秒没有格级位移）、超时兜底。
 * 无论怎么结束**都会松掉所有键**，这是这个函数存在的意义。
 */
export async function moveBy(
    bot: any,
    direction: MoveDirection,
    distance: number,
    mode: 'walk' | 'sprint' | 'sneak' = 'walk',
): Promise<boolean> {
    if (bot == null || typeof bot.setControlState !== 'function') return false;
    if (!MOVE_DIRECTIONS.includes(direction)) {
        log(bot, `不认识的方向 ${direction}；可用：${MOVE_DIRECTIONS.join('、')}。`);
        return false;
    }
    // 上限兜底：走远路是 goToCoordinates 的活，这里只做"挪几格"。
    const MAX_STEP = 64;
    if (!(distance > 0) || distance > MAX_STEP) {
        log(bot, `距离要大于 0 且不超过 ${MAX_STEP} 格（更远请用 goToCoordinates），收到的是 ${distance}。`);
        return false;
    }
    const vector = worldVectorFor(bot, direction);
    const yaw = ((bot?.entity?.yaw ?? 0) * Math.PI) / 180;
    const forward = { x: -Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: -Math.cos(yaw), z: -Math.sin(yaw) };
    // 世界方向 → 我该按哪几个键（前/右 分量各自过阈值；斜向会同时按两个键）。
    const along = vector.x * forward.x + vector.z * forward.z;
    const across = vector.x * right.x + vector.z * right.z;
    const pressed: string[] = [];
    if (along > 0.3) pressed.push('forward');
    if (along < -0.3) pressed.push('back');
    if (across > 0.3) pressed.push('right');
    if (across < -0.3) pressed.push('left');
    if (mode === 'sneak') pressed.push('sneak');
    if (mode === 'sprint') pressed.push('sprint');

    const start = { x: bot.entity?.position?.x ?? 0, z: bot.entity?.position?.z ?? 0 };
    const startedAt = Date.now();
    // 兜底超时：按最慢的蹲行（约 1.3 格/秒）再留一倍余量。
    const timeoutMs = Math.max(3000, (distance / 1.3) * 1000 * 2 + 2000);
    let lastProgressAt = startedAt;
    let lastDistance = 0;
    let moved = 0;
    let hazardStop: string | null = null;

    try {
        for (const key of pressed) bot.setControlState(key, true);
        while (true) {
            if (bot.interrupt_code) break;
            hazardStop = moveHazardAhead(bot, vector);
            if (hazardStop != null) break;
            const now = Date.now();
            const here = { x: bot.entity?.position?.x ?? 0, z: bot.entity?.position?.z ?? 0 };
            moved = horizontalDistance(start, here);
            if (moved >= distance - 0.2) break;
            if (moved > lastDistance + 0.05) {
                lastDistance = moved;
                lastProgressAt = now;
            } else if (now - lastProgressAt > 500) {
                break; // 卡住了（墙、栅栏、坑沿…）
            }
            if (now - startedAt > timeoutMs) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    } finally {
        // **一定松手**：不管是走满、卡住、超时还是被 Stop 打断。
        for (const key of pressed) {
            try {
                bot.setControlState(key, false);
            } catch {
                // 已经断线之类，尽力而为。
            }
        }
    }

    if (hazardStop != null) {
        const roundedHazard = Math.round(moved * 10) / 10;
        log(bot, `朝${direction}前方是${hazardStop}，已挪 ${roundedHazard} 格就停下（不会走进岩浆）。`);
        return false;
    }
    const rounded = Math.round(moved * 10) / 10;
    if (moved >= distance - 0.2) {
        log(bot, `朝${direction}走了 ${rounded} 格（目标 ${distance} 格）${mode === 'sneak' ? '，走完已站起' : ''}。`);
        return true;
    }
    log(bot, `朝${direction}只挪了 ${rounded} 格（目标 ${distance} 格）就被挡住了或没进展。`);
    return false;
}

/**
 * 长住的姿态：蹲下 / 站起来。
 *
 * 和 `moveBy` 的 `sneak` 模式分开：那个是"蹲着走这一段，走完自己站起来"，
 * 这个是"从今往后蹲着"，**只有再叫一次或 Stop 才会解除**。多数情况该用前者。
 *
 * **它不走身体通道**，所以也不写 `bot.output`——瞬时状态改变不是任务
 * （VLM-Bot 那边同样把 posture 划在"不是 running task"里）。回执直接返回。
 */
export function setPosture(bot: any, posture: string): string {
    if (bot == null || typeof bot.setControlState !== 'function') return '身体还没就绪。';
    if (posture === 'sneak' || posture === 'crouch' || posture === '蹲') {
        bot.setControlState('sneak', true);
        return '开始保持潜行（蹲下）；要站起来用 posture stand。';
    }
    if (posture === 'stand' || posture === '站') {
        bot.setControlState('sneak', false);
        return '站起来了，不再潜行。';
    }
    return `不认识的姿态 ${posture}；可用：sneak（蹲下）、stand（站起）。`;
}

/** 方位名 → 偏航角。角度是 Minecraft 的约定：0 面朝南，90 朝西，180 朝北，-90 朝东。 */
const DIRECTION_YAW: Record<string, number> = {
    south: 0,
    west: 90,
    north: 180,
    east: -90,
};

/**
 * 把视角转到某个方位（北/南/东/西），或者抬到正上/正下。
 *
 * 和 `lookAtPosition` 的分工：那个是"看向某个坐标"（要算角度），这个是"朝向某个
 * 方位"——模型想说"面朝北"时不该被迫先算一个坐标出来。
 */
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function degToRad(deg: number): number {
    return deg * DEG_TO_RAD;
}

export function radToDeg(rad: number): number {
    return rad * RAD_TO_DEG;
}

function angleDiffRad(a: number, b: number): number {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
}

/** 由目标点算 yaw/pitch（弧度），公式与 mineflayer 的 bot.lookAt 一致。 */
export function anglesToPoint(
    bot: any,
    point: { x: number; y: number; z: number },
): { yawRad: number; pitchRad: number; yawDeg: number; pitchDeg: number } {
    const pos = bot?.entity?.position ?? { x: 0, y: 0, z: 0 };
    const eyeHeight = typeof bot?.entity?.eyeHeight === 'number' ? bot.entity.eyeHeight : 1.62;
    const dx = point.x - pos.x;
    const dy = point.y - (pos.y + eyeHeight);
    const dz = point.z - pos.z;
    const ground = Math.sqrt(dx * dx + dz * dz);
    const yawRad = Math.atan2(-dx, -dz);
    const pitchRad = Math.atan2(dy, ground);
    return { yawRad, pitchRad, yawDeg: radToDeg(yawRad), pitchDeg: radToDeg(pitchRad) };
}

/** 真正调用 bot.look(yawRad, pitchRad, force=true)，并等它反映到 entity 读数。 */
export async function setLookDegrees(
    bot: any,
    yawDeg: number,
    pitchDeg: number,
    force: boolean = true,
): Promise<{ beforeYaw: number; beforePitch: number; afterYaw: number; afterPitch: number }> {
    const beforeYaw = radToDeg(Number(bot?.entity?.yaw ?? 0));
    const beforePitch = radToDeg(Number(bot?.entity?.pitch ?? 0));
    const yawRad = degToRad(yawDeg);
    const pitchRad = degToRad(Math.max(-90, Math.min(90, pitchDeg)));
    if (typeof bot?.look !== 'function') return { beforeYaw, beforePitch, afterYaw: beforeYaw, afterPitch: beforePitch };
    await bot.look(yawRad, pitchRad, force);
    await waitFor(
        bot,
        () =>
            angleDiffRad(Number(bot?.entity?.yaw ?? 0), yawRad) < 0.05 &&
            Math.abs(Number(bot?.entity?.pitch ?? 0) - pitchRad) < 0.05,
        600,
        30,
    );
    return {
        beforeYaw,
        beforePitch,
        afterYaw: radToDeg(Number(bot?.entity?.yaw ?? yawRad)),
        afterPitch: radToDeg(Number(bot?.entity?.pitch ?? pitchRad)),
    };
}

/** 面向某个坐标（交互/放置前自动调用它，不依赖模型先转向）。 */
export async function faceTarget(
    bot: any,
    point: { x: number; y: number; z: number },
    label: string = '目标',
): Promise<boolean> {
    const angles = anglesToPoint(bot, point);
    const result = await setLookDegrees(bot, angles.yawDeg, angles.pitchDeg, true);
    log(
        bot,
        '自动面向 ' + label + '：yaw ' + result.beforeYaw.toFixed(1) + '° → ' + result.afterYaw.toFixed(1) +
            '°，pitch ' + result.beforePitch.toFixed(1) + '° → ' + result.afterPitch.toFixed(1) + '°。',
    );
    return true;
}

/** 看向指定坐标：真调 bot.look，回执带 before→after yaw/pitch 和准星校验。 */
export async function lookAtCoordinates(bot: any, x: number, y: number, z: number): Promise<string> {
    if (bot == null || typeof bot.look !== 'function') return '身体还没就绪，转不了头。';
    const target = new Vec3(x + 0.5, y + 0.5, z + 0.5);
    const angles = anglesToPoint(bot, target);
    const result = await setLookDegrees(bot, angles.yawDeg, angles.pitchDeg, true);
    let cursorText: string;
    try {
        const cursor: any = bot.blockAtCursor?.(128) ?? null;
        const cp = cursor?.position;
        cursorText = cp == null
            ? '准星前方 128 格内没有方块'
            : (Math.floor(cp.x) === Math.floor(x) && Math.floor(cp.y) === Math.floor(y) && Math.floor(cp.z) === Math.floor(z)
                ? '准星落在目标方块上'
                : '准星落在 ' + cursor.name + ' @(' + cp.x + ',' + cp.y + ',' + cp.z + ')，没对上 (' + x + ',' + y + ',' + z + ')');
    } catch {
        cursorText = '准星校验读不到';
    }
    return (
        '看向 (' + x + ',' + y + ',' + z + ')：yaw ' + result.beforeYaw.toFixed(1) + '° → ' + result.afterYaw.toFixed(1) +
        '°，pitch ' + result.beforePitch.toFixed(1) + '° → ' + result.afterPitch.toFixed(1) + '°；' + cursorText + '。'
    );
}

/**
 * 把视角转到某个方位（北/南/东/西），或者抬到正上/正下。
 *
 * 和 `lookAtPosition` 的分工：那个是"看向某个坐标"（要算角度），这个是"朝向某个
 * 方位"——模型想说"面朝北"时不该被迫先算一个坐标出来。
 */
export async function lookInDirection(bot: any, direction: string, pitch?: number): Promise<boolean> {
    if (bot == null || typeof bot.look !== 'function') return false;
    const name = String(direction ?? '').trim().toLowerCase();
    const beforeYaw = radToDeg(Number(bot.entity?.yaw ?? 0));
    const beforePitch = radToDeg(Number(bot.entity?.pitch ?? 0));
    if (name === 'up' || name === 'down') {
        const target = name === 'up' ? -90 : 90;
        const result = await setLookDegrees(bot, beforeYaw, target, true);
        log(bot, '视角转到朝' + (name === 'up' ? '上' : '下') + '：pitch ' + result.beforePitch.toFixed(1) + '° → ' + result.afterPitch.toFixed(1) + '°。');
        return true;
    }
    const yawDeg = DIRECTION_YAW[name];
    if (yawDeg == null) {
        log(bot, '不认识的方位 ' + direction + '；可用：north、south、east、west、up、down。');
        return false;
    }
    const targetPitch = typeof pitch === 'number' ? Math.max(-90, Math.min(90, pitch)) : 0;
    const result = await setLookDegrees(bot, yawDeg, targetPitch, true);
    log(
        bot,
        '视角转到朝 ' + name + '：yaw ' + result.beforeYaw.toFixed(1) + '° → ' + result.afterYaw.toFixed(1) +
            '°，pitch ' + result.beforePitch.toFixed(1) + '° → ' + result.afterPitch.toFixed(1) + '°。',
    );
    return true;
}

/**
 * 在当前视角上转一个增量（度）。俯仰被夹在 ±90 之间。
 */
export async function turnView(bot: any, yawDelta: number, pitchDelta: number = 0): Promise<boolean> {
    if (bot == null || typeof bot.look !== 'function') return false;
    const yawDeg = radToDeg(Number(bot.entity?.yaw ?? 0)) + yawDelta;
    const pitchDeg = Math.max(-90, Math.min(90, radToDeg(Number(bot.entity?.pitch ?? 0)) + pitchDelta));
    const result = await setLookDegrees(bot, yawDeg, pitchDeg, true);
    log(
        bot,
        '视角转了 水平 ' + yawDelta + '°、俯仰 ' + pitchDelta + '°：yaw ' + result.beforeYaw.toFixed(1) + '° → ' +
            result.afterYaw.toFixed(1) + '°，pitch ' + result.beforePitch.toFixed(1) + '° → ' + result.afterPitch.toFixed(1) + '°。',
    );
    return true;
}

export function inspectAimed(bot: any, maxDistance: number = 5): string {
    if (bot == null) return '身体还没就绪。';
    const lines: string[] = [];
    let block: any;
    try {
        block = bot.blockAtCursor?.(maxDistance) ?? null;
    } catch {
        block = null;
    }
    if (block != null) {
        const p = block.position ?? {};
        lines.push(`准星指着方块 ${block.name} @(${p.x}, ${p.y}, ${p.z})`);
    }
    let entity: any;
    try {
        entity = bot.entityAtCursor?.(maxDistance) ?? null;
    } catch {
        entity = null;
    }
    if (entity != null) {
        lines.push(`准星指着实体 ${entity.name ?? entity.username ?? entity.type}（距离 ${entity.distance ?? '未知'}）`);
    }
    if (lines.length === 0) {
        return `${maxDistance} 格内的准星方向什么都没有（对着空气或太远）。`;
    }
    return lines.join('；') + '。';
}

/**
 * **走进一格** —— 移动的唯一原语（Lead 2026-10-20 指令：collapse, not patch）。
 *
 * 为什么需要它：`mineTunnel` / `travelTo` / `stairUp` / `digDown` 四个工具**同一个病**——
 * 它们挖通了，然后**让寻路器钻进 1×1 的洞**（寻路器表达不了这种动作），于是：
 * 「挖通了但没走进去（寻路失败）」「跳不上去」「Skipping air block… 挖了 4/80 格」。
 * 四个调用点坏成一句话 ⇒ 坏的是原语，不是四个调用者。
 *
 * 这条原语只做一件事：面向目标格、按住 forward（目标高一格就同时 jump）、
 * **测量位移是否真的发生**，有界重试（3 次），失败时**说出障碍物**并交给调用方报实话。
 * 不碰任何安全判定（落点/岩浆/虚空由调用方或反射负责）。
 */
export interface StepIntoResult {
    moved: boolean;
    /** 失败时的原因（含障碍物名字）；成功为 null。 */
    reason: string | null;
    /** 尝试次数（有界，最多 3）。 */
    attempts: number;
    from: { x: number; y: number; z: number };
    to: { x: number; y: number; z: number };
    /** 目标格里的障碍物（脚/头/落点），失败时非空，供调用方给具体下一步。 */
    obstacles: string[];
}

/** 目标格周围挡路的是什么（给"下一步该 mineBlock 哪里"用）。 */
export function describeStepObstacles(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    target: { x: number; y: number; z: number },
): string[] {
    const out: string[] = [];
    const solid = (name: unknown): boolean => {
        const value = String(name ?? '');
        return value !== '' && value !== 'air' && value !== 'cave_air' && value !== 'void_air';
    };
    const feet = blockAt(target.x, target.y, target.z)?.name;
    const head = blockAt(target.x, target.y + 1, target.z)?.name;
    const landing = blockAt(target.x, target.y - 1, target.z)?.name;
    if (solid(feet)) out.push(`脚那一格是 ${String(feet)}`);
    if (solid(head)) out.push(`头那一格是 ${String(head)}`);
    if (!solid(landing)) out.push(`目标脚下没有实心方块（${String(landing ?? '空')}）`);
    return out;
}

/**
 * 走进 `target` 这一格（格坐标）。**小、准、可测**：
 * - 面向格中心；目标比现在高 1 格 ⇒ 同时按 jump；低 1 格 ⇒ 只按 forward；
 * - 每轮 ~600ms 后松开按键并**实测位移**（≥0.35 格才算走进去了）；
 * - 最多 3 次；失败时返回障碍物名，不做任何"寻路失败"的空话。
 */
/**
 * **走进一格；挡路的格子就挖掉它**（Lead 2026-10-21：`digDown` 连续 5 次「走不进去」、
 * `stairUp`/`travelTo`/`goToSurface` 三个上行工具全死在「挖通了但走不进去」——
 * 名字了障碍物却没人消费它。B 自己给出了正确做法：「挖穿一格后站不进去就顺手把挡路格挖掉」）。
 *
 * 只在**目标脚格/头格是实心**时动手（不扩大破坏面），最多挖 `maxClears` 格，然后重试原语。
 */
export async function stepIntoCellClearing(
    bot: any,
    target: { x: number; y: number; z: number },
    maxClears = 3,
): Promise<StepIntoResult & { cleared: string[] }> {
    const cleared: string[] = [];
    let result = await stepIntoCell(bot, target);
    const solid = (name: unknown): boolean => {
        const value = String(name ?? '');
        return value !== '' && !['air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava'].includes(value);
    };
    for (let i = 0; i < maxClears && !result.moved; i++) {
        let victim: any = null;
        try {
            const feetBlock = bot.blockAt(new Vec3(target.x, target.y, target.z));
            const headBlock = bot.blockAt(new Vec3(target.x, target.y + 1, target.z));
            victim = solid(feetBlock?.name) ? feetBlock : solid(headBlock?.name) ? headBlock : null;
        } catch {
            victim = null;
        }
        if (victim == null) {
            // **障碍物读不到 = 不是"挖不动"**：目标格是空的，说明挡路的是天花板/落脚点/身体。
            if (result.obstacles.length === 0) {
                let headName: string | null = null;
                let floorName: string | null = null;
                try {
                    headName = String(bot.blockAt(new Vec3(target.x, target.y + 2, target.z))?.name ?? '');
                    floorName = String(bot.blockAt(new Vec3(target.x, target.y - 1, target.z))?.name ?? '');
                } catch { /* 读不到就走下面的通用建议 */ }
                result = { ...result, reason: formatNoObstacleDiagnosis({ target, headSolid: headName, floorSolid: floorName, onGround: bot?.entity?.onGround === true, movedAny: false }) };
            }
            break;
        }
        // **挖之前先算工具够不够**：木镐挖石头可能超过预算，宁可说清也不耗到超时。
        const hardness = (() => {
            try { return Number((mc as any)?.blocksByName?.[String(victim.name ?? '')]?.hardness ?? NaN); } catch { return NaN; }
        })();
        const clearPlan = planClearStep({
            blockName: String(victim.name ?? '方块'),
            toolName: String(bot?.heldItem?.name ?? '' ) || null,
            toolDurabilityLeft: (() => { try { return Number(bot?.heldItem?.durability ?? NaN); } catch { return null; } })(),
            seconds: estimateDigSeconds({ hardness: Number.isFinite(hardness) ? hardness : null, toolName: String(bot?.heldItem?.name ?? '') }),
        });
        if (clearPlan.action !== 'ok') {
            result = { ...result, reason: String(clearPlan.message) };
            break;
        }
        const dug = await digWithTimeout(
            bot,
            victim,
            `clear-for-step@(${victim.position.x},${victim.position.y},${victim.position.z})`,
        );
        if (!dug) break;
        cleared.push(String(victim.name ?? 'block'));
        result = await stepIntoCell(bot, target);
    }
    return { ...result, cleared };
}

export async function stepIntoCell(
    bot: any,
    target: { x: number; y: number; z: number },
): Promise<StepIntoResult> {
    const readPos = (): { x: number; y: number; z: number } => {
        try {
            const p = bot?.entity?.position;
            return { x: Number(p?.x ?? 0), y: Number(p?.y ?? 0), z: Number(p?.z ?? 0) };
        } catch {
            return { x: 0, y: 0, z: 0 };
        }
    };
    const from = readPos();
    const goal = { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z) };
    const inCell = (): boolean => {
        const p = readPos();
        return Math.floor(p.x) === goal.x && Math.floor(p.y) === goal.y && Math.floor(p.z) === goal.z;
    };
    const blockAt = (x: number, y: number, z: number): { name?: unknown } | null => {
        try {
            return bot.blockAt(new Vec3(x, y, z));
        } catch {
            return null;
        }
    };
    const release = (): void => {
        for (const key of ['forward', 'jump', 'sprint']) {
            try {
                bot.setControlState(key, false);
            } catch {
                // 拿不到控制就尽力而为。
            }
        }
    };
    if (inCell()) return { moved: true, reason: null, attempts: 0, from, to: readPos(), obstacles: [] };
    const climb = goal.y > Math.floor(from.y);
    const attemptsMax = 3;
    for (let attempt = 1; attempt <= attemptsMax; attempt++) {
        try {
            const look = new Vec3(goal.x + 0.5, Math.floor(from.y) + 1.5, goal.z + 0.5);
            if (typeof bot.lookAt === 'function') await bot.lookAt(look, true);
            bot.setControlState('forward', true);
            if (climb) bot.setControlState('jump', true);
            await new Promise<void>((resolve) => setTimeout(resolve, climb ? 900 : 650));
        } catch {
            // 控制失败也要走"测量位移"这一步。
        }
        release();
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        const nowPos = readPos();
        const moved = Math.hypot(nowPos.x - from.x, nowPos.z - from.z) >= 0.35 || inCell();
        if (inCell() || moved) {
            return { moved: true, reason: null, attempts: attempt, from, to: nowPos, obstacles: [] };
        }
    }
    const obstacles = describeStepObstacles(blockAt, goal);
    return {
        moved: false,
        reason:
            '走不进去：' +
            (obstacles.length > 0 ? obstacles.join('；') : '按了前进键但位置没变（可能被顶回或脚下打滑）') +
            '。',
        attempts: attemptsMax,
        from,
        to: readPos(),
        obstacles,
    };
}
