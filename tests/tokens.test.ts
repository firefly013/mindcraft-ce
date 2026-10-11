/**
 * token 粗估（预算 guard，不是计费表）。
 *
 * 它是"往大了估"的：CJK 一个字算 1，ASCII 算 1/4。真正的 token 数只信 provider
 * 报的 `usage`——这个估算只在没有 usage 锚点时兜底，以及感知层给内容定级。
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/utils/tokens.js';

describe('estimateTokens', () => {
  it('空串是 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('ASCII 按 1/4 估，向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('CJK 一个字算 1（不被 chars/4 低估）', () => {
    expect(estimateTokens('你好')).toBe(2);
  });

  it('中英混排累加', () => {
    // 2 个汉字 + 2 个 ASCII = 2 + 0.5 = 2.5 → 3
    expect(estimateTokens('你好ab')).toBe(3);
  });

  it('非字符串输入被 String() 归一', () => {
    expect(estimateTokens(null as unknown as string)).toBe(1);
  });
});
