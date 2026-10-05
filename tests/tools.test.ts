/**
 * 工具通道归属：动作类占身体通道（忙时拒绝），查询类只读不占，
 * Stop/Finish 是控制信号，不占通道。
 */
import { describe, expect, it } from 'vitest';
import { isActionTool, stripBang, toolExists, validateToolCall } from '../src/agent/commands/to_openai_tools.js';

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
