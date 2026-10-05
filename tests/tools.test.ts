/**
 * 工具通道归属：动作类占身体通道（忙时拒绝），查询类只读不占，
 * Stop/Finish 是控制信号，不占通道。
 */
import { describe, expect, it } from 'vitest';
import { isActionTool, stripBang, toolExists } from '../src/agent/commands/to_openai_tools.js';

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
