import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================ 碰世界那一层（用假 bot，不连服务端） ============================
import {
    countEyesOfEnder,
    countPotionsById,
    drinkPotionById,
    endgameToolSpecs,
    enterEndSkill,
    frameHasEye,
    recoverAfterDeathSkill,
    resetDeathClocks,
    throwEyeAndTrack,
    throwHeldSkill,
} from '../src/body/library/endgame_routine.js';
import { permits } from '../src/body/safety/permits.js';

/**
 * 测试里没有真服务端：`world.getNearestBlocks*` 会去问 minecraft-data（未连接时是 null），
 * `skills.goToPosition` 会去用 pathfinder。这里只把**这两种碰真机的能力**换成假的 ——
 * 其余（`getInventoryCounts`、`skills.log/wait/equip`）保持真实实现。
 */
vi.mock('../src/body/library/world.js', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        getNearestBlocks: vi.fn(() => []),
        getNearestBlock: vi.fn(() => null),
        getNearestBlocksWhere: vi.fn(() => []),
    };
});

vi.mock('../src/body/library/skills.js', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        goToPosition: vi.fn(() => Promise.resolve(true)),
        moveAway: vi.fn(() => Promise.resolve(true)),
        placeBlock: vi.fn(() => Promise.resolve(true)),
    };
});

import * as skills from '../src/body/library/skills.js';
import * as world from '../src/body/library/world.js';

function stack(name: string, count = 1, extra: Record<string, any> = {}) {
    return { name, count, ...extra };
}

/**
 * 假 bot 的"吃东西/喝药"必须**真的从背包里扣掉**。
 * `drinkPotionById` 现在会核对数量（数量没变 = 没喝下去），假 bot 不扣就等于
 * 永远喝不成 —— 那不是被测代码的 bug，是假 bot 不忠实。
 */
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
    findBlocks?: () => any[];
    health?: number;
    food?: number;
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
    const items = options.items ?? stacks;
    const calls: any[] = [];
    const bot: any = {
        game: { dimension: options.dimension ?? 'minecraft:the_end' },
        entity: { position: fakePosition, effects: options.effects ?? {} },
        entities: options.entities ?? {},
        bossBars: options.bossBars,
        registry: options.registry ?? { effects: {} },
        health: options.health ?? 20,
        food: options.food ?? 20,
        output: '',
        inventory: {
            slots: stacks,
            items: () => items,
        },
        findBlocks: options.findBlocks ?? (() => []),
        equip: (item: any) => {
            calls.push({ fn: 'equip', item });
            bot.heldItem = item;
            return Promise.resolve();
        },
        consume: () => {
            calls.push({ fn: 'consume' });
            consumeOne(items, bot.heldItem);
            return Promise.resolve();
        },
        activateItem: () => {
            calls.push({ fn: 'activateItem' });
            consumeOne(items, bot.heldItem);
            return Promise.resolve();
        },
        lookAt: () => {
            calls.push({ fn: 'lookAt' });
            return Promise.resolve();
        },
        calls,
    };
    if (options.blockAt != null) bot.blockAt = options.blockAt;
    return bot;
}


describe('drinkPotionById（按完整药水 id 喝药，不猜效果、不挑优先级）', () => {
    it('按 id 找到药水 → equip 到手上再 consume，结果报喝了哪一瓶/还剩几瓶', async () => {
        const slowFalling = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ items: [stack('stone', 3), slowFalling] });
        const receipt = await drinkPotionById(bot, 'long_slow_falling');
        expect(receipt).toContain('喝下 long_slow_falling');
        expect(receipt).toContain('剩 0 瓶');
        expect(bot.calls.map((c: any) => c.fn)).toEqual(['equip', 'consume']);
        expect(bot.calls[0].item).toBe(slowFalling);
    });

    it('id 必须精确：给 slow_falling 不会喝 long_slow_falling', async () => {
        const potion = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ items: [potion] });
        const receipt = await drinkPotionById(bot, 'slow_falling');
        expect(receipt).toContain("背包里没有 'slow_falling' 药水");
        expect(receipt).toContain('long_slow_falling');
        expect(bot.calls).toHaveLength(0);
    });

    it('同效果多等级：给哪个 id 就喝哪个，不给就不动', async () => {
        const base = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:healing' } } });
        const strong = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:strong_healing' } } });
        const bot = makeFakeBot({ items: [base, strong] });
        const receipt = await drinkPotionById(bot, 'strong_healing');
        expect(receipt).toContain('喝下 strong_healing');
        expect(bot.calls.map((c: any) => c.fn)).toEqual(['equip', 'consume']);
        expect(bot.calls[0].item).toBe(strong);
        expect(countPotionsById(bot, 'healing')).toBe(1);
    });

    it('背包没有这种药 → 报结果并列出背包现有的药水 id，不做任何动作', async () => {
        const potion = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ items: [stack('stone', 3), potion] });
        const receipt = await drinkPotionById(bot, 'fire_resistance');
        expect(receipt).toContain("背包里没有 'fire_resistance' 药水");
        expect(receipt).toContain('long_slow_falling');
        expect(bot.calls).toHaveLength(0);
    });

    it('背包里那叠数量没变 → 只报"不能确认喝下"，不谎报成功', async () => {
        const potion = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ items: [potion] });
        bot.consume = () => {
            bot.calls.push({ fn: 'consume' });
            return Promise.resolve();
        };
        expect(await drinkPotionById(bot, 'long_slow_falling')).toContain('使用包已经发出去了，但是 long_slow_falling 的数量从 1');
        expect(countPotionsById(bot, 'long_slow_falling')).toBe(1);
    });

    it('喝下去之后那一叠真的少一瓶', async () => {
        const potions = [stack('potion', 2, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } })];
        const bot = makeFakeBot({ items: potions });
        expect(await drinkPotionById(bot, 'long_slow_falling')).toContain('剩 1 瓶');
        expect(countPotionsById(bot, 'long_slow_falling')).toBe(1);
    });

});

// ============================ 回归测试：床炸选址 / 掩体 / 死亡回收 ============================


describe('末地传送门框架的眼：1.13+ 是方块状态，不是 metadata', () => {
    it('eye=true 的框架不算空框架（原来 metadata 恒 0，会把有眼的也当空的）', () => {
        expect(frameHasEye({ name: 'end_portal_frame', getProperties: () => ({ eye: 'true' }) })).toBe(true);
        expect(frameHasEye({ name: 'end_portal_frame', getProperties: () => ({ eye: 'false' }) })).toBe(false);
    });

    it('老版本（1.12-）走 metadata bit 2', () => {
        expect(frameHasEye({ name: 'end_portal_frame', metadata: 4 })).toBe(true);
        expect(frameHasEye({ name: 'end_portal_frame', metadata: 0 })).toBe(false);
    });
});

describe('enterEnd：要塞不在这就替你掷眼（原来只是干说一句）', () => {
    afterEach(() => {
        vi.mocked(world.getNearestBlock).mockReturnValue(null);
        vi.mocked(world.getNearestBlocksWhere).mockReturnValue([]);
    });

    it('没有门也没有框架，手里有眼 → equip + 扔一颗，数量真的少一颗', async () => {
        const bot = makeFakeBot({ dimension: 'minecraft:overworld', stacks: [stack('ender_eye', 8)] });
        const receipt = await enterEndSkill(bot, { memory_bank: { rememberPlace: () => undefined } });
        expect(receipt).toContain('末影之眼');
        expect(receipt).toContain('掷');
        expect(bot.calls.map((c: any) => c.fn)).toContain('equip');
        expect(bot.calls.map((c: any) => c.fn)).toContain('activateItem');
        expect(countEyesOfEnder(bot)).toBe(7);
    });

    it('连眼都没有 → 说清怎么弄眼，不假装丢过', async () => {
        const bot = makeFakeBot({ dimension: 'minecraft:overworld', stacks: [] });
        const receipt = await enterEndSkill(bot, {});
        expect(receipt).toContain('没有末影之眼');
        expect(receipt).toContain('烈焰粉');
        expect(bot.calls).toHaveLength(0);
    });

    it('已经在末地 → 直接返回，不做任何动作', async () => {
        const bot = makeFakeBot({ dimension: 'the_end' });
        await expect(enterEndSkill(bot, {})).resolves.toContain('已经在末地');
        expect(bot.calls).toHaveLength(0);
    });

    it('发现已激活的传送门：先把手坐标记进 Memory Bank，再走进去', async () => {
        const bot = makeFakeBot({ dimension: 'minecraft:overworld', position: { x: 300, y: 30, z: -120 } });
        vi.mocked(world.getNearestBlock).mockReturnValue({ name: 'end_portal', position: { x: 300, y: 30, z: -120 } });
        // 走门 = 进维度：让假的 goToPosition 顺便把维度切过去，waitFor 立刻成立。
        vi.mocked(skills.goToPosition).mockImplementation((target: any) => {
            target.game.dimension = 'the_end';
            return Promise.resolve(true);
        });
        const remembered: Array<[string, number, number, number]> = [];
        const agent = {
            memory_bank: {
                rememberPlace: (name: string, x: number, y: number, z: number) => remembered.push([name, x, y, z]),
            },
        };
        const receipt = await enterEndSkill(bot, agent);
        expect(remembered).toEqual([['overworld_end_portal', 300, 30, -120]]);
        expect(receipt).toContain('已进入末地');
        expect(receipt).toContain('100,49,0');
        vi.mocked(skills.goToPosition).mockImplementation(() => Promise.resolve(true));
    });
});

describe('末影之眼：扔出去之后必须盯住它的飞行方向', () => {
    /** 假 bot：activateItem 时"生成"一颗会持续向东飞的眼实体（每次读 position 前进 2 格）。 */
    function makeEyeBot(options: { eyeAppears?: boolean; eyeMoves?: boolean } = {}) {
        const bot = makeFakeBot({ stacks: [stack('ender_eye', 3)] });
        bot.heldItem = bot.inventory.slots[0]; // 手上已经拿着眼睛了（equip 过了）
        const entities: Record<string, any> = {};
        bot.entities = entities;
        const originalActivate = bot.activateItem;
        bot.activateItem = () => {
            bot.calls.push({ fn: 'activateItem' });
            consumeOne(bot.inventory.items(), bot.heldItem);
            if (options.eyeAppears !== false) {
                let x = 0;
                const eye: any = { name: 'eye_of_ender' };
                Object.defineProperty(eye, 'position', {
                    enumerable: true,
                    get() {
                        if (options.eyeMoves === false) return { x: 0, y: 64, z: 0 };
                        x += 2;
                        return { x, y: 64, z: 0 };
                    },
                });
                entities['42'] = eye;
            }
            return Promise.resolve();
        };
        void originalActivate;
        return bot;
    }

    it('采到轨迹 → 报出 8 方位方向 + 飞了多远，并把最后位置记进 Memory Bank', async () => {
        const bot = makeEyeBot();
        const remembered: Array<[string, number, number, number]> = [];
        const receipt = await throwHeldSkill(bot, {
            memory_bank: { rememberPlace: (name: string, x: number, y: number, z: number) => remembered.push([name, x, y, z]) },
        });
        expect(receipt).toContain('东');
        expect(receipt).toContain('方向已经量出来了');
        expect(remembered).toHaveLength(1);
        expect(remembered[0][0]).toBe('last_eye_of_ender');
        expect(remembered[0][1]).toBeGreaterThan(0);
    });

    it('眼睛一出膛就没了 → 如实说"没看清"，绝不编方向', async () => {
        const bot = makeEyeBot({ eyeAppears: false });
        const report = await throwEyeAndTrack(bot, { maxMs: 250, intervalMs: 50 });
        expect(report.threw).toBe(true);
        expect(report.track).toBeNull();
        expect(report.message).toContain('没看清');
        // 不许出现任何方位词
        for (const word of ['东北', '东南', '西北', '西南', '朝东', '朝南', '朝西', '朝北']) {
            expect(report.message).not.toContain(word);
        }
    });

    it('眼睛出现了但一动不动（还捏在手里）→ 也判"没看清"', async () => {
        const bot = makeEyeBot({ eyeMoves: false });
        const report = await throwEyeAndTrack(bot, { maxMs: 250, intervalMs: 50 });
        expect(report.track).toBeNull();
        expect(report.message).toContain('没看清');
    });

    it('扔不出去（手里数量没变）→ 不算扔了，也不量方向', async () => {
        const bot = makeFakeBot({ stacks: [stack('ender_eye', 3)] });
        bot.activateItem = () => {
            bot.calls.push({ fn: 'activateItem' });
            return Promise.resolve(); // 服务端没采纳：数量不变
        };
        const report = await throwEyeAndTrack(bot, { maxMs: 150, intervalMs: 50 });
        expect(report.threw).toBe(false);
        expect(report.track).toBeNull();
        expect(report.message).toContain('没有扔出末影之眼，手里的数量没有变化。');
    });

    it('手上不是眼睛 → 先 equip，背包装不下就如实说', async () => {
        const bot = makeFakeBot({ stacks: [] });
        const report = await throwEyeAndTrack(bot, { maxMs: 100, intervalMs: 50 });
        expect(report.threw).toBe(false);
        expect(report.message).toContain('没有末影之眼');
    });
});

describe('recoverAfterDeath：不再硬编码"刚死/没倒计时"', () => {
    afterEach(() => {
        resetDeathClocks();
        vi.useRealTimers();
    });

    function makeAgent(options: {
        dimension?: string;
        death?: [number, number, number];
        portal?: [number, number, number];
        blockAt?: (p: any) => any;
    }) {
        const bot = makeFakeBot({ dimension: options.dimension ?? 'overworld', blockAt: options.blockAt });
        return {
            bot,
            memory_bank: {
                recallPlace: (name: string) =>
                    name === 'last_death_position' ? options.death : name === 'overworld_end_portal' ? options.portal : undefined,
            },
        };
    }

    it('掉进虚空（Y<-60）→ 直接判 lost、劝去重新备战', async () => {
        const receipt = await recoverAfterDeathSkill(makeAgent({ death: [5, -80, 5] }));
        expect(receipt).toContain('虚空');
        expect(receipt).toContain('重新备战');
    });

    it('第一次调用如实说"真实死亡时间未知"；第二次报出真实经过时间并按 5 分钟倒计时', async () => {
        vi.useFakeTimers();
        const agent = makeAgent({ death: [10, 64, 10], blockAt: () => ({ name: 'stone' }) });
        const first = await recoverAfterDeathSkill(agent);
        expect(first).toContain('真实死亡时间未知');

        vi.advanceTimersByTime(120_000);
        const second = await recoverAfterDeathSkill(agent);
        expect(second).toContain('已经过了 120s');
        expect(second).toContain('剩 180s'); // 300 - 120
        expect(second).toContain('倒计时在跑');

        vi.advanceTimersByTime(200_000);
        const third = await recoverAfterDeathSkill(agent);
        expect(third).toContain('重新备战');
    });

    it('尸体区块没加载 → 说明不倒计时（但也提醒另一个 bot 在旁边时是在跑的）', async () => {
        const receipt = await recoverAfterDeathSkill(makeAgent({ death: [10, 64, 10], blockAt: () => null }));
        expect(receipt).toContain('不在加载区块里');
        expect(receipt).toContain('另一个 bot');
    });

    it('记过主世界传送门就给出回末地的路线；没记过就说清为什么没有', async () => {
        const withPortal = await recoverAfterDeathSkill(
            makeAgent({ death: [10, 64, 10], portal: [300, 30, -120] }),
        );
        expect(withPortal).toContain('300,30,-120');
        expect(withPortal).toContain('enterEnd');

        const withoutPortal = await recoverAfterDeathSkill(makeAgent({ death: [10, 64, 10] }));
        expect(withoutPortal).toContain('overworld_end_portal 是空的');
    });
});

/** 完整立方体（能当掩体）：和 prismarine-block 给真方块的样子一致。 */
function fullBlock(name: string) {
    return { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
}
/** 空气/可替换方块。 */
const AIR_BLOCK = { name: 'air', boundingBox: 'empty', shapes: [] };
/** 半高/多段碰撞箱的方块（`boundingBox` 也是 'block'，但挡不住爆风）。 */
function partialBlock(name: string, shapes: number[][], boundingBox = 'block') {
    return { name, boundingBox, shapes };
}


// ============================ 回归：掩体必须是"完整立方体"（对抗验证 claim 4） ============================

describe('给 Lead 的接线清单（工具声明）', () => {
    it('3 条工具、名字唯一、action 都有超时上限（不许再写 -1）', () => {
        expect(endgameToolSpecs).toHaveLength(3);
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

    it('和末地相关的工具只剩 enterEnd，另外两个是通用动作', () => {
        const names = endgameToolSpecs.map((spec) => spec.name);
        expect(names).toEqual(['enterEnd', 'drinkPotion', 'recoverAfterDeath']);
    });

    it('drinkPotion 的参数说明写清了"所有药水都叫 potion"这个坑', () => {
        const spec = endgameToolSpecs.find((s) => s.name === 'drinkPotion');
        expect(spec?.description).toContain('potion');
    });
});
