/**
 * 「避开 X」永远不能用在「你此刻正站在 X 里」上 —— 用户 2026-10-18 的原话。
 *
 * 真机两次被自己的安全策略锁死：
 *   - overnight_b（21:37）1×1 水坑，rung 1 原话「你**正站在水里**：避水规则把
 *     所有相邻格都判成危险，A* 因此一步都走不出去」；
 *   - overnight_a（21:44）垂直水柱，同层一步外就是草地，却只能一直上浮。
 *
 * 这里钉的是规则本身：**按状态**评估（每次寻路重新读 bot 位置），**泛化**到整个
 * `blocksToAvoid`，且**不许泄漏**到普通移动（在岸上就继续严格避水）。
 */
import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import { applySafety, movementsFor, relaxAvoidedTypesBotIsInside, waterBlockId } from '../src/body/safety/movements.js';

const MC_VERSION = '1.20.4';
const registry: any = minecraftData(MC_VERSION);

interface BlockCell { name: string; type: number; }

function worldBot(cells: Map<string, string>, pos: { x: number; y: number; z: number }): any {
    const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
    return {
        registry,
        version: MC_VERSION,
        entity: { position: pos },
        blockAt: (p: any): BlockCell => {
            const x = Math.floor(Number(p?.x));
            const y = Math.floor(Number(p?.y));
            const z = Math.floor(Number(p?.z));
            const name = cells.get(key(x, y, z)) ?? 'air';
            const def = registry.blocksByName[name];
            return { name, type: typeof def?.id === 'number' ? def.id : 0 };
        },
    };
}

const WATER = registry.blocksByName.water.id as number;
const FIRE = registry.blocksByName.fire.id as number;

describe('避让是状态不是常量：站在水里 ⇒ 水对该次搜索可通行', () => {
    it('bot 站在水里：water 不在 blocksToAvoid 里（否则 A* 连第一步都没有）', () => {
        const cells = new Map<string, string>([['0,60,0', 'water'], ['0,59,0', 'stone']]);
        const bot = worldBot(cells, { x: 0.5, y: 60, z: 0.5 });
        const movements = movementsFor(bot);
        expect(movements.blocksToAvoid.has(WATER), '站在水里还把水当禁区 = 把自己锁死').toBe(false);
    });

    it('bot 在岸上：water 依旧在 blocksToAvoid 里（普通移动必须避水，不许回归）', () => {
        const cells = new Map<string, string>([['0,61,0', 'stone']]);
        const bot = worldBot(cells, { x: 0.5, y: 62, z: 0.5 });
        const movements = movementsFor(bot);
        expect(movements.blocksToAvoid.has(WATER)).toBe(true);
    });

    it('离开水之后的**下一次**寻路恢复避水（不缓存、不泄漏）', () => {
        const cells = new Map<string, string>([['0,60,0', 'water'], ['1,60,0', 'water'], ['2,60,0', 'stone']]);
        const inWater = worldBot(cells, { x: 0.5, y: 60, z: 0.5 });
        expect(movementsFor(inWater).blocksToAvoid.has(WATER)).toBe(false);
        // 同一套 cells，bot 已经上到 (2,61) 的干地上
        const onLand = worldBot(cells, { x: 2.5, y: 61, z: 0.5 });
        expect(movementsFor(onLand).blocksToAvoid.has(WATER)).toBe(true);
    });

    it('泛化：被避开的**任何类型**，只要 bot 身体此刻在里面，就从这套 Movements 里放开', () => {
        // 受控的 blocksToAvoid（不依赖库默认值里恰好有 fire）。
        const bot = worldBot(new Map([['0,60,0', 'fire']]), { x: 0.5, y: 60, z: 0.5 });
        const movements: any = { blocksToAvoid: new Set([WATER, FIRE]), maxDropDown: 0 };
        applySafety(bot, movements);
        expect(movements.blocksToAvoid.has(FIRE), '站在火星里却还"避开火"：第一步就无路可走').toBe(false);
        expect(movements.blocksToAvoid.has(WATER), '不在水里就别顺手放开水').toBe(true);
    });

    it('relaxAvoidedTypesBotIsInside 只摘"身体所在"的类型，并返回摘了哪些', () => {
        const bot = worldBot(new Map([['0,60,0', 'water']]), { x: 0.5, y: 60, z: 0.5 });
        const movements: any = { blocksToAvoid: new Set([WATER, FIRE]) };
        const relaxed = relaxAvoidedTypesBotIsInside(bot, movements);
        expect(relaxed).toEqual([WATER]);
        expect([...movements.blocksToAvoid]).toEqual([FIRE]);
    });

    it('读不到位置/方块时不许崩（空 bot、null 都行）', () => {
        expect(() => movementsFor({ registry, version: MC_VERSION })).not.toThrow();
        expect(movementsFor({ registry, version: MC_VERSION }).blocksToAvoid.has(WATER)).toBe(true);
        expect(relaxAvoidedTypesBotIsInside(null, { blocksToAvoid: new Set([WATER]) })).toEqual([]);
        expect(waterBlockId({ registry })).toBe(WATER);
    });
});
