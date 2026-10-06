/**
 * 压仓契约：历史到顶时必须真的走 compaction，而不是把旧消息
 * 悄悄砍掉。
 *
 * 回归点：`history.add` 曾经给 maybeCompact 传 `summarize: null`，
 * 于是 level-2 分支永远进不去——策略接了根断线，实际裁剪全靠老
 * 代码按条数往下 splice，一次丢 5 条且没有摘要回填。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, MEMORY_LIMIT } from '../src/agent/history.js';
import type { ChatMessage } from '../src/types/common.js';

function makeHistory(opts: { maxMessages?: number; summary?: string; profile?: Record<string, unknown> } = {}): {
  h: History;
  calls: ChatMessage[][];
  dir: string;
} {
  const calls: ChatMessage[][] = [];
  // 临时目录：测试不再往仓库的 ./bots 里写 memory/histories。
  const dir = mkdtempSync(join(tmpdir(), 'mindcraft-hist-'));
  const agent = {
    name: 'maxtest',
    historyDir: dir,
    prompter: {
      profile: opts.profile ?? {},
      promptMemSaving: (turns: ChatMessage[]): Promise<string> => {
        calls.push(turns);
        return Promise.resolve(opts.summary ?? 'SUMMARY');
      },
    },
  };
  const h = new History(agent);
  h.max_messages = opts.maxMessages ?? 4;
  return { h, calls, dir };
}

/** 归档目录里最新一个全量历史文件。 */
function latestArchive(dir: string): ChatMessage[] {
  const archiveDir = join(dir, 'histories');
  const files = readdirSync(archiveDir).filter((f) => f.endsWith('.json')).sort();
  const newest = files[files.length - 1] as string;
  return JSON.parse(readFileSync(join(archiveDir, newest), 'utf8')) as ChatMessage[];
}

describe('History compaction', () => {
  it('does not summarize before the cap is reached', async () => {
    const { h, calls } = makeHistory({ maxMessages: 4 });
    await h.add('system', 'a');
    await h.add('system', 'b');
    await h.add('system', 'c');
    expect(calls).toHaveLength(0);
    expect(h.turns).toHaveLength(3);
  });

  it('summarizes the head and keeps the tail verbatim at the cap', async () => {
    const { h, calls } = makeHistory({ maxMessages: 4 });
    await h.add('system', 'a');
    await h.add('system', 'b');
    await h.add('system', 'c');
    await h.add('system', 'd');

    // keepLast = max_messages / 3 = 1：头部 3 条被总结，尾部 1 条逐字保留。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((t) => t.content)).toEqual(['a', 'b', 'c']);
    expect(h.turns).toHaveLength(2);
    expect(h.turns[0]?.kind).toBe('summary');
    expect(h.turns[0]?.level).toBe(2);
    expect(h.turns[0]?.content).toContain('SUMMARY');
    expect(h.turns.slice(1).map((t) => t.content)).toEqual(['d']);
    expect(h.memory).toBe('SUMMARY');
  });

  it('keeps compacting without thrashing on every single message', async () => {
    const { h, calls } = makeHistory({ maxMessages: 4 });
    for (let i = 0; i < 4; i++) await h.add('system', `m${i}`);
    expect(calls).toHaveLength(1);
    // 压完 3 条，再进来一条还不到顶：不该立刻再总结一次。
    await h.add('system', 'm4');
    expect(calls).toHaveLength(1);
    await h.add('system', 'm5');
    expect(calls).toHaveLength(2);
  });

  it('archives what it drops instead of losing it', async () => {
    const { h, dir } = makeHistory({ maxMessages: 4 });
    await h.add('system', 'keep-me-1');
    await h.add('system', 'keep-me-2');
    await h.add('system', 'keep-me-3');
    await h.add('system', 'keep-me-4');
    const archived = latestArchive(dir);
    expect(archived.map((t) => t.content)).toEqual(['keep-me-1', 'keep-me-2', 'keep-me-3']);
  });

  it('truncates an over-long memory with a marker', async () => {
    const { h } = makeHistory({ maxMessages: 2, summary: 'x'.repeat(MEMORY_LIMIT + 100) });
    await h.add('system', 'a');
    await h.add('system', 'b');
    expect(h.memory.length).toBeLessThan(MEMORY_LIMIT + 120);
    expect(h.memory).toContain('Memory truncated');
  });

  it('declines when token pressure hits but there is no head to cut', async () => {
    // 窗口极小 + 条目数 ≤ keepLast：以前这里会拿空数组去调一次模型，
    // 然后把 [摘要, ...原样全部] 写回去——长度 +1、一条没删、下轮再来一次。
    const { h, calls } = makeHistory({ maxMessages: 100, profile: { context_window: 4 } });
    await h.add('system', 'aaaa');
    await h.add('system', 'bbbb');
    expect(calls).toHaveLength(0);
    expect(h.turns.map((t) => t.content)).toEqual(['aaaa', 'bbbb']);
  });

  it('fires on token pressure once there is a head to summarize', async () => {
    // keepLast = floor(9/3) = 3，所以第 4 条进来时头部非空，才真的压。
    const { h, calls } = makeHistory({ maxMessages: 9, profile: { context_window: 4 } });
    for (const m of ['aaaa', 'bbbb', 'cccc', 'dddd']) await h.add('system', m);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.length).toBeGreaterThan(0);
    expect(h.turns[0]?.kind).toBe('summary');
  });
});

describe('History.getHistory tail budget', () => {
  const fill = async (h: History, n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await h.add('system', `line-${i}`);
  };

  it('returns everything by default', async () => {
    const { h } = makeHistory({ maxMessages: 1000 });
    await fill(h, 5);
    expect(h.getHistory()).toHaveLength(5);
  });

  it('honours max_history_entries from the newest end', async () => {
    const { h } = makeHistory({ maxMessages: 1000, profile: { max_history_entries: 2 } });
    await fill(h, 5);
    expect(h.getHistory().map((t) => t.content)).toEqual(['line-3', 'line-4']);
  });

  it('honours max_history_tokens but always keeps the newest entry', async () => {
    const { h } = makeHistory({ maxMessages: 1000, profile: { max_history_tokens: 3 } });
    await fill(h, 5);
    const kept = h.getHistory();
    expect(kept).toHaveLength(1);
    expect(kept[0]?.content).toBe('line-4');
  });

  it('treats a non-positive budget as unlimited', async () => {
    const { h } = makeHistory({ maxMessages: 1000, profile: { max_history_entries: 0, max_history_tokens: 0 } });
    await fill(h, 4);
    expect(h.getHistory()).toHaveLength(4);
  });
});
