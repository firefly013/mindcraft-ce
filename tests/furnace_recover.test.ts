/**
 * **炉子不能被一次性污染**（Lead 2026-10-23 当面质疑：
 * "`--output` 只碰产物槽，取不出燃料槽里的东西——这个炉子已经被永久污染了。这怎么行？"）。
 *
 * 真机现场：一把石镐被误投进燃料槽，产物槽是空的，`useBlock(type=furnace, output=…)`
 * 又只认产物槽 ⇒ 工具取不回来，炉子连带里面的东西一起废掉。
 * `recoverFromContainerSlots` 就是补这条路：产物槽取不到时，按**请求的物品名**
 * 去原料/燃料槽里找，找到就取回，并在回执里点名是从哪个槽取的。
 */
import { describe, expect, it } from 'vitest';
import { recoverFromContainerSlots } from '../src/body/commands/interact.js';

/** 一个最小的假熔炉：slots 里能读能 withdraw（把物品挪到"背包"）。 */
function fakeFurnace(slots: Array<{ name?: string; type?: number; count?: number } | null>) {
    const bag: Array<{ name: string; count: number }> = [];
    const furnace = {
        slots,
        inventoryStart: 3,
        withdraw: async (type: number, _metadata: unknown, count: number) => {
            const index = slots.findIndex((slot) => slot != null && slot.type === type);
            if (index < 0) throw new Error('not found');
            const slot = slots[index]!;
            slot.count = (slot.count ?? 0) - count;
            bag.push({ name: String(slot.name), count });
            if ((slot.count ?? 0) <= 0) slots[index] = null;
        },
        bag,
    };
    return furnace;
}

/** 让 countInInventory 能看到"背包"：它读 bot.inventory.items()。 */
function fakeBot(bag: Array<{ name: string; count: number }>) {
    return {
        inventory: {
            items: () => bag.map((entry) => ({ name: entry.name, count: entry.count, type: 1 })),
        },
    };
}

const item = (name: string, count = 1) => ({ name, count, countGiven: true }) as never;

describe('recoverFromContainerSlots：误投进燃料槽/原料槽的东西能取回来', () => {
    it('燃料槽里的石镐 → 取回，并点明"燃料槽"', async () => {
        const furnace = fakeFurnace([null, { name: 'stone_pickaxe', type: 923, count: 1 }, null, null]);
        const bot = fakeBot(furnace.bag);
        const text = await recoverFromContainerSlots(bot, furnace, item('stone_pickaxe'), 'furnace');
        expect(text).not.toBeNull();
        expect(text!).toContain('燃料槽');
        expect(text!).toContain('取回');
        expect(furnace.slots[1]).toBeNull(); // 真的挪走了
        expect(furnace.bag).toHaveLength(1);
    });

    it('原料槽里的生铁也能取回（点名"原料槽"）', async () => {
        const furnace = fakeFurnace([{ name: 'raw_iron', type: 1, count: 3 }, null, null, null]);
        const bot = fakeBot(furnace.bag);
        const text = await recoverFromContainerSlots(bot, furnace, item('raw_iron', 3), 'furnace');
        expect(text!).toContain('原料槽');
        expect(furnace.bag[0]).toEqual({ name: 'raw_iron', count: 3 });
    });

    it('槽里没有这件东西 ⇒ null（调用方继续报"产物槽是空的"）', async () => {
        const furnace = fakeFurnace([null, { name: 'coal', type: 5, count: 2 }, null, null]);
        const bot = fakeBot(furnace.bag);
        expect(await recoverFromContainerSlots(bot, furnace, item('stone_pickaxe'), 'furnace')).toBeNull();
    });

    it('取不出来时**如实说**（不假装成功，也不静默）', async () => {
        const furnace = fakeFurnace([null, { name: 'stone_pickaxe', type: 923, count: 1 }, null, null]);
        furnace.withdraw = async () => {
            throw new Error('destination full');
        };
        const bot = fakeBot([]);
        const text = await recoverFromContainerSlots(bot, furnace, item('stone_pickaxe'), 'furnace');
        expect(text!).toContain('取不出来');
        expect(text!).toContain('destination full');
    });
});
