/**
 * 中段推进能力的测试（不连 MC 服务端、不烧 token）。
 *
 * 这里钉五件事：
 * 1) **回执诚实**：没找到就说 `not found after N steps`，并写清扫描半径只覆盖
 *    已加载区块——绝不宣称扫过一个没加载的范围（这正是前半夜那个 bug）；
 * 2) **找到给坐标**：`found <方块> at (x, y, z)`，且下一步是一条能照抄的调用；
 * 3) **航点是真的在推进**：方形螺旋的坐标可逐腿核对，不是"原地打转"；
 * 4) **huntFor 到量就停**，并且**只认真实背包增量**（打了不等于到手）；
 * 5) **接线/门禁**：两条命令注册成 action + longRunning，schema 参数在 TOOL_TEXT
 *    里都有说明（`scripts/check-prompts.ts` 的同款不变式）。
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EXPLORE_MAX_STEPS,
    DEFAULT_EXPLORE_SCAN_RADIUS,
    DEFAULT_EXPLORE_STEP,
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
    normalizeName,
    resolveBlockName,
    resolveEntityName,
    spiralReach,
    spiralWaypoints,
    type ExploreOutcome,
    type FlatPosition,
    type HuntOutcome,
} from '../src/body/library/progression.js';
import { parseExploreArgs, parseHuntArgs, progressionActionList } from '../src/body/commands/progression.js';
import { findCommand, toolDeclarations, toolNames } from '../src/body/commands/registry.js';
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
    it('没找到 → not found after N steps，且写清只覆盖已加载区块', async () => {
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

        expect(receipt).toContain('not found after 3 steps');
        expect(receipt).toContain(`每次重扫半径 ${DEFAULT_EXPLORE_SCAN_RADIUS} 格`);
        expect(receipt).toContain('只扫已加载区块');
        expect(receipt).toContain('实际移动约');
        expect(receipt).toContain('从 (0, 64, 0) 到');
        // 三腿都走了：航点顺序 = 螺旋
        expect(visited).toEqual(spiralWaypoints({ x: 0, y: 64, z: 0 }, 32, 3).map((w) => ({ x: w.x, y: w.y, z: w.z })));
        // 严格最后一行是"一条能照抄的调用"
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            `下一步（照做即可）：exploreFor(block="nether_bricks", max_steps=6, step=32)`,
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
        expect(receipt).toContain('寻路失败 4 腿');
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
        expect(receipt).toContain('尝试 0/12 腿');
    });

    it('回执渲染：直接喂一个 outcome 也逐字可核（纯函数）', () => {
        const outcome: ExploreOutcome = {
            block: 'nether_bricks',
            scanRadius: 64,
            step: 32,
            maxSteps: 12,
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
            unknownBlock: false,
            notes: [],
        };
        expect(exploreNextAction(outcome)).toBe('exploreFor(block="nether_bricks", max_steps=6, step=32)');
        expect(exploreReceipt(outcome)).toContain(describeCoverage(64));
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
            maxMs: 7 * 60 * 1000, // 上限压在动作通道 8 分钟超时之下
        });
        expect(parseHuntArgs('烈焰人').entity).toBe('blaze');
        expect(parseHuntArgs('').error).toContain('entity 必填');
    });
});
