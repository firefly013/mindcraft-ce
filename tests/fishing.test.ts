/**
 * 钓鱼原语（`!fish`）的测试：不连服务器、不烧 token。
 *
 * 钉的是**判据**，不是"跑得通"：
 *   1) **咬钩由浮标信号驱动**（速度向下 / y 掉下静止水位），不是固定计时器——
 *      把咬钩往后挪两拍，收竿也必须跟着挪；
 *   2) **等不到就有界放弃**：不会挂死，也不会把"没咬钩"说成"钓到了"；
 *   3) **背包增量决定回执**：咬钩了但没多出鱼 → 明说"没多出鱼，别当钓到了"；
 *   4) 缺竿/够不到水/竿断了/背包已经够吃 → **早停**并给一条能照抄的下一步；
 *   5) 接线与提示词门禁：`!fish` 是 action + longRunning，参数有 TOOL_TEXT，
 *      `!survivalCheck` 的描述里写着食物两条线（和报告实际打印的措辞一致）。
 */
import { describe, expect, it } from 'vitest';
import {
    bobberDipped,
    FISH_FOOD_ENOUGH,
    FISH_ITEMS,
    FISH_MAX_CASTS,
    FISH_MAX_CASTS_LIMIT,
    FISH_MAX_MS_LIMIT,
    FISH_TIMEOUT_MS,
    fishSkill,
    type FishSample,
} from '../src/body/library/survival.js';
import { parseFishArgs, survivalActionList, SURVIVAL_TOOL_TEXT } from '../src/body/commands/survival.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import { getOpenAITools } from '../src/brain/tools/advertise.js';
import { foodValueOf } from '../src/body/safety/emergency.js';

interface FakeItem {
    name: string;
    count: number;
}

function stack(name: string, count = 1): FakeItem {
    return { name, count };
}

function add(items: FakeItem[], name: string, count: number): void {
    const found = items.find((item) => item.name === name);
    if (found == null) items.push(stack(name, count));
    else found.count += count;
}

/** 飞出去 → 落水稳定 → 咬钩，三段信号（和真机浮标的形状一致）。 */
const FLY_OUT: FishSample = { y: 63.4, vy: -0.4 };
const FLOATING: FishSample = { y: 62.6, vy: 0 };
const DIP: FishSample = { y: 62.45, vy: -0.25 };

/** 稳定 → 咬钩的脚本；`dipIndex` 控制咬钩出现在第几拍（用来证明"收竿跟着信号走"）。 */
function dipScript(dipIndex: number, length = 40): Array<FishSample | null> {
    const script: Array<FishSample | null> = [FLY_OUT, FLOATING, FLOATING];
    for (let i = 3; i < length; i++) script.push(i === dipIndex ? DIP : FLOATING);
    return script;
}

/** 测试用的快节奏参数：窗口短，语义不变。 */
const FAST = { castWaitMs: 400, pollMs: 100, settleMs: 300, appearMs: 500, lootSyncMs: 0 };

function fishHarness(
    options: {
        items?: FakeItem[];
        water?: { x: number; y: number; z: number } | null;
        waterDistance?: number;
        bobberScript?: Array<FishSample | null>;
        durability?: { used: number; max: number } | null;
        equipFails?: boolean;
        /** 收竿时服务端给了什么（默认什么都不给）。 */
        onReel?: (ctx: { items: FakeItem[]; reelIndex: number }) => void;
        interrupt?: boolean;
    } = {},
) {
    const items: FakeItem[] = (options.items ?? []).map((item) => ({ ...item }));
    const script = options.bobberScript ?? [];
    let index = 0;
    let clock = 0;
    let sampleReads = 0;
    const castTimes: number[] = [];
    const reelTimes: number[] = [];
    let bobberAlive = true;

    const bot: any = {
        interrupt_code: options.interrupt === true,
        entity: { position: { x: 0, y: 63, z: 0 }, yaw: 0 },
        inventory: { items: () => items, findInventoryItem: (name: string) => items.find((item) => item.name === name) },
    };

    const currentSample = (): FishSample | null => {
        if (!bobberAlive || script.length === 0) return null;
        sampleReads += 1;
        const sample = script[Math.min(index, script.length - 1)] ?? null;
        // 脚本跑完 = 浮标消失（不会永远"在"）
        if (index >= script.length) return null;
        return sample;
    };

    const deps = {
        position: () => ({ ...bot.entity.position }),
        hasRod: () => items.some((item) => item.name === 'fishing_rod' && item.count > 0),
        rodDurability: () => options.durability ?? { used: null, max: null },
        equip: async () => options.equipFails !== true,
        findWater: () =>
            options.water === undefined || options.water === null
                ? null
                : { position: { ...options.water }, distance: options.waterDistance ?? 4 },
        lookAtWater: async () => {},
        cast: async () => {
            castTimes.push(clock);
            bobberAlive = true;
            index = 0;
        },
        reel: async () => {
            reelTimes.push(clock);
            options.onReel?.({ items, reelIndex: reelTimes.length });
            bobberAlive = false;
        },
        bobber: () => currentSample(),
        fishCount: () => {
            const out: Record<string, number> = {};
            for (const item of items) {
                if ((FISH_ITEMS as readonly string[]).includes(item.name)) out[item.name] = item.count;
            }
            return out;
        },
        inventoryTotal: () => items.reduce((sum, item) => sum + item.count, 0),
        foodCount: () => items.filter((item) => foodValueOf(item.name) != null).reduce((sum, item) => sum + item.count, 0),
        sleep: async (ms: number) => {
            clock += ms;
            index += 1;
        },
        now: () => clock,
    };

    return {
        bot,
        deps,
        items,
        count: (name: string) => items.filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0),
        get casts() {
            return castTimes.length;
        },
        get reels() {
            return reelTimes.length;
        },
        castTimes,
        reelTimes,
        get sampleReads() {
            return sampleReads;
        },
    };
}

const WATER = { x: 3, y: 62, z: 0 };
const ROD = stack('fishing_rod', 1);
const lastLine = (receipt: string): string => receipt.trimEnd().split('\n').at(-1) ?? '';

// ─────────────────────────── 纯判据 ───────────────────────────

describe('咬钩判据（纯函数）', () => {
    it('浮标下坠或速度向下 = 咬钩；静止/上浮不算', () => {
        expect(bobberDipped({ y: 62.6, vy: 0 }, 62.6)).toBe(false);
        expect(bobberDipped({ y: 62.6, vy: 0.3 }, 62.6)).toBe(false);
        expect(bobberDipped({ y: 62.6, vy: -0.2 }, 62.6)).toBe(true);
        expect(bobberDipped({ y: 62.4, vy: 0 }, 62.6)).toBe(true);
        // 读不到就**不判咬钩**（宁可不收，也不误收）
        expect(bobberDipped({ y: Number.NaN, vy: Number.NaN }, 62.6)).toBe(false);
    });

    it('参数归一：越界夹住，缺省用默认值', () => {
        expect(parseFishArgs(undefined, undefined)).toEqual({ maxMs: FISH_TIMEOUT_MS, maxCasts: FISH_MAX_CASTS });
        expect(parseFishArgs(1, 999)).toEqual({ maxMs: 10_000, maxCasts: FISH_MAX_CASTS_LIMIT });
        expect(parseFishArgs(999_999, 0)).toEqual({ maxMs: FISH_MAX_MS_LIMIT, maxCasts: 1 });
    });
});

// ─────────────────────────── 咬钩 → 收竿 ───────────────────────────

describe('fish：信号驱动 + 增量核对', () => {
    it('浮标下沉 → 收竿一次、背包 +1 → 回执报"钓到 1 条"并提醒烤', async () => {
        const h = fishHarness({
            items: [ROD],
            water: WATER,
            bobberScript: dipScript(3),
            onReel: ({ items }) => add(items, 'raw_cod', 1),
        });
        const receipt = await fishSkill(h.bot, 90_000, 1, h.deps, FAST);

        expect(h.casts).toBe(1);
        expect(h.reels).toBe(1);
        expect(receipt).toContain('钓到 1 条（raw_cod x1）');
        expect(receipt).toContain('咬钩');
        expect(receipt).toContain('+1 raw_cod');
        // 生鳕鱼 2 点、熟鳕鱼 5 点：要提醒先烤，并给能照抄的熔炉调用
        expect(receipt).toContain('生鱼先烤再吃');
        expect(receipt).toContain('cooked_cod');
        expect(lastLine(receipt)).toBe(
            '下一步（照做即可）：useBlock(type="furnace", input="1 raw_cod", output="1 cooked_cod")',
        );
    });

    it('**收竿时机由信号决定**：咬钩挪后两拍，收竿也跟着挪后', async () => {
        const early = fishHarness({
            items: [ROD],
            water: WATER,
            bobberScript: dipScript(3),
            onReel: ({ items }) => add(items, 'raw_cod', 1),
        });
        const late = fishHarness({
            items: [ROD],
            water: WATER,
            bobberScript: dipScript(6),
            onReel: ({ items }) => add(items, 'raw_cod', 1),
        });
        await fishSkill(early.bot, 90_000, 1, early.deps, FAST);
        await fishSkill(late.bot, 90_000, 1, late.deps, FAST);

        // 两次都只收一次竿，但收竿时刻跟着咬钩走（不是固定计时器）
        expect(early.reels).toBe(1);
        expect(late.reels).toBe(1);
        expect(late.reelTimes[0]! - late.castTimes[0]!).toBeGreaterThan(
            early.reelTimes[0]! - early.castTimes[0]!,
        );
    });

    it('**永不咬钩 → 有界放弃**：收竿一次但绝不假报钓到', async () => {
        const h = fishHarness({ items: [ROD], water: WATER, bobberScript: dipScript(999) });
        const receipt = await fishSkill(h.bot, 90_000, 1, h.deps, FAST);

        expect(h.casts).toBe(1);
        expect(h.reels).toBe(1); // 等不到就收竿，不挂着
        expect(receipt).toContain('一条都没钓到');
        expect(receipt).toContain('没咬钩');
        expect(receipt).toContain('这一竿没钓到');
        expect(receipt).not.toContain('钓到 1');
        expect(lastLine(receipt)).toBe('下一步（照做即可）：fish(max_ms=90000, max_casts=1)');
    });

    it('咬钩了但背包没多出鱼 → 明说"没多出鱼，别当钓到了"', async () => {
        const h = fishHarness({ items: [ROD], water: WATER, bobberScript: dipScript(3) });
        const receipt = await fishSkill(h.bot, 90_000, 1, h.deps, FAST);

        expect(receipt).toContain('咬钩了但**背包没多出鱼**');
        expect(receipt).toContain('别当钓到了');
        expect(receipt).toContain('一条都没钓到');
        expect(receipt).not.toContain('钓到 1');
    });

    it('**浮标还在下落时不算咬钩**：不能拿飞行中的高度当水位（假咬钩的根因）', async () => {
        // 整段脚本都在往下掉（永远静不下来）：不许判咬钩，更不许假报钓到
        const falling: FishSample = { y: 63.4, vy: -0.4 };
        const h = fishHarness({
            items: [ROD],
            water: WATER,
            bobberScript: Array.from({ length: 40 }, () => falling),
        });
        const receipt = await fishSkill(h.bot, 90_000, 1, h.deps, FAST);

        expect(h.casts).toBe(1);
        expect(receipt).toContain('没咬钩');
        expect(receipt).not.toContain('咬钩了但');
        expect(receipt).not.toContain('钓到 1');
    });

    it('上来的不是鱼（垃圾/宝藏）→ 也说清楚，不冒充鱼', async () => {
        const h = fishHarness({
            items: [ROD],
            water: WATER,
            bobberScript: dipScript(3),
            onReel: ({ items }) => add(items, 'lily_pad', 1),
        });
        const receipt = await fishSkill(h.bot, 90_000, 1, h.deps, FAST);
        expect(receipt).toContain('可能是垃圾/宝藏');
        expect(receipt).not.toContain('钓到 1 条');
    });

    it('多竿累计：两种鱼分别计数，回执给净增量', async () => {
        const h = fishHarness({
            items: [ROD],
            water: WATER,
            bobberScript: dipScript(3),
            onReel: ({ items, reelIndex }) => add(items, reelIndex === 1 ? 'raw_cod' : 'raw_salmon', 1),
        });
        const receipt = await fishSkill(h.bot, 90_000, 2, h.deps, FAST);

        expect(h.casts).toBe(2);
        expect(receipt).toContain('钓到 2 条（raw_cod x1、raw_salmon x1）');
        expect(receipt).toContain('+1 raw_cod');
        expect(receipt).toContain('+1 raw_salmon');
    });
});

// ─────────────────────────── 早停与失败模式 ───────────────────────────

describe('fish：早停与诚实失败', () => {
    it('没有竿 → 一竿都不抛，并说清"要在工作台上做"（不是 craft）', async () => {
        const h = fishHarness({ items: [], water: WATER });
        const receipt = await fishSkill(h.bot, 90_000, 3, h.deps, FAST);

        expect(h.casts).toBe(0);
        expect(receipt).toContain('没有钓鱼竿');
        expect(receipt).toContain('工作台');
        expect(receipt).toContain('3 木棍 + 2 线');
        expect(lastLine(receipt)).toBe(
            '下一步（照做即可）：useBlock(type="crafting_table", input="3 stick, 2 string", output="1 fishing_rod")',
        );
        // 2×2 的 craft 放不下这个配方：不能把模型指到那条死路
        expect(receipt).not.toContain('craft(input=');
    });

    it('水太远 → 早停并给走近坐标', async () => {
        const h = fishHarness({ items: [ROD], water: { x: 80, y: 62, z: 0 }, waterDistance: 80 });
        const receipt = await fishSkill(h.bot, 90_000, 3, h.deps, FAST);

        expect(h.casts).toBe(0);
        expect(receipt).toContain('水太远');
        expect(receipt).toContain('80.0 格');
        expect(lastLine(receipt)).toBe('下一步（照做即可）：goToCoordinates(x=80, y=62, z=0, closeness=3)');
    });

    it('半径内没有水 → 早停并让去找水', async () => {
        const h = fishHarness({ items: [ROD], water: null });
        const receipt = await fishSkill(h.bot, 90_000, 3, h.deps, FAST);

        expect(h.casts).toBe(0);
        expect(receipt).toContain('没扫到水面');
        expect(lastLine(receipt)).toBe('下一步（照做即可）：searchForBlock(type="water", search_range=256)');
    });

    it('竿断了 → 报断竿 + 做新竿（钓到的鱼照算）', async () => {
        const h = fishHarness({
            items: [ROD],
            water: WATER,
            bobberScript: dipScript(3),
            durability: { used: 63, max: 64 },
            onReel: ({ items }) => {
                add(items, 'raw_cod', 1);
                const rod = items.find((item) => item.name === 'fishing_rod');
                if (rod != null) rod.count = 0; // 这一竿之后竿没了
            },
        });
        const receipt = await fishSkill(h.bot, 90_000, 3, h.deps, FAST);

        expect(h.casts).toBe(1);
        expect(receipt).toContain('钓到 1 条');
        expect(receipt).toContain('断了');
        expect(receipt).toContain('快断了'); // 耐久 63/64 → 报告里同时提醒
        expect(lastLine(receipt)).toBe(
            '下一步（照做即可）：useBlock(type="crafting_table", input="3 stick, 2 string", output="1 fishing_rod")',
        );
    });

    it('背包已经够吃（≥4 份）→ 一竿都不抛，说清"不用钓"', async () => {
        const h = fishHarness({ items: [ROD, stack('cooked_beef', FISH_FOOD_ENOUGH)], water: WATER });
        const receipt = await fishSkill(h.bot, 90_000, 3, h.deps, FAST);

        expect(h.casts).toBe(0);
        expect(receipt).toContain('不用钓');
        expect(receipt).toContain(`已经有 ${FISH_FOOD_ENOUGH} 份能吃的`);
        expect(lastLine(receipt)).toBe('下一步（照做即可）：stats(type="inventory")');
    });

    it('时间预算用完 → 收手并说明（不会无限钓）', async () => {
        const h = fishHarness({ items: [ROD], water: WATER, bobberScript: dipScript(999) });
        const receipt = await fishSkill(h.bot, 10_000, 5, h.deps, {
            castWaitMs: 9_000,
            pollMs: 1_000,
            settleMs: 100,
            appearMs: 200,
            lootSyncMs: 0,
        });

        expect(h.casts).toBe(1);
        expect(receipt).toContain('时间预算用完了');
    });

    it('被 Stop 打断 → 立刻收手，不继续抛竿', async () => {
        const h = fishHarness({ items: [ROD], water: WATER, bobberScript: dipScript(3), interrupt: true });
        const receipt = await fishSkill(h.bot, 90_000, 3, h.deps, FAST);
        expect(h.casts).toBe(0);
        expect(receipt).toContain('被 Stop 打断');
    });

    it('装备失败 → 说清"竿没拿到手上"，不空抛', async () => {
        const h = fishHarness({ items: [ROD], water: WATER, equipFails: true });
        const receipt = await fishSkill(h.bot, 90_000, 3, h.deps, FAST);
        expect(h.casts).toBe(0);
        expect(receipt).toContain('没拿到手上');
    });
});

// ─────────────────────────── 接线 / 提示词门禁 ───────────────────────────

describe('接线与提示词', () => {
    it('!fish 注册成 action + longRunning，参数顺序 = perform 位置参数顺序', () => {
        const command = survivalActionList.find((c) => c.name === '!fish');
        expect(command).toBeDefined();
        expect(command?.perform.longRunning).toBe(true);
        expect(Object.keys(command?.params ?? {})).toEqual(['max_ms', 'max_casts']);
        expect(command?.params?.max_ms.optional).toBe(true);
        expect(command?.params?.max_ms.default).toBe(FISH_TIMEOUT_MS);
        expect(command?.params?.max_casts.default).toBe(FISH_MAX_CASTS);

        const declaration = toolDeclarations().find((d) => d.name === 'fish');
        expect(declaration?.kind).toBe('action');
        expect(declaration?.longRunning).toBe(true);
    });

    it('schema 的每个参数都在 TOOL_TEXT 里有说明（check-prompts 的同款不变式）', () => {
        const tool = getOpenAITools(toolDeclarations()).find((t) => t.function.name === 'fish');
        expect(tool).toBeDefined();
        const props = Object.keys((tool?.function.parameters as any).properties ?? {});
        expect(props).toEqual(['max_ms', 'max_casts']);
        for (const param of props) {
            expect((TOOL_TEXT as any).fish?.params?.[param], `fish.${param} 缺 TOOL_TEXT 说明`).toBeTruthy();
        }
    });

    it('描述里写清了判据与诚实口径（别让回执退化成"我抛了竿"）', () => {
        const desc = SURVIVAL_TOOL_TEXT.fish.description;
        expect(desc).toContain('咬钩');
        expect(desc).toContain('没钓到');
        expect(desc).toContain('工作台');
        expect(desc).toContain('早停');
        // 大脑侧那份也要有同样的要点（两边一致）
        expect(String((TOOL_TEXT as any).fish?.description ?? '')).toContain('没钓到就说没钓到');
    });

    it('**!survivalCheck 的描述写着食物两条线**，措辞与报告一致（这条防的是"工具列表和报告各说各话"）', () => {
        const desc = SURVIVAL_TOOL_TEXT.survivalCheck.description;
        expect(desc).toContain('食物告急');
        expect(desc).toContain('先别打');
        expect(desc).toContain('低于回血线 18');
        expect(desc).toContain('存粮只剩');
        expect(desc).toContain('别等饿到 18 以下再找');
        expect(desc).toContain('furnace');
    });
});
