import { describe, expect, it } from 'vitest';
import { DRAGON_MAX_HEALTH } from '../src/body/library/endgame.js';

// ============================ 碰世界那一层（用假 bot，不连服务端） ============================
import {
    drinkPotionByKind,
    endgameStatusReport,
    endgameToolSpecs,
    pickBedItemName,
    readDragonHealth,
    readDragonPerched,
    readEffects,
    readEndCrystals,
    readEndSignals,
} from '../src/body/library/endgame_routine.js';

function stack(name: string, count = 1, extra: Record<string, any> = {}) {
    return { name, count, ...extra };
}

let fakePosition: any;

function makeFakeBot(options: {
    dimension?: string;
    stacks?: any[];
    items?: any[];
    effects?: any;
    entities?: Record<string, any>;
    bossBars?: any[];
    registry?: any;
    blockAt?: (p: any) => any;
    position?: { x: number; y: number; z: number };
} = {}) {
    const p = options.position ?? { x: 0, y: 64, z: 0 };
    fakePosition = {
        x: p.x,
        y: p.y,
        z: p.z,
        offset(dx: number, dy: number, dz: number) {
            return { x: p.x + dx, y: p.y + dy, z: p.z + dz };
        },
    };
    const stacks = options.stacks ?? [];
    const calls: any[] = [];
    const bot: any = {
        game: { dimension: options.dimension ?? 'minecraft:the_end' },
        entity: { position: fakePosition, effects: options.effects ?? {} },
        entities: options.entities ?? {},
        bossBars: options.bossBars,
        registry: options.registry ?? { effects: {} },
        output: '',
        inventory: {
            slots: stacks,
            items: () => options.items ?? stacks,
        },
        equip: (item: any) => {
            calls.push({ fn: 'equip', item });
            return Promise.resolve();
        },
        consume: () => {
            calls.push({ fn: 'consume' });
            return Promise.resolve();
        },
        calls,
    };
    if (options.blockAt != null) bot.blockAt = options.blockAt;
    return bot;
}

describe('读 bot 状态（假 bot）', () => {
    it('Buff：把数字 id 翻成名字、tick 换算成秒；翻不到就写 effect_<id>', () => {
        const bot = makeFakeBot({
            effects: {
                1: { id: 1, amplifier: 1, duration: 600 },
                16: { id: 16, amplifier: 0, duration: 40 },
            },
            registry: { effects: { 1: { name: 'Speed' }, 16: { name: 'Fire Resistance' } } },
        });
        const effects = readEffects(bot);
        expect(effects).toHaveLength(2);
        expect(effects.map((e) => e.name).sort()).toEqual(['fire_resistance', 'speed']);
        const speed = effects.find((e) => e.name === 'speed');
        expect(speed?.seconds).toBe(30);
        expect(speed?.amplifier).toBe(1);

        const blind = makeFakeBot({ effects: { 7: { id: 7, amplifier: 0, duration: 20 } } });
        expect(readEffects(blind)[0]?.name).toBe('effect_7');
    });

    it('读不到 buff 字段就返回空数组，不抛', () => {
        expect(readEffects({})).toEqual([]);
        expect(readEffects({ entity: { effects: null } })).toEqual([]);
    });

    it('boss bar → 龙血；非龙 bar 和没有 bar 都返回 null（不知道 ≠ 死透了）', () => {
        expect(readDragonHealth(makeFakeBot({ bossBars: [{ title: 'Ender Dragon', health: 0.5 }] }))).toBe(100);
        expect(readDragonHealth(makeFakeBot({ bossBars: [{ title: '末影龙', health: 1 }] }))).toBe(DRAGON_MAX_HEALTH);
        expect(readDragonHealth(makeFakeBot({ bossBars: [{ title: 'Something else', health: 0.5 }] }))).toBeNull();
        expect(readDragonHealth(makeFakeBot({}))).toBeNull();
        expect(readDragonHealth(makeFakeBot({ bossBars: [{ title: { toString: () => 'Ender Dragon' }, health: 0.25 }] }))).toBe(50);
    });

    it('水晶：按 end_crystal 实体数出来；有 iron_bars 邻居才算笼中', () => {
        const crystal = (name: string, x: number) => ({ name, position: { x, y: 70, z: 0, offset: (dx: number, dy: number, dz: number) => ({ x: x + dx, y: 70 + dy, z: dz }) } });
        const bot = makeFakeBot({
            entities: { 1: crystal('end_crystal', 20), 2: crystal('end_crystal', 10), 9: { name: 'zombie', position: { x: 0, y: 0, z: 0 } } },
            blockAt: (pos: any) => (pos.x === 21 && pos.y === 70 ? { name: 'iron_bars' } : { name: 'air' }),
        });
        const crystals = readEndCrystals(bot);
        expect(crystals).toHaveLength(2);
        expect(crystals.find((c) => c.position.x === 20)?.caged).toBe(true);
        expect(crystals.find((c) => c.position.x === 10)?.caged).toBe(false);

        const noWorld = makeFakeBot({ entities: { 1: crystal('end_crystal', 5) } });
        expect(readEndCrystals(noWorld)[0]?.caged).toBeUndefined();
        expect(readEndCrystals(makeFakeBot({}))).toEqual([]);
    });

    it('龙低头判定：贴近传送门且高度低才算', () => {
        const dragon = (x: number, y: number, z: number) => ({ name: 'ender_dragon', position: { x, y, z } });
        expect(readDragonPerched(makeFakeBot({ entities: { 1: dragon(0, 65, 0) } }))).toBe(true);
        expect(readDragonPerched(makeFakeBot({ entities: { 1: dragon(25, 65, 0) } }))).toBe(false);
        expect(readDragonPerched(makeFakeBot({ entities: { 1: dragon(0, 90, 0) } }))).toBe(false);
        expect(readDragonPerched(makeFakeBot({}))).toBe(false);
    });

    it('readEndSignals 会把清单/维度/水晶/龙血拼在一起，坏数据不抛', () => {
        const bot = makeFakeBot({
            stacks: [stack('white_bed', 4), stack('obsidian', 64)],
            entities: { 1: { name: 'end_crystal', position: { x: 20, y: 70, z: 0 } } },
            bossBars: [{ title: 'Ender Dragon', health: 0.6 }],
        });
        const signals = readEndSignals(bot);
        expect(signals.dimension).toBe('the_end');
        expect(signals.inEnd).toBe(true);
        expect(signals.crystalsAlive).toBe(1);
        expect(signals.dragonHealth).toBe(120);
        expect(signals.gear.ok).toBe(true);
        // 水晶实体没有 offset（读不到世界）也不该抛
        expect(signals.crystals[0]?.caged).toBeUndefined();

        expect(readEndSignals({}).dimension).toBeNull();
        expect(readEndSignals({}).crystalsAlive).toBe(0);
    });

    it('状态报告带阶段、现状、拆水晶建议', () => {
        const bot = makeFakeBot({
            stacks: [stack('white_bed', 4), stack('obsidian', 64)],
            entities: { 1: { name: 'end_crystal', position: { x: 20, y: 70, z: 0 } } },
            bossBars: [{ title: 'Ender Dragon', health: 0.6 }],
        });
        const report = endgameStatusReport(bot);
        expect(report).toContain('末地通关');
        expect(report).toContain('水晶 1 颗');
        expect(report).toContain('拆水晶');
        expect(report).toContain('120/200');
    });
});

describe('drinkPotionByKind（按效果喝药，不是按物品名）', () => {
    it('按大类找到药水 → equip 到手上再 consume', async () => {
        const slowFalling = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ items: [stack('stone', 3), slowFalling] });
        await expect(drinkPotionByKind(bot, 'slow_falling')).resolves.toBe(true);
        expect(bot.calls.map((c: any) => c.fn)).toEqual(['equip', 'consume']);
        expect(bot.calls[0].item).toBe(slowFalling);
    });

    it('背包没有这一类 → false，并明确说背包里没有', async () => {
        const bot = makeFakeBot({ items: [stack('stone', 3)] });
        await expect(drinkPotionByKind(bot, 'milk')).resolves.toBe(false);
        expect(bot.calls).toHaveLength(0);
        expect(bot.output).toContain('没有 milk');
    });

    it('equip/consume 抛异常 → 吞掉并返回 false（不能让一条命令炸掉整个循环）', async () => {
        const bot = makeFakeBot({ items: [stack('milk_bucket', 1)] });
        bot.equip = () => {
            throw new Error('boom');
        };
        await expect(drinkPotionByKind(bot, 'milk')).resolves.toBe(false);
        expect(bot.output).toContain('失败');
    });

    it('pickBedItemName 只认床，不认 bedrock', () => {
        expect(pickBedItemName(makeFakeBot({ items: [stack('bedrock', 64), stack('red_bed', 1)] }))).toBe('red_bed');
        expect(pickBedItemName(makeFakeBot({ items: [stack('bedrock', 64)] }))).toBeNull();
    });
});

describe('给 Lead 的接线清单（工具声明）', () => {
    it('9 条工具、名字唯一、action 都有超时上限（不许再写 -1）', () => {
        expect(endgameToolSpecs).toHaveLength(9);
        const names = endgameToolSpecs.map((spec) => spec.name);
        expect(new Set(names).size).toBe(names.length);
        for (const spec of endgameToolSpecs) {
            expect(spec.description.length).toBeGreaterThan(20);
            expect(spec.backing.length).toBeGreaterThan(5);
            if (spec.kind === 'action') {
                expect(spec.timeoutMinutes).toBeGreaterThan(0);
            } else {
                expect(spec.timeoutMinutes).toBeUndefined();
            }
        }
    });

    it('必须覆盖任务点名的能力：进入/拆水晶/床炸/躲龙息/喝药/回收', () => {
        const names = endgameToolSpecs.map((spec) => spec.name);
        expect(names).toContain('enterEnd');
        expect(names).toContain('clearEndCrystals');
        expect(names).toContain('bedBombDragon');
        expect(names).toContain('dodgeDragonBreath');
        expect(names).toContain('drinkPotion');
        expect(names).toContain('recoverAfterDeath');
    });

    it('drinkPotion 的参数说明写清了"所有药水都叫 potion"这个坑', () => {
        const spec = endgameToolSpecs.find((s) => s.name === 'drinkPotion');
        expect(spec?.description).toContain('potion');
    });
});