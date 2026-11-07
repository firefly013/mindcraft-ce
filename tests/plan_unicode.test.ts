/**
 * UpdateGoal 中文往返。
 *
 * 钉住这条链**一个字节都不改**：
 *   UpdateGoal 入参 → PlanStore → 会话文档(state_access) → 回读 → 回执
 * 覆盖中文、emoji、ZWJ 家族、组合字符、星光平面字符。
 */
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { PlanStore } from '../src/brain/plan.js';
import { createUpdateGoalTool, normalizeUpdateGoalArguments } from '../src/brain/tools/control_tools.js';
import { createStateAccess } from '../src/brain/runtime/state_access.js';

const CHINESE = '燧石/砾石：挖黑曜石，补燧石做打火石';
const EMOJI = '😀⛏️🎯🧨';
const ZWJ = '👨‍👩‍👧‍👦';
const COMBINING = 'e\u0301'; // é：e + 组合重音
const ASTRAL = '𝕏𝔸';
const MIXED = '挖燧石（flint）→ 砾石 gravel ⛏️ 10% 😀';

describe('PlanStore：中文/emoji 原样保留', () => {
  it('update → snapshot → hydrate 逐字相等', () => {
    const store = new PlanStore();
    const snapshot = store.update(`目标：${MIXED}`);
    expect(snapshot.goal).toBe(`目标：${MIXED}`);

    const restored = new PlanStore();
    restored.hydrate(snapshot.goal);
    expect(restored.snapshot()).toEqual(snapshot);
  });
});

describe('normalizeUpdateGoalArguments：不改一个字', () => {
  it('goal 原样保留，其它键透传给校验器', () => {
    const out = normalizeUpdateGoalArguments({ goal: CHINESE });
    expect(out.goal).toBe(CHINESE);
  });
});

describe('UpdateGoal 回执：原样带回模型给的内容', () => {
  it('工具回执里的中文 + emoji 与入参逐字一致', async () => {
    const applied: Array<string | null | undefined> = [];
    const tool = createUpdateGoalTool((goal) => {
      applied.push(goal);
      return { goal: goal ?? null };
    });
    const prepared = tool.prepareArguments?.({ goal: CHINESE });
    const result: any = await tool.execute(prepared as never, {} as never, {} as never);
    expect(applied).toEqual([CHINESE]);
    expect(result.content).toEqual([
      { type: 'text', text: `目标已经更新，现在的目标是 ${CHINESE}。` },
    ]);
  });

  it('空串清空目标', async () => {
    const store = new PlanStore();
    const tool = createUpdateGoalTool((goal) => store.update(goal));
    const result: any = await tool.execute({ goal: '' } as never, {} as never, {} as never);
    expect(result.content).toEqual([{ type: 'text', text: '目标已经更新，现在没有设定目标。' }]);
  });
});

/** 内存假 Harness：按 doc.kind 存对象，模拟 pi-durable 的 snapshot / commit(tx.doc)。 */
function fakeHarness() {
  const docs = new Map<string, any>();
  return {
    snapshot: (doc: any) => Promise.resolve(docs.get(doc.kind) ?? null),
    commit: async (fn: (tx: any) => Promise<void>) => {
      const tx = {
        doc: (doc: any) => {
          if (!docs.has(doc.kind)) docs.set(doc.kind, {});
          return Promise.resolve(docs.get(doc.kind));
        },
      };
      await fn(tx);
    },
  };
}

describe('state_access：会话文档往返（模拟重启）', () => {
  it('setPlan → plan 中文/emoji 逐字相等', async () => {
    const harness = fakeHarness();
    const goal = `目标：${MIXED}`;
    const writer = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    await writer.setPlan({ goal });

    // 新建一个 access 读同一份文档 = 模拟进程重启
    const reader = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    expect(await reader.plan()).toEqual({ goal });
  });

  it('goal 里的 emoji、ZWJ、组合字符、星光平面字符都原样保留', async () => {
    const harness = fakeHarness();
    for (const goal of [EMOJI, ZWJ, COMBINING, ASTRAL]) {
      const writer = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
      await writer.setPlan({ goal });
      const reader = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
      expect(await reader.plan()).toEqual({ goal });
    }
  });

  it('memory 走同一条文档链，也原样保留', async () => {
    const harness = fakeHarness();
    const writer = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    await writer.setMemory(`${MIXED}\n${ZWJ}`);
    const reader = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    expect(await reader.memory()).toBe(`${MIXED}\n${ZWJ}`);
  });
});
