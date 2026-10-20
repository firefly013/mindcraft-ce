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
    expect(text).toContain('还在炉内输入槽');
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
    // 5 块原料：4 被消耗、1 变成成品进包、0 在输入槽、0 在产物槽 ⇒ 真丢 3。
    const lost = { ...base, furnaceInput: 0, furnaceOutput: 0, productGained: 1, bagAfter: 1 };
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

describe('真丢的算术必须把"炉内产物槽"算进去（Lead 2026-10-20 真机反例）', () => {
  it('input 0 / 产物槽 1 个铁锭 / 背包 +0 ⇒ **真丢 0**（原料已经烧成成品，只是还没取）', () => {
    const real = {
      rawName: 'raw_iron',
      productName: 'iron_ingot',
      bagBefore: 1,
      bagAfter: 0,
      furnaceInput: 0,
      furnaceFuel: 0,
      furnaceOutput: 1,
      productGained: 0,
      target: 1,
    };
    expect(unaccountedInput(real)).toBe(0);
    const text = formatSmeltAccounting(real, 1).join('\n');
    expect(text).toContain('真丢：**0**');
    expect(text).toContain('产物槽里还有 1 个 iron_ingot 没取');
    expect(text).toContain('取走就行');
    expect(text).not.toContain('对不上账');
  });

  it('产物在背包里也算数（productGained 与炉内产物槽都折算）', () => {
    expect(
      unaccountedInput({
        rawName: 'raw_iron',
        productName: 'iron_ingot',
        bagBefore: 3,
        bagAfter: 0,
        furnaceInput: 0,
        furnaceFuel: 2,
        furnaceOutput: 1,
        productGained: 2,
        target: 3,
      }),
    ).toBe(0);
  });

  it('配方比例可折算（每原料出 2 个成品时，1 个原料 → 2 个成品不算丢）', () => {
    expect(
      unaccountedInput({
        rawName: 'sand',
        productName: 'glass',
        bagBefore: 1,
        bagAfter: 0,
        furnaceInput: 0,
        furnaceFuel: 1,
        furnaceOutput: 2,
        productGained: 0,
        target: 1,
        recipeRatio: 2,
      }),
    ).toBe(0);
  });

  it('任一读数缺失 ⇒ 仍然算不出来（不许默认说丢）', () => {
    expect(
      unaccountedInput({ rawName: 'raw_iron', productName: 'iron_ingot', bagBefore: 1, bagAfter: 0, furnaceInput: 0, furnaceFuel: 0, furnaceOutput: null, productGained: 0, target: 1 }),
    ).toBeNull();
  });
});
