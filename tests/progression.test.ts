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
    MAX_LEG_PER_SCAN_RATIO,
    collectDrops,
    countItem,
    countTotalItems,
    describeCoverage,
    dropForEntity,
    exploreForSkill,
    exploreNextAction,
    exploreReceipt,
    hasFireResistance,
    hazardHere,
    huntForSkill,
    huntNextAction,
    maxLegPerScan,
    normalizeName,
    resolveBlockName,
    resolveEntityName,
    spiralReach,
    spiralScanPath,
    spiralWaypoints,
    worstCoverageDistance,
    type ExploreOutcome,
    type FlatPosition,
    type HuntOutcome,
} from '../src/body/library/progression.js';
import {
    EXPLORE_TIMEOUT_MIN,
    HUNT_MAX_MS_LIMIT,
    HUNT_TIMEOUT_MIN,
    parseExploreArgs,
    parseHuntArgs,
    progressionActionList,
} from '../src/body/commands/progression.js';
import { findCommand, toolDeclarations, toolNames } from '../src/body/commands/registry.js';
import { clearDiscards, markDiscarded, noteDiscardedEntity } from '../src/body/auto_pickup.js';
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
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：exploreFor(block="nether_bricks", max_steps=4)',
        );
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
    const TOOLS = ['exploreFor', 'huntFor'];

    it('两条命令都注册进 registry 了', () => {
        const names = toolNames();
        for (const tool of TOOLS) expect(names).toContain(tool);
        expect(progressionActionList.map((c) => c.name.replace('!', ''))).toEqual(TOOLS);
        expect(findCommand('exploreFor')?.name).toBe('!exploreFor');
        expect(findCommand('!huntFor')?.name).toBe('!huntFor');
    });

    it('都是 action + longRunning（长动作：走 12 腿 / 刷 5 分钟）', () => {
        for (const declaration of toolDeclarations().filter((d) => TOOLS.includes(d.name))) {
            expect(declaration.kind).toBe('action');
            expect(declaration.longRunning).toBe(true);
        }
    });

    it('参数签名就是任务要求的那四个/三个，且参数顺序 = perform 的位置参数顺序', () => {
        expect(Object.keys(findCommand('exploreFor')?.params ?? {})).toEqual(['block', 'max_steps', 'step']);
        expect(Object.keys(findCommand('huntFor')?.params ?? {})).toEqual(['entity', 'want', 'radius', 'max_ms']);
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
});
