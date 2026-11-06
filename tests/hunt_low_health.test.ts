/**
 * huntFor 的**低血门控不能拦"打不还手的食物动物"**（真机 2026-10-23）。
 *
 * 死锁是怎么形成的：血 4.17、食物 5、背包全空。`huntFor` 一进门看到
 * 血量 ≤ MIN_HEALTH_TO_HUNT(6) 就立刻收手，于是拿不到肉；而 Minecraft 在
 * 食物 <18 时**根本不启动自然回血**（已核对 minecraft.wiki/w/Hunger），
 * 血就一直停在 4.17 ⇒ **血低 → 不敢打 → 更没血**。
 *
 * 那条门控的本意是"快死了别去打会还手的东西"，牛/猪/羊/鸡打不还手，
 * 所以它们必须放行；僵尸/骷髅/烈焰人这些会还手的照旧拦。
 */
import { describe, expect, it } from 'vitest';
import { huntForSkill } from '../src/body/library/progression.js';
import { isHarmlessFoodMob } from '../src/body/library/hunt_reach.js';

const noSleep = async (): Promise<void> => {};

function makeBot(options: { health: number; items: Array<{ name: string; count: number }> }) {
    const items = options.items;
    return {
        interrupt_code: false,
        game: { dimension: 'overworld', gameMode: 'survival' },
        health: options.health,
        food: 5,
        entity: { position: { x: 0, y: 64, z: 0 }, effects: {} },
        inventory: { items: () => items },
        entities: {},
        registry: { blocksByName: {} },
        blockAt: () => null,
    } as any;
}

describe('打不还手的食物动物', () => {
    it('名单只有真的不会还手的那几种（山羊会顶、猪灵蛮兽会打，都不在）', () => {
        expect(isHarmlessFoodMob('cow')).toBe(true);
        expect(isHarmlessFoodMob('pig')).toBe(true);
        expect(isHarmlessFoodMob('sheep')).toBe(true);
        expect(isHarmlessFoodMob('chicken')).toBe(true);
        expect(isHarmlessFoodMob('rabbit')).toBe(true);
        expect(isHarmlessFoodMob('mooshroom')).toBe(true);
        expect(isHarmlessFoodMob('minecraft:cow')).toBe(true);

        expect(isHarmlessFoodMob('goat')).toBe(false); // 会顶人
        expect(isHarmlessFoodMob('hoglin')).toBe(false); // 主动攻击
        expect(isHarmlessFoodMob('llama')).toBe(false); // 会吐口水
        expect(isHarmlessFoodMob('zombie')).toBe(false);
        expect(isHarmlessFoodMob('blaze')).toBe(false);
    });

    it('血 4 时打牛**照常打**（这是唯一能回血的路，不能被门控封死）', async () => {
        const items = [{ name: 'beef', count: 0 }];
        const bot = makeBot({ health: 4, items });
        let attacks = 0;
        const receipt = await huntForSkill(bot, 'cow', 2, 48, 60_000, {
            findEntity: () => ({ name: 'cow', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => null,
            attack: async () => {
                attacks += 1;
                items[0].count += 1;
                return true;
            },
            sleep: noSleep,
        });

        expect(attacks).toBe(2);
        expect(receipt).toContain('这次用 huntFor 刷 cow，beef 拿到了 2 个，目标是 2');
        expect(receipt).not.toContain('血量过低');
    });

    it('血 4 时打僵尸**照旧收手**（会还手，门控的本意就在这）', async () => {
        const items = [{ name: 'rotten_flesh', count: 0 }];
        const bot = makeBot({ health: 4, items });
        let attacks = 0;
        const receipt = await huntForSkill(bot, 'zombie', 2, 48, 60_000, {
            findEntity: () => ({ name: 'zombie', position: { x: 3, y: 64, z: 0 } }),
            findDrop: () => null,
            attack: async () => {
                attacks += 1;
                items[0].count += 1;
                return true;
            },
            sleep: noSleep,
        });

        expect(attacks).toBe(0);
        expect(receipt).toContain('这次用 huntFor 刷 zombie，rotten_flesh 拿到了');
        expect(receipt).toContain('这次用 huntFor 刷 zombie，rotten_flesh 拿到了');
    });
});
