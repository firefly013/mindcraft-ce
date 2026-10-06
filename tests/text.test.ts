import { describe, expect, it } from 'vitest';
import { serializeConversation, strictFormat, toLlmMessages } from '../src/utils/text.js';

describe('toLlmMessages', () => {
  it('strips internal fields and keeps only role + content', () => {
    const out = toLlmMessages([
      { role: 'user', content: 'task', kind: 'user', level: 3, at: 1 },
      {
        role: 'assistant',
        content: 'hi',
        kind: 'model',
        level: 2,
        at: 2,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('still normalizes roles through strictFormat', () => {
    expect(toLlmMessages([{ role: 'system', content: 'sys', kind: 'tool' }])).toEqual([
      { role: 'user', content: 'SYSTEM: sys' },
    ]);
  });
});

describe('serializeConversation', () => {
  it('renders a ledger, not a conversation the summarizer would continue', () => {
    const text = serializeConversation([
      { role: 'user', content: '挖点木头' },
      { role: 'assistant', content: '好' },
      { role: 'system', content: '工具 collectBlocks {} → accepted', kind: 'tool' },
      { role: 'system', content: '[记忆摘要] old', kind: 'summary' },
    ]);
    expect(text).toBe(
      '[User]: 挖点木头\n[Assistant]: 好\n[Tool result]: 工具 collectBlocks {} → accepted\n[Previous summary]: [记忆摘要] old',
    );
  });

  it('labels a plain system turn as [System]', () => {
    // 没有 kind 的 system 行（开场白、动作超时这类）走最后那个兜底标签。
    const text = serializeConversation([{ role: 'system', content: '动作超时' }]);
    expect(text).toBe('[System]: 动作超时');
  });

  it('truncates long tool output so the summarization request itself fits', () => {
    const text = serializeConversation([{ role: 'system', content: 'x'.repeat(50), kind: 'tool' }], 10);
    expect(text).toContain('…[truncated 40 chars]');
  });
});

describe('strictFormat', () => {
  it('converts system messages to user messages with SYSTEM prefix', () => {
    expect(strictFormat([{ role: 'system', content: '  hi  ' }])).toEqual([
      { role: 'user', content: 'SYSTEM: hi' },
    ]);
  });

  it('inserts a filler between consecutive assistant messages', () => {
    const out = strictFormat([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: '_' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('merges consecutive user messages', () => {
    expect(strictFormat([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ])).toEqual([{ role: 'user', content: 'a\nb' }]);
  });

  it('prepends a filler when history starts with assistant', () => {
    expect(strictFormat([{ role: 'assistant', content: 'a' }])).toEqual([
      { role: 'user', content: '_' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('returns a filler for empty input', () => {
    expect(strictFormat([])).toEqual([{ role: 'user', content: '_' }]);
  });
});
