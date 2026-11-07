/**
 * `useBlock` 拆成单动词工具后的契约。
 *
 * 这里只钉住拆分本身：工具名存在、旧名字消失、参数顺序、容器类型判定、
 * 不给 type 时按 coords 推断方块。具体动作（真的开箱、真的烧炼）由各自的
 * 专用测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import { findCommand, toolNames } from '../src/body/commands/registry.js';
import { isContainerBlockType, planUseBlock, resolveBlockType } from '../src/body/commands/interact.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';

const SPLIT_TOOLS = [
  'smelt',
  'combineAtAnvil',
  'putInContainer',
  'takeFromContainer',
  'inspectContainer',
  'lootContainer',
  'takeFurnaceOutput',
  'sleep',
  'interactBlock',
];

describe('useBlock 拆分后的工具清单', () => {
  it('九个单动词工具都注册了，旧 useBlock 消失', () => {
    const names = new Set(toolNames());
    for (const name of SPLIT_TOOLS) expect(names.has(name), name).toBe(true);
    expect(names.has('useBlock')).toBe(false);
  });

  it('每个新工具都有非空描述和参数说明', () => {
    for (const name of SPLIT_TOOLS) {
      const text = TOOL_TEXT[name];
      expect(text, name).toBeDefined();
      expect(text.description.length, name).toBeGreaterThan(10);
    }
  });

  it('参数顺序固定，命令按参数名取值不会错位', () => {
    expect(Object.keys(findCommand('!smelt')?.params ?? {})).toEqual(['input', 'output', 'type', 'coords']);
    expect(Object.keys(findCommand('!combineAtAnvil')?.params ?? {})).toEqual([
      'slot1',
      'slot2',
      'output',
      'type',
      'coords',
    ]);
    expect(Object.keys(findCommand('!putInContainer')?.params ?? {})).toEqual(['items', 'type', 'coords']);
    expect(Object.keys(findCommand('!takeFromContainer')?.params ?? {})).toEqual(['items', 'type', 'coords']);
    expect(Object.keys(findCommand('!inspectContainer')?.params ?? {})).toEqual(['type', 'coords']);
    expect(Object.keys(findCommand('!lootContainer')?.params ?? {})).toEqual(['type', 'coords']);
    expect(Object.keys(findCommand('!takeFurnaceOutput')?.params ?? {})).toEqual(['type', 'coords']);
    expect(Object.keys(findCommand('!sleep')?.params ?? {})).toEqual(['coords']);
    expect(Object.keys(findCommand('!interactBlock')?.params ?? {})).toEqual(['coords', 'type']);
  });
});

describe('容器类型判定', () => {
  it('彩色潜影盒也算容器，可以按物品存取', () => {
    expect(isContainerBlockType('chest')).toBe(true);
    expect(isContainerBlockType('barrel')).toBe(true);
    expect(isContainerBlockType('shulker_box')).toBe(true);
    expect(isContainerBlockType('red_shulker_box')).toBe(true);
    expect(isContainerBlockType('furnace')).toBe(false);
  });

  it('彩色潜影盒的存入/取出不再被规划层拒绝', () => {
    expect(planUseBlock('red_shulker_box', true, false).kind).toBe('deposit');
    expect(planUseBlock('red_shulker_box', false, true).kind).toBe('withdraw');
  });
});

describe('不给 type 时按 coords 推断方块', () => {
  const agentAt = (name: string) => ({
    bot: {
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: (p: { x: number; y: number; z: number }) =>
        p.x === 0 && p.y === 64 && p.z === 0 ? { name } : null,
    },
  });

  it('coords 那一格是 furnace 就认 furnace', () => {
    expect(resolveBlockType(agentAt('furnace'), undefined, '0,64,0', ['furnace', 'smoker'], '熔炉')).toEqual({
      type: 'furnace',
      coords: '0,64,0',
    });
  });

  it('coords 那一格不是允许类型就明确报', () => {
    const result = resolveBlockType(agentAt('stone'), undefined, '0,64,0', ['furnace'], '熔炉');
    expect(typeof result).toBe('string');
    expect(String(result)).toContain('stone');
  });

  it('给了不允许的 type 也明确报，不静默改成别的', () => {
    const result = resolveBlockType(agentAt('furnace'), 'chest', '0,64,0', ['furnace'], '熔炉');
    expect(typeof result).toBe('string');
    expect(String(result)).toContain('chest');
  });
});
