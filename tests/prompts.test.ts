import { describe, expect, it } from 'vitest';
import promptDefault, {
  MESSAGES,
  PROMPT_SETS,
  TOOL_TEXT,
  resolvePromptSet,
  td,
  tp,
} from '../src/prompts.js';
import type { AgentProfile } from '../src/types/common.js';

const profile = (over: Record<string, unknown> = {}): AgentProfile =>
  ({ name: 'test', ...over }) as AgentProfile;

describe('td/tp', () => {
  it('returns descriptions for known tools', () => {
    expect(td('stfu')).toBe(TOOL_TEXT.stfu.description);
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
    expect(MESSAGES.usedMarker('stop')).toBe('*used stop*');
    expect(MESSAGES.taskGoal('dig')).toBe('你的任务目标：dig');
    expect(MESSAGES.taskEnded(0.5)).toBe('任务结束，得分：0.5');
    expect(MESSAGES.taskEnded('timeout')).toBe('任务结束，得分：timeout');
    expect(MESSAGES.actionTimeout(3)).toBe('动作超时（3 分钟），正在强制停止。');
    expect(MESSAGES.death('x:1', 'overworld', 'boom')).toBe(
      "你死在了overworld维度 x:1，临终消息：'boom'。" +
        "死亡点已存为 'last_death_position'，想回去可以找它。" +
        '之前的动作已停止，你已重生。',
    );
    expect(MESSAGES.goalDone('g')).toBe('你刚成功完成了目标g。');
    expect(MESSAGES.goalFailed('g')).toBe('你刚没能完成目标g。');
    expect(MESSAGES.modelUnsupported).toBe(
      '我的模型不支持原生工具调用，换个 OpenAI 兼容模型再试。',
    );
    expect(MESSAGES.recentConvoPrefix).toBe('最近对话：\n');
    expect(MESSAGES.shuttingUp).toBe('闭嘴了。');
    expect(MESSAGES.restarting).toBe('重启中。');
    expect(MESSAGES.exiting).toBe('退出中。');
  });

  it('renders a tool outcome line with args, truncation and empty-output marker', () => {
    expect(MESSAGES.toolOutcome('goToPlayer', { player_name: 'steve' }, 'done')).toBe(
      '工具 goToPlayer {"player_name":"steve"} → done',
    );
    // 空输出有个明确的占位，不是空白。
    expect(MESSAGES.toolOutcome('stats', {}, '')).toBe('工具 stats {} → (无输出)');
    // 无法序列化（循环引用）与 undefined 都退化成 {}，绝不抛错。
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(MESSAGES.toolOutcome('x', circular, 'ok')).toBe('工具 x {} → ok');
    expect(MESSAGES.toolOutcome('x', undefined, 'ok')).toBe('工具 x {} → ok');
    // 超长参数截断并标记。
    const long = MESSAGES.toolOutcome('x', { blob: 'y'.repeat(900) }, 'ok');
    expect(long).toContain('[截断]');
    expect(long.length).toBeLessThan(600);
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
    const set = resolvePromptSet(profile({ prompt_set: 'cooking' }));
    // 变体已删，只剩 default：未知 variant 名直接回落整套 default。
    expect(set).toEqual(PROMPT_SETS.default);
  });

  it('ignores unknown variant names', () => {
    expect(resolvePromptSet(profile({ prompt_set: 'nope' }))).toEqual(PROMPT_SETS.default);
  });

  it('ignores non-string prompt_set', () => {
    expect(resolvePromptSet(profile({ prompt_set: 42 }))).toEqual(PROMPT_SETS.default);
  });

  it('lets profiles override individual keys', () => {
    const set = resolvePromptSet(profile({ conversing: 'custom', saving_memory: 42 }));
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
