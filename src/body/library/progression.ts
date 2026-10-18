/*
 * 中段推进能力：**系统性探索**（找下界要塞）与**刷怪掉落**（烈焰棒 / 末影珍珠）。
 *
 * 为什么单独有这个文件：夜晚实测（见 tmp/overnight/feedback/TRIAGE.md 第 2、4 条）
 * 里，两个 bot 在下界耗掉几小时也拿不到烈焰棒，根因不在末地，而在中段——
 *   1. `searchForBlock` 只能扫**已加载区块**，一次性扫描 + 回执不说明覆盖范围，
 *      于是"256/512 格搜不到"被模型读成"附近真没有"（它的原话：怀疑只扫已加载区块）；
 *   2. 没有"沿一个方向走一段、再扫一次"的**系统性**探索原语，全靠模型自己
 *      goToCoordinates + searchForBlock 手动拼，走两轮就乱了；
 *   3. 没有"刷够 N 个掉落物"的原语，模型只能一只一只打，还得自己数背包。
 *
 * 本文件的纪律（和前半夜那些 bug 对着来的）：
 *   - **不谎报覆盖范围**：扫描半径 + "只扫已加载区块"这句话必须同时出现在回执里；
 *   - **只认真实增量**：掉落数量一律以背包 before→after 为准，不看掉落物实体是否消失；
 *   - **不吞中断**：`bot.interrupt_code`（Stop / 保命）一置位就带着已完成的部分收手；
 *   - **不走进岩浆**：每腿落地后重新判脚下/身周危险，危险就停手并如实报告；
 *   - **纯逻辑与 bot 操作分开**：航点、回执、掉落表、计数都是纯函数，能离线单测；
 *     走路/攻击/等待走可注入的 deps，测试里换成假实现即可跑完整个流程。
 */

import * as skills from './skills.js';
import * as world from './world.js';

// ────────────────────────────── 默认参数 ──────────────────────────────

/** 每腿落地后重扫的半径。要塞是大型结构，64 格足够；再大就超出已加载范围了。 */
export const DEFAULT_EXPLORE_SCAN_RADIUS = 64;
/** 一腿走多远。下界地形破碎，32 格是一段"能走完、又能明显换地方"的距离。 */
export const DEFAULT_EXPLORE_STEP = 32;
/** 默认最多走几腿（方形螺旋 12 腿 ≈ 覆盖到出发点外 6×32=192 格）。 */
export const DEFAULT_EXPLORE_MAX_STEPS = 12;

/**
 * `exploreFor` 的**内部时间预算**（毫秒）：到点自己收手，照常出 `exploreReceipt`。
 *
 * 为什么必须有：真机 2026-10-18 13:13 的 `exploreFor#3` 跑长后被保险丝强退，模型
 * 只拿到一句"已强制释放动作通道，它可能仍在跑"——没有腿数、没有覆盖范围、没有
 * 坐标、没有下一步，于是它开始反复拍快照空转。**主动收手**才能把结论交出去。
 * 值必须明显小于命令超时（`EXPLORE_TIMEOUT_MIN`），留出最后一腿的寻路时间。
 */
export const DEFAULT_EXPLORE_BUDGET_MS = 4.5 * 60 * 1000;

export const DEFAULT_HUNT_RADIUS = 48;
export const DEFAULT_HUNT_WANT = 4;
/** 刷怪的默认时间预算（5 分钟）。 */
export const DEFAULT_HUNT_MAX_MS = 5 * 60 * 1000;
/** 半径内找不到目标时，等多久再找一次（烈焰人会飘、末影人会瞬移）。 */
export const HUNT_POLL_MS = 1500;
/** 找不到目标连续空转几次就收手（4 × 1.5s = 6 秒）。 */
export const HUNT_IDLE_POLLS = 4;
/** 打完一只后留给掉落物落地/走过去捡的时间。 */
export const HUNT_LOOT_BUDGET_MS = 6000;
/** 血量低于这个值就不再主动刷怪（先把命保住，让模型去吃喝）。 */
export const MIN_HEALTH_TO_HUNT = 6;
/** 等区块加载后额外等的稳定时间。 */
export const CHUNK_SETTLE_MS = 600;

// ─────────────────────────── 名字归一与别名 ───────────────────────────

/**
 * 归一到"小写、下划线、去掉 minecraft: 前缀"。
 *
 * 模型经常写 `Blaze` / `blaze rod` / `minecraft:ender_pearl`，而 mineflayer 的
 * 实体名、物品名、方块名各有各的写法——比较前统一一次，比在每个调用点记规则可靠。
 */
export function normalizeName(raw: unknown): string {
    return String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/^minecraft:/, '')
        .replace(/[\s-]+/g, '_');
}

/**
 * 中文/俗称 → 英文 id。
 *
 * 两个 bot 全程用中文说话和写计划，工具参数却要英文 id（`searchForBlock` 一直是
 * 这么用的）。加一层小别名表，省掉"模型写了烈焰人 → 工具报没找到"这种纯浪费的一轮。
 */
const ALIASES: Record<string, string> = {
    // 方块
    下界砖: 'nether_bricks',
    下界砖块: 'nether_bricks',
    地狱砖: 'nether_bricks',
    黑曜石: 'obsidian',
    下界石英矿: 'nether_quartz_ore',
    石英矿: 'nether_quartz_ore',
    末地石: 'end_stone',
    末地传送门框架: 'end_portal_frame',
    要塞砖: 'stone_bricks',
    石头砖: 'stone_bricks',
    // 实体
    烈焰人: 'blaze',
    烈焰使者: 'blaze',
    末影人: 'enderman',
    安德: 'enderman',
    猪灵: 'piglin',
    僵尸猪灵: 'zombified_piglin',
    僵尸猪人: 'zombified_piglin',
    恶魂: 'ghast',
    岩浆怪: 'magma_cube',
    骷髅: 'skeleton',
    凋灵骷髅: 'wither_skeleton',
    僵尸: 'zombie',
    蜘蛛: 'spider',
    苦力怕: 'creeper',
    爬行者: 'creeper',
    牛: 'cow',
    猪: 'pig',
    鸡: 'chicken',
    羊: 'sheep',
    兔子: 'rabbit',
    疣猪兽: 'hoglin',
};

/** 归一 + 查别名表。查不到就返回归一后的原文（让上层照原样试）。 */
export function resolveName(raw: unknown): string {
    const normalized = normalizeName(raw);
    return ALIASES[normalized] ?? normalized;
}

export const resolveBlockName = resolveName;
export const resolveEntityName = resolveName;

// ───────────────────────────── 探索航点 ─────────────────────────────

export interface FlatPosition {
    x: number;
    y: number;
    z: number;
}

export interface Waypoint {
    /** 第几腿（从 1 开始）。 */
    index: number;
    x: number;
    y: number;
    z: number;
    /** 这一腿要走多少格。 */
    legLength: number;
    /** 方向标签（写进回执，让人看得懂往哪走了）。 */
    direction: string;
}

interface SpiralDirection {
    dx: number;
    dz: number;
    label: string;
}

/** 方形螺旋的方向顺序：东 → 南 → 西 → 北（顺时针）。 */
export const SPIRAL_DIRECTIONS: readonly SpiralDirection[] = Object.freeze([
    { dx: 1, dz: 0, label: '东(+x)' },
    { dx: 0, dz: 1, label: '南(+z)' },
    { dx: -1, dz: 0, label: '西(-x)' },
    { dx: 0, dz: -1, label: '北(-z)' },
]);

/**
 * 方形螺旋航点：腿长 1,1,2,2,3,3…（乘 step），方向东→南→西→北循环。
 *
 * 为什么是螺旋而不是"一直朝一个方向"：要塞/堡垒是**长条**结构，方向猜错就永远
 * 碰不上；螺旋保证不管目标在哪个方向，走出去的距离都会稳定增长，而且每腿都会
 * 回到出发点附近一次，不会像直线那样一去不回。y 保持不变（下界靠走去换地方，
 * 不主动上下挖，避免掉进岩浆湖）。
 */
export function spiralWaypoints(origin: FlatPosition, step: number, maxSteps: number): Waypoint[] {
    const safeStep = Number.isFinite(step) && step > 0 ? Math.round(step) : DEFAULT_EXPLORE_STEP;
    const total = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 0;
    const out: Waypoint[] = [];
    let x = Math.round(origin.x);
    const y = Math.round(origin.y);
    let z = Math.round(origin.z);
    for (let i = 0; i < total; i++) {
        const leg = Math.floor(i / 2) + 1;
        const dir = SPIRAL_DIRECTIONS[i % SPIRAL_DIRECTIONS.length];
        const advance = leg * safeStep;
        x = Math.round(x + dir.dx * advance);
        z = Math.round(z + dir.dz * advance);
        out.push({ index: i + 1, x, y, z, legLength: advance, direction: dir.label });
    }
    return out;
}

/** 走完 N 腿后，离出发点最远的水平距离（写进回执，让模型知道"探到多远了"）。 */
export function spiralReach(step: number, maxSteps: number): number {
    return spiralWaypoints({ x: 0, y: 0, z: 0 }, step, maxSteps).reduce(
        (max, wp) => Math.max(max, Math.hypot(wp.x, wp.z)),
        0,
    );
}

// ─────────────────────────── 掉落物对照表 ───────────────────────────

export interface DropSpec {
    /** 主要掉落物（第一个用于计数）。 */
    items: string[];
    note?: string;
}

const DROP_TABLE: Record<string, DropSpec> = {
    blaze: { items: ['blaze_rod'], note: '烈焰棒 0-1 根（不是必掉），所以"打了没涨"是正常的，继续打。' },
    enderman: { items: ['ender_pearl'], note: '末影珍珠 0-1 颗；末影人怕水，别在水边打。' },
    wither_skeleton: { items: ['coal', 'bone'], note: '凋灵骷髅主要目标是头骨，这里只核对煤/骨头。' },
    skeleton: { items: ['bone', 'arrow'] },
    zombie: { items: ['rotten_flesh'] },
    husk: { items: ['rotten_flesh'] },
    drowned: { items: ['rotten_flesh', 'copper_ingot'] },
    zombified_piglin: { items: ['rotten_flesh', 'gold_nugget'] },
    spider: { items: ['string', 'spider_eye'] },
    cave_spider: { items: ['string', 'spider_eye'] },
    creeper: { items: ['gunpowder'] },
    ghast: { items: ['ghast_tear', 'gunpowder'] },
    magma_cube: { items: ['magma_cream'] },
    slime: { items: ['slime_ball'] },
    piglin: { items: ['gold_nugget'] },
    hoglin: { items: ['porkchop', 'leather'] },
    zoglin: { items: ['rotten_flesh'] },
    cow: { items: ['beef', 'leather'] },
    mooshroom: { items: ['beef', 'leather'] },
    pig: { items: ['porkchop'] },
    chicken: { items: ['chicken', 'feather'] },
    sheep: { items: ['mutton', 'wool'] },
    rabbit: { items: ['rabbit', 'rabbit_hide'] },
    salmon: { items: ['salmon'] },
    cod: { items: ['cod'] },
};

/** 这种怪掉什么。查不到 → `items: []`，上层改成"用背包总件数核对"。 */
export function dropForEntity(entityName: string): DropSpec {
    return DROP_TABLE[normalizeName(entityName)] ?? { items: [] };
}

// ─────────────────────────── 背包计数（真值） ───────────────────────────

/** 背包里某个物品的总数。读不到背包时返回 0，不抛。 */
export function countItem(bot: any, itemName: string): number {
    const target = normalizeName(itemName);
    if (target === '') return 0;
    let total = 0;
    try {
        for (const item of (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>) {
            if (item == null || normalizeName(item.name) !== target) continue;
            const count = Number(item.count);
            // count 缺失才按 1 算；**count === 0 就是 0**（假 bot 和"空堆"都会出现 0）。
            total += Number.isFinite(count) && count >= 0 ? count : 1;
        }
    } catch {
        return 0;
    }
    return total;
}

/** 一组物品的当前数量（掉落核对的基线）。 */
export function countItems(bot: any, items: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const item of items) out[item] = countItem(bot, item);
    return out;
}

/** 背包总件数（掉什么不知道时的兜底核对口径）。 */
export function countTotalItems(bot: any): number {
    let total = 0;
    try {
        for (const item of (bot?.inventory?.items?.() ?? []) as Array<{ count?: unknown }>) {
            const count = Number(item?.count);
            total += Number.isFinite(count) && count >= 0 ? count : 1;
        }
    } catch {
        return 0;
    }
    return total;
}

// ───────────────────────────── 危险判定 ─────────────────────────────

/** 站上去/走过去会掉血的方块。 */
const HAZARD_BLOCKS: ReadonlySet<string> = new Set([
    'lava',
    'flowing_lava',
    'fire',
    'soul_fire',
    'magma_block',
    'campfire',
    'soul_campfire',
    'cactus',
    'sweet_berry_bush',
    'powder_snow',
]);

export function blockNameAt(bot: any, x: number, y: number, z: number): string | null {
    try {
        const block = bot?.blockAt?.({ x, y, z });
        const name = block?.name;
        return typeof name === 'string' ? normalizeName(name) : null;
    } catch {
        return null;
    }
}

/** 当前位置（脚、身、脚下、头）有没有危险方块；有就返回一句人话。 */
export function hazardHere(bot: any): string | null {
    try {
        const p = bot?.entity?.position;
        if (p == null) return null;
        const fx = Math.floor(p.x);
        const fy = Math.floor(p.y);
        const fz = Math.floor(p.z);
        const feet = blockNameAt(bot, fx, fy, fz);
        const below = blockNameAt(bot, fx, fy - 1, fz);
        const head = blockNameAt(bot, fx, fy + 1, fz);
        for (const [name, where] of [
            [feet, '脚所在格'],
            [below, '脚下的方块'],
            [head, '头所在格'],
        ] as Array<[string | null, string]> ) {
            if (name != null && HAZARD_BLOCKS.has(name)) return `${where}是 ${name}`;
        }
        return null;
    } catch {
        return null;
    }
}

export function isInNether(bot: any): boolean {
    const dimension = bot?.game?.dimension;
    return typeof dimension === 'string' && dimension.includes('nether');
}

/**
 * 身上有没有抗火效果。
 *
 * 两个来源都要认：`bot.entity.effects` 的键在有的版本是数字 id、有的是名字，
 * 名字要去 `bot.registry.effects` 里查。查不到就按"没有"处理（宁可多提醒一句）。
 */
export function hasFireResistance(bot: any): boolean {
    let effects: Record<string, any>;
    try {
        effects = (bot?.entity?.effects ?? {}) as Record<string, any>;
    } catch {
        return false;
    }
    const registry: Record<string, any> = (bot?.registry?.effects ?? {}) as Record<string, any>;
    for (const [key, value] of Object.entries(effects)) {
        if (value == null) continue;
        const duration = Number((value as { duration?: unknown }).duration);
        // duration 是 tick；0 或负数表示已过期（有的版本用 -1 表示"永久"，-1 也算有）。
        if (Number.isFinite(duration) && duration === 0) continue;
        const byKey = normalizeName(key);
        const byRegistry = normalizeName(registry[key]?.name ?? registry[key]?.displayName);
        const byName = normalizeName((value as { name?: unknown }).name);
        if ([byKey, byRegistry, byName].some((name) => name.includes('fire_resistance'))) return true;
    }
    return false;
}

// ─────────────────────────────── 回执 ───────────────────────────────

/**
 * 覆盖范围这句话**必须**跟着扫描半径一起出现。
 *
 * `findBlocks` 只遍历客户端已加载的区块：说"扫了 512 格"是假话（前半夜的 bug 就是
 * 这么来的）。64 格通常落在视距内，所以可以说得强一点，但仍然要写清前提。
 */
export function describeCoverage(radius: number): string {
    return (
        `每次重扫半径 ${Math.round(radius)} 格。注意 findBlocks **只扫已加载区块**：` +
        `视距够大时这 ${Math.round(radius)} 格是完整的，视距小于 ${Math.round(radius)} 格时` +
        '边上可能有没扫到的格子；"找到"是真的，"没找到"只代表这次扫过的范围里没有。'
    );
}

/** 把坐标串成 `(x, y, z)`（整数，和快照口径一致）。 */
export function formatPoint(p: FlatPosition | null): string {
    if (p == null) return '(未知)';
    return `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
}

export interface ExploreOutcome {
    block: string;
    scanRadius: number;
    step: number;
    maxSteps: number;
    origin: FlatPosition;
    here: FlatPosition;
    /** 真正走完的腿数（travel 返回 true）。 */
    completedLegs: number;
    /** 尝试过的腿数（含失败）。 */
    attemptedLegs: number;
    /** 寻路失败的腿数。 */
    failedLegs: number;
    /** 实际位移累计（每腿落地后的真实位置差之和，格）。 */
    walkedBlocks: number;
    found: FlatPosition | null;
    foundDistance: number | null;
    interrupted: boolean;
    /** 非空 = 因危险中止。 */
    danger: string | null;
    /** 时间预算到点，自己收手（不是被打断，也不是走完了步数）。 */
    timedOut: boolean;
    /** 本次使用的时间预算（毫秒），写进回执让人能核对。 */
    budgetMs: number;
    /** 方块 id 不在当前版本的注册表里（入参写错了）。 */
    unknownBlock: boolean;
    /** 附加提醒（例如"方块名不认"）。 */
    notes: string[];
}

/**
 * **一条**可照抄的下一步调用。
 *
 * 为什么只给一条：真机实测里 overnight_a 15 分钟 38 次请求有 28 次**一个工具都没调**
 * （模型在原地念念有词）。给它一份"可以这样也可以那样"的建议，等于给它继续念的
 * 空间；给一条带好参数的调用，它才会动。所以这里只返回一个字符串，且必须是
 * 一条合法调用。
 */
export function exploreNextAction(o: ExploreOutcome): string {
    if (o.unknownBlock) return 'stats(type="blocks")';
    if (o.danger != null) return 'moveAway(distance=8)';
    if (o.found != null) {
        return (
            `goToCoordinates(x=${Math.round(o.found.x)}, y=${Math.round(o.found.y)}, ` +
            `z=${Math.round(o.found.z)}, closeness=2)`
        );
    }
    // 时间到/被打断：螺旋还没走完，接着把剩下的腿走完（新螺旋从当前位置起算）。
    if (o.timedOut || o.interrupted) {
        const remaining = Math.max(1, o.maxSteps - o.completedLegs);
        return `exploreFor(block="${o.block}", max_steps=${remaining}, step=${o.step})`;
    }
    // 一腿都没走成：多半是断层/落差，把 step 调小再来。
    if (o.attemptedLegs > 0 && o.completedLegs === 0) return `exploreFor(block="${o.block}", max_steps=8, step=16)`;
    return `exploreFor(block="${o.block}", max_steps=6, step=${o.step})`;
}

export function exploreReceipt(o: ExploreOutcome): string {
    const lines: string[] = [];
    if (o.found != null) {
        lines.push(
            `exploreFor ${o.block}：**found ${o.block} at ${formatPoint(o.found)}**` +
                `（离你 ${(o.foundDistance ?? 0).toFixed(1)} 格）。`,
        );
    } else if (o.danger != null) {
        lines.push(`exploreFor ${o.block}：**中止——${o.danger}**，没找到（不是"附近没有"，是我不敢再走了）。`);
    } else if (o.timedOut) {
        // **时间到必须说清楚**：不是"范围里确定没有"，是"预算用完了、螺旋没走完"。
        lines.push(
            `exploreFor ${o.block}：**时间到（预算 ${Math.round(o.budgetMs / 60000 * 10) / 10} 分钟）主动收手——没走完螺旋**，` +
                `走完 ${o.completedLegs}/${o.maxSteps} 腿；**not found after ${o.completedLegs} steps**（只代表这次扫过的范围里没有）。`,
        );
    } else if (o.interrupted) {
        lines.push(`exploreFor ${o.block}：**被打断（Stop/保命）**，没走完，**not found after ${o.completedLegs} steps**。`);
    } else {
        lines.push(
            `exploreFor ${o.block}：**not found after ${o.maxSteps} steps**` +
                `（走完 ${o.completedLegs} 腿，其中寻路失败 ${o.failedLegs} 腿）。`,
        );
    }
    lines.push(
        `路线：从 ${formatPoint(o.origin)} 到 ${formatPoint(o.here)}，` +
            `实际移动约 ${Math.round(o.walkedBlocks)} 格；` +
            `尝试 ${o.attemptedLegs}/${o.maxSteps} 腿，走完 ${o.completedLegs} 腿，失败 ${o.failedLegs} 腿，每腿 ${o.step} 格。`,
    );
    lines.push(describeCoverage(o.scanRadius));
    if (o.notes.length > 0) for (const note of o.notes) lines.push(note);
    lines.push(`下一步（照做即可）：${exploreNextAction(o)}`);
    return lines.join('\n');
}

export interface HuntProgressLine {
    attempt: number;
    text: string;
}

export interface HuntOutcome {
    entity: string;
    want: number;
    /** 计数的物品；空数组 = 不知道掉什么，用背包总件数核对。 */
    items: string[];
    gained: number;
    baseline: number;
    kills: number;
    attacks: number;
    stopReason: 'reached' | 'budget' | 'no_target' | 'interrupted' | 'low_health' | 'danger' | 'gone';
    elapsedMs: number;
    /** 在下界刷烈焰人（"没怪了"的下一步建议要用它）。 */
    netherBlaze: boolean;
    warnings: string[];
    progress: HuntProgressLine[];
}

const STOP_REASON_TEXT: Record<HuntOutcome['stopReason'], string> = {
    reached: '够数了',
    budget: '到时间预算了',
    no_target: '半径内找不到目标了',
    interrupted: '被 Stop/保命打断',
    low_health: '血量太低，先保命',
    danger: '脚下/身边有危险方块',
    gone: '目标跑掉/消失了',
};

export function huntReceipt(o: HuntOutcome): string {
    const lines: string[] = [];
    const counter = o.items.length > 0 ? `${o.items[0]} ${o.gained}/${o.want}` : `背包总件数 +${o.gained}（不知道这种怪掉什么，只能这么核对）`;
    const head = `huntFor ${o.entity}：**${counter}**（起手 ${o.baseline}）`;
    const tail = `攻击 ${o.attacks} 次、击杀 ${o.kills} 只，用了 ${Math.round(o.elapsedMs / 1000)} 秒；停止原因：${STOP_REASON_TEXT[o.stopReason]}。`;
    lines.push(`${head}；${tail}`);
    if (o.items.length === 0) {
        lines.push('⚠️ 掉落表里没有这种怪：**只报攻击/击杀次数**，没有可靠的"到手几个"依据——请用 stats 核对背包。');
    }
    for (const warning of o.warnings) lines.push(warning);
    if (o.progress.length > 0) {
        lines.push('进度：');
        for (const line of o.progress) lines.push(`- #${line.attempt} ${line.text}`);
    }
    lines.push(`下一步（照做即可）：${huntNextAction(o)}`);
    return lines.join('\n');
}

/** 和 `exploreNextAction` 同一条理由：只给**一条**能照抄的调用，别给菜单。 */
export function huntNextAction(o: HuntOutcome): string {
    const remaining = Math.max(1, o.want - o.gained);
    switch (o.stopReason) {
        case 'reached':
            return 'stats(type="inventory")';
        case 'budget':
        case 'interrupted':
        case 'gone':
            return `huntFor(entity="${o.entity}", want=${remaining}, max_ms=300000)`;
        case 'no_target':
            // 下界刷烈焰人：没怪 = 这附近没有堡垒房间，回去继续找要塞。
            return o.netherBlaze
                ? 'exploreFor(block="nether_bricks", max_steps=4)'
                : 'move(direction="north", distance=16)';
        case 'low_health':
            return 'survivalCheck';
        case 'danger':
            return 'moveAway(distance=8)';
        default:
            return `huntFor(entity="${o.entity}", want=${remaining})`;
    }
}

// ─────────────────────────── 探索（技能） ───────────────────────────

export interface ExploreDeps {
    /** 走到某个坐标；返回是否真的到了。默认走 skills.goToPosition。 */
    travel?: (bot: any, x: number, y: number, z: number) => Promise<boolean>;
    /** 重扫目标方块；返回最近的那个的坐标。默认用 world.getNearestBlocksWhere（认中断）。 */
    scan?: (bot: any, block: string, radius: number) => FlatPosition | null;
    /** 等区块加载。默认 bot.waitForChunksToLoad + 一点稳定时间。 */
    settle?: (bot: any) => Promise<void>;
    /** 让出事件循环。 */
    sleep?: (ms: number) => Promise<void>;
    /** 取当前位置。 */
    position?: (bot: any) => FlatPosition;
    /** 取当前时间；测试里换成假时钟（时间预算靠它判）。 */
    now?: () => number;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function defaultPosition(bot: any): FlatPosition {
    const p = bot?.entity?.position;
    return { x: Number(p?.x ?? 0), y: Number(p?.y ?? 0), z: Number(p?.z ?? 0) };
}

/**
 * 默认扫描：**用谓词版**而不是 `world.getNearestBlock`。
 *
 * 后者走 `mc.getBlockId`，而 mcdata 在没连服务器时是 null → 直接 TypeError。
 * 谓词版只比名字，还能顺手拿到 `getNearestBlocksWhere` 里的中断处理。
 */
function defaultScan(bot: any, block: string, radius: number): FlatPosition | null {
    const found = world.getNearestBlocksWhere(bot, (b: any) => normalizeName(b?.name) === block, radius, 1);
    const position = found[0]?.position;
    if (position == null) return null;
    return { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
}

async function defaultSettle(bot: any): Promise<void> {
    try {
        if (typeof bot?.waitForChunksToLoad === 'function') await bot.waitForChunksToLoad();
    } catch {
        // 拿不到就算了：下面还有一段固定等待兜底。
    }
    await sleepMs(CHUNK_SETTLE_MS);
}

export interface ExploreOptions {
    /** 每腿落地后重扫的半径。 */
    scanRadius?: number;
    /** 防止调用方传进不合理的大数把身体通道占死。 */
    maxStepsLimit?: number;
    /**
     * 内部时间预算（毫秒）。到点**自己收手**并照常出完整回执。
     * 默认 `DEFAULT_EXPLORE_BUDGET_MS`；必须小于命令超时。
     */
    budgetMs?: number;
}

/**
 * 系统性探索：走一段 → 重扫 → 再走一段，直到找到或走完 max_steps。
 *
 * 中断语义：`bot.interrupt_code` 一置位就**带着已完成的部分收手**（回执里写清
 * 走到哪、扫了多少），不吞掉 Stop/保命——这条是硬要求（前半夜的幽灵锁就是因为
 * 动作吞中断还占着通道）。
 */
export async function exploreForSkill(
    bot: any,
    rawBlock: string,
    rawMaxSteps?: unknown,
    rawStep?: unknown,
    deps: ExploreDeps = {},
    options: ExploreOptions = {},
): Promise<string> {
    const block = resolveBlockName(rawBlock);
    const scanRadius = options.scanRadius ?? DEFAULT_EXPLORE_SCAN_RADIUS;
    const maxSteps = clampInt(rawMaxSteps, DEFAULT_EXPLORE_MAX_STEPS, 1, options.maxStepsLimit ?? 64);
    const step = clampInt(rawStep, DEFAULT_EXPLORE_STEP, 4, 128);

    const travel = deps.travel ?? ((b: any, x: number, y: number, z: number) => skills.goToPosition(b, x, y, z, 3));
    const scan = deps.scan ?? defaultScan;
    const settle = deps.settle ?? defaultSettle;
    const sleep = deps.sleep ?? sleepMs;
    const position = deps.position ?? defaultPosition;
    const now = deps.now ?? Date.now;
    const budgetMs = options.budgetMs ?? DEFAULT_EXPLORE_BUDGET_MS;
    const startedAt = now();

    const notes: string[] = [];
    const origin = position(bot);
    const outcome: ExploreOutcome = {
        block,
        scanRadius,
        step,
        maxSteps,
        origin,
        here: origin,
        completedLegs: 0,
        attemptedLegs: 0,
        failedLegs: 0,
        walkedBlocks: 0,
        found: null,
        foundDistance: null,
        interrupted: false,
        danger: null,
        timedOut: false,
        budgetMs,
        unknownBlock: false,
        notes,
    };

    // 名字不认就直说：白走 12 腿是纯浪费（`searchForBlock` 不认名字时是静默的）。
    const registry = bot?.registry?.blocksByName;
    if (registry != null && typeof registry === 'object' && registry[block] == null) {
        outcome.unknownBlock = true;
        notes.push(
            `⚠️ 当前版本的方块表里没有 "${block}"（原始入参 "${String(rawBlock)}"）：` +
                '先用 searchForBlock/stats 确认真实方块 id，再重试——这次只做了原地扫描。',
        );
    }

    bot && (bot.interrupt_code = bot.interrupt_code === true);

    // 先原地扫一次：可能它就在身边（省掉 12 腿）。
    const immediate = scan(bot, block, scanRadius);
    if (immediate != null) {
        outcome.found = immediate;
        outcome.foundDistance = horizontalDistance(origin, immediate);
        return exploreReceipt(outcome);
    }

    for (const waypoint of spiralWaypoints(origin, step, maxSteps)) {
        // **时间预算**：到点自己收手，走正常回执（腿数/覆盖/坐标/下一步）。
        // 顺序放在最前：宁可少走一腿，也不要被命令超时/保险丝截胡——那条路
        // 上模型只能拿到一句"已强制释放动作通道"，等于没结论。
        if (now() - startedAt >= budgetMs) {
            outcome.timedOut = true;
            break;
        }
        if (bot?.interrupt_code === true) {
            outcome.interrupted = true;
            break;
        }
        const dangerBefore = hazardHere(bot);
        if (dangerBefore != null) {
            outcome.danger = dangerBefore;
            break;
        }
        const before = position(bot);
        outcome.attemptedLegs += 1;
        const arrived = await travel(bot, waypoint.x, waypoint.y, waypoint.z);
        const after = position(bot);
        outcome.here = after;
        outcome.walkedBlocks += horizontalDistance(before, after);
        if (arrived) outcome.completedLegs += 1;
        else outcome.failedLegs += 1;

        if (bot?.interrupt_code === true) {
            outcome.interrupted = true;
            break;
        }
        // 落地后重新判危险：走过去的过程中可能正好踩到岩浆边上。
        const dangerAfter = hazardHere(bot);
        if (dangerAfter != null) {
            outcome.danger = dangerAfter;
            break;
        }
        if (!arrived) {
            // 这一腿没走成：多半是断路/落差。别在原地死磕，直接下一腿。
            await sleep(50);
            continue;
        }
        await settle(bot);
        const found = scan(bot, block, scanRadius);
        if (found != null) {
            outcome.found = found;
            outcome.foundDistance = horizontalDistance(position(bot), found);
            break;
        }
    }

    outcome.here = position(bot);
    if (outcome.found == null && outcome.completedLegs === 0 && outcome.attemptedLegs >= maxSteps && outcome.danger == null && !outcome.interrupted) {
        notes.push('⚠️ 每一腿都没走到（寻路全失败）：先 goToCoordinates 挪到一个能走通的位置，或换 step 更小的一轮。');
    }
    return exploreReceipt(outcome);
}

function horizontalDistance(a: FlatPosition, b: FlatPosition): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

// ─────────────────────────── 刷怪（技能） ───────────────────────────

export interface HuntDeps {
    /** 找最近的某类实体。默认用 world.getNearestEntityWhere。 */
    findEntity?: (bot: any, entity: string, radius: number) => any | null;
    /** 找最近的地面掉落物（模型动作期间自动拾取是停的，得自己走过去踩）。 */
    findDrop?: (bot: any, radius: number) => any | null;
    /** 打一只；返回是否击杀。默认走 skills.attackTarget。 */
    attack?: (bot: any, entity: string) => Promise<boolean>;
    /** 走过去（捡掉落物用）。默认 skills.goToPosition。 */
    travel?: (bot: any, x: number, y: number, z: number, closeness: number) => Promise<boolean>;
    /** 让出事件循环；测试里换成假时钟。 */
    sleep?: (ms: number) => Promise<void>;
    /** 取当前时间；测试里换成假时钟。 */
    now?: () => number;
    /** 血量。 */
    health?: (bot: any) => number;
}

function defaultFindEntity(bot: any, entity: string, radius: number): any | null {
    return world.getNearestEntityWhere(bot, (e: any) => normalizeName(e?.name) === entity, radius);
}

function defaultFindDrop(bot: any, radius: number): any | null {
    return world.getNearestEntityWhere(bot, (e: any) => e?.name === 'Item', radius);
}

/**
 * 刷够 N 个掉落物。
 *
 * 循环：找怪 → 打 → **走过去捡** → 用背包真实增量核对 → 不够继续。
 *
 * 为什么必须自己走过去捡：`8af82db` 之后自动拾取在**任何模型动作在途时都被禁止**，
 * 而 huntFor 就是一个模型动作——所以打完不走过去，战利品会一直躺在地上，而"核对
 * 真实增量"会永远不涨。这是实测出来的坑，不是理论担忧。
 */
export async function huntForSkill(
    bot: any,
    rawEntity: string,
    rawWant?: unknown,
    rawRadius?: unknown,
    rawMaxMs?: unknown,
    deps: HuntDeps = {},
): Promise<string> {
    const entity = resolveEntityName(rawEntity);
    const want = clampInt(rawWant, DEFAULT_HUNT_WANT, 1, 64);
    const radius = clampInt(rawRadius, DEFAULT_HUNT_RADIUS, 8, 128);
    const maxMs = clampInt(rawMaxMs, DEFAULT_HUNT_MAX_MS, 5_000, 15 * 60 * 1000);

    const findEntity = deps.findEntity ?? defaultFindEntity;
    const findDrop = deps.findDrop ?? defaultFindDrop;
    const attack = deps.attack ?? ((b: any, name: string) => skills.attackTarget(b, name, 'entity', true));
    const travel = deps.travel ?? ((b: any, x: number, y: number, z: number, closeness: number) => skills.goToPosition(b, x, y, z, closeness));
    const sleep = deps.sleep ?? sleepMs;
    const now = deps.now ?? Date.now;
    const health = deps.health ?? ((b: any) => Number(b?.health ?? 20));

    const dropSpec = dropForEntity(entity);
    const items = dropSpec.items.slice(0, 1);
    const baselineAtStart = items.length > 0 ? countItem(bot, items[0]) : countTotalItems(bot);
    const startedAt = now();

    const warnings: string[] = [];
    const progress: HuntProgressLine[] = [];
    let attempts = 0;
    let kills = 0;
    let idlePolls = 0;
    let stopReason: HuntOutcome['stopReason'] = 'budget';

    if (dropSpec.note != null) warnings.push(`ℹ️ ${dropSpec.note}`);
    const netherBlaze = isInNether(bot) && entity === 'blaze';
    if (netherBlaze && !hasFireResistance(bot)) {
        warnings.push(
            '⚠️ 没有抗火 Buff：烈焰人的火球和贴身火焰会掉血很快。**先 prepareBlaze 喝下抗火药水**再来刷；' +
                '这次仍会打，但血量低于 ' + String(MIN_HEALTH_TO_HUNT) + ' 会立刻停手。',
        );
    }
    const dangerStart = hazardHere(bot);
    if (dangerStart != null) {
        warnings.push(`⚠️ 起手时${dangerStart}：先离开危险格再刷。`);
        return huntReceipt({
            entity,
            want,
            items,
            gained: 0,
            baseline: baselineAtStart,
            kills: 0,
            attacks: 0,
            stopReason: 'danger',
            elapsedMs: 0,
            netherBlaze,
            warnings,
            progress,
        });
    }

    for (;;) {
        if (bot?.interrupt_code === true) {
            stopReason = 'interrupted';
            break;
        }
        if (now() - startedAt > maxMs) {
            stopReason = 'budget';
            break;
        }
        if (health(bot) <= MIN_HEALTH_TO_HUNT) {
            warnings.push(`⚠️ 血量 ${health(bot)} ≤ ${MIN_HEALTH_TO_HUNT}：停手保命，先吃喝/撤退。`);
            stopReason = 'low_health';
            break;
        }
        const danger = hazardHere(bot);
        if (danger != null) {
            warnings.push(`⚠️ ${danger}：停手。`);
            stopReason = 'danger';
            break;
        }
        const gainedNow = currentGain(bot, items, baselineAtStart);
        if (gainedNow >= want) {
            stopReason = 'reached';
            break;
        }

        const target = findEntity(bot, entity, radius);
        if (target == null) {
            idlePolls += 1;
            if (idlePolls >= HUNT_IDLE_POLLS) {
                stopReason = 'no_target';
                break;
            }
            await sleep(HUNT_POLL_MS);
            continue;
        }
        idlePolls = 0;
        attempts += 1;
        const before = currentGain(bot, items, baselineAtStart);
        const killed = await attack(bot, entity);
        if (killed) kills += 1;
        // 掉落物要自己走过去踩（模型动作期间自动拾取是停的）。
        const looted = await collectDrops(bot, radius, HUNT_LOOT_BUDGET_MS, {
            findDrop,
            travel,
            sleep,
            now,
            items,
            baselineAtStart,
        });
        const after = looted.total;
        const delta = after - before;
        const counter = items.length > 0 ? `${items[0]} ${after}/${want}` : `背包总件数 ${after}/${want}`;
        progress.push({
            attempt: attempts,
            text: `${killed ? '击杀' : '没打死'} ${entity}；捡到 ${looted.picked} 个掉落物；${counter}${delta > 0 ? '' : '（这次没涨）'}`,
        });
        if (progress.length > 12) progress.splice(0, progress.length - 12);
    }

    const gained = currentGain(bot, items, baselineAtStart);
    return huntReceipt({
        entity,
        want,
        items,
        gained,
        baseline: baselineAtStart,
        kills,
        attacks: attempts,
        stopReason,
        elapsedMs: now() - startedAt,
        netherBlaze,
        warnings,
        progress,
    });
}

/** 当前累计到手数（相对起手基线的真实增量，只算正数）。 */
function currentGain(bot: any, items: readonly string[], baselineAtStart: number): number {
    if (items.length === 0) return Math.max(0, countTotalItems(bot) - baselineAtStart);
    return Math.max(0, countItem(bot, items[0]) - baselineAtStart);
}

interface CollectDeps {
    findDrop: (bot: any, radius: number) => any | null;
    travel: (bot: any, x: number, y: number, z: number, closeness: number) => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    items: readonly string[];
    baselineAtStart: number;
}

/**
 * 走过去把附近的掉落物踩掉，返回**核对出来的**累计到手数。
 *
 * 返回的 `total` 一律走背包计数（不是"我走了几步"），所以调用方可以直接拿它当
 * "到手几个"用——这就是"只认真实增量"的落点。
 */
export async function collectDrops(
    bot: any,
    radius: number,
    budgetMs: number,
    deps: CollectDeps,
): Promise<{ picked: number; total: number }> {
    const deadline = deps.now() + budgetMs;
    const startTotal = currentGain(bot, deps.items, deps.baselineAtStart);
    let picked = 0;
    while (deps.now() < deadline) {
        if (bot?.interrupt_code === true) break;
        const drop = deps.findDrop(bot, radius);
        if (drop?.position == null) break;
        const before = currentGain(bot, deps.items, deps.baselineAtStart);
        const arrived = await deps.travel(bot, drop.position.x, drop.position.y, drop.position.z, 1);
        await deps.sleep(250);
        const after = currentGain(bot, deps.items, deps.baselineAtStart);
        picked += Math.max(0, after - before);
        // 走不过去 + 没进账：别再对着同一个掉落物死循环。
        if (!arrived && after === before) break;
    }
    const total = Math.max(startTotal, currentGain(bot, deps.items, deps.baselineAtStart));
    return { picked, total };
}
