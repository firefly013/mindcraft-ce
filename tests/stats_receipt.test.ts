/**
 * `stats` 反轮询回执：整段逐字相同 → 追加"没变化，去做个动作"；
 * 有任何变化 → 照旧全量、不加戏；不同 type 之间互不串扰。
 *
 * 真机证据：overnight_b 15 分钟调 26 次 stats、overnight_a 15 次。
 */
import { describe, expect, it } from 'vitest';
import { queryList } from '../src/body/commands/queries.js';

const stats = queryList.find((c) => c.name === '!stats')!;

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

describe('stats 反轮询回执', () => {
    it('同一段第二次调用逐字相同：追加"完全相同 + 去做个动作"，状态一行不少', () => {
        const agent = agentWith(botWith());
        const first = call(agent, 'inventory');
        expect(first).not.toContain('完全相同');
        expect(first).toContain('Backpack');

        const second = call(agent, 'inventory');
        expect(second).toContain('完全相同');
        expect(second).toContain('做一个动作');
        expect(second).toContain('原地停摆');
        // 有动作在跑时别鼓励重复发——真实场景里模型就是在 exploreFor 跑着时反复 stats。
        expect(second).toContain('别重复发');
        expect(second).toContain('Backpack');
    });

    it('背包有变化：不说"完全相同"，全量照发', () => {
        const agent = agentWith(botWith());
        call(agent, 'inventory');
        // mineflayer 的 slots 按槽位下标索引：快捷栏 40 号。
        const slots: unknown[] = [];
        slots[40] = { name: 'iron_pickaxe', count: 1 };
        agent.bot.inventory.slots = slots;
        const second = call(agent, 'inventory');
        expect(second).not.toContain('完全相同');
        expect(second).toContain('iron_pickaxe');
    });

    it('换了 type 不算重复：各段各记各的', () => {
        const agent = agentWith(botWith());
        call(agent, 'inventory');
        const bodyFirst = call(agent, 'body');
        expect(bodyFirst).not.toContain('完全相同');
    });

    it('all：整份快照逐字相同才提示；一变就不提示', () => {
        const agent = agentWith(botWith());
        const first = call(agent);
        expect(first).toContain('SNAPSHOT');
        expect(first).not.toContain('完全相同');

        const second = call(agent);
        expect(second).toContain('完全相同');

        agent.liveStateText = () => '## 当前世界快照\nHeld: main iron_pickaxex1';
        const third = call(agent);
        expect(third).not.toContain('完全相同');
        expect(third).toContain('iron_pickaxex1');
    });

    it('不认识的 type 仍旧只回参数说明，不碰缓存', () => {
        const agent = agentWith(botWith());
        const text = call(agent, 'nonsense');
        expect(text).toContain('stats 的 type 只认这些');
        expect(text).not.toContain('完全相同');
    });
});
