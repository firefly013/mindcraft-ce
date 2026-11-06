/**
 * `stats` 回执：只给状态事实，不做跨调用对比、不追加"没变化/去做个动作"之类的总结。
 */
import { describe, expect, it } from 'vitest';
import { queryList } from '../src/body/commands/queries.js';

const stats = queryList.find((c) => c.name === '!stats') as { perform: (agent: any, type?: unknown) => string };

function botWith(overrides: Record<string, unknown> = {}): any {
    return {
        entity: { position: { x: 1.5, y: 64, z: 2.5 }, velocity: { x: 0, y: 0, z: 0 } },
        health: 20,
        food: 20,
        inventory: { slots: [] },
        game: { gameMode: 'survival' },
        time: { timeOfDay: 6000 },
        blockAt: () => ({ name: 'air' }),
        ...overrides,
    };
}

function agentWith(bot: any): any {
    return {
        bot,
        sampleContext: () => ({ bot }),
        liveStateText: () => '## 当前世界快照\nHeld: main empty',
    };
}

const call = (agent: any, type?: string): string => (stats.perform as any)(agent, type);

describe('stats 回执只报状态', () => {
    it('同一段连续调用两次：两次都给全量状态，不加"和上次相同"的总结', () => {
        const agent = agentWith(botWith());
        const first = call(agent, 'inventory');
        expect(first).toContain('我主手是空的，副手是空的，身上没有穿护甲。');
        expect(first).not.toContain('完全相同');
        expect(first).not.toContain('上一次');

        const second = call(agent, 'inventory');
        expect(second).toContain('我主手是空的，副手是空的，身上没有穿护甲。');
        expect(second).not.toContain('完全相同');
        expect(second).not.toContain('上一次');
    });

    it('背包有变化：状态如实反映 iron_pickaxe', () => {
        const agent = agentWith(botWith());
        call(agent, 'inventory');
        // mineflayer 的 slots 按槽位下标索引：快捷栏 40 号。
        const slots: unknown[] = [];
        slots[40] = { name: 'iron_pickaxe', count: 1 };
        agent.bot.inventory.slots = slots;
        const second = call(agent, 'inventory');
        expect(second).toContain('iron_pickaxe');
    });

    it('all：给 SNAPSHOT 与快照正文，任何变化都直接体现', () => {
        const agent = agentWith(botWith());
        const first = call(agent);
        expect(first).toContain('SNAPSHOT');
        expect(first).not.toContain('完全相同');

        agent.liveStateText = () => '## 当前世界快照\nHeld: main iron_pickaxex1';
        const second = call(agent);
        expect(second).toContain('iron_pickaxex1');
        expect(second).not.toContain('完全相同');
    });

    it('不认识的 type：只回参数说明', () => {
        const agent = agentWith(botWith());
        const text = call(agent, 'nonsense');
        expect(text).toContain('stats 的 type 只能是 all、body、inventory、entities 或 blocks');
        expect(text).toContain('"nonsense"');
    });
});
