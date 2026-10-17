/**
 * 末地通关纯逻辑的单元测试。
 *
 * 这里**不需要 MC 服务端**：`src/body/library/endgame.ts` 只吃普通数据。
 * 爆炸伤害用的是 Wiki「Explosion § Damage」的原公式，几组期望值是照公式手算的，
 * 改动公式时这些数字会当场拦下来。
 */
import { describe, expect, it } from 'vitest';
import {
    BREATH_HARM_RADIUS,
    DRAGON_MAX_HEALTH,
    END_PODIUM,
    EXPLOSION_POWER,
    ITEM_DESPAWN_SECONDS,
    PLATFORM_BLOCKS,
    activeEffectSeconds,
    assessEndGear,
    bedDamageVsDragon,
    bedsNeeded,
    blastRadius,
    countBedsIn,
    explosionDamage,
    explosionDamageToPlayer,
    findPotionItem,
    formatEndgameReport,
    hasActiveEffect,
    nextEndgameStep,
    planBedBombing,
    planBreathEscape,
    planCrystalAssault,
    planPillarCover,
    planRecovery,
    potionKindOf,
    potionStock,
    vec,
    type BreathCloud,
    type EndCrystalInfo,
} from '../src/body/library/endgame.js';

describe('爆炸伤害公式（照 Wiki 原式手算）', () => {
    it('威力 5 贴脸 = 71 点：7*5*(1+1)+1', () => {
        expect(explosionDamage(EXPLOSION_POWER.bed, 0, 1)).toBeCloseTo(71, 6);
    });

    it('威力 6 贴脸 = 85 点：7*6*(1+1)+1', () => {
        expect(explosionDamage(EXPLOSION_POWER.endCrystal, 0, 1)).toBeCloseTo(85, 6);
    });

    it('半径之外一律 0，半径之内至少 1', () => {
        const power = EXPLOSION_POWER.bed;
        expect(explosionDamage(power, blastRadius(power), 1)).toBe(0);
        expect(explosionDamage(power, blastRadius(power) + 0.001, 1)).toBe(0);
        // 距离刚好压线也是 0（公式里 impact=0）
        expect(explosionDamage(power, blastRadius(power) - 0.001, 1)).toBeGreaterThan(0);
        // 压线附近按公式算出来是 1.0035（末尾那个 +1 保证至少 1 点）
        const edge = explosionDamage(power, blastRadius(power) - 0.001, 1);
        expect(edge).toBeGreaterThan(1);
        expect(edge).toBeLessThan(1.01);
    });

    it('暴露度 0（完全挡住）也只是"伤害=1"，不是 0', () => {
        expect(explosionDamage(EXPLOSION_POWER.bed, 0, 0)).toBeCloseTo(1, 6);
    });

    it('非法输入不抛异常、返回 0', () => {
        expect(explosionDamage(0, 0, 1)).toBe(0);
        expect(explosionDamage(5, -1, 1)).toBe(0);
        expect(explosionDamage(5, Number.NaN, 1)).toBe(0);
        expect(explosionDamage(5, 0, Number.NaN)).toBeCloseTo(1, 6);
    });

    it('玩家结算：护甲/爆炸保护/抗性分别乘算（钻石套+爆炸保护IV+抗性II ≈ 5.79）', () => {
        const dmg = explosionDamageToPlayer(EXPLOSION_POWER.bed, 0, 1, {
            armorPoints: 20,
            blastProtectionLevel: 4,
            resistanceLevel: 2,
        });
        expect(dmg).toBeCloseTo(5.7936, 3);
    });

    it('简单难度用 min(d/2+1, d)', () => {
        const normal = explosionDamageToPlayer(EXPLOSION_POWER.bed, 0, 1, { armorPoints: 20, blastProtectionLevel: 4, resistanceLevel: 2 });
        const easy = explosionDamageToPlayer(EXPLOSION_POWER.bed, 0, 1, {
            armorPoints: 20,
            blastProtectionLevel: 4,
            resistanceLevel: 2,
            difficulty: 'easy',
        });
        expect(easy).toBeLessThan(normal);
        expect(easy).toBeCloseTo(Math.min(normal / 2 + 1, normal), 6);
    });
});

describe('床炸龙', () => {
    it('床离龙头 1 格内打满 1/4 血（50），3 格外等于白炸', () => {
        expect(bedDamageVsDragon(0)).toBeCloseTo(DRAGON_MAX_HEALTH * 0.25, 6);
        expect(bedDamageVsDragon(1)).toBeCloseTo(50, 6);
        expect(bedDamageVsDragon(2)).toBeCloseTo(25, 6);
        expect(bedDamageVsDragon(3)).toBe(0);
        expect(bedDamageVsDragon(30)).toBe(0);
    });

    it('满血龙要 4 张床', () => {
        expect(bedsNeeded(DRAGON_MAX_HEALTH)).toBe(4);
        expect(bedsNeeded(50)).toBe(1);
        expect(bedsNeeded(51)).toBe(2);
        expect(bedsNeeded(0)).toBe(0);
        expect(bedsNeeded(-5)).toBe(0);
    });

    it('裸站床边 = 自杀：直接判 lethal、ok=false', () => {
        const plan = planBedBombing({
            dragonHead: vec(0, 65, 0),
            bedCell: vec(1, 64, 0),
            standCell: vec(2, 64, 0),
        });
        expect(plan.lethal).toBe(true);
        expect(plan.ok).toBe(false);
        expect(plan.method).toBe('run');
        expect(plan.reason).toContain('打死自己');
    });

    it('钻进传送门结构/有掩体 → 自伤可控、方案可用', () => {
        const plan = planBedBombing({
            dragonHead: vec(0, 65, 0),
            bedCell: vec(1, 64, 0),
            standCell: vec(2, 64, 0),
            inTrench: true,
        });
        expect(plan.method).toBe('cover');
        expect(plan.lethal).toBe(false);
        expect(plan.ok).toBe(true);
        // 床在龙脚边、龙头高 1 格：3D 距离 ≈ 1.414，按 1~3 格线性衰减约 39.6
        expect(plan.expectedDragonDamage).toBeGreaterThan(30);
        expect(plan.expectedDragonDamage).toBeLessThanOrEqual(50);
    });

    it('退路方案会给出"退到爆炸半径外"的具体目标格', () => {
        const standCell = vec(4, 64, 0);
        const plan = planBedBombing({
            dragonHead: vec(0, 65, 0),
            bedCell: vec(0, 64, 0),
            standCell,
        });
        expect(plan.method).toBe('run');
        expect(plan.retreatDistance).toBe(blastRadius(EXPLOSION_POWER.bed));
        expect(plan.retreat).toBeDefined();
        // 退的方向是远离床：x 必须继续变大
        const retreat = plan.retreat;
        expect(retreat).toBeDefined();
        expect(retreat?.x).toBeGreaterThan(standCell.x);
    });

    it('床离龙头太远 → 拒绝（不浪费床也不把自己搭进去）', () => {
        const plan = planBedBombing({
            dragonHead: vec(0, 65, 0),
            bedCell: vec(20, 64, 0),
            standCell: vec(24, 64, 0),
            inTrench: true,
        });
        expect(plan.expectedDragonDamage).toBe(0);
        expect(plan.ok).toBe(false);
        expect(plan.warnings.join()).toContain('打不掉多少血');
    });

    it('抗性+爆炸保护能把自伤压下来，但没掩体仍走 run 方案', () => {
        const plan = planBedBombing({
            dragonHead: vec(0, 65, 0),
            bedCell: vec(1, 64, 0),
            standCell: vec(2, 64, 0),
            mitigation: { armorPoints: 20, blastProtectionLevel: 4, resistanceLevel: 2 },
        });
        expect(plan.selfRawDamage).toBeCloseTo(explosionDamage(EXPLOSION_POWER.bed, 1, 1), 6);
        expect(plan.selfFinalDamage).toBeLessThan(plan.selfRawDamage);
    });
});

describe('躲龙息', () => {
    it('没有云就不动', () => {
        const escape = planBreathEscape({ self: vec(0, 64, 0), clouds: [] });
        expect(escape.inside).toBe(false);
        expect(escape.urgency).toBe('none');
        expect(escape.distanceToMove).toBe(0);
        expect(escape.reason).toContain('没有龙息云');
    });

    it('站在云里 → sprint，并给出朝外跑的格子', () => {
        const clouds: BreathCloud[] = [{ position: vec(0, 64, 0), radius: BREATH_HARM_RADIUS }];
        const escape = planBreathEscape({ self: vec(0, 64, 0), clouds });
        expect(escape.inside).toBe(true);
        expect(escape.urgency).toBe('sprint');
        expect(escape.escapeDirection.dx !== 0 || escape.escapeDirection.dz !== 0).toBe(true);
        expect(Math.hypot(escape.escapeTarget.x - 0, escape.escapeTarget.z - 0)).toBeGreaterThan(BREATH_HARM_RADIUS);
    });

    it('差一层楼高的云不算同一层（y 差 > 1）', () => {
        const clouds: BreathCloud[] = [{ position: vec(0, 67, 0), radius: BREATH_HARM_RADIUS }];
        const escape = planBreathEscape({ self: vec(0, 64, 0), clouds });
        expect(escape.inside).toBe(false);
    });

    it('龙在传送门上低头、而我在 20 格内 → 预警要撤', () => {
        const escape = planBreathEscape({ self: vec(5, 64, 0), clouds: [], dragonPerched: true });
        expect(escape.dangerFromPerch).toBe(true);
        expect(escape.urgency).toBe('move');
        expect(escape.podiumDistance).toBeCloseTo(5, 6);
    });

    it('离传送门 20 格外、龙再低头也不喷我', () => {
        const escape = planBreathEscape({ self: vec(25, 64, 0), clouds: [], dragonPerched: true });
        expect(escape.dangerFromPerch).toBe(false);
    });

    it('END_PODIUM 就是 (0,64,0)', () => {
        expect(END_PODIUM).toEqual({ x: 0, y: 64, z: 0 });
    });
});

describe('掩体/柱子', () => {
    it('躲到离龙最远的那侧柱背', () => {
        const plan = planPillarCover({
            self: vec(10, 64, 0),
            dragon: vec(0, 64, 0),
            pillars: [vec(24, 64, 0), vec(0, 64, 24)],
        });
        expect(plan.ok).toBe(true);
        expect(plan.pillar).toEqual(vec(24, 64, 0));
        // 躲的位置必须比柱子本体更远离龙 → 柱子挡在中间
        const distPillarToDragon = Math.hypot(24, 0);
        const hideCell = plan.hideCell;
        expect(hideCell).toBeDefined();
        const distHideToDragon = Math.hypot(hideCell?.x ?? 0, hideCell?.z ?? 0);
        expect(distHideToDragon).toBeGreaterThan(distPillarToDragon);
    });

    it('周围没柱子 → 明确说找不到、让人现搭墙', () => {
        const plan = planPillarCover({ self: vec(10, 64, 10), dragon: vec(0, 64, 0), pillars: [], maxDistance: 8 });
        expect(plan.ok).toBe(false);
        expect(plan.reason).toContain('没有黑曜石柱');
    });
});

describe('拆末地水晶', () => {
    const crystals: EndCrystalInfo[] = [
        { id: 1, position: vec(20, 70, 0), caged: true },
        { id: 2, position: vec(10, 70, 0) },
        { id: 3, position: vec(-30, 80, 0) },
    ];

    it('先射地面能打到的（近的优先），笼中的排最后', () => {
        const plan = planCrystalAssault({ crystals, self: vec(0, 64, 0), hasPickaxe: true });
        expect(plan.total).toBe(3);
        expect(plan.cagedCount).toBe(1);
        expect(plan.targets[0]?.crystal.id).toBe(2);
        expect(plan.targets[1]?.crystal.id).toBe(3);
        expect(plan.targets[2]?.crystal.id).toBe(1);
        expect(plan.targets[2]?.method).toBe('climb_cage');
        expect(plan.targets[2]?.risk).toBe('high');
    });

    it('有 TNT 就优先用 TNT 掏笼子（比贴脸拆安全）', () => {
        const plan = planCrystalAssault({ crystals, self: vec(0, 64, 0), hasPickaxe: true, tntCount: 2 });
        const cagedTarget = plan.targets.find((t) => t.crystal.caged === true);
        expect(cagedTarget).toBeDefined();
        expect(cagedTarget?.method).toBe('tnt_cage');
        expect(cagedTarget?.note).toContain('TNT');
    });

    it('推荐站位在爆炸半径（12 格）之外', () => {
        const plan = planCrystalAssault({ crystals, self: vec(0, 64, 0) });
        expect(plan.safeShootDistance).toBe(blastRadius(EXPLOSION_POWER.endCrystal));
        for (const target of plan.targets) {
            expect(Math.hypot(target.standPoint.x - target.crystal.position.x, target.standPoint.z - target.crystal.position.z)).toBeCloseTo(
                plan.safeShootDistance,
                6
            );
        }
        expect(plan.message).toContain('笼中 1 颗');
    });

    it('全死了就直说可以去打龙', () => {
        const plan = planCrystalAssault({ crystals: crystals.map((c) => ({ ...c, alive: false })), self: vec(0, 64, 0) });
        expect(plan.total).toBe(0);
        expect(plan.targets).toHaveLength(0);
        expect(plan.message).toContain('全拆完');
    });
});

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

describe('进末地装备清单', () => {
    it('bedrock 不算床（名字里别把 bed 前缀当成床）', () => {
        expect(countBedsIn({ bedrock: 64, white_bed: 2 })).toBe(2);
        expect(countBedsIn({ bedrock: 64 })).toBe(0);
    });

    it('没床没 TNT 没弓没方块 → 硬缺口，明确说别进去', () => {
        const report = assessEndGear({ inventory: { bedrock: 64 } });
        expect(report.ok).toBe(false);
        expect(report.fatal.join()).toContain('没有任何能伤龙的手段');
        expect(report.message).toContain('先别进末地');
    });

    it('清单齐全 → ok，并且没带缓降药水一定给警告', () => {
        const complete = assessEndGear({
            inventory: {
                white_bed: 4,
                obsidian: 64,
                water_bucket: 1,
                bow: 1,
                arrow: 32,
                cooked_beef: 8,
                ender_pearl: 4,
                iron_pickaxe: 1,
                golden_apple: 2,
            },
            items: [
                { name: 'potion', nbt: { value: { Potion: 'minecraft:long_slow_falling' } } },
                { name: 'potion', nbt: { value: { Potion: 'minecraft:slow_falling' } } },
                { name: 'milk_bucket' },
                { name: 'potion', nbt: { value: { Potion: 'minecraft:long_resistance' } } },
                { name: 'potion', nbt: { value: { Potion: 'minecraft:regeneration' } } },
            ],
            armorPoints: 20,
        });
        expect(complete.ok).toBe(true);
        expect(complete.warnings).toHaveLength(0);

        const noSlowFalling = assessEndGear({
            inventory: { white_bed: 4, obsidian: 64 },
            armorPoints: 20,
        });
        expect(noSlowFalling.ok).toBe(true);
        expect(noSlowFalling.warnings.join()).toContain('缓降药水');
    });

    it('平台方块清单里确实有常用方块（防止清单被写成空数组）', () => {
        expect(PLATFORM_BLOCKS).toContain('obsidian');
        expect(PLATFORM_BLOCKS).toContain('end_stone');
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
        expect(plan.message).toContain('不倒计时');
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
        expect(plan2.steps.join()).toContain('没有设重生点');
    });
});

describe('阶段状态机', () => {
    it('从"什么都没准备"一路推到 done', () => {
        expect(nextEndgameStep({}).phase).toBe('prepare');
        expect(nextEndgameStep({ gearReady: true }).phase).toBe('travel_stronghold');
        expect(nextEndgameStep({ gearReady: true, strongholdFound: true }).phase).toBe('activate_portal');
        expect(nextEndgameStep({ gearReady: true, strongholdFound: true, portalActivated: true }).phase).toBe('enter_end');
        expect(
            nextEndgameStep({ gearReady: true, strongholdFound: true, portalActivated: true, inEnd: true, crystalsAlive: 10 }).phase
        ).toBe('clear_crystals');
        expect(
            nextEndgameStep({ gearReady: true, strongholdFound: true, portalActivated: true, inEnd: true, crystalsAlive: 0, dragonHealth: 120 })
                .phase
        ).toBe('fight_dragon');
        expect(
            nextEndgameStep({ gearReady: true, strongholdFound: true, portalActivated: true, inEnd: true, crystalsAlive: 0, dragonHealth: 0 })
                .action
        ).toContain('出口传送门');
    });

    it('地上还有东西 → 回收优先级最高，压过一切', () => {
        const advice = nextEndgameStep({ itemOnGround: true, gearReady: true, inEnd: true, crystalsAlive: 0, dragonHealth: 200 });
        expect(advice.phase).toBe('recover');
        expect(advice.tool).toBe('recoverAfterDeath');
    });

    it('龙血读不到（null）时继续打，不误判成打完', () => {
        const advice = nextEndgameStep({ inEnd: true, gearReady: true, strongholdFound: true, portalActivated: true, crystalsAlive: 0, dragonHealth: null });
        expect(advice.phase).toBe('fight_dragon');
    });

    it('报告把阶段、原因、缺口拼在一起', () => {
        const assessment = assessEndGear({ inventory: { bedrock: 1 } });
        const report = formatEndgameReport(assessment, nextEndgameStep({}));
        expect(report).toContain('末地通关');
        expect(report).toContain('原因：');
        expect(report).toContain('缺口：');
    });
});