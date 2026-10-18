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
/**
 * "快失败"的界线（毫秒）：一次攻击**几秒内**就返回 false = 调用本身被拒/解析错/服务端拒绝，
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
    stopReason: 'reached' | 'budget' | 'no_target' | 'interrupted' | 'low_health' | 'danger' | 'gone' | 'attack_failed' | 'attempts' | 'cannot_kill';
    elapsedMs: number;
    /** 在下界刷烈焰人（"没怪了"的下一步建议要用它）。 */
    netherBlaze: boolean;
    /** 连续失败了几次（`attack_failed` 时用来把话说清楚）——**只数"快失败"**。 */
    consecutiveFailures?: number;
    /** 耗完击杀预算还没打死的次数（`cannot_kill` 时用来把话说清楚）。 */
    slowFailures?: number;
    /** 背包里最能打的武器（`cannot_kill` 时给一条 equip 建议）。 */
    betterWeapon?: string | null;
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
    lines.push(`下一步（照做即可）：${huntNextAction(o)}`);
    // **硬长度上限**：循环里拼出来的字符串必须有天花板（真机教训：1.35 亿字符把上下文打爆）。
    return capReceipt(lines.join('\n'));
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
    const maxAttempts = huntMaxAttempts(want);
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
        const attackStartedAt = now();
        const killed = await attack(bot, entity);
        const attackMs = Math.max(0, now() - attackStartedAt);
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
        if (progress.length > HUNT_MAX_PROGRESS_LINES) progress.splice(0, progress.length - HUNT_MAX_PROGRESS_LINES);

        // 失败分两种（真机复核的教训）：**快失败**（几秒内被拒/解析错/服务端拒绝）才可能是
        // "工具坏了"；**慢失败**（耗完击杀预算）是"打不死"——坦克怪/回血/输出不够。
        // 混在一起数，就会让三只耐打的怪把模型骗去 debug 一个正常的工具。
        if (killed) {
            consecutiveFailures = 0;
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
        } else {
            // 慢失败 = 耗完击杀预算还没打死。**不计数进熔断，而且把快失败连击清零**：
            // 中间发生过一次"打了 90 秒"就说明工具是通的，"连续 N 次几秒内被拒"这句话必须字面为真。
            consecutiveFailures = 0;
            slowFailures += 1;
        }
    }

    const gained = currentGain(bot, items, baselineAtStart);
    // 全程一次都没打死、而且**每一次失败都是慢失败**（没有任何"快失败"）→ 结论是"打不死"，
    // 不是"工具坏了"：换成 cannot_kill 的说法与下一步（两者措辞与出路都不同）。
    // 混着快失败时不下这个结论（那可能是真有问题），只在回执里如实补一句"其中几次是打不死"。
    if (kills === 0 && slowFailures > 0 && fastFailures === 0 && (stopReason === 'budget' || stopReason === 'attempts')) {
        stopReason = 'cannot_kill';
    }
    const betterWeapon = stopReason === 'cannot_kill' ? skills.bestWeaponInInventory(bot) : null;
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

/** 第 `index` 步的几何：清哪几格、站到哪、踩在哪。 */
export function tunnelStep(pos: FlatPosition, dir: TunnelDirection, height: number, index: number): TunnelStep {
    const dx = dir.axis === 'x' ? dir.sign : 0;
    const dz = dir.axis === 'z' ? dir.sign : 0;
    const baseX = Math.round(pos.x) + dx;
    const baseZ = Math.round(pos.z) + dz;
    const baseY = Math.round(pos.y);
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
    | 'bad_direction';

const TUNNEL_STOP_TEXT: Record<TunnelStop, string> = {
    done: '挖满了本次长度（可以接着挖同一条线）',
    budget: '时间到（内部预算）主动收手',
    interrupted: '被 Stop/保命打断',
    low_health: '血量太低，停手保命',
    damaged: '中途掉血，停手',
    liquid_ahead: '前方是液体（岩浆/水），不能往里面挖',
    unsupported_floor: '下一步脚下不是实心方块，会掉下去',
    no_tool: '没有能挖的镐，而且前面的方块徒手挖不动',
    tool_low: '镐快用完了',
    dig_failed: '挖完还是原方块（挖不动/被挡）',
    travel_failed: '挖通了但没走进去（寻路失败）',
    unreadable: '读不到方块（区块没加载？），不敢瞎挖',
    bad_direction: '方向认不出来，也不给读朝向',
};

export interface TunnelOutcome {
    dir: ResolvedTunnelDirection;
    height: number;
    requested: number;
    /** 实际推进的格数（每一步都是"验证变空气 + 真的走进去了"才算）。 */
    dug: number;
    /** 实际挖掉的方块总数（含每步的 height 格）。 */
    blocksDug: number;
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
}

/** 挖了多少格 → 下一步还挖多少（原地接着挖同一条线）。 */
export function tunnelRemaining(o: TunnelOutcome): number {
    return Math.max(1, o.requested - o.dug);
}

export function tunnelNextAction(o: TunnelOutcome): string {
    switch (o.stop) {
        case 'liquid_ahead':
            return 'moveAway(distance=8)';
        case 'unsupported_floor':
            return 'pillarUp(distance=2)';
        case 'no_tool':
        case 'tool_low':
            return o.hintEquip != null ? `equip(item_name="${o.hintEquip}")` : 'stats(type="inventory")';
        case 'low_health':
        case 'damaged':
            return 'survivalCheck';
        case 'bad_direction':
        case 'unreadable':
            return 'stats(type="body")';
        default:
            // 正常可续：同一条线、剩下的长度。
            return `mineTunnel(length=${tunnelRemaining(o)}, direction="${o.dir.label}")`;
    }
}

export function tunnelReceipt(o: TunnelOutcome): string {
    const lines: string[] = [];
    const where = formatPoint(o.here);
    const dirText = `${o.dir.label}${o.dir.fromYaw ? '（按当时的朝向推出来的，下一步照抄这个方向）' : ''}`;
    lines.push(
        `mineTunnel：**挖了 ${o.dug}/${o.requested} 格**（净推进 ${o.dug} 格，共挖掉 ${o.blocksDug} 个方块），` +
            `现在 ${where}，方向 ${dirText}。`,
    );
    lines.push(`停止原因：${TUNNEL_STOP_TEXT[o.stop]}${o.detail === '' ? '' : `——${o.detail}`}。`);
    if (o.handMining) {
        lines.push('⚠️ 手上没有镐：这些方块是**徒手挖**的，很慢，而且更费时间=更暴露；能换镐就换。');
    }
    const toolText =
        o.toolName == null
            ? '镐：手上没有工具'
            : o.toolRemaining == null
              ? `镐：${o.toolName}（上限读不到，算不出还剩几次）`
              : `镐：${o.toolName} 还剩约 ${o.toolRemaining} 次（${o.toolMax ?? '?'} 上限）`;
    lines.push(toolText + '。');
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
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface TunnelOptions {
    budgetMs?: number;
    progressEvery?: number;
    /** 每一步之间的小停顿（让服务端把方块更新同步回来）。 */
    settleMs?: number;
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
    const budgetMs = options.budgetMs ?? DEFAULT_TUNNEL_BUDGET_MS;
    const progressEvery = Math.max(1, options.progressEvery ?? TUNNEL_PROGRESS_EVERY);
    const settleMs = options.settleMs ?? 120;

    const position = deps.position ?? defaultPosition;
    const yaw = deps.yaw ?? ((b: any) => (Number.isFinite(Number(b?.entity?.yaw)) ? Number(b.entity.yaw) : null));
    const blockAt = deps.blockAt ?? defaultBlockObject;
    const dig = deps.dig ?? ((b: any, x: number, y: number, z: number) => skills.mineBlockAt(b, x, y, z));
    const travel = deps.travel ?? ((b: any, x: number, y: number, z: number) => skills.goToPosition(b, x, y, z, 1));
    const health = deps.health ?? defaultTunnelHealth;
    const tool = deps.tool ?? ((b: any) => skills.toolDurabilityGuard(b));
    const sleep = deps.sleep ?? sleepMs;
    const now = deps.now ?? Date.now;

    const start = position(bot);
    const startedAt = now();
    const startHealth = health(bot);
    const outcome: TunnelOutcome = {
        dir: { axis: 'x', sign: 1, label: '+x', fromYaw: false },
        height,
        requested,
        dug: 0,
        blocksDug: 0,
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
    };

    const resolved = resolveTunnelDirection(rawDirection, yaw(bot));
    if (resolved == null) {
        outcome.stop = 'bad_direction';
        outcome.detail =
            typeof rawDirection === 'string' && rawDirection.trim() !== ''
                ? `direction="${rawDirection}" 认不出来（只认 ±x / ±z / east / west / north / south，或留空按朝向）`
                : '没给 direction，而且读不到 entity.yaw';
        const g = tool(bot);
        outcome.toolName = g.name;
        outcome.toolRemaining = g.remaining;
        outcome.toolMax = g.max;
        return tunnelReceipt(outcome);
    }
    outcome.dir = resolved;

    /** 一手工具的描述（每次都重新读，因为挖着挖着就磨损了）。 */
    const refreshTool = (): { name: string | null; remaining: number | null; max: number | null; low: boolean } => {
        const g = tool(bot);
        outcome.toolName = g.name;
        outcome.toolRemaining = g.remaining;
        outcome.toolMax = g.max;
        return g;
    };
    refreshTool();

    const cellText = (p: FlatPosition, name: string | null): string => `${formatPoint(p)} 是 ${name ?? '读不到'}`;

    for (let index = 1; index <= requested; index++) {
        // ── 时间预算：到点自己收手（回执必须由工具自己交出来） ──
        if (now() - startedAt >= budgetMs) {
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

        const step = tunnelStep(position(bot), resolved, height, index);

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

        // ── 安全门 2：前方脚下必须是实心（否则会掉下去/掉进岩浆海） ──
        if (floorBlock == null) {
            outcome.stop = 'unreadable';
            outcome.detail = `读不到前方的支撑格 ${formatPoint(step.floor)}`;
            break;
        }
        if (isUnsupportedFloorBlock(floorBlock)) {
            outcome.stop = 'unsupported_floor';
            outcome.detail = `前方脚下 ${cellText(step.floor, normalizeName(floorBlock?.name))}（下一步会踩空）`;
            break;
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
        const guard = refreshTool();
        const hasPickaxe = guard.name != null && guard.name.includes('pickaxe');
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
        } else if (guard.low) {
            outcome.stop = 'tool_low';
            const replacement = bestPickaxeInInventory(bot, guard.name);
            outcome.hintEquip = replacement;
            outcome.detail =
                replacement != null
                    ? `还剩约 ${guard.remaining ?? '?'} 次，先换 ${replacement}`
                    : `还剩约 ${guard.remaining ?? '?'} 次，背包里没有别的镐`;
            break;
        }

        // ── 挖：然后**验证明明变空气**（事实，不是假设） ──
        for (const { cell, block } of digBlocks) {
            if (isAirBlockName(block?.name)) continue;
            let ok = false;
            try {
                ok = await dig(bot, cell.x, cell.y, cell.z);
            } catch {
                ok = false;
            }
            outcome.blocksDug += 1;
            const after = blockAt(bot, cell.x, cell.y, cell.z);
            if (after == null || !isAirBlockName(after?.name)) {
                outcome.stop = 'dig_failed';
                outcome.detail =
                    `第 ${index} 步的 ${cellText(cell, normalizeName(after?.name))}${ok ? '（挖过了但没变空气）' : '（挖不动）'}`;
                return tunnelReceipt(outcome);
            }
        }
        await sleep(settleMs);

        // ── 走进去 ──
        let arrived = false;
        try {
            arrived = await travel(bot, step.feet.x, step.feet.y, step.feet.z);
        } catch {
            arrived = false;
        }
        const here = position(bot);
        outcome.here = here;
        const atTarget = Math.abs(here.x - step.feet.x) <= 1.5 && Math.abs(here.z - step.feet.z) <= 1.5;
        if (!arrived && !atTarget) {
            outcome.stop = 'travel_failed';
            outcome.detail = `第 ${index} 步已经挖通 ${formatPoint(step.feet)}，但人还停在 ${formatPoint(here)}`;
            break;
        }
        outcome.dug += 1;
        if (outcome.dug % progressEvery === 0) {
            outcome.progress.push(`- 已挖 ${outcome.dug} 格，现在 ${formatPoint(outcome.here)}`);
        }
    }

    refreshTool();
    return tunnelReceipt(outcome);
}

/** 背包里最好的一把镐（有镐才能继续挖；换镐提示要能直接照抄）。 */
export function bestPickaxeInInventory(bot: any, exclude?: string | null): string | null {
    let items: Array<{ name?: unknown; count?: unknown }>;
    try {
        items = (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>;
    } catch {
        return null;
    }
    if (!Array.isArray(items)) return null;
    const rank = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    const candidates = items
        .filter((item) => typeof item?.name === 'string' && item.name.includes('pickaxe') && item.name !== exclude)
        .filter((item) => (typeof item.count === 'number' ? item.count : 0) > 0)
        .map((item) => String(item.name));
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => {
        const ra = rank.findIndex((prefix) => a.startsWith(prefix));
        const rb = rank.findIndex((prefix) => b.startsWith(prefix));
        return (ra < 0 ? rank.length : ra) - (rb < 0 ? rank.length : rb);
    })[0] as string;
}
