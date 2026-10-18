import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAGON_MAX_HEALTH, distance as vecDistance, vec, type Vec3 } from '../src/body/library/endgame.js';

// ============================ 碰世界那一层（用假 bot，不连服务端） ============================
import {
    assessBedCover,
    bedBombDragon,
    clearEndCrystalsSkill,
    countEyesOfEnder,
    countPotionsOfKind,
    crystalToolKit,
    detectPodiumTrench,
    drinkPotionByKind,
    endgameStatusReport,
    endgameToolSpecs,
    enterEndSkill,
    frameHasEye,
    isFullCoverBlock,
    pickBedItemName,
    planBedBombSite,
    readDragonHealth,
    readDragonPerched,
    readEffects,
    readEndCrystals,
    readEndSignals,
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
 * `drinkPotionByKind` 现在会核对数量（数量没变 = 没喝下去），假 bot 不扣就等于
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

    it('drinkPotionByKind：背包里那叠数量没变 → 不算喝成功，如实报出来', async () => {
        const potion = stack('potion', 1, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } });
        const bot = makeFakeBot({ items: [potion] });
        // 服务端没采纳（consume 什么也没干）——不能当喝到了。
        bot.consume = () => {
            bot.calls.push({ fn: 'consume' });
            return Promise.resolve();
        };
        await expect(drinkPotionByKind(bot, 'slow_falling')).resolves.toBe(false);
        expect(bot.output).toContain('数量没变');
        expect(countPotionsOfKind(bot, 'slow_falling')).toBe(1);
    });

    it('drinkPotionByKind：喝下去之后那一叠真的少一瓶', async () => {
        const potions = [
            stack('potion', 2, { nbt: { value: { Potion: 'minecraft:long_slow_falling' } } }),
        ];
        const bot = makeFakeBot({ items: potions });
        await expect(drinkPotionByKind(bot, 'slow_falling')).resolves.toBe(true);
        expect(countPotionsOfKind(bot, 'slow_falling')).toBe(1);
        expect(bot.output).toContain('还剩 1 瓶');
    });

    it('pickBedItemName 只认床，不认 bedrock', () => {
        expect(pickBedItemName(makeFakeBot({ items: [stack('bedrock', 64), stack('red_bed', 1)] }))).toBe('red_bed');
        expect(pickBedItemName(makeFakeBot({ items: [stack('bedrock', 64)] }))).toBeNull();
    });
});

// ============================ 回归测试：床炸选址 / 掩体 / 死亡回收 ============================

describe('床炸选址：从真实方块读，不写死坐标', () => {
    /** 地面在 y=64 及以下，上面是空气。 */
    const ground = (p: Vec3) => (p.y <= 64 ? fullBlock('end_stone') : AIR_BLOCK);

    it('在龙头旁边选出床位/掩体/站位，站位在 4.5 格交互距离内', () => {
        const result = planBedBombSite({ dragonHead: vec(0, 65, 0), self: vec(2.5, 64, 0.5), probe: ground });
        expect(result.ok).toBe(true);
        const site = result.site;
        expect(site).toBeDefined();
        if (site == null) return;
        // 床位贴着龙头（水平邻格）
        expect(Math.hypot(site.bedCell.x, site.bedCell.z)).toBeCloseTo(1, 6);
        // 掩体在床和站位中间，人在掩体后面点床
        expect(vecDistance(site.bedCell, site.coverCell)).toBeCloseTo(1, 6);
        expect(vecDistance(site.bedCell, site.standCell)).toBeCloseTo(2, 6);
        expect(site.standDistance).toBeLessThanOrEqual(4.5);
        // 方向朝我现在站的那一侧（少走路，掩体天然在中间）
        expect(site.coverCell.x).toBeGreaterThan(site.bedCell.x);
    });

    it('掩体格本来就是完整方块 → coverAlreadySolid（不用再放一块）', () => {
        const probe = (p: Vec3) => {
            if (p.y === 65 && p.x === 2 && p.z === 0) return fullBlock('obsidian');
            return p.y <= 64 ? fullBlock('end_stone') : AIR_BLOCK;
        };
        const result = planBedBombSite({ dragonHead: vec(0, 65, 0), self: vec(3.5, 65, 0.5), probe });
        expect(result.ok).toBe(true);
        expect(result.site?.coverAlreadySolid).toBe(true);
        expect(result.site?.coverCellBlock).toBe('obsidian');
    });

    it('掩体格是火把 → **不算**掩体（这是会死人的那个反例）', () => {
        const torch = partialBlock('torch', [[]], 'empty');
        const probe = (p: Vec3) => {
            if (p.y === 65 && p.x === 2 && p.z === 0) return torch;
            return p.y <= 64 ? fullBlock('end_stone') : AIR_BLOCK;
        };
        const result = planBedBombSite({ dragonHead: vec(0, 65, 0), self: vec(3.5, 65, 0.5), probe });
        expect(result.ok).toBe(true);
        expect(result.site?.coverAlreadySolid).toBe(false);
        expect(result.site?.coverCellBlock).toBe('torch');
    });

    it('读不到世界（全 null）→ 拒绝选址，绝不猜地形', () => {
        const result = planBedBombSite({ dragonHead: vec(0, 65, 0), self: vec(2, 64, 0), probe: () => null });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('能放下床');
    });

    it('床边没有能站住的地方（悬空/半砖）→ 拒绝', () => {
        const result = planBedBombSite({ dragonHead: vec(0, 65, 0), self: vec(2, 64, 0), probe: () => AIR_BLOCK });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('能站住');

        // 脚下是半砖（boundingBox='block' 但不是完整立方体）→ 同样不算站得住
        const slabFloor = (p: Vec3) => {
            if (p.y <= 64) return partialBlock('oak_slab', [[0, 0, 0, 1, 0.5, 1]]);
            return AIR_BLOCK;
        };
        const onSlab = planBedBombSite({ dragonHead: vec(0, 65, 0), self: vec(2, 64, 0), probe: slabFloor });
        expect(onSlab.ok).toBe(false);
    });
});

describe('碗形基岩框（trench）判定：读不到就说不知道', () => {
    const bedrockCells = new Set(['0,63,0', '1,64,0', '-1,64,0', '0,64,1']);
    const bowlProbe = (p: any) => (bedrockCells.has(`${p.x},${p.y},${p.z}`) ? { name: 'bedrock' } : { name: 'air' });

    it('站在传送门 4 格内、两面以上基岩 → 算钻进了结构里', () => {
        const bot = makeFakeBot({ blockAt: bowlProbe });
        expect(detectPodiumTrench(bot, vec(0, 64, 0))).toBe(true);
    });

    it('离传送门 4 格外 → 直接 false（不用再探方块）', () => {
        const bot = makeFakeBot({ blockAt: bowlProbe });
        expect(detectPodiumTrench(bot, vec(10, 64, 0))).toBe(false);
    });

    it('读不到方块 → null（不知道），绝不当作"有掩体"', () => {
        expect(detectPodiumTrench(makeFakeBot({}), vec(0, 64, 0))).toBeNull();
    });
});

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
        expect(report.message).toContain('没扔出去');
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

describe('bedBombDragon 的前置条件（不放床就拒绝）', () => {
    afterEach(() => {
        permits.revokeAll();
    });

    const perchedDragon = { 1: { name: 'ender_dragon', position: { x: 0, y: 65, z: 0 } } };

    it('血量太低 → 拒绝，并且一个方块都不放', async () => {
        const bot = makeFakeBot({
            stacks: [stack('white_bed', 1), stack('obsidian', 8)],
            entities: perchedDragon,
            health: 4,
        });
        const receipt = await bedBombDragon(bot);
        expect(receipt).toContain('血量');
        expect(receipt).toContain('太低');
    });

    it('饥饿太低 → 拒绝（受伤后要靠饥饿回血）', async () => {
        const bot = makeFakeBot({
            stacks: [stack('white_bed', 1), stack('obsidian', 8)],
            entities: perchedDragon,
            health: 20,
            food: 2,
        });
        const receipt = await bedBombDragon(bot);
        expect(receipt).toContain('饥饿值');
    });

    it('没有授权 → 说清缺 sleep_in_bed，且不放任何方块', async () => {
        const bot = makeFakeBot({
            stacks: [stack('white_bed', 1), stack('obsidian', 8)],
            entities: perchedDragon,
            blockAt: (p: any) => (p.y <= 64 ? fullBlock('end_stone') : AIR_BLOCK),
        });
        const receipt = await bedBombDragon(bot);
        expect(receipt).toContain('sleep_in_bed');
        expect(receipt).toContain('没有放任何方块');
    });

    it('读不到方块（区块没加载）→ 拒绝选址，不猜地形', async () => {
        const bot = makeFakeBot({ stacks: [stack('white_bed', 1)], entities: perchedDragon });
        const receipt = await bedBombDragon(bot);
        expect(receipt).toContain('没有执行床炸');
    });

    it('龙没低头 → 直接拒绝', async () => {
        const bot = makeFakeBot({
            stacks: [stack('white_bed', 1)],
            entities: { 1: { name: 'ender_dragon', position: { x: 30, y: 90, z: 0 } } },
        });
        await expect(bedBombDragon(bot)).resolves.toContain('没低头停在传送门上');
    });

    it('授权 + 地形齐 → 放床、放掩体、站到掩体后、点床、退到 10 格外（全流程）', async () => {
        permits.grantCalls(['sleep_in_bed'], 3, '测试', Date.now());
        const blocks = new Map<string, string>();
        const key = (p: any): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        const bot = makeFakeBot({
            stacks: [stack('white_bed', 2), stack('obsidian', 8)],
            entities: { 1: { name: 'ender_dragon', position: { x: 0, y: 65, z: 0 } } },
            position: { x: 2.5, y: 64, z: 0.5 },
            health: 20,
            food: 20,
            blockAt: (p: any) => {
                const override = blocks.get(key(p));
                if (override != null) return fullBlock(override);
                return p.y <= 64 ? fullBlock('end_stone') : AIR_BLOCK;
            },
        });
        const slept: any[] = [];
        bot.sleep = (bed: any) => {
            slept.push(bed);
            return Promise.resolve();
        };
        const placed: Array<[string, number, number, number]> = [];
        vi.mocked(skills.placeBlock).mockImplementation((_bot: any, item: string, x: number, y: number, z: number) => {
            placed.push([item, x, y, z]);
            blocks.set(`${x},${y},${z}`, item);
            // 真 placeBlock 会扣掉背包里的方块，假 bot 也要扣，否则"还剩几张床"是假的。
            const items = _bot.inventory.items();
            const used = items.find((stack: any) => stack?.name === item);
            if (used != null) consumeOne(items, used);
            return Promise.resolve(true);
        });

        const receipt = await bedBombDragon(bot);
        expect(receipt).toContain('床炸完了');
        // 先放床，再在床边放挡爆风的方块
        expect(placed.map((p) => p[0])).toEqual(['white_bed', 'obsidian']);
        expect(Math.abs(placed[0][1] - placed[1][1])).toBeLessThanOrEqual(1); // 床和掩体挨着
        expect(slept).toHaveLength(1); // 真的点了床
        expect(vi.mocked(skills.goToPosition)).toHaveBeenCalled(); // 有站位/撤退
        expect(vi.mocked(skills.moveAway)).toHaveBeenCalled();
        // 自伤预估要报出来，且床数按真实库存算
        expect(receipt).toContain('还剩 1 张床');

        vi.mocked(skills.placeBlock).mockResolvedValue(true);
    });
});

describe('clearEndCrystals：退不到 12 格就不放箭', () => {
    afterEach(() => {
        vi.mocked(skills.goToPosition).mockImplementation(() => Promise.resolve(true));
    });

    it('离水晶 8 格、又退不动 → 一支箭都不放，回执说清该退到哪', async () => {
        const bot = makeFakeBot({ stacks: [stack('bow', 1), stack('arrow', 32)] });
        bot.entities = { 7: { name: 'end_crystal', position: { x: 8, y: 70, z: 0 } } };
        vi.mocked(skills.goToPosition).mockResolvedValue(false); // 路被堵，退不动

        const receipt = await clearEndCrystalsSkill(bot);
        expect(receipt).toContain('没有放箭');
        expect(receipt).toContain('12');
        expect(bot.calls.filter((c: any) => c.fn === 'activateItem')).toHaveLength(0);
        expect(crystalToolKit(bot).arrows).toBe(32);
    });

    /** 模拟"放一箭"：真的扣一支箭；hit=true 时水晶被炸掉。 */
    function fakeShoot(bot: any, options: { hit: boolean }): void {
        bot.activateItem = () => {
            bot.calls.push({ fn: 'activateItem' });
            const arrows = bot.inventory.items().find((stack: any) => stack?.name === 'arrow');
            if (arrows != null) consumeOne(bot.inventory.items(), arrows);
            if (options.hit) delete bot.entities['7'];
            return Promise.resolve();
        };
        bot.deactivateItem = () => {
            bot.calls.push({ fn: 'deactivateItem' });
            return Promise.resolve();
        };
    }

    it('退到 13 格后才放箭，并按"水晶数掉没掉"报进度', async () => {
        const bot = makeFakeBot({ stacks: [stack('bow', 1), stack('arrow', 32)] });
        bot.entities = { 7: { name: 'end_crystal', position: { x: 8, y: 70, z: 0 } } };
        vi.mocked(skills.goToPosition).mockImplementation(
            (target: any, x: number | null, _y: number | null, z: number | null) => {
                if (x != null) target.entity.position.x = x; // 真的走过去了
                if (z != null) target.entity.position.z = z;
                return Promise.resolve(true);
            },
        );
        fakeShoot(bot, { hit: true });

        const receipt = await clearEndCrystalsSkill(bot);
        expect(crystalToolKit(bot).arrows).toBe(31); // 箭真的少了
        expect(receipt).toContain('这一下有效');
        expect(receipt).toContain('水晶全拆完了');
    });

    it('射了但水晶没掉 → 如实说"多半没打中/被挡住"', async () => {
        const bot = makeFakeBot({ stacks: [stack('bow', 1), stack('arrow', 32)] });
        bot.entities = { 7: { name: 'end_crystal', position: { x: 8, y: 70, z: 0 } } };
        vi.mocked(skills.goToPosition).mockImplementation(
            (target: any, x: number | null, _y: number | null, z: number | null) => {
                if (x != null) target.entity.position.x = x;
                if (z != null) target.entity.position.z = z;
                return Promise.resolve(true);
            },
        );
        fakeShoot(bot, { hit: false });

        const receipt = await clearEndCrystalsSkill(bot);
        expect(crystalToolKit(bot).arrows).toBe(31);
        expect(receipt).toContain('没拆掉水晶');
        expect(receipt).toContain('没掉');
    });
});

// ============================ 回归：掩体必须是"完整立方体"（对抗验证 claim 4） ============================

describe('掩体判据：火把/栅栏/铁栏杆/台阶都不算掩体（会死人的那个反例）', () => {
    const NOT_COVER: Array<[string, any]> = [
        ['火把', partialBlock('torch', [[]], 'empty')],
        ['墙上的火把', partialBlock('wall_torch', [[]], 'empty')],
        ['铁轨', partialBlock('rail', [[]], 'empty')],
        ['蒲公英', partialBlock('dandelion', [[]], 'empty')],
        // 下面这些 boundingBox 也是 'block'，但碰撞箱不是完整立方体——只查 boundingBox 会漏
        ['橡木栅栏', partialBlock('oak_fence', [[0, 0, 0.375, 1, 1.5, 0.625], [0.375, 0, 0, 0.625, 1.5, 0.375]])],
        ['铁栏杆', partialBlock('iron_bars', [[0, 0, 0.4375, 1, 1, 0.5625]])],
        ['下半砖', partialBlock('oak_slab', [[0, 0, 0, 1, 0.5, 1]])],
        ['栅栏门', partialBlock('oak_fence_gate', [[0, 0, 0.375, 1, 1.5, 0.625]])],
        ['床', partialBlock('white_bed', [[0, 0, 0, 0.1875, 0.5625, 0.1875]])],
        ['水', partialBlock('water', [[]], 'empty')],
        ['空气', AIR_BLOCK],
    ];
    const COVER: Array<[string, any]> = [
        ['黑曜石', fullBlock('obsidian')],
        ['圆石', fullBlock('cobblestone')],
        ['石头', fullBlock('stone')],
        ['末地石', fullBlock('end_stone')],
        ['玻璃', fullBlock('glass')],
    ];

    it('isFullCoverBlock：只看碰撞箱，不看名字', () => {
        for (const [label, block] of NOT_COVER) {
            expect(isFullCoverBlock(block), `${label} 不该算掩体`).toBe(false);
        }
        for (const [label, block] of COVER) {
            expect(isFullCoverBlock(block), `${label} 应该算掩体`).toBe(true);
        }
    });

    it('读不到碰撞箱 → 也不算掩体（拿不准就不算，宁可拒绝）', () => {
        expect(isFullCoverBlock({ name: 'obsidian' })).toBe(false);
        expect(isFullCoverBlock({ name: 'obsidian', boundingBox: 'block' })).toBe(false);
        expect(isFullCoverBlock({ name: 'obsidian', boundingBox: 'block', shapes: [] })).toBe(false);
        expect(isFullCoverBlock(null)).toBe(false);
        expect(isFullCoverBlock(undefined)).toBe(false);
    });

    it('assessBedCover：掩体格是火把 → 不算已有掩体，走"放一块再复验"', () => {
        const torch = partialBlock('torch', [[]], 'empty');
        const bot = makeFakeBot({
            stacks: [stack('obsidian', 8)],
            blockAt: () => torch,
        });
        const assessment = assessBedCover(bot, {
            bedCell: vec(1, 65, 0),
            coverCell: vec(2, 65, 0),
            standCell: vec(3, 65, 0),
            coverAlreadySolid: false,
            coverCellBlock: 'torch',
            standDistance: 2,
            dragonDistance: 1,
        });
        expect(assessment.alreadySolid).toBe(false);
        expect(assessment.coverItem).toBe('obsidian');
        expect(assessment.available).toBe(true);
        expect(assessment.reason).toContain('不算掩体');
    });

    it('assessBedCover：没有可放的完整方块 → available=false（闸门会拒绝）', () => {
        const bot = makeFakeBot({ stacks: [stack('torch', 4)], blockAt: () => partialBlock('torch', [[]], 'empty') });
        const assessment = assessBedCover(bot, {
            bedCell: vec(1, 65, 0),
            coverCell: vec(2, 65, 0),
            standCell: vec(3, 65, 0),
            coverAlreadySolid: false,
            coverCellBlock: 'torch',
            standDistance: 2,
            dragonDistance: 1,
        });
        expect(assessment.alreadySolid).toBe(false);
        expect(assessment.coverItem).toBeNull();
        expect(assessment.available).toBe(false);
    });

    /** 授权 + 一个"掩体格有块碍事的非完整方块"的场地。 */
    function makeTorchCoverBot(options: { withBlocks: boolean }) {
        permits.grantCalls(['sleep_in_bed'], 3, '测试', Date.now());
        const blocks = new Map<string, any>();
        const key = (p: any): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
        const torch = partialBlock('torch', [[]], 'empty');
        const stacks = [stack('white_bed', 2)];
        if (options.withBlocks) stacks.push(stack('obsidian', 8));
        const bot = makeFakeBot({
            stacks,
            entities: { 1: { name: 'ender_dragon', position: { x: 0, y: 65, z: 0 } } },
            position: { x: 2.5, y: 64, z: 0.5 },
            health: 20,
            food: 20,
            blockAt: (p: any) => {
                const override = blocks.get(key(p));
                if (override != null) return override;
                const base = p.y <= 64 ? fullBlock('end_stone') : AIR_BLOCK;
                if (p.y === 65 && p.x === 2 && p.z === 0) return torch; // 掩体格里插着一根火把
                return base;
            },
        });
        const slept: any[] = [];
        bot.sleep = (bed: any) => {
            slept.push(bed);
            return Promise.resolve();
        };
        const placed: Array<[string, number, number, number]> = [];
        vi.mocked(skills.placeBlock).mockImplementation((_bot: any, item: string, x: number, y: number, z: number) => {
            placed.push([item, x, y, z]);
            // 真 placeBlock 会先把碍事的东西清掉再放：这里模拟"放成完整方块"。
            blocks.set(`${x},${y},${z}`, fullBlock(item));
            const items = _bot.inventory.items();
            const used = items.find((stackItem: any) => stackItem?.name === item);
            if (used != null) consumeOne(items, used);
            return Promise.resolve(true);
        });
        return { bot, placed, slept };
    }

    it('掩体格是火把 + 背包有方块 → **不会跳过放掩体那一步**，放完复验才点床', async () => {
        const { bot, placed, slept } = makeTorchCoverBot({ withBlocks: true });
        const receipt = await bedBombDragon(bot);
        // 床 + 掩体两次放置：火把不算掩体，所以必须真的去放 obsidian
        expect(placed.map((p) => p[0])).toEqual(['white_bed', 'obsidian']);
        expect(placed[1].slice(1)).toEqual([2, 65, 0]);
        expect(slept).toHaveLength(1); // 复验通过后才点床
        expect(receipt).toContain('掩体已放好');
        expect(receipt).toContain('床炸完了');
        vi.mocked(skills.placeBlock).mockImplementation(() => Promise.resolve(true));
    });

    it('掩体格是火把 + 背包没有方块 → 拒绝，一个方块都不放、也不点床', async () => {
        const { bot, placed, slept } = makeTorchCoverBot({ withBlocks: false });
        const receipt = await bedBombDragon(bot);
        expect(placed).toHaveLength(0);
        expect(slept).toHaveLength(0);
        expect(receipt).toContain('没有执行床炸');
        expect(receipt).toContain('不算掩体');
        vi.mocked(skills.placeBlock).mockImplementation(() => Promise.resolve(true));
    });

    it('endgameStatusReport 的干跑闸门也认这个判据：火把掩体 → "现在不能炸"', () => {
        const torch = partialBlock('torch', [[]], 'empty');
        const withTorch = (stacks: any[]) =>
            makeFakeBot({
                stacks,
                entities: { 1: { name: 'ender_dragon', position: { x: 0, y: 65, z: 0 } } },
                position: { x: 2.5, y: 64, z: 0.5 },
                bossBars: [{ title: 'Ender Dragon', health: 1 }],
                blockAt: (p: any) => {
                    if (p.y === 65 && p.x === 2 && p.z === 0) return torch;
                    return p.y <= 64 ? fullBlock('end_stone') : AIR_BLOCK;
                },
            });

        // 没有可放的完整方块 → 火把不算掩体 → 干跑也拒绝
        const noBlocks = endgameStatusReport(withTorch([stack('bow', 1), stack('arrow', 32)]));
        expect(noBlocks).toContain('【床炸闸门】现在不能炸');
        expect(noBlocks).toContain('不算掩体');

        // 有方块可放 → 可以炸，但报告必须说清"掩体格那根火把不算数、要先放一块"
        const withBlocks = endgameStatusReport(withTorch([stack('bow', 1), stack('arrow', 32), stack('end_stone', 64)]));
        expect(withBlocks).toContain('【床炸闸门】现在可以炸');
        expect(withBlocks).toContain('不算掩体');
        expect(withBlocks).toContain('end_stone');
    });
});

describe('给 Lead 的接线清单（工具声明）', () => {
    it('10 条工具、名字唯一、action 都有超时上限（不许再写 -1）', () => {
        expect(endgameToolSpecs).toHaveLength(10);
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

    it('必须覆盖任务点名的能力：进入/拆水晶/床炸/躲龙息/喝药/回收/复活', () => {
        const names = endgameToolSpecs.map((spec) => spec.name);
        expect(names).toContain('enterEnd');
        expect(names).toContain('clearEndCrystals');
        expect(names).toContain('bedBombDragon');
        expect(names).toContain('dodgeDragonBreath');
        expect(names).toContain('drinkPotion');
        expect(names).toContain('recoverAfterDeath');
        expect(names).toContain('reviveDragon');
    });

    it('drinkPotion 的参数说明写清了"所有药水都叫 potion"这个坑', () => {
        const spec = endgameToolSpecs.find((s) => s.name === 'drinkPotion');
        expect(spec?.description).toContain('potion');
    });
});