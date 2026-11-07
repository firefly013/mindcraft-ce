/**
 * 末地相关的纯逻辑单元测试（剩下的部分）。
 *
 * 这里**不需要 MC 服务端**：`src/body/library/endgame.ts` 只吃普通数据。
 * 现在覆盖的只有三块：药水识别、死亡回收、末影之眼的方向几何。
 */
import { describe, expect, it } from 'vitest';
import {
    COMPASS_POINTS,
    ITEM_DESPAWN_SECONDS,
    MIN_EYE_TRAVEL,
    activeEffectSeconds,
    compassBearing,
    describeEyeDirection,
    findNegativeEffect,
    findPotionItem,
    hasActiveEffect,
    planRecovery,
    potionKindOf,
    potionStock,
    trackEyeFlight,
    vec,
    type EyeSample,
} from '../src/body/library/endgame.js';

describe('药水识别（多种 NBT/组件形状）', () => {
    it('1.20.4 的 nbt.value.Potion 两种嵌套都认', () => {
        expect(potionKindOf({ name: 'potion', nbt: { value: { Potion: { value: 'minecraft:long_slow_falling' } } } })).toBe('slow_falling');
        expect(potionKindOf({ name: 'potion', nbt: { value: { Potion: 'minecraft:strong_healing' } } })).toBe('healing');
    });

    it('1.20.5+ 的 potion_contents 组件（对象和数组两种形状）都认', () => {
        expect(potionKindOf({ name: 'splash_potion', components: { potion_contents: { potion: 'minecraft:long_resistance' } } })).toBe('resistance');
        expect(
            potionKindOf({ name: 'lingering_potion', components: [{ type: 'potion_contents', data: { potion: 'minecraft:regeneration' } }] })
        ).toBe('regeneration');
    });

    it('turtle_master 归到抗性，牛奶单独一类，石头不是药水', () => {
        expect(potionKindOf({ name: 'potion', potion: 'minecraft:turtle_master' })).toBe('resistance');
        expect(potionKindOf({ name: 'milk_bucket' })).toBe('milk');
        expect(potionKindOf({ name: 'stone' })).toBeNull();
        expect(potionKindOf(null)).toBeNull();
    });

    it('药水但读不到 id → other（绝不猜成有效）', () => {
        expect(potionKindOf({ name: 'potion' })).toBe('other');
    });

    it('findPotionItem / potionStock 按大类统计', () => {
        const items = [
            { name: 'potion', nbt: { value: { Potion: 'minecraft:slow_falling' } } },
            { name: 'potion', nbt: { value: { Potion: 'minecraft:long_slow_falling' } } },
            { name: 'potion', nbt: { value: { Potion: 'minecraft:long_resistance' } } },
            { name: 'milk_bucket' },
            { name: 'stone' },
        ];
        expect(findPotionItem(items, 'resistance')?.name).toBe('potion');
        expect(findPotionItem(items, 'strength')).toBeNull();
        const stock = potionStock(items);
        expect(stock.slow_falling).toBe(2);
        expect(stock.resistance).toBe(1);
        expect(stock.milk).toBe(1);
        expect(stock.healing).toBe(0);
    });

    it('Buff 判定用名字包含，读剩余秒数', () => {
        const effects = [
            { name: 'Slow Falling', seconds: 90, amplifier: 0 },
            { name: 'Resistance', seconds: null, amplifier: 1 },
        ];
        expect(hasActiveEffect(effects, 'slow_falling')).toBe(true);
        expect(hasActiveEffect(effects, 'fire_resistance')).toBe(false);
        expect(activeEffectSeconds(effects, 'slow_falling')).toBe(90);
        expect(activeEffectSeconds(effects, 'resistance')).toBeNull();
    });
});

describe('死亡回收', () => {
    it('掉进虚空 = 东西没了，别去捡', () => {
        const plan = planRecovery({
            deathDimension: 'the_end',
            deathPosition: vec(0, -80, 0),
            secondsSinceDeath: 10,
            fellOutOfWorld: true,
        });
        expect(plan.itemOutlook).toBe('lost');
        expect(plan.steps.join()).toContain('虚空');
    });

    it('末地死亡：区块有人 → 按 5 分钟倒计时算剩余时间', () => {
        const plan = planRecovery({
            deathDimension: 'the_end',
            deathPosition: vec(12, 64, 3),
            overworldPortal: vec(300, 30, -120),
            secondsSinceDeath: 60,
            chunkLoadedSinceDeath: true,
        });
        expect(plan.secondsLeft).toBe(ITEM_DESPAWN_SECONDS - 60);
        expect(plan.itemOutlook).toBe('high');
        expect(plan.steps.join()).toContain('300,30,-120');
    });

    it('区块没人 → 不倒计时，先别慌', () => {
        const plan = planRecovery({
            deathDimension: 'the_end',
            deathPosition: vec(12, 64, 3),
            secondsSinceDeath: 9999,
            chunkLoadedSinceDeath: false,
        });
        expect(plan.secondsLeft).toBeNull();
        expect(plan.itemOutlook).toBe('high');
        expect(plan.message).toContain('未计时');
    });

    it('有记录的主世界传送门就顺着它回去；没设重生点要提醒', () => {
        const plan = planRecovery({
            deathDimension: 'the_end',
            deathPosition: vec(12, 64, 3),
            overworldPortal: vec(300, 30, -120),
            secondsSinceDeath: 5,
            chunkLoadedSinceDeath: true,
        });
        expect(plan.steps.join()).toContain('一直亮着');

        const plan2 = planRecovery({ deathDimension: 'the_end', deathPosition: vec(12, 64, 3), secondsSinceDeath: 5 });
        expect(plan2.steps.join()).toContain('重生点未设置');
    });
});

describe('负面效果识别', () => {
    it('findNegativeEffect 认得中毒/缓慢，不把缓降当负面', () => {
        expect(findNegativeEffect([{ name: 'Slowness', seconds: 5, amplifier: 0 }])).toBe('slowness');
        expect(findNegativeEffect([{ name: 'slow_falling', seconds: 5, amplifier: 0 }])).toBeNull();
    });
});

describe('末影之眼：方向是唯一线索，必须量准（+X 东 / +Z 南）', () => {
    const origin = vec(0, 64, 0);

    it('八个方向都能认出来', () => {
        const cases: Array<[number, number, string]> = [
            [10, 0, 'east'],
            [-10, 0, 'west'],
            [0, 10, 'south'],
            [0, -10, 'north'],
            [10, -10, 'northeast'],
            [10, 10, 'southeast'],
            [-10, 10, 'southwest'],
            [-10, -10, 'northwest'],
        ];
        for (const [dx, dz, point] of cases) {
            const bearing = compassBearing(origin, vec(dx, 64, dz));
            expect(bearing?.point, `${dx},${dz}`).toBe(point);
        }
        expect(COMPASS_POINTS).toHaveLength(8);
    });

    it('方位角 0 = 正北、顺时针；水平距离单独给', () => {
        expect(compassBearing(origin, vec(0, 64, -5))?.degrees).toBeCloseTo(0, 6);
        expect(compassBearing(origin, vec(5, 64, 0))?.degrees).toBeCloseTo(90, 6);
        expect(compassBearing(origin, vec(0, 64, 5))?.degrees).toBeCloseTo(180, 6);
        expect(compassBearing(origin, vec(3, 64, 4))?.distance).toBeCloseTo(5, 6);
    });

    it('重合/坏数据 → null（看不出方向就是看不出，不许编）', () => {
        expect(compassBearing(origin, vec(0, 64, 0))).toBeNull();
        expect(compassBearing(origin, vec(Number.NaN, 64, 0))).toBeNull();
    });

    it('采样轨迹：取最早和最晚两点算方向', () => {
        const samples: EyeSample[] = [
            { position: vec(0, 64, 0) },
            { position: vec(3, 64, 0.2) },
            { position: vec(9, 64, 0.4) },
        ];
        const track = trackEyeFlight(samples);
        expect(track?.point).toBe('east');
        expect(track?.travelled).toBeCloseTo(Math.hypot(9, 0.4), 6);
        expect(track?.samples).toBe(3);
        expect(track?.lastPosition).toEqual(vec(9, 64, 0.4));
    });

    it('首末几乎重合（出手就碎）→ 退而取"位移最大的一对"', () => {
        const samples: EyeSample[] = [
            { position: vec(0, 64, 0) },
            { position: vec(5, 64, 0) },
            { position: vec(0.2, 64, 0) },
        ];
        expect(trackEyeFlight(samples)?.point).toBe('east');
    });

    it('采样点不够 / 位移太小 → null（如实说"没看清"）', () => {
        expect(trackEyeFlight([])).toBeNull();
        expect(trackEyeFlight([{ position: vec(0, 64, 0) }])).toBeNull();
        expect(trackEyeFlight([{ position: vec(0, 64, 0) }, { position: vec(MIN_EYE_TRAVEL / 2, 64, 0) }])).toBeNull();
    });

    it('回执里把方位说成人话，并且明说"这不是到要塞的距离"', () => {
        const track = trackEyeFlight([{ position: vec(0, 64, 0) }, { position: vec(8, 64, 0) }]);
        expect(track).not.toBeNull();
        if (track == null) return;
        const text = describeEyeDirection(track);
        expect(text).toContain('东');
        expect(text).toContain('不是到要塞的距离');
    });
});
