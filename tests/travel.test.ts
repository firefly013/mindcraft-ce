/**
 * `travelTo`：一次调用把"赶路"往前推一大截。
 *
 * 这一批测试钉的是**路线决策 + 安全门不走样 + 诚实可续**：
 *   1) 同 y 直线目标 ⇒ 走到并报"到了"；
 *   2) 斜向目标 ⇒ **长的轴先走**，走完自动换轴（回执里能看到换）；
 *   3) 预算到 ⇒ 部分推进 + 续跑调用（坐标是同一个目标，人从断点继续）；
 *   4) 前方岩浆 ⇒ 停（**不许为了赶路放宽 mineTunnel 的门**）；
 *   5) 镐快用完 ⇒ 停并给换镐提示；
 *   6) 没镐 / 跨维度 / 坐标读不出来 ⇒ **不出发**，说清先做什么；
 *   7) 读不到方块 ⇒ 停，不猜；
 *   8) 几何不变式：续跑调用真的接着上一次的断点往前走（不回头、不跳格）。
 */
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_TRAVEL_MAX_MS,
    NETHER_TRAVEL_LAYER,
    TRAVEL_ARRIVE_RADIUS,
    TRAVEL_MAX_MS_LIMIT,
    TRAVEL_WALK_MAX_BLOCKS,
    chooseTravelLayer,
    normalizeDimensionName,
    planTravelLegs,
    travelNextAction,
    travelReceipt,
    travelResumeCall,
    travelToSkill,
    type TravelOutcome,
} from '../src/body/library/progression.js';
import { TRAVEL_TIMEOUT_MIN, progressionActionList, PROGRESSION_TOOL_TEXT } from '../src/body/commands/progression.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import { getOpenAITools } from '../src/brain/tools/advertise.js';
import { ACTION_MAX_MS } from '../src/brain/action_runner.js';

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
/** 回执里的**实测位移**（唯一能当"推进"用的数）。 */
const displacementOf = (receipt: string): number => Number(/实测位移 ([\d.]+) 格/.exec(receipt)?.[1] ?? '0');
/** 回执最后一行（"下一步"）。 */
const lastLineOf = (receipt: string): string => receipt.trimEnd().split('\n').at(-1) ?? '';

/**
 * 假身体：`cells` 里的格子有特殊方块，其余默认下界岩（实心、可挖）。
 * `travel`/`walk` 会**真的把 bot 挪过去**（一步一格），这样"推进量"是位置增量算出来的。
 */
function travelHarness(
    options: {
        pos?: { x: number; y: number; z: number };
        dimension?: string;
        tool?: { name: string | null; remaining: number | null; max: number | null; low: boolean };
        inventory?: Array<{ name: string; count: number }>;
        health?: number;
        cells?: Record<string, string>;
        unreadable?: string[];
        /** 寻路(走)能不能动：false = 走不动（模拟洞/寻路失败）。 */
        canWalk?: boolean;
        /** 隧道里"走进去"能不能动。 */
        canStep?: boolean;
        /** 每次 digLine 调用后把时钟往前拨多少毫秒。 */
        msPerStep?: number;
        /** 每挖一格耗时（毫秒），用来把预算烧掉。 */
        msPerDig?: number;
    } = {},
) {
    const special = new Map<string, string>(Object.entries(options.cells ?? {}));
    const placed = new Map<string, string>();
    const dug = new Set<string>();
    let clock = 0;
    const bridgeCalls: Array<{ block: string; x: number; y: number; z: number }> = [];
    const bot: any = {
        interrupt_code: false,
        health: options.health ?? 20,
        food: 20,
        game: { dimension: options.dimension ?? 'the_nether' },
        entity: { position: { ...(options.pos ?? { x: 0, y: 70, z: 0 }) }, yaw: 0 },
        inventory: { items: () => options.inventory ?? [{ name: 'diamond_pickaxe', count: 1 }] },
        output: '',
    };
    const blockName = (x: number, y: number, z: number): string =>
        placed.get(key(x, y, z)) ?? (dug.has(key(x, y, z)) ? 'air' : (special.get(key(x, y, z)) ?? 'netherrack'));

    const deps: any = {
        now: () => clock,
        sleep: async (ms: number) => {
            clock += ms;
        },
        position: () => ({ ...bot.entity.position }),
        health: () => bot.health,
        dimension: () => bot.game.dimension,
        blockAt: (_b: any, x: number, y: number, z: number) => {
            if ((options.unreadable ?? []).includes(key(x, y, z))) return null;
            const name = blockName(x, y, z);
            return {
                name,
                hardness: name === 'obsidian' ? 50 : 0.4,
                diggable: true,
                boundingBox: name === 'air' ? 'empty' : 'block',
                position: { x, y, z },
            };
        },
        dig: async (_b: any, x: number, y: number, z: number) => {
            clock += options.msPerDig ?? 0;
            dug.add(key(x, y, z));
            return true;
        },
        travel: async (_b: any, x: number, y: number, z: number) => {
            if (options.canStep === false) return false;
            bot.entity.position = { x, y, z };
            return true;
        },
        // 搭桥：只有背包里真有垫脚料才搭得成（和真机 placeBlock 的约束一致）
        scaffold: () => {
            const items: Array<{ name: string; count: number }> =
                options.inventory ?? [{ name: 'diamond_pickaxe', count: 1 }];
            return items.find((item) => item.name === 'cobblestone' || item.name === 'netherrack')?.name ?? null;
        },
        place: async (_b: any, block: string, x: number, y: number, z: number) => {
            bridgeCalls.push({ block, x, y, z });
            placed.set(key(x, y, z), block);
            return true;
        },
        walk: async (_b: any, x: number, _y: number, z: number) => {
            if (options.canWalk === false) return false;
            // 一步一格地走过去（带一点耗时，方便测预算）
            let guard = 0;
            while ((Math.abs(bot.entity.position.x - x) > 0 || Math.abs(bot.entity.position.z - z) > 0) && guard < 600) {
                guard += 1;
                clock += options.msPerStep ?? 0;
                const dx = Math.sign(x - bot.entity.position.x);
                const dz = Math.sign(z - bot.entity.position.z);
                bot.entity.position = {
                    x: bot.entity.position.x + dx,
                    y: bot.entity.position.y,
                    z: bot.entity.position.z + (dx === 0 ? dz : 0),
                };
            }
            return true;
        },
        stairUp: async (_b: any, distance: number) => {
            bot.entity.position = { ...bot.entity.position, y: bot.entity.position.y + distance };
            clock += options.msPerStep ?? 0;
            return true;
        },
        digDown: async (_b: any, distance: number) => {
            bot.entity.position = { ...bot.entity.position, y: bot.entity.position.y - distance };
            clock += options.msPerStep ?? 0;
            return true;
        },
        tool: () => options.tool ?? { name: 'diamond_pickaxe', remaining: 900, max: 1561, low: false },
    };
    return {
        bot,
        deps,
        clockNow: () => clock,
        setClock: (v: number) => (clock = v),
        dugCount: () => dug.size,
        bridgeCalls,
        /** 直接改"世界里那一格是什么"（测试里模拟"垫成功了"）。 */
        placedSet: (k: string, name: string) => placed.set(k, name),
    };
}

describe('travelTo：路线规划（纯函数）', () => {
    it('同 y：短距离先走路，长距离直接挖长轴', () => {
        const short = planTravelLegs({ x: 0, y: 70, z: 0 }, { x: 10, y: 70, z: 0 }, { walkAllowed: true });
        expect(short).toHaveLength(1);
        expect(short[0]?.kind).toBe('walk');

        const long = planTravelLegs({ x: 0, y: 70, z: 0 }, { x: 300, y: 70, z: 0 }, { walkAllowed: true });
        expect(long[0]?.kind).toBe('tunnel');
        expect(long[0]?.axis).toBe('x');
        expect(long[0]?.sign).toBe(1);
    });

    it('有高差：先竖直段（上=台阶 / 下=台阶），纯竖直才用 pillarUp/digDown', () => {
        const up = planTravelLegs({ x: 0, y: 70, z: 0 }, { x: 0, y: 116, z: 0 }, { walkAllowed: true });
        expect(up).toHaveLength(1);
        expect(up[0]?.kind).toBe('stairUp');
        expect(up[0]?.blocks).toBe(46);

        const down = planTravelLegs({ x: 0, y: 116, z: 0 }, { x: 0, y: 70, z: 0 }, { walkAllowed: true });
        expect(down[0]?.kind).toBe('digDown');
        expect(down[0]?.blocks).toBe(46);

        // 又上又前：**斜上台阶**（一边挖一边上），不需要垫脚料
        const diagonal = planTravelLegs({ x: 0, y: 70, z: 0 }, { x: 300, y: 116, z: 0 }, { walkAllowed: true });
        expect(diagonal[0]?.kind).toBe('stairTunnel');
        expect(diagonal[0]?.blocks).toBe(46);
        expect(diagonal[0]?.axis).toBe('x');
        expect(diagonal[0]?.label).toContain('不用垫脚料');
    });

    it('斜向：**长的轴先走**，另一轴在回执里预告', () => {
        const legs = planTravelLegs({ x: 0, y: 70, z: 0 }, { x: 300, y: 70, z: 40 }, { walkAllowed: true });
        expect(legs[0]?.kind).toBe('tunnel');
        expect(legs[0]?.axis).toBe('x');
        expect(legs[0]?.blocks).toBe(256); // 单腿上限
        expect(legs[0]?.label).toContain('另一轴（z）还差 40 格');

        // 走完 x 之后重新规划 → 自动换到 z（短的那条）
        const next = planTravelLegs({ x: 256, y: 70, z: 0 }, { x: 300, y: 70, z: 40 }, { walkAllowed: true });
        expect(next[0]?.kind).toBe('walk'); // 只剩 44 格水平 → 先试走路
        const tunnelNext = planTravelLegs({ x: 256, y: 70, z: 0 }, { x: 300, y: 70, z: 400 }, { walkAllowed: true });
        expect(tunnelNext[0]?.axis).toBe('z');
    });

    it('下坡（终点在下方）也用斜下台阶，不是 1×1 竖井', () => {
        const legs = planTravelLegs({ x: 0, y: 116, z: 0 }, { x: 300, y: 52, z: 0 }, { walkAllowed: true });
        expect(legs[0]?.kind).toBe('stairTunnel');
        expect(legs[0]?.rise).toBe(-1);
        expect(legs[0]?.blocks).toBe(64); // 单腿竖直上限
        expect(legs[0]?.label).toContain('斜下台阶');
    });

    it('已经在目标旁边 ⇒ 不再规划腿', () => {
        expect(planTravelLegs({ x: 0, y: 70, z: 0 }, { x: 1, y: 70, z: 1 }, { walkAllowed: true })).toHaveLength(0);
    });

    it('下界层高：默认爬到 116；给了 layer 就用给的；主世界不动层高', () => {
        const nether = chooseTravelLayer({ dimension: 'the_nether', dx: 500, dz: 0, requested: null });
        expect(nether.layer).toBe(NETHER_TRAVEL_LAYER);
        expect(nether.note).toContain('97% 是实心下界岩');

        expect(chooseTravelLayer({ dimension: 'the_nether', dx: 500, dz: 0, requested: 70 }).layer).toBe(70);
        expect(chooseTravelLayer({ dimension: 'the_nether', dx: 10, dz: 0, requested: null }).layer).toBeNull();
        expect(chooseTravelLayer({ dimension: 'overworld', dx: 500, dz: 0, requested: null }).layer).toBeNull();
    });

    it('维度名归一：nether/下界/the_nether 都认', () => {
        expect(normalizeDimensionName('nether')).toBe('the_nether');
        expect(normalizeDimensionName('下界')).toBe('the_nether');
        expect(normalizeDimensionName('the_nether')).toBe('the_nether');
        expect(normalizeDimensionName('主世界')).toBe('overworld');
        expect(normalizeDimensionName('末地')).toBe('the_end');
        expect(normalizeDimensionName('  ')).toBeNull();
        expect(normalizeDimensionName(7)).toBeNull();
    });
});

describe('travelTo：一次调用往前走（执行）', () => {
    it('同 y 直线目标 ⇒ 走到并报"到了"（且没用挖的）', async () => {
        const h = travelHarness({ pos: { x: 0, y: 70, z: 0 }, dimension: 'overworld' });
        const receipt = await travelToSkill(h.bot, 30, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('**到了**');
        expect(h.bot.entity.position.x).toBe(30);
        expect(h.dugCount()).toBe(0); // 走得到就别挖
    });

    it('斜向目标 ⇒ 长的轴先走，回执里能看到两条腿（先 x 再 z）', async () => {
        const h = travelHarness({ pos: { x: 0, y: 70, z: 0 } });
        const receipt = await travelToSkill(h.bot, 60, 70, 20, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('**到了**');
        expect(h.bot.entity.position.x).toBe(60);
        expect(h.bot.entity.position.z).toBe(20);
        // 长的轴（x=60 > z=20）先走
        expect(receipt.indexOf('沿 +x')).toBeGreaterThan(-1);
        expect(receipt.indexOf('沿 +x')).toBeLessThan(receipt.indexOf('沿 +z'));
    });

    it('预算到 ⇒ 部分推进 + 续跑调用（人从断点继续，方向/剩余格都写在回执里）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            // 每挖一格 400ms：5 分钟预算挖不完 500 格
            msPerDig: 400,
        });
        const receipt = await travelToSkill(h.bot, 500, 70, 0, 60_000, undefined, undefined, h.deps);

        expect(receipt).toMatch(/\*\*没出发\*\*|\*\*往前推进了 \d+ 格/);
        const advanced = displacementOf(receipt);
        expect(advanced).toBeGreaterThan(0);
        expect(advanced).toBeLessThan(500);
        expect(receipt).toContain('还剩');
        expect(receipt).toContain('时间预算用完');
        const next = receipt.trimEnd().split('\n').at(-1) ?? '';
        // 下界水平长途会自动带上推荐层高，续跑照抄即可
        expect(next).toBe('下一步（照做即可）：travelTo(x=500, y=70, z=0, layer=116, max_ms=60000)');
    });

    it('前方是岩浆 ⇒ 停，且用的是 mineTunnel 的原话与下一步（不放宽安全门）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            // x=4 那一步的脚位/脚下是岩浆
            cells: {
                [key(4, 70, 0)]: 'lava',
                [key(4, 71, 0)]: 'lava',
                [key(4, 69, 0)]: 'lava',
            },
        });
        const receipt = await travelToSkill(h.bot, 400, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('安全门');
        expect(receipt).toContain('前方');
        expect(receipt).toContain('岩浆');
        expect(receipt).toContain('(4, 70, 0)');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：moveAway(distance=8)');
    });

    it('镐快用完 ⇒ 停并给换镐提示（带具体工具名）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            tool: { name: 'iron_pickaxe', remaining: 5, max: 250, low: true },
            inventory: [
                { name: 'iron_pickaxe', count: 1 },
                { name: 'diamond_pickaxe', count: 1 },
            ],
        });
        const receipt = await travelToSkill(h.bot, 400, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('镐快用完了');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：equip(item_name="diamond_pickaxe")');
    });

    it('读不到方块 ⇒ 停，明说读不到（不猜、不硬挖）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            unreadable: [key(1, 70, 0), key(2, 70, 0), key(3, 70, 0), key(4, 70, 0), key(5, 70, 0)],
        });
        const receipt = await travelToSkill(h.bot, 400, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('读不到');
        expect(receipt).toContain('不敢瞎挖');
        expect(h.bot.entity.position.x).toBe(0); // 原地不动才是对的
    });
});

describe('travelTo：诚实拒绝（不出发）', () => {
    it('**镐在背包里、只是没握在手上** ⇒ 不许报"没有镐"：自己换上再走（真机 overnight_b）', async () => {
        let held: string | null = 'stone_sword';
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            tool: { name: 'stone_sword', remaining: null, max: null, low: false },
            inventory: [{ name: 'iron_pickaxe', count: 1 }],
        });
        const equipped: string[] = [];
        h.deps.tool = () => ({ name: held, remaining: held == null ? null : 900, max: held == null ? null : 1561, low: false });
        h.deps.equip = async (_b: any, item: string) => {
            equipped.push(item);
            held = item;
            return true;
        };
        const receipt = await travelToSkill(h.bot, 200, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(equipped).toEqual(['iron_pickaxe']); // 自己换上了，不是拒绝
        expect(receipt).not.toContain('**没出发**');
        expect(receipt).not.toContain('没有镐');
        expect(receipt).toContain('镐在背包里没握在手上 → 已自动换上 iron_pickaxe');
        expect(displacementOf(receipt)).toBeGreaterThan(0); // 而且真的往前走了
    });

    it('没有镐 + 需要挖 ⇒ 拒绝，并说清镐要在工作台上做', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            tool: { name: null, remaining: null, max: null, low: false },
            inventory: [{ name: 'stone', count: 8 }],
        });
        const receipt = await travelToSkill(h.bot, 400, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('**没出发**');
        expect(receipt).toContain('没有镐');
        expect(receipt).toContain('工作台');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe(
            '下一步（照做即可）：useBlock(type="crafting_table", input="3 cobblestone, 2 stick", output="1 stone_pickaxe")',
        );
        expect(h.bot.entity.position.x).toBe(0);
    });

    it('目标在别的维度 ⇒ 拒绝，并让你先 enterNether()', async () => {
        const h = travelHarness({ pos: { x: 0, y: 70, z: 0 }, dimension: 'overworld' });
        const receipt = await travelToSkill(h.bot, 100, 70, 0, 300_000, undefined, 'the_nether', h.deps);

        expect(receipt).toContain('**没出发**');
        expect(receipt).toContain('目标不在当前维度');
        expect(receipt).toContain('enterNether()');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：enterNether()');
    });

    it('坐标读不出来 ⇒ 拒绝（不当成 0）', async () => {
        const h = travelHarness({ pos: { x: 5, y: 70, z: 5 } });
        const receipt = await travelToSkill(h.bot, 'abc', 70, undefined, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('**没出发**');
        expect(receipt).toContain('坐标读不出来');
        expect(h.bot.entity.position.x).toBe(5);
    });
});

describe('travelTo：不许挖穿容器 + 小推进必须点名拦路的东西（真机：挖了基地的箱子、只推进 2.3 格）', () => {
    it('直线穿过 chest(1,70,0) ⇒ 箱子没被挖、绕过去、回执点名它', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'cobblestone', count: 8 },
            ],
            canWalk: false,
            cells: { [key(1, 70, 0)]: 'chest' },
        });
        const receipt = await travelToSkill(h.bot, 8, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('chest');
        expect(receipt).toContain('(1, 70, 0)');
        expect(receipt).toContain('不挖它');
        expect(receipt).toContain('里面的东西原样没动');
        expect(h.bot.entity.position.y).toBe(71); // 抬一格绕过去
        expect(displacementOf(receipt)).toBeGreaterThan(0);
    });

    it('拦路的是箱子且绕不开 ⇒ 停手，回执**点名它**并说"只推进了 N 格"', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [{ name: 'diamond_pickaxe', count: 1 }],
            canWalk: false,
            cells: { [key(1, 70, 0)]: 'chest', [key(1, 71, 0)]: 'chest', [key(1, 72, 0)]: 'chest' },
        });
        const receipt = await travelToSkill(h.bot, 8, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(displacementOf(receipt)).toBe(0);
        expect(receipt).toContain('**只推进了 0.0 格**');
        expect(receipt).toContain('卡在');
        expect(receipt).toContain('chest');
        expect(receipt).toContain('(1, 70, 0)');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：mineTunnel(length=2, direction="+z")');
    });

    it('寻路卡住（一直不靠近）⇒ **15 秒熔断**、停手改挖隧道，而不是干等 90 秒', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [{ name: 'diamond_pickaxe', count: 1 }],
            canWalk: true,
        });
        const stopped: number[] = [];
        h.deps.walk = () => new Promise<boolean>(() => {}); // 永远不返回：卡住的那种
        h.deps.stopWalk = () => stopped.push(1);
        const startedAt = h.clockNow();
        const receipt = await travelToSkill(h.bot, 40, 70, 0, 300_000, undefined, undefined, h.deps);
        const elapsed = h.clockNow() - startedAt;

        expect(stopped).toHaveLength(1); // 真的让寻路器停手了
        expect(elapsed).toBeLessThan(60_000); // 远小于"干等 90 秒"
        expect(receipt).toContain('没靠近');
        expect(receipt).toContain('改挖隧道');
        expect(displacementOf(receipt)).toBeGreaterThan(0); // 换成挖之后真的往前走了
    });
});

describe('travelTo：搭桥（横向的 pillarUp）', () => {
    it('**真机那一幕**：洞里第一级台阶下面是空气 + 背包有方块 → 垫一块桥就往上走（不再原地打死结）', async () => {
        // overnight_b 在 (-29,46,8) 的洞里：想往上爬，第一级台阶的"脚下"是 air。
        const h = travelHarness({
            pos: { x: -29, y: 46, z: 8 },
            dimension: 'the_nether',
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'netherrack', count: 12 },
            ],
            // 第一级台阶的支撑格 = 当前层往前一格：air（洞里就是这样）
            cells: { [key(-28, 46, 8)]: 'air' },
        });
        const receipt = await travelToSkill(h.bot, 100, 46, 8, 300_000, undefined, undefined, h.deps);

        // 桥垫上了，而且**真的往前/往上走了**
        expect(h.bridgeCalls.length).toBeGreaterThan(0);
        expect(h.bridgeCalls[0]?.block).toBe('netherrack');
        expect(receipt).toContain('垫了一块桥');
        expect(h.bot.entity.position.x).toBeGreaterThan(-29);
        const advanced = displacementOf(receipt);
        expect(advanced).toBeGreaterThan(0);
        expect(receipt).not.toContain('**没出发**');
    });

    it('洞里但背包里没有方块 → 停手并点名问题（不再是 pillarUp(distance=2) 那个死循环）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [{ name: 'diamond_pickaxe', count: 1 }],
            cells: { [key(1, 69, 0)]: 'air' },
        });
        const receipt = await travelToSkill(h.bot, 400, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(h.bridgeCalls).toHaveLength(0);
        expect(h.bot.entity.position.x).toBe(0);
        expect(receipt).toContain('没有能垫的方块');
        const next = receipt.trimEnd().split('\n').at(-1) ?? '';
        expect(next).not.toContain('pillarUp');
        expect(next).toContain('mineTunnel(length=2');
    });

    it('**连续两次调用都不许"推进 0 格 + 同一个门"**（有方块就必须走出这个洞）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'cobblestone', count: 8 },
            ],
            // 走不过去（洞/寻路失败）→ 只能挖；而且第一格脚下是空洞 → 必须搭桥
            canWalk: false,
            msPerDig: 500,
            cells: { [key(1, 69, 0)]: 'air' },
        });
        // 预算只够挖一小段：第一趟必然是"部分推进 + 续跑"
        const first = await travelToSkill(h.bot, 60, 70, 0, 25_000, undefined, undefined, h.deps);
        const advanced1 = displacementOf(first);
        const stop1 = h.bot.entity.position.x;

        const second = await travelToSkill(h.bot, 60, 70, 0, 25_000, undefined, undefined, h.deps);
        const advanced2 = displacementOf(second);

        expect(advanced1).toBeGreaterThan(0); // 第一次就不能是 0（桥搭过去了）
        expect(advanced2).toBeGreaterThan(0); // 第二次接着走，也不会是 0
        expect(h.bot.entity.position.x).toBeGreaterThan(stop1);
        // 两次都不能拿"脚下悬空"当结论（桥已经搭过去了）
        expect(second).not.toContain('下一步脚下不是实心');
    });

    it('搭桥一次不成 ⇒ **换个依附面/换种材料再试**，成了就继续走（不是只丢一句 moveAway）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'cobblestone', count: 8 },
                { name: 'netherrack', count: 8 },
            ],
            canWalk: false,
            cells: { [key(1, 69, 0)]: 'air' },
        });
        const attempts: Array<{ block: string; face: string | undefined }> = [];
        h.deps.place = async (_b: any, block: string, x: number, y: number, z: number, face?: string) => {
            attempts.push({ block, face });
            if (attempts.length <= 2) return false; // 前两次没搭上（依附面/材料不对）
            h.placedSet(key(x, y, z), block);
            return true;
        };
        const receipt = await travelToSkill(h.bot, 8, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(attempts.length).toBeGreaterThanOrEqual(3); // 真的换了再试
        expect(new Set(attempts.map((a) => `${a.block}@${a.face}`)).size).toBeGreaterThan(1);
        expect(receipt).toContain('垫了一块桥过去');
        expect(receipt).toContain('先试了');
        expect(displacementOf(receipt)).toBeGreaterThan(0); // 桥搭上了就继续走
    });

    it('所有依附面/材料都搭不上 ⇒ 停手，并把**试过什么**写清楚', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'cobblestone', count: 8 },
            ],
            canWalk: false,
            cells: { [key(1, 69, 0)]: 'air' },
        });
        const attempts: string[] = [];
        h.deps.place = async (_b: any, block: string, _x: number, _y: number, _z: number, face?: string) => {
            attempts.push(`${block}@${face}`);
            return false;
        };
        const receipt = await travelToSkill(h.bot, 8, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(attempts.length).toBeGreaterThanOrEqual(3);
        expect(receipt).toContain('搭桥');
        expect(receipt).toContain('都没成功');
        expect(receipt).toContain('试了');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：moveAway(distance=3)');
    });

    it('桥下是岩浆 → 拒绝搭桥（沿用液体门的措辞，一块都不垫）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'cobblestone', count: 8 },
            ],
            cells: { [key(1, 69, 0)]: 'air', [key(1, 68, 0)]: 'lava' },
        });
        const receipt = await travelToSkill(h.bot, 400, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(h.bridgeCalls).toHaveLength(0);
        expect(receipt).toContain('就是岩浆（桥下面）');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：moveAway(distance=8)');
    });

    it('搭桥之后继续正常挖：**没有重复挖、也没有漏步**（连续性不变式）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            inventory: [
                { name: 'diamond_pickaxe', count: 1 },
                { name: 'cobblestone', count: 8 },
            ],
            canWalk: false,
            cells: { [key(1, 69, 0)]: 'air' },
        });
        const receipt = await travelToSkill(h.bot, 20, 70, 0, 300_000, undefined, undefined, h.deps);

        // 推进行程是一条直线：x 从 0 连续走到 20，没有跳格/回头
        expect(h.bot.entity.position.x).toBe(20);
        const advanced = displacementOf(receipt);
        expect(advanced).toBe(20);
        // 桥只垫在需要的那一格，不会把整条路铺满
        expect(h.bridgeCalls).toHaveLength(1);
        expect(h.bridgeCalls[0]).toMatchObject({ block: 'cobblestone', x: 1, y: 69, z: 0 });
    });
});

describe('travelTo：进度必须是量出来的（真机 02:0x：挖了但位移 0）', () => {
    it('挖得动但人进不去 ⇒ 标题就是 0 格，并把**矛盾**摆出来', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'overworld',
            canWalk: false, // 走不动 → 只能挖
            canStep: false, // 挖通了但**走不进去**（这就是"挖了 64 格、位移 0"的形状）
        });
        const receipt = await travelToSkill(h.bot, 200, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(displacementOf(receipt)).toBe(0);
        expect(receipt).toContain('**往前推进了 0 格');
        expect(receipt).toContain('**矛盾**');
        expect(receipt).toContain('别把挖掉的方块当成走过的路');
        // 位移 0 就不许给"接着走"的同一条调用
        expect(lastLineOf(receipt)).toBe('下一步（照做即可）：stats(type="body")');
        expect(lastLineOf(receipt)).not.toContain('travelTo(');
    });

    it('0 进度时**下一步不是同一个 travelTo**（不许原地打转）', async () => {
        const h = travelHarness({
            pos: { x: 0, y: 70, z: 0 },
            dimension: 'the_nether',
            canStep: false,
            // 一开始就"到不了"：人卡在原地
        });
        const receipt = await travelToSkill(h.bot, 500, 70, 0, 300_000, undefined, undefined, h.deps);

        const next = lastLineOf(receipt);
        expect(next.startsWith('下一步（照做即可）：')).toBe(true);
        expect(next).not.toContain('travelTo(');
        expect(displacementOf(receipt)).toBe(0);
    });
});

describe('travelTo：几何不变式（续跑真的接得上）', () => {
    it('两次调用的接点严格连续：第二次从第一次停下那点出发，剩余距离单调减少，不回头', async () => {
        // 预算刚好挖一段：每格 400ms × 60s ≈ 145 格
        const h = travelHarness({ pos: { x: 0, y: 70, z: 0 }, msPerDig: 400 });
        const first = await travelToSkill(h.bot, 500, 70, 0, 60_000, undefined, undefined, h.deps);
        const stop1 = { ...h.bot.entity.position };
        const remaining1 = 500 - stop1.x;

        const resume = /下一步（照做即可）：(travelTo\([^)]*\))/.exec(first)?.[1] ?? '';
        expect(resume).toBe('travelTo(x=500, y=70, z=0, layer=116, max_ms=60000)');
        expect(remaining1).toBeGreaterThan(0);

        // 第二趟：**同一个目标**，所以它必然从断点接着往前走
        const second = await travelToSkill(h.bot, 500, 70, 0, 60_000, undefined, undefined, h.deps);
        const stop2 = { ...h.bot.entity.position };
        const remaining2 = 500 - stop2.x;

        expect(stop2.x).toBeGreaterThan(stop1.x); // 前进，不回头
        expect(remaining2).toBeLessThan(remaining1);
        // 起点没有跳格：第二趟的第一条腿的起点就是 stop1（回执里的"现在"从 stop1 开始）
        expect(second).toContain(`(${stop1.x}, ${stop1.y}, ${stop1.z})`);
        // 而且没有把已经走过的路重挖一遍（第二趟挖的格数不超过剩余距离）
        expect(remaining1 - remaining2).toBeLessThanOrEqual(remaining1 + 1);
    });

    it('travelResumeCall / travelNextAction 是纯函数：目标坐标原样带回去，layer 也带上', () => {
        const base = {
            target: { x: -332, y: 116, z: 88 },
            start: { x: 0, y: 70, z: 0 },
            here: { x: -100, y: 116, z: 88 },
            distanceBefore: 343,
            progressed: 243,
            blocksDug: 243,
            stop: 'budget' as const,
            detail: '',
            layer: NETHER_TRAVEL_LAYER,
            layerNote: '',
            legs: [],
            gate: null,
            gateNextCall: null,
            toolName: 'diamond_pickaxe',
            toolRemaining: 900,
            toolMax: 1561,
            handMining: false,
            budgetMs: 300_000,
            elapsedMs: 300_000,
            progress: [],
            yExplicit: true,
        } satisfies TravelOutcome;

        expect(travelResumeCall(base)).toBe('travelTo(x=-332, y=116, z=88, layer=116, max_ms=300000)');
        expect(travelNextAction(base)).toBe(travelResumeCall(base));
        // 安全门自己的下一步优先（不许用"续跑"把它盖掉）
        expect(travelNextAction({ ...base, gateNextCall: 'moveAway(distance=8)' })).toBe('moveAway(distance=8)');
        expect(travelNextAction({ ...base, stop: 'arrived' })).toBe('stats(type="body")');
        expect(travelNextAction({ ...base, stop: 'no_pickaxe' })).toContain('crafting_table');
        expect(travelNextAction({ ...base, stop: 'wrong_dimension', detail: '目标是 the_nether' })).toBe('enterNether()');
        // 回执结尾永远只有一条"下一步"
        const text = travelReceipt(base);
        const nextLines = text.split('\n').filter((line) => line.startsWith('下一步（照做即可）：'));
        expect(nextLines).toHaveLength(1);
        expect(text).toContain('离目标还剩');
    });

    it('竖直段先走：给 y=116 就真的先爬/下到那一层', async () => {
        const h = travelHarness({ pos: { x: 0, y: 70, z: 0 } });
        const receipt = await travelToSkill(h.bot, 0, 116, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('**到了**');
        expect(h.bot.entity.position.y).toBe(116);
        expect(receipt).toContain('stairUp 46 格');
    });

    it('下界长途（给了 y=70 的目标）也会**先爬到 116 修隧道**，最后再下到 70', async () => {
        const h = travelHarness({ pos: { x: 0, y: 70, z: 0 }, dimension: 'the_nether' });
        const receipt = await travelToSkill(h.bot, 200, 70, 0, 300_000, undefined, undefined, h.deps);

        expect(receipt).toContain('97% 是实心下界岩'); // 层高说明在回执里
        // 爬 46 格用的是**斜上台阶**（一边挖一边上），不需要 46 块垫脚料
        expect(receipt).toContain('斜上台阶');
        expect(receipt).toContain('不用垫脚料');
        expect(receipt).toMatch(/斜上台阶\*\* 46 格/);
        // 走完水平段后要回到目标高度 70
        expect(h.bot.entity.position.x).toBe(200);
        expect(h.bot.entity.position.y).toBe(70);
        expect(receipt).toContain('digDown'); // 最后那一段是往下回到 70
    });
});

describe('travelTo：接线与门禁', () => {
    it('!travelTo 是 action + longRunning，参数齐全且有 TOOL_TEXT 说明', () => {
        const command = progressionActionList.find((c) => c.name === '!travelTo');
        expect(command).toBeDefined();
        expect(command?.perform.longRunning).toBe(true);
        expect(Object.keys(command?.params ?? {})).toEqual(['x', 'y', 'z', 'max_ms', 'layer', 'dimension']);

        const declaration = toolDeclarations().find((d) => d.name === 'travelTo');
        expect(declaration?.kind).toBe('action');
        expect(declaration?.longRunning).toBe(true);

        const tool = getOpenAITools(toolDeclarations()).find((t) => t.function.name === 'travelTo');
        const props = Object.keys((tool?.function.parameters as any).properties ?? {});
        expect(props).toEqual(['x', 'y', 'z', 'max_ms', 'layer', 'dimension']);
        expect((tool?.function.parameters as any).required).toContain('x');
        expect((tool?.function.parameters as any).required).toContain('z');
        for (const param of props) {
            expect((TOOL_TEXT as any).travelTo?.params?.[param], `travelTo.${param} 缺 TOOL_TEXT 说明`).toBeTruthy();
        }
    });

    it('参数边界与描述自洽（子集）：want 之外的口径不许和回执打架', () => {
        expect(DEFAULT_TRAVEL_MAX_MS).toBe(300_000);
        expect(TRAVEL_MAX_MS_LIMIT).toBe(360_000);
        expect(TRAVEL_TIMEOUT_MIN * 60 * 1000).toBeGreaterThan(TRAVEL_MAX_MS_LIMIT);
        expect(TRAVEL_TIMEOUT_MIN * 60 * 1000).toBeLessThan(ACTION_MAX_MS);
        expect(TRAVEL_ARRIVE_RADIUS).toBeLessThan(TRAVEL_WALK_MAX_BLOCKS);
        const description = PROGRESSION_TOOL_TEXT.travelTo.description;
        expect(description).toContain('长的先走');
        expect(description).toContain('不放宽');
        expect(description).toContain('y=116');
    });
});
