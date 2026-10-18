/**
 * `getFood`：把"找吃的"从五步链变成一次调用的编排测试。
 *
 * 钉的是**行为与诚实**，不是"跑得通"：
 *   1) 背包够吃 ⇒ 什么都不做（want 是下限，不是目标）；
 *   2) 真饿 + 包里有吃的 ⇒ 吃，并报出食物/饱和度前后值；
 *   3) **存粮规则穿过去**：不饿 + 只剩 ≤2 份时不吃（和 consume 同一套阈值，不许打架）；
 *   4) 没动物 + 没竿 + 够得到蛛网 ⇒ 下一步是蛛网/竿的具体调用，不是"去找吃的"；
 *   5) 竿那条路**永远点名工作台**（3×3 配方，2×2 放不下）；
 *   6) 够不到水 ⇒ 说清水的位置/距离，并给一条可执行的下水调用；
 *   7) 每个部分结果都以**一条**能照抄的下一步收尾；
 *   8) 什么都没拿到 ⇒ 绝不说成功。
 */
import { describe, expect, it } from 'vitest';
import {
    FOOD_ACCEPTABLE,
    GETFOOD_MAX_MS_LIMIT,
    KNOWN_COBWEB_CLUSTER_RADIUS,
    KNOWN_COBWEB_CLUSTER_Y,
    KNOWN_COBWEB_SITES,
    bestKnownCobwebSite,
    cookCallFor,
    craftingTableCall,
    edibleItemsFrom,
    firstLine,
    getFoodSkill,
    lastNextCall,
    rodNextCall,
} from '../src/body/library/get_food.js';
import { FOOD_RESERVE_COMFORT, FOOD_RESERVE_LOW, FOOD_REGEN_THRESHOLD } from '../src/body/library/survival.js';
import { parseGetFoodArgs, GETFOOD_TIMEOUT_MIN, survivalActionList, SURVIVAL_TOOL_TEXT } from '../src/body/commands/survival.js';
import { ACTION_MAX_MS } from '../src/brain/action_runner.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import { getOpenAITools } from '../src/brain/tools/advertise.js';

interface FakeItem {
    name: string;
    count: number;
}

const stack = (name: string, count = 1): FakeItem => ({ name, count });
const lastLine = (text: string): string => text.trimEnd().split('\n').at(-1) ?? '';

/** 假身体 + 可控的每一步（默认"什么都拿不到"，测哪个场景就注哪一步）。 */
function harness(
    options: {
        items?: FakeItem[];
        food?: number;
        saturation?: number;
        health?: number;
        /** 半径内最近的实体名（动物/蜘蛛）；null = 这一带什么都没有。 */
        nearest?: string | null;
        blocks?: Record<string, { x: number; y: number; z: number } | null>;
        /** 一次给多个蛛网（用来验证"优先挑浅的"）。 */
        cobwebs?: Array<{ x: number; y: number; z: number }>;
        /** 当前维度（已知蛛网点只在主世界能照抄）。 */
        dimension?: string;
        water?: { x: number; y: number; z: number } | null;
        waterDistance?: number;
        travelOk?: boolean;
    } = {},
) {
    const items: FakeItem[] = (options.items ?? []).map((item) => ({ ...item }));
    let clock = 0;
    const calls = { eat: 0, hunt: [] as string[], fish: 0, mine: 0, craftRod: 0, travel: 0, travelTargets: [] as Array<{ x: number; y: number; z: number }> };

    const bot: any = {
        interrupt_code: false,
        health: options.health ?? 20,
        food: options.food ?? 10,
        foodSaturation: options.saturation ?? 0,
        entity: { position: { x: 0, y: 64, z: 0 } },
        game: { dimension: options.dimension ?? 'overworld' },
        inventory: {
            items: () => items,
            findInventoryItem: (name: string) => items.find((item) => item.name === name && item.count > 0),
        },
    };

    const add = (name: string, count: number): void => {
        const found = items.find((item) => item.name === name);
        if (found == null) items.push(stack(name, count));
        else found.count += count;
    };
    const count = (name: string): number =>
        items.filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);

    const deps = {
        now: () => clock,
        sleep: async (ms: number): Promise<void> => {
            clock += ms;
        },
        position: () => ({ x: 0, y: 64, z: 0 }),
        health: () => bot.health,
        foodState: () => ({ food: bot.food as number, saturation: bot.foodSaturation as number }),
        inventory: () => Object.fromEntries(items.filter((i) => i.count > 0).map((i) => [i.name, i.count])),
        countOf: (_b: any, name: string) => count(name),
        nearestEntity: (_b: any, names: readonly string[]) =>
            options.nearest != null && names.includes(options.nearest) ? options.nearest : null,
        eat: async (_b: any, name: string): Promise<boolean> => {
            calls.eat += 1;
            const found = items.find((item) => item.name === name);
            if (found == null) return false;
            found.count -= 1;
            bot.food = Math.min(20, (bot.food as number) + 5);
            bot.foodSaturation = (bot.foodSaturation as number) + 2;
            return true;
        },
        hunt: async (_b: any, entity: string): Promise<any> => {
            calls.hunt.push(entity);
            return { gained: 0, label: `huntFor ${entity}：这一带没有（被打光了）`, nextCall: `huntFor(entity="${entity}", want=2, max_ms=300000)` };
        },
        fish: async (): Promise<any> => {
            calls.fish += 1;
            return { gained: 0, label: 'fish：一条都没钓到', nextCall: 'fish(max_ms=90000, max_casts=1)' };
        },
        findBlock: (_b: any, block: string): any => options.blocks?.[block] ?? null,
        findCobwebs: options.cobwebs == null ? undefined : (): any[] => options.cobwebs ?? [],
        travel: async (_b: any, x: number, y: number, z: number): Promise<boolean> => {
            calls.travel += 1;
            calls.travelTargets.push({ x, y, z });
            return options.travelOk !== false;
        },
        mine: async (): Promise<boolean> => {
            calls.mine += 1;
            return true;
        },
        craftRod: async (): Promise<boolean> => {
            calls.craftRod += 1;
            return false;
        },
        water: (): any =>
            options.water === undefined || options.water === null
                ? null
                : { position: { ...options.water }, distance: options.waterDistance ?? 5 },
    };

    return { bot, deps, items, add, count, calls };
}

describe('getFood：优先级与"不做多余的事"', () => {
    it('背包已经够吃（≥4 份）→ **什么都不做**，并说清理由', async () => {
        const h = harness({ items: [stack('cooked_beef', FOOD_ACCEPTABLE)], food: 8 });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(receipt).toContain('不用动');
        expect(receipt).toContain(`已经有 ${FOOD_ACCEPTABLE} 份能吃的`);
        expect(h.calls.eat).toBe(0);
        expect(h.calls.hunt).toHaveLength(0);
        expect(h.calls.fish).toBe(0);
        expect(lastLine(receipt)).toBe('下一步（照做即可）：stats(type="inventory")');
    });

    it('真饿 + 包里有吃的 → 吃，并报出食物/饱和度的前后值', async () => {
        const h = harness({ items: [stack('bread', 3)], food: 8, saturation: 1 });
        const receipt = await getFoodSkill(h.bot, 1, 300_000, h.deps as any);

        expect(h.calls.eat).toBe(1);
        expect(receipt).toContain('吃了 bread');
        expect(receipt).toContain('食物 8 → 13');
        expect(receipt).toContain('饱和度 1 → 3');
        expect(receipt).toContain('血 20 → 20');
        expect(receipt).toContain('能吃的 3 → 2'); // 吃掉了一份：库存减少是事实
        expect(receipt).toContain('只吃了东西，没补到新的');
    });

    it('食物 ≥ 回血线 → 先补库存，不白吃', async () => {
        const h = harness({ items: [stack('bread', 3)], food: FOOD_REGEN_THRESHOLD });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(h.calls.eat).toBe(0);
        expect(receipt).toContain(`吃：跳过（食物 ${FOOD_REGEN_THRESHOLD} ≥ 回血线 ${FOOD_REGEN_THRESHOLD}`);
    });

    it('**存粮规则与吃这一步不打架**：不饿（≥14）+ 只剩 ≤2 份 → 不吃，先去补', async () => {
        const h = harness({ items: [stack('cooked_beef', FOOD_RESERVE_LOW)], food: FOOD_RESERVE_COMFORT });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(h.calls.eat).toBe(0);
        expect(receipt).toContain('**先留着**');
        expect(receipt).toContain('存粮规则要求留给低血期');
        // 同一套阈值：把食物降到 <14 就该吃（否则两条规则会振荡）
        const hungry = harness({ items: [stack('cooked_beef', FOOD_RESERVE_LOW)], food: FOOD_RESERVE_COMFORT - 1 });
        await getFoodSkill(hungry.bot, 1, 300_000, hungry.deps as any);
        expect(hungry.calls.eat).toBe(1);
    });
});

describe('getFood：打猎 → 钓鱼（含"自己弄竿"）', () => {
    it('附近有动物 → 先打猎，且用的是动物名', async () => {
        const h = harness({ items: [], nearest: 'chicken', food: 6 });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(h.calls.hunt).toEqual(['chicken']);
        expect(receipt).toContain('打猎：chicken');
    });

    it('没动物、没竿、够得到蛛网 → 下一步是**蛛网/竿的具体调用**，不是"去找吃的"', async () => {
        const h = harness({
            items: [stack('stone', 4)],
            food: 6,
            nearest: null,
            blocks: { cobweb: { x: 30, y: 40, z: 5 } },
            travelOk: false, // 走不过去：如实停在断点上
        });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(receipt).toContain('找线');
        expect(receipt).toContain('蛛网');
        const next = lastLine(receipt);
        expect(next).toBe('下一步（照做即可）：goToCoordinates(x=30, y=40, z=5, closeness=2)');
        expect(next).not.toContain('find food');
    });

    it('**挑最省事的蛛网**：竖直距离优先（少挖深井），不是"水平最近的那个"', async () => {
        // 人在 y=64，两个蛛网**都在下面**：一个浅（y=28，overnight_a 实测那个）但远，
        // 一个深（y=-20，要挖 84 格深井）但水平更近 → 选浅的。
        const h = harness({
            items: [stack('stone', 4)],
            food: 6,
            nearest: null,
            cobwebs: [
                { x: 30, y: -20, z: -10 }, // 水平更近，但深 84 格
                { x: 71, y: 28, z: -76 }, // 远，但只深 36 格
            ],
        });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(h.calls.travelTargets[0]).toEqual({ x: 71, y: 28, z: -76 });
        expect(receipt).toContain('找线');
    });

    it('别的维度/维度未知都不照抄主世界的蛛网点', () => {
        for (const dimension of ['the_nether', 'the_end', null]) {
            const next = rodNextCall({
                hasRod: false,
                string: 0,
                sticks: 0,
                cobweb: null,
                spawner: null,
                water: null,
                here: { x: 0, y: 64, z: 0 },
                dimension,
            });
            expect(next, String(dimension)).toBe('exploreFor(block="cobweb", max_steps=8, step=32)');
            expect(next, String(dimension)).not.toContain('71');
        }
    });

    it('半径内没有蛛网 ⇒ 直接给**已知更浅的那个点**（(71, 28, -76)），不瞎撞', () => {
        const next = rodNextCall({
            hasRod: false,
            string: 0,
            sticks: 0,
            cobweb: null,
            spawner: null,
            water: null,
            here: { x: 0, y: 64, z: 0 },
            dimension: 'overworld',
        });
        expect(next).toBe('travelTo(x=71, y=28, z=-76)'); // **从侧面进**：travelTo 会自己绕开水层
        expect(next).not.toContain('exploreFor');
        expect(next).not.toContain('goToCoordinates'); // 那个只会在水边干等
        expect(KNOWN_COBWEB_SITES[0]).toEqual({ x: 71, y: 28, z: -76 });
        expect(KNOWN_COBWEB_CLUSTER_RADIUS).toBe(40);
        expect(KNOWN_COBWEB_CLUSTER_Y).toEqual([24, 30]);
    });

    it('主世界缺线 ⇒ 回执把这条链**提到优先**，并给"从侧面进"的具体调用', async () => {
        const h = harness({ items: [stack('stone', 4)], food: 6, nearest: null, dimension: 'overworld' });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(receipt).toContain('优先做这条');
        expect(receipt).toContain('蛛网');
        expect(receipt).toContain('弓');
        expect(receipt).toContain('从侧面进');
        expect(receipt).toContain('travelTo(x=71, y=28, z=-76)');
        expect(receipt).toContain('y=24~30');
        expect(receipt).not.toContain('goToCoordinates(x=71');
    });

    it('下界里不提这条链（蛛网是主世界的差事）', async () => {
        const h = harness({ items: [stack('stone', 4)], food: 6, nearest: null, dimension: 'the_nether' });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);
        expect(receipt).not.toContain('优先做这条');
    });

    it('别的维度不照抄主世界的蛛网点（坐标是主世界的）', () => {
        const next = rodNextCall({
            hasRod: false,
            string: 0,
            sticks: 0,
            cobweb: null,
            spawner: null,
            water: null,
            here: { x: 0, y: 64, z: 0 },
            dimension: 'the_nether',
        });
        expect(next).toBe('exploreFor(block="cobweb", max_steps=8, step=32)');
        expect(next).not.toContain('71');
    });

    it('bestKnownCobwebSite：竖直代价权重更高（浅的优先）', () => {
        const here = { x: 0, y: 64, z: 0 };
        expect(bestKnownCobwebSite(here, [{ x: 3, y: 120, z: 0 }, { x: 60, y: 30, z: 0 }])).toEqual({ x: 60, y: 30, z: 0 });
        expect(bestKnownCobwebSite(null, [{ x: 1, y: 2, z: 3 }])).toEqual({ x: 1, y: 2, z: 3 });
        expect(bestKnownCobwebSite(here, [])).toBeNull();
    });

    it('**竿这条路永远点名工作台**（3 木棍 + 2 线，2×2 放不下）', async () => {        const h = harness({ items: [stack('string', 2), stack('stick', 3)], food: 6, nearest: null });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        // 注入的 craftRod 故意失败（模拟"附近没有工作台"）
        expect(h.calls.craftRod).toBe(1);
        expect(receipt).toContain('做竿：**没成**');
        expect(lastLine(receipt)).toBe(
            '下一步（照做即可）：useBlock(type="crafting_table", input="3 stick, 2 string", output="1 fishing_rod")',
        );
        expect(receipt).toContain('crafting_table');
    });

    it('有竿但够不到水 → 说清水的位置与距离，下一步是走过去/找水', async () => {
        const far = harness({
            items: [stack('fishing_rod', 1)],
            food: 6,
            nearest: null,
            water: { x: 80, y: 62, z: 0 },
            waterDistance: 80,
        });
        const farReceipt = await getFoodSkill(far.bot, 3, 300_000, far.deps as any);
        expect(farReceipt).toContain('最近的水在 (80, 62, 0)');
        expect(farReceipt).toContain('80.0 格');
        expect(lastLine(farReceipt)).toBe('下一步（照做即可）：goToCoordinates(x=80, y=62, z=0, closeness=3)');

        const none = harness({ items: [stack('fishing_rod', 1)], food: 6, nearest: null, water: null });
        const noneReceipt = await getFoodSkill(none.bot, 3, 300_000, none.deps as any);
        expect(noneReceipt).toContain('没扫到水面');
        expect(lastLine(noneReceipt)).toBe('下一步（照做即可）：searchForBlock(type="water", search_range=256)');
    });

    it('有竿 + 水在抛竿距离内 → 真的去钓（并报净增量）', async () => {
        const h = harness({ items: [stack('fishing_rod', 1)], food: 6, nearest: null, water: { x: 3, y: 62, z: 0 }, waterDistance: 3 });
        h.deps.fish = async (): Promise<any> => {
            h.calls.fish += 1;
            h.add('raw_cod', 1);
            return { gained: 1, label: 'fish：钓到 1 条（raw_cod x1）', nextCall: 'useBlock(type="furnace", input="1 raw_cod", output="1 cooked_cod")' };
        };
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(h.calls.fish).toBe(1);
        expect(receipt).toContain('拿到了 1 份能吃的');
        expect(receipt).toContain('钓鱼：fish：钓到 1 条');
        // 拿到生鱼 → 提醒先烤（不是"接着找"）
        expect(lastLine(receipt)).toBe('下一步（照做即可）：useBlock(type="furnace", input="1 raw_cod", output="1 cooked_cod")');
    });
});

describe('getFood：诚实与可续', () => {
    it('什么都没拿到 → **绝不报成功**，并写明卡在哪、什么都没变', async () => {
        const h = harness({ items: [], food: 2, nearest: null, water: null });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(receipt).toContain('**没拿到吃的**');
        expect(receipt).toContain('什么都没变');
        expect(receipt).not.toContain('拿到了');
        expect(receipt).toContain('能吃的 0 → 0');
        expect(receipt).toContain('停止原因');
    });

    it('每个部分结果都以**一条**能照抄的下一步收尾', async () => {
        const scenarios = [
            harness({ items: [stack('cooked_beef', 5)], food: 20 }),
            harness({ items: [stack('bread', 2)], food: 6 }),
            harness({ items: [], food: 2, nearest: 'cow' }),
            harness({ items: [stack('fishing_rod', 1)], food: 2, nearest: null, water: null }),
            harness({ items: [stack('string', 2), stack('stick', 3)], food: 2, nearest: null }),
            harness({ items: [], food: 2, nearest: null, water: null }),
        ];
        for (const h of scenarios) {
            const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);
            const nextLines = receipt.split('\n').filter((line) => line.startsWith('下一步（照做即可）：'));
            expect(nextLines, receipt).toHaveLength(1);
            expect(nextLines[0]?.replace('下一步（照做即可）：', '').trim().length, receipt).toBeGreaterThan(3);
        }
    });

    it('预算不够时不硬开始，说清"跳过（剩余预算不足）"', async () => {
        const h = harness({ items: [], food: 2, nearest: 'cow' });
        let clock = 0;
        h.deps.now = () => clock;
        // 12 秒预算：打猎那步（至少 15 秒）就不该开始
        h.deps.sleep = async (ms: number) => {
            clock += ms;
        };
        const receipt = await getFoodSkill(h.bot, 3, 12_000, h.deps as any);

        expect(h.calls.hunt).toHaveLength(0);
        expect(receipt).toContain('跳过（剩余预算不足');
        expect(lastLine(receipt).startsWith('下一步（照做即可）：')).toBe(true);
    });

    it('长期方案：有种子就说清"生长 20~40 分钟、别站着等"，并给工作台上的锄头调用', async () => {
        const h = harness({ items: [stack('wheat_seeds', 6), stack('stick', 2), stack('oak_planks', 2)], food: 6, nearest: null });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(receipt).toContain('长期方案');
        expect(receipt).toContain('20~40 分钟');
        expect(receipt).toContain('别在危机里站着等');
        expect(receipt).toContain('useBlock(type="crafting_table", input="2 oak_planks, 2 stick", output="1 wooden_hoe")');
    });

    it('最后手段：只有腐肉时说清"会附带饥饿效果"', async () => {
        const h = harness({ items: [stack('rotten_flesh', 2)], food: 2, nearest: null, water: null, blocks: {} });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        // 真饿（food 2 < 14）→ 会真的吃掉腐肉（走 consume）
        expect(h.calls.eat).toBe(1);
        expect(receipt).toContain('吃了 rotten_flesh');
    });
});

describe('getFood：纯函数与接线', () => {
    it('rodNextCall：永远是"接着做"的那一步，且竿点名工作台', () => {
        const water = { position: { x: 10, y: 62, z: 4 }, distance: 11 };
        expect(rodNextCall({ hasRod: true, string: 0, sticks: 0, cobweb: null, spawner: null, water })).toBe(
            'goToCoordinates(x=10, y=62, z=4, closeness=3)',
        );
        expect(rodNextCall({ hasRod: true, string: 0, sticks: 0, cobweb: null, spawner: null, water: null })).toBe(
            'searchForBlock(type="water", search_range=256)',
        );
        expect(rodNextCall({ hasRod: false, string: 0, sticks: 0, cobweb: null, spawner: 'spider', water })).toBe(
            'huntFor(entity="spider", want=2, max_ms=60000)',
        );
        expect(
            rodNextCall({ hasRod: false, string: 0, sticks: 0, cobweb: { x: 30, y: 40, z: 5 }, spawner: null, water }),
        ).toBe('goToCoordinates(x=30, y=40, z=5, closeness=2)');
        expect(rodNextCall({ hasRod: false, string: 0, sticks: 0, cobweb: null, spawner: null, water })).toBe(
            'exploreFor(block="cobweb", max_steps=8, step=32)',
        );
        expect(rodNextCall({ hasRod: false, string: 2, sticks: 0, cobweb: null, spawner: null, water })).toContain('stick');
        expect(rodNextCall({ hasRod: false, string: 2, sticks: 3, cobweb: null, spawner: null, water })).toBe(
            'useBlock(type="crafting_table", input="3 stick, 2 string", output="1 fishing_rod")',
        );
    });

    it('子回执取"接着做"：取最后一条下一步；摘要有兜底', () => {
        expect(lastNextCall('a\n下一步（照做即可）：X\nb\n下一步（照做即可）：Y')).toBe('Y');
        expect(lastNextCall('没有下一步')).toBeNull();
        expect(lastNextCall('下一步（照做即可）：')).toBeNull();
        expect(firstLine('\n\nhuntFor cow：…\n后面')).toBe('huntFor cow：…');
        expect(firstLine('')).toBe('');
    });

    it('cookCallFor / craftingTableCall / edibleItemsFrom 是纯函数', () => {
        expect(cookCallFor('raw_cod', 2)).toBe('useBlock(type="furnace", input="2 raw_cod", output="2 cooked_cod")');
        expect(cookCallFor('bread', 1)).toBeNull();
        expect(craftingTableCall('3 stick, 2 string', '1 fishing_rod')).toContain('crafting_table');
        expect(edibleItemsFrom({ bread: 2, stone: 64, wheat_seeds: 3, cooked_beef: 1 })).toEqual([
            { name: 'bread', count: 2 },
            { name: 'cooked_beef', count: 1 },
        ]);
    });

    it('参数归一：want/max_ms 夹住，默认值正确', () => {
        const defaults = parseGetFoodArgs(undefined, undefined);
        expect(defaults.want).toBe(3);
        expect(parseGetFoodArgs(999, 1)).toEqual({ want: 32, maxMs: 10_000 });
        expect(parseGetFoodArgs(0, 9_999_999).maxMs).toBe(GETFOOD_MAX_MS_LIMIT);
    });

    it('接线：!getFood 是 action + longRunning，参数有 TOOL_TEXT 说明', () => {
        const command = survivalActionList.find((c) => c.name === '!getFood');
        expect(command).toBeDefined();
        expect(command?.perform.longRunning).toBe(true);
        expect(Object.keys(command?.params ?? {})).toEqual(['want', 'max_ms']);
        const declaration = toolDeclarations().find((d) => d.name === 'getFood');
        expect(declaration?.kind).toBe('action');
        expect(declaration?.longRunning).toBe(true);

        const tool = getOpenAITools(toolDeclarations()).find((t) => t.function.name === 'getFood');
        const props = Object.keys((tool?.function.parameters as any).properties ?? {});
        expect(props).toEqual(['want', 'max_ms']);
        for (const param of props) {
            expect((TOOL_TEXT as any).getFood?.params?.[param], `getFood.${param} 缺 TOOL_TEXT 说明`).toBeTruthy();
        }
        const desc = SURVIVAL_TOOL_TEXT.getFood.description;
        expect(desc).toContain('存粮规则');
        expect(desc).toContain('工作台');
        expect(desc).toContain('背包增量是唯一证据');
    });

    it('内部预算 < 命令超时 < 保险丝（不许把链路顺序搞反）', () => {
        // 内部预算上限 6 分钟 → 命令 7 分钟 → 脑侧保险丝 8.5 分钟（action_runner.ACTION_MAX_MS）。
        expect(GETFOOD_MAX_MS_LIMIT).toBeLessThan(GETFOOD_TIMEOUT_MIN * 60 * 1000);
        expect(GETFOOD_TIMEOUT_MIN * 60 * 1000).toBeLessThan(ACTION_MAX_MS);
    });
});
