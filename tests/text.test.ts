import { describe, expect, it } from 'vitest';
import { strictFormat, stringifyTurns, toSinglePrompt, wordOverlapScore } from '../src/utils/text.js';
import type { ChatMessage } from '../src/types/common.js';

describe('stringifyTurns', () => {
  it('formats each role with its prefix', () => {
    const turns: ChatMessage[] = [
      { role: 'assistant', content: 'hi' },
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'yo' },
    ];
    expect(stringifyTurns(turns)).toBe('Your output:\nhi\nSystem output: sys\nUser input: yo');
  });

  it('returns empty string for no turns', () => {
    expect(stringifyTurns([])).toBe('');
  });
});

describe('toSinglePrompt', () => {
  it('joins turns with stop sequences', () => {
    const turns: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(toSinglePrompt(turns, 'SYS', '***', 'assistant')).toBe(
      'SYS***user: hello***assistant: hi***',
    );
  });

  it('appends a model prompt when the last turn is from the user', () => {
    expect(toSinglePrompt([{ role: 'user', content: 'hello' }])).toBe(
      'user: hello***assistant: ',
    );
  });

  it('uses the nickname for assistant roles', () => {
    expect(toSinglePrompt([{ role: 'assistant', content: 'x' }], null, '***', 'bot')).toBe(
      'bot: x***',
    );
  });
});

describe('wordOverlapScore', () => {
  it('scores identical texts as 1', () => {
    expect(wordOverlapScore('hello world', 'hello world')).toBe(1);
  });

  it('scores disjoint texts as 0', () => {
    expect(wordOverlapScore('aaa', 'bbb')).toBe(0);
  });

  it('strips punctuation and lowercases', () => {
    expect(wordOverlapScore('Hello, World!', 'hello world')).toBe(1);
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
