/**
 * 事件接入层：L1–L5 → 原生原语。
 *
 * 用假依赖（可控落定），重点钉住那条唯一需要自己写的逻辑：
 * **`abort()` 会撤回排队中的输入，所以中断前要把未落定的事件缓冲一份、
 * 中断后重新提交**——否则 L3 排队中的事件会被 L4/L5 悄悄吃掉。
 */
import { describe, expect, it } from 'vitest';
import type { Submission } from '@earendil-works/pi-durable';
import { LEVEL } from '../src/agent/scheduler.js';
import { EventIntake, type GameEvent } from '../src/runtime/events.js';

interface Submitted {
  text: string;
  whenBusy: string;
}

function makeIntake() {
  const submits: Submitted[] = [];
  const writes: GameEvent[] = [];
  const aborts: number[] = [];
  const rescues: number[] = [];
  const actions: string[] = [];
  const errors: unknown[] = [];

  /** 手动放行的假 submission：不主动落定，便于观察 outstanding。 */
  const releasers: Array<() => void> = [];
  const fakeSubmission = (): Submission => {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    releasers.push(release);
    return {
      id: 'sub' as unknown as Submission['id'],
      status: () => Promise.resolve({} as never),
      wait: () => settled.then(() => ({ status: 'done' }) as never),
      abort: () => Promise.resolve('aborted' as const),
    } as Submission;
  };

  const intake = new EventIntake({
    submit: (text, whenBusy) => {
      submits.push({ text, whenBusy });
      return Promise.resolve(fakeSubmission());
    },
    abort: () => {
      aborts.push(submits.length);
      return Promise.resolve();
    },
    rescue: () => {
      rescues.push(1);
      return Promise.resolve();
    },
    onEvent: (event, action) => actions.push(`${event.text}:${action}`),
    onError: (error) => errors.push(error),
  });

  return {
    intake,
    submits,
    writes,
    aborts,
    rescues,
    actions,
    errors,
    /** 放行所有假 submission，让它们落定。 */
    releaseAll: () => {
      for (const release of releasers) release();
    },
  };
}

function event(text: string, level: number): GameEvent {
  return { text, level: level as GameEvent['level'] };
}

describe('L1/L2：只进缓冲区，不唤醒', () => {
  it('进"下一次要发的内容"，不 submit、不标记需要请求', async () => {
    const h = makeIntake();
    h.intake.notify(event('L1', LEVEL.UNUSED));
    h.intake.notify(event('L2', LEVEL.STATE));
    await h.intake.settle();

    expect(h.submits).toHaveLength(0);
    expect(h.intake.pendingCount).toBe(2);
    expect(h.actions).toEqual(['L1:write', 'L2:write']);
  });

  it('只有 L2 攒着时，请求结束也不发（搭下一次请求的车）', async () => {
    const h = makeIntake();
    h.intake.notify(event('L2', LEVEL.STATE));
    await h.intake.settle();
    // 请求结束会检查"需要请求"标志——L2 没标记，所以什么都不发
    h.intake.requestFinished();
    await h.intake.settle();
    expect(h.submits).toHaveLength(0);
    expect(h.intake.pendingCount).toBe(1);
  });

  it('L2 搭 L3 的车：一起进同一批', async () => {
    const h = makeIntake();
    h.intake.notify(event('L2', LEVEL.STATE));
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();
    expect(h.submits).toEqual([{ text: 'L2\n\nL3', whenBusy: 'steer' }]);
  });
});

describe('L3：整流——一次请求带走一整批', () => {
  it('5 条 L3 只 submit **一次**（原来是一条一次，真机上掉 8 次血 = 8 次请求）', async () => {
    const h = makeIntake();
    for (let i = 1; i <= 5; i++) h.intake.notify(event(`L3-${i}`, LEVEL.WAKE));
    await h.intake.settle();

    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]?.text).toBe('L3-1\n\nL3-2\n\nL3-3\n\nL3-4\n\nL3-5');
    expect(h.actions).toEqual(['L3-1:steer', 'L3-2:steer', 'L3-3:steer', 'L3-4:steer', 'L3-5:steer']);
  });

  it('请求在飞的时候只攒不发；请求结束才发一次', async () => {
    const h = makeIntake();
    h.intake.requestStarted();
    for (let i = 1; i <= 3; i++) h.intake.notify(event(`L3-${i}`, LEVEL.WAKE));
    await h.intake.settle();
    // 模型正在生成，这时发过去它也看不见——攒着零成本
    expect(h.submits).toHaveLength(0);
    expect(h.intake.pendingCount).toBe(3);

    h.intake.requestFinished();
    await h.intake.settle();
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]?.text).toBe('L3-1\n\nL3-2\n\nL3-3');
  });

  it('落定后从 outstanding 移除', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();
    expect(h.intake.outstandingEvents.map((e) => e.text)).toEqual(['L3']);
    h.releaseAll();
    // 等 forget 的微任务跑完
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.intake.outstandingEvents).toHaveLength(0);
  });
});

describe('L4：中断（abort + 把整批发出去）', () => {
  it('L4 把在途的 L3 退回缓冲区，和它一起作为**一次**提交发出去', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();
    expect(h.submits.map((s) => s.text)).toEqual(['L3']);

    h.intake.notify(event('L4', LEVEL.PREEMPT));
    await h.intake.settle();

    expect(h.aborts).toHaveLength(1);
    // 在途的 L3 先退回，再和 L4 一起走一次提交——顺序不乱、一条不丢
    expect(h.submits.map((s) => s.text)).toEqual(['L3', 'L3\n\nL4']);
    expect(h.submits.every((s) => s.whenBusy === 'steer')).toBe(true);
    expect(h.actions).toEqual(['L3:steer', 'L4:preempt']);
  });

  it('没有攒下东西时只提交自己', async () => {
    const h = makeIntake();
    h.intake.notify(event('L4', LEVEL.PREEMPT));
    await h.intake.settle();
    expect(h.aborts).toHaveLength(1);
    expect(h.submits.map((s) => s.text)).toEqual(['L4']);
  });
});

describe('L5：冻住 → 保命 → 接着干', () => {
  it('abort + 保命，**保命跑完**才把整批提交出去', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();

    h.intake.notify(event('L5', LEVEL.EMERGENCY));
    await h.intake.settle();

    expect(h.aborts).toHaveLength(1);
    expect(h.rescues).toHaveLength(1);
    // 保命要跑好几秒，先提交的话模型会对着过时的世界做判断——所以提交在后
    expect(h.submits.map((s) => s.text)).toEqual(['L3', 'L3\n\nL5']);
    expect(h.actions).toEqual(['L3:steer', 'L5:emergency']);
  });

  it('空闲时 L5 也能触发（abort + 保命）', async () => {
    const h = makeIntake();
    h.intake.notify(event('L5', LEVEL.EMERGENCY));
    await h.intake.settle();
    expect(h.aborts).toHaveLength(1);
    expect(h.rescues).toHaveLength(1);
    expect(h.submits.map((s) => s.text)).toEqual(['L5']);
  });
});

describe('同步返回 / 异常隔离', () => {
  it('notify 同步返回，异步动作还没跑', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    expect(h.submits).toHaveLength(0);
    await h.intake.settle();
    expect(h.submits).toHaveLength(1);
  });

  it('提交抛错：整批退回缓冲区不丢，后续事件照样处理', async () => {
    const h = makeIntake();
    let first = true;
    const intake = new EventIntake({
      submit: (text, whenBusy) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('boom'));
        }
        h.submits.push({ text, whenBusy });
        return Promise.resolve({
          id: 'sub' as never,
          status: () => Promise.resolve({} as never),
          wait: () => Promise.resolve({ status: 'done' } as never),
          abort: () => Promise.resolve('settled' as const),
        } as never);
      },
      abort: () => Promise.resolve(),
      rescue: () => Promise.resolve(),
      onError: (error) => h.errors.push(error),
    });

    intake.notify(event('bad', LEVEL.WAKE));
    await intake.settle();

    expect(h.errors).toHaveLength(1);
    // 抛错不能把事件凭空吃掉——整批退回缓冲区等下次重试
    expect(h.submits).toHaveLength(0);
    expect(intake.pendingCount).toBe(1);

    // 后续事件照样处理，并且和退回的那条合成一批发出去
    intake.notify(event('good', LEVEL.WAKE));
    await intake.settle();
    expect(h.submits.map((s) => s.text)).toEqual(['bad\n\ngood']);
  });

  it('中断本身抛错也不让泵停摆', async () => {
    const errors: unknown[] = [];
    const intake = new EventIntake({
      submit: () =>
        Promise.resolve({
          id: 'sub' as never,
          status: () => Promise.resolve({} as never),
          wait: () => Promise.resolve({ status: 'done' } as never),
          abort: () => Promise.resolve('settled' as const),
        } as never),
      abort: () => Promise.reject(new Error('abort boom')),
      rescue: () => Promise.resolve(),
      onError: (error) => errors.push(error),
    });

    intake.notify(event('L4', LEVEL.PREEMPT));
    await intake.settle();
    // 一条事件处理失败只记一笔，泵继续跑（后面还排着几十条）
    expect(errors).toHaveLength(1);
    // 它的文本没丢，还在缓冲区里等下一次顺风车
    expect(intake.pendingCount).toBe(1);
  });
});

/**
 * 运行时就绪前的事件。
 *
 * SQLite 打开要几毫秒，而 edges 的轮询和 bot.on(...) 在连接建立后**立刻**
 * 就开始产生事件了。没有这个缓冲，连接后到就绪之间的事件会真丢——而
 * "丢一个事件就是丢一份工作"。
 */
describe('运行时就绪前的事件不丢', () => {
  function makeDeferredIntake() {
    const submits: Submitted[] = [];
    const writes: GameEvent[] = [];
    const actions: string[] = [];
    const releasers: Array<() => void> = [];
    const fakeSubmission = (): Submission => {
      let release!: () => void;
      const settled = new Promise<void>((resolve) => {
        release = resolve;
      });
      releasers.push(release);
      return {
        id: 'sub' as unknown as Submission['id'],
        status: () => Promise.resolve({} as never),
        wait: () => settled.then(() => ({ status: 'done' }) as never),
        abort: () => Promise.resolve('aborted' as const),
      } as Submission;
    };
    const deps = {
      submit: (text: string, whenBusy: string) => {
        submits.push({ text, whenBusy });
        return Promise.resolve(fakeSubmission());
      },
      abort: () => Promise.resolve(),
      rescue: () => Promise.resolve(),
      onEvent: (event: GameEvent, action: string) => actions.push(`${event.text}:${action}`),
    };
    return { intake: new EventIntake(), deps, submits, writes, actions };
  }

  it('attach 之前的事件被暂存，不进链、不触发动作', () => {
    const h = makeDeferredIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    h.intake.notify(event('L2', LEVEL.STATE));

    expect(h.intake.attached).toBe(false);
    expect(h.intake.waitingCount).toBe(2);
    expect(h.submits).toHaveLength(0);
    expect(h.intake.pendingCount).toBe(0);
  });

  it('attach 后**按顺序**补投，一个都不丢', async () => {
    const h = makeDeferredIntake();
    h.intake.notify(event('先', LEVEL.WAKE));
    h.intake.notify(event('后', LEVEL.WAKE));
    h.intake.attach(h.deps);
    await h.intake.settle();

    expect(h.intake.attached).toBe(true);
    expect(h.intake.waitingCount).toBe(0);
    // 两条 L3 补投后合成**一批**发出去，顺序不变
    expect(h.submits.map((s) => s.text)).toEqual(['先\n\n后']);
    expect(h.actions).toEqual(['先:steer', '后:steer']);
  });

  it('attach 后新来的事件直接进缓冲区', async () => {
    const h = makeDeferredIntake();
    h.intake.attach(h.deps);
    h.intake.notify(event('L2', LEVEL.STATE));
    await h.intake.settle();
    expect(h.intake.waitingCount).toBe(0);
    expect(h.intake.pendingCount).toBe(1);
    expect(h.submits).toHaveLength(0);
  });

  it('重复 attach 抛错（不许悄悄换掉运行时）', () => {
    const h = makeDeferredIntake();
    h.intake.attach(h.deps);
    expect(() => h.intake.attach(h.deps)).toThrow();
  });

  it('先缓冲的 L5 补投时照样走 abort + 保命', async () => {
    const h = makeDeferredIntake();
    h.intake.notify(event('紧急', LEVEL.EMERGENCY));
    h.intake.attach(h.deps);
    await h.intake.settle();
    expect(h.actions).toEqual(['紧急:emergency']);
    // 按"所有事件都立刻进消息"的统一规则，L5 的文本也会跟着这一批过去
    expect(h.submits.map((s) => s.text)).toEqual(['紧急']);
  });
});

/**
 * L4 的"打断立刻插入"。
 *
 * 原来是一条 FIFO promise 链，等级只决定**做什么**、不决定**什么时候做**，
 * 于是这条设计意图根本没实现。真机日志：pia 被骷髅射死，死亡事件
 * 12:32:38 入队、12:32:57 才落地——**排在 30 条 L3 后面干等了 19 秒**，
 * 最后还连同被 abort 的那一轮一起丢了。模型全程不知道自己死了。
 */
describe('L4 插队：打断立刻插入', () => {
  it('L4 插到普通队列前面，不排在几十条 L3 后面', async () => {
    const h = makeIntake();
    // 模拟真机那场骷髅战：链路里已经堆了一批 L3
    for (let i = 1; i <= 5; i++) h.intake.notify(event(`L3-${i}`, LEVEL.WAKE));
    // 死亡事件是 L4
    h.intake.notify(event('L4-death', LEVEL.PREEMPT));
    await h.intake.settle();

    const order = h.actions.map((a) => a.split(':')[0] ?? '');
    expect(order.indexOf('L4-death')).toBeGreaterThanOrEqual(0);
    // 关键：它必须插到**后面那几条** L3 前面
    expect(order.indexOf('L4-death')).toBeLessThan(order.indexOf('L3-3'));
    expect(order.indexOf('L4-death')).toBeLessThan(order.indexOf('L3-5'));
  });

  it('插队不破坏各自的先后：L4 之间有序，L3 之间也有序', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3-a', LEVEL.WAKE));
    h.intake.notify(event('L3-b', LEVEL.WAKE));
    h.intake.notify(event('L4-1', LEVEL.PREEMPT));
    h.intake.notify(event('L3-c', LEVEL.WAKE));
    h.intake.notify(event('L4-2', LEVEL.PREEMPT));
    await h.intake.settle();

    const order = h.actions.map((a) => a.split(':')[0] ?? '');
    expect(order.indexOf('L4-1')).toBeLessThan(order.indexOf('L4-2'));
    expect(order.indexOf('L3-a')).toBeLessThan(order.indexOf('L3-b'));
    expect(order.indexOf('L3-b')).toBeLessThan(order.indexOf('L3-c'));
  });

  it('L5（紧急）同样走优先通道', async () => {
    const h = makeIntake();
    for (let i = 1; i <= 4; i++) h.intake.notify(event(`L3-${i}`, LEVEL.WAKE));
    h.intake.notify(event('L5-emergency', LEVEL.EMERGENCY));
    await h.intake.settle();

    const order = h.actions.map((a) => a.split(':')[0] ?? '');
    expect(order.indexOf('L5-emergency')).toBeLessThan(order.indexOf('L3-3'));
  });
});
