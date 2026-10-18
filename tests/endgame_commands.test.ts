/**
 * 末地命令接线层的测试（不连 MC 服务端、不烧 token）。
 *
 * 这里钉三件事：
 * 1) **接线正确**：registry 里能查到 9 条命令，kind 与超时标记对得上；
 * 2) **门禁安全**：命令全部无参数——`scripts/check-prompts.ts` 只扫
 *    actions/queries/interact，新文件里带参数会被判 SCHEMA PARAM WITHOUT PROMPT TEXT；
 * 3) **命令真的干活**：用假 agent（actions.runAction 立即执行）跑一遍，核对它写进
 *    bot.output 的回执——模型的工具回执就是从 bot.output 来的。
 */
import { describe, expect, it } from 'vitest';
import { findCommand, toolDeclarations, toolNames } from '../src/body/commands/registry.js';
import { ENDGAME_TOOL_TEXT, endgameActionList, endgameQueryList } from '../src/body/commands/endgame.js';
import { choosePotionToDrink, type EffectInfo, type PotionStock } from '../src/body/library/endgame.js';
import { executeToolCall } from '../src/body/commands/execute.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import {
    countEyesOfEnder,
    crystalToolKit,
    drinkPotionsByPriority,
    throwHeldSkill,
} from '../src/body/library/endgame_routine.js';

const ENDGAME_TOOLS = [
    'endFightStatus',
    'enterEnd',
    'clearEndCrystals',
    'bedBombDragon',
    'dodgeDragonBreath',
    'drinkPotion',
    'drinkMilk',
    'recoverAfterDeath',
    'throwHeld',
    'reviveDragon',
] as const;

function stack(name: string, count = 1, extra: Record<string, any> = {}) {
    return { name, count, ...extra };
}

/** 喝药/吃东西要真的从背包里扣掉（`drinkPotionByKind` 会核对数量，假 bot 不扣等于永远喝不成）。 */
function consumeOne(items: any[], held: any): void {
    if (held == null) return;
    const index = items.indexOf(held);
    if (index < 0) return;
    const item = items[index];
    if (typeof item.count === 'number' && item.count > 1) item.count -= 1;
    else items.splice(index, 1);
    // 同一份栈：**只扣一次**（held 往往就是 items 里那个对象）。
    if (item !== held && typeof held.count === 'number' && held.count > 1) held.count -= 1;
}

function makeFakeBot(options: {
    dimension?: string;
    stacks?: any[];
    items?: any[];
    effects?: any;
    entities?: Record<string, any>;
    heldItem?: any;
    health?: number;
    onGround?: boolean;
    velocityY?: number;
} = {}) {
    const p = { x: 0, y: 64, z: 0 };
    const stacks = options.stacks ?? [];
    const items = options.items ?? stacks;
    const calls: any[] = [];
    const bot: any = {
        game: { dimension: options.dimension ?? 'the_end' },
        entity: {
            position: {
                x: p.x,
                y: p.y,
                z: p.z,
                offset: (dx: number, dy: number, dz: number) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz }),
            },
            effects: options.effects ?? {},
            velocity: { x: 0, y: options.velocityY ?? 0, z: 0 },
            onGround: options.onGround ?? true,
        },
        entities: options.entities ?? {},
        registry: { effects: {} },
        health: options.health ?? 20,
        output: '',
        heldItem: options.heldItem,
        inventory: { slots: stacks, items: () => items },
        calls,
        lookAt: () => {
            calls.push({ fn: 'lookAt' });
            return Promise.resolve();
        },
        activateItem: () => {
            calls.push({ fn: 'activateItem' });
            if (bot.heldItem != null) bot.heldItem = { ...bot.heldItem, count: bot.heldItem.count - 1 };
            return Promise.resolve();
        },
        deactivateItem: () => {
            calls.push({ fn: 'deactivateItem' });
            return Promise.resolve();
        },
        equip: (item: any, slot: string) => {
            calls.push({ fn: 'equip', item, slot });
            bot.heldItem = item;
            return Promise.resolve();
        },
        consume: () => {
            calls.push({ fn: 'consume' });
            consumeOne(items, bot.heldItem);
            return Promise.resolve();
        },
    };
    return bot;
}

/** 假 agent：`actions.runAction` 立刻把动作跑完，并回一个正常的 ActionResult。 */
function makeFakeAgent(bot: any, runActionResult: any = { message: 'ACTION-DONE', interrupted: false, timedout: false }) {
    return {
        bot,
        memory_bank: { recallPlace: () => [10, 64, 10] as [number, number, number] },
        actions: {
            runAction: async (label: string, fn: () => Promise<void>) => {
                await fn();
                return runActionResult;
            },
        },
    };
}

describe('接线：registry 里的 9 条末地命令', () => {
    it('全部注册进来了，名字与顺序稳定', () => {
        const names = toolNames();
        for (const tool of ENDGAME_TOOLS) expect(names).toContain(tool);
        expect(endgameQueryList.map((c) => c.name.replace('!', ''))).toEqual(['endFightStatus']);
        expect(endgameActionList.map((c) => c.name.replace('!', ''))).toEqual(ENDGAME_TOOLS.slice(1));
    });

    it('kind 对：体检是 query（不占身体通道），其余 8 条是 action', () => {
        const declarations = toolDeclarations();
        for (const tool of ENDGAME_TOOLS) {
            const declaration = declarations.find((d) => d.name === tool);
            expect(declaration, `${tool} 没在声明里`).toBeDefined();
            expect(declaration?.kind).toBe(tool === 'endFightStatus' ? 'query' : 'action');
            expect(declaration?.longRunning).toBe(tool === 'endFightStatus' ? undefined : true);
        }
    });

    it('findCommand 带不带 ! 都认', () => {
        expect(findCommand('endFightStatus')?.name).toBe('!endFightStatus');
        expect(findCommand('!drinkPotion')?.name).toBe('!drinkPotion');
        expect(findCommand('notAThing')).toBeUndefined();
    });

    it('工具调用的 `spots` 参数真的传到了 reviveDragon（按 params 顺序展开成位置参数）', async () => {
        // 用"坏格式"当探针：只有参数真的传进去了，回执才会说"spots 参数没看懂"。
        // 动作类工具的回执走 `bot.output`（skills.log），返回值是 runAction 的 message。
        const bot = makeFakeBot({ stacks: [stack('end_crystal', 4)] });
        const agent = makeFakeAgent(bot);
        await executeToolCall(agent, 'reviveDragon', { spots: '3,63,0;哎呀' });
        expect(bot.output).toContain('spots 参数没看懂');

        bot.output = '';
        await executeToolCall(agent, 'reviveDragon', {});
        expect(bot.output).not.toContain('spots 参数没看懂');
    });

    it('**每个参数都有提示词文案**（否则 check-prompts 会报 SCHEMA PARAM WITHOUT PROMPT TEXT）', () => {
        // 末地工具默认无参数；`reviveDragon(spots)` 是唯一例外（人能直接指定四个格子）。
        // 真正的不变式不是"没有参数"，而是"**schema 里有的参数，TOOL_TEXT 里必须有说明**"
        // —— 这正是 `npm run check:prompts` 第 1b 轮在查的东西。
        for (const command of [...endgameQueryList, ...endgameActionList]) {
            const params = Object.keys(command.params ?? {});
            if (command.name !== '!reviveDragon') {
                expect(params, `${command.name} 不该有参数`).toEqual([]);
            }
            for (const param of params) {
                const tool = command.name.replace(/^!/, '');
                expect((TOOL_TEXT as any)[tool]?.params?.[param], `${tool}.${param} 缺提示词文案`).toBeTruthy();
            }
        }
        const declarations = toolDeclarations().filter((d) => (ENDGAME_TOOLS as readonly string[]).includes(d.name));
        for (const declaration of declarations) {
            for (const param of Object.keys(declaration.params ?? {})) {
                expect((TOOL_TEXT as any)[declaration.name]?.params?.[param], `${declaration.name}.${param} 缺提示词文案`).toBeTruthy();
            }
        }
        // spots 必须写进 schema，否则模型没法显式指定格子
        const revive = declarations.find((d) => d.name === 'reviveDragon');
        expect(Object.keys(revive?.params ?? {})).toEqual(['spots']);
    });

    it('描述写得够长（它就是模型看到的说明书）并且都提到了关键风险', () => {
        expect(Object.keys(ENDGAME_TOOL_TEXT).sort()).toEqual([...ENDGAME_TOOLS].sort());
        for (const tool of ENDGAME_TOOLS) {
            expect(ENDGAME_TOOL_TEXT[tool].description.length).toBeGreaterThan(80);
        }
        expect(ENDGAME_TOOL_TEXT.bedBombDragon.description).toContain('sleep_in_bed');
        expect(ENDGAME_TOOL_TEXT.clearEndCrystals.description).toContain('12 格');
        expect(ENDGAME_TOOL_TEXT.drinkPotion.description).toContain('缓降');
        expect(ENDGAME_TOOL_TEXT.dodgeDragonBreath.description).toContain('20 格');
        expect(ENDGAME_TOOL_TEXT.recoverAfterDeath.description).toContain('5 分钟');
        expect(ENDGAME_TOOL_TEXT.reviveDragon.description).toContain('end_crystal');
    });
});

describe('命令执行（假 agent）', () => {
    it('endFightStatus 直接返回一份体检报告', () => {
        const bot = makeFakeBot({ stacks: [stack('white_bed', 4), stack('obsidian', 64)] });
        const text = findCommand('endFightStatus')?.perform(makeFakeAgent(bot)) as string;
        expect(text).toContain('末地通关');
        expect(text).toContain('现状');
    });

    it('drinkMilk 会把牛奶喝掉并写回执；没有牛奶也如实说', async () => {
        const withMilk = makeFakeBot({ items: [stack('milk_bucket', 1)] });
        const agent = makeFakeAgent(withMilk);
        await findCommand('drinkMilk')?.perform(agent);
        expect(withMilk.calls.map((c: any) => c.fn)).toEqual(['equip', 'consume']);
        expect(withMilk.output).toContain('喝下牛奶');

        const without = makeFakeBot({ items: [] });
        await findCommand('drinkMilk')?.perform(makeFakeAgent(without));
        expect(without.output).toContain('没有喝到牛奶');
    });

    it('throwHeld：手里没东西时给明确指引，不许假装扔了', async () => {
        const bot = makeFakeBot({});
        await findCommand('throwHeld')?.perform(makeFakeAgent(bot));
        expect(bot.output).toContain('手上是空的');
        expect(bot.output).toContain('equip');
    });

    it('bedBombDragon 在非末地直接拒绝（不做任何危险动作）', async () => {
        const bot = makeFakeBot({ dimension: 'overworld' });
        await findCommand('bedBombDragon')?.perform(makeFakeAgent(bot));
        expect(bot.output).toContain('不在末地');
        expect(bot.calls).toHaveLength(0);
    });

    it('recoverAfterDeath 读到记录点就给出回收方案', async () => {
        const bot = makeFakeBot({ dimension: 'overworld' });
        await findCommand('recoverAfterDeath')?.perform(makeFakeAgent(bot));
        expect(bot.output).toContain('死亡回收');
        expect(bot.output).toContain('10,64,10');
    });

    it('超时回执说清"超时 ≠ 没做成"，被中断则安静返回', async () => {
        const bot = makeFakeBot({});
        const timedOut = makeFakeAgent(bot, { message: null, interrupted: false, timedout: true });
        const receipt = (await findCommand('!drinkPotion')?.perform(timedOut)) as string;
        expect(receipt).toContain('超时');

        const interrupted = makeFakeAgent(bot, { message: null, interrupted: true, timedout: false });
        // interrupted 且没超时 = 无需回执（模型自己知道它在干嘛）
        expect(await findCommand('!drinkPotion')?.perform(interrupted)).toBeUndefined();
    });

    it('每个 action 都走身体通道（runAction 的参数带 action: 前缀和超时）', async () => {
        const bot = makeFakeBot({});
        const seen: any[] = [];
        const agent = {
            bot,
            memory_bank: { recallPlace: () => undefined },
            actions: {
                runAction: (label: string, fn: () => Promise<void>, opts: any) => {
                    seen.push({ label, opts });
                    return fn().then(() => ({ message: 'ok', interrupted: false, timedout: false }));
                },
            },
        };
        for (const command of endgameActionList) {
            await command.perform(agent);
        }
        expect(seen).toHaveLength(endgameActionList.length);
        for (const entry of seen) {
            expect(String(entry.label).startsWith('action:')).toBe(true);
            expect(entry.opts.timeout).toBeGreaterThan(0);
        }
    });
});

describe('choosePotionToDrink（末地喝药优先级，纯函数）', () => {
    const emptyStock: PotionStock = {
        slow_falling: 0,
        resistance: 0,
        regeneration: 0,
        healing: 0,
        strength: 0,
        fire_resistance: 0,
        swiftness: 0,
        other: 0,
        milk: 0,
    };
    const stock = (overrides: Partial<PotionStock>): PotionStock => ({ ...emptyStock, ...overrides });
    const slowFalling: EffectInfo[] = [{ name: 'slow_falling', seconds: 120, amplifier: 0 }];

    it('在末地没缓降 Buff → 先喝缓降（P0，防摔死）', () => {
        const decision = choosePotionToDrink({ stock: stock({ slow_falling: 1, resistance: 1 }), health: 20, inEnd: true });
        expect(decision.kind).toBe('slow_falling');
        expect(decision.reason).toContain('几十格高空');
    });

    it('缓降只剩 10 秒 → 续上；还剩 120 秒 → 不动它', () => {
        expect(choosePotionToDrink({ stock: stock({ slow_falling: 1 }), effects: [{ name: 'slow_falling', seconds: 10, amplifier: 0 }], health: 20, inEnd: true }).kind).toBe('slow_falling');
        const fresh = choosePotionToDrink({ stock: stock({ slow_falling: 1, resistance: 1 }), effects: slowFalling, health: 20, inEnd: true });
        expect(fresh.kind).toBe('resistance');
    });

    it('不在末地也不在空中 → 不会乱喝缓降', () => {
        const decision = choosePotionToDrink({ stock: stock({ slow_falling: 1 }), health: 20, inEnd: false });
        expect(decision.kind).toBeNull();
        expect(decision.reason).toContain('不需要喝药');
    });

    it('血量 ≤10 → 再生优先，其次治疗', () => {
        expect(choosePotionToDrink({ stock: stock({ regeneration: 1, healing: 1 }), health: 8, inEnd: true }).kind).toBe('regeneration');
        expect(choosePotionToDrink({ stock: stock({ healing: 1 }), health: 8, inEnd: true }).kind).toBe('healing');
    });

    it('在末地没抗性 → 喝抗性；有抗性且血够 → 不喝，并列出背包库存', () => {
        expect(choosePotionToDrink({ stock: stock({ resistance: 1 }), effects: slowFalling, health: 20, inEnd: true }).kind).toBe('resistance');
        const decision = choosePotionToDrink({
            stock: stock({ resistance: 1, strength: 2 }),
            effects: [...slowFalling, { name: 'resistance', seconds: 200, amplifier: 0 }],
            health: 20,
            inEnd: true,
        });
        expect(decision.kind).toBeNull();
        expect(decision.reason).toContain('resistance×1');
        expect(decision.reason).toContain('strength×2');
    });

    it('空中也算坠落风险（哪怕不在末地）', () => {
        const decision = choosePotionToDrink({ stock: stock({ slow_falling: 1 }), health: 20, inEnd: false, airborne: true });
        expect(decision.kind).toBe('slow_falling');
        expect(decision.reason).toContain('空中');
    });
});

describe('routine 里的几个计数器/技能', () => {
    it('countEyesOfEnder / crystalToolKit 认得末影之眼、弓、箭、镐、TNT', () => {
        const bot = makeFakeBot({
            stacks: [stack('ender_eye', 12), stack('bow', 1), stack('arrow', 32), stack('iron_pickaxe', 1), stack('tnt', 2), stack('bedrock', 64)],
        });
        expect(countEyesOfEnder(bot)).toBe(12);
        const kit = crystalToolKit(bot);
        expect(kit.bow).toBe('bow');
        expect(kit.arrows).toBe(32);
        expect(kit.pickaxe).toBe(true);
        expect(kit.tnt).toBe(2);
        expect(crystalToolKit(makeFakeBot({ stacks: [stack('stone', 1)] }))).toEqual({ bow: null, arrows: 0, pickaxe: false, tnt: 0 });
    });

    it('drinkPotionsByPriority 在末地会真的把缓降 equip 到手上喝掉', async () => {
        const potion = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ dimension: 'the_end', items: [potion], health: 20, onGround: true });
        const receipt = await drinkPotionsByPriority(bot);
        expect(receipt).toContain('喝了 slow_falling');
        expect(bot.calls.map((c: any) => c.fn)).toEqual(['equip', 'consume']);
    });

    it('背包里想喝的药没有 → 明说没有，不静默成功', async () => {
        const bot = makeFakeBot({ dimension: 'the_end', items: [], health: 20 });
        const receipt = await drinkPotionsByPriority(bot);
        expect(receipt).toContain('不需要喝药');
        expect(bot.calls).toHaveLength(0);
    });

    it('throwHeldSkill：下坠时会把珍珠往脚下扔（瞄准点低于脚下）', async () => {
        const bot = makeFakeBot({
            heldItem: stack('ender_pearl', 2),
            onGround: false,
            velocityY: -1.5,
        });
        const receipt = await throwHeldSkill(bot);
        expect(receipt).toContain('珍珠');
        expect(bot.calls.map((c: any) => c.fn)).toContain('activateItem');
        expect(bot.heldItem.count).toBe(1);
    });

    it('throwHeldSkill：手持末影之眼时给出"跟着眼睛走"的下一步', async () => {
        const bot = makeFakeBot({ heldItem: stack('ender_eye', 8) });
        const receipt = await throwHeldSkill(bot);
        expect(receipt).toContain('末影之眼');
        expect(receipt).toContain('20%');
    });

    it('throwHeldSkill：数量没变 = 没扔成，如实报出来', async () => {
        const bot = makeFakeBot({ heldItem: stack('ender_pearl', 2) });
        bot.activateItem = () => {
            bot.calls.push({ fn: 'activateItem' });
        };
        const receipt = await throwHeldSkill(bot);
        expect(receipt).toContain('手里数量没变');
    });
});