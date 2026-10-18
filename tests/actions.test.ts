/**
 * task-2 命令层/快照层回归：
 * B 关键方块清单（黑曜石/下界砖/末地传送门框）
 * D 大脑侧动作保险丝
 * D6 被中断的动作回执必须有结论（不是空串）
 * D7 快照 Held 行的耐久绝对读数
 */
import { describe, expect, it } from 'vitest';
import { actionsList } from '../src/body/commands/actions.js';
import { ACTION_MAX_MS } from '../src/brain/action_runner.js';
import { KEY_BLOCKS } from '../src/shared/live_state.js';
import { renderSections } from '../src/shared/live_state.js';
import { sampleLiveState } from '../src/body/live_state.js';

describe('B 关键方块清单覆盖通关路线', () => {
  it('obsidian / nether_bricks / end_portal_frame 都在 KEY_BLOCKS 里', () => {
    // 真机：1.9 米外的下界门不在快照里，模型据此判断"门不在这儿"（Feedback #28）。
    for (const name of ['obsidian', 'nether_bricks', 'end_portal_frame']) {
      expect(KEY_BLOCKS).toContain(name);
    }
  });
});

describe('D 大脑侧动作保险丝', () => {
  it('比身体侧最长超时（collectBlocks 6 分钟）长，又比旧的 10 分钟短', () => {
    expect(ACTION_MAX_MS).toBeGreaterThan(6 * 60_000);
    expect(ACTION_MAX_MS).toBeLessThanOrEqual(7 * 60_000);
  });
});

describe('D6 被中断的动作回执必须有结论', () => {
  it('runAsAction 被中断：写明"被中断/没有结论"，不再返回空串', async () => {
    const cmd = actionsList.find((c) => c.name === '!collectBlocks');
    expect(cmd).toBeDefined();
    let label = '';
    const agent = {
      bot: { output: '', interrupt_code: true },
      actions: {
        runAction: async (l: string): Promise<unknown> => {
          label = l;
          return { interrupted: true, timedout: false, message: '' };
        },
      },
    };
    const text = (await (cmd!.perform as any)(agent, 'netherrack', 8)) as string;
    expect(label).toBe('action:collectBlocks');
    expect(text).toContain('被中断');
    expect(text).toContain('没有结论');
    expect(text).toContain('Stop');
  });

  it('没被中断时不加戏：原样带回身体消息', async () => {
    const cmd = actionsList.find((c) => c.name === '!collectBlocks');
    const agent = {
      bot: { output: '', interrupt_code: false },
      actions: {
        runAction: async (): Promise<unknown> => ({ interrupted: false, timedout: false, message: '采集完成：dirt 背包 1 → 3（+2），移动 2 格。' }),
      },
    };
    const text = (await (cmd!.perform as any)(agent, 'dirt', 2)) as string;
    expect(text).toContain('采集完成');
    expect(text).not.toContain('被中断');
  });
});

describe('D7 快照 Held 行给出耐久绝对读数', () => {
  function botWithHeld(held: unknown): any {
    return {
      entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
      health: 20,
      food: 20,
      inventory: { slots: [] },
      heldItem: held,
      game: {},
      time: { timeOfDay: 6000 },
      blockAt: () => ({ name: 'air' }),
    };
  }

  it('写着 used/max 和还剩几次（不是只有百分比）', () => {
    const text = renderSections(
      sampleLiveState({ bot: botWithHeld({ name: 'iron_pickaxe', count: 1, durabilityUsed: 37, maxDurability: 251 }) }),
      ['held'],
    );
    expect(text).toContain('iron_pickaxex1');
    expect(text).toContain('耐久 37/251');
    expect(text).toContain('还剩 214');
  });

  it('上限读不到时不编数字，只如实报读数', () => {
    const text = renderSections(
      sampleLiveState({ bot: botWithHeld({ name: 'stone_pickaxe', count: 1, durabilityUsed: 35, maxDurability: 1 }) }),
      ['held'],
    );
    expect(text).toContain('上限读不到');
    expect(text).not.toContain('还剩');
  });
});
