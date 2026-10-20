/**
 * 烧炼三本账（Lead 2026-10-20，真机 overnight_b）：
 * `useBlock(type=furnace, input="5 raw_iron", output="5 iron_ingot")`
 *   ⇒ 「Only smelted 1 iron_ingot」+「背包账目：raw_iron 5 → 0；iron_ingot 0 → 1」
 * 那 4 块很可能是**还在炉内输入槽**，而回执只印背包 ⇒ 模型报"材料没影了"。
 * 规则：背包 / 炉内 / 真丢 三个数分开，`真丢` 只能由读数算，不许凭空声称。
 */
import { describe, expect, it } from 'vitest';
import {
  formatSmeltAccounting,
  formatSmeltUnfinished,
  nextSmeltStep,
  unaccountedInput,
} from '../src/body/commands/interact.js';

const base = {
  rawName: 'raw_iron',
  productName: 'iron_ingot',
  bagBefore: 5,
  bagAfter: 0,
  furnaceInput: 4,
  furnaceFuel: 3,
  furnaceOutput: 1,
  productGained: 1,
  target: 5,
};

describe('三本账分开算', () => {
  it('部分烧完 + 炉内还有原料 ⇒ 真丢 = 0，且回执明说"还在炉里"', () => {
    expect(unaccountedInput(base)).toBe(0);
    const text = formatSmeltAccounting(base, 2).join('\n');
    expect(text).toContain('背包账：raw_iron 5 → 0');
    expect(text).toContain('炉内账');
    expect(text).toContain('输入槽 4 个 raw_iron');
    expect(text).toContain('真丢：**0**');
    expect(text).toContain('躺在熔炉输入槽');
    expect(text).not.toContain('凭空消失');
    expect(text).not.toContain('没影');
  });

  it('**炉子读不到 ⇒ 真丢算不出来**，明说不能当成丢了（不许猜）', () => {
    const partial = { ...base, furnaceInput: null };
    expect(unaccountedInput(partial)).toBeNull();
    const text = formatSmeltAccounting(partial, 1).join('\n');
    expect(text).toContain('真丢：**算不出来**');
    expect(text).toContain('这不能当成"丢了"');
  });

  it('真丢 > 0 时才允许说"对不上账"，并要求把事实留给开发者', () => {
    const lost = { ...base, furnaceInput: 0, productGained: 1, bagAfter: 1 }; // 5-1=4 consumed，只记 1 产出
    expect(unaccountedInput(lost)).toBe(3);
    const text = formatSmeltAccounting(lost, 1).join('\n');
    expect(text).toContain('真丢：**3 个**');
    expect(text).toContain('真的对不上账');
  });

  it('**不许在回执里写 "n → 0" 却不提炉内**：背包行与炉内行必须同时出现', () => {
    const lines = formatSmeltAccounting(base, 1);
    expect(lines.some((line) => line.includes('raw_iron 5 → 0'))).toBe(true);
    expect(lines.some((line) => line.includes('炉内账'))).toBe(true);
  });
});

describe('继续烧 vs 收工（有界）', () => {
  it('没到目标、炉内还有原料/燃料 ⇒ continue（"Only smelted N" 是进度，不是失败）', () => {
    expect(nextSmeltStep({ produced: 1, target: 5, furnaceInput: 4, furnaceFuel: 3, elapsedMs: 1_000, rounds: 1 })).toBe('continue');
  });

  it('燃料耗尽 ⇒ stop-fuel，并说明**还剩多少在炉里、要补几个煤**', () => {
    const next = nextSmeltStep({ produced: 1, target: 5, furnaceInput: 4, furnaceFuel: 0, elapsedMs: 1_000, rounds: 1 });
    expect(next).toBe('stop-fuel');
    const text = formatSmeltUnfinished({ ...base, productGained: 1 }, next);
    expect(text).toContain('还在熔炉输入槽里');
    expect(text).toContain('缺燃料');
    expect(text).toContain('安全');
    expect(text).not.toContain('消失');
  });

  it('到目标 ⇒ done；轮数/时间到上限 ⇒ stop-time（有界，不无限烧）', () => {
    expect(nextSmeltStep({ produced: 5, target: 5, furnaceInput: 2, furnaceFuel: 3, elapsedMs: 1_000, rounds: 2 })).toBe('done');
    expect(nextSmeltStep({ produced: 1, target: 5, furnaceInput: 4, furnaceFuel: 3, elapsedMs: 1_000, rounds: 9, maxRounds: 3 })).toBe('stop-time');
    expect(nextSmeltStep({ produced: 1, target: 5, furnaceInput: 4, furnaceFuel: 3, elapsedMs: 999_999, rounds: 1, maxMs: 120_000 })).toBe('stop-time');
    const text = formatSmeltUnfinished(base, 'stop-time');
    expect(text).toContain('再发一次同样的 useBlock');
    expect(text).toContain('进度不会丢');
  });
});
