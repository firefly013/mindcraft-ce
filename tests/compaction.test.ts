/**
 * 压仓契约（照 Pi）：
 *   - 触发线是 `contextTokens > contextWindow - reserveTokens`，
 *     contextTokens 优先取 provider 报的真实 usage；
 *   - 切点从最新往前累加，攒够 keepRecentTokens 就切，只在 user/assistant 边界切；
 *   - 压仓只把头部换成一条摘要条目，尾部逐字保留，不删历史。
 *
 * 这里同时钉住"没有条数上限"这条：条目多但窗口很空时**不得**压仓。
 */
import { describe, expect, it } from 'vitest';
import {
  contextUsage,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  estimateEntriesTokens,
  estimateTokens,
  FALLBACK_CONTEXT_WINDOW,
  findCutPoint,
  maybeCompact,
  resolvePolicy,
  shouldCompact,
} from '../src/agent/compaction.js';
import type { Compactable, CompactionPolicy } from '../src/agent/compaction.js';

interface E extends Compactable {
  text: string;
}

const entry = (text: string, role = 'user', extra: Partial<E> = {}): E => ({
  text,
  role,
  content: text,
  ...extra,
});

const assistantWithUsage = (text: string, totalTokens: number): E =>
  entry(text, 'assistant', { usage: { totalTokens } });

const summaryOf = (text: string, at: number): E => ({
  text: `summary: ${text}`,
  role: 'system',
  content: `summary: ${text}`,
  kind: 'summary',
  level: 2,
  at,
});

const policy = (over: Partial<CompactionPolicy> = {}): CompactionPolicy => ({
  enabled: true,
  contextWindow: 1000,
  reserveTokens: 100,
  keepRecentTokens: 100,
  ...over,
});

describe('estimateTokens', () => {
  it('overestimates: CJK ~1, ASCII ~1/4, always ceil', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc你好')).toBeGreaterThanOrEqual(3);
  });

  it('counts an entry as role + content', () => {
    expect(estimateEntriesTokens([])).toBe(0);
    expect(estimateEntriesTokens([{ role: 'user', content: 'hi' }])).toBeGreaterThan(0);
    // 空条目（没有正文）不占上下文。
    expect(estimateEntriesTokens([{ role: 'system', content: '' }])).toBe(0);
  });
});

describe('resolvePolicy', () => {
  it('reads window / reserve / keep from the profile, with Pi defaults', () => {
    expect(resolvePolicy({ context_window: 1_000_000 })).toEqual({
      enabled: true,
      contextWindow: 1_000_000,
      reserveTokens: DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    });
    expect(resolvePolicy({}).contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolvePolicy(null).contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolvePolicy({ context_window: -5 }).contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolvePolicy({ context_window: 'big' }).contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(resolvePolicy({ reserve_tokens: 500, keep_recent_tokens: 50 })).toMatchObject({
      reserveTokens: 500,
      keepRecentTokens: 50,
    });
  });

  it('can be switched off', () => {
    expect(resolvePolicy({ compaction_enabled: false }).enabled).toBe(false);
  });
});

describe('contextUsage', () => {
  it('anchors on the last real usage and estimates only what came after', () => {
    const entries = [
      entry('old'),
      assistantWithUsage('a', 900),
      entry('x'.repeat(400)), // 估算 ~100 token
    ];
    const usage = contextUsage(entries);
    expect(usage.anchorIndex).toBe(1);
    expect(usage.usageTokens).toBe(900);
    expect(usage.trailingTokens).toBeGreaterThan(0);
    expect(usage.tokens).toBe(900 + usage.trailingTokens);
  });

  it('falls back to a pure estimate when the provider reported nothing', () => {
    const entries = [entry('a'), entry('b')];
    const usage = contextUsage(entries);
    expect(usage.anchorIndex).toBeNull();
    expect(usage.usageTokens).toBe(0);
    expect(usage.tokens).toBe(estimateEntriesTokens(entries));
  });

  it('ignores an anchor that predates the latest compaction', () => {
    // 压仓之后头部被换成摘要；那条 assistant 的 usage 描述的是压仓前
    // 那个更大的上下文，拿它当基线会让下一轮立刻又压一次。
    const entries = [
      assistantWithUsage('a', 999_999),
      summaryOf('s', 1),
      entry('after compaction'),
    ];
    const usage = contextUsage(entries);
    expect(usage.anchorIndex).toBeNull();
    expect(usage.tokens).toBeLessThan(999_999);
  });

  it('trusts the anchor when the summary carries no timestamp to compare against', () => {
    // 老存档/外部注入的摘要条目可能没有 `at`：没有时间戳就没法判新旧，
    // 这时退回"按下标"的规则——摘要之后第一条 assistant usage 仍然可信。
    const bare: E = { text: 's', role: 'system', content: 's', kind: 'summary' };
    const entries = [assistantWithUsage('old', 999_999), bare, assistantWithUsage('new', 500)];
    const usage = contextUsage(entries);
    expect(usage.anchorIndex).toBe(2);
    expect(usage.usageTokens).toBe(500);
  });
});

describe('shouldCompact', () => {
  it('is a strict > against window - reserve', () => {
    const p = policy({ contextWindow: 1000, reserveTokens: 100 });
    expect(shouldCompact(900, p)).toBe(false);
    expect(shouldCompact(901, p)).toBe(true);
  });

  it('respects enabled=false', () => {
    expect(shouldCompact(1_000_000, policy({ enabled: false }))).toBe(false);
  });
});

describe('findCutPoint', () => {
  it('keeps a tail worth keepRecentTokens, cutting at a user/assistant boundary', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`m${i}`.padEnd(40, 'x')));
    const cut = findCutPoint(entries, 200);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(entries.length);
    expect(['user', 'assistant']).toContain(entries[cut].role);
    expect(estimateEntriesTokens(entries.slice(cut))).toBeGreaterThanOrEqual(200);
  });

  it('never starts the kept tail on a tool result', () => {
    const entries = [
      entry('u0'),
      entry('a0', 'assistant'),
      entry('tool0', 'system', { kind: 'tool' }),
      entry('tool1', 'system', { kind: 'tool' }),
    ];
    const cut = findCutPoint(entries, 1);
    expect(['user', 'assistant']).toContain(entries[cut].role);
  });

  it('returns 0 when the whole conversation fits the keep budget', () => {
    const entries = [entry('short'), entry('short2')];
    expect(findCutPoint(entries, DEFAULT_KEEP_RECENT_TOKENS)).toBe(0);
  });
});

describe('maybeCompact', () => {
  it('does nothing below the threshold and returns the same array', async () => {
    const entries = [entry('a'), entry('b')];
    const r = await maybeCompact({ entries, policy: policy(), summarize: () => 's', makeSummary: summaryOf });
    expect(r.compacted).toBe(false);
    expect(r.reason).toBe('below-threshold');
    expect(r.entries).toBe(entries);
  });

  it('NEVER compacts on message count alone: many entries, huge window', async () => {
    // 这正是 max_messages=15 干的坏事：窗口还很空就把历史压掉。
    const entries = Array.from({ length: 500 }, (_, i) => entry(`turn ${i}`, i % 2 ? 'user' : 'assistant'));
    const r = await maybeCompact({
      entries,
      policy: policy({ contextWindow: 1_000_000, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
      summarize: () => 'should not run',
      makeSummary: summaryOf,
    });
    expect(r.compacted).toBe(false);
    expect(r.entries).toBe(entries);
  });

  it('compacts on real usage from the provider', async () => {
    const entries = [assistantWithUsage('a', 950), entry('trailing')];
    let summarized: E[] = [];
    const r = await maybeCompact({
      entries,
      policy: policy({ contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 1 }),
      summarize: (head) => {
        summarized = head;
        return 'SUMMARY';
      },
      makeSummary: summaryOf,
    });
    expect(r.compacted).toBe(true);
    expect(r.summary).toBe('SUMMARY');
    expect(summarized).toHaveLength(1);
    expect(r.entries[0].kind).toBe('summary');
  });

  it('keeps the tail verbatim and prepends the summary entry', async () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry(`m${i}`.padEnd(40, 'x'), i % 2 ? 'user' : 'assistant'),
    );
    const r = await maybeCompact({
      entries,
      policy: policy({ contextWindow: 100, reserveTokens: 10, keepRecentTokens: 200 }),
      summarize: (head) => `covered ${head.length}`,
      makeSummary: summaryOf,
    });
    expect(r.compacted).toBe(true);
    expect(r.entries[0].kind).toBe('summary');
    const kept = r.entries.slice(1);
    expect(r.keptCount).toBe(kept.length);
    expect(kept.map((e) => e.text)).toEqual(entries.slice(entries.length - kept.length).map((e) => e.text));
    expect(r.summarizedCount).toBe(entries.length - kept.length);
  });

  it('does nothing when the whole conversation is inside the keep budget', async () => {
    const entries = [entry('a'), entry('b')];
    const r = await maybeCompact({
      entries,
      policy: policy({ contextWindow: 4, reserveTokens: 1, keepRecentTokens: 100_000 }),
      summarize: () => 's',
      makeSummary: summaryOf,
    });
    expect(r.compacted).toBe(false);
    expect(r.reason).toBe('nothing-to-summarize');
  });

  it('does nothing without a summarizer instead of making a no-op entry', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`m${i}`.padEnd(40, 'x')));
    const r = await maybeCompact({
      entries,
      policy: policy({ contextWindow: 100, reserveTokens: 10, keepRecentTokens: 100 }),
      summarize: null,
      makeSummary: null,
    });
    expect(r.compacted).toBe(false);
    expect(r.reason).toBe('no-summarizer');
    expect(r.entries).toHaveLength(entries.length);
  });

  it('force bypasses the threshold (overflow recovery)', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`m${i}`.padEnd(40, 'x')));
    const r = await maybeCompact({
      entries,
      policy: policy({ contextWindow: 1_000_000, reserveTokens: 16_384, keepRecentTokens: 200 }),
      summarize: () => 'forced',
      makeSummary: summaryOf,
      force: true,
    });
    expect(r.compacted).toBe(true);
    expect(r.summary).toBe('forced');
  });
});
