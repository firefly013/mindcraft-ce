import { describe, expect, it } from 'vitest';
import { formatItemDelta, craftNoOutputNote } from '../src/body/commands/interact.js';

/**
 * 真机原话（1.21.11 新档 overnight_b）：
 * 「合成 oak_planks：**+-1**（现在 0 个）」——材料少了 1、产物 0，
 * 回执给了一个既非成功也非失败的符号，模型看不懂就反复重试继续丢材料。
 */
describe('合成回执：变化量必须能被读懂', () => {
  it('负变化写成 -N，绝不出现 +-1', () => {
    expect(formatItemDelta(1, 0)).toBe('-1（现在 0 个）');
    expect(formatItemDelta(3, 2)).toBe('-1（现在 2 个）');
  });
  it('正变化与零变化', () => {
    expect(formatItemDelta(0, 4)).toBe('+4（现在 4 个）');
    expect(formatItemDelta(2, 2)).toBe('±0（现在 2 个）');
  });
  it('任何变化量都不含自相矛盾的 "+-"', () => {
    for (const [have, now] of [[1, 0], [0, 0], [0, 1], [5, 2], [2, 7]] as const) {
      expect(formatItemDelta(have, now)).not.toContain('+-');
      expect(formatItemDelta(have, now)).not.toContain('--');
    }
  });
  it('没产出时的说明：说事实、给下一步，绝不安抚模型「不要怀疑丢东西」', () => {
    const t = craftNoOutputNote('oak_planks', 1, 0);
    expect(t).toContain('实测没有产出');
    expect(t).toContain('1 → 0');
    expect(t).toContain('stats');
    // 旧文案的安抚句必须消失——它曾让模型不要怀疑丢材料：
    expect(t).not.toContain('不要判定材料/产物蒸发');
  });
});
