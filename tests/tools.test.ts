/**
 * 工具通道归属：动作类占身体通道（忙时拒绝），查询类只读不占，
 * Stop/Finish 是控制信号，不占通道。
 */
import { describe, expect, it } from 'vitest';
import { isActionTool, stripBang, toolExists, validateToolCall, validateUpdatePlan, formatSay, getOpenAITools, getToolDocs } from '../src/agent/commands/to_openai_tools.js';

describe('isActionTool', () => {
  it('action tools claim the body channel', () => {
    expect(isActionTool('goToPlayer')).toBe(true);
    expect(isActionTool('collectBlocks')).toBe(true);
    expect(isActionTool('attack')).toBe(true);
  });

  it('query tools do not claim the channel', () => {
    expect(isActionTool('stats')).toBe(false);
    expect(isActionTool('inventory')).toBe(false);
    expect(isActionTool('entities')).toBe(false);
  });

  it('control tools do not claim the channel', () => {
    expect(isActionTool('Finish')).toBe(false);
    expect(isActionTool('Stop')).toBe(false);
  });

  it('bang prefix is accepted either way', () => {
    expect(isActionTool('!goToPlayer')).toBe(true);
    expect(stripBang('!goToPlayer')).toBe('goToPlayer');
    expect(toolExists('goToPlayer')).toBe(true);
    expect(toolExists('NoSuchTool')).toBe(false);
  });
});

describe('validateToolCall', () => {
  it('accepts a full valid call and control tools', () => {
    expect(validateToolCall('goToPlayer', { player_name: 'steve', closeness: 3 })).toEqual({ ok: true });
    expect(validateToolCall('Finish', {})).toEqual({ ok: true });
    expect(validateToolCall('stats', {})).toEqual({ ok: true });
  });

  it('rejects unknown tools without touching anything else', () => {
    const r = validateToolCall('Fly', {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_TOOL');
  });

  it('rejects non-object args', () => {
    expect(validateToolCall('stats', null).code).toBe('BAD_ARGS');
    expect(validateToolCall('stats', 'x').code).toBe('BAD_ARGS');
  });

  it('names missing, mistyped and unknown properties with paths', () => {
    const missing = validateToolCall('goToPlayer', { player_name: 'steve' });
    expect(missing.ok).toBe(false);
    expect(missing.errors?.join(';')).toContain('closeness');

    const mistyped = validateToolCall('goToPlayer', { player_name: 'steve', closeness: 'near' });
    expect(mistyped.ok).toBe(false);
    expect(mistyped.errors?.join(';')).toContain('$.closeness');

    const extra = validateToolCall('stats', { foo: 1 });
    expect(extra.ok).toBe(false);
    expect(extra.errors?.join(';')).toContain('foo');

    const notInt = validateToolCall('stay', { type: 1.5 });
    expect(notInt.ok).toBe(false);
  });

  it('null counts as not given: optional/default may omit, required may not', () => {
    // quantity 有 default，可缺。
    expect(validateToolCall('getCraftingPlan', { targetItem: 'stick' }).ok).toBe(true);
    expect(validateToolCall('getCraftingPlan', { targetItem: 'stick', quantity: null }).ok).toBe(true);
    expect(validateToolCall('getCraftingPlan', { quantity: 2 }).ok).toBe(false);
  });
});

describe('Say isolation', () => {
  it('formatSay rejects empty talk and truncates long lines but keeps full text', () => {
    expect(formatSay('').ok).toBe(false);
    expect(formatSay('   ').ok).toBe(false);
    expect(formatSay(123).ok).toBe(false);
    const short = formatSay('来了');
    expect(short).toEqual({ ok: true, line: '来了', full: '来了' });
    const long = formatSay('x'.repeat(300));
    expect(long.ok).toBe(true);
    expect(Array.from(long.line ?? '').length).toBe(241);
    expect(long.full?.length).toBe(300);
  });

  it('Say is a control tool: known, valid, channel-free', () => {
    expect(toolExists('Say')).toBe(true);
    expect(isActionTool('Say')).toBe(false);
    expect(validateToolCall('Say', { text: 'hi' }).ok).toBe(true);
    const tools = getOpenAITools({ blocked_actions: [] });
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('Say');
    expect(names).toContain('Finish');
    expect(names).toContain('Stop');
    expect(names).toContain('UpdatePlan');
  });

  it('UpdatePlan is a control tool with whole-replace shape', () => {
    expect(toolExists('UpdatePlan')).toBe(true);
    expect(isActionTool('UpdatePlan')).toBe(false);
    expect(validateToolCall('UpdatePlan', { goal: 'build', todos: ['wood'] }).ok).toBe(true);
    expect(validateToolCall('UpdatePlan', {}).ok).toBe(true);
    expect(validateUpdatePlan({ goal: 42 }).ok).toBe(false);
    expect(validateUpdatePlan({ todos: 'wood' }).ok).toBe(false);
    expect(validateUpdatePlan({ todos: ['wood', 7] }).ok).toBe(false);
    expect(validateUpdatePlan({ nope: 1 }).ok).toBe(false);
    const tools = getOpenAITools({ blocked_actions: [] });
    expect(tools.map((t) => t.function.name)).toContain('UpdatePlan');
    const docs = getToolDocs({ blocked_actions: [] });
    for (const name of ['Finish', 'Stop', 'Say', 'UpdatePlan']) {
      expect(docs).toContain(`${name}:`);
    }
  });
});
