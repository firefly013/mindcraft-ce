/**
 * 中段推进能力的测试（不连 MC 服务端、不烧 token）。
 *
 * 这里钉六件事：
 * 1) **回执诚实**：没找到就说 `not found after N steps`，并写清扫描半径只覆盖
 *    已加载区块——绝不宣称扫过一个没加载的范围（这正是前半夜那个 bug）；
 * 2) **找到给坐标**：`found <方块> at (x, y, z)`，且下一步是一条能照抄的调用；
 * 3) **航点是真的在推进**：方形螺旋的坐标可逐腿核对，不是"原地打转"；
 * 4) **huntFor 到量就停**，并且**只认真实背包增量**（打了不等于到手）；
 * 5) **接线/门禁**：两条命令注册成 action + longRunning，schema 参数在 TOOL_TEXT
 *    里都有说明（`scripts/check-prompts.ts` 的同款不变式）；
 * 6) **时间预算先于超时**（本轮新增，针对真机 13:13 的强退）：exploreFor 到点
 *    **自己收手**并给出腿数/覆盖/坐标/下一步；huntFor 的预算上限压在超时之下。
 *    这两条以前**没有任何测试**——删掉预算、把超时调大，都不会红。
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EXPLORE_BUDGET_MS,
    DEFAULT_EXPLORE_MAX_STEPS,
    DEFAULT_EXPLORE_SCAN_RADIUS,
    DEFAULT_EXPLORE_STEP,
    DEFAULT_TUNNEL_BUDGET_MS,
    DEFAULT_TUNNEL_HEIGHT,
    DEFAULT_TUNNEL_LENGTH,
    MAX_LEG_PER_SCAN_RATIO,
    MAX_TUNNEL_HEIGHT,
    MAX_TUNNEL_LENGTH,
    MIN_TUNNEL_RESUME,
    HUNT_ATTACK_BACKOFF_MAX_MS,
    HUNT_ATTACK_TYPE,
    HUNT_MAX_ATTEMPTS,
    HUNT_MAX_ATTEMPTS_CAP,
    HUNT_MAX_CONSECUTIVE_FAILURES,
    HUNT_MAX_SAME_TARGET_FAILURES,
    HUNT_RECEIPT_MAX_CHARS,
    blockNameAt,
    capLines,
    capReceipt,
    collectDrops,
    countItem,
    countTotalItems,
    describeCoverage,
    describeDropSweep,
    dropForEntity,
    exploreForSkill,
    exploreNextAction,
    exploreReceipt,
    foodRouteLines,
    foodRoutePrimary,
    hasFireResistance,
    hazardHere,
    huntBackoffMs,
    huntForSkill,
    huntMaxAttempts,
    huntNextAction,
    huntReceipt,
    isPassiveFoodAnimal,
    isProtectedBlockName,
    isContainerBlockName,
    isUnsupportedFloorBlock,
    maxLegPerScan,
    mineTunnelSkill,
    normalizeName,
    parseHandoff,
    resolveBlockName,
    resolveEntityName,
    resolveTunnelDirection,
    scanFoodRouteAssets,
    spiralReach,
    spiralScanPath,
    spiralWaypoints,
    tunnelNextAction,
    tunnelReceipt,
    tunnelStep,
    worstCoverageDistance,
    type ExploreOutcome,
    type FlatPosition,
    type FoodRouteAssets,
    type HuntOutcome,
} from '../src/body/library/progression.js';
import {
    EXPLORE_TIMEOUT_MIN,
    HUNT_MAX_MS_LIMIT,
    HUNT_TIMEOUT_MIN,
    TUNNEL_TIMEOUT_MIN,
    parseExploreArgs,
    parseHuntArgs,
    progressionActionList,
} from '../src/body/commands/progression.js';
import { findCommand, toolDeclarations, toolNames } from '../src/body/commands/registry.js';
import { clearDiscards, markDiscarded, noteDiscardedEntity } from '../src/body/auto_pickup.js';
import { resolveAttackTarget } from '../src/body/library/skills.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import { getOpenAITools } from '../src/brain/tools/advertise.js';

// ────────────────────────────── 假 bot ──────────────────────────────

interface BlockSpec {
    name: string;
    x: number;
    y: number;
    z: number;
}

function stack(name: string, count = 1): { name: string; count: number } {
    return { name, count };
}

/**
 * 假 bot：只实现被用到的表面。
 *
 * 默认**不注入** scan/travel —— 让 `world.getNearestBlocksWhere` 走自己的路
 * （findBlocks + blockAt），这样默认扫描路径也被真跑一遍（顺带证明它不依赖
 * mcdata：`world.getNearestBlock` 在没连服务器时是 TypeError）。
 */
function makeBot(options: {
    position?: FlatPosition;
    blocks?: BlockSpec[];
    items?: Array<{ name: string; count: number }>;
    effects?: Record<string, unknown>;
    dimension?: string;
    health?: number;
    hazard?: string | null;
    entities?: Record<string, any>;
} = {}) {
    const position = options.position ?? { x: 0, y: 64, z: 0 };
    const blocks = options.blocks ?? [];
    const items = options.items ?? [];
    const bot: any = {
        interrupt_code: false,
        game: { dimension: options.dimension ?? 'the_nether', gameMode: 'survival' },
        health: options.health ?? 20,
        entity: { position, effects: options.effects ?? {} },
        registry: { blocksByName: { nether_bricks: { id: 1 }, obsidian: { id: 2 } } },
        inventory: { items: () => items },
        entities: options.entities ?? {},
        findBlocks: ({ matching, maxDistance }: any) => {
            const out: Array<{ x: number; y: number; z: number }> = [];
            for (const block of blocks) {
                const distance = Math.hypot(
                    block.x - bot.entity.position.x,
                    block.y - bot.entity.position.y,
                    block.z - bot.entity.position.z,
                );
                if (distance > maxDistance) continue;
                if (matching({ name: block.name, position: { x: block.x, y: block.y, z: block.z } }) === false) continue;
                out.push({ x: block.x, y: block.y, z: block.z });
            }
            return out;
        },
        blockAt: (pos: any) => {
            const hit = blocks.find((b) => b.x === pos.x && b.y === pos.y && b.z === pos.z);
            if (hit != null) return { name: hit.name, position: { x: hit.x, y: hit.y, z: hit.z } };
            // 没登记的格子：默认给一个危险方块（用于测"落地后发现危险"），否则给石头。
            return { name: options.hazard ?? 'netherrack', position: { x: pos.x, y: pos.y, z: pos.z } };
        },
        nearestEntity: (predicate: (e: any) => boolean) => {
            for (const entity of Object.values(bot.entities) as any[]) {
                if (predicate(entity)) return entity;
            }
            return null;
        },
        waitForChunksToLoad: () => Promise.resolve(),
    };
    return bot;
}

/** 让假 bot 的坐标真的跟着 travel 走：否则 `walkedBlocks` 永远是 0。 */
function travellingBot(bot: any): (b: any, x: number, y: number, z: number) => Promise<boolean> {
    return async (b: any, x: number, y: number, z: number) => {
        b.entity.position = { x, y, z };
        return true;
    };
}

const noSleep = (): Promise<void> => Promise.resolve();

// ─────────────────────────── 纯函数：归一/别名 ───────────────────────────

describe('名字归一与中文别名', () => {
    it('归一 minecraft: 前缀 / 空格 / 大小写', () => {
        expect(normalizeName('minecraft:Ender_Pearl')).toBe('ender_pearl');
        expect(normalizeName('Blaze Rod')).toBe('blaze_rod');
        expect(normalizeName('  NETHER-BRICKS ')).toBe('nether_bricks');
    });

    it('中文俗称能翻成 id（两个 bot 全程说中文，参数却要英文 id）', () => {
        expect(resolveBlockName('下界砖')).toBe('nether_bricks');
        expect(resolveBlockName('黑曜石')).toBe('obsidian');
        expect(resolveEntityName('烈焰人')).toBe('blaze');
        expect(resolveEntityName('末影人')).toBe('enderman');
        // 已经是 id 的原样返回
        expect(resolveEntityName('enderman')).toBe('enderman');
    });

    it('掉落表：烈焰人→烈焰棒、末影人→末影珍珠；不认识就空表（宁可说"不知道"）', () => {
        expect(dropForEntity('blaze').items).toEqual(['blaze_rod']);
        expect(dropForEntity('enderman').items).toEqual(['ender_pearl']);
        expect(dropForEntity('not_a_mob').items).toEqual([]);
    });
});

// ─────────────────────────── 纯函数：航点 ───────────────────────────

describe('方形螺旋航点', () => {
    it('腿长 1,1,2,2…、方向东南西北循环，坐标可逐腿核对', () => {
        const waypoints = spiralWaypoints({ x: 0, y: 64, z: 0 }, 32, 8);
        expect(waypoints.map((w) => [w.x, w.z])).toEqual([
            [32, 0], // 东 1 腿
            [32, 32], // 南 1 腿
            [-32, 32], // 西 2 腿
            [-32, -32], // 北 2 腿
            [64, -32], // 东 3 腿
            [64, 64], // 南 3 腿
            [-64, 64], // 西 4 腿
            [-64, -64], // 北 4 腿
        ]);
        expect(waypoints.map((w) => w.direction)).toEqual([
            '东(+x)', '南(+z)', '西(-x)', '北(-z)', '东(+x)', '南(+z)', '西(-x)', '北(-z)',
        ]);
        expect(waypoints.map((w) => w.legLength)).toEqual([32, 32, 64, 64, 96, 96, 128, 128]);
        // y 不变：下界探索靠走，不主动上下挖（避免挖穿到岩浆湖）
        expect(waypoints.every((w) => w.y === 64)).toBe(true);
    });

    it('maxSteps=0 / 非法 step 不炸', () => {
        expect(spiralWaypoints({ x: 1, y: 2, z: 3 }, 32, 0)).toEqual([]);
        expect(spiralWaypoints({ x: 0, y: 0, z: 0 }, NaN, 1)[0]?.legLength).toBe(DEFAULT_EXPLORE_STEP);
    });

    it('探到的范围随腿数增长（写进回执给模型看）', () => {
        expect(spiralReach(32, 4)).toBeCloseTo(Math.hypot(32, 32), 5);
        expect(spiralReach(32, 12)).toBeGreaterThan(spiralReach(32, 4));
    });
});

// ──────────────────────── exploreFor：回执诚实 ────────────────────────

describe('exploreFor：系统性探索', () => {
    const ORIGIN: FlatPosition = { x: 0, y: 64, z: 0 };
    /** 计划步数（长腿被切段后的真实步数）——不是模型给的原始腿数。 */
    const plannedSteps = (legs: number, step = 32, radius = DEFAULT_EXPLORE_SCAN_RADIUS): number =>
        spiralScanPath(ORIGIN, step, legs, maxLegPerScan(radius)).length;

    it('没找到 → not found after N steps，且写清只覆盖已加载区块 + 不漏扫保证', async () => {
        const bot = makeBot();
        const visited: FlatPosition[] = [];
        const receipt = await exploreForSkill(
            bot,
            'nether_bricks',
            3,
            32,
            {
                travel: async (b, x, y, z) => {
                    b.entity.position = { x, y, z };
                    visited.push({ x, y, z });
                    return true;
                },
                scan: () => null,
                settle: noSleep,
                sleep: noSleep,
            },
        );

        const steps = plannedSteps(3);
        expect(steps).toBeGreaterThan(3); // 长腿切段：3 条原始腿 = 更多步
        expect(receipt).toContain(`not found after ${steps} steps`);
        expect(receipt).toContain(`每次重扫半径 ${DEFAULT_EXPLORE_SCAN_RADIUS} 格`);
        expect(receipt).toContain('只扫已加载区块');
        expect(receipt).toContain('走过去了却没扫到'); // 几何保证写进回执
        expect(receipt).toContain('实际移动约');
        expect(receipt).toContain('从 (0, 64, 0) 到');
        // 走的顺序 = 切段后的路径（不是原始螺旋端点）
        expect(visited).toEqual(
            spiralScanPath(ORIGIN, 32, 3, maxLegPerScan(DEFAULT_EXPLORE_SCAN_RADIUS)).map((w) => ({ x: w.x, y: w.y, z: w.z })),
        );
        // 严格最后一行是"一条能照抄的调用"：扫完没有 → 沿同方向走出去（而不是原地重扫）
        expect(receipt).toContain('已加载范围内确定没有 nether_bricks');
        expect(receipt).toContain('不是工具坏了');
        expect(receipt).toContain('继续沿同一方向走');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：goToCoordinates(x=-332, y=64, z=32, closeness=2)',
        );
    });

    it('找到 → found <方块> at (x, y, z)，并在那一腿就停（不多走）', async () => {
        const bot = makeBot();
        let legs = 0;
        const found = { x: -33, y: 70, z: 96 };
        const receipt = await exploreForSkill(bot, 'nether_bricks', 12, 32, {
            travel: async (b, x, y, z) => {
                legs += 1;
                b.entity.position = { x, y, z };
                return true;
            },
            scan: () => (legs >= 2 ? found : null),
            settle: noSleep,
            sleep: noSleep,
        });

        expect(receipt).toContain('found nether_bricks at (-33, 70, 96)');
        expect(legs).toBe(2); // 第 2 腿发现就停，后面 10 腿不该走
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：goToCoordinates(x=-33, y=70, z=96, closeness=2)',
        );
    });

    it('默认扫描走 findBlocks/blockAt（不依赖 mcdata），且能找到', async () => {
        const bot = makeBot({ blocks: [{ name: 'nether_bricks', x: 40, y: 64, z: 0 }] });
        const receipt = await exploreForSkill(bot, 'nether_bricks', 3, 32, {
            travel: travellingBot(bot),
            settle: noSleep,
            sleep: noSleep,
        });
        expect(receipt).toContain('found nether_bricks at (40, 64, 0)');
    });

    it('脚下是岩浆 → 立刻停手，并给一条脱离危险的调用', async () => {
        const bot = makeBot({ hazard: 'lava' });
        let travelled = 0;
        const receipt = await exploreForSkill(bot, 'nether_bricks', 5, 32, {
            travel: async (b, x, y, z) => {
                travelled += 1;
                b.entity.position = { x, y, z };
                return true;
            },
            scan: () => null,
            settle: noSleep,
            sleep: noSleep,
        });
        expect(travelled).toBe(0);
        expect(receipt).toContain('中止——脚所在格是 lava');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：moveAway(distance=8)');
    });

    it('被打断（Stop/保命）→ 带着已完成的部分收手，不假装走完', async () => {
        const bot = makeBot();
        let legs = 0;
        const receipt = await exploreForSkill(bot, 'nether_bricks', 10, 32, {
            travel: async (b, x, y, z) => {
                legs += 1;
                b.entity.position = { x, y, z };
                if (legs >= 2) b.interrupt_code = true;
                return true;
            },
            scan: () => null,
            settle: noSleep,
            sleep: noSleep,
        });
        expect(receipt).toContain('被打断（Stop/保命）');
        expect(receipt).toContain('not found after 2 steps');
        expect(legs).toBe(2);
    });

    it('方块 id 不认 → 明确说出来，并指路去确认真实 id', async () => {
        const bot = makeBot();
        const receipt = await exploreForSkill(bot, 'nether_brick_wrong', 4, 32, {
            travel: travellingBot(bot),
            scan: () => null,
            settle: noSleep,
            sleep: noSleep,
        });
        expect(receipt).toContain('方块表里没有 "nether_brick_wrong"');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：stats(type="blocks")');
    });

    it('一腿都没走成 → 建议把 step 调小（而不是原地再来一次同样的）', async () => {
        const bot = makeBot();
        const receipt = await exploreForSkill(bot, 'nether_bricks', 4, 64, {
            travel: async () => false,
            scan: () => null,
            settle: noSleep,
            sleep: noSleep,
        });
        expect(receipt).toContain(`失败 ${plannedSteps(4, 64)} 步`);
        expect(receipt).toContain('每一腿都没走到');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：exploreFor(block="nether_bricks", max_steps=8, step=16)',
        );
    });

    it('立即在身边找到 → 不走路（0 腿）', async () => {
        const bot = makeBot();
        const receipt = await exploreForSkill(bot, 'obsidian', 12, 32, {
            travel: async () => {
                throw new Error('不该走');
            },
            scan: () => ({ x: 2, y: 64, z: 2 }),
            settle: noSleep,
            sleep: noSleep,
        });
        expect(receipt).toContain('found obsidian at (2, 64, 2)');
        expect(receipt).toContain(`尝试 0/${plannedSteps(12)} 步`);
    });

    it('回执渲染：直接喂一个 outcome 也逐字可核（纯函数）', () => {
        const outcome: ExploreOutcome = {
            block: 'nether_bricks',
            scanRadius: 64,
            step: 32,
            maxSteps: 12,
            requestedLegs: 12,
            maxLeg: maxLegPerScan(64),
            origin: { x: 0, y: 64, z: 0 },
            here: { x: 32, y: 64, z: 32 },
            completedLegs: 2,
            attemptedLegs: 2,
            failedLegs: 0,
            walkedBlocks: 64,
            found: null,
            foundDistance: null,
            interrupted: false,
            danger: null,
            timedOut: false,
            budgetMs: DEFAULT_EXPLORE_BUDGET_MS,
            unknownBlock: false,
            notes: [],
        };
        expect(exploreNextAction(outcome)).toBe('goToCoordinates(x=332, y=64, z=32, closeness=2)');
        expect(exploreReceipt(outcome)).toContain(describeCoverage(64));
    });

    it('时间到 → 自己收手，回执仍给步数/覆盖/坐标，下一步是"接着跑一轮"', async () => {
        const bot = makeBot();
        let clock = 0;
        let legs = 0;
        const receipt = await exploreForSkill(
            bot,
            'nether_bricks',
            12,
            32,
            {
                travel: async (b, x, y, z) => {
                    legs += 1;
                    b.entity.position = { x, y, z };
                    clock += 120_000; // 每步 2 分钟：第 4 步前就会越过 4.5 分钟预算
                    return true;
                },
                scan: () => null,
                settle: noSleep,
                sleep: noSleep,
                now: () => clock,
            },
            { budgetMs: 270_000 },
        );

        // **没有被强退**：走完 3 步（6 分钟）后第 4 步前自己收手，不是走满整条螺旋
        expect(legs).toBe(3);
        // 时间原因必须**明说**，不能写成"范围里确定没有"
        expect(receipt).toContain('时间到');
        expect(receipt).toContain('主动收手');
        expect(receipt).toContain('没走完螺旋');
        expect(receipt).not.toContain('范围内的确定没有');
        // 报的是**实际走完的步数**，不是计划步数
        expect(receipt).toContain(`走完 3/${plannedSteps(12)} 步`);
        expect(receipt).toContain('not found after 3 steps');
        // 覆盖范围 + 从哪到哪，一个都不能少
        expect(receipt).toContain(`每次重扫半径 ${DEFAULT_EXPLORE_SCAN_RADIUS} 格`);
        expect(receipt).toContain('只扫已加载区块');
        expect(receipt).toContain('从 (0, 64, 0) 到');
        expect(receipt).toContain('实际移动约');
        // 最后一行仍是**一条**能照抄的调用：照原始腿数接着跑一轮
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：exploreFor(block="nether_bricks", max_steps=12, step=32)',
        );
    });

    it('时间到（纯渲染）：措辞与"下一步"逐字可核', () => {
        const outcome: ExploreOutcome = {
            block: 'nether_bricks',
            scanRadius: 64,
            step: 32,
            maxSteps: 12,
            requestedLegs: 12,
            maxLeg: maxLegPerScan(64),
            origin: { x: 0, y: 64, z: 0 },
            here: { x: 32, y: 64, z: 32 },
            completedLegs: 2,
            attemptedLegs: 2,
            failedLegs: 0,
            walkedBlocks: 64,
            found: null,
            foundDistance: null,
            interrupted: false,
            danger: null,
            timedOut: true,
            budgetMs: 270_000,
            unknownBlock: false,
            notes: [],
        };
        expect(exploreNextAction(outcome)).toBe('exploreFor(block="nether_bricks", max_steps=12, step=32)');
        const text = exploreReceipt(outcome);
        expect(text).toContain('时间到（预算 4.5 分钟）主动收手');
        expect(text).toContain('not found after 2 steps');
        expect(text.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：exploreFor(block="nether_bricks", max_steps=12, step=32)',
        );
    });

    it('默认预算确实在生效（不给 budgetMs 也会收手）', async () => {
        const bot = makeBot();
        let clock = 0;
        let legs = 0;
        const receipt = await exploreForSkill(bot, 'nether_bricks', 12, 32, {
            travel: async (b, x, y, z) => {
                legs += 1;
                b.entity.position = { x, y, z };
                clock += 60_000; // 每步 1 分钟
                return true;
            },
            scan: () => null,
            settle: noSleep,
            sleep: noSleep,
            now: () => clock,
        });
        // 默认预算 4.5 分钟、每步 1 分钟 → 第 6 步前收手（走到 5 分钟 > 4.5）
        expect(legs).toBe(5);
        expect(receipt).toContain('时间到');
        expect(receipt).toContain(`走完 5/${plannedSteps(12)} 步`);
    });
});

// ────────────── 不漏扫：扫描几何的构造性保证（memo B 的修复） ──────────────

describe('不漏扫：走过的路径必须落在某个扫描球里', () => {
    const ORIGIN: FlatPosition = { x: 0, y: 64, z: 0 };
    /**
     * 真机实测的纵向差：要塞 y≈70、机器人 y≈53 → 差 17 格。
     * 扫描是 3D 球，所以水平方向上真正够得着的半径是 √(R²−17²)，不是 R。
     */
    const LIVE_Y_DIFF = 17;
    const effectiveRadius = (radius: number): number => Math.sqrt(radius * radius - LIVE_Y_DIFF * LIVE_Y_DIFF);
    const asPath = (points: readonly { x: number; y: number; z: number }[]): FlatPosition[] =>
        points.map((p) => ({ x: p.x, y: p.y, z: p.z }));

    it('步长上限写死在常量里：0.75 × 扫描半径', () => {
        expect(MAX_LEG_PER_SCAN_RATIO).toBe(0.75);
        expect(maxLegPerScan(64)).toBe(48);
        expect(maxLegPerScan(96)).toBe(72);
        expect(maxLegPerScan(48)).toBe(36);
    });

    it('文档里的"12 腿能走多远"是真数：单轴 96 格、最远对角 ≈136 格（不是 192）', () => {
        // 回执里的"这一带（约 N 格内）"用的就是它——不许再出现凭感觉的覆盖数字。
        expect(Math.round(spiralReach(DEFAULT_EXPLORE_STEP, 12))).toBe(136);
        const path = spiralScanPath(ORIGIN, DEFAULT_EXPLORE_STEP, 12, maxLegPerScan(64));
        const far = path.reduce((max, wp) => Math.max(max, Math.hypot(wp.x - ORIGIN.x, wp.z - ORIGIN.z)), 0);
        expect(Math.round(far)).toBe(136);
    });

    it('**证伪**：原始螺旋（只在腿端点扫）确实有漏扫缝——这正是真机两次没命中的几何原因', () => {
        const radius = DEFAULT_EXPLORE_SCAN_RADIUS;
        const raw = spiralWaypoints(ORIGIN, DEFAULT_EXPLORE_STEP, 12);
        const centres = [ORIGIN, ...asPath(raw)];
        const worst = worstCoverageDistance(asPath(raw), centres);
        // 长腿 160/192 的中段离最近扫描中心 ~72 格：连 2D 都超出 64 格半径
        expect(worst).toBeGreaterThan(radius);
        // 叠加纵向差折算后（水平只剩 61.7 格）缝更大
        expect(worst).toBeGreaterThan(effectiveRadius(radius));
    });

    it('**不变式**：切段后，路径上任意一点都在某个扫描球里（且只用掉不到一半半径）', () => {
        for (const radius of [48, 64, 96]) {
            for (const step of [16, 32, 48]) {
                for (const legs of [6, 12, 20]) {
                    const path = spiralScanPath(ORIGIN, step, legs, maxLegPerScan(radius));
                    const centres = [ORIGIN, ...asPath(path)];
                    const worst = worstCoverageDistance(asPath(path), centres);
                    // 强判据：最远点 ≤ 半径/2 → 另一半留给纵向差与方块中心偏差
                    expect(worst, `radius=${radius} step=${step} legs=${legs}`).toBeLessThanOrEqual(radius / 2);
                    // 连"17 格纵向差"折算后的水平半径也绰绰有余
                    expect(worst, `radius=${radius} step=${step} legs=${legs}`).toBeLessThan(effectiveRadius(radius));
                }
            }
        }
    });

    it('构造规则：相邻两个落点距离 ≤ maxLegPerScan(半径)（取整之后也成立）', () => {
        for (const radius of [48, 64, 96]) {
            const maxLeg = maxLegPerScan(radius);
            const path = spiralScanPath(ORIGIN, DEFAULT_EXPLORE_STEP, 12, maxLeg);
            let prev: FlatPosition = ORIGIN;
            for (const wp of path) {
                expect(Math.hypot(wp.x - prev.x, wp.z - prev.z)).toBeLessThanOrEqual(maxLeg);
                prev = { x: wp.x, y: wp.y, z: wp.z };
            }
            // 确实切了段（不是把原始 12 条腿原样当路径）
            expect(path.length).toBeGreaterThan(DEFAULT_EXPLORE_MAX_STEPS);
        }
    });

    it('exploreFor 真的在每一步落点扫描，走出来的折线满足不变式', async () => {
        const bot = makeBot();
        const walked: FlatPosition[] = [];
        const scanCentres: FlatPosition[] = [];
        const receipt = await exploreForSkill(bot, 'nether_bricks', 12, DEFAULT_EXPLORE_STEP, {
            travel: async (b, x, y, z) => {
                b.entity.position = { x, y, z };
                walked.push({ x, y, z });
                return true;
            },
            scan: (b) => {
                scanCentres.push({ ...b.entity.position });
                return null;
            },
            settle: noSleep,
            sleep: noSleep,
        });

        const path: FlatPosition[] = [{ x: 0, y: 64, z: 0 }, ...walked];
        // 起点扫 1 次 + 每一步落点扫 1 次
        expect(scanCentres.length).toBe(path.length);
        const radius = DEFAULT_EXPLORE_SCAN_RADIUS;
        const worst = worstCoverageDistance(path, scanCentres);
        expect(worst).toBeLessThanOrEqual(radius / 2);
        // 回执把这条保证说出来，而不是让模型猜
        expect(receipt).toContain('走过去了却没扫到');
        expect(receipt).toContain(`每步 ≤ ${maxLegPerScan(radius)} 格`);
    });
});

// ──────────────────────── huntFor：只认真实增量 ────────────────────────

describe('huntFor：刷到够数 / 只认真实增量', () => {
    it('打到 want 就停，并逐次报进度', async () => {
        const items = [stack('blaze_rod', 0)];
        const bot = makeBot({ items, dimension: 'the_nether' });
        let attacks = 0;
        const receipt = await huntForSkill(bot, 'blaze', 2, 48, 60_000, {
            findEntity: () => ({ name: 'blaze', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => null,
            attack: async () => {
                attacks += 1;
                items[0].count += 1; // 模拟"打死 + 掉落进背包"
                return true;
            },
            sleep: noSleep,
        });

        expect(attacks).toBe(2);
        expect(receipt).toContain('blaze_rod 2/2');
        expect(receipt).toContain('击杀 2 只');
        expect(receipt).toContain('停止原因：够数了');
        expect(receipt).toContain('进度：');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：stats(type="inventory")');
    });

    it('**怪死了、地上有掉落物、没捡到** ⇒ 四个事实分开说 + 下一步是"去踩它"（真机 overnight_b）', async () => {
        const bot = makeBot({ items: [stack('bone', 0)] });
        let clock = 0;
        const receipt = await huntForSkill(bot, 'skeleton', 8, 48, 6_000, {
            findEntity: () => ({ name: 'skeleton', position: { x: 3, y: 64, z: 0 } }),
            // 地上**有**掉落物（真机那条：id=434443 在 (-43.16, 58, 6.25) 停了 8 秒），但人走不过去
            findDrop: () => ({ id: 434443, name: 'item', position: { x: -43.16, y: 58, z: 6.25 } }),
            countDrops: () => 1,
            travel: async () => false,
            attack: async () => {
                clock += 2_000;
                return true; // 打死了
            },
            entityPresent: () => false, // 实体没了 = 真死
            sleep: noSleep,
            now: () => clock,
        });

        // ① 四个事实分开说，不再是一句"捡到 0 个"
        expect(receipt).toContain('捡拾四个事实');
        expect(receipt).toContain('看到 1 个');
        expect(receipt).toContain('踩到 0 次');
        expect(receipt).toContain('一个都没到手');
        expect(receipt).toContain('背包实测增量 0');
        // ② 明确"不是不掉东西，是没捡到"（回执里那句警告本身就是在纠正这个误解）
        expect(receipt).toContain('地上有掉落物，但一个都没到手');
        expect(receipt).toContain('没捡到');
        expect(receipt).toContain('这**不是**"这种怪不掉东西"');
        // ③ 下一步是**去踩它**（可执行），不是收工
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：goToCoordinates(x=-43, y=58, z=6, closeness=1)',
        );
    });

    it('**读不到掉落物实体** ⇒ 说"没读到"，绝不说"没有掉落物"', async () => {
        const bot = makeBot({ items: [stack('bone', 0)] });
        let clock = 0;
        const receipt = await huntForSkill(bot, 'skeleton', 8, 48, 4_000, {
            findEntity: () => ({ name: 'skeleton', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => null,
            countDrops: () => null, // 实体表读不到
            attack: async () => {
                clock += 2_000;
                return true;
            },
            entityPresent: () => false,
            sleep: noSleep,
            now: () => clock,
        });

        expect(receipt).toContain('没读到');
        expect(receipt).toContain('不能说"没有掉落物"');
        expect(receipt).not.toContain('范围内**没看到**');
    });

    it('实体读得到、范围内真没有 ⇒ 才说"没看到"；到手了就报"到手 N 个"', async () => {
        const bot = makeBot({ items: [stack('bone', 0)] });
        let clock = 0;
        const none = await huntForSkill(bot, 'skeleton', 8, 48, 4_000, {
            findEntity: () => ({ name: 'skeleton', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => null,
            countDrops: () => 0,
            attack: async () => {
                clock += 2_000;
                return true;
            },
            entityPresent: () => false,
            sleep: noSleep,
            now: () => clock,
        });
        expect(none).toContain('范围内**没看到**掉落物实体');

        const bot2 = makeBot({ items: [stack('bone', 0)] });
        let clock2 = 0;
        let dropsLeft = 1; // 只喂一次：捡到就没了（否则 collectDrops 会在假时钟里空转）
        const got = await huntForSkill(bot2, 'skeleton', 8, 48, 4_000, {
            findEntity: () => ({ name: 'skeleton', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () =>
                dropsLeft > 0 ? { id: 7, name: 'item', position: { x: 1, y: 64, z: 0 } } : null,
            countDrops: () => 1,
            travel: async (b: any) => {
                clock2 += 500;
                b.inventory.items()[0].count += 1; // 踩到了 ⇒ 背包真的涨
                b.entity.position = { x: 1, y: 64, z: 0 };
                dropsLeft -= 1;
                return true;
            },
            attack: async () => {
                clock2 += 2_000;
                return true;
            },
            entityPresent: () => false,
            sleep: noSleep,
            now: () => clock2,
        });
        expect(got).toContain('到手 1 个');
        expect(got).toContain('踩到 1 次');
    });

    it('对齐 body 侧仪器：`bot.output` 里有 `drop-seen{…}` 就原样引一句（不重复实现）', async () => {
        const bot = makeBot({ items: [stack('bone', 0)] });
        bot.output = '…\ndrop-seen{id=434443, distance=3.2, willAttempt=true, blockedBy=[threat]}\n';
        let clock = 0;
        const receipt = await huntForSkill(bot, 'skeleton', 8, 48, 4_000, {
            findEntity: () => ({ name: 'skeleton', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => ({ id: 434443, name: 'item', position: { x: -43.16, y: 58, z: 6.25 } }),
            countDrops: () => 1,
            travel: async () => false,
            attack: async () => {
                clock += 2_000;
                return true;
            },
            entityPresent: () => false,
            sleep: noSleep,
            now: () => clock,
        });

        expect(receipt).toContain('drop-seen{id=434443, distance=3.2, willAttempt=true, blockedBy=[threat]}');
        // 没有那条线时**不许编**
        const clean = makeBot({ items: [stack('bone', 0)] });
        const noLine = await huntForSkill(clean, 'skeleton', 8, 48, 4_000, {
            findEntity: () => ({ name: 'skeleton', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => null,
            countDrops: () => 0,
            attack: async () => true,
            entityPresent: () => false,
            sleep: noSleep,
            now: () => clock,
        });
        expect(noLine).not.toContain('drop-seen');
    });

    it('describeDropSweep：四种状态逐字可核（纯函数）', () => {
        const pos = { x: 1, y: 64, z: 2 };
        expect(
            describeDropSweep({ seen: 0, readable: false, nearest: null, attempts: 0, overlapped: 0, picked: 0 }),
        ).toContain('没读到');
        expect(
            describeDropSweep({ seen: 0, readable: true, nearest: null, attempts: 0, overlapped: 0, picked: 0 }),
        ).toContain('范围内**没看到**');
        const seenNotPicked = describeDropSweep({
            seen: 2,
            readable: true,
            nearest: { name: 'item', id: 9, distance: 3.25, position: pos },
            attempts: 2,
            overlapped: 1,
            picked: 0,
        });
        expect(seenNotPicked).toContain('看到 2 个');
        expect(seenNotPicked).toContain('现在最近 3.3 格');
        expect(seenNotPicked).toContain('@(1, 64, 2)');
        expect(seenNotPicked).toContain('踩到 1 次');
        expect(seenNotPicked).toContain('一个都没到手');
        expect(
            describeDropSweep({ seen: 1, readable: true, nearest: null, attempts: 1, overlapped: 1, picked: 1 }),
        ).toContain('到手 1 个');
        expect(describeDropSweep(null)).toContain('没读到');
    });

    it('打了但背包没涨 → 绝不算到手（击杀数照报，drop 计数保持 0）', async () => {
        const bot = makeBot({ items: [stack('blaze_rod', 0)] });
        let clock = 0;
        const receipt = await huntForSkill(bot, 'blaze', 3, 48, 6_000, {
            findEntity: () => ({ name: 'blaze', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => null,
            attack: async () => {
                clock += 2_000; // 每一轮消耗 2 秒预算
                return true; // 打死了，但什么都没掉
            },
            sleep: noSleep,
            now: () => clock,
        });

        expect(receipt).toContain('blaze_rod 0/3');
        expect(receipt).toContain('击杀');
        expect(receipt).toContain('（这次没涨）');
        expect(receipt).toContain('停止原因：到时间预算了');
        // **时间预算到点也必须给完整回执**：进度逐条在，且最后一行是一条真实调用。
        expect(receipt).toContain('进度：');
        expect(receipt).toContain('攻击');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：huntFor(entity="blaze", want=3, max_ms=300000)',
        );
    });

    it('掉落物要自己走过去踩：走过去 + 背包涨了才算数', async () => {
        const items = [stack('ender_pearl', 0)];
        const bot = makeBot({ items });
        const drops = [{ name: 'Item', position: { x: 1, y: 64, z: 1 } }];
        const walked: string[] = [];
        let taken = false;
        const result = await collectDrops(bot, 12, 6_000, {
            // 捡走就没了：返回一次之后必须 null，否则会绕着一个掉落物死循环。
            findDrop: () => {
                if (taken) return null;
                taken = true;
                return drops[0];
            },
            travel: async (_b, x, y, z) => {
                walked.push(`${x},${y},${z}`);
                items[0].count += 1; // 踩到就进背包
                return true;
            },
            sleep: noSleep,
            now: () => 0,
            items: ['ender_pearl'],
            baselineAtStart: 0,
        });
        expect(walked).toEqual(['1,64,1']);
        expect(result.picked).toBe(1);
        expect(result.total).toBe(1);
    });

    it('找不到怪 → 明确说"半径内没有"，并给一条换地方的调用', async () => {
        const bot = makeBot({ dimension: 'the_nether' });
        const receipt = await huntForSkill(bot, 'blaze', 4, 48, 60_000, {
            findEntity: () => null,
            sleep: noSleep,
        });
        expect(receipt).toContain('停止原因：半径内找不到目标了');
        // 和 exploreFor 同一个口径："这一带没有"不是"工具坏了"
        expect(receipt).toContain('这一带（半径 48 格内）确实没有 blaze');
        expect(receipt).toContain('不是工具坏了');
        expect(receipt).toContain('烈焰人只在要塞里刷');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：exploreFor(block="nether_bricks", max_steps=4)',
        );
    });

    // ── 被动动物被打光：死胡同 → 可再生食物路线 ──
    // 真机原话（overnight_b）："世界几乎没有食物来源：找不到任何被动动物/村庄/农田，
    // 掉血后无法回血（卡在 2.7 血）"。所以 no_target 必须是出路，不是终点。
    it('被动动物找不到 → 给三条可再生路线 + 最近的水，且**主行动只有一条**', async () => {
        const bot = makeBot({
            items: [stack('stick', 3), stack('string', 2), stack('wheat_seeds', 12)],
            blocks: [{ name: 'water', x: 20, y: 63, z: 0 }],
        });
        const receipt = await huntForSkill(bot, 'chicken', 2, 48, 60_000, {
            findEntity: () => null,
            sleep: noSleep,
        });

        expect(receipt).toContain('这一带（半径 48 格内）确实没有 chicken');
        expect(receipt).toContain('被动动物被打光之后不会很快回来');
        expect(receipt).toContain('可再生食物路线');
        // ① 钓鱼 ② 种地 ③ 腐肉：三条都要在回执里，别让模型自己想去
        expect(receipt).toContain('fishing_rod');
        expect(receipt).toContain('3 木棍 + 2 线');
        expect(receipt).toContain('种小麦');
        expect(receipt).toContain('12 个种子');
        // ③ 腐肉：背包里没有时就只说"这是最后手段"，不编一条做不出来的调用
        expect(receipt).toContain('腐肉');
        expect(receipt).toContain('最后手段');
        // ③ 鱼在哪：水的位置要写清楚（钓鱼路线才可执行）
        expect(receipt).toContain('最近的水在 (20, 63, 0)');
        expect(receipt).toContain('离你约 20.0 格');
        // **只有一条**下一步
        const nextLines = receipt.split('\n').filter((line) => line.startsWith('下一步（照做即可）：'));
        expect(nextLines).toHaveLength(1);
        expect(nextLines[0]).toBe(
            '下一步（照做即可）：useBlock(type="crafting_table", input="3 stick, 2 string", output="1 fishing_rod")',
        );
    });

    it('没有材料时主行动仍然可执行：腐肉 → 水边 → 去找水（逐级降级）', async () => {
        const rottenBot = makeBot({ items: [stack('rotten_flesh', 2)] });
        const rotten = await huntForSkill(rottenBot, 'cow', 2, 48, 60_000, {
            findEntity: () => null,
            sleep: noSleep,
        });
        expect(rotten).toContain('腐肉');
        expect(rotten.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：consume(item_name="rotten_flesh")');

        const bareBot = makeBot({ items: [] });
        const bare = await huntForSkill(bareBot, 'cow', 2, 48, 60_000, {
            findEntity: () => null,
            sleep: noSleep,
        });
        expect(bare).toContain('没扫到');
        expect(bare.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：searchForBlock(type="water", search_range=256)',
        );
    });

    it('非被动目标（烈焰人）不塞食物路线：原来的口径不变', async () => {
        const bot = makeBot({ dimension: 'the_nether' });
        const receipt = await huntForSkill(bot, 'blaze', 4, 48, 60_000, {
            findEntity: () => null,
            sleep: noSleep,
        });
        expect(receipt).not.toContain('可再生食物路线');
        expect(receipt).toContain('烈焰人只在要塞里刷');
    });

    it('只认会被打光的被动动物（怪物不在名单里）', () => {
        for (const animal of ['chicken', 'cow', 'pig', 'sheep', 'rabbit', 'cod', 'minecraft:Chicken']) {
            expect(isPassiveFoodAnimal(animal), animal).toBe(true);
        }
        for (const monster of ['blaze', 'zombie', 'creeper', 'enderman', 'warden']) {
            expect(isPassiveFoodAnimal(monster), monster).toBe(false);
        }
        expect(isPassiveFoodAnimal(undefined)).toBe(false);
    });

    it('主行动优先级：能钓鱼先做竿 → 有竿去水边 → 有种子先做锄 → 腐肉 → 找水', () => {
        const base: FoodRouteAssets = {
            edibles: 0,
            sticks: 0,
            string: 0,
            seeds: 0,
            planks: 0,
            rottenFlesh: 0,
            hasHoe: false,
            hasFishingRod: false,
            hasCraftingTable: false,
            water: null,
            waterScanRadius: 64,
        };
        expect(foodRoutePrimary({ ...base, sticks: 3, string: 2 })).toContain('fishing_rod');
        expect(
            foodRoutePrimary({
                ...base,
                hasFishingRod: true,
                water: { position: { x: 10, y: 63, z: 5 }, distance: 11.2 },
            }),
        ).toBe('goToCoordinates(x=10, y=63, z=5, closeness=3)');
        expect(foodRoutePrimary({ ...base, seeds: 12, planks: 4, sticks: 4 })).toContain('wooden_hoe');
        expect(foodRoutePrimary({ ...base, seeds: 12, hasHoe: true, water: { position: { x: 1, y: 62, z: 1 }, distance: 1.4 } })).toContain('goToCoordinates');
        expect(foodRoutePrimary({ ...base, rottenFlesh: 1 })).toBe('consume(item_name="rotten_flesh")');
        expect(foodRoutePrimary(base)).toBe('searchForBlock(type="water", search_range=256)');
    });

    it('种子算"资产"不算"能吃"：盘点只走 foodValueOf，主行动指向种地', () => {
        const bot = makeBot({
            items: [stack('wheat_seeds', 12), stack('oak_planks', 4), stack('stick', 4), stack('bread', 1)],
        });
        const assets = scanFoodRouteAssets(bot, { x: 0, y: 64, z: 0 });
        expect(assets.edibles).toBe(1); // 只有 bread 能吃，种子/木板/木棍都不算
        expect(assets.seeds).toBe(12);
        expect(assets.planks).toBe(4);
        expect(assets.sticks).toBe(4);
        expect(foodRouteLines(assets).join('\n')).toContain('12 个种子');
        expect(foodRoutePrimary(assets)).toContain('wooden_hoe');
    });

    it('下界刷烈焰人且没有抗火 Buff → 回执里必须先提醒（不静默送死）', async () => {
        const bot = makeBot({ dimension: 'the_nether', effects: {} });
        const receipt = await huntForSkill(bot, '烈焰人', 4, 48, 60_000, {
            findEntity: () => null,
            sleep: noSleep,
        });
        expect(receipt).toContain('没有抗火 Buff');
        expect(receipt).toContain('prepareBlaze');
        // 有抗火 Buff 就不该再提醒
        const safeBot = makeBot({ dimension: 'the_nether', effects: { 12: { duration: 3600, name: 'Fire Resistance' } } });
        const safeReceipt = await huntForSkill(safeBot, 'blaze', 4, 48, 60_000, {
            findEntity: () => null,
            sleep: noSleep,
        });
        expect(safeReceipt).not.toContain('没有抗火 Buff');
    });

    it('血量过低 → 立刻停手保命', async () => {
        const bot = makeBot({ health: 5 });
        let attacks = 0;
        const receipt = await huntForSkill(bot, 'blaze', 4, 48, 60_000, {
            findEntity: () => ({ name: 'blaze', position: { x: 3, y: 64, z: 0 } }),
            attack: async () => {
                attacks += 1;
                return true;
            },
            sleep: noSleep,
        });
        expect(attacks).toBe(0);
        expect(receipt).toContain('停止原因：血量太低，先保命');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：survivalCheck');
    });

    it('不认识掉落物的怪 → 用背包总件数核对，并说明"不知道掉什么"', async () => {
        const items = [stack('rotten_flesh', 0)];
        const bot = makeBot({ items });
        const receipt = await huntForSkill(bot, 'not_a_mob', 1, 16, 60_000, {
            findEntity: () => ({ name: 'not_a_mob', position: { x: 2, y: 64, z: 0 } }),
            findDrop: () => null,
            attack: async () => {
                items[0].count += 1;
                return true;
            },
            sleep: noSleep,
        });
        expect(receipt).toContain('背包总件数 +1');
        expect(receipt).toContain('掉落表里没有这种怪');
    });

    it('默认捡拾走 nearestDropWithin：刚扔掉的掉落物不会被走回去捡（丢弃免疫 A/B 对照）', async () => {
        const drop = { id: 42, name: 'item', displayName: 'Blaze Rod', position: { x: 5, y: 64, z: 5 } };
        /** 跑一轮：附近只有一只"打死了但东西不进背包"的烈焰人 + 地上那个掉落物。 */
        const runOnce = async (): Promise<string[]> => {
            const bot = makeBot({ items: [stack('blaze_rod', 0)], entities: { 42: drop } });
            const travelled: string[] = [];
            let clock = 0;
            await huntForSkill(bot, 'blaze', 3, 48, 4_000, {
                findEntity: () => ({ name: 'blaze', position: { x: 3, y: 64, z: 0 } }),
                attack: async () => true,
                // **不注入 findDrop**：走的必须是默认实现（nearestDropWithin）
                travel: async (_b, x, y, z) => {
                    travelled.push(`${x},${y},${z}`);
                    return true;
                },
                sleep: noSleep,
                now: () => (clock += 1_000),
            });
            return travelled;
        };

        clearDiscards();
        try {
            // ① 记下"刚扔了 blaze_rod，落在 (5,64,5)" → 一步都不该为它走
            markDiscarded('blaze_rod', { x: 5, y: 64, z: 5 });
            noteDiscardedEntity(42);
            expect(await runOnce()).not.toContain('5,64,5');

            // ② 清掉免疫（A/B 对照）：同一个掉落物会被走过去 —— 证明①不是"这段压根没跑"
            clearDiscards();
            expect(await runOnce()).toContain('5,64,5');
        } finally {
            clearDiscards();
        }
    });

    it('huntNextAction：预算用尽 → 建议接着刷剩下的数量', () => {
        const outcome: HuntOutcome = {
            entity: 'blaze',
            want: 7,
            items: ['blaze_rod'],
            gained: 3,
            baseline: 0,
            kills: 3,
            attacks: 5,
            stopReason: 'budget',
            elapsedMs: 300_000,
            netherBlaze: true,
            warnings: [],
            progress: [],
        };
        expect(huntNextAction(outcome)).toBe('huntFor(entity="blaze", want=4, max_ms=300000)');
    });
});

// ───────────────────────── 辅助判据（纯函数） ─────────────────────────

describe('危险与 Buff 判据', () => {
    it('hazardHere 认岩浆/火，不认普通方块', () => {
        expect(hazardHere(makeBot({ hazard: 'lava' }))).toContain('lava');
        expect(hazardHere(makeBot({ hazard: 'netherrack' }))).toBeNull();
        expect(hazardHere(makeBot({ hazard: null }))).toBeNull();
    });

    it('hasFireResistance 认 id 键、认名字、认 registry', () => {
        expect(hasFireResistance(makeBot({ effects: {} }))).toBe(false);
        expect(hasFireResistance(makeBot({ effects: { 12: { duration: 3600, name: 'Fire Resistance' } } }))).toBe(true);
        expect(hasFireResistance(makeBot({ effects: { fire_resistance: { duration: 200 } } }))).toBe(true);
        // duration 0 = 已过期
        expect(hasFireResistance(makeBot({ effects: { 12: { duration: 0, name: 'Fire Resistance' } } }))).toBe(false);
    });

    it('背包计数：按名字归并、读不到就 0', () => {
        const bot = makeBot({ items: [stack('blaze_rod', 3), stack('Blaze Rod', 2), stack('coal', 5)] });
        expect(countItem(bot, 'blaze_rod')).toBe(5);
        expect(countItem(bot, 'minecraft:blaze_rod')).toBe(5);
        expect(countItem(bot, 'diamond')).toBe(0);
        expect(countTotalItems(bot)).toBe(10);
        expect(countItem({}, 'blaze_rod')).toBe(0);
    });
});

// ───────────────────── 接线 / 参数 / 门禁不变式 ─────────────────────

describe('接线：registry 与 schema', () => {
    const TOOLS = ['exploreFor', 'huntFor', 'mineTunnel', 'travelTo'];

    it('四条命令都注册进 registry 了', () => {
        const names = toolNames();
        for (const tool of TOOLS) expect(names).toContain(tool);
        expect(progressionActionList.map((c) => c.name.replace('!', ''))).toEqual(TOOLS);
        expect(findCommand('exploreFor')?.name).toBe('!exploreFor');
        expect(findCommand('!huntFor')?.name).toBe('!huntFor');
        expect(findCommand('mineTunnel')?.name).toBe('!mineTunnel');
        expect(findCommand('travelTo')?.name).toBe('!travelTo');
    });

    it('都是 action + longRunning（长动作：走 12 腿 / 刷 5 分钟）', () => {
        for (const declaration of toolDeclarations().filter((d) => TOOLS.includes(d.name))) {
            expect(declaration.kind).toBe('action');
            expect(declaration.longRunning).toBe(true);
        }
    });

    it('参数签名就是任务要求的那四个/三个/六个，且参数顺序 = perform 的位置参数顺序', () => {
        expect(Object.keys(findCommand('exploreFor')?.params ?? {})).toEqual(['block', 'max_steps', 'step']);
        expect(Object.keys(findCommand('huntFor')?.params ?? {})).toEqual(['entity', 'want', 'radius', 'max_ms']);
        expect(Object.keys(findCommand('mineTunnel')?.params ?? {})).toEqual(['length', 'height', 'direction', 'handoff']);
        expect(Object.keys(findCommand('travelTo')?.params ?? {})).toEqual(['x', 'y', 'z', 'max_ms', 'layer', 'dimension', 'handoff']);
        expect(progressionActionList[0].params?.block.optional).toBeUndefined(); // block 必填
        expect(progressionActionList[1].params?.entity.optional).toBeUndefined(); // entity 必填
        expect(progressionActionList[0].params?.max_steps.default).toBe(DEFAULT_EXPLORE_MAX_STEPS);
        expect(progressionActionList[0].params?.step.default).toBe(DEFAULT_EXPLORE_STEP);
    });

    it('schema 里出现的每个参数都在 TOOL_TEXT 里有说明（scripts/check-prompts.ts 的同款不变式）', () => {
        const tools = getOpenAITools(toolDeclarations());
        for (const name of TOOLS) {
            const tool = tools.find((t) => t.function.name === name);
            expect(tool, `${name} 不在 schema 里`).toBeDefined();
            const props = Object.keys((tool?.function.parameters as any).properties ?? {});
            expect(props.length).toBeGreaterThan(0);
            for (const param of props) {
                expect((TOOL_TEXT as any)[name]?.params?.[param], `${name}.${param} 缺 TOOL_TEXT 说明`).toBeTruthy();
            }
        }
    });

    it('参数解析：缺必填报错、越界钳到合法区间、中文别名照收', () => {
        expect(parseExploreArgs('nether_bricks', 999, 999)).toMatchObject({ block: 'nether_bricks', maxSteps: 64, step: 128 });
        expect(parseExploreArgs('下界砖', 0, 0)).toMatchObject({ block: 'nether_bricks', maxSteps: 1, step: 4 });
        expect(parseExploreArgs('', 12, 32).error).toContain('block 必填');
        expect(parseHuntArgs('enderman', 999, 1, 10 ** 9)).toMatchObject({
            entity: 'enderman',
            want: 64,
            radius: 8,
            maxMs: HUNT_MAX_MS_LIMIT, // 上限压在 5 分钟：内部预算必须低于命令超时
        });
        expect(parseHuntArgs('烈焰人').entity).toBe('blaze');
        expect(parseHuntArgs('').error).toContain('entity 必填');
    });

    it('时间预算 < 命令超时 < 脑侧保险丝：超时永远不该抢在预算前面', () => {
        // 脑侧保险丝 = (BODY_ACTION_TIMEOUT_MAX_MIN*60+30) 秒 = 8.5 分钟（action_runner.ts）。
        const FUSE_MS = 8.5 * 60_000;
        // Lead 的硬要求：exploreFor 的命令超时压到 ≤6 分钟（不许再回到 8），
        // 这样"预算 4.5 分钟 + 最后一腿寻路"也够，且离保险丝有 2.5 分钟余量。
        expect(EXPLORE_TIMEOUT_MIN).toBeLessThanOrEqual(6);
        expect(DEFAULT_EXPLORE_BUDGET_MS).toBeLessThan(EXPLORE_TIMEOUT_MIN * 60_000);
        expect(EXPLORE_TIMEOUT_MIN * 60_000).toBeLessThan(FUSE_MS);
        expect(HUNT_MAX_MS_LIMIT).toBeLessThan(HUNT_TIMEOUT_MIN * 60_000);
        expect(HUNT_TIMEOUT_MIN * 60_000).toBeLessThan(FUSE_MS);
        // mineTunnel 同一条不变式：它自己也先收手，命令超时不抢在它前面
        expect(DEFAULT_TUNNEL_BUDGET_MS).toBeLessThan(TUNNEL_TIMEOUT_MIN * 60_000);
        expect(TUNNEL_TIMEOUT_MIN * 60_000).toBeLessThan(FUSE_MS);
        // 两次探索之间的余量：exploreFor 的命令超时不能贴着预算（最后一腿还要寻路时间）。
        expect(EXPLORE_TIMEOUT_MIN * 60_000 - DEFAULT_EXPLORE_BUDGET_MS).toBeGreaterThanOrEqual(60_000);
    });

    it('huntFor 的 max_ms：schema 的 domain、clamp、默认值三者同源', () => {
        const param = progressionActionList[1].params?.max_ms;
        expect(param?.domain).toEqual([10_000, HUNT_MAX_MS_LIMIT]);
        expect(param?.default).toBe(HUNT_MAX_MS_LIMIT); // 默认 5 分钟 = 上限，仍低于超时
        // 模型给再大的值也只能拿到上限（写了 15 分钟也不会把通道占满）
        expect(parseHuntArgs('blaze', 7, 48, 15 * 60_000).maxMs).toBe(HUNT_MAX_MS_LIMIT);
        expect(parseHuntArgs('blaze', 7, 48, 10_000).maxMs).toBe(10_000);
    });

    it('mineTunnel 的三个参数全可选 + 方向/长度上限与常量同源', () => {
        const params = progressionActionList[2].params ?? {};
        expect(Object.keys(params)).toEqual(['length', 'height', 'direction', 'handoff']);
        expect(params.length.optional).toBe(true);
        expect(params.length.default).toBe(DEFAULT_TUNNEL_LENGTH);
        expect(params.length.domain).toEqual([1, MAX_TUNNEL_LENGTH]);
        expect(params.height.optional).toBe(true);
        expect(params.height.default).toBe(DEFAULT_TUNNEL_HEIGHT);
        expect(params.height.domain).toEqual([1, MAX_TUNNEL_HEIGHT]);
        expect(params.direction.optional).toBe(true);
    });
});

// ───────── mineTunnel：直线隧道（overnight_a 16:31 要的那件能力） ─────────
//
// 真机背景：下界长途找要塞时 y=70-85 是致密岩体，寻路必须一路挖 → 30 回合只推进
// 100 格、死 3 次（岩浆/恶魂/疣猪）、stuckForSeconds 60/73。模型自己要的是
// "沿某方向直线挖隧道 N 格"。这里的纪律：每一步都是
// 「读格子 → 判危险 → 挖 → **验证真的变空气** → 走进去」，安全门一触发就停手
// 并点名格子，回执永远可续挖。

/** 假世界：默认全是下界岩（能徒手挖、能踩），特殊格子用 `cells` 覆盖。 */
function tunnelHarness(
    options: {
        pos?: FlatPosition;
        yaw?: number;
        tool?: { name: string | null; remaining: number | null; max: number | null; low: boolean };
        inventory?: Array<{ name: string; count: number }>;
        health?: number;
        /** `"x,y,z"` → 方块名（默认 netherrack）。 */
        cells?: Record<string, string>;
        /** 这些格子读不到（blockAt 返回 null）。 */
        unreadable?: string[];
        /** 这些格子挖不动（dig 返回 false 且不变成空气）。 */
        undiggable?: string[];
        /** 走到第几步时置 interrupt_code（模拟 Stop/保命）。 */
        interruptAfterSteps?: number;
    } = {},
) {
    const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
    const special = new Map<string, string>(Object.entries(options.cells ?? {}));
    const placed = new Map<string, string>();
    const dug = new Set<string>();
    const dugOrder: FlatPosition[] = [];
    let travels = 0;
    const bot: any = {
        interrupt_code: false,
        health: options.health ?? 20,
        entity: { position: { ...(options.pos ?? { x: 0, y: 70, z: 0 }) }, yaw: options.yaw ?? 0 },
        inventory: { items: () => options.inventory ?? [] },
        output: '',
    };
    const deps = {
        position: () => ({ ...bot.entity.position }),
        blockAt: (_b: any, x: number, y: number, z: number) => {
            if ((options.unreadable ?? []).includes(key(x, y, z))) return null;
            const name = placed.get(key(x, y, z)) ?? (dug.has(key(x, y, z)) ? 'air' : (special.get(key(x, y, z)) ?? 'netherrack'));
            return {
                name,
                // obsidian 徒手挖不动；下界岩徒手挖得动
                hardness: name === 'obsidian' ? 50 : 0.4,
                diggable: true,
                position: { x, y, z },
            };
        },
        dig: async (_b: any, x: number, y: number, z: number) => {
            const k = key(x, y, z);
            if ((options.undiggable ?? []).includes(k)) return false;
            if (!dug.has(k)) {
                dug.add(k);
                dugOrder.push({ x, y, z });
            }
            return true;
        },
        travel: async (b: any, x: number, y: number, z: number) => {
            b.entity.position = { x, y, z };
            travels += 1;
            if (options.interruptAfterSteps != null && travels >= options.interruptAfterSteps) {
                b.interrupt_code = true;
            }
            return true;
        },
        tool: () => options.tool ?? { name: 'stone_pickaxe', remaining: 200, max: 251, low: false },
        health: () => bot.health,
        sleep: async (): Promise<void> => {},
        now: () => 0,
    };
    /** 垫一块方块（模拟 placeBlock 成功）：之后 blockAt 就当作实心。 */
    const place = (x: number, y: number, z: number, name: string): void => {
        placed.set(key(x, y, z), name);
    };
    return { bot, deps, dugOrder, place };
}

describe('mineTunnel：**不许挖穿容器/功能方块**（真机：travelTo 挖了基地的箱子）', () => {
    it('直线撞上 chest(1,70,0) ⇒ 箱子**一格都没挖**，抬一格绕过去，并在回执里点名', async () => {
        const h = tunnelHarness({
            cells: { '1,70,0': 'chest' }, // 正前方脚那一格就是箱子
            inventory: [{ name: 'diamond_pickaxe', count: 1 }],
        });
        const receipt = await mineTunnelSkill(h.bot, 3, 2, '+x', h.deps);

        // 箱子没被挖
        expect(h.dugOrder.some((p) => p.x === 1 && p.y === 70 && p.z === 0)).toBe(false);
        // 绕开了：人从上面过去了（抬 1 格）
        expect(h.bot.entity.position.y).toBe(71);
        expect(receipt).toContain('净前进 3/3 格');
        // 回执按名字 + 坐标点名，并说明内容物没动
        expect(receipt).toContain('(1, 70, 0)');
        expect(receipt).toContain('chest');
        expect(receipt).toContain('没挖它');
        expect(receipt).toContain('里面的东西原样没动');
        expect(receipt).toContain('抬/降了 1 次');
    });

    it('抬一格降一格都被挡住 ⇒ 停手说清楚（并给"横着挪开"的下一步）', async () => {
        const h = tunnelHarness({
            // 脚/头那两格上下都塞了箱子：抬一格撞 (1,71)，降一格撞 (1,70)
            cells: { '1,70,0': 'chest', '1,71,0': 'chest', '1,72,0': 'chest' },
            inventory: [{ name: 'diamond_pickaxe', count: 1 }],
        });
        const receipt = await mineTunnelSkill(h.bot, 3, 2, '+x', h.deps);

        expect(h.dugOrder).toHaveLength(0); // 一个箱子都没挖
        expect(receipt).toContain('净前进 0/3 格');
        expect(receipt).toContain('容器/功能方块');
        expect(receipt).toContain('绕不开');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：mineTunnel(length=2, direction="+z")');
    });

    it('功能方块（工作台/熔炉/告示牌/床/潜影盒）同样不挖；普通方块照挖', () => {
        for (const name of ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'barrel', 'oak_sign', 'red_bed', 'white_shulker_box', 'trapped_chest', 'spawner', 'beacon', 'anvil']) {
            expect(isProtectedBlockName(name), name).toBe(true);
            expect(isProtectedBlockName(`minecraft:${name}`), name).toBe(true);
        }
        for (const name of ['netherrack', 'cobblestone', 'stone', 'oak_log', 'chest_boat', 'air']) {
            expect(isProtectedBlockName(name), name).toBe(false);
        }
        expect(isContainerBlockName('chest')).toBe(true);
        expect(isContainerBlockName('crafting_table')).toBe(false);
        expect(isProtectedBlockName(null)).toBe(false);
    });
});

describe('mineTunnel：格数**只能由位置量出来**（真机回归：「已挖 64 格 + 位移 0.5 格」）', () => {
    it('**站在格子边缘、一步没走** ⇒ 格数必须是 0（旧判定"3D ≤0.75 就算到了"会算成 64 格）', async () => {
        // 人在 x=0.4：到 (1,70,0) 只有 0.6 格 ≤ 0.75 —— 旧代码每轮都算"到了"，
        // travel 又原地不动 ⇒ 64 轮全计数。现在格数由沿轴位移量出来 ⇒ 0。
        const h = tunnelHarness({ pos: { x: 0.4, y: 70, z: 0 } });
        h.deps.travel = async () => true; // 报成功、但人不动（真机那种"到了"其实没到）
        const receipt = await mineTunnelSkill(h.bot, 64, 2, '+x', h.deps);

        expect(receipt).toContain('净前进 0/64 格');
        expect(receipt).not.toContain('净前进 64/64');
        expect(receipt).toContain('实测位移');
        expect(receipt).toContain('没有一格真的变成空气，人也没往前挪');
        expect(receipt).toContain('卡住了');
    });

    it('**来回晃**（前进 0.5 又被顶回 0.5）⇒ 格数 0、标题显示实测位移，并写出矛盾', async () => {
        const h = tunnelHarness();
        let n = 0;
        h.deps.travel = async (b: any) => {
            n += 1;
            // 奇数步往前 0.5，偶数步退回原地：位移有、**沿轴净前进为 0**
            b.entity.position = n % 2 === 1 ? { x: 0.5, y: 70, z: 0 } : { x: 0, y: 70, z: 0 };
            return true; // 而且"报成功"
        };
        const receipt = await mineTunnelSkill(h.bot, 8, 2, '+x', h.deps);

        expect(receipt).toContain('净前进 0/8 格'); // 沿轴一格都没前进
        expect(receipt).toMatch(/实测位移 0\.[05] 格/); // 标题给的是量出来的数
        expect(receipt).toContain('一格都没前进');
    });

    it('真的往前走 ⇒ 格数 ≤ 实测位移（结构上不可能再矛盾）', async () => {
        const h = tunnelHarness();
        const receipt = await mineTunnelSkill(h.bot, 5, 2, '+x', h.deps);

        const dug = Number(/净前进 (\d+)\//.exec(receipt)?.[1] ?? '0');
        const moved = Number(/实测位移 ([\d.]+) 格/.exec(receipt)?.[1] ?? '0');
        expect(dug).toBe(5);
        expect(moved).toBeGreaterThanOrEqual(dug); // 沿轴 ≤ 3D
        expect(receipt).toContain('沿 +x 净前进');
    });
});

describe('mineTunnel：方向端到端（模型参数 ⇒ 执行 ⇒ 回执 ⇒ 续跑建议）', () => {
    it('yaw → 方向的符号是对的（0=+z、π=-z、π/2=-x、-π/2=+x）', () => {
        const cases: Array<[number, string]> = [
            [0, '+z'],
            [Math.PI, '-z'],
            [Math.PI / 2, '-x'],
            [-Math.PI / 2, '+x'],
        ];
        for (const [yaw, expected] of cases) {
            const resolved = resolveTunnelDirection(undefined, yaw);
            expect(resolved?.label, `yaw=${yaw}`).toBe(expected);
            expect(resolved?.fromYaw, `yaw=${yaw}`).toBe(true);
        }
    });

    it('**朝前**（yaw=π/2 ⇒ -x）⇒ 真的往 -x 挖、回执写 -x、续跑建议也是 -x', async () => {
        const h = tunnelHarness({ yaw: Math.PI / 2 });
        const receipt = await mineTunnelSkill(h.bot, 3, 2, 'forward', h.deps);

        // 执行：挖的格子都在 -x 侧
        for (const cell of h.dugOrder) expect(cell.x).toBeLessThan(0);
        // 回执 + 续跑建议
        expect(receipt).toContain('沿 -x 净前进 3/3 格');
        expect(receipt).toContain('按你当时的朝向推出来的');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：mineTunnel(length=32, direction="-x")');
    });

    it('明确给 -x ⇒ 不会被朝向改写（fromYaw=false，回执不出现"按朝向推"）', async () => {
        const h = tunnelHarness({ yaw: 0 }); // 朝向指着 +z
        const receipt = await mineTunnelSkill(h.bot, 2, 2, '-x', h.deps);

        for (const cell of h.dugOrder) expect(cell.x).toBeLessThan(0);
        expect(receipt).toContain('沿 -x 净前进');
        expect(receipt).not.toContain('按你当时的朝向推出来的');
    });

    it('续跑建议**永远不给 length=1**；被挡住时要点名障碍', () => {
        const base = {
            dir: { axis: 'x' as const, sign: 1 as const, label: '+x', fromYaw: false },
            height: 2,
            requested: 32,
            dug: 0,
            blocksDug: 0,
            digAttempts: 0,
            moved: 0,
            toolChanges: [],
            stalls: 0,
            protectedHits: [],
            detours: 0,
            start: { x: 0, y: 70, z: 0 },
            here: { x: 0, y: 70, z: 0 },
            detail: '',
            hintEquip: null,
            progress: [],
            toolName: 'diamond_pickaxe',
            toolRemaining: 900,
            toolMax: 1561,
            handMining: false,
            bridges: 0,
        } as const;
        const stops = ['done', 'budget', 'interrupted', 'low_health', 'damaged', 'stalled', 'protected_block', 'liquid_ahead', 'travel_failed', 'dig_failed'] as const;
        for (const stop of stops) {
            const next = tunnelNextAction({ ...base, stop } as any);
            expect(next, stop).not.toContain('length=1)');
            expect(next, stop).not.toMatch(/length=1,/);
        }
        // 挖满一段的续跑是"默认长度"，不是 1
        expect(tunnelNextAction({ ...base, stop: 'done', dug: 32 } as any)).toBe('mineTunnel(length=32, direction="+x")');
        // 还剩一点点时至少给 MIN_TUNNEL_RESUME
        expect(tunnelNextAction({ ...base, stop: 'budget', dug: 30 } as any)).toBe(`mineTunnel(length=${MIN_TUNNEL_RESUME}, direction="+x")`);
        // 被容器挡住：点名 + 横着挪开（不是"再挖一次同样的"）
        const blocked = tunnelNextAction({ ...base, stop: 'protected_block' } as any);
        expect(blocked).toBe('mineTunnel(length=2, direction="+z")');
    });
});

describe('mineTunnel 收到兄弟工具的交接（handoff）', () => {
    it('是 travelTo 交过来的 ⇒ 回执点名这件事，并要求"说清原因、别再交回去"', async () => {
        const h = tunnelHarness({
            cells: { '1,70,0': 'chest', '1,71,0': 'chest', '1,72,0': 'chest' },
            inventory: [{ name: 'diamond_pickaxe', count: 1 }],
        });
        const receipt = await mineTunnelSkill(h.bot, 3, 2, '+x', h.deps, { handoff: 'travelTo' });

        expect(receipt).toContain('这条是 **travelTo** 交过来的');
        expect(receipt).toContain('handoff="travelTo"');
        expect(receipt).toContain('不要再交回 travelTo');
        // 0 位移写在标题里，而且点名卡在什么
        expect(receipt).toContain('净前进 0/3 格');
        expect(receipt).toContain('**卡在**：');
        expect(receipt).toContain('chest');
    });

    it('没有 handoff ⇒ 不提交接（不会无端说"别再交回去"）', async () => {
        const h = tunnelHarness({ inventory: [{ name: 'diamond_pickaxe', count: 1 }] });
        const receipt = await mineTunnelSkill(h.bot, 2, 2, '+x', h.deps);
        expect(receipt).not.toContain('交过来的');
        expect(receipt).not.toContain('handoff=');
    });

    it('handoff 解析只认这两个工具名（乱写的当没给）', () => {
        expect(parseHandoff('travelTo')).toBe('travelTo');
        expect(parseHandoff('!mineTunnel')).toBe('mineTunnel');
        expect(parseHandoff('MINETUNNEL')).toBe('mineTunnel');
        expect(parseHandoff('goToCoordinates')).toBeNull();
        expect(parseHandoff('')).toBeNull();
        expect(parseHandoff(null)).toBeNull();
    });
});

describe('mineTunnel：进度必须是**量出来的**，不是数出来的（真机 02:0x 事故）', () => {
    // 真机：回执「已挖 64 格」但**位移 0、背包 0 增量**。
    // 机制：这一步前面本来就是空气（洞穴里很常见）→ 没挖任何东西；`travel` 没把 bot 挪动，
    // 而"到没到"只比较 x/z 且容忍 1.5 格 → 差 1 格也算"到了" → 每轮 `dug += 1` → 64。
    // 现在：一步必须**人真的站进新格子**才算；三项证据（变空气/位移/背包）不一致要明说。

    /** 洞穴型假身体：脚/头是空气、**地板是实心**（所以不会触发"脚下悬空"那道门）；`travel` 不动。 */
    function stuckInCave(options: { diggable?: boolean } = {}) {
        const dugOrder: FlatPosition[] = [];
        const bot: any = {
            interrupt_code: false,
            health: 20,
            entity: { position: { x: 0, y: 70, z: 0 }, yaw: 0 },
            inventory: { items: () => [{ name: 'diamond_pickaxe', count: 1 }] },
            output: '',
        };
        const deps = {
            position: () => ({ ...bot.entity.position }),
            // 脚/头一直是空气（洞穴：这一格不需要挖，也永远不会"变成"空气）；地板实心
            blockAt: (_b: any, x: number, y: number, z: number) => ({
                name: y <= 69 ? 'netherrack' : 'air',
                hardness: y <= 69 ? 0.4 : 0,
                diggable: true,
                boundingBox: y <= 69 ? 'block' : 'empty',
                position: { x, y, z },
            }),
            dig: async (_b: any, x: number, y: number, z: number) => {
                if (options.diggable === false) return false;
                dugOrder.push({ x, y, z });
                return true;
            },
            travel: async () => true, // **报成功但人不动**（这就是那一晚的形状）
            tool: () => ({ name: 'diamond_pickaxe', remaining: 900, max: 1561, low: false }),
            health: () => bot.health,
            sleep: async (): Promise<void> => {},
            now: () => 0,
        };
        return { bot, deps, dugOrder };
    }

    it('**人没动 + 前面本来就是空气** ⇒ 0 格，回执必须明说（原来会写 64 格）', async () => {
        const h = stuckInCave();
        const receipt = await mineTunnelSkill(h.bot, 64, 2, '+x', h.deps);

        expect(receipt).toContain('净前进 0/64 格**');
        expect(receipt).not.toContain('净前进 64/64');
        expect(receipt).toContain('0 格');
        expect(receipt).toContain('没有一格真的变成空气');
        expect(receipt).toContain('人也没往前挪');
        // 位移确实还是 0
        expect(h.bot.entity.position).toEqual({ x: 0, y: 70, z: 0 });
    });

    it('位移是 0 但挖掉了方块 ⇒ 回执把**矛盾**摆出来（不许只报大的那个数）', async () => {
        // 方块能挖（真的变空气），但 bot 走不进去：挖了 ≠ 推进了
        const dug = new Set<string>();
        const bot: any = {
            interrupt_code: false,
            health: 20,
            entity: { position: { x: 0, y: 70, z: 0 }, yaw: 0 },
            inventory: { items: () => [{ name: 'diamond_pickaxe', count: 1 }] },
            output: '',
        };
        const deps = {
            position: () => ({ ...bot.entity.position }),
            blockAt: (_b: any, x: number, y: number, z: number) => ({
                name: dug.has(`${x},${y},${z}`) ? 'air' : 'netherrack',
                hardness: 0.4,
                diggable: true,
                position: { x, y, z },
            }),
            dig: async (_b: any, x: number, y: number, z: number) => {
                dug.add(`${x},${y},${z}`);
                return true;
            },
            travel: async () => false, // 挖通了但走不进去
            tool: () => ({ name: 'diamond_pickaxe', remaining: 900, max: 1561, low: false }),
            health: () => bot.health,
            sleep: async (): Promise<void> => {},
            now: () => 0,
        };
        const receipt = await mineTunnelSkill(bot, 8, 2, '+x', deps);

        expect(receipt).toContain('净前进 0/8 格**');
        expect(receipt).toContain('位移是 0 格');
        expect(receipt).toContain('矛盾');
        expect(receipt).not.toMatch(/已挖 [1-9]\d* 格/);
    });

    it('正常的隧道：报的格数 = **验证变空气**的格数，位移也自洽', async () => {
        const h = tunnelHarness();
        const receipt = await mineTunnelSkill(h.bot, 5, 2, '+x', h.deps);

        expect(receipt).toContain('净前进 5/5 格**');
        expect(h.dugOrder).toHaveLength(10); // 5 步 × 2 格
        expect(h.bot.entity.position).toEqual({ x: 5, y: 70, z: 0 });
        // 位移与格数一致（1 格 = 1 步）
        expect(receipt).toContain('实测位移');
        expect(receipt).toContain('实测位移 5.0 格');
    });

    it('0 进度时**下一步不是同一条挖隧道调用**（不许把会空转的调用原样丢回去）', async () => {
        const h = stuckInCave();
        const receipt = await mineTunnelSkill(h.bot, 64, 2, '+x', h.deps);
        const next = receipt.trimEnd().split('\n').at(-1) ?? '';
        expect(next).toMatch(/^下一步（照做即可）：/);
        expect(next).not.toContain('mineTunnel(');
        expect(next).toContain('stats(type="body")');
    });

    it('**镐在背包里、只是没握在手上** ⇒ 不许说"手上没有镐"，自己换上再挖（真机 overnight_b）', async () => {
        let held: string | null = 'stone_sword';
        const h = tunnelHarness({
            tool: { name: 'stone_sword', remaining: null, max: null, low: false },
            inventory: [{ name: 'iron_pickaxe', count: 1 }],
        });
        const equipped: string[] = [];
        const receipt = await mineTunnelSkill(h.bot, 3, 2, '+x', {
            ...h.deps,
            tool: () => ({ name: held, remaining: held == null ? null : 900, max: held == null ? null : 1561, low: false }),
            equip: async (_b: any, item: string) => {
                equipped.push(item);
                held = item;
                return true;
            },
        });

        expect(equipped).toEqual(['iron_pickaxe']); // 自己换上了
        expect(receipt).not.toContain('手上没有镐'); // 不许假报"没有镐"
        expect(receipt).not.toContain('背包里也没有镐');
        expect(receipt).toContain('镐在背包里没握在手上 → 已自动换上 iron_pickaxe');
        expect(receipt).toContain('净前进 3/3 格'); // 也没被这件事挡住
    });

    it('真的没镐（背包也没有）+ 方块徒手挖不动 ⇒ 如实拒绝并点名"背包里也没有镐"', async () => {
        const h = tunnelHarness({
            tool: { name: 'stone_sword', remaining: null, max: null, low: false },
            inventory: [{ name: 'stone_sword', count: 1 }],
            cells: { '1,70,0': 'obsidian', '1,71,0': 'obsidian' },
        });
        const receipt = await mineTunnelSkill(h.bot, 3, 2, '+x', h.deps);

        expect(receipt).toContain('净前进 0/3 格');
        expect(receipt).toContain('背包里也没有镐');
        expect(receipt).not.toContain('已自动换上');
    });

    it('挖不动时**先换镐再试**（真机"爬 6 格就停"的形状）：换完能挖就继续，并把换手写进回执', async () => {
        const h = tunnelHarness({
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'iron_pickaxe', count: 1 },
            ],
        });
        let digs = 0;
        const equipped: string[] = [];
        const receipt = await mineTunnelSkill(h.bot, 4, 2, '+x', {
            ...h.deps,
            dig: async (b: any, x: number, y: number, z: number) => {
                digs += 1;
                if (digs === 1) return false; // 第一次挖不动（工具被换走/镐断了）
                return h.deps.dig(b, x, y, z);
            },
            equip: async (_b: any, item: string) => {
                equipped.push(item);
                return true;
            },
            tool: () => ({
                name: equipped.length > 0 ? 'iron_pickaxe' : 'diamond_pickaxe',
                remaining: 900,
                max: 1561,
                low: false,
            }),
        });

        expect(equipped).toEqual(['iron_pickaxe']); // 自动换了一把能用的镐
        expect(receipt).toContain('净前进 4/4 格'); // 没有"爬 6 格就停"
        expect(receipt).toContain('中途工具变了');
        expect(receipt).toContain('diamond_pickaxe → iron_pickaxe');
    });

    it('工具中途被换走：回执点名"换过工具"，不是闷声少挖', async () => {
        const h = tunnelHarness();
        let reads = 0;
        const receipt = await mineTunnelSkill(h.bot, 8, 2, '+x', {
            ...h.deps,
            // 第 3 次读工具时换成了别的（模拟自动换手/镐断了）
            tool: () => {
                reads += 1;
                return reads >= 3
                    ? { name: 'golden_pickaxe', remaining: 900, max: 32, low: false }
                    : { name: 'diamond_pickaxe', remaining: 900, max: 1561, low: false };
            },
        });

        expect(receipt).toContain('中途工具变了');
        expect(receipt).toContain('diamond_pickaxe → golden_pickaxe');
    });
});

describe('mineTunnel：直线隧道', () => {
    it('四个方向：挖的格子与终点逐一对应，回执写明方向且可续挖', async () => {
        const cases: Array<[string, FlatPosition, string[]]> = [
            ['+x', { x: 3, y: 70, z: 0 }, ['1,70,0', '1,71,0', '2,70,0', '2,71,0', '3,70,0', '3,71,0']],
            ['-x', { x: -3, y: 70, z: 0 }, ['-1,70,0', '-1,71,0', '-2,70,0', '-2,71,0', '-3,70,0', '-3,71,0']],
            ['+z', { x: 0, y: 70, z: 3 }, ['0,70,1', '0,71,1', '0,70,2', '0,71,2', '0,70,3', '0,71,3']],
            ['-z', { x: 0, y: 70, z: -3 }, ['0,70,-1', '0,71,-1', '0,70,-2', '0,71,-2', '0,70,-3', '0,71,-3']],
        ];
        for (const [direction, end, expected] of cases) {
            const h = tunnelHarness();
            const receipt = await mineTunnelSkill(h.bot, 3, 2, direction, h.deps);
            expect(h.dugOrder.map((c) => `${c.x},${c.y},${c.z}`), direction).toEqual(expected);
            expect(h.bot.entity.position, direction).toEqual(end);
            expect(receipt, direction).toContain('净前进 3/3 格');
            expect(receipt, direction).toContain(`现在 (${end.x}, ${end.y}, ${end.z})`);
            expect(receipt, direction).toContain(`沿 ${direction} 净前进`);
            expect(receipt, direction).toContain('验证变空气**的方块 6 个');
            expect(receipt.trimEnd().split('\n').at(-1), direction).toBe(
                `下一步（照做即可）：mineTunnel(length=32, direction="${direction}")`,
            );
        }
    });

    it('height=1 只挖脚那一格；不传 height 默认 2 格高', async () => {
        const one = tunnelHarness();
        await mineTunnelSkill(one.bot, 2, 1, '+x', one.deps);
        expect(one.dugOrder.map((c) => `${c.x},${c.y},${c.z}`)).toEqual(['1,70,0', '2,70,0']);

        const dflt = tunnelHarness();
        await mineTunnelSkill(dflt.bot, 1, undefined, '+x', dflt.deps);
        expect(dflt.dugOrder.map((c) => `${c.x},${c.y},${c.z}`)).toEqual(['1,70,0', '1,71,0']);
    });

    it('前方是岩浆 → 停手、点名格子、**一格都不挖**', async () => {
        const h = tunnelHarness({ cells: { '1,70,0': 'lava' } });
        const receipt = await mineTunnelSkill(h.bot, 4, 2, '+x', h.deps);
        expect(h.dugOrder).toEqual([]);
        expect(h.bot.entity.position).toEqual({ x: 0, y: 70, z: 0 });
        expect(receipt).toContain('净前进 0/4 格');
        expect(receipt).toContain('前方脚所在格');
        expect(receipt).toContain('lava');
        expect(receipt).toContain('(1, 70, 0)');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：moveAway(distance=8)');
    });

    it('水/岩浆在头上或前方脚下 → 同样停手（三处都要读）', async () => {
        const head = tunnelHarness({ cells: { '1,71,0': 'water' } });
        const r1 = await mineTunnelSkill(head.bot, 4, 2, '+x', head.deps);
        expect(head.dugOrder).toEqual([]);
        expect(r1).toContain('前方头所在格');
        expect(r1).toContain('water');

        const below = tunnelHarness({ cells: { '1,69,0': 'lava' } });
        const r2 = await mineTunnelSkill(below.bot, 4, 2, '+x', below.deps);
        expect(below.dugOrder).toEqual([]);
        expect(r2).toContain('前方脚下的格子');
        expect(r2).toContain('lava');
    });

    it('前方脚下不是实心 → 停手（走过去就是岩浆海/悬崖）', async () => {
        // 背包里没有能垫的方块 → 只能停；而且**不许再给 pillarUp(distance=2)**（它也要方块，
        // 没方块时就是真机那个死循环）。先弄 1 个能垫的方块。
        const h = tunnelHarness({ cells: { '1,69,0': 'air' } });
        const receipt = await mineTunnelSkill(h.bot, 4, 2, '+x', h.deps);
        expect(h.dugOrder).toEqual([]);
        expect(receipt).toContain('会掉下去');
        expect(receipt).toContain('(1, 69, 0)');
        expect(receipt).toContain('没有能垫的方块');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：mineTunnel(length=2, direction="+z")');
    });

    it('前方脚下是空洞 + 背包里有方块 → **垫一块桥过去**（横向的 pillarUp）', async () => {
        const h = tunnelHarness({ cells: { '1,69,0': 'air' }, inventory: [{ name: 'cobblestone', count: 8 }] });
        const placed: string[] = [];
        const receipt = await mineTunnelSkill(h.bot, 3, 2, '+x', {
            ...h.deps,
            place: async (_b: any, block: string, x: number, y: number, z: number) => {
                placed.push(`${block}@${x},${y},${z}`);
                h.place(x, y, z, 'cobblestone');
                return true;
            },
        });

        expect(placed).toEqual(['cobblestone@1,69,0']);
        expect(receipt).toContain('垫了一块桥过去');
        expect(receipt).toContain('cobblestone');
        expect(h.dugOrder.length).toBeGreaterThan(0); // 桥搭完继续挖，没有被卡住
        expect(receipt).toContain('搭桥：这一趟垫了 1 块');
    });

    it('桥下就是岩浆 → 拒绝搭桥（沿用液体门的措辞），一块都不垫', async () => {
        const h = tunnelHarness({ cells: { '1,69,0': 'air', '1,68,0': 'lava' }, inventory: [{ name: 'cobblestone', count: 8 }] });
        let placeCalls = 0;
        const receipt = await mineTunnelSkill(h.bot, 3, 2, '+x', {
            ...h.deps,
            place: async () => {
                placeCalls += 1;
                return true;
            },
        });

        expect(placeCalls).toBe(0);
        expect(h.dugOrder).toEqual([]);
        expect(receipt).toContain('就是岩浆（桥下面）');
        expect(receipt).toContain('不能在上面搭桥');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：moveAway(distance=8)');
    });

    it('"不是实心"不只是 air：没有碰撞箱的方块也算踩空（纯函数）', () => {
        expect(isUnsupportedFloorBlock({ name: 'air' })).toBe(true);
        expect(isUnsupportedFloorBlock({ name: 'cave_air' })).toBe(true);
        expect(isUnsupportedFloorBlock({ name: 'lava' })).toBe(true);
        expect(isUnsupportedFloorBlock({ name: 'water' })).toBe(true);
        expect(isUnsupportedFloorBlock({ name: 'torch', boundingBox: 'empty' })).toBe(true);
        expect(isUnsupportedFloorBlock({ name: 'short_grass', passable: true })).toBe(true);
        expect(isUnsupportedFloorBlock({ name: 'netherrack', hardness: 0.4 })).toBe(false);
        expect(isUnsupportedFloorBlock(null)).toBe(true);
    });

    it('镐快用完了 → 停手并给"换哪一把"的可执行调用', async () => {
        const h = tunnelHarness({
            tool: { name: 'stone_pickaxe', remaining: 12, max: 251, low: true },
            inventory: [{ name: 'diamond_pickaxe', count: 1 }],
        });
        const receipt = await mineTunnelSkill(h.bot, 4, 2, '+x', h.deps);
        expect(h.dugOrder).toEqual([]);
        expect(receipt).toContain('镐快用完了');
        expect(receipt).toContain('stone_pickaxe');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：equip(item_name="diamond_pickaxe")');
    });

    it('没镐 + 徒手挖不动 → 停手并给装备提示；徒手挖得动 → 放行但明说"很慢"', async () => {
        const hard = tunnelHarness({
            tool: { name: null, remaining: null, max: null, low: false },
            cells: { '1,70,0': 'obsidian' },
            inventory: [{ name: 'stone_pickaxe', count: 1 }],
        });
        const r1 = await mineTunnelSkill(hard.bot, 4, 2, '+x', hard.deps);
        expect(hard.dugOrder).toEqual([]);
        expect(r1).toContain('徒手挖不动');
        expect(r1.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：equip(item_name="stone_pickaxe")');

        const soft = tunnelHarness({ tool: { name: null, remaining: null, max: null, low: false } });
        const r2 = await mineTunnelSkill(soft.bot, 2, 2, '+x', soft.deps);
        expect(soft.dugOrder.length).toBe(4);
        expect(r2).toContain('徒手挖');
        expect(r2).toContain('净前进 2/2 格');
    });

    it('中途被 Stop → 报挖了几格 + 续挖调用（不是从头再来）', async () => {
        const h = tunnelHarness({ interruptAfterSteps: 2 });
        const receipt = await mineTunnelSkill(h.bot, 5, 2, '+x', h.deps);
        expect(receipt).toContain('净前进 2/5 格');
        expect(receipt).toContain('被 Stop/保命打断');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：mineTunnel(length=16, direction="+x")',
        );
    });

    it('读不到方块 → 拒绝瞎挖（读不到就不猜）', async () => {
        const h = tunnelHarness({ unreadable: ['1,71,0'] });
        const receipt = await mineTunnelSkill(h.bot, 4, 2, '+x', h.deps);
        expect(h.dugOrder).toEqual([]);
        expect(receipt).toContain('读不到');
        expect(receipt).toContain('净前进 0/4 格');
    });

    it('挖完还是原方块 → 报"挖不动"，绝不假装挖通、也不往前站', async () => {
        const h = tunnelHarness({ undiggable: ['1,70,0'] });
        const receipt = await mineTunnelSkill(h.bot, 4, 2, '+x', h.deps);
        expect(h.bot.entity.position).toEqual({ x: 0, y: 70, z: 0 });
        expect(receipt).toContain('挖不动');
        expect(receipt).toContain('净前进 0/4 格');
    });

    it('掉血 / 血量过低 → 停手保命', async () => {
        const low = tunnelHarness({ health: 5 });
        const r1 = await mineTunnelSkill(low.bot, 4, 2, '+x', low.deps);
        expect(low.dugOrder).toEqual([]);
        expect(r1).toContain('停手保命');
        expect(r1.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：survivalCheck');

        const hurt = tunnelHarness();
        let step = 0;
        const deps = {
            ...hurt.deps,
            travel: async (b: any, x: number, y: number, z: number) => {
                b.entity.position = { x, y, z };
                step += 1;
                if (step >= 2) b.health = 12; // 第 2 步之后挨了一下
                return true;
            },
        };
        const r2 = await mineTunnelSkill(hurt.bot, 5, 2, '+x', deps);
        expect(r2).toContain('掉血');
        expect(r2).toContain('净前进 2/5 格');
    });

    it('每 16 格报一次进度（20 格 → 只有一次 16 格进度）', async () => {
        const h = tunnelHarness();
        const receipt = await mineTunnelSkill(h.bot, 20, 2, '+x', h.deps);
        expect(receipt).toContain('已前进 16 格');
        expect(receipt).not.toContain('已前进 20 格');
        expect(h.dugOrder.length).toBe(40);
    });

    it('内部时间预算到点 → 自己收手并给续挖调用', async () => {
        const h = tunnelHarness();
        let clock = 0;
        const receipt = await mineTunnelSkill(
            h.bot,
            10,
            2,
            '+x',
            { ...h.deps, now: () => (clock += 60_000) },
            { budgetMs: 150_000 },
        );
        expect(receipt).toContain('时间到');
        expect(receipt).toContain('净前进 2/10 格');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：mineTunnel(length=16, direction="+x")',
        );
    });

    it('方向解析：显式四种写法都认；留空按 yaw 推；认不出来就拒绝', () => {
        expect(resolveTunnelDirection('+x', null)).toMatchObject({ axis: 'x', sign: 1, fromYaw: false });
        expect(resolveTunnelDirection('-x', null)).toMatchObject({ axis: 'x', sign: -1, fromYaw: false });
        expect(resolveTunnelDirection('+z', null)).toMatchObject({ axis: 'z', sign: 1, fromYaw: false });
        expect(resolveTunnelDirection('-z', null)).toMatchObject({ axis: 'z', sign: -1, fromYaw: false });
        expect(resolveTunnelDirection('north', null)?.label).toBe('-z');
        expect(resolveTunnelDirection('east', null)?.label).toBe('+x');
        expect(resolveTunnelDirection('西', null)?.label).toBe('-x');
        // yaw 约定：0 = +z（南）、π/2 = -x（西）、-π/2 = +x（东）、π = -z（北）
        expect(resolveTunnelDirection(undefined, 0)).toMatchObject({ label: '+z', fromYaw: true });
        expect(resolveTunnelDirection('facing', Math.PI / 2)).toMatchObject({ label: '-x', fromYaw: true });
        expect(resolveTunnelDirection('', -Math.PI / 2)).toMatchObject({ label: '+x', fromYaw: true });
        expect(resolveTunnelDirection('', Math.PI)).toMatchObject({ label: '-z', fromYaw: true });
        // 认不出来 / 读不到朝向 → 拒绝，不猜
        expect(resolveTunnelDirection('sideways', 0)).toBeNull();
        expect(resolveTunnelDirection(undefined, null)).toBeNull();
    });

    it('不给方向时按朝向挖，回执写明"是推出来的"（下一次照抄即可）', async () => {
        const h = tunnelHarness({ yaw: 0 }); // 朝南 → +z
        const receipt = await mineTunnelSkill(h.bot, 2, 2, undefined, h.deps);
        expect(receipt).toContain('按你当时的朝向推出来的');
        expect(h.bot.entity.position).toEqual({ x: 0, y: 70, z: 2 });
    });

    it('方向认不出来 → 一格不挖，并说清只认哪些写法', async () => {
        const h = tunnelHarness();
        const receipt = await mineTunnelSkill(h.bot, 4, 2, 'sideways', h.deps);
        expect(h.dugOrder).toEqual([]);
        expect(receipt).toContain('认不出来');
        expect(receipt).toContain('净前进 0/4 格');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：stats(type="body")');
    });

    it('tunnelStep 的几何：脚/头/脚下三格逐一对得上', () => {
        const step = tunnelStep({ x: 10, y: 70, z: -4 }, { axis: 'z', sign: -1, label: '-z' }, 2, 1);
        expect(step.dig).toEqual([
            { x: 10, y: 70, z: -5 },
            { x: 10, y: 71, z: -5 },
        ]);
        expect(step.feet).toEqual({ x: 10, y: 70, z: -5 });
        expect(step.floor).toEqual({ x: 10, y: 69, z: -5 });
    });
});

/**
 * **真实 API 契约**：`bot.blockAt()` 必须收到 `Vec3`（或至少带 `.floored()` 的对象）。
 *
 * 真机事故（2026-10-18 17:14，overnight_a）：`blockNameAt` 传普通对象 `{x,y,z}`，
 * mineflayer 转给 prismarine-world 的 `getBlock(pos)`，后者第一件事是 `pos.floored()`
 * ——普通对象没有这个方法，**抛 TypeError 被 catch 吞成 null**。表现是
 * `mineTunnel` 永远「读不到方块（区块没加载？），不敢瞎挖」，一格都挖不动，
 * 而当时所有替身测试全绿：**替身太宽容**（收普通对象也认）。
 *
 * 所以这里的替身**故意像真东西一样苛刻**：参数没有 `.floored()` 就抛。
 * 谁再把它改回普通对象，这条立刻红。
 */
describe('blockAt 契约：参数必须是 Vec3（替身照真实 API 苛刻）', () => {
    function strictBot(name: string | null): { bot: any; seen: any[] } {
        const seen: any[] = [];
        return {
            seen,
            bot: {
                blockAt: (p: any) => {
                    seen.push(p);
                    if (typeof p?.floored !== 'function') {
                        throw new TypeError('pos.floored is not a function');
                    }
                    return name == null ? null : { name };
                },
            },
        };
    }

    it('blockNameAt 传进去的对象带 floored()，坐标原样保留（含负数）', () => {
        const { bot, seen } = strictBot('netherrack');
        expect(blockNameAt(bot, -15, 70, 3)).toBe('netherrack');
        expect(seen).toHaveLength(1);
        expect(typeof seen[0].floored).toBe('function');
        expect([seen[0].x, seen[0].y, seen[0].z]).toEqual([-15, 70, 3]);
    });

    it('读不到方块时如实返回 null（不是"区块没加载"的谎）', () => {
        const { bot } = strictBot(null);
        expect(blockNameAt(bot, 0, 0, 0)).toBeNull();
    });

    it('mineTunnel 在真实契约下真的挖得动（严格替身 + 负数坐标 + 走生产路径）', async () => {
        // **生产路径**：`commands/progression.ts` 调 `mineTunnelSkill(agent.bot, ...)`
        // **不传 deps**，所以读格子走的是 `defaultBlockObject(bot, ...)` → `bot.blockAt`。
        // 这里故意只给 deps 的其它字段、**不给 blockAt**，逼它走那条路。
        const world = new Map<string, string>();
        const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
        // 注意：位置取整用的是 `Math.round`（(-14.5, 2.5) → (-14, 3)），铺格子要照着来。
        for (let x = -20; x <= -10; x += 1) {
            for (let y = 68; y <= 74; y += 1) world.set(key(x, y, 3), 'netherrack');
        }
        const dugOrder: string[] = [];
        const bot: any = {
            interrupt_code: false,
            health: 20,
            output: '',
            entity: { position: { x: -14.5, y: 70, z: 2.5 }, yaw: Math.PI / 2 },
            inventory: { items: () => [] },
            blockAt: (p: any) => {
                // 真 API：prismarine-world 的 getBlock 第一件事就是 pos.floored()
                if (typeof p?.floored !== 'function') throw new TypeError('pos.floored is not a function');
                const name = world.get(key(p.x, p.y, p.z));
                return name == null ? null : { name, position: { x: p.x, y: p.y, z: p.z }, hardness: 0.4, diggable: true };
            },
        };
        const deps = {
            position: () => ({ ...bot.entity.position }),
            dig: async (_b: any, x: number, y: number, z: number) => {
                const k = key(x, y, z);
                world.set(k, 'air');
                dugOrder.push(k);
                return true;
            },
            travel: async (b: any, x: number, y: number, z: number) => {
                b.entity.position = { x, y, z };
                return true;
            },
            tool: () => ({ name: 'diamond_pickaxe', remaining: 500, max: 1561, low: false }),
            health: () => bot.health,
            sleep: async (): Promise<void> => {},
            now: () => 0,
        };
        const receipt = await mineTunnelSkill(bot, 3, 2, '-x', deps as any);
        expect(dugOrder).toEqual(['-15,70,3', '-15,71,3', '-16,70,3', '-16,71,3', '-17,70,3', '-17,71,3']);
        expect(receipt).toContain('净前进 3/3 格');
        expect(receipt).not.toContain('读不到方块');
    });
});

describe('huntFor：击杀必须有证据（真机事故 01:20，overnight_a）', () => {
    // 真机：`huntFor(enderman)` 输出 12 次 `Successfully killed enderman.`——同一个实体 id
    // `enderman#286831`、0 个珍珠。末影人被打就瞬移，"离开 24 格扫描"被当成了死亡。
    // 现在的规矩：击杀只认"实体真的没了"（全局实体表 / 血量归零），同一个 id 又出现 = 瞬移 = 没死。
    const enderman = (id = 286831): any => ({
        id,
        name: 'enderman',
        health: 40,
        position: { x: 2, y: 64, z: 0, distanceTo: () => 2 },
    });

    it('同一个实体"消失又出现" → **击杀数不涨**，回执说它瞬移了', async () => {
        const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
        let clock = 0;
        const receipt = await huntForSkill(bot, 'enderman', 4, 48, 300_000, {
            findEntity: () => enderman(), // 永远是同一个 id
            attack: async () => true, // 攻击"说"打死了
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => (clock += 1_000),
            entityPresent: () => true, // 它还在世界里（= 瞬移走又回来）
        });

        expect(receipt).toMatch(/击杀 0 只/);
        expect(receipt).toContain('它瞬移了');
        expect(receipt).toContain('同一个实体 #286831 还在，不是击杀');
        expect(receipt).not.toContain('击杀 enderman（已验证');
        expect(receipt).toContain('同一个目标连续打不死');
    });

    it('**回溯更正**：上一轮"击杀"的同一个 id 又出现 → 击杀数被扣回去，并写明是假的', async () => {
        const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
        let clock = 0;
        const receipt = await huntForSkill(bot, 'enderman', 4, 48, 300_000, {
            findEntity: () => enderman(),
            attack: async () => true, // 每次都说打死了（而且当场"看起来"没了）
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => (clock += 1_000),
            entityPresent: () => false, // 当场看是没了……
        });

        // ……但同一个 id 下一轮又出现 ⇒ 必须撤回，不许累计成 4-12 个战果
        expect(receipt).toContain('是假的');
        expect(receipt).toContain('同一个实体又出现了');
        expect(receipt).toMatch(/击杀 [01] 只/); // 最多只剩最后一笔没来得及复核的
        expect(receipt).not.toMatch(/击杀 (?:[2-9]|\d\d+) 只/);
    });

    it('实体**真的**消失 → 击杀计数（只在有证据时）', async () => {
        const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
        let clock = 0;
        let calls = 0;
        const receipt = await huntForSkill(bot, 'enderman', 1, 48, 300_000, {
            // 每次给不同的 id（上一只真的死了，这一只是新的）
            findEntity: () => enderman(286831 + calls),
            attack: async () => {
                calls += 1;
                return true;
            },
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => (clock += 1_000),
            entityPresent: () => false,
        });

        expect(receipt).toMatch(/击杀 \d+ 只/);
        expect(receipt).toContain('击杀 enderman（已验证');
        expect(receipt).not.toContain('是假的');
    });

    it('同一个 id 连续打不死 → **熔断**（不是 12 次假成功），并给末影人打法', async () => {
        const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
        let clock = 0;
        let attacks = 0;
        const receipt = await huntForSkill(bot, 'enderman', 4, 48, 300_000, {
            findEntity: () => enderman(),
            attack: async () => {
                attacks += 1;
                return true; // 每次都"说"打死，但实体还在
            },
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => (clock += 1_000),
            entityPresent: () => true, // 还在 = 没死
        });

        expect(attacks).toBeLessThanOrEqual(HUNT_MAX_SAME_TARGET_FAILURES); // 早早熔断，不刷满
        expect(receipt).toContain('停止原因：同一个目标连续打不死');
        expect(receipt).toContain('**同一个目标连续打不死');
        expect(receipt).toContain('末影人提示');
        expect(receipt).toContain('船'); // 具体打法
        expect(receipt).toMatch(/击杀 0 只/);
        expect(receipt).not.toContain('Successfully');
        // 每行如实写"瞬移"，不写击杀
        expect(receipt).toContain('它瞬移了');
        expect(receipt).not.toContain('击杀 enderman（已验证');
        expect(receipt.trimEnd().split('\n').at(-1)).toMatch(/^下一步（照做即可）：/);
    });

    it('攻击"说"打死了但**读不到实体表** → 不算击杀（没证据就不许报战果）', async () => {
        const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
        let clock = 0;
        const receipt = await huntForSkill(bot, 'enderman', 1, 48, 60_000, {
            findEntity: () => enderman(),
            attack: async () => true,
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => (clock += 1_000),
            entityPresent: () => null, // 读不到
        });

        expect(receipt).toMatch(/击杀 0 只/);
        expect(receipt).toContain('没证据');
        expect(receipt).not.toContain('击杀 enderman（已验证');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 真机事故回归（2026-10-18 19:19，overnight_a）：
//   huntFor 内部 attack 传了 `'entity'`（真实只认 id / player / mob）→ 每次攻击都被拒，
//   而循环只按墙钟收口 → **315 万次空转**、每次 log() 往 bot.output 追加一行 →
//   **1.35 亿字符回执**，直接打爆整段上下文。
// 这四条把病根逐条钉死：① 真实解析器校验 ② 有界熔断 ③ 下一步不是同一个调用 ④ 硬长度上限。
// ─────────────────────────────────────────────────────────────────────────────
describe('huntFor 失控回执：参数名 / 熔断 / 下一步 / 长度上限', () => {
    /** 能过真实 `resolveAttackTarget` 的假 salmon（position 要有 distanceTo，getNearbyEntities 用它）。 */
    const salmonEntity = (): any => ({
        id: 7,
        name: 'salmon',
        position: { x: 1, y: 64, z: 0, distanceTo: () => 5 },
    });
    const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

    it('① 内部 type 过**真实解析器**：\'entity\' 被拒、内部常量不会被拒（当时该红的就是这条）', () => {
        // 真实 !attack 命令的 schema：params 只有 target + type（type 由 resolveAttackTarget 校验）
        const command = findCommand('attack');
        expect(command).toBeDefined();
        expect(Object.keys(command?.params ?? {})).toEqual(['target', 'type']);

        const bot = makeBot({ entities: { 7: salmonEntity() } });
        // 真实解析器要用 positions.distanceTo 算距离：假身也必须是"真形状"
        (bot.entity.position as any).distanceTo = () => 5;
        // 写错的类型必须被真实解析器拒绝……
        expect(resolveAttackTarget(bot, 'salmon', 'entity').message).toContain('只认');
        expect(resolveAttackTarget(bot, 'salmon', 'entity').entity).toBeNull();
        // ……内部用的常量必须过（HUNT_ATTACK_TYPE 就是喂给 skills.attackTarget 的第三个参数）
        const ok = resolveAttackTarget(bot, 'salmon', HUNT_ATTACK_TYPE);
        expect(ok.message).not.toContain('只认');
        expect(ok.entity?.name).toBe('salmon');
    });

    it('①b **不注入假 attack**：走真实默认路径（含真实类型解析），bot.output 里不许出现"type 必填"', async () => {
        const bot = makeBot({ entities: { 7: salmonEntity() } });
        (bot.entity.position as any).distanceTo = () => 5;
        bot.output = '';
        bot.heldItem = null;
        bot.equip = async (): Promise<void> => {};
        const swung: any[] = [];
        // 真实 skills.attackTarget(kill=true) 会走 swordpvp 并循环到目标消失；
        // 这里记录一次挥击并把实体移出实体表（模拟"打死了"），否则那个 kill 循环会一直等。
        bot.swordpvp = {
            weaponOfChoice: '',
            attack: async (entity: any): Promise<void> => {
                swung.push(entity);
                delete bot.entities[7];
            },
        };

        await huntForSkill(bot, 'salmon', 1, 16, 20_000, {
            findEntity: () => salmonEntity(),
            // 注意：**不传 attack** —— 走 progression 里的默认实现（就是写错过 'entity' 的那行）
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => Date.now(),
        });

        expect(swung.length).toBeGreaterThan(0); // 真的挥了手 = 类型解析过了
        expect(bot.output).toContain('锁定');
        expect(bot.output).not.toContain('type 必填');
    });

    it('② 攻击一直失败 + **时钟不前进** → 有界熔断（旧代码会在这里空转到超时）', async () => {
        let attacks = 0;
        const bot = makeBot({ health: 20 });
        const receipt = await huntForSkill(bot, 'salmon', 2, 48, 300_000, {
            findEntity: () => salmonEntity(),
            attack: async () => {
                attacks += 1;
                return false;
            },
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => 0, // 墙钟永远不走：只有"次数上限/连续失败"能救它
        });

        expect(attacks).toBeLessThanOrEqual(HUNT_MAX_CONSECUTIVE_FAILURES);
        expect(receipt).toContain('熔断');
        expect(receipt).toContain('连续');
        expect(receipt.length).toBeLessThan(2_000); // 旧代码这里是 1.35 亿
    });

    it('③ 熔断后"下一步"**不是**同一个会爆的调用，而是直接诊断', async () => {
        const bot = makeBot({ health: 20 });
        const receipt = await huntForSkill(bot, 'salmon', 2, 48, 300_000, {
            findEntity: () => salmonEntity(),
            attack: async () => false,
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => 0,
        });
        const next = lastLine(receipt);
        expect(next).toBe('下一步（照做即可）：attack(type="mob", target="salmon")');
        expect(next).not.toContain('huntFor(');
    });

    it('②b 打得死但一直没进账：到**尝试次数上限**就停（不是无限打）', async () => {
        let attacks = 0;
        const bot = makeBot({ health: 20 });
        const receipt = await huntForSkill(bot, 'salmon', 1, 48, 300_000, {
            findEntity: () => salmonEntity(),
            attack: async () => {
                attacks += 1;
                return true;
            },
            findDrop: () => null,
            sleep: async (): Promise<void> => {},
            now: () => 0,
        });

        expect(attacks).toBe(huntMaxAttempts(1));
        expect(receipt).toContain('尝试次数到上限');
        expect(lastLine(receipt)).toBe('下一步（照做即可）：stats(type="entities")');
    });

    it('④ 长度上限：列表级有天花板，单条超长也兜得住（尾部“下一步”必须还在）', () => {
        const lines = Array.from({ length: 5_000 }, (_, i) => `⚠️ 第 ${i} 条`);
        expect(capLines(lines, 8, '警告')).toHaveLength(9);
        expect(capLines(lines, 8, '警告')[8]).toContain('还有 4992 条警告省略');

        const base: HuntOutcome = {
            entity: 'salmon',
            want: 2,
            items: ['raw_salmon'],
            gained: 0,
            baseline: 0,
            kills: 0,
            attacks: 3_156_982,
            stopReason: 'attack_failed',
            elapsedMs: 300_000,
            netherBlaze: false,
            consecutiveFailures: HUNT_MAX_CONSECUTIVE_FAILURES,
            warnings: lines,
            progress: lines.map((text, i) => ({ attempt: i + 1, text })),
        };
        // ① 列表级天花板：5000 条警告/进度 → 回执很短，且写明省略了多少
        const listed = huntReceipt(base);
        expect(listed.length).toBeLessThan(2_500);
        expect(listed).toContain('省略');
        expect(lastLine(listed)).toBe('下一步（照做即可）：attack(type="mob", target="salmon")');
        // ② 字符级天花板：**单条**警告就有 5 万字符（列表级拦不住），必须靠硬上限兜
        const oneHuge = huntReceipt({ ...base, warnings: [`⚠️ ${'x'.repeat(50_000)}`], progress: [] });
        expect(oneHuge.length).toBeLessThanOrEqual(HUNT_RECEIPT_MAX_CHARS);
        expect(oneHuge).toContain('回执过长');
        expect(lastLine(oneHuge)).toBe('下一步（照做即可）：attack(type="mob", target="salmon")');
        expect(capReceipt('x'.repeat(50_000)).length).toBeLessThanOrEqual(HUNT_RECEIPT_MAX_CHARS);
    });

    it('重试上限与退避是纯函数（不会随 want 无限放大）', () => {
        expect(huntMaxAttempts(1)).toBe(HUNT_MAX_ATTEMPTS);
        expect(huntMaxAttempts(7)).toBe(14);
        expect(huntMaxAttempts(64)).toBe(HUNT_MAX_ATTEMPTS_CAP);
        expect(huntMaxAttempts(0)).toBe(HUNT_MAX_ATTEMPTS);
        expect(huntBackoffMs(1)).toBe(400);
        expect(huntBackoffMs(2)).toBe(800);
        expect(huntBackoffMs(99)).toBe(HUNT_ATTACK_BACKOFF_MAX_MS);
    });

    // 独立复核的发现：`attackEntity` 的 90 秒击杀预算耗尽**也**返回 false。
    // 原来"连续 3 次失败 ⇒ 工具可能坏了"把这种**慢失败**也算了进去，于是三只耐打的怪就让
    // 回执说「内部打怪动作可能有问题」、并把模型打发去 `attack` 调一个完全正常的工具——
    // 回执把模型骗了。下面几条把"快失败"和"打不死"钉开。
    describe('快失败 vs 打不死（时长感知的熔断）', () => {
        const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

        it('连续三次**耗完击杀预算**的失败 → 说"打不死"，绝不说工具坏了，下一步不是 attack', async () => {
            let clock = 0;
            let attacks = 0;
            const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
            const receipt = await huntForSkill(bot, 'blaze', 2, 48, 300_000, {
                findEntity: () => salmonEntity(),
                attack: async () => {
                    attacks += 1;
                    clock += 90_000; // = attackEntity 的击杀预算
                    return false;
                },
                findDrop: () => null,
                sleep: async (): Promise<void> => {},
                now: () => clock,
            });

            expect(attacks).toBeGreaterThanOrEqual(3);
            expect(receipt).toContain('停止原因：打不死');
            expect(receipt).toContain('**打不死**');
            expect(receipt).toContain('耗完击杀预算');
            expect(receipt).toContain('不是工具坏了');
            // 绝不能把模型打发去 debug 一个正常的工具
            expect(receipt).not.toContain('内部打怪动作');
            expect(receipt).not.toContain('参数/目标解析/服务端拒绝');
            const next = lastLine(receipt);
            expect(next.startsWith('下一步（照做即可）：')).toBe(true);
            expect(next).not.toContain('attack(');
            expect(next).not.toContain('huntFor(');
            // 烈焰人 → 先 prepareBlaze（换打法，而不是调工具）
            expect(next).toBe('下一步（照做即可）：prepareBlaze');
        });

        it('打不死但包里有更好的武器 → 下一步是 equip（换武器也是"换打法"）', async () => {
            let clock = 0;
            const bot = makeBot({
                health: 20,
                items: [stack('iron_sword', 1), stack('diamond_sword', 1)],
            });
            // 真机上 item.attackDamage 由 prismarine-item 提供（equipHighestAttack 也用它排序）
            bot.inventory.items = () => [
                { name: 'iron_sword', count: 1, attackDamage: 4 },
                { name: 'diamond_sword', count: 1, attackDamage: 7 },
            ];
            const receipt = await huntForSkill(bot, 'zombie', 2, 48, 300_000, {
                findEntity: () => salmonEntity(),
                attack: async () => {
                    clock += 90_000;
                    return false;
                },
                findDrop: () => null,
                sleep: async (): Promise<void> => {},
                now: () => clock,
            });

            expect(receipt).toContain('**打不死**');
            expect(lastLine(receipt)).toBe('下一步（照做即可）：equip(item_name="diamond_sword")');
        });

        it('三次**亚秒级**失败 → 仍然是原来的熔断口径（诊断 attack）', async () => {
            let clock = 0;
            const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
            const receipt = await huntForSkill(bot, 'salmon', 2, 48, 300_000, {
                findEntity: () => salmonEntity(),
                attack: async () => {
                    clock += 10;
                    return false;
                },
                findDrop: () => null,
                sleep: async (): Promise<void> => {},
                now: () => clock,
            });

            expect(receipt).toContain('停止原因：内部打怪动作连续失败');
            expect(receipt).toContain('几秒内就被拒');
            expect(receipt).not.toContain('**打不死**');
            expect(lastLine(receipt)).toBe('下一步（照做即可）：attack(type="mob", target="salmon")');
        });

        it('混合（慢、慢、快、慢）**不会提前熔断**，也不会诬告工具', async () => {
            let clock = 0;
            let attacks = 0;
            // 慢失败会把"快失败连击"清零：所以这一串里最快的连击只有 1 次，永远到不了 3。
            const durations = [90_000, 90_000, 10, 90_000];
            let ticket = 0;
            const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
            const receipt = await huntForSkill(bot, 'zombie', 2, 48, 300_000, {
                // 每次换一个 id（每次都在打不同的怪）：否则会被"同一目标连续打不死"提前熔断
                findEntity: () => ({ ...salmonEntity(), id: 7 + ticket++ }),
                attack: async () => {
                    clock += durations[Math.min(attacks, durations.length - 1)] ?? 10;
                    attacks += 1;
                    return false;
                },
                findDrop: () => null,
                sleep: async (): Promise<void> => {},
                now: () => clock,
            });

            expect(attacks).toBeGreaterThanOrEqual(4); // 没有在第 3 次就熔断
            expect(receipt).not.toContain('内部打怪动作'); // 没有"连续三次快失败"，就不许说工具坏了
            expect(receipt).not.toContain('停止原因：打不死'); // 混着快失败 → 不下"打不死"的结论
            expect(receipt).toContain('停止原因：到时间预算了'); // 由墙钟预算收尾（口径不变）
            // 但慢失败这件事仍然如实说一句（不改变下一步，也不诬告工具）
            expect(receipt).toContain('耗完击杀预算');
        });

        it('慢失败会清零"快失败连击"：快、快、慢、快、快、快 是在**第 6 次**才熔断，不是第 3 次', async () => {
            let clock = 0;
            let attacks = 0;
            const durations = [10, 10, 90_000, 10, 10, 10, 10];
            let ticket = 0;
            const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
            const receipt = await huntForSkill(bot, 'zombie', 2, 48, 300_000, {
                findEntity: () => ({ ...salmonEntity(), id: 7 + ticket++ }),
                attack: async () => {
                    clock += durations[Math.min(attacks, durations.length - 1)] ?? 10;
                    attacks += 1;
                    return false;
                },
                findDrop: () => null,
                sleep: async (): Promise<void> => {},
                now: () => clock,
            });

            // 中间那次 90 秒把连击清零 → 第 4、5 次才重新数到 1、2，第 6 次才到 3
            expect(attacks).toBe(6);
            expect(receipt).toContain('连续 3 次攻击都是**几秒内就被拒**'); // 这句话现在字面为真
            expect(receipt).toContain('停止原因：内部打怪动作连续失败');
        });

        it('打死了几只、只有慢失败 → 不算"打不死"（按原来的上限口径收尾）', async () => {
            let clock = 0;
            let attacks = 0;
            const bot = makeBot({ health: 20, items: [stack('iron_sword', 1)] });
            const receipt = await huntForSkill(bot, 'zombie', 1, 48, 300_000, {
                // 每次换一个 id：真的打死了一只，然后遇到两只打不动的
                findEntity: () => ({ ...salmonEntity(), id: 7 + attacks }),
                attack: async () => {
                    attacks += 1;
                    clock += attacks === 1 ? 10 : 90_000; // 先杀一只，再慢失败
                    return attacks === 1;
                },
                findDrop: () => null,
                sleep: async (): Promise<void> => {},
                now: () => clock,
                // 这一条只测"慢失败不诬告打不死"：击杀按"实体真的没了"算（默认实体表是空的 = 没了）
                entityPresent: () => false,
            });

            expect(receipt).not.toContain('**打不死**');
        });
    });

    it('同类风险一起堵：exploreReceipt / tunnelReceipt 也有硬长度上限', () => {
        const notes = Array.from({ length: 3_000 }, (_, i) => `提示 ${i}`);
        const explored = exploreReceipt({
            block: 'nether_bricks',
            origin: { x: 0, y: 70, z: 0 },
            here: { x: 384, y: 70, z: 0 },
            scanRadius: 64,
            maxSteps: 12,
            requestedLegs: 12,
            maxLeg: 48,
            step: 32,
            attemptedLegs: 12,
            completedLegs: 12,
            failedLegs: 0,
            walkedBlocks: 384,
            found: null,
            foundDistance: null,
            danger: null,
            timedOut: false,
            interrupted: false,
            unknownBlock: false,
            budgetMs: 270_000,
            notes: [`⚠️ 单条超长：${'x'.repeat(50_000)}`, ...notes],
        });
        expect(explored.length).toBeLessThanOrEqual(HUNT_RECEIPT_MAX_CHARS);
        expect(explored).toContain('回执过长');

        const tunneled = tunnelReceipt({
            dir: { label: '+x', fromYaw: false },
            requested: 256,
            dug: 256,
            blocksDug: 512,
            digAttempts: 512,
            moved: 256,
            toolChanges: [],
            stalls: 0,
            bridges: 0,
            height: 2,
            start: { x: 0, y: 70, z: 0 },
            here: { x: 256, y: 70, z: 0 },
            stop: 'done',
            detail: '',
            elapsedMs: 60_000,
            progress: Array.from({ length: 3_000 }, (_, i) => `第 ${i} 格`),
            toolName: 'diamond_pickaxe',
            toolRemaining: 500,
            toolMax: 1561,
            handMining: false,
            hintEquip: null,
        } as any);
        expect(tunneled.length).toBeLessThanOrEqual(HUNT_RECEIPT_MAX_CHARS);
        expect(tunneled).toContain('省略');
    });
});

