/**
 * 护甲守卫：下界不许把金甲换成非金甲，而且**任何护甲变化都要说出来**。
 *
 * 真机事故（overnight_b）：`mineflayer-armor-manager` 的等级表是
 * leather < **golden** < **iron** < chainmail < …，所以捡到 iron_helmet 就把 golden_helmet
 * 换掉了 —— 在下界这等于把"猪灵中立"换成"猪灵追杀"。模型看不到，也没要求它发生。
 *
 * 这一批钉四件事：
 *   1) 纯判据：下界"金 → 非金"必须换回；下界"非金 → 金"放行；主世界照常换；
 *   2) 行为：下界里插件把金甲换掉 ⇒ **换回来**且**有报告**（不是静默）；
 *   3) 主世界：更好的甲**照常换**（不许变成"永不自动穿甲"），但也要报告；
 *   4) 接线：`mcdata.ts` 真的装了守卫（插件加载点就在那里）。
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    ARMOR_SLOTS,
    armorSlotNameOf,
    armorSlotOfItemName,
    armorSwapVerdict,
    enforceGoldInNether,
    findGoldArmorFor,
    installArmorGuard,
    isGoldArmorName,
    isInNetherDimension,
} from '../src/body/library/armor_guard.js';

const stack = (name: string, count = 1): any => ({ name, count, type: 1 });

/** 假身体：真的事件总线 + 可读的护甲槽 + 记录 `equip` 调用。 */
function armorBot(options: { dimension?: string; worn?: Record<string, string | null>; items?: any[] } = {}) {
    const inventory = new EventEmitter() as EventEmitter & { items: () => any[]; slots: any[] };
    const items: any[] = [...(options.items ?? [])];
    inventory.items = () => items;
    inventory.slots = new Array(46).fill(null);
    const equipped: Array<{ name: string; destination: string }> = [];
    const bot: any = {
        output: '',
        game: { dimension: options.dimension ?? 'the_nether' },
        inventory,
        equip: async (item: any, destination: string) => {
            equipped.push({ name: item.name, destination });
            // 真的把槽位换掉（和 mineflayer 一样），并把换下来的放回背包
            const index = Number(Object.keys(ARMOR_SLOTS).find((key) => ARMOR_SLOTS[Number(key)] === destination));
            const previous = inventory.slots[index];
            inventory.slots[index] = item;
            if (previous != null) items.push(previous);
            const at = items.indexOf(item);
            if (at >= 0) items.splice(at, 1);
            return true;
        },
    };
    // 初始化穿着
    for (const [slotName, name] of Object.entries(options.worn ?? {})) {
        const index = Number(Object.keys(ARMOR_SLOTS).find((key) => ARMOR_SLOTS[Number(key)] === slotName));
        inventory.slots[index] = name == null ? null : stack(name);
    }
    return {
        bot,
        inventory,
        equipped,
        items,
        /** 模拟插件/服务端的换甲：旧件回背包、新件穿上、发 `updateSlot`（和 mineflayer 一致）。 */
        simulateSwap: (slotIndex: number, newName: string, options: { keepOldInPack?: boolean } = {}) => {
            const previous = inventory.slots[slotIndex];
            if (previous != null && options.keepOldInPack !== false) items.push(previous);
            const next = stack(newName);
            inventory.slots[slotIndex] = next;
            const at = items.findIndex((item) => item.name === newName);
            if (at >= 0) items.splice(at, 1);
            inventory.emit('updateSlot', slotIndex, previous, next);
        },
        wornAt: (slotName: string) => {
            const index = Number(Object.keys(ARMOR_SLOTS).find((key) => ARMOR_SLOTS[Number(key)] === slotName));
            return inventory.slots[index]?.name ?? null;
        },
    };
}

describe('护甲判据（纯函数）', () => {
    it('槽位与部位：5~8 = head/torso/legs/feet，非护甲槽返回 null', () => {
        expect(armorSlotNameOf(5)).toBe('head');
        expect(armorSlotNameOf(6)).toBe('torso');
        expect(armorSlotNameOf(7)).toBe('legs');
        expect(armorSlotNameOf(8)).toBe('feet');
        expect(armorSlotNameOf(9)).toBeNull();
        expect(armorSlotNameOf('x')).toBeNull();
        expect(armorSlotOfItemName('golden_helmet')).toBe('head');
        expect(armorSlotOfItemName('iron_chestplate')).toBe('torso');
        expect(armorSlotOfItemName('diamond_leggings')).toBe('legs');
        expect(armorSlotOfItemName('netherite_boots')).toBe('feet');
        expect(armorSlotOfItemName('gold_ingot')).toBeNull();
    });

    it('"金装备"只认带部位后缀的：金甲是 golden_*，金锭不是', () => {
        expect(isGoldArmorName('golden_helmet')).toBe(true);
        expect(isGoldArmorName('golden_boots')).toBe(true);
        expect(isGoldArmorName('gold_chestplate')).toBe(true); // 老写法也认
        expect(isGoldArmorName('gold_ingot')).toBe(false);
        expect(isGoldArmorName('golden_apple')).toBe(false);
        expect(isGoldArmorName('iron_helmet')).toBe(false);
        expect(isGoldArmorName(null)).toBe(false);
    });

    it('下界"金 → 非金"⇒ 换回（并给出猪灵原因）；下界"非金 → 金"⇒ 放行', () => {
        const swap = armorSwapVerdict({
            dimension: 'the_nether',
            slotName: 'head',
            from: 'golden_helmet',
            to: 'iron_helmet',
        });
        expect(swap.action).toBe('revert_gold');
        expect(swap.report).toContain('golden_helmet → iron_helmet');
        expect(swap.report).toContain('招来猪灵');
        expect(swap.reason).toContain('中立');

        const upgrade = armorSwapVerdict({
            dimension: 'minecraft:the_nether',
            slotName: 'head',
            from: 'iron_helmet',
            to: 'golden_helmet',
        });
        expect(upgrade.action).toBe('allow');
        expect(upgrade.report).toContain('换上金甲是对的');

        // 下界里不涉及金甲的更换照常放行，但**必须报告**
        const neutral = armorSwapVerdict({
            dimension: 'the_nether',
            slotName: 'legs',
            from: 'leather_leggings',
            to: 'iron_leggings',
        });
        expect(neutral.action).toBe('allow');
        expect(neutral.report).toContain('护甲变化');
    });

    it('主世界/末地：更好的甲照常换（不许变成"永不自动穿甲"）', () => {
        for (const dimension of ['overworld', 'the_end', null]) {
            const verdict = armorSwapVerdict({
                dimension,
                slotName: 'head',
                from: 'golden_helmet',
                to: 'iron_helmet',
            });
            expect(verdict.action, String(dimension)).toBe('allow');
            expect(verdict.report).toContain('护甲变化');
        }
        expect(isInNetherDimension('the_nether')).toBe(true);
        expect(isInNetherDimension('overworld')).toBe(false);
    });

    it('背包里找这个部位的金装备：只看同部位、只认金', () => {
        const items = [stack('iron_helmet'), stack('golden_boots'), stack('gold_ingot'), stack('golden_helmet')];
        expect(findGoldArmorFor(items, 'head')?.name).toBe('golden_helmet');
        expect(findGoldArmorFor(items, 'feet')?.name).toBe('golden_boots');
        expect(findGoldArmorFor(items, 'legs')).toBeNull();
    });
});

describe('护甲守卫（行为）', () => {
    it('**真机那一幕**：下界里插件把 golden_helmet 换成 iron_helmet ⇒ 换回金甲 + 有报告', async () => {
        const h = armorBot({
            dimension: 'the_nether',
            worn: { head: 'golden_helmet' },
            items: [stack('iron_helmet')], // 捡到的更好的（按插件等级表）铁头盔
        });
        installArmorGuard(h.bot);

        // 插件的行为：playerCollect → equipItem → bot.equip(iron_helmet, 'head')
        h.simulateSwap(5, 'iron_helmet');
        await new Promise((resolve) => setTimeout(resolve, 0)); // 让异步的换回跑完

        expect(h.wornAt('head')).toBe('golden_helmet'); // 金甲保住了
        expect(h.equipped.map((e) => e.name)).toContain('golden_helmet');
        expect(h.bot.output).toContain('招来猪灵'); // 而且**不是静默**
        expect(h.bot.output).toContain('已经换回 golden_helmet');
    });

    it('下界里金甲被换掉、背包里也没有金装备了 ⇒ **大声说**（不许静默地失去中立）', async () => {
        const h = armorBot({
            dimension: 'the_nether',
            worn: { head: 'golden_helmet' },
            items: [],
        });
        installArmorGuard(h.bot);
        // 金甲没了（比如掉进岩浆）：铁甲换上去就回不来了
        h.simulateSwap(5, 'iron_helmet', { keepOldInPack: false });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(h.bot.output).toContain('招来猪灵');
        expect(h.bot.output).toContain('猪灵会主动攻击');
        expect(h.wornAt('head')).toBe('iron_helmet'); // 换不回来是事实，但说出来了
    });

    it('主世界：更好的甲**照常换**，但同样有报告（可观测）', async () => {
        const h = armorBot({
            dimension: 'overworld',
            worn: { head: 'golden_helmet' },
            items: [stack('iron_helmet')],
        });
        installArmorGuard(h.bot);
        h.simulateSwap(5, 'iron_helmet');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(h.wornAt('head')).toBe('iron_helmet'); // 没被换回去
        expect(h.equipped).toHaveLength(0); // 守卫没有插手
        expect(h.bot.output).toContain('护甲变化');
        expect(h.bot.output).not.toContain('招来猪灵');
    });

    it('任何护甲变化都**不许静默**：主世界/末地/下界的换甲都会留一行', async () => {
        for (const dimension of ['overworld', 'the_end', 'the_nether']) {
            const h = armorBot({ dimension, worn: { torso: 'leather_chestplate' }, items: [] });
            installArmorGuard(h.bot);
                h.simulateSwap(6, 'iron_chestplate');
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(h.bot.output, dimension).toContain('护甲变化');
            expect(h.bot.output, dimension).toContain('leather_chestplate → iron_chestplate');
        }
    });

    it('插件的 `equipAll` 也被包住：下界批量穿甲后金甲仍在', async () => {
        const h = armorBot({
            dimension: 'the_nether',
            worn: { head: 'golden_helmet' },
            items: [stack('iron_helmet')],
        });
        // 模拟插件自己挂上去的 equipAll（就是它会把金甲换成铁甲）
        h.bot.armorManager = {
            equipAll: async () => {
                h.simulateSwap(5, 'iron_helmet');
            },
        };
        installArmorGuard(h.bot);
        await h.bot.armorManager.equipAll();

        expect(h.wornAt('head')).toBe('golden_helmet'); // 批量穿甲后也被纠回来
        expect(h.bot.output).toContain('换回');
    });

    it('非下界时 enforceGoldInNether 什么都不做（不会乱动主世界的甲）', async () => {
        const h = armorBot({ dimension: 'overworld', worn: { head: 'iron_helmet' }, items: [stack('golden_helmet')] });
        const lines = await enforceGoldInNether(h.bot);
        expect(lines).toEqual([]);
        expect(h.wornAt('head')).toBe('iron_helmet');
        expect(h.equipped).toHaveLength(0);
    });

    it('下界里穿着铁甲、背包有金甲 ⇒ 换回金（`equipAll` 路径的兜底）', async () => {
        const h = armorBot({ dimension: 'the_nether', worn: { head: 'iron_helmet' }, items: [stack('golden_helmet')] });
        const lines = await enforceGoldInNether(h.bot);
        expect(lines).toHaveLength(1);
        expect(h.wornAt('head')).toBe('golden_helmet');
        expect(h.bot.output).toContain('金甲让猪灵保持中立');
    });

    it('`equip` 说成功但槽位没变 ⇒ **不许说"已换回"**（证据不是返回值）', async () => {
        const h = armorBot({ dimension: 'the_nether', worn: { head: 'iron_helmet' }, items: [stack('golden_helmet')] });
        // equip 返回 true 但什么都没穿上（真实世界里的"点了没反应"）
        const lines = await enforceGoldInNether(h.bot, { equip: async () => true });
        expect(h.wornAt('head')).toBe('iron_helmet');
        expect(lines[0]).toContain('没成功');
        expect(lines[0]).toContain('猪灵会主动攻击');
        expect(lines[0]).not.toContain('已把');
    });

    it('接线：mcdata.ts 在加载 armor-manager 之后装了守卫', () => {
        const source = readFileSync(new URL('../src/body/data/mcdata.ts', import.meta.url), 'utf8');
        expect(source).toContain("import { installArmorGuard } from '../library/armor_guard.js';");
        expect(source).toContain('bot.loadPlugin(armorManager)');
        expect(source.indexOf('installArmorGuard(bot)')).toBeGreaterThan(source.indexOf('bot.loadPlugin(armorManager)'));
    });
});
