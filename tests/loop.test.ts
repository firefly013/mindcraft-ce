/**
 * 循环契约：用剧本模型 + 真 Scheduler，不起服。
 *
 * 锁三件事：Finish 后面的 call 不跑；被抢占的响应整体作废；
 * emergency 跑完硬逻辑才解调度锁。
 */
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/agent/loop.js';
import type { LoopModelResponse, LoopRunner, LoopToolResult } from '../src/agent/loop.js';
import { Scheduler } from '../src/agent/scheduler.js';

function stubRunner(): LoopRunner & { ran: string[] } {
  const handlers = new Map<string, (args: unknown) => Promise<LoopToolResult>>();
  const runner: LoopRunner & { ran: string[] } = {
    ran: [],
    register(name, handler) {
      handlers.set(name, handler);
    },
    call(name: string, args: unknown): Promise<LoopToolResult> {
      const handler = handlers.get(name);
      if (!handler) return Promise.resolve({ status: 'rejected', code: 'NO_HANDLER' });
      runner.ran.push(name);
      return handler(args);
    },
  };
  return runner;
}

function stubHistory(): { appends: Array<{ kind: string; level: number }>; append: (kind: string, level: number, payload: unknown) => void } {
  const appends: Array<{ kind: string; level: number }> = [];
  return {
    appends,
    append(kind: string, level: number, _payload: unknown) {
      void _payload;
      appends.push({ kind, level });
    },
  };
}

function scriptedModel(responses: LoopModelResponse[]): {
  fn: (text: string, tools: unknown, image?: string | null) => Promise<LoopModelResponse>;
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: (_text: string, _tools: unknown, _image?: string | null) => {
      void _text;
      void _tools;
      void _image;
      const res = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return Promise.resolve(res ?? { text: null, calls: [] });
    },
  };
}

function makeLoop(modelResponses: LoopModelResponse[] = [{ text: null, calls: [{ name: 'Finish', args: {} }] }]): {
  loop: AgentLoop;
  scheduler: Scheduler;
  runner: LoopRunner & { ran: string[] };
  model: { calls: number };
} {
  const scheduler = new Scheduler();
  const runner = stubRunner();
  const history = stubHistory();
  const model = scriptedModel(modelResponses);
  const loop = new AgentLoop({
    scheduler,
    runner,
    history,
    assemble: () => ({ text: 'ctx', tools: [] }),
    model: model.fn,
  });
  return { loop, scheduler, runner, model };
}

describe('handleDecision', () => {
  it('start opens a round; stored/queued do nothing', async () => {
    const { loop, model } = makeLoop();
    await loop.handleDecision('stored');
    await loop.handleDecision('queued');
    expect(model.calls).toBe(0);
    await loop.handleDecision('start');
    expect(model.calls).toBe(1);
  });

  it('emergency runs the hard logic before unlocking the scheduler', async () => {
    const { loop, scheduler } = makeLoop();
    const order: string[] = [];
    const loopWithHooks = new AgentLoop({
      scheduler,
      runner: stubRunner(),
      history: stubHistory(),
      assemble: () => ({ text: 'ctx', tools: [] }),
      model: scriptedModel([{ text: null, calls: [{ name: 'Finish', args: {} }] }]).fn,
      emergencyHandler: () => {
        order.push('emergency');
        return Promise.resolve();
      },
    });
    scheduler.pushEvent({ kind: 'World', level: 5, payload: {} });
    await loopWithHooks.handleDecision('emergency');
    expect(order).toEqual(['emergency']);
    expect(scheduler.describe().emergency).toBe(false);
    void loop;
  });
});

/**
 * 头号声明的端到端钉子：调度器挑出的"未见事件"必须一路走到模型。
 *
 * 之前本文件的 `assemble` 是 `() => ({ text: 'ctx', tools: [] })`——**忽略入参**，
 * 所以把 `loop.ts` 里的 `assemble(begun.events)` 改成 `assemble([])` 也会全绿，
 * 整个事件流特性（"模型被叫醒却不知道为什么"的修复）会静默死亡。这里焊死。
 */
describe('event delivery', () => {
  function recordingLoop(): {
    loop: AgentLoop;
    scheduler: Scheduler;
    assembled: unknown[][];
    texts: string[];
  } {
    const scheduler = new Scheduler();
    const assembled: unknown[][] = [];
    const texts: string[] = [];
    const loop = new AgentLoop({
      scheduler,
      runner: stubRunner(),
      history: stubHistory(),
      assemble: (events: unknown[]) => {
        assembled.push(events);
        return { text: `CTX(${events.length})`, tools: [] };
      },
      model: (text: string) => {
        texts.push(text);
        return Promise.resolve({ text: null, calls: [{ name: 'Finish', args: {} }] });
      },
    });
    return { loop, scheduler, assembled, texts };
  }

  it('forwards the scheduler events to assemble, and the assembled text to the model', async () => {
    const { loop, scheduler, assembled, texts } = recordingLoop();
    const verdict = scheduler.pushEvent({ kind: 'World', level: 3, payload: { why: 'creeper' } });
    expect(verdict.decision).toBe('start');
    await loop.handleDecision(verdict.decision);

    expect(assembled).toHaveLength(1);
    expect(assembled[0]).toHaveLength(1);
    expect((assembled[0]?.[0] as { payload?: { why?: string } }).payload?.why).toBe('creeper');
    // 组装结果就是要发出去的尾巴，必须原样交给模型。
    expect(texts).toEqual(['CTX(1)']);
  });

  it('hands each event to exactly one round', async () => {
    const { loop, scheduler, assembled } = recordingLoop();
    scheduler.pushEvent({ kind: 'World', level: 3, payload: { n: 1 } });
    await loop.handleDecision('start');
    scheduler.pushEvent({ kind: 'World', level: 3, payload: { n: 2 } });
    await loop.handleDecision('start');

    expect(assembled).toHaveLength(2);
    expect(assembled[0]).toHaveLength(1);
    expect(assembled[1]).toHaveLength(1);
    expect((assembled[1]?.[0] as { payload?: { n?: number } }).payload?.n).toBe(2);
  });
});

describe('runRound', () => {
  it('runs calls in order until Finish, then idles', async () => {
    const { loop, runner } = makeLoop([
      { text: 'hi', calls: [{ name: 'Say', args: { text: 'yo' } }, { name: 'Finish', args: {} }] },
    ]);
    runner.register('Say', () => Promise.resolve({ status: 'completed', data: {} }));
    await loop.handleDecision('start');
    expect(runner.ran).toEqual(['Say', 'Finish']);
  });

  it('calls behind Finish are refused on the spot, never run', async () => {
    const { loop, runner } = makeLoop([
      {
        text: null,
        calls: [{ name: 'Finish', args: {} }, { name: 'Attack', args: {} }],
      },
    ]);
    runner.register('Attack', () => Promise.resolve({ status: 'completed', data: {} }));
    await loop.handleDecision('start');
    expect(runner.ran).toEqual(['Finish']);
  });

  it('a response arriving after preemption is voided whole', async () => {
    const scheduler = new Scheduler();
    const runner = stubRunner();
    runner.register('Attack', () => Promise.resolve({ status: 'completed', data: {} }));
    let loopRef: AgentLoop | null = null;
    const loop = new AgentLoop({
      scheduler,
      runner,
      history: stubHistory(),
      assemble: () => ({ text: 'ctx', tools: [] }),
      model: () => {
        // 模型思考期间来了个抢占事件：重启已经带走了事件。
        loopRef?.notify({ kind: 'World', level: 4, payload: {} });
        return Promise.resolve({ text: null, calls: [{ name: 'Attack', args: {} }] });
      },
    });
    loopRef = loop;
    await loop.handleDecision('start');
    // 作废的响应一个 call 都不跑；重启的那一轮由新的 decision 驱动，这里只断言没 double-act。
    expect(runner.ran).toEqual([]);
  });

  it('Stop frees the action and invalidates the generation', async () => {
    const { loop, runner, scheduler } = makeLoop([
      { text: null, calls: [{ name: 'Stop', args: {} }, { name: 'Finish', args: {} }] },
    ]);
    scheduler.startAction('long-run');
    await loop.handleDecision('start');
    expect(runner.ran).toEqual(['Stop', 'Finish']);
    expect(scheduler.describe().actionId).toBeNull();
  });

  it('notifyAction re-enters as a level-3 Tool event', () => {
    const { loop, scheduler, model } = makeLoop();
    scheduler.beginRequest();
    const verdict = loop.notifyAction({ call: 'x', result: { status: 'completed' } });
    expect(verdict.decision).toBe('queued');
    expect(model.calls).toBe(0);
  });
});
