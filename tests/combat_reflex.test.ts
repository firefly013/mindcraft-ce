/**
 * 战斗反射的决策层（用户 2026-10-31 spec）：什么时候接管、接管谁、什么时候让位。
 *
 * 身体执行（custom-pvp / escape）不在这里测；这里钉住的是"判决"和"让位规则"，
 * 它们决定了机器人会不会在模型正在干活时乱抢身体。
 */
import { describe, expect, it } from 'vitest';
import {
  COMBAT_REFLEX_COOLDOWN_MS,
  DEFAULT_COMBAT_POLICY,
  formatCombatDecision,
  formatCombatResult,
  planCombatResponse,
  readCombatEnemies,
  readCombatPolicy,
  readSelfFacts,
  type CombatPolicy,
  type CombatReflexInput,
} from '../src/body/safety/combat_reflex.js';
import type { CombatEnemyFacts, CombatSelfFacts } from '../src/body/safety/combat_power.js';

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

const input = (over: Partial<CombatReflexInput> = {}): CombatReflexInput => ({
  self: self(),
  enemies: [enemy()],
  policy: DEFAULT_COMBAT_POLICY,
  now: 100_000,
  engaged: false,
  engagedSince: null,
  cooldownUntil: 0,
  otherReflexActive: false,
  creeperReflexActive: false,
  safeguardsSuppressed: false,
  ...over,
});

describe('策略读取', () => {
  it('缺省 = on / 1.6 / 1.0 / 24 / 20s', () => {
    expect(readCombatPolicy(undefined)).toEqual(DEFAULT_COMBAT_POLICY);
    expect(DEFAULT_COMBAT_POLICY.mode).toBe('on');
  });

  it('非法字段退回默认值，不因为读不到就关掉功能', () => {
    const p = readCombatPolicy({ mode: 'nonsense', margin: -1, exitMargin: 'x', scanRadius: 0 });
    expect(p.mode).toBe('on');
    expect(p.margin).toBe(DEFAULT_COMBAT_POLICY.margin);
    expect(p.exitMargin).toBe(DEFAULT_COMBAT_POLICY.exitMargin);
    expect(p.scanRadius).toBe(DEFAULT_COMBAT_POLICY.scanRadius);
  });

  it('显式 shadow / off 被保留', () => {
    expect(readCombatPolicy({ mode: 'shadow' }).mode).toBe('shadow');
    expect(readCombatPolicy({ mode: 'off' }).mode).toBe('off');
  });
});

describe('让位规则（不抢身体的情形）', () => {
  it('模式 off ⇒ 不动作', () => {
    expect(planCombatResponse(input({ policy: { ...DEFAULT_COMBAT_POLICY, mode: 'off' } })).action).toBe('none');
  });

  it('模型关了保命程序 ⇒ yield（身体归模型）', () => {
    expect(planCombatResponse(input({ safeguardsSuppressed: true })).action).toBe('yield');
  });

  it('苦力怕反射在跑 ⇒ yield', () => {
    expect(planCombatResponse(input({ creeperReflexActive: true })).action).toBe('yield');
  });

  it('保命反射在跑 ⇒ yield', () => {
    expect(planCombatResponse(input({ otherReflexActive: true })).action).toBe('yield');
  });

  it('冷却中 ⇒ 不动作', () => {
    expect(planCombatResponse(input({ cooldownUntil: 100_001 })).action).toBe('none');
  });

  it('苦力怕在 14 格内 ⇒ 交给 creeper_reflex，战斗反射不碰', () => {
    expect(planCombatResponse(input({ enemies: [enemy({ name: 'creeper', distance: 10 })] })).action).toBe('none');
  });

  it('怪还没进入警戒范围 ⇒ 观望，不主动开战', () => {
    expect(
      planCombatResponse(input({ enemies: [enemy({ distance: 10, attackingMe: false, lockedOn: false })] })).action,
    ).toBe('none');
  });

  it('远处（扫描半径外）的怪不算威胁', () => {
    expect(
      planCombatResponse(input({ enemies: [enemy({ distance: 30, attackingMe: false, lockedOn: false })] })).action,
    ).toBe('none');
  });
});

describe('接管', () => {
  it('僵尸贴脸 ⇒ engage，目标就是它', () => {
    const plan = planCombatResponse(input());
    expect(plan.action).toBe('engage');
    expect(plan.targetId).toBe(1);
    expect(plan.assessment?.verdict).toBe('fight');
  });

  it('两只怪：优先打"正在打我"的那只', () => {
    const plan = planCombatResponse(
      input({
        // 铁套 + 下界合金剑：两只僵尸也打得过（否则判决会是"跑"，测不到选目标）
        self: self({
          weapon: { damage: 8, attacksPerSec: 1.6, kind: 'sword' },
          armor: { points: 15, toughness: 0, protection: 0 },
        }),
        enemies: [
          enemy({ id: 1, distance: 4, attackingMe: false, lockedOn: false }),
          enemy({ id: 2, distance: 7, attackingMe: true }),
        ],
      }),
    );
    expect(plan.action).toBe('engage');
    expect(plan.targetId).toBe(2);
  });

  it('打不过 ⇒ flee（交给 escape 反射）', () => {
    const plan = planCombatResponse(
      input({
        self: self({ health: 4, food: 8 }),
        enemies: [enemy({ distance: 2 })],
      }),
    );
    expect(plan.action).toBe('flee');
  });

  it('交战超时 ⇒ flee（交还身体）', () => {
    const plan = planCombatResponse(
      input({ engaged: true, engagedSince: 100_000 - DEFAULT_COMBAT_POLICY.maxEngageMs - 1 }),
    );
    expect(plan.action).toBe('flee');
  });

  it('已经在打且战力仍够 ⇒ hold（继续打，不重新决策）', () => {
    const plan = planCombatResponse(input({ self: self({ health: 8 }), engaged: true, engagedSince: 99_000 }));
    expect(plan.action).toBe('hold');
  });
});

describe('读事实', () => {
  const bot = {
    health: 20,
    food: 18,
    foodSaturation: 2,
    game: { difficulty: 3 },
    entity: { position: { x: 0, y: 64, z: 0 }, id: 99, isInWater: false, onGround: true, effects: { 4: { amplifier: 0 } } },
    inventory: {
      items: () => [{ name: 'stone_sword' }, { name: 'iron_axe' }, { name: 'bread' }],
      slots: [null, null, null, null, null, { name: 'iron_helmet' }, { name: 'iron_chestplate' }, null, null],
    },
    registry: { entitiesByName: { zombie: { metadataKeys: ['health'] } } },
    entities: {
      1: {
        id: 1,
        name: 'zombie',
        type: 'hostile',
        position: { x: 3, y: 64, z: 0 },
        yaw: Math.PI / 2,
        attributes: { 'generic.max_health': { value: 20 }, 'generic.attack_damage': { value: 4 } },
        metadata: [18],
      },
    },
  };

  it('难度 3 ⇒ hard；药水 amplifier 0 ⇒ 1 级', () => {
    const facts = readSelfFacts(bot);
    expect(facts.difficulty).toBe('hard');
    expect(facts.effects.strength).toBe(1);
  });

  it('按 DPS 选武器（铁斧 8.1 > 石剑 8.0），不按背包顺序', () => {
    expect(readSelfFacts(bot).weapon?.kind).toBe('axe');
  });

  it('护甲从穿戴槽累加', () => {
    expect(readSelfFacts(bot).armor?.points).toBe(8);
  });

  it('读敌对生物：距离/血量/属性/锁定/最近攻击者', () => {
    const enemies = readCombatEnemies(bot, 24, 'zombie');
    expect(enemies).toHaveLength(1);
    expect(enemies[0]).toMatchObject({
      id: 1,
      name: 'zombie',
      distance: 3,
      health: 18,
      maxHealth: 20,
      attackDamage: 4,
      lockedOn: true,
      attackingMe: true,
    });
  });

  it('扫描半径外的怪不返回', () => {
    expect(readCombatEnemies(bot, 2)).toHaveLength(0);
  });
});

describe('回执', () => {
  it('判决回执写明打/跑和数值', () => {
    const plan = planCombatResponse(input());
    const text = formatCombatDecision(plan);
    expect(text).toContain('判决');
    expect(text).toContain('打');
    expect(text).toContain('DPS');
  });

  it('结果回执只报实测事实', () => {
    const killed = formatCombatResult({
      targetName: 'zombie',
      outcome: 'killed',
      healthBefore: 20,
      healthAfter: 14.5,
      ms: 3200,
    });
    expect(killed).toContain('击杀');
    expect(killed).toContain('掉血 5.5');
    expect(killed).toContain('3.2s');
    const aborted = formatCombatResult({
      targetName: 'zombie',
      outcome: 'aborted',
      healthBefore: 20,
      healthAfter: 18,
      ms: 900,
      detail: '按最新战力改判',
    });
    expect(aborted).toContain('没打完');
    expect(aborted).toContain('按最新战力改判');
  });

  it('冷却常量是正数（身体侧真的会用它）', () => {
    expect(COMBAT_REFLEX_COOLDOWN_MS).toBeGreaterThan(0);
  });
});

describe('策略对象形状', () => {
  it('CombatPolicy 的字段与默认值一一对应', () => {
    const policy: CombatPolicy = { ...DEFAULT_COMBAT_POLICY };
    expect(Object.keys(policy).sort()).toEqual(['exitMargin', 'margin', 'maxEngageMs', 'mode', 'scanRadius']);
  });
});
