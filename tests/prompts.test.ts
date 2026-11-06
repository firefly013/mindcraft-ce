import { describe, expect, it } from 'vitest';
import promptDefault, {
  MESSAGES,
  PROMPT_SETS,
  TOOL_TEXT,
  resolvePromptSet,
  td,
  tp,
} from '../src/shared/prompts.js';
import type { AgentProfile } from '../src/shared/types/common.js';

const profile = (over: Record<string, unknown> = {}): AgentProfile =>
  ({ name: 'test', ...over }) as AgentProfile;

describe('td/tp', () => {
  it('returns descriptions for known tools', () => {
    expect(td('restart')).toBe(TOOL_TEXT.restart.description);
    expect(tp('goToPlayer', 'player_name')).toBe(TOOL_TEXT.goToPlayer.params.player_name);
  });

  it('falls back for unknown tools and params', () => {
    expect(td('nope')).toBe('nope');
    expect(tp('stop', 'nope')).toBe('');
    expect(tp('nope', 'nope')).toBe('');
  });
});

describe('MESSAGES', () => {
  it('pins every user-visible template exactly', () => {
    expect(MESSAGES.hello('Andy')).toBe('Hello world! 我是Andy');
    expect(MESSAGES.taskGoal('dig')).toBe('你的任务目标是 dig');
    expect(MESSAGES.taskEnded(0.5)).toBe('任务结束了，得分是 0.5。');
    expect(MESSAGES.taskEnded('timeout')).toBe('任务结束了，得分是 timeout。');
    expect(MESSAGES.actionTimeout(3)).toBe('这次动作超时了，3 分钟没有跑完。');
    expect(MESSAGES.death('x:1', 'overworld', 'boom', 'dirt×1')).toBe(
      "你死在overworld维度，坐标是 x:1。临终消息里写的原因是 'boom'。" +
        '死亡时身上带着 dirt×1。' +
        '你已经重生了。',
    );
    expect(MESSAGES.modelUnsupported).toBe(
      '我的模型不支持原生工具调用，换个 OpenAI 兼容模型再试。',
    );
    expect(MESSAGES.restarting).toBe('重启中。');
    expect(MESSAGES.exiting).toBe('退出中。');
  });

  it('renders a tool outcome line without echoing the model’s own args', () => {
    // 参数是模型刚发出去的，重复回显没有信息；只报工具名与结果。
    expect(MESSAGES.toolOutcome('goToPlayer', 'done')).toBe(
      '调用 goToPlayer 之后，返回的内容是 done',
    );
    // 空输出有个明确的说法，不是空白。
    expect(MESSAGES.toolOutcome('stats', '')).toBe('调用 stats 之后，没有返回任何内容。');
  });
});

describe('resolvePromptSet', () => {
  it('returns defaults for an empty profile', () => {
    expect(resolvePromptSet(profile())).toEqual(PROMPT_SETS.default);
  });

  it('uses the default parameter too', () => {
    expect(resolvePromptSet()).toEqual(PROMPT_SETS.default);
  });

  it('merges a task variant over defaults', () => {
    const set = resolvePromptSet(profile({ promptSet: 'cooking' }));
    // 变体已删，只剩 default：未知 variant 名直接回落整套 default。
    expect(set).toEqual(PROMPT_SETS.default);
  });

  it('ignores unknown variant names', () => {
    expect(resolvePromptSet(profile({ promptSet: 'nope' }))).toEqual(PROMPT_SETS.default);
  });

  it('ignores non-string promptSet', () => {
    expect(resolvePromptSet(profile({ promptSet: 42 }))).toEqual(PROMPT_SETS.default);
  });

  it('lets profiles override individual keys', () => {
    const set = resolvePromptSet(profile({ prompts: { conversing: 'custom', saving_memory: 42 } }));
    expect(set.conversing).toBe('custom');
    expect(set.saving_memory).toBe(PROMPT_SETS.default.saving_memory);
  });
});

describe('default export', () => {
  it('bundles every export', () => {
    expect(promptDefault.PROMPT_SETS).toBe(PROMPT_SETS);
    expect(promptDefault.TOOL_TEXT).toBe(TOOL_TEXT);
    expect(promptDefault.MESSAGES).toBe(MESSAGES);
    expect(promptDefault.td).toBe(td);
    expect(promptDefault.tp).toBe(tp);
    expect(promptDefault.resolvePromptSet).toBe(resolvePromptSet);
  });
});
