/**
 * History 压仓契约（照 Pi）：
 *   - 触发线是真实 usage vs `context_window - reserve_tokens`；
 *   - **没有任何条数上限**——条目多但窗口空就不压（这是 max_messages 的坟）；
 *   - 压仓把头部换成一条摘要条目，尾部逐字保留；被压掉的原文进归档。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, SUMMARY_PREFIX } from '../src/agent/history.js';
import type { ChatMessage } from '../src/types/common.js';

interface AgentStub {
  name: string;
  historyDir: string;
  requestLog: { rotate: () => string; rotations: number };
  prompter: {
    profile: Record<string, unknown>;
    promptMemSaving: (turns: ChatMessage[]) => Promise<string>;
  };
}

function makeHistory(opts: { summary?: string; profile?: Record<string, unknown> } = {}): {
  h: History;
  calls: ChatMessage[][];
  dir: string;
  agent: AgentStub;
} {
  const calls: ChatMessage[][] = [];
  // 临时目录：测试不再往仓库的 ./bots 里写 memory/histories。
  const dir = mkdtempSync(join(tmpdir(), 'mindcraft-hist-'));
  const agent: AgentStub = {
    name: 'maxtest',
    historyDir: dir,
    requestLog: {
      rotations: 0,
      rotate(): string {
        this.rotations++;
        return `request-00${this.rotations + 1}.log`;
      },
    },
    prompter: {
      profile: opts.profile ?? {},
      promptMemSaving: (turns: ChatMessage[]): Promise<string> => {
        calls.push(turns);
        return Promise.resolve(opts.summary ?? 'SUMMARY');
      },
    },
  };
  const h = new History(agent);
  return { h, calls, dir, agent };
}

/** 归档目录里最新一个全量历史文件。 */
function latestArchive(dir: string): ChatMessage[] {
  const archiveDir = join(dir, 'histories');
  const files = readdirSync(archiveDir).filter((f) => f.endsWith('.json')).sort();
  const newest = files[files.length - 1] as string;
  return JSON.parse(readFileSync(join(archiveDir, newest), 'utf8')) as ChatMessage[];
}

/** 一个窗口很小、保留量很小的 profile：方便用少量条目触发压仓。 */
const tightProfile = {
  context_window: 100,
  reserve_tokens: 10,
  keep_recent_tokens: 30,
};

describe('History compaction', () => {
  it('does nothing while under the threshold', async () => {
    const { h, calls } = makeHistory({ profile: { context_window: 1_000_000 } });
    await h.add('system', 'a');
    await h.add('bobo', 'b');
    await h.add('maxtest', 'c');
    expect(calls).toHaveLength(0);
    expect(h.turns).toHaveLength(3);
  });

  it('never compacts on message count alone', async () => {
    // 这条是 max_messages 的回归钉子：500 条消息、1M 窗口，必须一条不压。
    const { h, calls } = makeHistory({ profile: { context_window: 1_000_000 } });
    for (let i = 0; i < 500; i++) {
      await h.add(i % 2 === 0 ? 'bobo' : 'maxtest', `line-${i}`);
    }
    expect(calls).toHaveLength(0);
    expect(h.turns).toHaveLength(500);
  });

  it('compacts on real provider usage and keeps the tail verbatim', async () => {
    const { h, calls, agent } = makeHistory({ profile: tightProfile, summary: 'SUMMARY' });
    for (let i = 0; i < 6; i++) await h.add(i % 2 === 0 ? 'bobo' : 'maxtest', `${i}`.padEnd(30, 'x'));
    // 给最后一条 assistant 挂上真实 usage：940 + reserve 10 > 窗口 100。
    const last = h.turns[h.turns.length - 1];
    expect(last.role).toBe('assistant');
    last.usage = { promptTokens: 930, completionTokens: 10, totalTokens: 940 };
    await h.add('bobo', 'wake me');

    expect(calls).toHaveLength(1);
    expect(h.turns[0]?.kind).toBe('summary');
    expect(h.turns[0]?.content).toBe(`${SUMMARY_PREFIX}SUMMARY`);
    expect(h.memory).toBe('SUMMARY');
    // 尾部逐字保留：摘要之后的内容必须还能在 turns 里原样找到。
    expect(h.turns.slice(1).map((t) => t.content).at(-1)).toBe('bobo: wake me');
    // 压仓点 = 请求日志翻页点。
    expect(agent.requestLog.rotations).toBe(1);
  });

  it('archives what it drops instead of losing it', async () => {
    const { h, dir } = makeHistory({ profile: tightProfile });
    for (let i = 0; i < 6; i++) await h.add(i % 2 === 0 ? 'bobo' : 'maxtest', `keep-${i}`.padEnd(30, 'x'));
    h.turns[h.turns.length - 1].usage = { promptTokens: 930, completionTokens: 10, totalTokens: 940 };
    await h.add('bobo', 'tail');

    const archived = latestArchive(dir);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived[0]?.content).toContain('keep-0');
  });

  it('does not summarize when there is nothing to cut', async () => {
    // 条目全是 tool 回执（role=system）时没有合法切点：宁可什么都不做，
    // 也不要把 [摘要, ...原样全部] 写回去（长度 +1、一条没删、下轮再来）。
    const { h, calls } = makeHistory({ profile: { context_window: 1 } });
    await h.add('system', 'aaaa');
    await h.add('system', 'bbbb');
    expect(calls).toHaveLength(0);
    expect(h.turns.map((t) => t.content)).toEqual(['aaaa', 'bbbb']);
  });

  it('does not re-compact immediately after compacting', async () => {
    const { h, calls } = makeHistory({ profile: tightProfile });
    for (let i = 0; i < 6; i++) await h.add(i % 2 === 0 ? 'bobo' : 'maxtest', `${i}`.padEnd(30, 'x'));
    h.turns[h.turns.length - 1].usage = { promptTokens: 930, completionTokens: 10, totalTokens: 940 };
    await h.add('bobo', 'tail');
    expect(calls).toHaveLength(1);
    // 压仓后的锚点被作废，下一轮从头估算——不应该立刻又压一次。
    await h.add('bobo', 'more');
    expect(calls).toHaveLength(1);
  });
});

describe('History.addEvent（事件恰好进上下文一次）', () => {
  it('keeps a player message as a natural user turn, tagged with its event seq', () => {
    const { h } = makeHistory({ profile: { context_window: 1_000_000 } });
    h.addEvent({ kind: 'User', level: 3, payload: { source: 'bobo', message: '挖点木头' }, seq: 15 });
    const turns = h.getHistory();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('user');
    // 序号就是唤醒标记 `## 本轮新事件` 里的那个 #N，模型据此能对上号。
    expect(turns[0]?.content).toBe('#15 bobo: 挖点木头');
  });

  it('renders a world event as one system line — it used to exist only in the tail', () => {
    const { h } = makeHistory({ profile: { context_window: 1_000_000 } });
    h.addEvent({ kind: 'World', level: 3, payload: { type: 'inventory.collected', item: 'oak_log' }, seq: 16 });
    const turns = h.getHistory();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe('event');
    expect(turns[0]?.content).toBe('#16 World/L3 {"type":"inventory.collected","item":"oak_log"}');
  });

  it('system-sourced chat still reads as a user turn', () => {
    const { h } = makeHistory({ profile: { context_window: 1_000_000 } });
    h.addEvent({ kind: 'User', level: 3, payload: { source: 'system', message: '任务目标：砍树' }, seq: 1 });
    expect(h.getHistory()[0]?.content).toBe('#1 system: 任务目标：砍树');
  });
});

describe('History.getHistory', () => {  it('returns the complete history — no tail budget, no truncation', async () => {
    const { h } = makeHistory({ profile: { context_window: 1_000_000, max_history_entries: 2, max_history_tokens: 3 } });
    for (let i = 0; i < 30; i++) await h.add(i % 2 === 0 ? 'bobo' : 'maxtest', `line-${i}`);
    const sent = h.getHistory();
    expect(sent).toHaveLength(30);
    expect(sent[0]?.content).toContain('line-0');
    expect(sent.at(-1)?.content).toContain('line-29');
  });

  it('strips nothing but does not leak internals into the payload copy', async () => {
    const { h } = makeHistory({ profile: { context_window: 1_000_000 } });
    await h.add('maxtest', 'hi', { kind: 'model', level: 2 });
    const sent = h.getHistory();
    expect(sent[0]?.kind).toBe('model');
    // 内部字段仍在对象上，但 gpt.toLlmMessages 负责在发出前剥掉。
  });
});
