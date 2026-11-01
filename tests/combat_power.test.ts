/**
 * 战力模型（用户 2026-10-31 spec）：两条时间线 ttd/ttk 决定打还是跑。
 *
 * 这里钉住的是**判决边界**，不是精确数值：数值会随版本/难度漂移，
 * 但"铁剑打单只僵尸能打、三只围上来要跑、苦力怕永不近战"这些结论必须稳定。
 */
import { describe, expect, it } from 'vitest';
import {
  armorDamageReduction,
  armorFromItems,
  assessCombat,
  enemyBaseDps,
  mobProfileOf,
  selfDps,
  weaponProfileOf,
  type CombatEnemyFacts,
  type CombatSelfFacts,
} from '../src/body/safety/combat_power.js';

const self = (over: Partial<CombatSelfFacts> = {}): CombatSelfFacts => ({
  health: 20,
  maxHealth: 20,
  food: 20,
  saturation: 5,
  armor: { points: 0, toughness: 0, protection: 0 },
  weapon: { damage: 6, attacksPerSec: 1.6, kind: 'sword' },
  shield: false,
  effects: { strength: 0, resistance: 0, regeneration: 0, absorption: 0, weakness: 0, fireResistance: false },
  difficulty: 'hard',
  inWater: false,
  onGround: true,
  ...over,
});

const enemy = (over: Partial<CombatEnemyFacts> = {}): CombatEnemyFacts => ({
  id: 1,
  name: 'zombie',
  distance: 3,
  health: 20,
  maxHealth: 20,
  attackDamage: null,
  movementSpeed: null,
  lockedOn: true,
  attackingMe: true,
  isPlayer: false,
  ...over,
});

const opts = { mode: 'entry' as const, margin: 1.6, exitMargin: 1.0 };

describe('数据表与公式', () => {
  it('铁剑 6 伤 / 1.6 攻速 / 85% 命中 ⇒ 约 8.2 DPS', () => {
    expect(selfDps(self())).toBeCloseTo(6 * 1.6 * 0.85, 5);
  });

  it('锋利附魔按 0.5×等级+0.5 加伤害', () => {
    expect(weaponProfileOf('diamond_sword').damage).toBe(7);
    expect(weaponProfileOf('diamond_sword', 5).damage).toBe(7 + 3);
  });

  it('不认识的"武器"按铁剑估，不是空手', () => {
    expect(weaponProfileOf('mystery_blade').damage).toBe(6);
  });

  it('铁套 15 点护甲对 6 点伤害减伤约 48%', () => {
    expect(armorDamageReduction(15, 0, 6)).toBeCloseTo(12 / 25, 5);
  });

  it('护甲档案从四件装备累加（含韧性）', () => {
    const armor = armorFromItems(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
    expect(armor.points).toBe(15);
    const diamond = armorFromItems(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']);
    expect(diamond.points).toBe(20);
    expect(diamond.toughness).toBe(8);
  });

  it('难度按倍率缩放怪的伤害（困难 1.5×）', () => {
    const easy = enemyBaseDps(self({ difficulty: 'easy' }), enemy());
    const hard = enemyBaseDps(self({ difficulty: 'hard' }), enemy());
    expect(hard / easy).toBeCloseTo(1.5 / 0.7, 5);
  });

  it('怪表覆盖真机死因里的主要怪，未知怪不冒充已知', () => {
    for (const name of ['zombie', 'skeleton', 'creeper', 'drowned', 'spider', 'enderman', 'pillager', 'blaze', 'warden']) {
      expect(mobProfileOf(name)).not.toBeNull();
    }
    expect(mobProfileOf('definitely_not_a_mob')).toBeNull();
  });
});

describe('判决：打', () => {
  it('铁剑 + 满血打单只僵尸 ⇒ fight', () => {
    expect(assessCombat(self(), [enemy()], opts).verdict).toBe('fight');
  });

  it('穿铁套后更该打（有效血翻倍）', () => {
    const armored = assessCombat(
      self({ armor: { points: 15, toughness: 0, protection: 0 } }),
      [enemy()],
      opts,
    );
    expect(armored.verdict).toBe('fight');
    expect(armored.selfEffectiveHp).toBeGreaterThan(30);
  });

  it('骷髅在 12 格：接近路上挨几箭，仍然能打', () => {
    expect(assessCombat(self(), [enemy({ name: 'skeleton', distance: 12 })], opts).verdict).toBe('fight');
  });
});

describe('判决：跑', () => {
  it('3 只僵尸围上来 ⇒ flee', () => {
    const enemies = [enemy({ id: 1 }), enemy({ id: 2, distance: 4 }), enemy({ id: 3, distance: 5 })];
    expect(assessCombat(self(), enemies, opts).verdict).toBe('flee');
  });

  it('残血 + 食物不足（不回血）⇒ flee', () => {
    const a = assessCombat(self({ health: 4, food: 10 }), [enemy({ distance: 2 })], opts);
    expect(a.verdict).toBe('flee');
    expect(a.hardRule).toBe('low-health');
  });

  it('苦力怕在 10 格 ⇒ flee（爆炸是二值事件，永不近战）', () => {
    const a = assessCombat(self(), [enemy({ name: 'creeper', distance: 10 })], opts);
    expect(a.verdict).toBe('flee');
    expect(a.hardRule).toBe('creeper');
  });

  it('监守者/凋灵这类永不交火 ⇒ flee', () => {
    expect(assessCombat(self(), [enemy({ name: 'warden', distance: 12 })], opts).hardRule).toBe('never-fight');
    expect(assessCombat(self(), [enemy({ name: 'wither', distance: 20 })], opts).verdict).toBe('flee');
  });

  it('不认识的怪贴到 10 格 ⇒ flee（读不到就按危险处理）', () => {
    const a = assessCombat(self(), [enemy({ name: 'mystery_beast', distance: 10 })], opts);
    expect(a.verdict).toBe('flee');
    expect(a.hardRule).toBe('unknown-mob');
  });

  it('空手 ⇒ flee（手上没有能打的东西）', () => {
    expect(assessCombat(self({ weapon: null }), [enemy()], opts).hardRule).toBe('no-weapon');
  });
});

describe('判决：不该打', () => {
  it('中立怪没攻击我 ⇒ ignore（不主动开战）', () => {
    expect(assessCombat(self(), [enemy({ name: 'enderman', attackingMe: false })], opts).verdict).toBe('ignore');
  });

  it('中立怪正在攻击我 ⇒ 进公式（末影人 5 格单挑打不过）', () => {
    const a = assessCombat(self(), [enemy({ name: 'enderman', distance: 5, attackingMe: true })], opts);
    expect(a.verdict).toBe('flee');
  });

  it('和平难度 ⇒ ignore', () => {
    expect(assessCombat(self({ difficulty: 'peaceful' }), [enemy()], opts).verdict).toBe('ignore');
  });

  it('附近只有玩家 ⇒ ignore（玩家不在这套战力表里）', () => {
    expect(assessCombat(self(), [enemy({ name: 'player', isPlayer: true })], opts).verdict).toBe('ignore');
  });

  it('没有怪 ⇒ ignore', () => {
    expect(assessCombat(self(), [], opts).verdict).toBe('ignore');
  });
});

describe('迟滞：entry 与 hold 用不同阈值', () => {
  it('残血单挑：还没开打时判跑，已经在打时判继续打', () => {
    const weak = self({ health: 8 });
    expect(assessCombat(weak, [enemy()], { ...opts, mode: 'entry' }).verdict).toBe('flee');
    expect(assessCombat(weak, [enemy()], { ...opts, mode: 'hold' }).verdict).toBe('fight');
  });

  it('交战目标优先选"正在打我"的那只', () => {
    const enemies = [
      enemy({ id: 1, distance: 4, attackingMe: false, lockedOn: false }),
      enemy({ id: 2, distance: 7, attackingMe: true }),
    ];
    expect(assessCombat(self(), enemies, opts).targetId).toBe(2);
  });
});
