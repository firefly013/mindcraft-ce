/**
 * P6：抢占桥。用**真实的** `Scheduler`（冻结层）+ 假的 run 句柄，
 * 逐条对照旧循环的语义。
 *
 * 最要紧的三条：
 *  1. `notify()` 必须**同步**返回（旧协议形状），异步动作排在链上；
 *  2. `preempt` 要在在途 run 还跑着时插进去，且被抢占那轮的迟到结束
 *     **不能**再开一轮（等价于旧实现作废在途响应）；
 *  3. `preempt` 之后新一轮要带上被 `unsee()` 退回的事件——不能丢。
 */
import { describe, expect, it } from 'vitest';
import { Scheduler, type BeginVerdict } from '../src/agent/scheduler.js';
import { PreemptionBridge, type RunHandle } from '../src/runtime/preemption.js';

interface FakeRun {
  events: BeginVerdict['events'];
  resolve: () => void;
  rejected: (error: unknown) => void;
}

function makeBridge() {
  const scheduler = new Scheduler();
  const runs: FakeRun[] = [];
  const aborts: number[] = [];
  let emergencies = 0;

  const bridge = new PreemptionBridge({
    scheduler,
    startRun: (events): Promise<RunHandle> => {
      let resolve!: () => void;
      let rejected!: (error: unknown) => void;
      const settled = new Promise<void>((res, rej) => {
        resolve = res;
        rejected = rej;
      });
      runs.push({ events, resolve, rejected });
      return Promise.resolve({ settled });
    },
    abortRun: () => {
      aborts.push(runs.length);
      return Promise.resolve();
    },
    onEmergency: () => {
      emergencies += 1;
      return Promise.resolve();
    },
  });

  return { scheduler, runs, aborts, bridge, emergencies: () => emergencies };
}

/** 事件的 payload 序列，便于断言"新一轮带了哪些事件"。 */
function payloads(run: FakeRun | undefined): unknown[] {
  return (run?.events ?? []).map((event) => event.payload);
}

describe('同步判定 / 异步动作', () => {
  it('notify 同步返回，动作还没跑', async () => {
    const { bridge, runs } = makeBridge();
    const verdict = bridge.notify({ kind: 'World', level: 3, payload: { a: 1 } });
    expect(verdict.decision).toBe('start');
    // 关键：返回时异步动作还没执行
    expect(runs).toHaveLength(0);
    await bridge.settle();
    expect(runs).toHaveLength(1);
  });

  it('L1/L2 只记账，不开 run', async () => {
    const { bridge, runs } = makeBridge();
    expect(bridge.notify({ kind: 'World', level: 1, payload: {} }).decision).toBe('stored');
    expect(bridge.notify({ kind: 'World', level: 2, payload: {} }).decision).toBe('stored');
    await bridge.settle();
    expect(runs).toHaveLength(0);
    expect(bridge.running).toBe(false);
  });

  it('L3 空闲 → 开一轮，并把事件交给 startRun 渲染进尾巴', async () => {
    const { bridge, runs } = makeBridge();
    bridge.notify({ kind: 'World', level: 3, payload: { why: 'woken' } });
    await bridge.settle();
    expect(runs).toHaveLength(1);
    expect(payloads(runs[0])).toEqual([{ why: 'woken' }]);
    expect(bridge.running).toBe(true);
    expect(bridge.currentEvents).toHaveLength(1);
  });
});

describe('L3 忙时搭车（queued）', () => {
  it('不立刻再开一轮；在途轮结束后由 finishRequest 续跑', async () => {
    const { bridge, runs } = makeBridge();
    bridge.notify({ kind: 'World', level: 3, payload: { first: 1 } });
    await bridge.settle();
    expect(runs).toHaveLength(1);

    const verdict = bridge.notify({ kind: 'World', level: 3, payload: { second: 2 } });
    expect(verdict.decision).toBe('queued');
    await bridge.settle();
    expect(runs).toHaveLength(1); // 没有立刻再开

    runs[0]?.resolve();
    await bridge.settle();
    expect(runs).toHaveLength(2);
    expect(payloads(runs[1])).toEqual([{ second: 2 }]);
  });
});

describe('L4 抢占（preempt）', () => {
  it('在途轮被中断，新一轮带上被 unsee 退回的事件 + 新事件', async () => {
    const { bridge, runs, aborts } = makeBridge();
    bridge.notify({ kind: 'User', level: 3, payload: { first: 1 } });
    await bridge.settle();
    expect(runs).toHaveLength(1);

    const verdict = bridge.notify({ kind: 'User', level: 4, payload: { urgent: 2 } });
    expect(verdict.decision).toBe('preempt');
    expect(verdict.cancelledRequest).toBeTruthy();

    await bridge.settle();
    expect(aborts).toHaveLength(1);
    expect(runs).toHaveLength(2);
    // 旧轮带走的事件被 unsee 退回，新一轮必须重新带上——不能丢。
    expect(payloads(runs[1])).toEqual([{ first: 1 }, { urgent: 2 }]);
  });

  it('被抢占那轮的迟到结束不会再开一轮', async () => {
    const { bridge, runs } = makeBridge();
    bridge.notify({ kind: 'User', level: 3, payload: { first: 1 } });
    await bridge.settle();
    bridge.notify({ kind: 'User', level: 4, payload: { urgent: 2 } });
    await bridge.settle();
    expect(runs).toHaveLength(2);

    // 第 1 轮姗姗来迟地结束
    runs[0]?.resolve();
    await bridge.settle();
    expect(runs).toHaveLength(2); // 不该开第 3 轮
  });

  it('L4 空闲时退化为 start', async () => {
    const { bridge, runs } = makeBridge();
    const verdict = bridge.notify({ kind: 'User', level: 4, payload: {} });
    expect(verdict.decision).toBe('start');
    await bridge.settle();
    expect(runs).toHaveLength(1);
  });
});

describe('L5 紧急（emergency）', () => {
  it('中断在途轮、交给紧急反射，且**不**开新 run', async () => {
    const { bridge, runs, aborts, emergencies } = makeBridge();
    bridge.notify({ kind: 'World', level: 3, payload: { hp: 20 } });
    await bridge.settle();
    expect(runs).toHaveLength(1);

    const verdict = bridge.notify({ kind: 'World', level: 5, payload: { lava: true } });
    expect(verdict.decision).toBe('emergency');
    await bridge.settle();

    expect(aborts).toHaveLength(1);
    expect(emergencies()).toBe(1);
    expect(runs).toHaveLength(1); // 紧急反射绕过模型
  });

  it('紧急锁定期间的新事件只记账，不开 run', async () => {
    const { bridge, runs } = makeBridge();
    bridge.notify({ kind: 'World', level: 5, payload: {} });
    await bridge.settle();
    expect(bridge.notify({ kind: 'World', level: 3, payload: {} }).decision).toBe('stored');
    await bridge.settle();
    expect(runs).toHaveLength(0);
  });

  it('空闲时 L5 也能触发（cancelledRequest 为 null）', async () => {
    const { bridge, aborts, emergencies } = makeBridge();
    const verdict = bridge.notify({ kind: 'World', level: 5, payload: {} });
    expect(verdict.decision).toBe('emergency');
    expect(verdict.cancelledRequest ?? null).toBeNull();
    await bridge.settle();
    expect(aborts).toHaveLength(1);
    expect(emergencies()).toBe(1);
  });
});

describe('异常路径', () => {
  it('一轮失败也要让出当前轮，避免桥永久卡住', async () => {
    const { bridge, runs, scheduler } = makeBridge();
    bridge.notify({ kind: 'World', level: 3, payload: {} });
    await bridge.settle();
    runs[0]?.rejected(new Error('boom'));
    await bridge.settle();
    expect(bridge.running).toBe(false);
    expect(scheduler.describe().apiBusy).toBe(false);
  });
});
