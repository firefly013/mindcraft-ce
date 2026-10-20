/**
 * `isHostile` 的回归测试。
 *
 * 这条规则出过两次真机事故，都是同一个形状——**把"是生物"当成"是敌人"**：
 * 1. 旧档（1.20.6）：快照里只有两只 glow_squid，却收到一堆 `hostile_nearby`；
 * 2. 新档（1.21.11）：`salmon` 被判成敌对 ⇒ 自动拾取永远跳过
 *    （原话：`附近有敌对生物 salmon（13 格），这次不去捡掉落物——先保命`）。
 *
 * 根因：mineflayer 运行时实体的 `entity.type` 是**协议层**种类，
 * `'mob'` = "这是个生物"（牛/猪/鱼/鱿鱼都算），不是"敌对"。
 * 1.21.11 里 salmon 的 mcdata `type` 刚好也变成了 `'mob'`，于是版本一升，鱼就成了敌人。
 *
 * 权威判据是 mcdata 的 `category`（`'Hostile mobs'` / `'Passive mobs'`）。
 */
import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import { hostileFromEntityData, isHostile } from '../src/body/data/mcdata.js';

describe('D 敌对判定：真是生物 ≠ 是敌人', () => {
    it('真实 mcdata（1.21.11）：鱼/牛/猪/村民不是敌对，僵尸/骷髅/末影人/烈焰人是', () => {
        const data: any = minecraftData('1.21.11');
        const byName = data.entitiesByName as Record<string, any>;

        for (const name of ['salmon', 'cod', 'tropical_fish', 'cow', 'pig', 'sheep', 'chicken', 'squid', 'glow_squid', 'villager']) {
            expect(hostileFromEntityData(byName[name]), `${name} 不该是敌对`).toBe(false);
        }
        for (const name of ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'blaze', 'witch', 'slime']) {
            expect(hostileFromEntityData(byName[name]), `${name} 该是敌对`).toBe(true);
        }
    });

    it('同一份判定在 1.20.6 上也成立（category 在两个版本都可靠）', () => {
        const data: any = minecraftData('1.20.6');
        const byName = data.entitiesByName as Record<string, any>;
        expect(hostileFromEntityData(byName['salmon'])).toBe(false);
        expect(hostileFromEntityData(byName['zombie'])).toBe(true);
    });

    it('回归钉死：只有 `type: "mob"` 一条信息时，绝不判敌对（这就是那个 bug 的形状）', () => {
        expect(hostileFromEntityData({ type: 'mob' })).toBe(false);
        expect(hostileFromEntityData({ type: 'mob', category: 'Passive mobs' })).toBe(false);
        expect(hostileFromEntityData({ type: 'water_creature' })).toBe(false);
        expect(hostileFromEntityData({ type: 'mob', category: 'Hostile mobs' })).toBe(true);
        expect(hostileFromEntityData({ type: 'hostile' })).toBe(true);
    });

    it('读不到数据 ⇒ 不当敌对（宁可漏报，也不把整片鱼塘当敌人）', () => {
        expect(hostileFromEntityData(null)).toBe(false);
        expect(hostileFromEntityData(undefined)).toBe(false);
        expect(hostileFromEntityData({})).toBe(false);
        expect(hostileFromEntityData({ type: 'unknown_thing' })).toBe(false);
    });

    it('运行时实体走 isHostile：没有 mcdata 时也不得因为 type:"mob" 报敌对', () => {
        // 单元测试环境里 mcdata 未初始化（它只在 bot login 后才有），
        // 这里验证的正是"没有数据 ⇒ 不猜"这条：
        expect(isHostile({ name: 'salmon', type: 'mob' })).toBe(false);
        expect(isHostile({ name: 'zombie', type: 'hostile' })).toBe(false);
        expect(isHostile(null)).toBe(false);
        expect(isHostile({})).toBe(false);
        // 傀儡永远不是敌对（原来就有这两个豁免，别在重构里丢掉）：
        expect(isHostile({ name: 'iron_golem', type: 'mob' })).toBe(false);
        expect(isHostile({ name: 'snow_golem', type: 'mob' })).toBe(false);
        expect(isHostile({ name: 'player', type: 'player' })).toBe(false);
    });
});
