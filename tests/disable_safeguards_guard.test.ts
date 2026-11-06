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
    expect(verdict.text).toContain('现在不能关闭保命，因为保命反射 escape 正在跑，已经 18 秒。');
    expect(verdict.text).toContain('escape');
    expect(verdict.text).toContain('18 秒');
  });

  it('② 血 3.87 + 15 米外有怪 ⇒ 拒，理由写清、不排下一步（真机现场）', () => {
    const verdict = disableSafeguardsVerdict(facts({ health: 3.87, hostileMeters: 15, food: 8 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('现在不能关闭保命，因为你的血量只有 3.87，15 格外还有敌对生物。');
    expect(verdict.text).toContain('15 格');
    // 2026-10-30：只有"身体被反射占着"才给下一步（stop），其余只报原因
    expect(verdict.text).not.toContain('下一步（照做即可）');
  });

  it('② 血 3.87 但**周围什么都没有** ⇒ 照样拒（≤3 血不看环境）', () => {
    const verdict = disableSafeguardsVerdict(facts({ health: 3.87, hostileMeters: null }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('现在不能关闭保命，因为你的血量只有 3.87。');
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
    expect(disableSafeguardsVerdict(facts({ submerged: true })).text).toContain('头在水里');
    expect(disableSafeguardsVerdict(facts({ belowVoid: true })).text).toContain('虚空');
  });

  it('④ 满血、没反射、没危险 ⇒ **允许**（正当用途必须活下来）', () => {
    const verdict = disableSafeguardsVerdict(facts());
    expect(verdict.allowed).toBe(true);
  });
});

describe('接线：拒绝时绝不静音（也不留计时器）', () => {
  it('保命在跑 + 血 3.87 ⇒ 工具拒绝、safeguards 仍是"开启"状态', () => {
    const agent = fakeAgent({
      bot: { health: 3.87, food: 8, entity: { id: 1, position: { x: 0, y: 64, z: 0 } }, entities: {}, game: { minY: -64 }, blockAt: () => ({ name: 'air' }) },
      reflexStatus: () => ({ reflex: 'escape', intent: 'flee', ms: 18_000 }),
    });
    const text = disableTool.perform(agent, undefined, 6, '血只剩 3.87、背包无食物', false);
    expect(String(text)).toContain('现在不能关闭保命，因为保命反射 escape 正在跑，已经 18 秒。');
    expect(safeguards.isSuppressed(Date.now())).toBe(false);
    expect(safeguards.current(Date.now())).toBeNull();
  });

  it('满血安全 ⇒ 工具真的关闭，回执只报状态', () => {
    const agent = fakeAgent();
    const text = String(disableTool.perform(agent, undefined, 6, '我想挖岩浆旁边的矿', false));
    expect(text).toContain('保命程序已关闭');
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



