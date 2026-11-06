/**
 * 末地命令接线层的测试（不连 MC 服务端、不烧 token）。
 *
 * 这里钉三件事：
 * 1) **接线正确**：registry 里能查到 10 条命令，kind 与超时标记对得上；
 * 2) **参数接线**：`drinkPotion(potion)` / `reviveDragon(spots)` 这类参数必须
 *    真的从工具调用传进实现（参数名要对齐 schema 与提示词）；
 * 3) **命令真的干活**：用假 agent（actions.runAction 立即执行）跑一遍，核对它写进
 *    bot.output 的回执——模型的工具结果就是从 bot.output 来的。
 */
import { describe, expect, it } from 'vitest';
import { findCommand, toolDeclarations, toolNames } from '../src/body/commands/registry.js';
import { ENDGAME_TOOL_TEXT, endgameActionList, endgameQueryList } from '../src/body/commands/endgame.js';
import { executeToolCall } from '../src/body/commands/execute.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import {
    countEyesOfEnder,
    crystalToolKit,
    throwHeldSkill,
} from '../src/body/library/endgame_routine.js';

const ENDGAME_TOOLS = [
    'endFightStatus',
    'enterEnd',
    'clearEndCrystals',
    'bedBombDragon',
    'dodgeDragonBreath',
    'drinkPotion',
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

describe('接线：registry 里的 10 条末地命令', () => {
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
        // 真正的不变式不是"没有参数"，而是"**schema 里有的参数，TOOL_TEXT 里必须有说明**"
        // —— 这正是 `npm run check:prompts` 第 1b 轮在查的东西。
        // 现在带参数的末地工具：drinkPotion(potion)（指定药水 id）、reviveDragon(spots)。
        const parameterized = new Set(['!drinkPotion', '!reviveDragon']);
        for (const command of [...endgameQueryList, ...endgameActionList]) {
            const params = Object.keys(command.params ?? {});
            if (!parameterized.has(command.name)) {
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
        // 参数必须写进 schema，否则模型没法显式指定
        const revive = declarations.find((d) => d.name === 'reviveDragon');
        expect(Object.keys(revive?.params ?? {})).toEqual(['spots']);
        const drink = declarations.find((d) => d.name === 'drinkPotion');
        expect(Object.keys(drink?.params ?? {})).toEqual(['potion']);
        expect(drink?.params?.potion?.optional).toBeUndefined();
    });

    it('描述写得够长（它就是模型看到的说明书）并且都提到了关键风险', () => {
        expect(Object.keys(ENDGAME_TOOL_TEXT).sort()).toEqual([...ENDGAME_TOOLS].sort());
        for (const tool of ENDGAME_TOOLS) {
            expect(ENDGAME_TOOL_TEXT[tool].description.length).toBeGreaterThan(80);
        }
        expect(ENDGAME_TOOL_TEXT.bedBombDragon.description).toContain('sleep_in_bed');
        expect(ENDGAME_TOOL_TEXT.clearEndCrystals.description).toContain('12 格');
        expect(ENDGAME_TOOL_TEXT.drinkPotion.description).toContain('药水 id');
        expect(ENDGAME_TOOL_TEXT.drinkPotion.params.potion).toContain('long_slow_falling');
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

    it('throwHeld：手里没东西时给明确指引，不许假装扔了', async () => {
        const bot = makeFakeBot({});
        await findCommand('throwHeld')?.perform(makeFakeAgent(bot));
        expect(bot.output).toContain('手上是空的');
        expect(bot.output).toContain('手上是空的');
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
        const receipt = (await findCommand('!drinkPotion')?.perform(timedOut, 'long_slow_falling')) as string;
        expect(receipt).toContain('超时');

        const interrupted = makeFakeAgent(bot, { message: null, interrupted: true, timedout: false });
        // interrupted 且没超时 = 无需回执（模型自己知道它在干嘛）
        expect(await findCommand('!drinkPotion')?.perform(interrupted, 'long_slow_falling')).toBeUndefined();
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

describe('drinkPotion 的药水 id 参数（壳不再替模型挑药）', () => {
    it('potion 真的传到实现：给哪个 id 就只喝哪个', async () => {
        const potion = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ items: [potion] });
        const agent = makeFakeAgent(bot);
        await executeToolCall(agent, 'drinkPotion', { potion: 'long_slow_falling' });
        expect(bot.calls.map((c: any) => c.fn)).toEqual(['equip', 'consume']);
        expect(bot.output).toContain('喝下 long_slow_falling');
    });

    it('没有这瓶 → 报结果并列出背包里现有的药水 id', async () => {
        const potion = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:regeneration' } } });
        const bot = makeFakeBot({ items: [potion] });
        await executeToolCall(makeFakeAgent(bot), 'drinkPotion', { potion: 'fire_resistance' });
        expect(bot.output).toContain("背包里没有 'fire_resistance' 药水");
        expect(bot.output).toContain('regeneration');
        expect(bot.calls).toHaveLength(0);
    });

    it('drinkPotion 是必填参数：schema 里 potion 在 required 里', () => {
        const declaration = toolDeclarations().find((d) => d.name === 'drinkPotion');
        expect(Object.keys(declaration?.params ?? {})).toEqual(['potion']);
        expect(declaration?.params?.potion?.optional).toBeUndefined();
        expect((TOOL_TEXT as any).drinkPotion?.params?.potion).toBeTruthy();
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
        expect(receipt).toContain('没做到 throwHeld，ender_pearl 没有扔出去。');
    });
});