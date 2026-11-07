/**
 * 末地命令接线层的测试（不连 MC 服务端、不烧 token）。
 *
 * 和末地相关的工具已经删到只剩 `enterEnd` 和 `recoverAfterDeath`，这里钉住：
 * 1) **接线正确**：registry 里能查到 2 条命令，kind 与超时标记对得上；
 * 2) **命令真的干活**：用假 agent 跑一遍，核对它写进 bot.output 的回执。
 */
import { describe, expect, it } from 'vitest';
import { findCommand, toolDeclarations, toolNames } from '../src/body/commands/registry.js';
import { ENDGAME_TOOL_TEXT, endgameActionList, endgameQueryList } from '../src/body/commands/endgame.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import {
    countEyesOfEnder,
    throwHeldSkill,
} from '../src/body/library/endgame_routine.js';

const ENDGAME_TOOLS = [
    'enterEnd',
    'recoverAfterDeath',
] as const;

function stack(name: string, count = 1, extra: Record<string, any> = {}) {
    return { name, count, ...extra };
}

/** 假 bot 的 consume 会从背包扣一个，用来核对「数量真的变了」这类事实。 */
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

describe('接线：registry 里和末地相关的 3 条命令', () => {
    it('全部注册进来了，名字与顺序稳定', () => {
        const names = toolNames();
        for (const tool of ENDGAME_TOOLS) expect(names).toContain(tool);
        expect(endgameQueryList.map((c) => c.name.replace('!', ''))).toEqual([]);
        expect(endgameActionList.map((c) => c.name.replace('!', ''))).toEqual([...ENDGAME_TOOLS]);
    });

    it('kind 全对：都是 action + longRunning', () => {
        const declarations = toolDeclarations();
        for (const tool of ENDGAME_TOOLS) {
            const declaration = declarations.find((d) => d.name === tool);
            expect(declaration, `${tool} 没在声明里`).toBeDefined();
            expect(declaration?.kind).toBe('action');
            expect(declaration?.longRunning).toBe(true);
        }
    });

    it('findCommand 带不带 ! 都认', () => {
        expect(findCommand('enterEnd')?.name).toBe('!enterEnd');
        expect(findCommand('notAThing')).toBeUndefined();
    });

    it('**每个参数都有提示词文案**（否则 check-prompts 会报 SCHEMA PARAM WITHOUT PROMPT TEXT）', () => {
        for (const command of [...endgameQueryList, ...endgameActionList]) {
            const params = Object.keys(command.params ?? {});
            expect(params, `${command.name} 不该有参数`).toEqual([]);
            for (const param of params) {
                const tool = command.name.replace(/^!/, '');
                expect((TOOL_TEXT as any)[tool]?.params?.[param], `${tool}.${param} 缺提示词文案`).toBeTruthy();
            }
        }
    });

    it('描述写得够长（它就是模型看到的说明书）并且都提到了关键风险', () => {
        expect(Object.keys(ENDGAME_TOOL_TEXT).sort()).toEqual([...ENDGAME_TOOLS].sort());
        for (const tool of ENDGAME_TOOLS) {
            expect(ENDGAME_TOOL_TEXT[tool].description.length).toBeGreaterThan(80);
        }
        expect(ENDGAME_TOOL_TEXT.recoverAfterDeath.description).toContain('5 分钟');
    });
});

describe('命令执行（假 agent）', () => {
    it('recoverAfterDeath 读到记录点就给出回收方案', async () => {
        const bot = makeFakeBot({ dimension: 'overworld' });
        await findCommand('recoverAfterDeath')?.perform(makeFakeAgent(bot));
        expect(bot.output).toContain('死亡回收');
        expect(bot.output).toContain('10,64,10');
    });

    it('超时回执说清"超时 ≠ 没做成"，被中断则安静返回', async () => {
        const bot = makeFakeBot({});
        const timedOut = makeFakeAgent(bot, { message: null, interrupted: false, timedout: true });
        const receipt = (await findCommand('!recoverAfterDeath')?.perform(timedOut)) as string;
        expect(receipt).toContain('超时');

        const interrupted = makeFakeAgent(bot, { message: null, interrupted: true, timedout: false });
        // interrupted 且没超时 = 无需回执（模型自己知道它在干嘛）
        expect(await findCommand('!recoverAfterDeath')?.perform(interrupted)).toBeUndefined();
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


describe('routine 里的几个计数器/技能', () => {
    it('countEyesOfEnder 认得末影之眼', () => {
        const bot = makeFakeBot({ stacks: [stack('ender_eye', 12), stack('stone', 1)] });
        expect(countEyesOfEnder(bot)).toBe(12);
        expect(countEyesOfEnder(makeFakeBot({ stacks: [stack('stone', 1)] }))).toBe(0);
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
        expect(receipt).toContain('ender_pearl 没有扔出去。');
    });
});
