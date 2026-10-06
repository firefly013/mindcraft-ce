/**
 * Compaction 契约：90% 才动手，能删 25% 就删，否则总结。
 * 工具往来和模型原文永远不进删除名单。
 */
import { describe, expect, it } from 'vitest';
import {
  COMPACT_AT,
  DEFAULT_KEEP_LAST,
  entriesTokens,
  estimateTokens,
  FALLBACK_CONTEXT_WINDOW,
  maybeCompact,
  resolveContextWindow,
  WORLD_TTL_MS,
} from '../src/agent/compaction.js';
import type { Compactable } from '../src/agent/compaction.js';

interface E extends Compactable {
  text: string;
}

const entry = (text: string, kind = 'tool', level = 2, at = 0): E => ({ text, kind, level, at });
const summaryOf = (text: string, at: number): E => ({ text: `summary: ${text}`, kind: 'system', level: 2, at });

describe('estimateTokens', () => {
  it('overestimates: CJK ~1, ASCII ~1/4, always ceil', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc你好')).toBeGreaterThanOrEqual(3);
  });
});

describe('resolveContextWindow', () => {
  it('uses a positive configured window, else the conservative fallback', () => {
    expect(resolveContextWindow({ context_window: 64000 })).toBe(64000);
    expect(resolveContextWindow({})).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveContextWindow(null)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveContextWindow({ context_window: -5 })).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolveContextWindow({ context_window: 'big' })).toBe(FALLBACK_CONTEXT_WINDOW);
  });
});

describe('entriesTokens', () => {
  it('sums role+content estimates, tolerates missing fields', () => {
    expect(entriesTokens([])).toBe(0);
    expect(entriesTokens([{ role: 'user', content: 'hi' }])).toBeGreaterThan(0);
    expect(entriesTokens([{}])).toBeGreaterThanOrEqual(0);
  });
});

describe('maybeCompact', () => {
  it('below pressure does nothing and returns the same array', () => {
    const entries = [entry('a'), entry('b')];
    return maybeCompact({ entries, usageRatio: COMPACT_AT - 0.01 }).then((r) => {
      expect(r.compacted).toBe(false);
      expect(r.level).toBe(0);
      expect(r.entries).toBe(entries);
    });
  });

  it('level-1: deletes expired world noise when it frees enough', async () => {
    const now = 1_000_000;
    const fresh: E[] = [entry('keep1', 'tool'), entry('keep2', 'model')];
    const stale: E[] = [
      entry('old1', 'world', 3, now - WORLD_TTL_MS - 1),
      entry('old2', 'world', 3, now - WORLD_TTL_MS - 1),
    ];
    const r = await maybeCompact({ entries: [...fresh, ...stale], usageRatio: 1, now });
    expect(r.compacted).toBe(true);
    expect(r.level).toBe(1);
    expect(r.removed).toBe(2);
    expect(r.entries.map((e) => e.text)).toEqual(['keep1', 'keep2']);
  });

  it('level-1 never touches tool/model traffic, however old', async () => {
    const now = 1_000_000;
    const entries = [
      entry('tool-old', 'tool', 2, 0),
      entry('model-old', 'model', 2, 0),
      entry('user-old', 'user', 3, 0),
    ];
    // 三条都在 keepLast 里：没有可压的头部，所以什么都不做——不删、也不空调一次总结。
    const short = await maybeCompact({
      entries,
      usageRatio: 1,
      now,
      summarize: () => 's',
      makeSummary: summaryOf,
    });
    expect(short.compacted).toBe(false);
    expect(short.level).toBe(0);
    expect(short.entries.map((e) => e.text)).toEqual(['tool-old', 'model-old', 'user-old']);

    // 条目多到有头部时走 level-2：老 tool/model 是"被总结进去"，而不是"被当过期删掉"。
    const many = [...entries, ...Array.from({ length: 25 }, (_, i) => entry(`m${i}`, 'tool', 2, 0))];
    let summarized: E[] = [];
    const long = await maybeCompact({
      entries: many,
      usageRatio: 1,
      now,
      summarize: (head) => {
        summarized = head;
        return 's';
      },
      makeSummary: summaryOf,
    });
    expect(long.level).toBe(2);
    expect(long.summary).toBe('s');
    const headTexts = summarized.map((e) => e.text);
    expect(headTexts).toContain('tool-old');
    expect(headTexts).toContain('model-old');
  });

  it('entries without kind/at are never obsolete', async () => {
    const entries: E[] = [{ text: 'legacy' }, { text: 'legacy2' }];
    const r = await maybeCompact({ entries, usageRatio: 1, now: 999 });
    expect(r.removed).toBe(0);
    expect(r.entries).toHaveLength(2);
  });

  it('level-2 keeps the tail verbatim and summarizes the head', async () => {
    const entries = Array.from({ length: DEFAULT_KEEP_LAST + 10 }, (_, i) =>
      entry(`m${i}`, i % 2 === 0 ? 'tool' : 'model'),
    );
    let summarized: E[] = [];
    const r = await maybeCompact({
      entries,
      usageRatio: 1,
      now: 1,
      keepLast: DEFAULT_KEEP_LAST,
      summarize: (head) => {
        summarized = head;
        return `first was ${head[0]?.text}`;
      },
      makeSummary: summaryOf,
    });
    expect(r.level).toBe(2);
    expect(summarized).toHaveLength(10);
    expect(r.summary).toBe('first was m0');
    expect(r.entries.slice(1).map((e) => e.text)).toEqual(entries.slice(-DEFAULT_KEEP_LAST).map((e) => e.text));
  });

  it('without a summarizer it reports level-1 with nothing removed', async () => {
    const entries = [entry('a', 'tool'), entry('b', 'model')];
    const r = await maybeCompact({ entries, usageRatio: 1, now: 1, summarize: null });
    expect(r.compacted).toBe(true);
    expect(r.level).toBe(1);
    expect(r.removed).toBe(0);
    expect(r.entries).toHaveLength(2);
  });
});
