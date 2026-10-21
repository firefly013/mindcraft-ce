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
import { chooseToolForJob } from './tool_choice.js';
import { isLandAnimal, planWaterHuntStop } from './hunt_reach.js';
import type { ToolCandidate } from './tool_choice.js';
import * as world from './world.js';
import { Vec3 } from 'vec3';
import { nearestDropWithin } from '../auto_pickup.js';
import { foodValueOf } from '../safety/emergency.js';

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

/**
 * 内部打怪的 `type`。**`attack` 只认 id / player / mob**，而这里要的是"按实体类型取最近的"。
 *
 * 真机事故（2026-10-18 19:19，overnight_a）：这里原来传的是 `'entity'`，于是每一次攻击都在
 * `resolveAttackTarget` 里被拒（「type 必填，且只认id / player / mob（收到 "entity"）。」）。
 * 配上当时"只按墙钟预算收口"的循环，5 分钟里空转 **315 万次**，每次 `log()` 都往
 * `bot.output` 追加一行 → 回执 **1.35 亿字符**，把整段上下文打爆（F-21 的上游原因之一）。
 *
 * 所以：类型写成常量（能被"用真实 schema 校验"的测试钉住），循环有**次数上限 + 连续失败熔断**，
 * 回执有**硬长度上限**。这三样缺一，同样的爆法就会再发生一次。
 */
export const HUNT_ATTACK_TYPE = 'mob';
/** 同一个目标至少允许尝试打几次（按 want 放宽，见 `huntMaxAttempts`）。 */
export const HUNT_MAX_ATTEMPTS = 12;
export const HUNT_MAX_ATTEMPTS_CAP = 64;
/** 连续失败这么多次 → 认定"内部动作坏了"，立刻停手（不再空转）。**只对"快失败"计数**（见下）。 */
export const HUNT_MAX_CONSECUTIVE_FAILURES = 3;
/** 同一个目标连续这么多"打不死"就熔断（真机：同一只末影人打了 12 轮、0 个珍珠）。 */
export const HUNT_MAX_SAME_TARGET_FAILURES = 5;
/** "快失败"的界线（毫秒）：一次攻击**几秒内**就返回 false = 调用本身被拒/解析错/服务端拒绝，
 * 这类才可能意味着内部动作坏了。
 *
 * 真机反例（独立复核探针）：`attackEntity` 的击杀死等预算耗尽（90 秒）也返回 false——
 * 那是"**打不死**"（耐打的怪/在回血/输出不够），不是工具坏了。原来两种都算进熔断，
 * 于是三只耐打的怪就让回执说「内部打怪动作可能有问题」，还打发模型去 `attack` 调工具——
 * 而工具其实是好的，模型被自己的回执骗了。所以：慢失败**不计入**熔断，措辞和下一步都分开。
 */
export const HUNT_FAST_FAILURE_MS = 5_000;
/** 打失败后的退避（随连续失败翻倍，封顶）。 */
export const HUNT_ATTACK_BACKOFF_MS = 400;
export const HUNT_ATTACK_BACKOFF_MAX_MS = 3_000;
/**
 * 回执硬上限（字符）。**循环里拼出来的字符串必须有天花板**——
 * 不能指望下游的 clamp 兜：那只能掩盖爆炸，救不回已经烧掉的 315 万次迭代。
 */
export const HUNT_RECEIPT_MAX_CHARS = 12_000;
/** 回执里最多渲染几条警告 / 进度。 */
export const HUNT_MAX_WARNING_LINES = 8;
export const HUNT_MAX_PROGRESS_LINES = 12;

/**
 * 这次最多尝试打几次：至少 `HUNT_MAX_ATTEMPTS`，按需求数放宽（每只要 2 次余量），封顶 64。
 * 纯函数，方便单测钉住"不会无限重试"。
 */
export function huntMaxAttempts(want: number): number {
    const safeWant = Number.isFinite(want) && want > 0 ? Math.floor(want) : 1;
    return Math.max(HUNT_MAX_ATTEMPTS, Math.min(HUNT_MAX_ATTEMPTS_CAP, safeWant * 2));
}

/** 连续失败第 n 次后的退避（指数，封顶）。 */
export function huntBackoffMs(consecutiveFailures: number): number {
    const n = Number.isFinite(consecutiveFailures) && consecutiveFailures > 0 ? Math.floor(consecutiveFailures) : 1;
    return Math.min(HUNT_ATTACK_BACKOFF_MS * 2 ** (n - 1), HUNT_ATTACK_BACKOFF_MAX_MS);
}

/**
 * 通用"拼字符串前的天花板"：只留前 max 条，并**如实写明省略了多少条**。
 * 回执里的每个列表（警告/进度/提示）都走它，谁也别想靠长度绕过。
 */
export function capLines(lines: readonly string[], max: number, label: string): string[] {
    if (lines.length <= max) return [...lines];
    return [...lines.slice(0, max), `…（还有 ${lines.length - max} 条${label}省略：回执有硬长度上限，这里只留前 ${max} 条）`];
}

/** 整段回执的硬上限：超了就保留**头部 + 尾部**（尾部带"下一步"），中间写明省略了多少字符。 */
export function capReceipt(text: string, max: number = HUNT_RECEIPT_MAX_CHARS): string {
    if (text.length <= max) return text;
    const headBudget = Math.floor(max * 0.6);
    const notice = `\n…（回执过长：中间省略 ${text.length - max} 字符）…\n`;
    const tailBudget = Math.max(0, max - headBudget - notice.length);
    return `${text.slice(0, headBudget)}${notice}${text.slice(text.length - tailBudget)}`;
}

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

// ─────────────────── 不漏扫的几何保证（构造性，不靠调参） ───────────────────

/**
 * 一腿最长 = `MAX_LEG_PER_SCAN_RATIO × 扫描半径`。
 *
 * **这是"走过去了就扫过"的构造性保证。** 扫描只发生在每一腿的落点，所以路径上
 * 离扫描中心最远的点就是相邻两腿之间的中点，距离 = 腿长/2：
 *   - 腿长 = 2×半径 → 相邻两个扫描球**外切**，切点正好落在覆盖边界上；
 *   - 再叠加纵向差（真机实测：要塞 y≈70、机器人 y≈53，差 17 格 → 水平可达半径
 *     只剩 √(64²−17²) ≈ 61.7 格），"外切"就变成了真实的漏扫缝——机器人从要塞
 *     旁边走过去也看不见（`overnight_b` 05:24Z：两个圆心的 exploreFor 都没命中）。
 * 取 0.75×半径后，路径上任意一点到最近扫描中心 ≤ 0.375×半径：一半以上的半径
 * 留给了纵向差与"目标方块中心不在球心"的误差。**不用把半径调大**（那会真的变慢）。
 */
export const MAX_LEG_PER_SCAN_RATIO = 0.75;

/** 一腿最长多少格（按扫描半径算）。 */
export function maxLegPerScan(scanRadius: number): number {
    const radius = Number.isFinite(scanRadius) && scanRadius > 0 ? scanRadius : DEFAULT_EXPLORE_SCAN_RADIUS;
    return Math.max(1, Math.floor(radius * MAX_LEG_PER_SCAN_RATIO));
}

/**
 * 螺旋的**走+扫路径**：把每条原始腿按 `maxLeg` 切分，保证**相邻两点距离 ≤ maxLeg**。
 *
 * 为什么不直接改 `spiralWaypoints`：那是"螺旋的几何形状"（`spiralReach` 与既有测试
 * 都用它）。这个函数才是"实际会走、且每一步落点都会扫"的序列——于是"有没有漏扫"
 * 有了单一判据：相邻点距离 ≤ `maxLegPerScan(radius)`。
 */
export function spiralScanPath(origin: FlatPosition, step: number, maxSteps: number, maxLeg: number): Waypoint[] {
    const raw = spiralWaypoints(origin, step, maxSteps);
    const cap = Number.isFinite(maxLeg) && maxLeg >= 1 ? Math.floor(maxLeg) : DEFAULT_EXPLORE_STEP;
    const out: Waypoint[] = [];
    let prev: FlatPosition = { x: Math.round(origin.x), y: Math.round(origin.y), z: Math.round(origin.z) };
    let index = 0;
    for (const target of raw) {
        const dx = target.x - prev.x;
        const dz = target.z - prev.z;
        const length = Math.hypot(dx, dz);
        const parts = Math.max(1, Math.ceil(length / cap));
        for (let k = 1; k <= parts; k++) {
            const ratio = k / parts;
            index += 1;
            out.push({
                index,
                x: Math.round(prev.x + dx * ratio),
                y: target.y,
                z: Math.round(prev.z + dz * ratio),
                legLength: Math.round(length / parts),
                direction: target.direction,
            });
        }
        prev = { x: target.x, y: target.y, z: target.z };
    }
    return out;
}

/** 点到一组"扫描中心"的最近距离（3D；扫描用的是 3D 距离）。 */
export function nearestCentreDistance(point: FlatPosition, centres: readonly FlatPosition[]): number {
    let best = Number.POSITIVE_INFINITY;
    for (const centre of centres) {
        const d = Math.hypot(point.x - centre.x, point.y - centre.y, point.z - centre.z);
        if (d < best) best = d;
    }
    return best;
}

/**
 * **路径上任意一点**（origin → w1 → … → wn，按 1 格采样）到最近扫描中心的最大距离。
 *
 * 为什么用采样而不是"腿长/2"这个解析式：解析式只对两中心的中点成立，而这里要证的
 * 是"沿着真正会走的那条折线，没有一步走到没扫过的地方"——采样把取整、y 不变、
 * 非等分切分这些实现细节全都算进去。没有扫描中心时返回 `Infinity`。
 */
export function worstCoverageDistance(path: readonly FlatPosition[], centres: readonly FlatPosition[]): number {
    if (centres.length === 0) return Number.POSITIVE_INFINITY;
    let worst = 0;
    const sample = (point: FlatPosition): void => {
        const d = nearestCentreDistance(point, centres);
        if (d > worst) worst = d;
    };
    if (path.length > 0) sample(path[0]);
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const b = path[i];
        const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        const steps = Math.max(1, Math.ceil(length));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            sample({
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }
    return worst;
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

/**
 * 把一个坐标包成 `bot.blockAt()` **真正接受**的类型。
 *
 * ⚠️ **真机事故（2026-10-18 17:14，overnight_a）**：这里以前直接传普通对象
 * `{ x, y, z }`。mineflayer 的 `blockAt` 转给 prismarine-world 的
 * `getBlock(pos)`，而后者第一件事就是 `pos.floored()` ——
 * **普通对象没有这个方法，直接抛 TypeError**，被外面的 `try/catch` 吞成 `null`。
 * 结果：`mineTunnel` 永远报「读不到方块（区块没加载？），不敢瞎挖」，**一格都挖不动**
 * （两个候选点、连续两次 0/64），而单元测试全绿——因为替身 `blockAt` 收普通对象也认。
 *
 * 所以这里**必须**给 `Vec3`。`nether_portal.ts` 里同一个功能一直是对的，因为它用了
 * `new Vec3(...)`；这处是漏网的那份。替身请照真实 API 写：**参数没有 `.floored()`
 * 就抛错**，否则这种 bug 还会再溜进来一次。
 */
export function vec3At(x: number, y: number, z: number): any {
    return new Vec3(x, y, z);
}

export function blockNameAt(bot: any, x: number, y: number, z: number): string | null {
    try {
        const block = bot?.blockAt?.(vec3At(x, y, z));
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

/** 末影人（含被改名/带 id 后缀的写法）：它们的"消失又出现"是瞬移，不是死亡。 */
export function isEndermanName(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    return normalizeName(name).replace(/#.*$/, '').trim() === 'enderman';
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
        `每次重扫半径 ${Math.round(radius)} 格，**每腿 ≤ ${maxLegPerScan(radius)} 格（=0.75×半径）**：` +
        '相邻两次扫描的球是重叠的，所以**走过的路径上任意一点都在某个扫描球里**（不会出现"走过去了却没扫到"）。' +
        '注意 findBlocks **只扫已加载区块**：视距够大时这些格子是完整的，视距小于扫描半径时' +
        `边上可能仍有没扫到的格子；"找到"是真的，"没找到"只代表这次扫过的范围里没有。`
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
    /** 计划要走+扫的步数（`spiralScanPath` 的长度；长腿会被切成多步以保证不漏扫）。 */
    maxSteps: number;
    /** 模型给的原始"螺旋腿数"（下一次调用照它继续）。 */
    requestedLegs: number;
    /** 一步最长多少格（=0.75×扫描半径）。 */
    maxLeg: number;
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
/**
 * "这一带真没有"之后，一次往同一方向走多远（格）。
 *
 * 世界存档分析了已探索的下界区块（chunk x −32..63 / z −32..31，8 个 region 文件）
 * 里**一块 `nether_bricks` 都没有**——所以"没找到"往往是"真没有，得走更远"，
 * 不是工具坏了。绕圈重扫同一片区域不会变出方块，只有走出去才有用；
 * 真人给的判据是"沿一个轴至少走 400 格"，这里给一次 300 格的跳步（重复一次就够）。
 */
const WALK_FURTHER_BLOCKS = 300;

/** 空手而归时：沿这一轮**实际推进最多的轴**继续走的坐标。 */
function walkFurtherTarget(o: ExploreOutcome): FlatPosition {
    const dx = o.here.x - o.origin.x;
    const dz = o.here.z - o.origin.z;
    if (Math.abs(dx) >= Math.abs(dz)) {
        return { x: o.here.x + (dx < 0 ? -WALK_FURTHER_BLOCKS : WALK_FURTHER_BLOCKS), y: o.here.y, z: o.here.z };
    }
    return { x: o.here.x, y: o.here.y, z: o.here.z + (dz < 0 ? -WALK_FURTHER_BLOCKS : WALK_FURTHER_BLOCKS) };
}

export function exploreNextAction(o: ExploreOutcome): string {
    if (o.unknownBlock) return 'stats(type="blocks")';
    if (o.danger != null) return 'moveAway(distance=8)';
    if (o.found != null) {
        return (
            `goToCoordinates(x=${Math.round(o.found.x)}, y=${Math.round(o.found.y)}, ` +
            `z=${Math.round(o.found.z)}, closeness=2)`
        );
    }
    // 时间到/被打断：螺旋还没走完，接着跑一轮（新螺旋从当前位置重新起算）。
    if (o.timedOut || o.interrupted) {
        return `exploreFor(block="${o.block}", max_steps=${o.requestedLegs}, step=${o.step})`;
    }
    // 一腿都没走成：多半是断层/落差，把 step 调小再来。
    if (o.attemptedLegs > 0 && o.completedLegs === 0) return `exploreFor(block="${o.block}", max_steps=8, step=16)`;
    // 这一带扫完了、确定没有 → **换地方**，别再原地绕。
    if (o.completedLegs > 0) {
        const target = walkFurtherTarget(o);
        return `goToCoordinates(x=${Math.round(target.x)}, y=${Math.round(target.y)}, z=${Math.round(target.z)}, closeness=2)`;
    }
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
                `走完 ${o.completedLegs}/${o.maxSteps} 步；**not found after ${o.completedLegs} steps**（只代表这次扫过的范围里没有）。`,
        );
    } else if (o.interrupted) {
        lines.push(`exploreFor ${o.block}：**被打断（Stop/保命）**，没走完，**not found after ${o.completedLegs} steps**。`);
    } else {
        lines.push(
            `exploreFor ${o.block}：**not found after ${o.maxSteps} steps**` +
                `（走完 ${o.completedLegs} 步，其中寻路失败 ${o.failedLegs} 步）。`,
        );
    }
    lines.push(
        `路线：从 ${formatPoint(o.origin)} 到 ${formatPoint(o.here)}，` +
            `实际移动约 ${Math.round(o.walkedBlocks)} 格；` +
            `尝试 ${o.attemptedLegs}/${o.maxSteps} 步，走完 ${o.completedLegs} 步，失败 ${o.failedLegs} 步，` +
            `每步 ≤ ${o.maxLeg} 格（原始螺旋 ${o.requestedLegs} 腿，长腿已切段以保证不漏扫）。`,
    );
    lines.push(describeCoverage(o.scanRadius));
    // 扫完了、确定没有：把"这意味着什么"说清楚。否则模型会把 "not found"
    // 读成"工具坏了"，然后原地反复重扫（真机反馈就是这么来的）。
    if (o.found == null && o.danger == null && !o.timedOut && !o.interrupted && !o.unknownBlock && o.completedLegs > 0) {
        const reach = Math.round(spiralReach(o.step, o.requestedLegs));
        lines.push(
            `**结论：这一带（约 ${reach} 格内）已加载范围内确定没有 ${o.block}——不是工具坏了，是真没有。**` +
                `同一片区域再扫一遍不会变出方块；**继续沿同一方向走**（至少 400 格，` +
                `照下面这条走一次 ≈ ${WALK_FURTHER_BLOCKS} 格、重复一次就够）再 exploreFor，才有新区块。` +
                `（参考：已探索过的下界区块里一块 nether_bricks 都没有。）`,
        );
    }
    if (o.notes.length > 0) for (const note of capLines(o.notes, HUNT_MAX_WARNING_LINES, '提示')) lines.push(note);
    lines.push(`下一步（照做即可）：${exploreNextAction(o)}`);
    // 同 huntReceipt：**拼出来的东西必须有天花板**（真机教训见 HUNT_RECEIPT_MAX_CHARS）。
    return capReceipt(lines.join('\n'));
}

export interface HuntProgressLine {
    attempt: number;
    text: string;
}

export interface HuntOutcome {
    entity: string;
    want: number;
    /** 找怪用的半径（回执里要写清"这一带确实没有"的范围）。 */
    radius?: number;
    /**
     * 被动动物 `no_target` 时的"家底"（种子/线/木棍/腐肉 + 最近的水）。
     * 有它 = 回执要给可再生食物路线，主行动也从这里挑（不是"换个地方再找找"）。
     */
    assets?: FoodRouteAssets;
    /** 计数的物品；空数组 = 不知道掉什么，用背包总件数核对。 */
    items: string[];
    gained: number;
    baseline: number;
    kills: number;
    attacks: number;
    stopReason:
        | 'reached'
        | 'budget'
        | 'no_target'
        | 'interrupted'
        | 'low_health'
        | 'danger'
        | 'gone'
        | 'attack_failed'
        | 'attempts'
        | 'cannot_kill'
        | 'same_target'
        | 'water_unreachable';
    elapsedMs: number;
    /** 在下界刷烈焰人（"没怪了"的下一步建议要用它）。 */
    netherBlaze: boolean;
    /** 连续失败了几次（`attack_failed` 时用来把话说清楚）——**只数"快失败"**。 */
    consecutiveFailures?: number;
    /** 耗完击杀预算还没打死的次数（`cannot_kill` 时用来把话说清楚）。 */
    slowFailures?: number;
    /** 背包里最能打的武器（`cannot_kill` 时给一条 equip 建议）。 */
    betterWeapon?: string | null;
    /** 包里有没有弓（被瞬移怪耗住时的换打法建议）。 */
    bowInPack?: boolean;
    /** 当场发现"攻击说死了但实体还在"的次数（瞬移）。 */
    teleportFailures?: number;
    /** 事后被同一个 id 证伪的"击杀"次数（已从击杀数里扣掉）。 */
    retractions?: number;
    /** 攻击说死了但读不到实体表的次数（没证据，不算击杀）。 */
    unverifiedKills?: number;
    /** 最后一次捡拾的四个事实（看到/踩到/到手/读不到）——回执要分开说。 */
    loot?: DropSweep | null;
    /**
     * body 侧落点诊断（`receipts-dev` 的仪器）：`bot.output` 里最后一条 `drop-seen{…}`。
     * 它解释"为什么没捡到"，我们这边只负责**不再声称没掉东西**——两边对齐、不重复。
     */
    dropDiagnostics?: string | null;
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
    attack_failed: '内部打怪动作连续失败，已熔断停手',
    attempts: '尝试次数到上限了',
    cannot_kill: '打不死（每次都耗完击杀预算），已收手',
    same_target: '同一个目标连续打不死，已熔断停手',
    water_unreachable: '目标在水里、我在岸上，追不到——早停（不烧完整段预算）',
};

export function huntReceipt(o: HuntOutcome): string {
    const lines: string[] = [];
    const counter = o.items.length > 0 ? `${o.items[0]} ${o.gained}/${o.want}` : `背包总件数 +${o.gained}（不知道这种怪掉什么，只能这么核对）`;
    const head = `huntFor ${o.entity}：**${counter}**（起手 ${o.baseline}）`;
    const tail = `攻击 ${o.attacks} 次、击杀 ${o.kills} 只，用了 ${Math.round(o.elapsedMs / 1000)} 秒；停止原因：${STOP_REASON_TEXT[o.stopReason]}。`;
    lines.push(`${head}；${tail}`);
    // **四个事实分开说**（击杀 / 看到掉落物 / 踩到没 / 背包增量）——真机教训：
    // 只写「捡到 0 个」会让模型读成"这种怪不掉东西"，而真相是"东西在地上、没去踩"。
    if (o.loot != null) {
        lines.push(`捡拾四个事实：击杀 ${o.kills} 只（已验证）；${describeDropSweep(o.loot)}；背包实测增量 ${o.gained}。`);
        if (o.loot.seen > 0 && o.loot.picked === 0) {
            lines.push(
                '⚠️ **怪死了、地上有掉落物，但一个都没到手**——这**不是**"这种怪不掉东西"，是**没捡到**：' +
                    '照下一步走过去踩它（自动拾取会收）。别把它记成"掉率为 0"。',
            );
        } else if (!o.loot.readable && o.loot.seen === 0) {
            lines.push(
                '⚠️ **掉落物实体读不到**（实体表不可用）⇒ 这条回执只能说"**没读到**"，' +
                    '**不能说"没有掉落物"**；以 stats 的背包为准。',
            );
        }
        if (o.dropDiagnostics != null && o.dropDiagnostics !== '') {
            lines.push(`（body 侧落点诊断：${o.dropDiagnostics}）`);
        }
    }
    if (o.items.length === 0) {
        lines.push('⚠️ 掉落表里没有这种怪：**只报攻击/击杀次数**，没有可靠的"到手几个"依据——请用 stats 核对背包。');
    }
    if (o.stopReason === 'no_target') {
        // 和 exploreFor 同一个口径：**"这一带没有"不是"工具坏了"**，换地方才有用。
        // 真机里模型会把"没找到"读成工具问题，然后在原地反复调同一个工具。
        const scope = o.radius == null ? '这一带' : `这一带（半径 ${Math.round(o.radius)} 格内）`;
        if (o.assets != null) {
            // **被动动物**：这一带被反复猎杀之后不会很快回来 —— 必须给可再生路线，
            // 否则模型只会换个圆心继续空跑（"世界几乎没有食物来源"就是这么来的）。
            lines.push(
                `**${scope}确实没有 ${o.entity}——不是工具坏了，是真没有。**` +
                    `被动动物被打光之后不会很快回来（你们在这一带已经打了很久），**别换个圆心继续空跑**。`,
            );
            for (const line of foodRouteLines(o.assets)) lines.push(line);
        } else {
            lines.push(
                `**${scope}确实没有 ${o.entity}——不是工具坏了，是真没有。**` +
                    (o.netherBlaze
                        ? '烈焰人只在要塞里刷：先在附近 exploreFor(nether_bricks) 找到要塞再回来刷。'
                        : '同一片区域反复刷不会出怪：换地方、走远一点再来。'),
            );
        }
    }
    for (const warning of capLines(o.warnings, HUNT_MAX_WARNING_LINES, '警告')) lines.push(warning);
    if (o.progress.length > 0) {
        lines.push('进度：');
        for (const line of capLines(o.progress.map((p) => `- #${p.attempt} ${p.text}`), HUNT_MAX_PROGRESS_LINES, '进度'))
            lines.push(line);
    }
    if (o.stopReason !== 'cannot_kill' && (o.slowFailures ?? 0) > 0) {
        lines.push(
            `ℹ️ 其中 ${o.slowFailures} 次是**耗完击杀预算**的打不死（不是工具坏了）：想换打法就换更好的武器/先吃饱/换个目标。`,
        );
    }
    if (o.stopReason === 'attack_failed') {
        lines.push(
            `**内部打怪动作连续失败 ${o.consecutiveFailures ?? '几'} 次，已熔断停手**——` +
                `这不是"这一带没有 ${o.entity}"，而是**打怪这个动作本身没成功**（每次都是"几秒内就被拒"，` +
                `最近的错误见上面的警告）。已经停了，不会再原地重试；下一步给的是一条**直接调用**，用来定位到底是哪一步不对。`,
        );
    }
    if (o.stopReason === 'cannot_kill') {
        lines.push(
            `**打不死**：这 ${o.slowFailures ?? '几'} 次攻击每次都是**耗完击杀预算**（默认 90 秒）才收手——` +
                `说明调用本身是通的（不是被拒/解析错），是**打不动**：它太耐打、在水里回血、或者你的输出不够。` +
                `**不是工具坏了，别去 debug attack**；要换的是打法：① 换更好的武器 ② ${
                    o.netherBlaze ? '打烈焰人先 prepareBlaze（抗火 + 吃饱）' : '换个更好打的目标或先 reposition'
                } ③ 打之前先吃饱/回血。`,
        );
    }
    if (o.stopReason === 'same_target') {
        lines.push(
            (o.teleportFailures ?? 0) > 0
                ? `**同一个目标连续打不死（${o.teleportFailures} 次"消失又出现"= 瞬移）**：` +
                  `这不是"这一带没有 ${o.entity}"，也不是工具坏了——**是它每次都能跑掉，近战追着打没意义**。`
                : `**同一个目标连续打不死**：每次攻击都没有"它真死了"的证据（${o.unverifiedKills ?? 0} 次连实体表都读不到），` +
                  `不算击杀、也不说是工具坏了——先核对实体表再决定。`,
        );
        if ((o.teleportFailures ?? 0) > 0) {
            lines.push(
                isEndermanName(o.entity)
                    ? '**末影人提示**：① 用**船**把它困住（坐进船里的生物不能瞬移）再打；② 用**弓**在远处耗；' +
                      '③ 珍珠不一定要杀——要塞/末地城的箱子里也有 ender_pearl，可以顺路拿。'
                    : '换个打法：远程（弓）/把它逼进死角，或者换个目标——别在同一只身上反复耗。',
            );
        }
    }
    if ((o.unverifiedKills ?? 0) > 0) {
        lines.push(
            `ℹ️ 有 ${o.unverifiedKills} 次攻击**返回成功但读不到实体表**（没证据）：**没有证据就不算击杀**。` +
                '先用 stats(type="entities") 核对一次，再决定要不要继续。',
        );
    }
    if ((o.retractions ?? 0) > 0 || (o.teleportFailures ?? 0) > 0) {
        lines.push(
            `⚠️ 本轮有 **${(o.retractions ?? 0) + (o.teleportFailures ?? 0)} 次"击杀"是假的**` +
                `（同一个实体 id 又出现了 = 瞬移，不是死亡），已经从击杀数里扣掉；` +
                `现在的击杀数 ${o.kills} 只算**验证过、尸体真的没了**的。`,
        );
    }
    // **击杀数 vs 掉落数对不上就是信号**：真机那次是"12 次击杀、0 个珍珠"。
    // 必掉/高概率掉的怪打了 ≥5 只还一个没涨，更可能是"没真死"，不是运气差。
    if (o.kills >= 5 && o.items.length > 0 && o.gained === 0) {
        lines.push(
            `⚠️ 击杀 ${o.kills} 只但 **${o.items[0]} 一个都没涨**：这种怪掉率不低，` +
                `打了 ${o.kills} 只还是 0 更可能是"它们其实没真死"（被打飞/瞬移/脱战）。` +
                '**别把这当战果**——先 stats(type="entities") 核对，再决定换地方还是换打法。',
        );
    }
    lines.push(`下一步（照做即可）：${huntNextAction(o)}`);
    // **硬长度上限**：循环里拼出来的字符串必须有天花板（真机教训：1.35 亿字符把上下文打爆）。
    return capReceipt(lines.join('\n'));
}

/** 和 `exploreNextAction` 同一条理由：只给**一条**能照抄的调用，别给菜单。 */
export function huntNextAction(o: HuntOutcome): string {
    const remaining = Math.max(1, o.want - o.gained);
    // **地上有东西就别收工**：击杀已确认、掉落物看到过、但一个都没到手 ⇒ 下一步是**去踩它**
    // （真机 overnight_b：回执说"没捡到"就结束了，模型于是以为"这种怪不掉东西"）。
    if (o.loot != null && o.loot.seen > 0 && o.loot.picked === 0 && o.loot.nearest != null) {
        const p = o.loot.nearest.position;
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z)) {
            return `goToCoordinates(x=${Math.round(p.x)}, y=${Math.round(p.y)}, z=${Math.round(p.z)}, closeness=1)`;
        }
    }
    switch (o.stopReason) {
        case 'reached':
            return 'stats(type="inventory")';
        case 'budget':
        case 'interrupted':
        case 'gone':
            return `huntFor(entity="${o.entity}", want=${remaining}, max_ms=300000)`;
        case 'no_target':
            // 被动动物被打光了：给**一条**可再生路线（钓鱼/种地/腐肉），别让它换圆心空跑。
            if (o.assets != null) return foodRoutePrimary(o.assets);
            // 下界刷烈焰人：没怪 = 这附近没有堡垒房间，回去继续找要塞。
            return o.netherBlaze
                ? 'exploreFor(block="nether_bricks", max_steps=4)'
                : 'move(direction="north", distance=16)';
        case 'low_health':
            return 'survivalCheck';
        case 'danger':
            return 'moveAway(distance=8)';
        case 'attack_failed':
            // **绝不把同一个会爆的调用原样丢回去**：给一条直接诊断内部动作的调用。
            return `attack(type="${HUNT_ATTACK_TYPE}", target="${o.entity}")`;
        case 'cannot_kill':
            // **打不死 ≠ 工具坏了**：换打法，别让模型去调 attack 那个正常的工具。
            if (o.netherBlaze) return 'prepareBlaze';
            if (o.betterWeapon != null && o.betterWeapon !== '') return `equip(item_name="${o.betterWeapon}")`;
            return 'stats(type="inventory")';
        case 'same_target':
            // 同一只打不死（末影人瞬移）：换打法而不是再来一次 huntFor。
            if (o.bowInPack === true) return 'equip(item_name="bow")';
            if (o.netherBlaze) return 'prepareBlaze';
            return 'stats(type="inventory")';
        case 'attempts':
            return 'stats(type="entities")';
        default:
            return `huntFor(entity="${o.entity}", want=${remaining})`;
    }
}

// ───────────────── 可再生食物路线（"世界被打光了"之后的出路） ─────────────────
//
// 背景（overnight_b 的原话）：`世界几乎没有食物来源：找不到任何被动动物/村庄/农田，
// 掉血后无法回血（卡在 2.7 血）`。这两个 bot 在 1000 格内打了五小时，动物被清空、
// 村民/农田本来就没有——`huntFor(entity="chicken")` 一小时前还能成，现在什么都找不到。
// 所以 `no_target` **不能是死胡同**：必须给出"不依赖野生动物"的可再生路线。

/** 被动/可猎食的动物（被打光后不会马上回来；怪物是持续刷的，不在这个名单里）。 */
export const PASSIVE_FOOD_ANIMALS: ReadonlySet<string> = new Set([
    'cow',
    'mooshroom',
    'pig',
    'sheep',
    'chicken',
    'rabbit',
    'goat',
    'hoglin',
    'turtle',
    'cod',
    'salmon',
    'tropical_fish',
    'pufferfish',
    'squid',
    'glow_squid',
]);

export function isPassiveFoodAnimal(entity: unknown): boolean {
    return typeof entity === 'string' && PASSIVE_FOOD_ANIMALS.has(normalizeName(entity));
}

/** 找水时扫多大半径（只扫已加载区块，和 exploreFor 同一个口径）。 */
export const FOOD_WATER_SCAN_RADIUS = 64;

export interface FoodRouteAssets {
    /** 能直接吃的份数。 */
    edibles: number;
    sticks: number;
    string: number;
    seeds: number;
    planks: number;
    rottenFlesh: number;
    hasHoe: boolean;
    hasFishingRod: boolean;
    hasCraftingTable: boolean;
    /** 最近的水（钓鱼要水）；没扫到就是 null。 */
    water: { position: FlatPosition; distance: number } | null;
    waterScanRadius: number;
}

function countInventoryBy(bot: any, predicate: (name: string) => boolean): number {
    let items: Array<{ name?: unknown; count?: unknown }>;
    try {
        items = (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>;
    } catch {
        return 0;
    }
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const item of items) {
        const name = normalizeName(item?.name);
        if (name === '' || !predicate(name)) continue;
        total += typeof item?.count === 'number' && Number.isFinite(item.count) ? item.count : 1;
    }
    return total;
}

/** 最近的水（只扫已加载区块）。读不到/没有 → null。 */
export function nearestWater(
    bot: any,
    position: FlatPosition,
    radius: number = FOOD_WATER_SCAN_RADIUS,
): { position: FlatPosition; distance: number } | null {
    try {
        const found = world.getNearestBlocksWhere(bot, (b: any) => normalizeName(b?.name) === 'water', radius, 1);
        const p = found[0]?.position;
        if (p == null) return null;
        const point = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
        return { position: point, distance: horizontalDistance(position, point) };
    } catch {
        return null;
    }
}

/**
 * 盘一遍"能不能自己造食物"的家底（种子/线/木棍/木板/腐肉 + 最近的水）。
 *
 * 为什么要它：`no_target` 时模型需要的是**可执行**的替代路线，而不是"换个地方再找找"——
 * 这一带的动物已经被它自己打光了，再找也是空跑。
 */
export function scanFoodRouteAssets(
    bot: any,
    position: FlatPosition,
    radius: number = FOOD_WATER_SCAN_RADIUS,
): FoodRouteAssets {
    return {
        edibles: countInventoryBy(bot, (name) => foodValueOf(name) != null),
        sticks: countInventoryBy(bot, (name) => name === 'stick'),
        string: countInventoryBy(bot, (name) => name === 'string'),
        seeds: countInventoryBy(bot, (name) => name.endsWith('_seeds')),
        planks: countInventoryBy(bot, (name) => name.endsWith('_planks')),
        rottenFlesh: countInventoryBy(bot, (name) => name === 'rotten_flesh'),
        hasHoe: countInventoryBy(bot, (name) => name.endsWith('_hoe')) > 0,
        hasFishingRod: countInventoryBy(bot, (name) => name === 'fishing_rod') > 0,
        hasCraftingTable: countInventoryBy(bot, (name) => name === 'crafting_table') > 0,
        water: nearestWater(bot, position, radius),
        waterScanRadius: radius,
    };
}

function waterLine(a: FoodRouteAssets): string {
    if (a.water == null) {
        return `最近的水：半径 ${a.waterScanRadius} 格内**没扫到**（只扫已加载区块）——钓鱼先得找到水，用 searchForBlock(type="water", search_range=256)，或沿一个方向走远点。`;
    }
    const p = a.water.position;
    return `最近的水在 ${formatPoint(p)}，离你约 ${a.water.distance.toFixed(1)} 格（只扫已加载区块）。鱼就在水里：到岸边钓鱼，或者 huntFor(entity="cod")。`;
}

/** 三条可再生路线（回执里逐条列出来；主行动只挑一条，见 `foodRoutePrimary`）。 */
export function foodRouteLines(a: FoodRouteAssets): string[] {
    const rod = a.hasFishingRod
        ? '① **钓鱼**（最稳、可再生）：你已经有 fishing_rod → 到水边 useOn(tool_name="fishing_rod", target="water")；一条鱼 2 点食物。'
        : '① **钓鱼**（最稳、可再生）：先做竿 useBlock(type="crafting_table", input="3 stick, 2 string", output="1 fishing_rod")（3 木棍 + 2 线）→ 到水边 useOn(tool_name="fishing_rod", target="water")；一条鱼 2 点食物。';
    const farm =
        a.seeds > 0
            ? `② **种小麦**（背包里有 ${a.seeds} 个种子）：木锄 → 在泥土/草方块上锄地 → 播种；3 个小麦做 1 个面包。`
            : '② **种小麦**：背包里没有种子（打草会掉 wheat_seeds）——有种子就能自给：木锄 → 锄地 → 播种，3 小麦做面包。';
    const rotten =
        a.rottenFlesh > 0
            ? `③ **腐肉**（最后手段，你有 ${a.rottenFlesh} 个）：consume(item_name="rotten_flesh")——会附带饥饿效果，**只当应急**，别当主食。`
            : '③ **腐肉**：僵尸掉的，会附带饥饿效果，只当最后手段（背包里现在没有）。';
    return ['可再生食物路线（别再空跑找动物）：', rod, farm, rotten, waterLine(a)];
}

/**
 * **一条**主行动（和 exploreFor/huntFor 的规矩一致：只给一条能照抄的调用）。
 *
 * 选路顺序按"多快能吃上"排：能做竿就先做竿（钓的鱼可再生、不靠运气）→ 已有竿就去水边 →
 * 有种子就先做锄头 → 有腐肉先顶一口 → 有水就去水边 → 都没有就去找水。
 */
export function foodRoutePrimary(a: FoodRouteAssets): string {
    if (!a.hasFishingRod && a.sticks >= 3 && a.string >= 2) {
        return 'useBlock(type="crafting_table", input="3 stick, 2 string", output="1 fishing_rod")';
    }
    if (a.hasFishingRod && a.water != null) {
        return `goToCoordinates(x=${Math.round(a.water.position.x)}, y=${Math.round(a.water.position.y)}, z=${Math.round(a.water.position.z)}, closeness=3)`;
    }
    if (a.seeds > 0) {
        if (!a.hasHoe && a.planks >= 2 && a.sticks >= 2) {
            return 'useBlock(type="crafting_table", input="2 oak_planks, 2 stick", output="1 wooden_hoe")';
        }
        if (a.water != null) {
            return `goToCoordinates(x=${Math.round(a.water.position.x)}, y=${Math.round(a.water.position.y)}, z=${Math.round(a.water.position.z)}, closeness=3)`;
        }
    }
    if (a.rottenFlesh > 0) return 'consume(item_name="rotten_flesh")';
    if (a.water != null) {
        return `goToCoordinates(x=${Math.round(a.water.position.x)}, y=${Math.round(a.water.position.y)}, z=${Math.round(a.water.position.z)}, closeness=3)`;
    }
    return 'searchForBlock(type="water", search_range=256)';
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
    const requestedLegs = clampInt(rawMaxSteps, DEFAULT_EXPLORE_MAX_STEPS, 1, options.maxStepsLimit ?? 64);
    const step = clampInt(rawStep, DEFAULT_EXPLORE_STEP, 4, 128);
    // 一步最长 = 0.75×扫描半径：长腿切段，保证走过的路径不漏扫（见 MAX_LEG_PER_SCAN_RATIO）。
    const maxLeg = maxLegPerScan(scanRadius);

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
    const path = spiralScanPath(origin, step, requestedLegs, maxLeg);
    const outcome: ExploreOutcome = {
        block,
        scanRadius,
        step,
        maxSteps: path.length,
        requestedLegs,
        maxLeg,
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

    for (const waypoint of path) {
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
    if (outcome.found == null && outcome.completedLegs === 0 && outcome.attemptedLegs >= outcome.maxSteps && outcome.danger == null && !outcome.interrupted && !outcome.timedOut) {
        notes.push('⚠️ 每一腿都没走到（寻路全失败）：先 goToCoordinates 挪到一个能走通的位置，或换 step 更小的一轮。');
    }
    return exploreReceipt(outcome);
}

function horizontalDistance(a: FlatPosition, b: FlatPosition): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/** 3D 距离（脚对脚）：走路停滞判定用它（竖直方向也算进步）。 */
function distance3(a: FlatPosition, b: FlatPosition): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
    /** 数一数附近有几个掉落物实体；**读不到实体表返回 null**（"没读到" ≠ "没有"）。 */
    countDrops?: (bot: any, radius: number) => number | null;
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
    /**
     * 某个实体 id 是否还在世界里（`true` = 还在 = 没死；`false` = 没了；`null` = 读不到）。
     * 默认走 `skills.entityPresentById`（**全局实体表**，不是 24 格扫描——瞬移出扫描 ≠ 死）。
     */
    entityPresent?: (bot: any, id: number) => boolean | null;
    /** 装备一件物品（默认 `skills.equip`）：挖不动时先换一把镐再试。 */
    equip?: (bot: any, item: string) => Promise<boolean>;
}

function defaultFindEntity(bot: any, entity: string, radius: number): any | null {
    return world.getNearestEntityWhere(bot, (e: any) => normalizeName(e?.name) === entity, radius);
}

/**
 * 默认"找最近的掉落物"：**必须走 `auto_pickup.nearestDropWithin` 这个入口**，
 * 不能自己再筛一遍实体表。
 *
 * 为什么（2026-10-18 跨文件坑，receipts-dev 报的）：这里以前是
 * `world.getNearestEntityWhere(bot, e => e.name === 'Item', radius)`，它**绕过了
 * 丢弃免疫**——刚被 `discard` 扔掉的东西会被 `huntFor` 当成战利品，再走回去踩一遍，
 * "扔了又自动捡回来"当场复发。`nearestDropWithin` 已经把三条免疫路径
 * （显示名归一化 / 落点 / 实体 id）都算进去了，所以这里只做**形状转换**：
 * 它返回扁平的 `{id,name,x,y,z,distance}`，而 `collectDrops` 读 `drop.position.{x,y,z}`。
 */
function defaultFindDrop(bot: any, radius: number): any | null {
    const target = nearestDropWithin(bot, radius);
    if (target == null) return null;
    return { id: target.id, name: target.name, position: { x: target.x, y: target.y, z: target.z } };
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
    // **type 必须是 mob**（`attack` 只认 id / player / mob）：这里以前写成 'entity'，
    // 于是每一次攻击都被拒、循环又只按墙钟收口 → 315 万次空转 + 1.35 亿字符回执。
    const attack = deps.attack ?? ((b: any, name: string) => skills.attackTarget(b, name, HUNT_ATTACK_TYPE, true));
    const travel = deps.travel ?? ((b: any, x: number, y: number, z: number, closeness: number) => skills.goToPosition(b, x, y, z, closeness));
    const sleep = deps.sleep ?? sleepMs;
    const now = deps.now ?? Date.now;
    const health = deps.health ?? ((b: any) => Number(b?.health ?? 20));
    // **击杀的证据**：这个实体 id 还在不在**全局实体表**里（不是 24 格扫描——瞬移出扫描 ≠ 死）。
    // 默认走 skills 的同款实现，保证"两条路看同一份证据"。
    const entityPresent =
        deps.entityPresent ?? ((b: any, id: number) => skills.entityPresentById(b, id));

    const dropSpec = dropForEntity(entity);
    const items = dropSpec.items.slice(0, 1);
    const baselineAtStart = items.length > 0 ? countItem(bot, items[0]) : countTotalItems(bot);
    const startedAt = now();

    const warnings: string[] = [];
    const progress: HuntProgressLine[] = [];
    let attempts = 0;
    let kills = 0;
    let idlePolls = 0;
    let consecutiveFailures = 0;
    let fastFailures = 0;
    let slowFailures = 0;
    // 假击杀的账：`retractions` = 事后被同一个 id 证伪的次数；
    // `teleportFailures` = 当场发现"攻击说死了但实体还在"的次数；
    // `unverifiedKills` = 攻击说死了但读不到实体表（没证据，不算）；
    // `sameTargetFailures` = 同一个 id 连续打不死的次数（≥HUNT_MAX_SAME_TARGET_FAILURES 就熔断）。
    let retractions = 0;
    let teleportFailures = 0;
    let unverifiedKills = 0;
    let sameTargetFailures = 0;
    let lastKilledTargetId: number | null = null;
    let lastFailedTargetId: number | null = null;
    const maxAttempts = huntMaxAttempts(want);
    let stopReason: HuntOutcome['stopReason'] = 'budget';
    /** 岸上追水里目标的开始时刻（0 = 当前没有这种空转）。 */
    let waterStallSince = 0;
    /** 最后一次捡拾的四个事实（回执要分开说：看到/踩到/到手/读不到）。 */
    let lastSweep: DropSweep | null = null;

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
        // **次数上限**：墙钟预算挡不住"失败一次只要几微秒"的空转（真机 315 万次就是这么来的）。
        if (attempts >= maxAttempts) {
            stopReason = 'attempts';
            break;
        }
        // **连续失败熔断**：内部动作坏了（例如参数名写错）时立刻停手，而不是刷满整段时间。
        if (consecutiveFailures >= HUNT_MAX_CONSECUTIVE_FAILURES) {
            stopReason = 'attack_failed';
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
        const targetId = Number.isFinite(Number((target as any)?.id)) ? Number((target as any).id) : null;
        // **回溯更正**：上一轮"击杀"的 id 这一轮又出现了 → 那次根本没死（末影人瞬移）。
        // 真机事故：12 次 `Successfully killed enderman#286831`、0 个珍珠——同一个 id 反复出现
        // 就是铁证：击杀是假的。这里当场把击杀数扣回去，并如实记一行。
        if (targetId != null && targetId === lastKilledTargetId) {
            if (kills > 0) kills -= 1;
            retractions += 1;
            lastKilledTargetId = null;
            progress.push({
                attempt: attempts,
                text:
                    `⚠️ 更正：上一次"击杀 ${entity}#${targetId}"**是假的**——同一个实体又出现了` +
                    `${isEndermanName(entity) ? '（末影人被打就瞬移）' : ''}，击杀数 -1。`,
            });
            if (progress.length > HUNT_MAX_PROGRESS_LINES) progress.splice(0, progress.length - HUNT_MAX_PROGRESS_LINES);
        }
        // **岸上追水里：早停**（Lead 2026-10-21：60 秒零移动零命中）。
        // 判据是纯函数（hunt_reach）；这里只负责测量：位置、水块、陆生动物数量、空转时长。
        if (waterStallSince == null) waterStallSince = 0;
        try {
            const botPosition = bot?.entity?.position ?? null;
            const targetPosition = (target as { position?: { x: number; y: number; z: number } })?.position ?? null;
            const pointInWater = (point: { x: number; y: number; z: number } | null): boolean => {
                if (point == null) return false;
                try {
                    const block = bot?.blockAt?.(new Vec3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)));
                    return String(block?.name ?? '').includes('water');
                } catch {
                    return false;
                }
            };
            const botInWater = pointInWater(botPosition);
            const targetInWater = pointInWater(targetPosition);
            const distanceNow =
                botPosition != null && targetPosition != null
                    ? Math.hypot(
                          Number(botPosition.x) - Number(targetPosition.x),
                          Number(botPosition.y) - Number(targetPosition.y),
                          Number(botPosition.z) - Number(targetPosition.z),
                      )
                    : null;
            let landAnimals: number | null = null;
            try {
                let count = 0;
                for (const other of Object.values(bot?.entities ?? {}) as Array<{ name?: unknown; position?: { x: number; z: number } }>) {
                    if (!isLandAnimal(String(other?.name ?? ''))) continue;
                    const p = other?.position;
                    if (p == null || botPosition == null) continue;
                    if (Math.hypot(Number(p.x) - Number(botPosition.x), Number(p.z) - Number(botPosition.z)) <= radius) count += 1;
                }
                landAnimals = count;
            } catch {
                landAnimals = null;
            }
            if (targetInWater && !botInWater) {
                if (waterStallSince <= 0) waterStallSince = now();
                const waterVerdict = planWaterHuntStop({
                    elapsedMs: now() - waterStallSince,
                    distance: distanceNow ?? radius,
                    attempts,
                    landAnimals,
                    botInWater,
                    targetInWater,
                    targetName: entity,
                });
                if (waterVerdict.stop) {
                    stopReason = 'water_unreachable';
                    progress.push({ attempt: attempts, text: waterVerdict.text });
                    if (progress.length > HUNT_MAX_PROGRESS_LINES) {
                        progress.splice(0, progress.length - HUNT_MAX_PROGRESS_LINES);
                    }
                    break;
                }
            } else {
                waterStallSince = 0;
            }
        } catch {
            // 判据坏了不许让 huntFor 停下来。
        }

        const attackStartedAt = now();
        const claimedKill = await attack(bot, entity);
        const attackMs = Math.max(0, now() - attackStartedAt);
        // **`attack` 说打死了不算数**：独立复核一次——同一个 id 还在实体表里就不是击杀。
        // （`attackEntity` 那一层也修了，这里是第二张网；两侧都只看证据。）
        let killed = claimedKill === true;
        let teleported = false;
        if (killed && targetId != null) {
            const present = entityPresent(bot, targetId);
            if (present === true) {
                killed = false;
                teleported = true;
                teleportFailures += 1;
            } else if (present == null) {
                // 读不到实体表：**不许声称击杀**（没证据），当没打死处理，但不说它瞬移了。
                killed = false;
                unverifiedKills += 1;
            }
        }
        const unverified = claimedKill === true && !killed && !teleported;
        if (killed) {
            kills += 1;
            lastKilledTargetId = targetId;
            sameTargetFailures = 0;
        } else {
            // 同一个目标连续打不死（瞬移 / 攻击说成功但没证据）：**任何非击杀都算一次**，
            // 因为模型看到的就是"它没死"。
            sameTargetFailures = targetId != null && targetId === lastFailedTargetId ? sameTargetFailures + 1 : 1;
            lastFailedTargetId = targetId;
        }
        void lastFailedTargetId;
        // 掉落物要自己走过去踩（模型动作期间自动拾取是停的）。
        const looted = await collectDrops(bot, radius, HUNT_LOOT_BUDGET_MS, {
            findDrop,
            travel,
            sleep,
            now,
            items,
            baselineAtStart,
            countDrops: deps.countDrops,
        });
        lastSweep = looted.sweep;
        const after = looted.total;
        const delta = after - before;
        const counter = items.length > 0 ? `${items[0]} ${after}/${want}` : `背包总件数 ${after}/${want}`;
        // **每一步只说真话**：没有证据的击杀一律不写成"击杀"。
        const outcomeText = killed
            ? `击杀 ${entity}（已验证：实体没了）`
            : teleported
              ? `打了 ${entity} 一下，**它瞬移了**（同一个实体 #${targetId} 还在，不是击杀）`
              : claimedKill === true
                ? `攻击返回成功但**没证据**（读不到实体表），不算击杀`
                : `没打死 ${entity}`;
        progress.push({
            attempt: attempts,
            // **四个事实分开说**（击杀 / 看到掉落物 / 踩到没 / 背包增量）——揉成一个
            // "捡到 0 个"会让模型读成"这种怪不掉东西"（真机 overnight_b）。
            text: `${outcomeText}；${describeDropSweep(looted.sweep)}；${counter}${delta > 0 ? '' : '（这次没涨）'}`,
        });
        if (progress.length > HUNT_MAX_PROGRESS_LINES) progress.splice(0, progress.length - HUNT_MAX_PROGRESS_LINES);

        // 同一个目标连续 N 次"打不死"（每次都瞬移/消失又出现）→ 熔断，别再骗自己。
        if (sameTargetFailures >= HUNT_MAX_SAME_TARGET_FAILURES) {
            warnings.push(
                `⚠️ 同一个目标（${entity}${targetId != null ? `#${targetId}` : ''}）连续 ${sameTargetFailures} 次都没打死` +
                    `${teleportFailures > 0 ? '——它每次都**瞬移走**' : ''}：这不是"工具坏了"，是**打不死**，已熔断停手。`,
            );
            stopReason = 'same_target';
            break;
        }

        // 失败分两种（真机复核的教训）：**快失败**（几秒内被拒/解析错/服务端拒绝）才可能是
        // "工具坏了"；**慢失败**（耗完击杀预算）是"打不死"——坦克怪/回血/输出不够。
        // 混在一起数，就会让三只耐打的怪把模型骗去 debug 一个正常的工具。
        if (killed) {
            consecutiveFailures = 0;
        } else if (teleported || unverified) {
            // **不是"工具坏了"**：攻击调用本身成功了（只是没证据/它瞬移了）。
            // 单独记账，交给"同一目标连续打不死"那条熔断，绝不喂给快失败熔断。
            consecutiveFailures = 0;
            await sleep(huntBackoffMs(1));
        } else if (attackMs < HUNT_FAST_FAILURE_MS) {
            consecutiveFailures += 1;
            fastFailures += 1;
            if (consecutiveFailures >= HUNT_MAX_CONSECUTIVE_FAILURES) {
                warnings.push(
                    `⚠️ 连续 ${consecutiveFailures} 次攻击都是**几秒内就被拒**（最后一次 ${entity} 没打死、掉落也没涨）：` +
                        `**内部打怪动作本身可能有问题**（参数/目标解析/服务端拒绝），熔断停手，不原地重试。`,
                );
                stopReason = 'attack_failed';
                break;
            }
            await sleep(huntBackoffMs(consecutiveFailures));
        } else if (teleported) {
            // 瞬移不是"工具坏了"，也不是"慢失败"：单独记在 `teleportFailures` 里，
            // 由"同一目标连续打不死"那条熔断管（见上）。
            await sleep(huntBackoffMs(1));
        } else {
            // 慢失败 = 耗完击杀预算还没打死。**不计数进熔断，而且把快失败连击清零**：
            // 中间发生过一次"打了 90 秒"就说明工具是通的，"连续 N 次几秒内被拒"这句话必须字面为真。
            consecutiveFailures = 0;
            slowFailures += 1;
        }
    }

    const gained = currentGain(bot, items, baselineAtStart);
    // **收尾复核**：最后一次"击杀"如果还能在实体表里找到，同样撤回——不能指望"下一轮才发现"
    // （真机那次就是循环结束时还挂着一笔假击杀）。
    if (lastKilledTargetId != null) {
        const present = entityPresent(bot, lastKilledTargetId);
        if (present === true) {
            if (kills > 0) kills -= 1;
            retractions += 1;
            teleportFailures += 1;
            lastKilledTargetId = null;
            progress.push({
                attempt: attempts,
                text: `⚠️ 收尾复核：最后那次"击杀 ${entity}#${attempts}"**也是假的**——它还在实体表里，击杀数 -1。`,
            });
            if (progress.length > HUNT_MAX_PROGRESS_LINES) progress.splice(0, progress.length - HUNT_MAX_PROGRESS_LINES);
        }
    }
    // 全程一次都没打死、而且**每一次失败都是慢失败**（没有任何"快失败"）→ 结论是"打不死"，
    // 不是"工具坏了"：换成 cannot_kill 的说法与下一步（两者措辞与出路都不同）。
    // 混着快失败时不下这个结论（那可能是真有问题），只在回执里如实补一句"其中几次是打不死"。
    if (kills === 0 && slowFailures > 0 && fastFailures === 0 && (stopReason === 'budget' || stopReason === 'attempts')) {
        stopReason = 'cannot_kill';
    }
    const betterWeapon = stopReason === 'cannot_kill' ? skills.bestWeaponInInventory(bot) : null;
    const bowInPack = stopReason === 'same_target' ? countItem(bot, 'bow') > 0 : false;
    // 被动动物这一带没有了：**顺手把"能不能自己造食物"的家底盘出来**（含最近的水），
    // 让回执给的是可执行路线，而不是"换个地方再找找"。
    const assets =
        stopReason === 'no_target' && isPassiveFoodAnimal(entity)
            ? scanFoodRouteAssets(bot, defaultPosition(bot))
            : undefined;
    return huntReceipt({
        entity,
        want,
        radius,
        ...(assets == null ? {} : { assets }),
        items,
        gained,
        baseline: baselineAtStart,
        kills,
        attacks: attempts,
        stopReason,
        elapsedMs: now() - startedAt,
        netherBlaze,
        consecutiveFailures,
        slowFailures,
        ...(stopReason === 'cannot_kill' ? { betterWeapon } : {}),
        ...(stopReason === 'same_target' ? { bowInPack } : {}),
        teleportFailures,
        retractions,
        unverifiedKills,
        loot: lastSweep,
        dropDiagnostics: lastDropDiagnostics(bot),
        warnings,
        progress,
    });
}

/**
 * 从 `bot.output` 里取**最后一条** body 侧落点诊断（`receipts-dev` 的仪器：
 * `drop-seen{id, distance, willAttempt, blockedBy[]}`）。
 *
 * 我们这边**不重复实现**它：他们解释"为什么没捡到"，我们只负责"不再声称没掉东西"。
 * 找不到就返回 null（不编）。
 */
export function lastDropDiagnostics(bot: any): string | null {
    try {
        const output = typeof bot?.output === 'string' ? bot.output : '';
        const matches = output.match(/drop-seen\{[^}]*\}/g);
        return matches != null && matches.length > 0 ? (matches[matches.length - 1] ?? null) : null;
    } catch {
        return null;
    }
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
    /** 数一数附近有几个掉落物实体；**读不到实体表返回 null**（"没读到" ≠ "没有"）。 */
    countDrops?: (bot: any, radius: number) => number | null;
}

/** 踩到多近算"人真的到了掉落物身上"（格）。 */
export const DROP_OVERLAP_EPS = 1.5;

/**
 * 把一次捡拾的**四个事实分开说**（纯函数，可单测）。
 *
 * 真机教训：回执只写「捡到 0 个掉落物」，模型读成"这种怪不掉东西"✗——
 * 而真相是"怪死了、东西在地上、没去踩"。所以这里必须分开说：
 * ① 看到几个（+ 最近几格）② 踩到几次 ③ 到手几个（背包增量）④ 读不到就说读不到。
 */
export function describeDropSweep(sweep: DropSweep | null | undefined): string {
    if (sweep == null) return '掉落物：**没读到**（这次没有捡拾记录）';
    const nearest = sweep.nearest;
    const where =
        nearest == null
            ? ''
            : `（现在最近 ${Number.isFinite(nearest.distance) ? nearest.distance.toFixed(1) : '?'} 格` +
              `${Number.isFinite(nearest.position?.x) ? ` @(${Math.round(nearest.position.x)}, ${Math.round(nearest.position.y)}, ${Math.round(nearest.position.z)})` : ''}` +
              `${nearest.name != null ? `，${nearest.name}` : ''}）`;
    if (!sweep.readable && sweep.seen === 0) {
        return '掉落物：**没读到**（实体表读不到 ⇒ 这只说明"没读到"，**不等于没有掉落物**）';
    }
    if (sweep.seen === 0) {
        return '掉落物：范围内**没看到**掉落物实体';
    }
    const pickedText = sweep.picked > 0 ? `**到手 ${sweep.picked} 个**` : '**一个都没到手**';
    return (
        `掉落物：**看到 ${sweep.seen} 个**${where}；走过去试了 ${sweep.attempts} 次、` +
        `**踩到 ${sweep.overlapped} 次**；${pickedText}`
    );
}

/**
 * 一次"捡掉落物"的**四个事实**（回执绝不许把它们揉成一个数）。
 *
 * 真机（overnight_b）：怪**死了**、掉落物实体**真的刷出来了**（`item.drop.nearby id=…` 停了 8 秒），
 * 但回执只写「捡到 0 个掉落物」⇒ 模型读成"这种怪不掉东西"✗。
 */
export interface DropSweep {
    /** 扫到过几个掉落物实体（0 = 一次都没扫到）。 */
    seen: number;
    /** 掉落物实体**读不到**（实体表不可用）——这时候只能说"没读到"，不能说"没有"。 */
    readable: boolean;
    /** 最近那个（回执要能说"最近 N 格 @(x,y,z)"，下一步也照它走）。 */
    nearest: { name: string | null; id: number | null; distance: number; position: FlatPosition } | null;
    /** 走过去尝试了几次。 */
    attempts: number;
    /** 有几次**人真的踩到它身上**（≤ `DROP_OVERLAP_EPS` 格）。 */
    overlapped: number;
    /** 背包增量（**唯一算数的"到手几个"**）。 */
    picked: number;
}

/**
 * 默认的"数掉落物"：读 `bot.entities` 里的 item 实体。
 *
 * 返回 `null` = **读不到**（实体表没有/读异常）——调用方必须把它和 0 分开说。
 */
export function countNearbyDrops(bot: any, radius: number): number | null {
    try {
        const entities = bot?.entities;
        if (entities == null || typeof entities !== 'object') return null;
        const pos = bot?.entity?.position;
        if (pos == null) return null;
        let count = 0;
        for (const key of Object.keys(entities)) {
            const entity = (entities as Record<string, any>)[key];
            if (entity == null) continue;
            const kind = String(entity?.name ?? entity?.entityType ?? entity?.type ?? '').toLowerCase();
            const isItem =
                kind === 'item' ||
                kind === 'item_stack' ||
                kind === 'item_entity' ||
                String(entity?.objectType ?? '').toLowerCase() === 'item';
            if (!isItem) continue;
            const p = entity?.position;
            if (p == null) continue;
            const d = Math.hypot(Number(p.x) - Number(pos.x), Number(p.y) - Number(pos.y), Number(p.z) - Number(pos.z));
            if (Number.isFinite(d) && d <= radius) count += 1;
        }
        return count;
    } catch {
        return null;
    }
}

/**
 * 走过去把附近的掉落物踩掉，返回**核对出来的**累计到手数 + 四个事实。
 *
 * `total` 一律走背包计数（不是"我走了几步"），所以调用方可以直接拿它当
 * "到手几个"用——这就是"只认真实增量"的落点。`sweep` 则把"看到没看到/踩到没踩到"
 * 分开记下来（回执要能说"地上有、没捡到"）。
 */
export async function collectDrops(
    bot: any,
    radius: number,
    budgetMs: number,
    deps: CollectDeps,
): Promise<{ picked: number; total: number; sweep: DropSweep }> {
    const deadline = deps.now() + budgetMs;
    const startTotal = currentGain(bot, deps.items, deps.baselineAtStart);
    const countDrops = deps.countDrops ?? countNearbyDrops;
    const sweep: DropSweep = { seen: 0, readable: true, nearest: null, attempts: 0, overlapped: 0, picked: 0 };
    let picked = 0;
    const noteDrop = (drop: any): number => {
        const p = drop?.position;
        let distance = Number.POSITIVE_INFINITY;
        try {
            const self = bot?.entity?.position;
            if (self != null && p != null) {
                distance = Math.hypot(Number(p.x) - Number(self.x), Number(p.y) - Number(self.y), Number(p.z) - Number(self.z));
            }
        } catch {
            distance = Number.POSITIVE_INFINITY;
        }
        if (sweep.nearest == null || distance < sweep.nearest.distance) {
            sweep.nearest = {
                name: typeof drop?.name === 'string' ? drop.name : null,
                id: Number.isFinite(Number(drop?.id)) ? Number(drop.id) : null,
                distance,
                position: { x: Number(p?.x), y: Number(p?.y), z: Number(p?.z) },
            };
        }
        return distance;
    };
    while (deps.now() < deadline) {
        if (bot?.interrupt_code === true) break;
        const counted = countDrops(bot, radius);
        if (counted == null) sweep.readable = false;
        else sweep.seen = Math.max(sweep.seen, counted);
        const drop = deps.findDrop(bot, radius);
        if (drop?.position == null) break;
        sweep.seen = Math.max(sweep.seen, 1); // findDrop 找到了 ⇒ 至少看到过一个
        noteDrop(drop);
        sweep.attempts += 1;
        const before = currentGain(bot, deps.items, deps.baselineAtStart);
        const arrived = await deps.travel(bot, drop.position.x, drop.position.y, drop.position.z, 1);
        await deps.sleep(250);
        const afterGain = currentGain(bot, deps.items, deps.baselineAtStart);
        const gained = Math.max(0, afterGain - before);
        picked += gained;
        sweep.picked += gained;
        // **踩到没有**：用"人的位置 vs 掉落物位置"量，不看 travel 的返回值。
        const distanceAfter = noteDrop(drop);
        if (distanceAfter <= DROP_OVERLAP_EPS) sweep.overlapped += 1;
        // 走不过去 + 没进账：别再对着同一个掉落物死循环。
        if (!arrived && afterGain === before) break;
    }
    const total = Math.max(startTotal, currentGain(bot, deps.items, deps.baselineAtStart));
    return { picked, total, sweep };
}

// ─────────────────────────── 直线隧道（mineTunnel） ───────────────────────────
//
// 为什么要有（overnight_a 2026-10-18 16:31 的自己汇报）：下界长途找要塞时
// "这一带 **y=70-85 是致密石英/金矿岩体，寻路必须一路挖**"，于是 goToCoordinates
// 又慢又险——30 个回合净推进约 100 格、死 3 次（岩浆 / 恶魂 / 疣猪顶下悬崖），
// 还经常 `stuckForSeconds: 60/73`。模型自己给出的替代方案就是"沿某方向直线挖隧道
// N 格，我自己在 y=70 挖一条走廊反而更可控"。
//
// 寻路在岩体里本来就要挖，差别只在**可不可控**：隧道的每一步都是
// 「读格子 → 判危险 → 挖 → **验证明明变成空气** → 走进去 → 记进度」，
// 任何一条安全门触发就停手并给完整回执（和 exploreFor / consume 同一个口径：
// 给事实、给一条能照抄的下一步、绝不给堆栈）。

export const DEFAULT_TUNNEL_LENGTH = 32;
/** 单次调用最多挖多少格（模型会反复调用，单次别太长）。 */
export const MAX_TUNNEL_LENGTH = 256;
export const DEFAULT_TUNNEL_HEIGHT = 2;
export const MAX_TUNNEL_HEIGHT = 3;
/** 每挖这么多格报一次进度。 */
export const TUNNEL_PROGRESS_EVERY = 16;
/** 内部时间预算：到点**自己收手**并给完整回执（同 exploreFor 的教训）。 */
export const DEFAULT_TUNNEL_BUDGET_MS = 4.5 * 60 * 1000;
/** 血量低于这个值就停手。 */
export const MIN_HEALTH_TO_DIG = 6;

const TUNNEL_LIQUIDS: ReadonlySet<string> = new Set([
    'lava',
    'flowing_lava',
    'water',
    'flowing_water',
    'bubble_column',
]);
const TUNNEL_AIR: ReadonlySet<string> = new Set(['air', 'cave_air', 'void_air']);

export function isLiquidBlockName(name: unknown): boolean {
    return typeof name === 'string' && TUNNEL_LIQUIDS.has(normalizeName(name));
}

export function isAirBlockName(name: unknown): boolean {
    return typeof name === 'string' && TUNNEL_AIR.has(normalizeName(name));
}

/**
 * 前面脚下这格**能不能踩**：空气/液体/没有碰撞箱（告示牌、火把…）都算踩空。
 *
 * 只看"不是空气"是不够的：下界岩体里真正的死法是"前面看着有地，走过去是岩浆海"，
 * 或者脚下是 cave_air 直接掉下去。`boundingBox === 'empty'` / `passable` 是
 * mineflayer 对"没有碰撞箱"的两种报法，都认。
 */
export function isUnsupportedFloorBlock(block: any): boolean {
    if (block == null) return true;
    const name = normalizeName(block?.name);
    if (isAirBlockName(name) || isLiquidBlockName(name)) return true;
    if (block?.boundingBox === 'empty') return true;
    if (block?.passable === true) return true;
    return false;
}

export interface TunnelDirection {
    axis: 'x' | 'z';
    sign: 1 | -1;
    /** `+x` / `-x` / `+z` / `-z`：回执和下一步都照抄这个。 */
    label: string;
}

export interface ResolvedTunnelDirection extends TunnelDirection {
    /** true = 没给方向，是按当前朝向（yaw）推出来的。 */
    fromYaw: boolean;
}

const DIRECTION_TABLE: Readonly<Record<string, TunnelDirection>> = Object.freeze({
    '+x': { axis: 'x', sign: 1, label: '+x' },
    'x+': { axis: 'x', sign: 1, label: '+x' },
    x: { axis: 'x', sign: 1, label: '+x' },
    east: { axis: 'x', sign: 1, label: '+x' },
    东: { axis: 'x', sign: 1, label: '+x' },
    '-x': { axis: 'x', sign: -1, label: '-x' },
    'x-': { axis: 'x', sign: -1, label: '-x' },
    west: { axis: 'x', sign: -1, label: '-x' },
    西: { axis: 'x', sign: -1, label: '-x' },
    '+z': { axis: 'z', sign: 1, label: '+z' },
    'z+': { axis: 'z', sign: 1, label: '+z' },
    z: { axis: 'z', sign: 1, label: '+z' },
    south: { axis: 'z', sign: 1, label: '+z' },
    南: { axis: 'z', sign: 1, label: '+z' },
    '-z': { axis: 'z', sign: -1, label: '-z' },
    'z-': { axis: 'z', sign: -1, label: '-z' },
    north: { axis: 'z', sign: -1, label: '-z' },
    北: { axis: 'z', sign: -1, label: '-z' },
});

/** 这些写法都表示"按当前朝向"；认不出来的写法一律拒绝（不猜方向）。 */
const FACING_WORDS: ReadonlySet<string> = new Set(['', 'facing', 'current', 'forward', 'me', '当前', '朝向', '前方']);

/**
 * 方向解析：显式 `±x/±z`（或 east/north/…）优先，否则按 yaw 推。
 *
 * mineflayer 的 yaw 约定（和 `actions.ts` 的 discard 一致）：`dx = -sin(yaw)`、
 * `dz = cos(yaw)` → 取分量大的那条轴。读不到 yaw 又没给方向就返回 null（拒绝）。
 */
export function resolveTunnelDirection(raw: unknown, yaw: number | null): ResolvedTunnelDirection | null {
    const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const explicit = DIRECTION_TABLE[key];
    if (explicit != null) return { ...explicit, fromYaw: false };
    if (!FACING_WORDS.has(key)) return null;
    if (yaw == null || !Number.isFinite(yaw)) return null;
    const dx = -Math.sin(yaw);
    const dz = Math.cos(yaw);
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const positive = (alongX ? dx : dz) >= 0;
    const axis: 'x' | 'z' = alongX ? 'x' : 'z';
    return { axis, sign: positive ? 1 : -1, label: `${positive ? '+' : '-'}${axis}`, fromYaw: true };
}

export interface TunnelStep {
    /** 第几步（1-based）。 */
    index: number;
    /** 要清掉的格子（脚到头的 height 格）。 */
    dig: FlatPosition[];
    /** 挖通后要站进去的脚位。 */
    feet: FlatPosition;
    /** 下一步脚下的支撑格：**不许**是液体或非实心。 */
    floor: FlatPosition;
}

/** 判定"真的站进了那一格"的容差（格）：格子中心 ±0.4 才算站进去（旧的 1.5 会把"差一格"算成到达）。 */
export const TUNNEL_ARRIVE_EPS = 0.75;/** 判定"这一动真的挪了位置"的最小 3D 位移（格）。 */
export const TUNNEL_MOVE_EPS = 0.5;
/** 连续这么多步既没挖到东西、人也没挪动 → 熔断（不许空转刷"进度"）。 */
export const TUNNEL_MAX_STALLS = 3;
/** 续跑建议的最小长度：**绝不给 1**（模型会一段一段啃到死）。 */
export const MIN_TUNNEL_RESUME = 16;

// ───────────────────────── 工具之间的"踢皮球"熔断 ─────────────────────────
//
// 真机（overnight_b）：`travelTo` 把活儿交给 `mineTunnel`，`mineTunnel` 又交回 `travelTo`，
// **两边都没挪动、都报 0 位移**，同一个坐标上来回踢。这正是我们整晚在杀的形状
// （回执说"去用另一个工具"，而世界没变），只不过这次是**我们自己的两个工具之间**。
//
// 结构性堵法（不靠模型自觉）：
//   ① 谁要把活儿交给兄弟工具，**必须先说清自己为什么干不了**（点名障碍，不许只说"用另一个"）；
//   ② 交出去的建议里**盖一个 `handoff="<我>"` 章**（模型照抄那条调用就带着章走）；
//   ③ 身体记住"上一次是谁交给谁的"——如果**我刚交出去、兄弟跑了一趟、又回到我这儿**，
//      那就是一个 2 环 ⇒ **拒绝再交一次**，当场报循环，并给一条**不是兄弟工具**的出路。

/** 会互相交活的这两个工具。 */
export type ProgressionTool = 'travelTo' | 'mineTunnel';

/** 循环判定的时间窗：更久以前的交接不算同一条链。 */
export const HANDOFF_CYCLE_WINDOW_MS = 10 * 60 * 1000;

/** 检测到循环时给的出路：**不是兄弟工具**（先把身体/工具状态看清，再决定）。 */
export const HANDOFF_CYCLE_ESCAPE_CALL = 'stats(type="body")';

/** 解析 `handoff="…"` 参数（只认这两个工具名；别的一律当没给）。 */
export function parseHandoff(raw: unknown): ProgressionTool | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase().replace(/^!/, '');
    if (value === 'travelto') return 'travelTo';
    if (value === 'minetunnel') return 'mineTunnel';
    return null;
}

/** 兄弟工具（这两个互为兄弟）。 */
export function siblingTool(tool: ProgressionTool): ProgressionTool {
    return tool === 'travelTo' ? 'mineTunnel' : 'travelTo';
}

/** 把交接章盖进一条建议调用里（幂等）。 */
export function stampHandoff(call: string, from: ProgressionTool): string {
    if (!call.startsWith(`${siblingTool(from)}(`)) return call; // 只给兄弟工具盖章
    if (call.includes('handoff=')) return call;
    return call.replace(/\)\s*$/, `, handoff="${from}")`);
}

/** 这条建议是不是交给兄弟工具的（用来判断"要不要盖章/查循环"）。 */
export function isSiblingCall(call: string | null | undefined, tool: ProgressionTool): boolean {
    return typeof call === 'string' && call.startsWith(`${siblingTool(tool)}(`);
}

export interface HandoffRecord {
    from: ProgressionTool;
    to: ProgressionTool;
    at: number;
}

/** 每个 bot 一份：上一次跑的是谁、上一次把活儿交给谁（WeakMap，不泄漏、也不跨 bot 串味）。 */
const HANDOFF_LEDGER = new WeakMap<
    object,
    { lastRun: { tool: ProgressionTool; at: number } | null; lastHandoff: HandoffRecord | null }
>();

function ledgerOf(bot: any): { lastRun: { tool: ProgressionTool; at: number } | null; lastHandoff: HandoffRecord | null } {
    if (bot == null || (typeof bot !== 'object' && typeof bot !== 'function')) {
        return { lastRun: null, lastHandoff: null };
    }
    let entry = HANDOFF_LEDGER.get(bot as object);
    if (entry == null) {
        entry = { lastRun: null, lastHandoff: null };
        HANDOFF_LEDGER.set(bot as object, entry);
    }
    return entry;
}

/** 记下"这个工具跑过了"。 */
export function recordToolRun(bot: any, tool: ProgressionTool, at: number): void {
    ledgerOf(bot).lastRun = { tool, at };
}

/** 记下"这个工具把活儿交给谁了"。 */
export function recordHandoff(bot: any, from: ProgressionTool, to: ProgressionTool, at: number): void {
    ledgerOf(bot).lastHandoff = { from, to, at };
}

export function lastToolRun(bot: any): { tool: ProgressionTool; at: number } | null {
    return ledgerOf(bot).lastRun;
}

export function lastHandoff(bot: any): HandoffRecord | null {
    return ledgerOf(bot).lastHandoff;
}

/**
 * 是不是"两个工具在互相踢皮球"（纯函数，可单测）。
 *
 * 判据（任一成立就是 2 环）：
 *   - **显式**：这次的调用带着 `handoff="<兄弟>"`（是兄弟把我叫来的），而我又要把它交回给兄弟；
 *   - **账本**：我上一次把活儿交给了兄弟（`lastHandoff.from === 我`），而且**兄弟真的跑过一趟**
 *     （`lastRun.tool === 兄弟`），现在又轮到我 ⇒ 我 → 兄弟 → 我。
 */
export function detectHandoffCycle(options: {
    tool: ProgressionTool;
    /** 本次调用带进来的 `handoff`（谁把我叫来的）。 */
    handoff: ProgressionTool | null;
    /** 这次我准备建议的调用（可能为 null）。 */
    suggestion: string | null;
    lastRun: { tool: ProgressionTool; at: number } | null;
    lastHandoffRecord: HandoffRecord | null;
    now: number;
    windowMs?: number;
}): boolean {
    const windowMs = options.windowMs ?? HANDOFF_CYCLE_WINDOW_MS;
    const sibling = siblingTool(options.tool);
    const fresh = (at: number): boolean => Math.abs(options.now - at) <= windowMs;
    // 显式那条：兄弟叫我来，我又要交回给兄弟。
    if (options.handoff === sibling && isSiblingCall(options.suggestion, options.tool)) return true;
    // 账本那条：我交出去 → 兄弟跑过 → 又轮到我。
    const record = options.lastHandoffRecord;
    if (record != null && record.from === options.tool && record.to === sibling && fresh(record.at)) {
        if (options.lastRun != null && options.lastRun.tool === sibling && fresh(options.lastRun.at)) return true;
    }
    return false;
}

/** 循环时写在回执里的那一行（点名两个工具 + 说明"都没动"）。 */
export function handoffCycleNote(tool: ProgressionTool, reason: string): string {
    const sibling = siblingTool(tool);
    return (
        `⚠️ **检测到两个工具在互相踢皮球**：${sibling} 把你交给 ${tool}、${tool} 又要交回 ${sibling}——**停**。` +
        `两边都不动的具体原因：${reason}。` +
        `下一步**不要**再用 ${sibling}（那就是把同一个圈再走一遍），先 ${HANDOFF_CYCLE_ESCAPE_CALL} 看清身体/工具，再决定换路。`
    );
}

/**
 * 把一个"要交给兄弟工具"的建议过一遍交接闸门（**纯逻辑 + 账本副作用**）：
 *
 * - 不是交给兄弟的 ⇒ 原样返回（自己续跑/换别的动作都不受影响）；
 * - 是交给兄弟的 ⇒ 先查循环：
 *   - **循环** ⇒ **拒绝这次交接**，改用 `HANDOFF_CYCLE_ESCAPE_CALL`，并把循环说明交给 `onCycle`
 *     （回执必须说出来：两个工具都没动、为什么）；
 *   - 不循环 ⇒ 给建议**盖 `handoff="<我>"` 章**并记账（模型照抄那条调用就带着章走）。
 */
export function handoffAwareNextCall(options: {
    bot: any;
    tool: ProgressionTool;
    handoffFrom: ProgressionTool | null;
    suggestion: string;
    /** 我为什么干不了（要写进循环说明里）。 */
    reason: string;
    now: number;
    /** **本次运行之前**账本里的"上一次跑的是谁"（调用方要先读再记自己，否则会覆盖掉证据）。 */
    lastRun?: { tool: ProgressionTool; at: number } | null;
    onCycle?: (note: string) => void;
}): string {
    const { bot, tool, handoffFrom, suggestion, reason, now } = options;
    if (!isSiblingCall(suggestion, tool)) return suggestion;
    const cycle = detectHandoffCycle({
        tool,
        handoff: handoffFrom,
        suggestion,
        lastRun: options.lastRun !== undefined ? options.lastRun : lastToolRun(bot),
        lastHandoffRecord: lastHandoff(bot),
        now,
    });
    if (cycle) {
        options.onCycle?.(handoffCycleNote(tool, reason));
        return HANDOFF_CYCLE_ESCAPE_CALL;
    }
    recordHandoff(bot, tool, siblingTool(tool), now);
    return stampHandoff(suggestion, tool);
}

/** 搭桥时最多换几种材料（换依附面已经在里面循环了）。 */
export const BRIDGE_MAX_MATERIALS = 3;

/**
 * **不许挖穿的方块**：容器与功能方块。
 *
 * 真机事故（overnight_b，2026-10-19）：`travelTo` 把基地的箱子 `chest(12,63,1)` 连承重方块
 * 一起挖了，内容物撒地——而那是它们自己要用的补给点。挖存储不是这个工具该替模型做的决定。
 * 直线隧道遇到它们应当**绕开**（抬/降一格通常就够），绕不开就停下说清楚。
 */
export const PROTECTED_BLOCK_NAMES: ReadonlySet<string> = new Set([
    'chest',
    'trapped_chest',
    'ender_chest',
    'barrel',
    'furnace',
    'blast_furnace',
    'smoker',
    'crafting_table',
    'anvil',
    'chipped_anvil',
    'damaged_anvil',
    'spawner',
    'beacon',
    'brewing_stand',
    'enchanting_table',
    'hopper',
    'dropper',
    'dispenser',
    'lectern',
    'composter',
    'cauldron',
    'water_cauldron',
    'lava_cauldron',
    'powder_snow_cauldron',
    'jukebox',
    'note_block',
    'respawn_anchor',
    'lodestone',
    'conduit',
    'bell',
    'campfire',
    'soul_campfire',
    'flower_pot',
    'decorated_pot',
    'cartography_table',
    'fletching_table',
    'smithing_table',
    'loom',
    'stonecutter',
    'grindstone',
]);

/** 名字后缀族：床 / 告示牌 / 旗帜 / 潜影盒（各种木头/颜色）。 */
const PROTECTED_SUFFIXES: ReadonlyArray<string> = ['_bed', '_sign', '_wall_sign', '_hanging_sign', '_banner', '_wall_banner', '_shulker_box'];

/** 是不是"不许挖穿"的方块（容器/功能方块）。 */
export function isProtectedBlockName(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const value = name.trim().toLowerCase().replace(/^minecraft:/, '');
    if (value === '') return false;
    if (PROTECTED_BLOCK_NAMES.has(value)) return true;
    return PROTECTED_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

/** 是不是**容器**（里面有东西的那种）——回执要说"里面的东西没动"。 */
export function isContainerBlockName(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const value = name.trim().toLowerCase().replace(/^minecraft:/, '');
    if (value === '') return false;
    return (
        value === 'chest' ||
        value === 'trapped_chest' ||
        value === 'ender_chest' ||
        value === 'barrel' ||
        value === 'hopper' ||
        value === 'dropper' ||
        value === 'dispenser' ||
        value.endsWith('_shulker_box') ||
        value === 'furnace' ||
        value === 'blast_furnace' ||
        value === 'smoker' ||
        value === 'brewing_stand'
    );
}

/** 搭桥时依次尝试的依附面：先按常规从下方/侧面搭，再试上面。 */
export const BRIDGE_FACES = ['bottom', 'side', 'top'] as const;
export type BridgeFace = (typeof BRIDGE_FACES)[number];
/** 依附面的中文说法（回执里要能照抄/看懂）。 */
export const BRIDGE_FACE_TEXT: Readonly<Record<BridgeFace, string>> = Object.freeze({
    bottom: '下方依附',
    side: '侧面依附',
    top: '上方依附',
});

/**
 * 第 `index` 步的几何：清哪几格、站到哪、踩在哪。
 *
 * `rise` = 每步抬高几格（默认 0 = 平隧道；1 = **斜上台阶**：挖斜上两格再走上去，
 * 不用垫脚料——往 y=116 爬 46 格需要的垫脚方块，bot 身上通常根本没有）。
 */
export function tunnelStep(pos: FlatPosition, dir: TunnelDirection, height: number, index: number, rise = 0): TunnelStep {
    const dx = dir.axis === 'x' ? dir.sign : 0;
    const dz = dir.axis === 'z' ? dir.sign : 0;
    const baseX = Math.round(pos.x) + dx;
    const baseZ = Math.round(pos.z) + dz;
    const baseY = Math.round(pos.y) + rise;
    const dig: FlatPosition[] = [];
    for (let i = 0; i < height; i++) dig.push({ x: baseX, y: baseY + i, z: baseZ });
    return { index, dig, feet: { x: baseX, y: baseY, z: baseZ }, floor: { x: baseX, y: baseY - 1, z: baseZ } };
}

export type TunnelStop =
    | 'done'
    | 'budget'
    | 'interrupted'
    | 'low_health'
    | 'damaged'
    | 'liquid_ahead'
    | 'unsupported_floor'
    | 'no_tool'
    | 'tool_low'
    | 'dig_failed'
    | 'travel_failed'
    | 'unreadable'
    | 'bad_direction'
    | 'bridge_failed'
    | 'protected_block'
    | 'stalled';

const TUNNEL_STOP_TEXT: Record<TunnelStop, string> = {
    done: '挖满了本次长度（可以接着挖同一条线）',
    budget: '时间到（内部预算）主动收手',
    interrupted: '被 Stop/保命打断',
    low_health: '血量太低，停手保命',
    damaged: '中途掉血，停手',
    liquid_ahead: '前方是液体（岩浆/水），不能往里面挖',
    unsupported_floor: '下一步脚下不是实心方块，会掉下去',
    no_tool: '没有能挖的镐，而且前面的方块徒手挖不动',
    tool_low: '（已删除的安全门：低耐久不再拦路，工具断了由动作内部换）',
    dig_failed: '挖完还是原方块（挖不动/被挡）',
    travel_failed: '挖通了但没走进去（寻路失败）',
    unreadable: '读不到方块（区块没加载？），不敢瞎挖',
    bad_direction: '方向认不出来，也不给读朝向',
    bridge_failed: '想垫一块桥过去，但没垫成',
    protected_block: '前面是容器/功能方块（箱子、熔炉、工作台…），**不挖穿**，而且抬/降一格都绕不开',
    stalled: '连着几步既没挖到东西、人也没挪动（卡住了）',
};

export interface TunnelOutcome {
    dir: ResolvedTunnelDirection;
    height: number;
    requested: number;
    /**
     * **真的推进了几格**：每一步都必须"人站进了新格子"（3D 距离 ≤ 0.75）才算。
     * 真机事故：这个数字原来是"循环跑了多少轮"，于是"已挖 64 格 + 位移 0"。
     */
    dug: number;
    /** 挖掉并**验证变空气**的方块总数（不等于推进格数）。 */
    blocksDug: number;
    /** 尝试挖的次数（含没变成空气的）——用来和 `blocksDug` 对照着说真话。 */
    digAttempts: number;
    /** 有位移的步数（`dug` 的另一侧证据；正常情况下等于 `dug`）。 */
    moved: number;
    /** 中途工具变过几次（`{from,to}`）——自动换手/镐断了，必须写进回执。 */
    toolChanges: Array<{ from: string | null; to: string | null }>;
    /** 连续"既没挖到东西也没挪动"的步数（熔断用）。 */
    stalls: number;
    /** 直线撞上的容器/功能方块（**一个都没挖**）：名字 + 坐标 + 是否被挖掉。 */
    protectedHits: Array<{ name: string; position: FlatPosition; dug: boolean }>;
    /** 为了绕开它们抬/降了几次。 */
    detours: number;
    /** 这条是被哪个兄弟工具交过来的（`handoff="travelTo"`），用来堵"互相踢皮球"。 */
    handoffFrom?: ProgressionTool | null;
    start: FlatPosition;
    here: FlatPosition;
    stop: TunnelStop;
    /** 触发停止的具体格子/方块（安全门必须点名，模型才知道绕开哪）。 */
    detail: string;
    /** 需要换的工具名（`equip` 提示用；没有就是 null）。 */
    hintEquip: string | null;
    progress: string[];
    toolName: string | null;
    toolRemaining: number | null;
    toolMax: number | null;
    handMining: boolean;
    /** 搭了几块桥（横向的 `pillarUp`：前方脚下是空洞就垫一块过去）。 */
    bridges: number;
}

/** 挖了多少格 → 下一步还挖多少（原地接着挖同一条线）。 */
export function tunnelRemaining(o: TunnelOutcome): number {
    const left = o.requested - o.dug;
    // **续跑绝不给 1 格**（真机：模型拿到 length=1 就原地打转，一段一段啃）。
    // 这一段挖满了 ⇒ 接着挖就用默认长度；还剩一点 ⇒ 至少给 MIN_TUNNEL_RESUME 格
    // （同一条直线，多挖几格只是"这一次试多远"）。
    if (left <= 0) return DEFAULT_TUNNEL_LENGTH;
    return Math.max(MIN_TUNNEL_RESUME, left);
}

export function tunnelNextAction(o: TunnelOutcome): string {
    switch (o.stop) {
        case 'liquid_ahead':
            return 'moveAway(distance=8)';
        case 'unsupported_floor':
            // **别再给 pillarUp(distance=2)**：它也要方块，没方块时就是死循环
            // （真机 overnight_b 在 (-29,46,8) 的洞里连撞两次）。先弄 1 个能垫的方块。
            return `mineTunnel(length=2, direction="${o.dir.axis === 'x' ? (o.dir.sign > 0 ? '+z' : '-z') : o.dir.sign > 0 ? '+x' : '-x'}")`;
        case 'bridge_failed':
            return 'moveAway(distance=3)';
        case 'no_tool':
        case 'tool_low': // 历史停止码：不再产生，仅为兼容旧回执保留
            return o.hintEquip != null ? `equip(item_name="${o.hintEquip}")` : 'stats(type="inventory")';
        case 'low_health':
        case 'damaged':
            return 'survivalCheck';
        case 'bad_direction':
        case 'unreadable':
            return 'stats(type="body")';
        case 'stalled':
            // **绝不把同一个会空转的调用原样丢回去**：先看清身体状态/手上工具。
            return o.hintEquip != null ? `equip(item_name="${o.hintEquip}")` : 'stats(type="body")';
        case 'protected_block': {
            // 直线上撞到箱子/熔炉这类方块：**横着挪开再继续**，别在原地再挖一次。
            const sideways = o.dir.axis === 'x' ? '+z' : '+x';
            return `mineTunnel(length=2, direction="${sideways}")`;
        }
        default:
            // 正常可续：同一条线、剩下的长度。
            return `mineTunnel(length=${tunnelRemaining(o)}, direction="${o.dir.label}")`;
    }
}

export function tunnelReceipt(o: TunnelOutcome): string {
    const lines: string[] = [];
    const where = formatPoint(o.here);
    const dirText = `${o.dir.label}${o.dir.fromYaw ? '（按当时的朝向推出来的，下一步照抄这个方向）' : ''}`;
    // **进度只报量出来的数**：位移（3D 直线距离）+ 验证变空气的方块数 + 尝试次数。
    const displacement = Math.hypot(o.here.x - o.start.x, o.here.y - o.start.y, o.here.z - o.start.z);
    lines.push(
        `mineTunnel：**沿 ${o.dir.label} 净前进 ${o.dug}/${o.requested} 格**（实测位移 ${displacement.toFixed(1)} 格：` +
            `${formatPoint(o.start)} → 现在 ${where}），挖掉并**验证变空气**的方块 ${o.blocksDug} 个` +
            `${o.digAttempts > o.blocksDug ? `（尝试 ${o.digAttempts} 次）` : ''}。` +
            // **0 位移必须是标题里的事**：把"卡在什么"直接写在第一行。
            (displacement < TUNNEL_MOVE_EPS
                ? `**卡在**：${o.detail === '' ? TUNNEL_STOP_TEXT[o.stop] : o.detail}。`
                : ''),
    );
    // **被兄弟工具交过来的**：说清"挖不动就报原因，别再交回去"（真机：两个工具互相踢皮球）。
    if (o.handoffFrom != null) {
        lines.push(
            `ℹ️ 这条是 **${o.handoffFrom}** 交过来的（\`handoff="${o.handoffFrom}"\`）：**挖不动就把具体原因说出来**` +
                '（脚下没有可站的方块 / 前面是容器·功能方块 / 手上没镐 / 读不到方块），**不要再交回 ' +
                `${o.handoffFrom}**——来回踢皮球就是两边都不动。`,
        );
    }
    // **方向是推出来的就要说清楚**（真机："方向挖反了"最常见的原因就是没给 direction、
    // 而当时的朝向是反的）。而且要指路去那个不会猜反的工具。
    if (o.dir.fromYaw) {
        lines.push(
            `⚠️ 你没给 direction：这个 **${o.dir.label}** 是**按你当时的朝向推出来的**——` +
                `如果你其实想往另一个方向（比如目标在背后），就明确写 direction="${o.dir.label === '+x' ? '-x' : o.dir.label === '-x' ? '+x' : o.dir.label === '+z' ? '-z' : '+z'}"。` +
                '**要去某个坐标就用 travelTo(x=…, z=…)**：它按坐标算方向，不会猜反。',
        );
    }
    lines.push(`停止原因：${TUNNEL_STOP_TEXT[o.stop]}${o.detail === '' ? '' : `——${o.detail}`}。`);
    // **三项证据不一致就不许只报大的那个数**（两条可以同时成立，所以用独立的 if）。
    if (o.dug === 0 && (o.digAttempts > 0 || o.moved === 0)) {
        lines.push(
            `⚠️ 读/挖了 ${o.digAttempts} 次、**没有一格真的变成空气，人也没往前挪**——按证据这一趟是 0 格` +
                `（以前的回执会把这整段写成"挖满了"，那是假的）。`,
        );
    }
    if (o.blocksDug > 0 && displacement < TUNNEL_MOVE_EPS) {
        lines.push(
            `⚠️ **矛盾**：挖掉了 ${o.blocksDug} 个方块（验证过变空气），但**位移是 0 格**——` +
                `人不在地道里/被卡住了。别按"挖掉多少方块"去算走了多远。`,
        );
    }
    if (o.moved < o.dug) {
        lines.push(`ℹ️ 有 ${o.dug - o.moved} 步是"人到了但位移判不出来"，已按证据从低计。`);
    }
    // **保险**：`dug` 现在由位置量出来（`dug ≤ 实测位移`），这条理论上永远不会触发；
    // 留着是为了"万一以后有人又改成数循环"，回执会当场自曝而不是骗人。
    if (o.dug > 0 && displacement + 0.75 < o.dug * TUNNEL_MOVE_EPS) {
        lines.push(
            `⚠️ **矛盾**：格数（${o.dug}）和实测位移（${displacement.toFixed(1)} 格）对不上——` +
                '**按位移算**，格数不算数。',
        );
    }
    if (o.stalls > 0) {
        lines.push(`ℹ️ 有 ${o.stalls} 步既没挖到东西、人也没挪动（反复空转会被判"卡住了"并停手）。`);
    }
    // **容器/功能方块**：一个都没挖，而且点名（真机：箱子被挖了、内容物撒地、回执里一个字都没有）。
    for (const hit of (o.protectedHits ?? []).slice(0, 4)) {
        lines.push(
            `🛡️ ${formatPoint(hit.position)} 是 **${hit.name}**（容器/功能方块）——**没挖它**` +
                (hit.dug ? '（记录时已经被挖掉了）' : '') +
                (isContainerBlockName(hit.name) ? '，里面的东西原样没动；要拿就自己 useBlock 打开它' : '') +
                '。',
        );
    }
    if ((o.detours ?? 0) > 0) {
        lines.push(`ℹ️ 为了绕开它们，抬/降了 ${o.detours} 次（横向隧道抬一格通常就够）。`);
    }
    if ((o.toolChanges ?? []).length > 0) {        const changes = (o.toolChanges ?? [])
            .slice(0, 3)
            .map((c) => `${c.from ?? '空手'} → ${c.to ?? '空手'}`)
            .join('、');
        lines.push(
            `⚠️ **中途工具变了 ${(o.toolChanges ?? []).length} 次**（${changes}）：这是自动换手/镐断了，挖得慢是它造成的。`,
        );
    }
    if (o.handMining) {
        lines.push(
            '⚠️ **手上和背包里都没有镐**：这些方块是**徒手挖**的，很慢，而且更费时间=更暴露；' +
                '能找/做一把镐就先做（3 个石头 + 2 根木棍）。',
        );
    }
    const toolText =
        o.toolName == null
            ? '镐：手上没有工具'
            : o.toolRemaining == null
              ? `镐：${o.toolName}（上限读不到，算不出还剩几次）`
              : `镐：${o.toolName} 还剩约 ${o.toolRemaining} 次（${o.toolMax ?? '?'} 上限）`;
    lines.push(toolText + '。');
    if (o.bridges > 0) lines.push(`搭桥：这一趟垫了 ${o.bridges} 块（前方脚下是空洞时垫一块过去，横向的 pillarUp）。`);
    for (const line of capLines(o.progress, HUNT_MAX_PROGRESS_LINES, '进度')) lines.push(line);
    lines.push(`下一步（照做即可）：${tunnelNextAction(o)}`);
    // 同 huntReceipt：隧道很长时进度行也不能无限堆。
    return capReceipt(lines.join('\n'));
}

export interface TunnelDeps {
    /** 取当前位置（脚）。 */
    position?: (bot: any) => FlatPosition;
    /** 取朝向（弧度）。 */
    yaw?: (bot: any) => number | null;
    /** 读一格方块（返回 null = 读不到）。 */
    blockAt?: (bot: any, x: number, y: number, z: number) => any | null;
    /** 挖掉一格；返回是否真的挖掉了。 */
    dig?: (bot: any, x: number, y: number, z: number) => Promise<boolean>;
    /** 走进下一格；返回是否真的到了。 */
    travel?: (bot: any, x: number, y: number, z: number) => Promise<boolean>;
    /** 血量。 */
    health?: (bot: any) => number | null;
    /** 手上工具（默认走 skills.toolDurabilityGuard）。 */
    tool?: (bot: any) => { name: string | null; remaining: number | null; max: number | null; low: boolean };
    /** 挑一块能垫的方块（默认走 `skills.choosePillarMaterial`，和 pillarUp 同一套偏好）。 */
    scaffold?: (bot: any) => string | null;
    /** 挑**一串**能垫的方块（按偏好排序）：搭桥一次不成要能换材料。 */
    scaffoldAll?: (bot: any) => string[];
    /** 垫一块方块（默认 `skills.placeBlock`）；`face` = 依附面（bottom/side/top）。 */
    place?: (bot: any, block: string, x: number, y: number, z: number, face?: string) => Promise<boolean>;
    /** 装备一件物品（默认 `skills.equip`）：挖不动时先换一把镐再试。 */
    equip?: (bot: any, item: string) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface TunnelOptions {
    budgetMs?: number;
    progressEvery?: number;
    /** 每一步之间的小停顿（让服务端把方块更新同步回来）。 */
    settleMs?: number;
    /** 交接章：`handoff="travelTo"` = "这条是 travelTo 交过来的"（照抄上一条回执里的调用即可）。 */
    handoff?: unknown;
}

function defaultBlockObject(bot: any, x: number, y: number, z: number): any | null {
    try {
        // 同 `blockNameAt`：必须给 Vec3，普通对象会被 `pos.floored()` 打回。
        return bot?.blockAt?.(vec3At(x, y, z)) ?? null;
    } catch {
        return null;
    }
}

function defaultTunnelHealth(bot: any): number | null {
    const value = Number(bot?.health);
    return Number.isFinite(value) ? value : null;
}

export interface DigLineRequest {
    /** 已解析好的方向（travelTo 自己挑轴，mineTunnel 由模型给或按朝向推）。 */
    dir: ResolvedTunnelDirection;
    length: number;
    height: number;
    budgetMs: number;
    /** 绝对截止时间（多腿共享一个总预算时用；取更早的那个）。 */
    deadline?: number;
    /** 每步抬高几格（默认 0；1 = 斜上台阶，爬到目标层用）。 */
    rise?: number;
}

/**
 * 沿一条直线挖：**每一格都"先判危险 → 挖 → 验证明明变空气 → 走进去"**（安全门一个不少）。
 *
 * 从 `mineTunnelSkill` 里抽出来，是为了让 `travelTo` 的多腿路线**复用同一套门与验证**——
 * 不许为了"能走长途"把安全门放宽一档。
 */
export async function digLine(
    bot: any,
    request: DigLineRequest,
    deps: TunnelDeps = {},
    options: TunnelOptions = {},
): Promise<TunnelOutcome> {
    const progressEvery = Math.max(1, options.progressEvery ?? TUNNEL_PROGRESS_EVERY);
    const settleMs = options.settleMs ?? 120;

    const position = deps.position ?? defaultPosition;
    const yaw = deps.yaw ?? ((b: any) => (Number.isFinite(Number(b?.entity?.yaw)) ? Number(b.entity.yaw) : null));
    const blockAt = deps.blockAt ?? defaultBlockObject;
    const dig = deps.dig ?? ((b: any, x: number, y: number, z: number) => skills.mineBlockAt(b, x, y, z));
    const travel = deps.travel ?? ((b: any, x: number, y: number, z: number) => skills.goToPosition(b, x, y, z, 1));
    const equip = deps.equip ?? ((b: any, item: string) => skills.equip(b, item));
    const health = deps.health ?? defaultTunnelHealth;
    const tool = deps.tool ?? ((b: any) => skills.toolDurabilityGuard(b));
    // 垫脚材料：和 `pillarUp` / `applyScaffoldingBlocks` **同一套偏好**（圆石/泥土/下界岩…），
    // 不另立一份"什么算能垫的方块"。
    const scaffold =
        deps.scaffold ??
        ((b: any) => {
            try {
                return (
                    skills.choosePillarMaterial(
                        (b?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>,
                        1,
                        (b?.registry?.blocksByName ?? null) as Record<string, any> | null,
                    ) ?? null
                );
            } catch {
                return null;
            }
        });
    /**
     * 能垫的方块，**按偏好排序的一串**：搭桥一次不成要能换材料（换材料 = 换尺寸/朝向，
     * 依附面不成立时往往换个方块就成立）。实现就是把挑中的材料从候选里剔掉再挑一次。
     */
    const scaffoldChoices = (b: any): string[] => {
        if (deps.scaffoldAll != null) {
            try {
                return (deps.scaffoldAll(b) ?? []).filter((name) => typeof name === 'string' && name !== '');
            } catch {
                return [];
            }
        }
        const out: string[] = [];
        for (let i = 0; i < BRIDGE_MAX_MATERIALS; i++) {
            let items: Array<{ name?: unknown; count?: unknown }> = [];
            try {
                items = (b?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>;
            } catch {
                items = [];
            }
            const filtered = items.filter((item) => typeof item?.name !== 'string' || !out.includes(item.name));
            let picked: string | null = null;
            try {
                picked =
                    skills.choosePillarMaterial(
                        filtered,
                        1,
                        (b?.registry?.blocksByName ?? null) as Record<string, any> | null,
                    ) ?? null;
            } catch {
                picked = null;
            }
            if (picked == null) break;
            out.push(picked);
        }
        if (out.length === 0) {
            // 自定义 `scaffold` 依赖（测试/别的身体）兜底：至少给它一次机会。
            try {
                const one = scaffold(b);
                if (typeof one === 'string' && one !== '') out.push(one);
            } catch {
                /* ignore */
            }
        }
        return out;
    };
    const place =
        deps.place ??
        ((b: any, block: string, x: number, y: number, z: number, face?: string) =>
            skills.placeBlock(b, block, x, y, z, face ?? 'side'));
    const sleep = deps.sleep ?? sleepMs;
    const now = deps.now ?? Date.now;

    const start = position(bot);
    const startedAt = now();
    const startHealth = health(bot);
    const height = request.height;
    const requested = request.length;
    const budgetMs = request.budgetMs;
    const deadline = Math.min(startedAt + budgetMs, request.deadline ?? Number.POSITIVE_INFINITY);
    const outcome: TunnelOutcome = {
        dir: request.dir,
        height,
        requested,
        dug: 0,
        blocksDug: 0,
        digAttempts: 0,
        moved: 0,
        toolChanges: [],
        stalls: 0,
        protectedHits: [],
        detours: 0,
        start,
        here: start,
        stop: 'done',
        detail: '',
        hintEquip: null,
        progress: [],
        toolName: null,
        toolRemaining: null,
        toolMax: null,
        handMining: false,
        bridges: 0,
    };

    /** 一手工具的描述（每次都重新读，因为挖着挖着就磨损了）。 */    const refreshTool = (): { name: string | null; remaining: number | null; max: number | null; low: boolean } => {
        const g = tool(bot);
        outcome.toolName = g.name;
        outcome.toolRemaining = g.remaining;
        outcome.toolMax = g.max;
        return g;
    };
    refreshTool();

    const cellText = (p: FlatPosition, name: string | null): string => `${formatPoint(p)} 是 ${name ?? '读不到'}`;

    /**
     * 把脚的位置投影到隧道轴线上：**沿这条线真的走进了第几格**。
     *
     * 原点取"起手那一格的格心"（`round`），所以站在 x=0.4 起步、走到 x=1.0 时读数是 1.0 ✓。
     * `dug`（前进格数）只由它决定——位置是唯一算数的证据；**来回晃 0.5 格不算一格**
     * （读数要够 0.75 格才进位，见下面的 `+ 0.25`）。
     */
    const originX = Math.round(start.x);
    const originZ = Math.round(start.z);
    const alongAxis = (p: FlatPosition): number =>
        request.dir.axis === 'x' ? (p.x - originX) * request.dir.sign : (p.z - originZ) * request.dir.sign;

    /** 上一轮看到的手上工具：**中途换手本身就是事实**，必须写进回执（哪怕没卡住）。 */
    let lastToolName: string | null = outcome.toolName;
    const noteToolChange = (nowName: string | null): void => {
        if (nowName === lastToolName) return;
        outcome.toolChanges.push({ from: lastToolName, to: nowName });
        outcome.progress.push(`- 中途工具变了：${lastToolName ?? '空手'} → ${nowName ?? '空手'}`);
        lastToolName = nowName;
    };

    for (let index = 1; index <= requested; index++) {
        // ── 时间预算：到点自己收手（回执必须由工具自己交出来） ──
        if (now() >= deadline) {
            outcome.stop = 'budget';
            outcome.detail = `本轮预算 ${Math.round(budgetMs / 6000) / 10} 分钟用完`;
            break;
        }
        if (bot?.interrupt_code === true) {
            outcome.stop = 'interrupted';
            break;
        }
        const hp = health(bot);
        if (hp != null && hp <= MIN_HEALTH_TO_DIG) {
            outcome.stop = 'low_health';
            outcome.detail = `血量 ${hp} ≤ ${MIN_HEALTH_TO_DIG}`;
            break;
        }
        if (hp != null && startHealth != null && hp < startHealth) {
            outcome.stop = 'damaged';
            outcome.detail = `血量 ${startHealth} → ${hp}`;
            break;
        }

        let step = tunnelStep(position(bot), request.dir, height, index, request.rise ?? 0);

        // ── 安全门 0：**不许挖穿容器/功能方块** ──
        //
        // 真机（overnight_b）：`travelTo` 把基地的箱子 chest(12,63,1) 连承重方块一起挖了，
        // 内容物撒地——那是它们自己要用的补给点。挖存储不是这个工具该替模型做的决定：
        // 直线上撞到就**抬/降一格绕过去**（横向隧道抬一格通常就够），绕不开才停手说清楚。
        const obstruction = step.dig
            .map((cell) => ({ cell, block: blockAt(bot, cell.x, cell.y, cell.z) }))
            .find(({ block }) => isProtectedBlockName(block?.name));
        if (obstruction != null) {
            const name = normalizeName(obstruction.block?.name) ?? '读不到';
            const baseRise = request.rise ?? 0;
            let detourStep: TunnelStep | null = null;
            let detourRise = baseRise;
            for (const delta of [1, -1]) {
                const candidate = tunnelStep(position(bot), request.dir, height, index, baseRise + delta);
                const blocked = candidate.dig.some((cell) => isProtectedBlockName(blockAt(bot, cell.x, cell.y, cell.z)?.name));
                const wet = candidate.dig.some((cell) => isLiquidBlockName(blockAt(bot, cell.x, cell.y, cell.z)?.name));
                if (!blocked && !wet) {
                    detourStep = candidate;
                    detourRise = baseRise + delta;
                    break;
                }
            }
            const already = outcome.protectedHits.some(
                (hit) =>
                    hit.position.x === obstruction.cell.x &&
                    hit.position.y === obstruction.cell.y &&
                    hit.position.z === obstruction.cell.z,
            );
            if (!already) outcome.protectedHits.push({ name, position: obstruction.cell, dug: false });
            if (detourStep == null) {
                outcome.stop = 'protected_block';
                outcome.detail =
                    `${formatPoint(obstruction.cell)} 是 ${name}（**容器/功能方块**，不该挖穿），抬一格、降一格都绕不开`;
                break;
            }
            outcome.detours += 1;
            outcome.progress.push(
                `- 前方 ${formatPoint(obstruction.cell)} 是 ${name}（容器/功能方块）→ **不挖它**，` +
                    `${detourRise > baseRise ? '抬' : '降'} 1 格绕过去` +
                    (isContainerBlockName(name) ? `；**里面的东西原样没动**（要拿就用 useBlock 打开它）` : ''),
            );
            step = detourStep;
        }

        // ── 安全门 1：前方（脚/头）与前方脚下都不许是液体 ──
        const feetBlock = blockAt(bot, step.feet.x, step.feet.y, step.feet.z);
        const headBlock = blockAt(bot, step.dig[step.dig.length - 1].x, step.dig[step.dig.length - 1].y, step.dig[step.dig.length - 1].z);
        const floorBlock = blockAt(bot, step.floor.x, step.floor.y, step.floor.z);
        const named = [
            [feetBlock, step.feet, '前方脚所在格'],
            [headBlock, step.dig[step.dig.length - 1], '前方头所在格'],
            [floorBlock, step.floor, '前方脚下的格子'],
        ] as Array<[any, FlatPosition, string]>;
        const liquid = named.find(([block]) => isLiquidBlockName(block?.name));
        if (liquid != null) {
            outcome.stop = 'liquid_ahead';
            outcome.detail = `${liquid[2]} ${cellText(liquid[1], normalizeName(liquid[0]?.name))}（挖进去就是死）`;
            break;
        }

        // ── 安全门 2：前方脚下必须能踩；**是空洞就垫一块桥过去**（横向的 pillarUp） ──
        if (floorBlock == null) {
            outcome.stop = 'unreadable';
            outcome.detail = `读不到前方的支撑格 ${formatPoint(step.floor)}`;
            break;
        }
        if (isUnsupportedFloorBlock(floorBlock)) {
            // 桥下就是岩浆 → **不搭**（照旧按液体门拒绝；绝不往岩浆上垫方块）。
            const below = blockAt(bot, step.floor.x, step.floor.y - 1, step.floor.z);
            if (isLiquidBlockName(below?.name)) {
                outcome.stop = 'liquid_ahead';
                outcome.detail = `${cellText(step.floor, normalizeName(below?.name))} 就是岩浆（桥下面），不能在上面搭桥`;
                break;
            }
            const materials = scaffoldChoices(bot).slice(0, BRIDGE_MAX_MATERIALS);
            if (materials.length === 0) {
                outcome.stop = 'unsupported_floor';
                outcome.detail =
                    `${cellText(step.floor, normalizeName(floorBlock?.name))}（下一步会踩空），` +
                    `**背包里没有能垫的方块**——先弄 1 个（挖两格就有下界岩/圆石）`;
                break;
            }
            // **一次不成不代表搭不了**：换依附面、再换材料，都试过才认输
            // （真机：只给 moveAway 等于把"换个角度再来"这件事丢给模型）。
            let placedOk = false;
            let usedMaterial: string | null = null;
            let usedFace: BridgeFace | null = null;
            const tried: string[] = [];
            for (const material of materials) {
                for (const face of BRIDGE_FACES) {
                    try {
                        placedOk = await place(bot, material, step.floor.x, step.floor.y, step.floor.z, face);
                    } catch {
                        placedOk = false;
                    }
                    const now = blockAt(bot, step.floor.x, step.floor.y, step.floor.z);
                    if (now != null && !isUnsupportedFloorBlock(now)) {
                        usedMaterial = material;
                        usedFace = face;
                        break;
                    }
                    tried.push(`${material}@${face}`);
                }
                if (usedMaterial != null) break;
            }
            if (usedMaterial == null) {
                const nowBlock = blockAt(bot, step.floor.x, step.floor.y, step.floor.z);
                outcome.stop = 'bridge_failed';
                outcome.detail =
                    `搭桥：想在 ${formatPoint(step.floor)} 垫一块桥，试了 ${tried.length} 种（${tried.slice(0, 4).join('、')}）` +
                    `都没成功（现在还是 ${normalizeName(nowBlock?.name) ?? '读不到'}）`;
                break;
            }
            outcome.bridges += 1;
            outcome.progress.push(
                `- 前方脚下 ${formatPoint(step.floor)} 是空洞 → 用 ${usedMaterial} 从 ${BRIDGE_FACE_TEXT[usedFace ?? 'bottom']} 垫了一块桥过去` +
                    `（第 ${outcome.bridges} 块${tried.length > 0 ? `；先试了 ${tried.length} 次别的依附面/材料` : ''}）`,
            );
        }

        // ── 安全门 3：要挖的格子必须读得到（读不到就不猜） ──
        const digBlocks = step.dig.map((cell) => ({ cell, block: blockAt(bot, cell.x, cell.y, cell.z) }));
        const unreadable = digBlocks.find(({ block }) => block == null);
        if (unreadable != null) {
            outcome.stop = 'unreadable';
            outcome.detail = `读不到要挖的 ${formatPoint(unreadable.cell)}（区块没加载？）`;
            break;
        }

        // ── 安全门 4：没有镐时，只有徒手挖得动的方块才放行 ──
        //
        // ⚠️ **"手上没有镐" ≠ "没有镐"**（真机 overnight_b：镐就在背包里、只是没握在手上，
        // 回执却报"没有镐"，害得它掉头回去做一个已经有的工具）。所以先自己换上再判。
        let guard = refreshTool();
        // **拒绝过的工具本次动作不再选回**（Lead 2026-10-21：拒绝→换手→选回同一把 = 结构性震荡）。
        const refusedTools = new Set<string>();
        noteToolChange(guard.name);
        let hasPickaxe = guard.name != null && guard.name.includes('pickaxe');
        if (!hasPickaxe) {
            const spare = bestPickaxeInInventory(bot, null, [...(refusedTools ?? [])]);
            if (spare != null) {
                try {
                    await equip(bot, spare);
                } catch {
                    /* 换不上就按原样继续判 */
                }
                const after = refreshTool();
                if (after.name != null && after.name.includes('pickaxe')) {
                    hasPickaxe = true;
                    guard = after;
                    noteToolChange(after.name);
                    outcome.progress.push(`- 镐在背包里没握在手上 → 已自动换上 ${after.name}`);
                }
            }
        }
        const needDig = digBlocks.filter(({ block }) => !isAirBlockName(block?.name));
        if (!hasPickaxe) {
            const tooHard = needDig.find(({ block }) => {
                try {
                    return !skills.isHandMineable(block);
                } catch {
                    return true;
                }
            });
            if (tooHard != null) {
                outcome.stop = 'no_tool';
                const replacement = bestPickaxeInInventory(bot);
                outcome.hintEquip = replacement;
                outcome.detail = replacement != null
                    ? `前方 ${formatPoint(tooHard.cell)} 是 ${normalizeName(tooHard.block?.name)}，徒手挖不动；先装备 ${replacement}`
                    : `前方 ${formatPoint(tooHard.cell)} 是 ${normalizeName(tooHard.block?.name)}，徒手挖不动，背包里也没有镐`;
                break;
            }
            outcome.handMining = true;
        }

        // ── 挖：然后**验证明明变空气**（事实，不是假设）。挖不动的先换一次镐再试。──
        for (const { cell, block } of digBlocks) {
            if (isAirBlockName(block?.name)) continue;
            outcome.digAttempts += 1;
            const digOnce = async (): Promise<boolean> => {
                try {
                    return await dig(bot, cell.x, cell.y, cell.z);
                } catch {
                    return false;
                }
            };
            let ok = await digOnce();
            let after = blockAt(bot, cell.x, cell.y, cell.z);
            if (after == null || !isAirBlockName(after?.name)) {
                // **工具被换走/换手**是最常见的"挖不动"：换一把最好的镐，再试一次
                // （真机 overnight_a 的"爬了 6 格就停"就是这个形状）。
                const current = refreshTool().name;
                const spare = bestPickaxeInInventory(bot, current);
                if (spare != null) {
                    try {
                        await equip(bot, spare);
                    } catch {
                        /* 换不上就按失败处理 */
                    }
                    const switched = refreshTool().name;
                    if (switched != null && switched !== current) {
                        outcome.toolChanges.push({ from: current, to: switched });
                        outcome.progress.push(`- 挖不动 → 换成 ${switched} 再试（原来是 ${current ?? '空手'}）`);
                        outcome.digAttempts += 1;
                        ok = await digOnce();
                        after = blockAt(bot, cell.x, cell.y, cell.z);
                    }
                }
            }
            if (after == null || !isAirBlockName(after?.name)) {
                outcome.stop = 'dig_failed';
                outcome.detail =
                    `第 ${index} 步的 ${cellText(cell, normalizeName(after?.name))}${ok ? '（挖过了但没变空气）' : '（挖不动）'}`;
                refreshTool();
                return outcome;
            }
            outcome.blocksDug += 1; // **只有验证过变空气的才计数**
        }
        await sleep(settleMs);

        // ── 走进去：**位移是唯一证据**（"报成功但人没动"是最常见的假进度） ──
        const beforeStep = position(bot);
        let arrived = false;
        try {
            arrived = await travel(bot, step.feet.x, step.feet.y, step.feet.z);
        } catch {
            arrived = false;
        }
        const here = position(bot);
        outcome.here = here;
        // **格数从位移里量出来，不是数循环**：把脚的位置投影到隧道轴线上，
        // "沿轴真的走进了第几格"就是 `dug`。
        //
        // 为什么必须这样（真机 overnight_b 的回归）：「已挖 64 格 + 实测位移 0.5 格」——
        // 上一版要求"3D 距离 ≤ 0.75 就算站进那一格"，而站在 x=0.4 时到 (1,70,0) 只有 0.6 格，
        // 于是**一步没走也能算"到了"**，64 轮下来 `dug=64` 而位移 0.5。
        // 现在 `dug` 只由位置决定 ⇒ **结构上不可能大于实测位移**。
        const reachedNow = Math.max(
            0,
            // `+ 0.25`：读数要够 0.75 格才进位 ⇒ **被顶回/来回晃的半格不算一格**。
            Math.min(Math.floor(alongAxis(here) + 0.25), requested),
        );
        const distToFeet = Math.hypot(here.x - step.feet.x, here.y - step.feet.y, here.z - step.feet.z);
        const stepDist = Math.hypot(here.x - beforeStep.x, here.y - beforeStep.y, here.z - beforeStep.z);
        const reallyArrived = distToFeet <= TUNNEL_ARRIVE_EPS;
        const reallyMoved = stepDist >= TUNNEL_MOVE_EPS;
        if (reachedNow <= outcome.dug) {
            // 沿轴**没有前进**（原地、被顶回、来回晃都算）→ 这一步没有进度，不管 travel 返回什么。
            outcome.stalls += 1;
            if (outcome.stalls >= TUNNEL_MAX_STALLS) {
                outcome.stop = 'stalled';
                outcome.detail =
                    `连续 ${outcome.stalls} 步沿 ${request.dir.label} **一格都没前进**（` +
                    `${arrived ? '寻路"报成功"但位移 0' : '走不进去'}；实测位移只有 ${stepDist.toFixed(2)} 格）；` +
                    `现在 ${formatPoint(here)}，目标格 ${formatPoint(step.feet)}`;
                break;
            }
            await sleep(settleMs);
            continue;
        }
        outcome.dug = reachedNow;
        outcome.moved += 1;
        outcome.stalls = 0;
        // **先试移动原语，再决定是不是"走不进去"**（Lead 2026-10-20：四个工具同一个病，
        // 根因是让寻路器钻进 1×1 的洞；stepIntoCell 面向目标、按 forward/jump、测位移）。
        if (!reallyArrived) {
            // **消费 obstacles**：目标格挡路就挖掉再走（Lead 2026-10-21：四个工具都死在'挖通了但走不进去'）。
            const stepped = await skills.stepIntoCellClearing(bot, step.feet);
            if (stepped.moved) {
                outcome.progress.push(`- 第 ${index} 步：用 stepIntoCell 走进去了（寻路器报的"没到"是它的极限，不是人的极限）。`);
                continue;
            }
            // 原语也走不进去 ⇒ **说实话 + 给具体的下一步**，不再只写"寻路失败"。
            outcome.stop = 'travel_failed';
            const reasonText = String(stepped.reason ?? '').replace(/。+$/, '');
            outcome.detail =
                `第 ${index} 步挖通了 ${formatPoint(step.feet)}，但**走不进去**：${reasonText}。` +
                `建议：mineBlock 掉 ${formatPoint(step.feet)} 那一格（或它头顶那格）后再走；若是水/岩浆，换 goToCoordinates 绕开。`;
            break;
        }
        if (outcome.dug % progressEvery === 0) {
            outcome.progress.push(`- 沿 ${request.dir.label} 已前进 ${outcome.dug} 格，现在 ${formatPoint(outcome.here)}`);
        }
    }

    refreshTool();
    return outcome;
}

/**
 * 沿一条直线挖隧道：每一格都"先判危险 → 挖 → 验证 → 走进去"。
 *
 * 安全门（都在**挖之前**判，触发就停手并点名格子）：
 *   1. 前方脚/头、以及前方脚下那格是 lava/water → 停（就是这条害死了 overnight_a）；
 *   2. 前方脚下那格不是实心 → 停（会走进岩浆海/悬崖）；
 *   3. 没有镐且方块徒手挖不动 → 停并给 equip 提示；徒手挖得动的放行但要如实说慢；
 *   4. 镐快用完（`toolDurabilityGuard.low`）→ 停并给换镐提示；
 *   5. 掉血 / 血量过低 / 被 Stop → 停并说清挖了多少。
 */
export async function mineTunnelSkill(
    bot: any,
    rawLength?: unknown,
    rawHeight?: unknown,
    rawDirection?: unknown,
    deps: TunnelDeps = {},
    options: TunnelOptions = {},
): Promise<string> {
    const requested = clampInt(rawLength, DEFAULT_TUNNEL_LENGTH, 1, MAX_TUNNEL_LENGTH);
    const height = clampInt(rawHeight, DEFAULT_TUNNEL_HEIGHT, 1, MAX_TUNNEL_HEIGHT);
    const yaw = deps.yaw ?? ((b: any) => (Number.isFinite(Number(b?.entity?.yaw)) ? Number(b.entity.yaw) : null));
    const tool = deps.tool ?? ((b: any) => skills.toolDurabilityGuard(b));
    // 交接账本：记下"我跑过了"，并看看这条是谁交过来的。
    const startedAtMs = (deps.now ?? Date.now)();
    recordToolRun(bot, 'mineTunnel', startedAtMs);
    const handoffFrom = parseHandoff(options.handoff);
    const resolved = resolveTunnelDirection(rawDirection, yaw(bot));
    if (resolved == null) {
        // 方向认不出来：保持原来的口径（回执里点名到底哪里不对，并给工具现状）。
        const g = tool(bot);
        const outcome: TunnelOutcome = {
            dir: { axis: 'x', sign: 1, label: '+x', fromYaw: false },
            height,
            requested,
            dug: 0,
            blocksDug: 0,
            digAttempts: 0,
            moved: 0,
            toolChanges: [],
            stalls: 0,
            start: (deps.position ?? defaultPosition)(bot),
            here: (deps.position ?? defaultPosition)(bot),
            stop: 'bad_direction',
            detail:
                typeof rawDirection === 'string' && rawDirection.trim() !== ''
                    ? `direction="${rawDirection}" 认不出来（只认 ±x / ±z / east / west / north / south，或留空按朝向）`
                    : '没给 direction，而且读不到 entity.yaw',
            hintEquip: null,
            progress: [],
            toolName: g.name,
            toolRemaining: g.remaining,
            toolMax: g.max,
            handMining: false,
            bridges: 0,
            protectedHits: [],
            detours: 0,
            handoffFrom,
        };
        return tunnelReceipt(outcome);
    }
    const outcome = await digLine(
        bot,
        { dir: resolved, length: requested, height, budgetMs: options.budgetMs ?? DEFAULT_TUNNEL_BUDGET_MS },
        deps,
        options,
    );
    outcome.handoffFrom = handoffFrom;
    return tunnelReceipt(outcome);
}

/** 背包里最好的一把镐（有镐才能继续挖；换镐提示要能直接照抄）。 */
// **耐久感知**（Lead 2026-10-21）：层级最高 ≠ 还能用；把选择交给共享决策函数，
// 并且排除本次动作里已被安全门拒绝的工具（否则"拒绝→换手→选回同一把"是结构性震荡）。
export function bestPickaxeInInventory(bot: any, exclude?: string | null, excluded?: string[]): string | null {
    let items: unknown[];
    try {
        items = (bot?.inventory?.items?.() ?? []) as unknown[];
    } catch {
        return null;
    }
    if (!Array.isArray(items)) return null;
    const excludedNames = [...(excluded ?? [])];
    if (typeof exclude === 'string' && exclude !== '') excludedNames.push(exclude);
    // 便宜优先：走一步路只需挖 1 格（usesNeeded=1）⇒ 快断的镐正好用掉，满耐久留给硬活。
    const choice = chooseToolForJob({ tools: items as ToolCandidate[], kind: 'pickaxe', minimumTier: 'wooden', usesNeeded: 1, excluded: excludedNames });
    return choice.name;
}

// ─────────────────────────── 长途赶路（travelTo） ───────────────────────────
//
// 为什么要有（2026-10-19 的瓶颈）：这两个 bot 反复死在**长多步任务**上。
// `mineTunnel(length=64)` 单腿很好用，但 500 格要走 ~8 腿，模型在两次调用之间会丢线
// （overnight_b 被指到 500 格外的要塞，结果在基地待了一小时；overnight_a 走 60 格到
// 末地门也没到）。`getFood` / `escapeWater` / `mineTunnel` 之所以有效，都是因为把多步链
// 变成了**一次调用**——travelTo 是同一个动作，用在赶路上：**模型只调一次，人往前走一大截**。
//
// 路线自己挑（不许模型自己算两条腿和顺序——那正是它丢的东西）：
//   同 y     → 直线隧道（第一步先试走路，走得到就不挖）
//   有高差   → 先 `stairUp`（上）或 `digDown`（下）到目标高度
//   斜向     → **一次只走一条轴，长的先走**；走完自动重新规划 → 自动换轴
//
// 安全门**一格都不许放宽**：每一格还是走 `digLine`（读格子 → 判危险 → 挖 → 验证明明变空气 →
// 走进去），lava/水、脚下不实心、镐快用完、掉血、Stop、读不到方块全都照旧触发即停。

export const DEFAULT_TRAVEL_MAX_MS = 5 * 60 * 1000;
export const TRAVEL_MAX_MS_LIMIT = 6 * 60 * 1000;
/** 每推进这么多格报一次进度。 */
export const TRAVEL_PROGRESS_EVERY = 32;
/**
 * 下界长途的推荐层（真机实测）：y=112~120 **97% 是实心下界岩、几乎没有岩浆**；
 * 而 y=68~80 只有 ~35% 实心（全是洞 ⇒ 掉下去/岩浆/寻路卡死）。
 * 在下界做水平长途时默认爬到这一层修直隧道：把"跳洞"变成"挖矿"，差别是数量级的。
 */
export const NETHER_TRAVEL_LAYER = 116;
export const NETHER_LAYER_LOW = 112;
export const NETHER_LAYER_HIGH = 120;
/** 短距离先试一次走路（走得到就别挖）：60 格走到末地门这种就该走，走不动下一腿自动改挖。 */
export const TRAVEL_WALK_MAX_BLOCKS = 64;
export const TRAVEL_WALK_BUDGET_MS = 45_000;
/** 竖直段一次最多爬/下多少格（剩下的下一趟接着来）。 */
export const TRAVEL_MAX_VERTICAL_PER_LEG = 64;
/** 单腿最多挖多少格（剩下的下一趟接着来）。 */
export const TRAVEL_MAX_HORIZONTAL_PER_LEG = 256;
export const TRAVEL_VERTICAL_BUDGET_MS = 90_000;
/** 剩余预算少于这个值就不再开新腿（宁可老实收手）。 */
export const TRAVEL_MIN_LEG_MS = 10_000;
/** 水平距离 ≤ 这个值就算到了（站到目标旁边，不用严丝合缝）。 */
export const TRAVEL_ARRIVE_RADIUS = 2;
/** 推进少于这么多格就要在回执里**点名拦路的东西**（真机："只推进 2.3 格"却看不出被什么挡住）。 */
export const TRAVEL_SMALL_ADVANCE = 5;
/** 走路的停滞检查间隔（ms）。 */
export const TRAVEL_WALK_STALL_POLL_MS = 5_000;
/** 连续这么久没有靠近目标 ⇒ 判定"卡住了"（真机：水边干等 90 秒）。 */
export const TRAVEL_WALK_STALL_MS = 15_000;
/** 算"变近了"的最小幅度（格）：小于它不算进步（抖动/被顶开不算）。 */
export const TRAVEL_WALK_STALL_MIN_GAIN = 0.5;
export const TRAVEL_TUNNEL_HEIGHT = DEFAULT_TUNNEL_HEIGHT;

/** 维度名的归一（模型可能写 nether / 下界 / the_nether）。 */
export function normalizeDimensionName(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase();
    if (value === '') return null;
    if (['the_nether', 'nether', '下界', '地狱'].includes(value)) return 'the_nether';
    if (['overworld', 'the_overworld', '主世界', '地上'].includes(value)) return 'overworld';
    if (['the_end', 'end', '末地', '末路之地'].includes(value)) return 'the_end';
    return value;
}

export interface TravelLegPlan {
    kind: 'walk' | 'stairUp' | 'digDown' | 'tunnel' | 'stairTunnel';
    blocks: number;
    axis: 'x' | 'z' | null;
    sign: 1 | -1 | null;
    /** 斜上(+1)/斜下(-1)台阶；平台隧道不带这个字段。 */
    rise?: 1 | -1;
    /** 人类可读（进回执）。 */
    label: string;
}

/** 目标层：给了就用给的；否则下界水平长途默认修到 `NETHER_TRAVEL_LAYER`。 */
export function chooseTravelLayer(options: {
    dimension: string | null;
    dx: number;
    dz: number;
    requested: number | null;
}): { layer: number | null; note: string } {
    if (options.requested != null && Number.isFinite(options.requested)) {
        const layer = Math.max(-60, Math.min(320, Math.round(options.requested)));
        return { layer, note: `按指定的 layer=${layer} 走。` };
    }
    const horizontal = Math.max(Math.abs(options.dx), Math.abs(options.dz));
    if (options.dimension === 'the_nether' && horizontal >= TRAVEL_WALK_MAX_BLOCKS) {
        return {
            layer: NETHER_TRAVEL_LAYER,
            note:
                `下界水平长途：默认先爬到 **y=${NETHER_TRAVEL_LAYER}** 再修直隧道——实测这一带` +
                `（y=${NETHER_LAYER_LOW}~${NETHER_LAYER_HIGH}）**97% 是实心下界岩、几乎没有岩浆**，` +
                `而 y=68~80 只有 ~35% 实心（全是洞：掉下去 / 岩浆 / 寻路卡死）。`,
        };
    }
    return { layer: null, note: '' };
}

/**
 * 只规划**下一条腿**（走完重新规划，所以位置/地形变了也不会照着过期计划走）。
 * 顺序：竖直段 → 短距离走路 → 长轴隧道（另一条轴下一趟自动接上）。
 */
export function planTravelLegs(
    from: FlatPosition,
    to: FlatPosition,
    options: { walkAllowed: boolean; walkFailed?: boolean },
): TravelLegPlan[] {
    const legs: TravelLegPlan[] = [];
    const dy = Math.round(to.y) - Math.round(from.y);
    if (Math.abs(dy) >= 2) {
        const blocks = Math.min(Math.abs(dy), TRAVEL_MAX_VERTICAL_PER_LEG);
        const dx0 = Math.round(to.x) - Math.round(from.x);
        const dz0 = Math.round(to.z) - Math.round(from.z);
        const horizontal = Math.max(Math.abs(dx0), Math.abs(dz0));
        if (dy > 0) {
            if (horizontal >= 1) {
                // **斜上台阶**：一边往前挖一边往上走——爬 46 格不需要 46 块垫脚料。
                const axis: 'x' | 'z' = Math.abs(dx0) >= Math.abs(dz0) ? 'x' : 'z';
                const sign: 1 | -1 = (axis === 'x' ? dx0 : dz0) >= 0 ? 1 : -1;
                const label = `${sign > 0 ? '+' : '-'}${axis}` as '+x' | '-x' | '+z' | '-z';
                legs.push({
                    kind: 'stairTunnel',
                    blocks,
                    axis,
                    sign,
                    label: `竖直段：沿 ${label} 挖**斜上台阶** ${blocks} 格（y ${Math.round(from.y)} → ${Math.round(from.y) + blocks}，目标 y=${Math.round(to.y)}；不用垫脚料）`,
                });
            } else {
                legs.push({
                    kind: 'stairUp',
                    blocks,
                    axis: null,
                    sign: null,
                    label: `竖直段：stairUp ${blocks} 格（y ${Math.round(from.y)} → ${Math.round(from.y) + blocks}，目标 y=${Math.round(to.y)}；要垫脚方块）`,
                });
            }
        } else {
            if (horizontal >= 1) {
                // **斜下台阶**：一边往前挖一边往下走（比 digDown 的 1×1 竖井稳，也能搭桥）。
                const axis: 'x' | 'z' = Math.abs(dx0) >= Math.abs(dz0) ? 'x' : 'z';
                const sign: 1 | -1 = (axis === 'x' ? dx0 : dz0) >= 0 ? 1 : -1;
                const label = `${sign > 0 ? '+' : '-'}${axis}` as '+x' | '-x' | '+z' | '-z';
                legs.push({
                    kind: 'stairTunnel',
                    blocks,
                    axis,
                    sign,
                    rise: -1,
                    label: `竖直段：沿 ${label} 挖**斜下台阶** ${blocks} 格（y ${Math.round(from.y)} → ${Math.round(from.y) - blocks}，目标 y=${Math.round(to.y)}）`,
                });
            } else {
                legs.push({
                    kind: 'digDown',
                    blocks,
                    axis: null,
                    sign: null,
                    label: `竖直段：digDown ${blocks} 格（y ${Math.round(from.y)} → ${Math.round(from.y) - blocks}，目标 y=${Math.round(to.y)}）`,
                });
            }
        }
        return legs;
    }
    const dx = Math.round(to.x) - Math.round(from.x);
    const dz = Math.round(to.z) - Math.round(from.z);
    const straight = Math.max(Math.abs(dx), Math.abs(dz));
    if (straight <= TRAVEL_ARRIVE_RADIUS) return legs;
    if (options.walkAllowed && options.walkFailed !== true && straight <= TRAVEL_WALK_MAX_BLOCKS) {
        legs.push({ kind: 'walk', blocks: straight, axis: null, sign: null, label: `水平段：先试着走过去（${straight} 格，不用挖）` });
        return legs;
    }
    // 一次只走一条轴：**长的先走**（走完重新规划 → 自动换到另一条轴）。
    const axis: 'x' | 'z' = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
    const delta = axis === 'x' ? dx : dz;
    const other = axis === 'x' ? dz : dx;
    const sign: 1 | -1 = delta >= 0 ? 1 : -1;
    const label = `${sign > 0 ? '+' : '-'}${axis}` as '+x' | '-x' | '+z' | '-z';
    const otherText = other === 0 ? '' : `；另一轴（${axis === 'x' ? 'z' : 'x'}）还差 ${Math.abs(other)} 格，这条走完自动换`;
    legs.push({
        kind: 'tunnel',
        blocks: Math.min(Math.abs(delta), TRAVEL_MAX_HORIZONTAL_PER_LEG),
        axis,
        sign,
        label: `水平段：沿 ${label} 挖 ${Math.min(Math.abs(delta), TRAVEL_MAX_HORIZONTAL_PER_LEG)} 格（这个轴还差 ${Math.abs(delta)} 格${otherText}）`,
    });
    return legs;
}

/**
 * 规划用的目标高度：**水平还没走完时先走在 `layer` 那一层**（下界默认 116：
 * 实心、少岩浆），只剩最后一小段时才下/上到真正的目标 y。
 * 这样"500 格洞窟跳"就变成"500 格挖矿"，而最后该去的 y 也不会被丢掉。
 */
function planningTarget(here: FlatPosition, target: FlatPosition, layer: number | null): FlatPosition {
    if (layer == null) return target;
    if (horizontalDistance(here, target) <= TRAVEL_ARRIVE_RADIUS) return target;
    return { x: target.x, y: layer, z: target.z };
}

export type TravelStop =
    | 'arrived'
    | 'budget'
    | 'interrupted'
    | 'low_health'
    | 'blocked'
    | 'no_pickaxe'
    | 'wrong_dimension'
    | 'bad_target';

const TRAVEL_STOP_TEXT: Record<TravelStop, string> = {
    arrived: '到目的地了',
    budget: '时间预算用完（下一趟接着走）',
    interrupted: '被 Stop/保命打断',
    low_health: '血量太低，停手保命',
    blocked: '安全门触发了，停手',
    no_pickaxe: '没有能用的镐，挖不动',
    wrong_dimension: '目标不在当前维度',
    bad_target: '坐标读不出来',
};

export interface TravelLegResult {
    plan: TravelLegPlan;
    /** 这一腿**真实**推进了多少格（按位置增量算，不是按计划）。 */
    advanced: number;
    /** 一腿一句话（进回执）。 */
    text: string;
    /** 安全门触发时的隧道结果（保留原始措辞）。 */
    tunnel?: TunnelOutcome;
}

export interface TravelOutcome {
    target: FlatPosition;
    start: FlatPosition;
    here: FlatPosition;
    /** 起手时离目标多远（用来算"推进了多少格"）。 */
    distanceBefore: number;
    /** 检测到"两个工具互相踢皮球"时的那一行（**必须说出来**：两个工具都没动、为什么）。 */
    cycle?: string | null;
    /** 出发前后的零碎事实（例如"镐在背包里 → 已自动换上"），**不许静默**。 */
    notes?: string[];
    /** **实测位移**（起点 → 现在，3D 直线距离）——这是唯一能当"推进"用的数。 */
    progressed: number;
    /** 这一趟挖掉并验证变空气的方块数（和位移对照着看）。 */
    blocksDug: number;
    stop: TravelStop;
    detail: string;
    layer: number | null;
    layerNote: string;
    legs: TravelLegResult[];
    /** 触发停止的安全门（原话，来自 digLine）。 */
    gate: string | null;
    /** 安全门自己的下一步（`tunnelNextAction`），优先于普通续跑。 */
    gateNextCall: string | null;
    toolName: string | null;
    toolRemaining: number | null;
    toolMax: number | null;
    handMining: boolean;
    budgetMs: number;
    elapsedMs: number;
    progress: string[];
    /** 需不需要在下一趟带 `layer`。 */
    yExplicit: boolean;
}

/** 续跑调用：**从当前断点继续朝同一个目标走**（人已经往前挪了，所以这就是"剩下的那一段"）。 */
export function travelResumeCall(o: TravelOutcome): string {
    const parts = [`x=${Math.round(o.target.x)}`, `y=${Math.round(o.target.y)}`, `z=${Math.round(o.target.z)}`];
    if (o.layer != null) parts.push(`layer=${o.layer}`);
    parts.push(`max_ms=${o.budgetMs}`);
    return `travelTo(${parts.join(', ')})`;
}

export function travelNextAction(o: TravelOutcome): string {
    if (o.gateNextCall != null) return o.gateNextCall;
    switch (o.stop) {
        case 'arrived':
            return 'stats(type="body")';
        case 'no_pickaxe':
            return 'useBlock(type="crafting_table", input="3 cobblestone, 2 stick", output="1 stone_pickaxe")';
        case 'wrong_dimension':
            return o.detail.includes('the_nether') ? 'enterNether()' : 'getPlaces';
        case 'interrupted':
        case 'low_health':
            return 'survivalCheck';
        case 'bad_target':
            return 'stats(type="coords")';
        default:
            // **0 进度不许把同一条调用原样丢回去**（那正是"原地打转"的形状）：
            // 先看清身体状态/手上工具，再决定要不要重来。
            if (o.progressed < TUNNEL_MOVE_EPS) return 'stats(type="body")';
            return travelResumeCall(o);
    }
}

/** 剩余方向的短描述（+x 314 格、+z 40 格）。 */
export function travelRemainingLabel(o: TravelOutcome): string {
    const dx = Math.round(o.target.x) - Math.round(o.here.x);
    const dz = Math.round(o.target.z) - Math.round(o.here.z);
    const parts: string[] = [];
    if (dx !== 0) parts.push(`${dx > 0 ? '+x' : '-x'} ${Math.abs(dx)} 格`);
    if (dz !== 0) parts.push(`${dz > 0 ? '+z' : '-z'} ${Math.abs(dz)} 格`);
    if (parts.length === 0) return '';
    return `方向 ${parts.join('、')}`;
}

export function travelReceipt(o: TravelOutcome): string {
    const lines: string[] = [];
    const remaining = horizontalDistance(o.here, o.target);
    const progressed = Math.round(o.progressed);
    const label = travelRemainingLabel(o);
    if (o.stop === 'arrived') {
        lines.push(
            `travelTo：**到了**——现在 ${formatPoint(o.here)}（目标 ${formatPoint(o.target)}，水平还差 ${remaining.toFixed(1)} 格）。` +
                `这一趟**实测位移 ${o.progressed.toFixed(1)} 格**。`,
        );
    } else if (o.stop === 'bad_target' || o.stop === 'wrong_dimension' || o.stop === 'no_pickaxe') {
        lines.push(`travelTo：**没出发**（还站在 ${formatPoint(o.here)}）——${TRAVEL_STOP_TEXT[o.stop]}。`);
    } else {
        // **位移是标题**：挖了多少方块、计划了多少格，都不如"人到底挪了几格"。
        // **0 位移时标题直接写"卡在什么"**（真机：两个工具互相踢皮球、同一位置都 0 位移，
        // 回执却看不出卡在哪儿）。
        if (o.progressed < TUNNEL_MOVE_EPS) {
            const why = o.detail !== '' ? o.detail : o.gate != null ? o.gate : TRAVEL_STOP_TEXT[o.stop];
            lines.push(
                `travelTo：这一趟**净前进 0 格**（实测位移 ${o.progressed.toFixed(1)} 格：` +
                    `${formatPoint(o.start)} → 现在 ${formatPoint(o.here)}）：**卡在**「${why}」。` +
                    `**离目标还剩 ${Math.round(remaining)} 格**${label === '' ? '' : `（${label}）`}。`,
            );
        } else {
            lines.push(
                `travelTo：这一趟**往前推进了 ${progressed} 格（实测位移 ${o.progressed.toFixed(1)} 格**：` +
                    `${formatPoint(o.start)} → 现在 ${formatPoint(o.here)}），**离目标还剩 ${Math.round(remaining)} 格**` +
                    `${label === '' ? '' : `（${label}）`}。`,
            );
        }
    }
    lines.push(`停止原因：${TRAVEL_STOP_TEXT[o.stop]}${o.detail === '' ? '' : `——${o.detail}`}。`);
    for (const note of o.notes ?? []) lines.push(`- ${note}`);
    // **小推进必须点名拦路的东西**（真机："挖通了但寻路失败、只推进 2.3 格"，回执里看不出被什么挡住）。
    if (o.stop !== 'arrived' && o.stop !== 'bad_target' && o.stop !== 'wrong_dimension' && o.stop !== 'no_pickaxe') {
        if (o.progressed < TRAVEL_SMALL_ADVANCE) {
            const why = o.detail !== '' ? o.detail : o.gate !== undefined ? o.gate : TRAVEL_STOP_TEXT[o.stop];
            lines.push(`⚠️ 这一趟**只推进了 ${o.progressed.toFixed(1)} 格**（< ${TRAVEL_SMALL_ADVANCE} 格）：**卡在**「${why}」。`);
        }
    }
    // **挖了 ≠ 走了**：三项证据不一致就摆在最前面几行。
    if (o.blocksDug > 0 && o.progressed < TUNNEL_MOVE_EPS) {
        lines.push(
            `⚠️ **矛盾**：这一趟挖掉了 ${o.blocksDug} 个方块（都验证过变空气），但**位移只有 ${o.progressed.toFixed(1)} 格**——` +
                `人不在地道里/被卡住了。**别把挖掉的方块当成走过的路。**`,
        );
    } else if (o.blocksDug === 0 && o.progressed < TUNNEL_MOVE_EPS && o.stop !== 'arrived') {
        lines.push('⚠️ 这一趟**既没挖到东西、人也没挪动**（0 格）——按证据就是白跑一趟，别当成"走了一段"。');
    }
    if (o.layer != null && o.layerNote !== '') lines.push(`层高：${o.layerNote}`);
    for (const leg of o.legs) lines.push(`- ${leg.text}`);
    for (const line of capLines(o.progress, 4, '进度')) lines.push(line);
    if (o.gate != null) lines.push(`⚠️ 安全门（来自隧道那一格一格的门，一步没放宽）：${o.gate}`);
    if (o.handMining) lines.push('⚠️ **手上和背包里都没有镐**：这些方块是**徒手挖**的，很慢，能找/做一把就先做。');
    if (o.toolName != null) {
        lines.push(
            o.toolRemaining == null
                ? `镐：${o.toolName}（上限读不到，算不出还剩几次）。`
                : `镐：${o.toolName} 还剩约 ${o.toolRemaining} 次（${o.toolMax ?? '?'} 上限）。`,
        );
    }
    if (o.cycle != null && o.cycle !== '') lines.push(o.cycle);
    lines.push(`下一步（照做即可）：${travelNextAction(o)}`);
    return capReceipt(lines.join('\n'));
}

export interface TravelOptions {
    budgetMs?: number;
    /** 允许"先试走路"（默认允许；下界横向的调用方可以关掉）。 */
    walkAllowed?: boolean;
    /** 交接章：`handoff="mineTunnel"` = "这条是 mineTunnel 交过来的"。 */
    handoff?: unknown;
}

export interface TravelDeps extends TunnelDeps {
    /** 走路（默认 `skills.goToPosition`）。 */
    walk?: (bot: any, x: number, y: number, z: number) => Promise<boolean>;
    /** 上台阶（默认 `skills.stairUp`）。 */
    stairUp?: (bot: any, distance: number) => Promise<boolean>;
    /** 往下挖（默认 `skills.digDown`）。 */
    digDown?: (bot: any, distance: number) => Promise<boolean>;
    /** 让寻路器停手（默认 `bot.pathfinder.stop()`）：走路停滞熔断时用。 */
    stopWalk?: (bot: any) => void;
    /** 当前维度（默认 `bot.game.dimension`）。 */
    dimension?: (bot: any) => string | null;
}

/**
 * 一次调用把"赶路"往前推一大截：自己选路线、自己换腿，到点/触门就停并给**续跑调用**。
 *
 * 只认事实：推进量按**位置增量**算（不是"我计划挖 186 格"），每一格都由 `digLine`
 * 验证过"明明变成空气"才走进去。
 */
export async function travelToSkill(
    bot: any,
    rawX?: unknown,
    rawY?: unknown,
    rawZ?: unknown,
    rawMaxMs?: unknown,
    rawLayer?: unknown,
    rawDimension?: unknown,
    deps: TravelDeps = {},
    options: TravelOptions = {},
): Promise<string> {
    const budgetMs = clampInt(rawMaxMs, DEFAULT_TRAVEL_MAX_MS, 10_000, TRAVEL_MAX_MS_LIMIT);
    const position = deps.position ?? defaultPosition;
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? sleepMs;
    const health = deps.health ?? defaultTunnelHealth;
    const tool = deps.tool ?? ((b: any) => skills.toolDurabilityGuard(b));
    const blockAt = deps.blockAt ?? defaultBlockObject;
    const dig = deps.dig ?? ((b: any, x: number, y: number, z: number) => skills.mineBlockAt(b, x, y, z));
    const travelStep = deps.travel ?? ((b: any, x: number, y: number, z: number) => skills.goToPosition(b, x, y, z, 1));
    const walk = deps.walk ?? ((b: any, x: number, y: number, z: number) => skills.goToPosition(b, x, y, z, TRAVEL_ARRIVE_RADIUS));
    /** 让寻路器停手（默认 `bot.pathfinder.stop()`）——停滞熔断时要真的停，不能跟下一腿抢身体。 */
    const stopWalk = deps.stopWalk ?? ((b: any) => b?.pathfinder?.stop?.());
    const stairUp = deps.stairUp ?? ((b: any, distance: number) => skills.stairUp(b, distance));
    const digDown = deps.digDown ?? ((b: any, distance: number) => skills.digDown(b, distance));
    const dimension =
        deps.dimension ?? ((b: any) => (typeof b?.game?.dimension === 'string' ? String(b.game.dimension) : null));

    const startedAt = now();
    const start = position(bot);
    const x = Number(rawX);
    const z = Number(rawZ);
    const currentDimension = dimension(bot);
    const wantedDimension = normalizeDimensionName(rawDimension);
    const layerHint = rawLayer == null || rawLayer === '' ? null : Number(rawLayer);
    const layerChoice = chooseTravelLayer({
        dimension: currentDimension,
        dx: Number.isFinite(x) ? x - start.x : 0,
        dz: Number.isFinite(z) ? z - start.z : 0,
        requested: layerHint != null && Number.isFinite(layerHint) ? layerHint : null,
    });
    const layer = layerChoice.layer;
    const yGiven = Number.isFinite(Number(rawY)) && rawY != null && rawY !== '';
    const targetY = yGiven ? Math.max(-64, Math.min(320, Math.round(Number(rawY)))) : (layer ?? Math.round(start.y));
    const target: FlatPosition = { x: Number.isFinite(x) ? Math.round(x) : start.x, y: targetY, z: Number.isFinite(z) ? Math.round(z) : start.z };
    // 交接账本：**先读上一次的状态**（谁跑的、谁交给谁），再记下"我跑过了"——
    // 顺序反了就会把自己这次写进去，于是"兄弟刚跑过"这条证据被覆盖，循环永远查不出来。
    const lastRunBefore = lastToolRun(bot);
    recordToolRun(bot, 'travelTo', now());
    const handoffFrom = parseHandoff(options.handoff);

    const outcome: TravelOutcome = {
        target,
        start,
        here: start,
        distanceBefore: horizontalDistance(start, target),
        progressed: 0,
        blocksDug: 0,
        stop: 'arrived',
        detail: '',
        cycle: null,
        layer,
        layerNote: layerChoice.note,
        legs: [],
        gate: null,
        gateNextCall: null,
        toolName: null,
        toolRemaining: null,
        toolMax: null,
        handMining: false,
        budgetMs,
        elapsedMs: 0,
        progress: [],
        yExplicit: yGiven,
    };

    const refreshTool = (): void => {
        const g = tool(bot);
        outcome.toolName = g.name;
        outcome.toolRemaining = g.remaining;
        outcome.toolMax = g.max;
    };
    refreshTool();

    // ── 诚实拒绝 1：坐标读不出来 ──
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
        outcome.stop = 'bad_target';
        outcome.detail = `x/z 读不出来（收到 x=${String(rawX)}, z=${String(rawZ)}）`;
        return travelReceipt(outcome);
    }
    // ── 诚实拒绝 2：目标在别的维度 ──
    if (wantedDimension != null && currentDimension != null && wantedDimension !== currentDimension) {
        outcome.stop = 'wrong_dimension';
        outcome.detail =
            `目标是 ${wantedDimension}，你现在在 ${currentDimension}——**跨维度要先走传送门**` +
            (wantedDimension === 'the_nether' ? '（用 enterNether()）' : '（先走回你进来时的那个门：getPlaces 找坐标）');
        return travelReceipt(outcome);
    }

    const deadline = startedAt + budgetMs;
    let walkFailed = false;
    const walkAllowed = options.walkAllowed ?? currentDimension !== 'the_nether';

    // ── 诚实拒绝 3：要挖但没镐（不出发，而不是挖两下再失败） ──
    const planProbe = planTravelLegs(start, planningTarget(start, target, layer), { walkAllowed });
    const needsDigging = planProbe.some((leg) => leg.kind !== 'walk');
    const guard0 = tool(bot);
    const equippedPickaxe = guard0.name != null && guard0.name.includes('pickaxe');
    const sparePickaxe = bestPickaxeInInventory(bot);
    if (needsDigging && !equippedPickaxe && sparePickaxe == null) {
        outcome.stop = 'no_pickaxe';
        outcome.detail =
            `这条路线要挖（${planProbe.map((leg) => leg.kind).join('+')}），但手上和背包里都没有镐；` +
            '镐是 3×3 配方，**要在工作台上做**（2×2 放不下）';
        return travelReceipt(outcome);
    }
    if (needsDigging && !equippedPickaxe && sparePickaxe != null) {
        // **镐在背包里、只是没握在手上**：自己换上，不许因为"手上不是镐"就说没镐
        // （真机 overnight_b 因此掉头回去做一个已经有的工具）。
        const swap = deps.equip ?? ((b: any, item: string) => skills.equip(b, item));
        try {
            await swap(bot, sparePickaxe);
        } catch {
            /* 下面按"换上了没有"如实记 */
        }
        const after = tool(bot);
        const nowHeld = after.name != null && after.name.includes('pickaxe');
        (outcome.notes ??= []).push(
            nowHeld
                ? `镐在背包里没握在手上 → 已自动换上 ${after.name}。`
                : `背包里有 ${sparePickaxe}，但自动换镐没成功（手上还是 ${after.name ?? '空手'}）——会按徒手规则走，慢且更危险。`,
        );
    }

    for (;;) {
        const here = position(bot);
        outcome.here = here;
        outcome.elapsedMs = now() - startedAt;
        const remaining = horizontalDistance(here, target);
        const heightLeft = Math.abs(Math.round(target.y) - Math.round(here.y));
        if (remaining <= TRAVEL_ARRIVE_RADIUS && heightLeft <= 2) {
            outcome.stop = 'arrived';
            break;
        }
        if (bot?.interrupt_code === true) {
            outcome.stop = 'interrupted';
            break;
        }
        const left = deadline - now();
        if (left <= 0) {
            outcome.stop = 'budget';
            outcome.detail = `本轮预算 ${Math.round(budgetMs / 6000) / 10} 分钟用完（还剩 ${Math.round(remaining)} 格）`;
            break;
        }
        if (left < TRAVEL_MIN_LEG_MS) {
            outcome.stop = 'budget';
            outcome.detail = `只剩 ${Math.round(left / 1000)} 秒，不够再开一条腿（还剩 ${Math.round(remaining)} 格）`;
            break;
        }
        const hp = health(bot);
        if (hp != null && hp <= MIN_HEALTH_TO_DIG) {
            outcome.stop = 'low_health';
            outcome.detail = `血量 ${hp} ≤ ${MIN_HEALTH_TO_DIG}`;
            break;
        }

        const legs = planTravelLegs(here, planningTarget(here, target, layer), { walkAllowed, walkFailed });
        const leg = legs[0];
        if (leg == null) {
            outcome.stop = 'arrived';
            break;
        }

        const before = position(bot);
        if (leg.kind === 'walk') {
            let arrived = false;
            // **停滞熔断（用在移动上）**：真机「goToCoordinates 卡在水边 90 秒不动」——
            // 寻路器没靠近就一直在那儿磨。这里盯着"离这一腿目标有没有变近"，
            // 连续 `TRAVEL_WALK_STALL_MS` 没变近就**停手改挖隧道**（而不是继续等）。
            const walkStart = position(bot);
            let stalledMs = 0;
            let stalled = false;
            let walkDone = false;
            let bestDistance = distance3(walkStart, target);
            const walkPromise = (async (): Promise<boolean> => {
                try {
                    return await walk(bot, target.x, target.y, target.z);
                } catch {
                    return false;
                } finally {
                    walkDone = true;
                }
            })();
            const watcher = (async (): Promise<void> => {
                while (!walkDone) {
                    await sleep(TRAVEL_WALK_STALL_POLL_MS);
                    if (walkDone) return;
                    const nowDistance = distance3(position(bot), target);
                    if (nowDistance < bestDistance - TRAVEL_WALK_STALL_MIN_GAIN) {
                        bestDistance = nowDistance;
                        stalledMs = 0;
                        continue;
                    }
                    stalledMs += TRAVEL_WALK_STALL_POLL_MS;
                    if (stalledMs >= TRAVEL_WALK_STALL_MS) {
                        stalled = true;
                        try {
                            stopWalk(bot);
                        } catch {
                            /* 停不下来也要如实说 */
                        }
                        return;
                    }
                }
            })();
            try {
                arrived = await Promise.race([walkPromise, watcher.then(() => false)]);
            } catch {
                arrived = false;
            }
            if (stalled) {
                // 让寻路器有机会真的停下来，再确认"人不动了"（不然会跟下一腿抢身体）。
                await sleep(TRAVEL_WALK_STALL_POLL_MS);
                const settled = distance3(position(bot), walkStart) < 0.5;
                outcome.legs.push({
                    plan: leg,
                    advanced: 0,
                    text:
                        `${leg.label} → **寻路 ${Math.round(TRAVEL_WALK_STALL_MS / 1000)} 秒没靠近**（卡在水边/墙边？）` +
                        (settled ? '，已停手，下一腿改挖隧道（绕过去）' : '，而且人还在动——这次不再往下走，先确认身体状态'),
                });
                outcome.here = position(bot);
                if (!settled) {
                    outcome.stop = 'blocked';
                    outcome.detail = `寻路卡住而且停不下来（现在 ${formatPoint(position(bot))}），先 stats 看清身体状态`;
                    outcome.gate = '寻路没靠近、也没能停下';
                    outcome.gateNextCall = 'stats(type="body")';
                    break;
                }
                walkFailed = true;
                await sleep(150);
                continue;
            }
            const after = position(bot);
            outcome.here = after;
            const advanced = Math.max(0, horizontalDistance(walkStart, target) - horizontalDistance(after, target));
            if (advanced < 1 && !arrived) {
                // 走不过去：换成隧道（下一次规划会切到 tunnel），这一腿如实说"没走动"。
                walkFailed = true;
                outcome.legs.push({ plan: leg, advanced: 0, text: `${leg.label} → **没走动**（寻路失败），下一腿改挖隧道` });
                await sleep(150);
                continue;
            }
            outcome.legs.push({
                plan: leg,
                advanced,
                text: `${leg.label} → 实际推进 ${advanced.toFixed(1)} 格${arrived ? '（到了）' : ''}`,
            });
            await sleep(150);
            continue;
        }

        if (leg.kind === 'stairUp' || leg.kind === 'digDown') {
            const legBudget = Math.min(TRAVEL_VERTICAL_BUDGET_MS, Math.max(5_000, left - 5_000));
            const startedLeg = now();
            let ok = false;
            try {
                ok = leg.kind === 'stairUp' ? await stairUp(bot, leg.blocks) : await digDown(bot, leg.blocks);
            } catch {
                ok = false;
            }
            const after = position(bot);
            outcome.here = after;
            const dy = Math.round(after.y) - Math.round(before.y);
            const wanted = leg.kind === 'stairUp' ? leg.blocks : -leg.blocks;
            outcome.legs.push({
                plan: leg,
                advanced: Math.abs(dy),
                text:
                    `${leg.label} → 实际 y ${Math.round(before.y)} → ${Math.round(after.y)}（${dy >= 0 ? '+' : ''}${dy} 格，` +
                    `${ok ? '完成' : '没走完'}；这一腿用了 ${Math.round((now() - startedLeg) / 1000)} 秒）`,
            });
            if (dy === 0 && !ok) {
                outcome.stop = 'blocked';
                outcome.detail = `竖直段没推进（${leg.kind} ${leg.blocks} 格没成功），不硬钻`;
                // 竖直段失败通常是**缺垫脚料**（stairUp）或**下不去**（digDown 遇到岩浆/水）：
                // 别再给同一条会被照抄的续跑调用（那会原地打转），先让模型看清背包。
                outcome.gate = '竖直段没进步：stairUp 要垫脚方块，digDown 可能是下面有岩浆/水';
                outcome.gateNextCall = 'stats(type="inventory")';
                break;
            }
            if (Math.abs(dy - wanted) >= 2 && now() >= deadline) break;
            await sleep(150);
            continue;
        }

        // ── 隧道腿（含斜上台阶）：走 digLine（安全门与验证一格不放宽） ──
        const dir: ResolvedTunnelDirection = {
            axis: leg.axis ?? 'x',
            sign: leg.sign ?? 1,
            label: (leg.sign ?? 1) > 0 ? `+${leg.axis ?? 'x'}` : `-${leg.axis ?? 'x'}`,
            fromYaw: false,
        };
        const tunnel = await digLine(
            bot,
            {
                dir,
                length: leg.blocks,
                height: TRAVEL_TUNNEL_HEIGHT,
                budgetMs: Math.max(5_000, left - 5_000),
                deadline,
                rise: leg.kind === 'stairTunnel' ? (leg.rise ?? 1) : 0,
            },
            deps,
            { progressEvery: TRAVEL_PROGRESS_EVERY },
        );
        outcome.here = tunnel.here;
        outcome.handMining = outcome.handMining || tunnel.handMining;
        outcome.blocksDug += tunnel.blocksDug;
        refreshTool();
        const advanced = Math.max(0, horizontalDistance(before, target) - horizontalDistance(tunnel.here, target));
        outcome.legs.push({
            plan: leg,
            advanced,
            text:
                `${leg.label} → 挖了 ${tunnel.dug}/${leg.blocks} 格（共挖掉 ${tunnel.blocksDug} 个方块` +
                `${tunnel.bridges > 0 ? `，其中搭桥 ${tunnel.bridges} 块` : ''}），` +
                `实际推进 ${advanced.toFixed(1)} 格，现在 ${formatPoint(tunnel.here)}`,
            ...(tunnel.stop === 'done' ? {} : { tunnel }),
        });
        for (const line of tunnel.progress) outcome.progress.push(line);
        if (tunnel.stop !== 'done') {
            // 隧道那一格一格的门说了算：原话照抄，下一步也照它的来（不许"为了赶路"降级）。
            if (tunnel.stop === 'budget' || tunnel.stop === 'interrupted' || tunnel.stop === 'low_health' || tunnel.stop === 'damaged') {
                outcome.stop = tunnel.stop === 'budget' ? 'budget' : tunnel.stop === 'interrupted' ? 'interrupted' : 'low_health';
                outcome.detail = tunnel.detail === '' ? TUNNEL_STOP_TEXT[tunnel.stop] : tunnel.detail;
            } else {
                outcome.stop = 'blocked';
                outcome.detail = tunnel.detail === '' ? TUNNEL_STOP_TEXT[tunnel.stop] : tunnel.detail;
                outcome.gate = `${TUNNEL_STOP_TEXT[tunnel.stop]}${tunnel.detail === '' ? '' : `——${tunnel.detail}`}`;
                outcome.gateNextCall = handoffAwareNextCall({
                    bot,
                    tool: 'travelTo',
                    handoffFrom,
                    suggestion: tunnelNextAction(tunnel),
                    reason: outcome.detail,
                    now: now(),
                    lastRun: lastRunBefore,
                    onCycle: (note) => {
                        outcome.cycle = note;
                    },
                });
            }
            break;
        }
        if (advanced < 1) {
            // 挖通了却没往前挪：下次规划会重新挑轴，这里如实记一笔而不是假装在走。
            outcome.legs.push({ plan: leg, advanced: 0, text: '（这一腿挖通但人没往前挪，下一腿重新规划）' });
        }
        await sleep(150);
    }

    outcome.elapsedMs = now() - startedAt;
    outcome.here = position(bot);
    // **实测位移**：起点 → 现在（3D）。回执的标题数字只用它。
    outcome.progressed = Math.hypot(
        outcome.here.x - outcome.start.x,
        outcome.here.y - outcome.start.y,
        outcome.here.z - outcome.start.z,
    );
    refreshTool();
    return travelReceipt(outcome);
}
