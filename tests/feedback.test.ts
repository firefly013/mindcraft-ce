/**
 * Feedback 契约：形状校验严格、自动附 plan 与历史尾部摘要、
 * 落盘 JSONL、写失败原样抛（绝不静默丢意见）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  appendFeedback,
  buildFeedbackEntry,
  validateFeedback,
} from '../src/agent/feedback.js';
import { getOpenAITools, isActionTool, toolExists, validateToolCall } from '../src/agent/commands/to_openai_tools.js';

describe('validateFeedback', () => {
  it('accepts a full valid call', () => {
    expect(validateFeedback({ title: '寻路过水卡住', body: 'goto 河边时反复原地跳' }).ok).toBe(true);
  });

  it('rejects empty and unknown keys', () => {
    expect(validateFeedback({ title: '  ', body: 'x' }).ok).toBe(false);
    expect(validateFeedback({ title: 't' }).ok).toBe(false);
    expect(validateFeedback({ title: 't', body: 'b', extra: 1 }).ok).toBe(false);
    expect(validateFeedback(null).ok).toBe(false);
  });
});

describe('buildFeedbackEntry', () => {
  it('attaches timestamp, plan and a summarized history tail', () => {
    const long = 'x'.repeat(500);
    const entry = buildFeedbackEntry(
      { title: 't', body: 'b' },
      {
        at: 42,
        plan: { goal: '盖房', todos: ['打地基'] },
        historyTail: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: long },
        ],
      },
    );
    expect(entry.at).toBe(42);
    expect(entry.plan).toEqual({ goal: '盖房', todos: ['打地基'] });
    expect(entry.recent).toHaveLength(2);
    expect(entry.recent?.[1]?.summary.length).toBeLessThan(500);
  });

  it('clamps title and body by code points', () => {
    const entry = buildFeedbackEntry({ title: '标'.repeat(200), body: '石'.repeat(5000) });
    // 保留前 120 码点，尾部接截断标记（标记本身占 4 码点）。
    expect(entry.title.startsWith('标'.repeat(120))).toBe(true);
    expect(entry.title).toContain('[截断]');
    expect(entry.title.endsWith('[截断]')).toBe(true);
    expect(entry.body.startsWith('石'.repeat(4000))).toBe(true);
    expect(entry.body.endsWith('[截断]')).toBe(true);
  });

  it('keeps only the last 8 history entries', () => {
    const tail = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    const entry = buildFeedbackEntry({ title: 't', body: 'b' }, { historyTail: tail });
    expect(entry.recent).toHaveLength(8);
    expect(entry.recent?.[7]?.summary).toBe('m11');
  });
});

describe('appendFeedback', () => {
  it('writes one JSONL line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedback-'));
    const entry = buildFeedbackEntry({ title: 't', body: 'b' }, { at: 7 });
    const file = appendFeedback(dir, entry);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).title).toBe('t');
  });

  it('throws (never swallows) when the sink fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedback-bad-'));
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x', 'utf8');
    const entry = buildFeedbackEntry({ title: 't', body: 'b' });
    expect(() => appendFeedback(blocker, entry)).toThrow();
  });
});

describe('Feedback on the tool surface', () => {
  it('is a known, channel-free control tool with a strict schema', () => {
    expect(toolExists('Feedback')).toBe(true);
    expect(isActionTool('Feedback')).toBe(false);
    expect(validateToolCall('Feedback', { title: 't', body: 'b' }).ok).toBe(true);
    expect(validateToolCall('Feedback', { title: 't' }).ok).toBe(false);
    const tools = getOpenAITools({ blocked_actions: [] });
    const feedback = tools.find((t) => t.function.name === 'Feedback');
    expect(feedback).toBeDefined();
    expect(feedback?.function.parameters).toMatchObject({
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'],
    });
  });
});
