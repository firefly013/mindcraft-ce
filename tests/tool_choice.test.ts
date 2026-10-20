/**
 * 工具选择：**快断的镐是便宜工具，不是坏工具**（Lead 2026-10-21，用户推翻上一版规则）。
 * 唯一的禁止项：选一个"会在活干到一半断掉"的工具（把可用工具变成必然半途而废）。
 * 规则：candidates = 档位达标 且 耐久 ≥ usesNeeded；choice = 其中最便宜（档位最低 → 耐久最少）。
 */
import { describe, expect, it } from 'vitest';
import { chooseToolForJob, toolRemainingUses } from '../src/body/library/tool_choice.js';

const pick = (name: string, remaining: number) => ({ name, count: 1, maxDurability: 251, durabilityUsed: 251 - remaining });

describe('便宜优先（与上一版"健康优先"相反）', () => {
  it('(a) 3 把铁镐含剩 4 次，活只要 2 次耐�（挖 2 格）⇒ **选剩 4 次那把**', () => {
    const choice = chooseToolForJob({ tools: [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4), pick('iron_pickaxe', 251)], usesNeeded: 2 });
    expect(choice.name).toBe('iron_pickaxe');
    expect(choice.remaining).toBe(4);
    expect(choice.message).toContain('耐久 4');
    expect(choice.message).toContain('留给硬活');
  });

  it('(d) 活需要 120 次 ⇒ 不选剩 4 次的（会断在那），选满耐久的', () => {
    const choice = chooseToolForJob({ tools: [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4)], usesNeeded: 120 });
    expect(choice.remaining).toBe(250);
  });

  it('便宜优先也尊重档位：石镐不会抢本需要铁镐的活', () => {
    const choice = chooseToolForJob({ tools: [pick('stone_pickaxe', 131), pick('iron_pickaxe', 250)], minimumTier: 'iron', usesNeeded: 1 });
    expect(choice.name).toBe('iron_pickaxe');
  });
});

describe('没有候选时：区分"会断"和"档位不够"', () => {
  it('(b) 活要 10 次，只有剩 4 的铁镐 + 满耐久石镐，最低要求铁 ⇒ "能挖但会断"，**不许降级用石镐**', () => {
    const choice = chooseToolForJob({
      tools: [pick('iron_pickaxe', 4), pick('stone_pickaxe', 131)],
      minimumTier: 'iron',
      usesNeeded: 10,
    });
    expect(choice.name).toBeNull();
    expect(choice.failure).toBe('tier-ok-but-will-break');
    expect(choice.message).toContain('挖到一半会断');
  });

  it('连档位都不够 ⇒ tier-too-low，明说这格需要什么档位', () => {
    const choice = chooseToolForJob({ tools: [pick('wooden_pickaxe', 60)], minimumTier: 'iron', usesNeeded: 1 });
    expect(choice.name).toBeNull();
    expect(choice.failure).toBe('tier-too-low');
    expect(choice.message).toContain('档位不够');
  });

  it('完全没有镐 ⇒ no-tool', () => {
    expect(chooseToolForJob({ tools: [], usesNeeded: 1 }).failure).toBe('no-tool');
  });
});

describe('(c) 循环守卫：被拒绝的工具本动作内不许再选回', () => {
  it('第一次选了剩 4 次那把，被安全门拒绝后排除它 ⇒ 换满耐久那把', () => {
    const tools = [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4)];
    const first = chooseToolForJob({ tools, usesNeeded: 2 });
    expect(first.remaining).toBe(4);
    const second = chooseToolForJob({ tools, usesNeeded: 2, excluded: ['iron_pickaxe'] });
    // 同名工具排除后没有候选：必须明说"在互相让位"，而不是选回同一把
    expect(second.name).toBeNull();
    expect(second.failure).toBe('excluded-oscillation');
    expect(second.message).toContain('互相让位');
  });
  it('读不到耐久的工具不会被当成"不够用"排除', () => {
    expect(toolRemainingUses({ name: 'iron_pickaxe', count: 1 })).toBeNull();
    expect(chooseToolForJob({ tools: [{ name: 'iron_pickaxe', count: 1 }], usesNeeded: 50 }).failure).toBeNull();
  });
});
