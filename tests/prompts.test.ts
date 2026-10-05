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
    expect(td('stop')).toBe(TOOL_TEXT.stop.description);
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
    expect(MESSAGES.hello('Andy')).toBe('Hello world! I am Andy');
    expect(MESSAGES.usedMarker('stop')).toBe('*used stop*');
    expect(MESSAGES.taskGoal('dig')).toBe('你的任务目标：dig');
    expect(MESSAGES.taskEnded(0.5)).toBe('Task ended with score : 0.5');
    expect(MESSAGES.taskEnded('timeout')).toBe('Task ended with score : timeout');
    expect(MESSAGES.actionTimeout(3)).toBe(
      'Action timed out after 3 minutes. Attempting force stop.',
    );
    expect(MESSAGES.death('x:1', 'overworld', 'boom')).toBe(
      "You died at position x:1 in the overworld dimension with the final message: 'boom'. " +
        "Your place of death is saved as 'last_death_position' if you want to return. " +
        'Previous actions were stopped and you have respawned.',
    );
    expect(MESSAGES.goalDone('g')).toBe('You recently successfully completed the goal g.');
    expect(MESSAGES.goalFailed('g')).toBe('You recently failed to complete the goal g.');
    expect(MESSAGES.modelUnsupported).toBe(
      '我的模型不支持原生工具调用，换个 OpenAI 兼容模型再试。',
    );
    expect(MESSAGES.recentConvoPrefix).toBe('Recent conversation:\n');
    expect(MESSAGES.shuttingUp).toBe('Shutting up.');
    expect(MESSAGES.restarting).toBe('Restarting.');
    expect(MESSAGES.exiting).toBe('Exiting.');
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
    expect(set.conversing).toBe(PROMPT_SETS.cooking.conversing);
    // keys missing from the variant inherit defaults
    expect(set.image_analysis).toBe(PROMPT_SETS.default.image_analysis);
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
