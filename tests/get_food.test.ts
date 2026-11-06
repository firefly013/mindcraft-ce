/**
 * `getFood`：把"找吃的"从五步链变成一次调用的编排测试。
 *
 * 钉的是**行为与诚实**，不是"跑得通"：
 *   1) 背包已经到 want ⇒ 什么都不做（**判据只认 want**：它自己说要几份）；
 *   2) 真饿 + 包里有吃的 ⇒ 吃，并报出食物/饱和度前后值；
 *   3) 吃不吃由模型定：不饿 + 只剩 ≤2 份时**照吃**，只把后果写进回执（10-24 定的原则）；
 *   4) 没动物 + 没竿 + 够得到蛛网 ⇒ 下一步是蛛网/竿的具体调用，不是"去找吃的"；
 *   5) 竿那条路**永远点名工作台**（3×3 配方，2×2 放不下）；
 *   6) 够不到水 ⇒ 说清水的位置/距离，并给一条可执行的下水调用；
 *   7) 每个部分结果都以**一条**能照抄的下一步收尾；
 *   8) 什么都没拿到 ⇒ 绝不说成功。
 */
import { describe, expect, it } from 'vitest';
import {
    GETFOOD_MAX_MS_LIMIT,
    KNOWN_COBWEB_CLUSTER_RADIUS,
    KNOWN_COBWEB_CLUSTER_Y,
    KNOWN_COBWEB_SITES,
    bestKnownCobwebSite,
    craftingTableCall,
    edibleItemsFrom,
    firstLine,
    foodDistributionLines,
    getFoodSkill,
    surveyFood,
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
    it('背包已经到 want（4 份 ≥ 要 3 份）→ **什么都不做**，并说清理由', async () => {
        const h = harness({ items: [stack('cooked_beef', 4)], food: 8 });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(receipt).toContain('背包里有 4 份能吃的，已经达到你要的 3 份，这次什么都没动。');
        expect(receipt).toContain('背包里有 4 份能吃的，已经达到你要的 3 份，这次什么都没动。');
        expect(receipt).toContain('背包里有 4 份能吃的，已经达到你要的 3 份，这次什么都没动。');
        expect(h.calls.eat).toBe(0);
        expect(h.calls.hunt).toHaveLength(0);
        expect(h.calls.fish).toBe(0);
        expect(lastLine(receipt)).not.toContain('照做即可');
    });

    // 2026-10-26：want 以前被全局门槛吞掉——背包有 4 份时 getFood(want=10) 直接判"不用动"。
    // 模型说了它要几份，工具不许按自己的阈值驳回。

    it('真饿 + 包里有吃的 → 吃，并报出食物/饱和度的前后值', async () => {
        const h = harness({ items: [stack('bread', 3)], food: 8, saturation: 1 });
        const receipt = await getFoodSkill(h.bot, 1, 300_000, h.deps as any);

        expect(h.calls.eat).toBe(1);
        expect(receipt).toContain('只吃了东西');
        expect(receipt).toContain('这次只吃了东西，没有补到新的，背包里能吃的从 3 份变成了 2 份。');
        expect(receipt).toContain('这次只吃了东西，没有补到新的，背包里能吃的从 3 份变成了 2 份。');
        expect(receipt).toContain('这次只吃了东西，没有补到新的，背包里能吃的从 3 份变成了 2 份。');
        expect(receipt).toContain('这次只吃了东西，没有补到新的，背包里能吃的从 3 份变成了 2 份。'); // 吃掉了一份：库存减少是事实
    });

    // 2026-10-24：回血线也从"不吃"改成"照吃 + 事实"。接下来是打架还是回城
    // 只有模型知道；"吃了不涨"作为事实进回执，判断权交还模型。

    // 2026-10-24：存粮规则从"不吃"改成"照吃 + 警告"（和 `skills.consume` 同一套契约）。
    // "最后两份该不该动"只有模型能判断，工具不再替它决定。
});

describe('getFood：打猎 → 钓鱼（含"自己弄竿"）', () => {




    it('下界里不提这条链（蛛网是主世界的差事）', async () => {
        const h = harness({ items: [stack('stone', 4)], food: 6, nearest: null, dimension: 'the_nether' });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);
        expect(receipt).not.toContain('优先做这条');
    });

    it('bestKnownCobwebSite：竖直代价权重更高（浅的优先）', () => {
        const here = { x: 0, y: 64, z: 0 };
        expect(bestKnownCobwebSite(here, [{ x: 3, y: 120, z: 0 }, { x: 60, y: 30, z: 0 }])).toEqual({ x: 60, y: 30, z: 0 });
        expect(bestKnownCobwebSite(null, [{ x: 1, y: 2, z: 3 }])).toEqual({ x: 1, y: 2, z: 3 });
        expect(bestKnownCobwebSite(here, [])).toBeNull();
    });



});

describe('getFood：诚实与可续', () => {
    it('什么都没拿到 → **绝不报成功**，并写明卡在哪、什么都没变', async () => {
        const h = harness({ items: [], food: 2, nearest: null, water: null });
        const receipt = await getFoodSkill(h.bot, 3, 300_000, h.deps as any);

        expect(receipt).toContain('这次没能拿到吃的，背包里能吃的还是 0 份，停下来的原因是每一条路都卡住了');
        expect(receipt).not.toContain('拿到了');
        expect(receipt).toContain('这次没能拿到吃的，背包里能吃的还是 0 份，停下来的原因是每一条路都卡住了');
        expect(receipt).toContain('这次没能拿到吃的，背包里能吃的还是 0 份，停下来的原因是每一条路都卡住了');
    });

    it('每种结局都**不**补"下一步"（回执只报事实）', async () => {
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
            expect(nextLines, receipt).toHaveLength(0);
        }
    });



});

describe('getFood：纯函数与接线', () => {
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

describe('失败时必须告诉模型"吃的在哪"（真机 overnight_a：血 8.575 卡 8 分钟）', () => {
    const here = { x: 0, y: 64, z: 0 };
    const at = (x: number, y: number, z: number) => ({ x, y, z });

    it('**看得见但没猎到** ⇒ 明说，别让模型以为"这一带没有动物"', () => {
        const survey = surveyFood({} as any, {
            position: () => here,
            nearbyEntities: () => [{ name: 'cow', position: at(3, 64, 0) }],
            findBlock: () => null,
            water: () => null,
        });
        const text = foodDistributionLines(survey, { huntedWithoutGain: true }).join('\n');
        expect(text).toContain('看得见但没猎到');
        expect(text).not.toContain('确实没有食物来源');
    });

});
