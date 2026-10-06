/**
 * 静态系统提示词：与旧 `Prompter.replaceStrings` 在**静态部分**上等价，
 * 并且明确保证"动态内容一个都不进来"（system 是 section，值一变缓存全废）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_SETS, resolvePromptSet } from '../src/prompts.js';
import { staticSystemPrompt, systemPromptFromProfile } from '../src/runtime/prompt.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const REAL = PROMPT_SETS['default']?.['conversing'] ?? '';

describe('staticSystemPrompt', () => {
  it('替换 $NAME', () => {
    expect(staticSystemPrompt('你是 $NAME，$NAME 干活。', 'Andy')).toBe('你是 Andy，Andy 干活。');
  });

  it('真实提示词渲染后没有剩余占位符', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = staticSystemPrompt(REAL, 'Andy');
    expect(text).not.toMatch(/\$[A-Z_]+/);
    expect(warn).not.toHaveBeenCalled();
    expect(text).toContain('Andy');
  });

  it('剩余占位符会警告，而不是静默留下 $FOO', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = staticSystemPrompt('$NAME 和 $STATS 和 $MEMORY', 'Andy');
    expect(text).toContain('$STATS');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('$STATS');
  });
});

describe('systemPromptFromProfile', () => {
  it('从 profile 解析提示词集', () => {
    const text = systemPromptFromProfile({ name: 'tester' }, 'tester');
    expect(text).toContain('tester');
    expect(text).not.toMatch(/\$[A-Z_]+/);
  });

  it('与 resolvePromptSet 的 conversing 同源', () => {
    const prompts = resolvePromptSet(undefined) as Record<string, string>;
    const expected = (prompts['conversing'] ?? '').replaceAll('$NAME', 'X');
    expect(systemPromptFromProfile({}, 'X')).toBe(expected);
  });

  it('未知的 prompt_set 回退到默认集，不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = systemPromptFromProfile({ prompt_set: '不存在的集' }, 'X');
    expect(text).toBe(staticSystemPrompt(REAL, 'X'));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('静态性：动态内容不得进来', () => {
  it('真实提示词不含 $STATS / $INVENTORY / $ACTION / $MEMORY / $CONVO', () => {
    // 这些现在分别由每轮尾巴（Live State / 记忆）与对话历史承担。
    // 一旦有人把它们塞回系统提示词，前缀缓存会每轮失效。
    for (const placeholder of ['$STATS', '$INVENTORY', '$ACTION', '$MEMORY', '$CONVO']) {
      expect(REAL).not.toContain(placeholder);
    }
  });

  it('同一输入两次渲染结果相同（可以安全地放进 section）', () => {
    expect(staticSystemPrompt(REAL, 'Andy')).toBe(staticSystemPrompt(REAL, 'Andy'));
  });
});
