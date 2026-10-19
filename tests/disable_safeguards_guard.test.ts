/**
 * `disableSafeguards` 的自杀式调用必须被拒 —— 真机 2026-10-19 01:48（overnight_b）。
 *
 * 现场：血 3.87、15 米外有苦力怕，模型调 disableSafeguards 关掉**正在跑的 escape**
 * 去打怪 → 4 秒后血 1.87。这个开关存在的意义就是防这种事。
 *
 * 这里钉住：该拒的四种情况必须拒（且**不留静音计时器**），正当用途必须照旧放行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectOverrideFacts,
  deathCostLine,
  disableSafeguardsVerdict,
  type OverrideFacts,
} from '../src/body/safety/reflex_override.js';
import { safeguards } from '../src/body/safety/safeguards.js';
import { actionsList } from '../src/body/commands/actions.js';

const facts = (overrides: Partial<OverrideFacts> = {}): OverrideFacts => ({
  health: 20,
  food: 20,
  hostileMeters: null,
  reflex: null,
  reflexMs: 0,
  inLava: false,
  submerged: false,
  belowVoid: false,
  keepInventory: true,
  immediateRespawn: true,
  ...overrides,
});

const disableTool = (actionsList as any[]).find((tool) => tool.name === '!disableSafeguards');

function fakeAgent(overrides: Record<string, unknown> = {}): any {
  return {
    bot: {
      health: 20,
      food: 20,
      entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
      entities: {},
      game: { minY: -64 },
      blockAt: () => ({ name: 'air' }),
    },
    reflexStatus: () => null,
    ...overrides,
  };
}

afterEach(() => {
  safeguards.release();
});

describe('判定：该拒的必须拒', () => {
  it('① 保命反射正在跑 ⇒ 拒（中途静音就是 F-23 的另一扇门）', () => {
    const verdict = disableSafeguardsVerdict(facts({ reflex: 'escape', reflexMs: 18_000 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('拒绝');
    expect(verdict.text).toContain('escape');
    expect(verdict.text).toContain('18 秒');
    expect(verdict.text).toContain('stop()');
  });

  it('② 血 3.87 + 15 米外有怪 ⇒ 拒，理由与下一步都写清（真机现场）', () => {
    const verdict = disableSafeguardsVerdict(facts({ health: 3.87, hostileMeters: 15, food: 8 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('3.87 血');
    expect(verdict.text).toContain('15 格');
    expect(verdict.text).toContain('下一步（照做即可）');
    expect(verdict.text).toMatch(/getFood|consume|goToCoordinates/);
  });

  it('② 血 3.87 但**周围什么都没有** ⇒ 照样拒（≤3 血不看环境）', () => {
    const verdict = disableSafeguardsVerdict(facts({ health: 3.87, hostileMeters: null }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('3.87 血');
  });

  it('② 血 6 且有怪 16 米内 ⇒ 拒；血 6 而怪在 40 米外 ⇒ 允许（不过度拦截）', () => {
    expect(disableSafeguardsVerdict(facts({ health: 6, hostileMeters: 16 })).allowed).toBe(false);
    expect(disableSafeguardsVerdict(facts({ health: 6, hostileMeters: 40 })).allowed).toBe(true);
  });

  it('③ 在岩浆里 / 正在溺水 / 正掉进虚空 ⇒ 一律拒', () => {
    expect(disableSafeguardsVerdict(facts({ inLava: true })).allowed).toBe(false);
    expect(disableSafeguardsVerdict(facts({ submerged: true })).allowed).toBe(false);
    expect(disableSafeguardsVerdict(facts({ belowVoid: true })).allowed).toBe(false);
    expect(disableSafeguardsVerdict(facts({ inLava: true })).text).toContain('岩浆');
    expect(disableSafeguardsVerdict(facts({ submerged: true })).text).toContain('溺水');
    expect(disableSafeguardsVerdict(facts({ belowVoid: true })).text).toContain('虚空');
  });

  it('④ 满血、没反射、没危险 ⇒ **允许**（正当用途必须活下来）', () => {
    const verdict = disableSafeguardsVerdict(facts());
    expect(verdict.allowed).toBe(true);
  });

  it('拒绝的回执里带上"这个世界死一次多贵"（keepInventory 三态）', () => {
    expect(deathCostLine({ keepInventory: true, immediateRespawn: true })).toContain('物品和经验都保留');
    expect(deathCostLine({ keepInventory: true, immediateRespawn: true })).toContain('合法的重置');
    expect(deathCostLine({ keepInventory: false, immediateRespawn: true })).toContain('绝不能拿命去赌');
    expect(deathCostLine({ keepInventory: null, immediateRespawn: null })).toContain('gamerule');
  });
});

describe('接线：拒绝时绝不静音（也不留计时器）', () => {
  it('保命在跑 + 血 3.87 ⇒ 工具拒绝、safeguards 仍是"开启"状态', () => {
    const agent = fakeAgent({
      bot: { health: 3.87, food: 8, entity: { id: 1, position: { x: 0, y: 64, z: 0 } }, entities: {}, game: { minY: -64 }, blockAt: () => ({ name: 'air' }) },
      reflexStatus: () => ({ reflex: 'escape', intent: 'flee', ms: 18_000 }),
    });
    const text = disableTool.perform(agent, undefined, 6, '血只剩 3.87、背包无食物', false);
    expect(String(text)).toContain('拒绝');
    expect(safeguards.isSuppressed(Date.now())).toBe(false);
    expect(safeguards.current(Date.now())).toBeNull();
  });

  it('满血安全 ⇒ 工具真的关闭，并且回执不再替模型的理由背书', () => {
    const agent = fakeAgent();
    const text = String(disableTool.perform(agent, undefined, 6, '我想挖岩浆旁边的矿', false));
    expect(text).toContain('保命程序已关闭');
    expect(text).toContain('你自己写的理由');
    expect(safeguards.isSuppressed(Date.now())).toBe(true);
  });
});

describe('事实采集：从 agent 读得出该读的东西', () => {
  it('岩浆在脚/头那格 ⇒ inLava；血/食物/位置都读得到', () => {
    const agent = fakeAgent({
      bot: {
        health: 3.87,
        food: 8,
        entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
        entities: {},
        game: { minY: -64 },
        blockAt: () => ({ name: 'lava' }),
      },
    });
    const read = collectOverrideFacts(agent);
    expect(read.inLava).toBe(true);
    expect(read.health).toBe(3.87);
    expect(read.food).toBe(8);
    expect(disableSafeguardsVerdict(read).allowed).toBe(false);
  });
});

describe('三方互锁例外：确认卡死时只放行呼吸反射 60 秒（Lead 2026-10-19 授权）', () => {
  const lock = (over: Record<string, unknown> = {}) => ({
    stuckSec: 2_400,
    health: 0.375,
    food: 0,
    hasDigTool: false,
    hasDiggableNeighbour: false,
    surfaceTriggers: 60,
    keepInventory: true,
    immediateRespawn: true,
    ...over,
  });
  const trapped = (over: Record<string, unknown> = {}) =>
    facts({ health: 0.375, food: 0, reflex: 'surface', reflexMs: 90_000, submerged: true, deadlock: lock(over) as any });

  it('三个拒绝条款同时成立 + 确认卡死 ⇒ **放行**，但只给 60 秒呼吸反射', () => {
    const verdict = disableSafeguardsVerdict(trapped());
    expect(verdict.allowed).toBe(true);
    expect(verdict.grantSurfaceMs).toBe(60_000);
    expect(String(verdict.text)).toContain('你被卡死了');
    expect(String(verdict.text)).toContain('引擎的死锁');
    expect(String(verdict.text)).toContain('只让 surface 这一条规则停手 60 秒');
    expect(String(verdict.text)).toContain('下一步（照做即可）');
  });

  it('背包里有镐 ⇒ **拒绝**（它能挖，所以不是被困）', () => {
    const verdict = disableSafeguardsVerdict(trapped({ hasDigTool: true, hasDiggableNeighbour: true }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.grantSurfaceMs).toBeUndefined();
  });

  it('身边没有可挖的邻居 ⇒ 仍算被困（挖不动那一条成立）', () => {
    expect(disableSafeguardsVerdict(trapped({ hasDigTool: true, hasDiggableNeighbour: false })).allowed).toBe(true);
  });

  it('有食物/食物非 0 ⇒ 拒绝（不是卡死，是饿，去吃）', () => {
    expect(disableSafeguardsVerdict(trapped({ food: 3 })).allowed).toBe(false);
  });

  it('位置没卡够 3 分钟 / 呼吸反射只触发几次 ⇒ 拒绝（不许瞬时状态触发例外）', () => {
    expect(disableSafeguardsVerdict(trapped({ stuckSec: 60 })).allowed).toBe(false);
    expect(disableSafeguardsVerdict(trapped({ surfaceTriggers: 2 })).allowed).toBe(false);
  });

  it('岩浆/溺水但**不满足**完整卡死谓词 ⇒ 照旧拒绝（本例的读不到/缺字段）', () => {
    expect(disableSafeguardsVerdict(facts({ health: 1, food: 0, inLava: true })).allowed).toBe(false);
    expect(disableSafeguardsVerdict(facts({ health: 1, food: 0, submerged: true })).allowed).toBe(false);
  });

  it('血量/食物/背包读不到（deadlock=null）⇒ 拒绝', () => {
    expect(disableSafeguardsVerdict(facts({ health: 0.5, food: 0, submerged: true, deadlock: null })).allowed).toBe(false);
  });

  it('keepInventory 不是 true ⇒ 放行但**不给**死亡出路（standDown=0 ⇒ 走拒绝）', () => {
    const verdict = disableSafeguardsVerdict(trapped({ keepInventory: false }));
    expect(verdict.allowed).toBe(false);
  });
});
