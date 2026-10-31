/**
 * 工具选择：**快断的镐是便宜工具，先用它，断了再换下一把**（用户 2026-10-28 定稿）。
 *
 * 耐久**不参与筛选**。旧那版是"活要约 N 次、不够就拒（tier-ok-but-will-break）"，
 * 已经删掉：那个 N 本来就是我们猜的（挖一格≈1 次耐久，实际还看方块/附魔），
 * 而且它把"值不值得冒断的风险"从模型手里拿走了。断了由执行层换下一把。
 *
 * 规则：candidates = 档位达标；choice = 最便宜（档位最低 → 剩余耐久最少）。
 */
import { describe, expect, it } from 'vitest';
import { chooseToolForJob, toolRemainingUses } from '../src/body/library/tool_choice.js';

const pick = (name: string, remaining: number) => ({ name, count: 1, maxDurability: 251, durabilityUsed: 251 - remaining });

describe('便宜优先（先用快断的那把）', () => {
  it('3 把铁镐含剩 4 次的 ⇒ 选剩 4 次那把，回执说清"断了再换"', () => {
    const choice = chooseToolForJob({ tools: [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4), pick('iron_pickaxe', 251)] });
    expect(choice.name).toBe('iron_pickaxe');
    expect(choice.remaining).toBe(4);
    expect(choice.message).toContain('耐久 4');
    expect(choice.message).toContain('断了再换');
  });

  it('**活再大也不因为"会断"拒绝**：同档位只剩 4 次也照选', () => {
    // 旧行为：minimumTier=iron + usesNeeded=10 ⇒ 返回 null + 让你先换一把。
    // 现在：先挖，爆了再换下一把（执行层负责换）。
    const choice = chooseToolForJob({
      tools: [pick('iron_pickaxe', 4), pick('stone_pickaxe', 131)],
      minimumTier: 'iron',
    });
    expect(choice.failure).toBeNull();
    expect(choice.name).toBe('iron_pickaxe');
    expect(choice.remaining).toBe(4);
  });

  it('同档位里剩 1 次也照选（不再有"会用断"这种失败态）', () => {
    const choice = chooseToolForJob({ tools: [pick('iron_pickaxe', 1), pick('iron_pickaxe', 200)], minimumTier: 'iron' });
    expect(choice.failure).toBeNull();
    expect(choice.remaining).toBe(1);
  });

  it('便宜优先也尊重档位：石镐不会抢本需要铁镐的活', () => {
    const choice = chooseToolForJob({ tools: [pick('stone_pickaxe', 131), pick('iron_pickaxe', 250)], minimumTier: 'iron' });
    expect(choice.name).toBe('iron_pickaxe');
  });
});

describe('没有候选时：只剩"没有工具"和"档位不够"', () => {
  it('连档位都不够 ⇒ tier-too-low，明说这格需要什么档位', () => {
    const choice = chooseToolForJob({ tools: [pick('wooden_pickaxe', 60)], minimumTier: 'iron' });
    expect(choice.name).toBeNull();
    expect(choice.failure).toBe('tier-too-low');
    expect(choice.message).toContain('档位不够');
  });

  it('完全没有镐 ⇒ no-tool', () => {
    expect(chooseToolForJob({ tools: [] }).failure).toBe('no-tool');
  });
});

describe('循环守卫：被拒绝的工具本动作内不许再选回', () => {
  it('唯一能用的那把被排除 ⇒ 明说"在互相让位"，而不是选回同一把', () => {
    const tools = [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4)];
    const first = chooseToolForJob({ tools });
    expect(first.remaining).toBe(4);
    const second = chooseToolForJob({ tools, excluded: ['iron_pickaxe'] });
    // 同名工具排除后没有候选：必须明说"在互相让位"，而不是选回同一把
    expect(second.name).toBeNull();
    expect(second.failure).toBe('excluded-oscillation');
    expect(second.message).toContain('互相让位');
  });
});

describe('读不到耐久', () => {
  it('toolRemainingUses 返回 null，且不会被当成"不够用"排除', () => {
    expect(toolRemainingUses({ name: 'iron_pickaxe', count: 1 })).toBeNull();
    const choice = chooseToolForJob({ tools: [{ name: 'iron_pickaxe', count: 1 }] });
    expect(choice.failure).toBeNull();
    expect(choice.name).toBe('iron_pickaxe');
  });
});
