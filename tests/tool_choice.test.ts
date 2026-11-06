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
import {
  chooseToolForJob,
  ENCHANTED_RESERVE_USES,
  hasEnchantment,
  isToolProtected,
  toolRemainingUses,
} from '../src/body/library/tool_choice.js';

const pick = (name: string, remaining: number) => ({ name, count: 1, maxDurability: 251, durabilityUsed: 251 - remaining });
/** 附魔工具：`enchants` 是 prismarine-item 的 getter 形状（`{name,lvl}[]`）。 */
const enchanted = (name: string, remaining: number) => ({
  ...pick(name, remaining),
  enchants: [{ name: 'efficiency', lvl: 3 }],
});

describe('便宜优先（先用快断的那把）', () => {
  it('3 把铁镐含剩 4 次的 ⇒ 选剩 4 次那把，只报选择的工具与耐久', () => {
    const choice = chooseToolForJob({ tools: [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4), pick('iron_pickaxe', 251)] });
    expect(choice.name).toBe('iron_pickaxe');
    expect(choice.remaining).toBe(4);
    expect(choice.message).toContain('耐久 4');
    expect(choice.message).not.toContain('断了再换');
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

describe('没有候选时：只报"没有可用的"与原因', () => {
  it('连档位都不够 ⇒ tier-too-low，点名需要的档位', () => {
    const choice = chooseToolForJob({ tools: [pick('wooden_pickaxe', 60)], minimumTier: 'iron' });
    expect(choice.name).toBeNull();
    expect(choice.failure).toBe('tier-too-low');
    expect(choice.message).toContain('没有可用的 pickaxe');
    expect(choice.message).toContain('iron');
  });

  it('完全没有镐 ⇒ no-tool', () => {
    expect(chooseToolForJob({ tools: [] }).failure).toBe('no-tool');
  });
});

describe('循环守卫：被拒绝的工具本动作内不许再选回', () => {
  it('唯一能用的那把被排除 ⇒ 报"被排除过"，不选回同一把', () => {
    const tools = [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4)];
    const first = chooseToolForJob({ tools });
    expect(first.remaining).toBe(4);
    const second = chooseToolForJob({ tools, excluded: ['iron_pickaxe'] });
    expect(second.name).toBeNull();
    expect(second.failure).toBe('excluded-oscillation');
    expect(second.message).toContain('排除过');
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

describe('附魔工具保护（用户 2026-11-01）', () => {
  it('附魔工具到保护线（剩 11 次）⇒ 不参与自动选择，自动换未附魔工具', () => {
    const choice = chooseToolForJob({
      tools: [enchanted('iron_pickaxe', 11), pick('stone_pickaxe', 131)],
    });
    expect(choice.failure).toBeNull();
    expect(choice.name).toBe('stone_pickaxe');
  });

  it('附魔工具健康（剩 200 次）⇒ 照常参与选择（便宜优先不变）', () => {
    const choice = chooseToolForJob({ tools: [enchanted('iron_pickaxe', 200), pick('stone_pickaxe', 131)] });
    // 便宜优先：档位低的石镐先选（附魔不是"更贵"的判据，耐久才是）。
    expect(choice.name).toBe('stone_pickaxe');
    const only = chooseToolForJob({ tools: [enchanted('iron_pickaxe', 200)] });
    expect(only.name).toBe('iron_pickaxe');
    expect(only.message).toContain('耐久 200');
  });

  it('只有到保护线的附魔工具 ⇒ reserve-protected，明说保护线、不自动用', () => {
    const choice = chooseToolForJob({ tools: [enchanted('diamond_pickaxe', 5)] });
    expect(choice.name).toBeNull();
    expect(choice.failure).toBe('reserve-protected');
    expect(choice.message).toContain('保护线');
    expect(choice.message).toContain(`≤ ${ENCHANTED_RESERVE_USES}`);
  });

  it('未附魔工具照旧用到爆：剩 1 次也照选', () => {
    const choice = chooseToolForJob({ tools: [pick('iron_pickaxe', 1)] });
    expect(choice.failure).toBeNull();
    expect(choice.name).toBe('iron_pickaxe');
  });

  it('读不到耐久不保护（不能因为测不出就锁死工具）', () => {
    const unknown: any = { name: 'iron_pickaxe', count: 1, enchants: [{ name: 'efficiency', lvl: 1 }] };
    expect(isToolProtected(unknown)).toBe(false);
    expect(chooseToolForJob({ tools: [unknown] }).name).toBe('iron_pickaxe');
  });

  it('附魔检测：getter 抛异常 / 空数组 / 非数组 ⇒ 都当"没附魔"', () => {
    expect(hasEnchantment({ name: 'iron_pickaxe', count: 1 })).toBe(false);
    expect(hasEnchantment({ name: 'iron_pickaxe', count: 1, enchants: [] })).toBe(false);
    const throwing: any = {
      name: 'iron_pickaxe',
      count: 1,
      get enchants(): unknown {
        throw new Error("Don't know how to get the enchants from an item on this mc version");
      },
    };
    expect(hasEnchantment(throwing)).toBe(false);
    expect(isToolProtected(throwing)).toBe(false);
  });

  it('保护线用比例也生效：剩 20% 但 > 20 次的大工具（钻石镐剩 300/1561）', () => {
    const big = { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 1261, enchants: [{ name: 'fortune', lvl: 3 }] };
    // 剩 300 次 > 20，但 300/1561 ≈ 19% > 15% ⇒ 不保护
    expect(isToolProtected(big)).toBe(false);
    const low = { name: 'diamond_pickaxe', count: 1, maxDurability: 1561, durabilityUsed: 1400, enchants: [{ name: 'fortune', lvl: 3 }] };
    // 剩 161 次，161/1561 ≈ 10.3% < 15% ⇒ 保护
    expect(isToolProtected(low)).toBe(true);
  });
});
