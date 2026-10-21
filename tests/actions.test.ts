/**
 * task-2 命令层/快照层回归：
 * B 关键方块清单（黑曜石/下界砖/末地传送门框）
 * D 大脑侧动作保险丝
 * D6 被中断的动作回执必须有结论（不是空串）
 * D7 快照 Held 行的耐久绝对读数
 */
import { describe, expect, it } from 'vitest';
import { actionsList } from '../src/body/commands/actions.js';
import { ACTION_MAX_MS, BODY_ACTION_TIMEOUT_MAX_MIN } from '../src/brain/action_runner.js';
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
  it('覆盖身体侧最长超时（exploreFor 8 分钟），不是把正常动作误杀在 6.5 分钟', () => {
    // 事故：exploreFor（8 分钟）曾在 6.5 分钟被强退。
    expect(ACTION_MAX_MS).toBeGreaterThan(8 * 60_000);
    expect(ACTION_MAX_MS).toBeLessThanOrEqual(9 * 60_000);
    // 推导关系：保险丝 = 最长身体超时 + 30 秒缓冲。
    expect(ACTION_MAX_MS).toBe((BODY_ACTION_TIMEOUT_MAX_MIN * 60 + 30) * 1000);
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
    // 契约变更（Lead 2026-10-21）：**必须指名元凶，不许列三个候选**——
    // 用 CLI 驱动 collectBlocks 被中断时，旧回执写"Stop / 保命反射 / autoPickup"，
    // 三个候选项等于零信息，模型只能盲试同一条命令。
    // body 没记录原因时要**如实说没记录**，而不是假装知道。
    expect(text).toContain('原因未记录');
    expect(text).not.toContain('Stop / 保命反射 / autoPickup');
  });

  it('中断原因有记录时：回执直接指名（不再说"原因未记录"）', async () => {
    const cmd = actionsList.find((c) => c.name === '!collectBlocks');
    const agent = {
      bot: { output: '', interrupt_code: true, __interruptReason: '保命反射/急停抢走了身体' },
      actions: {
        runAction: async (): Promise<unknown> => ({ interrupted: true, timedout: false, message: '' }),
      },
    };
    const text = (await (cmd!.perform as any)(agent, 'netherrack', 8)) as string;
    expect(text).toContain('保命反射/急停抢走了身体');
    expect(text).not.toContain('原因未记录');
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
  function botWithHeld(held: unknown, extra: Record<string, unknown> = {}): any {
    return {
      entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
      health: 20,
      food: 20,
      inventory: { slots: [] },
      heldItem: held,
      game: {},
      time: { timeOfDay: 6000 },
      blockAt: () => ({ name: 'air' }),
      ...extra,
    };
  }
  const heldLine = (bot: any): string => renderSections(sampleLiveState({ bot }), ['held']);

  it('写着 used/max 和还剩几次（不是只有百分比）', () => {
    const text = heldLine(botWithHeld({ name: 'iron_pickaxe', count: 1, durabilityUsed: 37, maxDurability: 251 }));
    expect(text).toContain('iron_pickaxex1');
    expect(text).toContain('耐久 37/251');
    expect(text).toContain('还剩 214');
  });

  it('maxDurability 缺失：明说算不出剩余，不印假上限', () => {
    const text = heldLine(botWithHeld({ name: 'stone_pickaxe', count: 1, durabilityUsed: 95 }));
    expect(text).toContain('算不出剩余');
    expect(text).toContain('used=95');
    expect(text).not.toContain('max=');
  });

  it('maxDurability=0：同样明说算不出剩余', () => {
    const text = heldLine(botWithHeld({ name: 'stone_pickaxe', count: 1, durabilityUsed: 95, maxDurability: 0 }));
    expect(text).toContain('算不出剩余');
    expect(text).not.toContain('max=');
  });

  it('maxDurability=1（真机读数）：不把 1 当总耐久印出来', () => {
    const text = heldLine(botWithHeld({ name: 'stone_pickaxe', count: 1, durabilityUsed: 95, maxDurability: 1 }));
    expect(text).toContain('算不出剩余');
    expect(text).toContain('无效值，已忽略');
    expect(text).not.toContain('max=1');
    expect(text).not.toContain('/1');
  });

  it('回退 bot 注册表拿到真上限（stone_pickaxe → 131）', () => {
    const text = heldLine(
      botWithHeld(
        { name: 'stone_pickaxe', count: 1, durabilityUsed: 95, maxDurability: 1 },
        { registry: { itemsByName: { stone_pickaxe: { maxDurability: 131 } } } },
      ),
    );
    expect(text).toContain('耐久 95/131');
    expect(text).toContain('还剩 36');
  });
});
