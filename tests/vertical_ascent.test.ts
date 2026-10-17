/**
 * task-16：垂直上行工具（stairUp / pillarUp）的判据、材料选择与回执。
 */
import { describe, expect, it } from 'vitest';
import {
  choosePillarMaterial,
  pillarUp,
  planPillarStep,
  planStairStep,
  stairUp,
} from '../src/body/library/skills.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';

type Block = { name: string } | null;
const accessor = (blocks: Record<string, string>): ((x: number, y: number, z: number) => Block) => {
  return (x, y, z) => (blocks[x + ',' + y + ',' + z] ? { name: blocks[x + ',' + y + ',' + z] } : null);
};

describe('choosePillarMaterial', () => {
  it('优先选圆石等常见垫脚方块，不选火把/水桶/食物', () => {
    expect(choosePillarMaterial([{ name: 'torch', count: 3 }, { name: 'cobblestone', count: 2 }])).toBe('cobblestone');
    expect(choosePillarMaterial([{ name: 'water_bucket', count: 1 }, { name: 'bread', count: 5 }])).toBeNull();
  });

  it('空背包返回 null', () => {
    expect(choosePillarMaterial([])).toBeNull();
    expect(choosePillarMaterial(null)).toBeNull();
  });
});

describe('planPillarStep', () => {
  it('头顶是实心：先挖头顶', () => {
    const plan = planPillarStep(accessor({ '0,1,0': 'stone', '0,2,0': 'air' }), { x: 0, y: 0, z: 0 });
    expect(plan).toEqual({ kind: 'mine', target: { x: 0, y: 1, z: 0 } });
  });

  it('头顶两格都空：可以跳起垫脚', () => {
    const plan = planPillarStep(accessor({ '0,1,0': 'air', '0,2,0': 'air' }), { x: 0, y: 0, z: 0 });
    expect(plan.kind).toBe('jump_place');
  });

  it('头顶是水/岩浆：不挖，直接 blocked', () => {
    expect(planPillarStep(accessor({ '0,1,0': 'water' }), { x: 0, y: 0, z: 0 }).kind).toBe('blocked');
    expect(planPillarStep(accessor({ '0,1,0': 'air', '0,2,0': 'lava' }), { x: 0, y: 0, z: 0 }).kind).toBe('blocked');
  });
});

describe('planStairStep', () => {
  it('正前方头顶是实心：先挖前方台阶', () => {
    const plan = planStairStep(
      accessor({ '0,1,0': 'air', '1,1,0': 'stone', '1,0,0': 'stone' }),
      { x: 0, y: 0, z: 0 },
      1,
      0,
    );
    expect(plan).toEqual({ kind: 'mine', target: { x: 1, y: 1, z: 0 } });
  });

  it('正前方是高一层的实心格：跳上去', () => {
    const plan = planStairStep(
      accessor({ '0,1,0': 'air', '1,0,0': 'stone', '1,1,0': 'air' }),
      { x: 0, y: 0, z: 0 },
      1,
      0,
    );
    expect(plan.kind).toBe('step_forward');
  });

  it('正前方脚下是空的：放一块垫脚', () => {
    const plan = planStairStep(
      accessor({ '0,1,0': 'air', '1,0,0': 'air', '1,1,0': 'air' }),
      { x: 0, y: 0, z: 0 },
      1,
      0,
    );
    expect(plan.kind).toBe('place_step');
  });

  it('前方是水/岩浆：不上去', () => {
    expect(
      planStairStep(accessor({ '0,1,0': 'air', '1,0,0': 'lava', '1,1,0': 'air' }), { x: 0, y: 0, z: 0 }, 1, 0).kind,
    ).toBe('blocked');
  });
});

describe('垂直上行工具回执', () => {
  it('没有垫脚方块：pillarUp 明确报失败原因', async () => {
    const bot = { output: '', interrupt_code: false, inventory: { items: () => [] }, entity: { position: { x: 0, y: 0, z: 0 } } };
    await expect(pillarUp(bot, 2)).resolves.toBe(false);
    expect(bot.output).toContain('没有可垫脚的方块');
  });

  it('interrupt_code 已置位：stairUp 立刻退出并回报中断', async () => {
    const bot = { output: '', interrupt_code: true, inventory: { items: () => [{ name: 'cobblestone', count: 3 }] }, entity: { position: { x: 0, y: 0, z: 0 }, yaw: 0 } };
    await expect(stairUp(bot, 2)).resolves.toBe(false);
    expect(bot.output).toContain('中断');
  });
});

describe('工具注册与提示词', () => {
  it('stairUp / pillarUp 声明为 action 工具', () => {
    const declarations = toolDeclarations();
    for (const name of ['stairUp', 'pillarUp']) {
      const declaration = declarations.find((d) => d.name === name);
      expect(declaration?.kind).toBe('action');
    }
  });

  it('stairUp / pillarUp 有工具描述和参数说明', () => {
    expect(TOOL_TEXT['stairUp']?.description).toBeTruthy();
    expect(TOOL_TEXT['stairUp']?.params['distance']).toBeTruthy();
    expect(TOOL_TEXT['pillarUp']?.description).toBeTruthy();
    expect(TOOL_TEXT['pillarUp']?.params['distance']).toBeTruthy();
  });
});
