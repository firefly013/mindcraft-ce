/**
 * task-19：UpdatePlan 中文往返。
 *
 * 现场证据（bots/overnight_a/logs/request-001.log 第 4637 行）：模型发来的
 * UpdatePlan 原始入参里 todo 已经是「刷爧石（42砂砹…）」，而 goal（来自更早的
 * 正确消息）仍是「补燧石」——也就是说乱码在模型生成的参数里，交互层只是**如实原样**
 * 存下来、回读、回执。这组测试钉住：
 *   UpdatePlan 入参归一 → PlanStore → 会话文档(state_access) → 回读 → 回执
 * 这条链**一个字节都不改**，覆盖中文、emoji、ZWJ 家族、组合字符、星光平面字符。
 */
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { PlanStore } from '../src/brain/plan.js';
import { createUpdatePlanTool, normalizeUpdatePlanArguments } from '../src/brain/tools/control_tools.js';
import { createStateAccess } from '../src/brain/runtime/state_access.js';

const CHINESE = '燧石/砾石：挖黑曜石，补燧石做打火石';
const EMOJI = '😀⛏️🎯🧨';
const ZWJ = '👨‍👩‍👧‍👦';
const COMBINING = 'e\u0301'; // é：e + 组合重音
const ASTRAL = '𝕏𝔸';
const MIXED = '挖燧石（flint）→ 砾石 gravel ⛏️ 10% 😀';
const ALL = [CHINESE, EMOJI, ZWJ, COMBINING, ASTRAL, MIXED];

describe('PlanStore：中文/emoji 原样保留', () => {
  it('update → snapshot → hydrate 逐字相等', () => {
    const store = new PlanStore();
    const snapshot = store.update(`目标：${MIXED}`, ALL);
    expect(snapshot.goal).toBe(`目标：${MIXED}`);
    expect(snapshot.todos.map((t) => t.text)).toEqual(ALL);
    expect(snapshot.todos.every((t) => t.done === false)).toBe(true);

    const restored = new PlanStore();
    restored.hydrate(snapshot.goal, snapshot.todos);
    expect(restored.snapshot()).toEqual(snapshot);
  });

  it('snapshot 是深拷贝，改返回的快照不影响存储', () => {
    const store = new PlanStore();
    store.update(null, [CHINESE]);
    const snap = store.snapshot();
    snap.todos[0].text = '改坏了';
    expect(store.snapshot().todos[0].text).toBe(CHINESE);
  });
});

describe('normalizeUpdatePlanArguments：不改一个字', () => {
  it('goal / 字符串 todo / 对象 todo 都原样保留', () => {
    const out = normalizeUpdatePlanArguments({
      goal: CHINESE,
      todos: [EMOJI, { text: ZWJ, done: true }, { text: ASTRAL }],
    });
    expect(out.goal).toBe(CHINESE);
    expect(out.todos).toEqual([
      { text: EMOJI, done: false },
      { text: ZWJ, done: true },
      { text: ASTRAL },
    ]);
  });
});

describe('UpdatePlan 回执：原样带回模型给的内容', () => {
  it('工具回执里的中文 + emoji 与入参逐字一致', async () => {
    const applied: Array<{ goal: unknown; todos: unknown }> = [];
    const tool = createUpdatePlanTool((goal, todos) => {
      applied.push({ goal, todos });
      return {
        goal: goal ?? null,
        todos: (todos ?? []).map((todo) =>
          typeof todo === 'string' ? { text: todo, done: false } : { text: todo.text, done: todo.done === true },
        ),
      };
    });
    const prepared = tool.prepareArguments?.({ goal: CHINESE, todos: [MIXED, ZWJ] });
    const result: any = await tool.execute(prepared as never, {} as never, {} as never);
    expect(applied).toEqual([{ goal: CHINESE, todos: [{ text: MIXED, done: false }, { text: ZWJ, done: false }] }]);
    expect(result.content).toEqual([
      { type: 'text', text: `Plan updated. Goal: ${CHINESE}. Todos: [ ] ${MIXED}; [ ] ${ZWJ}.` },
    ]);
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
    const todos = [
      { text: CHINESE, done: false },
      { text: EMOJI, done: true },
      { text: ZWJ, done: false },
      { text: COMBINING, done: false },
      { text: ASTRAL, done: true },
    ];
    const writer = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    await writer.setPlan({ goal, todos });

    // 新建一个 access 读同一份文档 = 模拟进程重启
    const reader = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    expect(await reader.plan()).toEqual({ goal, todos });
  });

  it('memory 走同一条文档链，也原样保留', async () => {
    const harness = fakeHarness();
    const writer = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    await writer.setMemory(`${MIXED}\n${ZWJ}`);
    const reader = createStateAccess(harness as never, 'conv' as never, BACKGROUND_CONTEXT);
    expect(await reader.memory()).toBe(`${MIXED}\n${ZWJ}`);
  });
});
