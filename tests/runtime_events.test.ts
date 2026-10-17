/**
 * 事件接入层：**事件 → 处理，一一对应**。
 *
 * 这个文件钉住三件事：
 *
 * 1. **等级只管"用多大力气把模型叫来看一眼"**，不决定谁来处理；
 * 2. **每个事件恰好进上下文一次**——L2 走 `write`（记录，不唤醒），L3+ 走
 *    `submit`（记录并唤醒），两者互斥；
 * 3. **处理也要进上下文**：反射报告完成的 `completes` 事件同样被记录下来，
 *    并且负责解开 L5 的动作通道锁。
 *
 * `abort()` 会撤回排队中的输入，所以中断前要把未落定的一批缓冲一份、
 * 中断后重新提交——否则 L3 排队中的事件会被 L4/L5 悄悄吃掉。
 */
import { describe, expect, it } from 'vitest';
import type { Submission } from '@earendil-works/pi-durable';
import { LEVEL } from '../src/shared/events.js';
import type { Kind, Level } from '../src/shared/events.js';
import { EventIntake, type GameEvent } from '../src/brain/runtime/events.js';
import type { EventHandler } from '../src/brain/runtime/handlers.js';

interface Submitted {
  text: string;
  whenBusy: string;
}

function event(type: string, level: number, text = type, extra: Partial<GameEvent> = {}): GameEvent {
  return {
    type,
    kind: 'World' as Kind,
    level: level as Level,
    payload: { type },
    text,
    ts: 0,
    reflex: null,
    completes: null,
    ...extra,
  };
}

function makeIntake(handlers: readonly EventHandler[] = []) {
  const submits: Submitted[] = [];
  const writes: GameEvent[][] = [];
  const aborts: number[] = [];
  const actions: string[] = [];
  const errors: unknown[] = [];
  const locks: string[] = [];

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

  const byType = new Map<string, EventHandler>();
  for (const handler of handlers) for (const type of handler.types) byType.set(type, handler);

  const intake = new EventIntake({
    submit: (text, whenBusy) => {
      submits.push({ text, whenBusy });
      return Promise.resolve(fakeSubmission());
    },
    write: (_events, text) => {
      writes.push([..._events]);
      void text;
      return Promise.resolve();
    },
    abort: () => {
      aborts.push(submits.length);
      return Promise.resolve();
    },
    lookup: (type) => byType.get(type),
    beginEmergency: () => locks.push('begin'),
    endEmergency: () => locks.push('end'),
    onEvent: (e, action) => actions.push(`${e.text}:${action}`),
    onError: (error) => errors.push(error),
  });

  return {
    intake,
    submits,
    writes,
    aborts,
    actions,
    errors,
    locks,
    /** 放行所有假 submission，让它们落定。 */
    releaseAll: () => {
      for (const release of releasers) release();
    },
  };
}

describe('等级 1 是保留空位：出现即非法', () => {
  it('收到就报错，不写、不发、不当作 2', async () => {
    const h = makeIntake();
    h.intake.notify(event('不该存在的事件', LEVEL.UNUSED));
    await h.intake.settle();

    expect(h.errors).toHaveLength(1);
    expect(String(h.errors[0])).toContain('保留空位');
    expect(h.submits).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    expect(h.intake.pendingCount).toBe(0);
  });
});

describe('L2：记录，不唤醒（write）', () => {
  it('立刻写进上下文，不 submit', async () => {
    const h = makeIntake();
    h.intake.notify(event('bot.hurt', LEVEL.STATE, '挨了一下'));
    await h.intake.settle();

    expect(h.submits).toHaveLength(0);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.map((e) => e.text)).toEqual(['挨了一下']);
    expect(h.actions).toEqual(['挨了一下:written']);
  });

  it('同一拍里的多条合成一条 entry（不必一行一条）', async () => {
    const h = makeIntake();
    h.intake.notify(event('a', LEVEL.STATE, 'A'));
    h.intake.notify(event('b', LEVEL.STATE, 'B'));
    await h.intake.settle();

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]?.map((e) => e.text)).toEqual(['A', 'B']);
  });

  it('请求在飞也不影响记录：记录没有"等下一次"这回事', async () => {
    const h = makeIntake();
    h.intake.requestStarted();
    h.intake.notify(event('a', LEVEL.STATE, 'A'));
    await h.intake.settle();
    expect(h.writes).toHaveLength(1);
    expect(h.submits).toHaveLength(0);
  });
});

describe('L3：整流——一次请求带走一整批', () => {
  it('5 条 L3 只 submit 一次', async () => {
    const h = makeIntake();
    for (let i = 1; i <= 5; i++) h.intake.notify(event(`e${i}`, LEVEL.WAKE, `L3-${i}`));
    await h.intake.settle();

    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]?.text).toBe('L3-1\n\nL3-2\n\nL3-3\n\nL3-4\n\nL3-5');
    expect(h.actions).toEqual(['L3-1:steer', 'L3-2:steer', 'L3-3:steer', 'L3-4:steer', 'L3-5:steer']);
  });

  it('请求在飞的时候只攒不发；请求结束才发一次', async () => {
    const h = makeIntake();
    h.intake.requestStarted();
    for (let i = 1; i <= 3; i++) h.intake.notify(event(`e${i}`, LEVEL.WAKE, `L3-${i}`));
    await h.intake.settle();
    expect(h.submits).toHaveLength(0);

    h.intake.requestFinished();
    await h.intake.settle();
    expect(h.submits.map((s) => s.text)).toEqual(['L3-1\n\nL3-2\n\nL3-3']);
  });

  it('落定后从 outstanding 移除', async () => {
    const h = makeIntake();
    h.intake.notify(event('e', LEVEL.WAKE, 'L3'));
    await h.intake.settle();
    expect(h.intake.outstandingEvents.map((e) => e.text)).toEqual(['L3']);
    h.releaseAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.intake.outstandingEvents).toHaveLength(0);
  });
});

describe('L4：中断（abort + 把整批发出去）', () => {
  it('把在途的 L3 退回缓冲区，和它一起作为一次提交发出去', async () => {
    const h = makeIntake();
    h.intake.notify(event('a', LEVEL.WAKE, 'L3'));
    await h.intake.settle();
    expect(h.submits.map((s) => s.text)).toEqual(['L3']);

    h.intake.notify(event('b', LEVEL.PREEMPT, 'L4'));
    await h.intake.settle();

    expect(h.aborts).toHaveLength(1);
    expect(h.submits.map((s) => s.text)).toEqual(['L3', 'L3\n\nL4']);
    expect(h.actions).toEqual(['L3:steer', 'L4:preempt']);
  });

  it('没有攒下东西时只提交自己', async () => {
    const h = makeIntake();
    h.intake.notify(event('b', LEVEL.PREEMPT, 'L4'));
    await h.intake.settle();
    expect(h.aborts).toHaveLength(1);
    expect(h.submits.map((s) => s.text)).toEqual(['L4']);
  });
});

describe('L5：中断 + 锁通道；处理（反射）自己报告结果', () => {
  it('没有声明反射：只 abort + 提交，不加锁', async () => {
    const h = makeIntake();
    h.intake.notify(event('world.fall.lethal', LEVEL.EMERGENCY, '掉进虚空'));
    await h.intake.settle();
    expect(h.aborts).toHaveLength(1);
    expect(h.locks).toEqual([]);
    expect(h.submits.map((s) => s.text)).toEqual(['掉进虚空']);
    expect(h.actions).toEqual(['掉进虚空:emergency']);
  });

  it('声明了反射：上锁；处理报告完成才解锁，而且报告也进上下文', async () => {
    const h = makeIntake();
    h.intake.notify(
      event('world.water.drowning', LEVEL.EMERGENCY, '头在水里', { reflex: 'surface' }),
    );
    await h.intake.settle();

    expect(h.locks).toEqual(['begin']);
    expect(h.submits.map((s) => s.text)).toEqual(['头在水里']);
    expect(h.intake.runningReflexes).toEqual(['surface']);

    h.intake.notify(
      event('reflex.done', LEVEL.STATE, '浮上来了', { completes: 'surface' }),
    );
    await h.intake.settle();

    expect(h.locks).toEqual(['begin', 'end']);
    expect(h.intake.runningReflexes).toEqual([]);
    // 处理的结果是记录（write），不是又一次唤醒
    expect(h.writes.flat().map((e) => e.text)).toEqual(['浮上来了']);
    expect(h.submits).toHaveLength(1);
  });

  it('两个反射都在跑，只有最后一个报告完成才解锁', async () => {
    const h = makeIntake();
    h.intake.notify(event('a', LEVEL.EMERGENCY, 'A', { reflex: 'r1' }));
    h.intake.notify(event('b', LEVEL.EMERGENCY, 'B', { reflex: 'r2' }));
    await h.intake.settle();
    expect(h.locks).toEqual(['begin']);

    h.intake.notify(event('d1', LEVEL.STATE, 'D1', { completes: 'r1' }));
    await h.intake.settle();
    expect(h.locks).toEqual(['begin']);

    h.intake.notify(event('d2', LEVEL.STATE, 'D2', { completes: 'r2' }));
    await h.intake.settle();
    expect(h.locks).toEqual(['begin', 'end']);
  });
});

describe('处理由事件类型决定（不是等级）', () => {
  it('登记了反射的事件不会被投给模型，而是执行处理体', async () => {
    const ran: string[] = [];
    const handler: EventHandler = {
      types: ['item.drop.nearby'],
      executor: 'reflex',
      note: '测试用',
      run: (e, ctx) => {
        ran.push(e.text);
        ctx.emit(event('reflex.done', LEVEL.STATE, '捡完了', { completes: 'auto-pickup' }));
        return Promise.resolve();
      },
    };
    const h = makeIntake([handler]);
    h.intake.notify(event('item.drop.nearby', LEVEL.STATE, '地上有个苹果'));
    await h.intake.settle();
    // 反射不 await（它可能跑好几秒），但要开始跑
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ran).toEqual(['地上有个苹果']);
    expect(h.submits).toHaveLength(0);
    expect(h.writes.flat().map((e) => e.text)).toEqual(['捡完了']);
    expect(h.actions).toEqual(['地上有个苹果:reflex', '捡完了:written']);
  });

  it('等级高也一样按类型走反射（等级不改处理，只改投递）', async () => {
    const ran: string[] = [];
    const handler: EventHandler = {
      types: ['x'],
      executor: 'reflex',
      run: () => {
        ran.push('x');
        return Promise.resolve();
      },
    };
    const h = makeIntake([handler]);
    h.intake.notify(event('x', LEVEL.EMERGENCY, 'X'));
    await h.intake.settle();
    expect(h.submits).toHaveLength(0);
    expect(ran).toEqual(['x']);
  });
});

describe('同步返回 / 异常隔离', () => {
  it('notify 同步返回，异步动作还没跑', async () => {
    const h = makeIntake();
    h.intake.notify(event('e', LEVEL.WAKE, 'L3'));
    expect(h.submits).toHaveLength(0);
    await h.intake.settle();
    expect(h.submits).toHaveLength(1);
  });

  it('提交抛错：整批退回缓冲区不丢，后续事件照样处理', async () => {
    const errors: unknown[] = [];
    const submits: Submitted[] = [];
    let first = true;
    const intake = new EventIntake({
      submit: (text, whenBusy) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('boom'));
        }
        submits.push({ text, whenBusy });
        return Promise.resolve({
          id: 'sub' as never,
          status: () => Promise.resolve({} as never),
          wait: () => Promise.resolve({ status: 'done' } as never),
          abort: () => Promise.resolve('settled' as const),
        } as never);
      },
      write: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      onError: (error) => errors.push(error),
    });

    intake.notify(event('bad', LEVEL.WAKE, 'bad'));
    await intake.settle();
    expect(errors).toHaveLength(1);
    expect(submits).toHaveLength(0);
    expect(intake.pendingCount).toBe(1);

    intake.notify(event('good', LEVEL.WAKE, 'good'));
    await intake.settle();
    expect(submits.map((s) => s.text)).toEqual(['bad\n\ngood']);
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
      write: () => Promise.resolve(),
      abort: () => Promise.reject(new Error('abort boom')),
      onError: (error) => errors.push(error),
    });

    intake.notify(event('x', LEVEL.PREEMPT, 'L4'));
    await intake.settle();
    expect(errors).toHaveLength(1);
    expect(intake.pendingCount).toBe(1);
  });
});

/**
 * 运行时就绪前的事件。
 *
 * SQLite 打开要几毫秒，而边沿检测和 `bot.on(...)` 在连接建立后**立刻**就
 * 开始产生事件了。没有这个缓冲，连接后到就绪之间的事件会真丢——而
 * "丢一个事件就是丢一份工作"。
 */
describe('运行时就绪前的事件不丢', () => {
  it('attach 之前的事件被暂存，不进链、不触发动作', () => {
    const h = makeIntake();
    // 用一个没有 attach 的干净实例观察暂存
    const pending = new EventIntake();
    pending.notify(event('a', LEVEL.WAKE, 'L3'));
    pending.notify(event('b', LEVEL.STATE, 'L2'));

    expect(pending.attached).toBe(false);
    expect(pending.waitingCount).toBe(2);
    expect(pending.pendingCount).toBe(0);

    void h;
  });

  it('attach 后按顺序补投，一个都不丢', async () => {
    const submits: Submitted[] = [];
    const writes: string[] = [];
    const intake = new EventIntake();
    intake.notify(event('a', LEVEL.WAKE, '先'));
    intake.notify(event('b', LEVEL.WAKE, '后'));
    intake.attach({
      submit: (text, whenBusy) => {
        submits.push({ text, whenBusy });
        return Promise.resolve({
          id: 'sub' as never,
          status: () => Promise.resolve({} as never),
          wait: () => Promise.resolve({ status: 'done' } as never),
          abort: () => Promise.resolve('settled' as const),
        } as never);
      },
      write: (_events, text) => {
        writes.push(text);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    });
    await intake.settle();

    expect(intake.attached).toBe(true);
    expect(intake.waitingCount).toBe(0);
    expect(submits.map((s) => s.text)).toEqual(['先\n\n后']);
  });

  it('重复 attach 抛错（不许悄悄换掉运行时）', () => {
    const intake = new EventIntake();
    const deps = {
      submit: () => Promise.reject(new Error('unused')),
      write: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    };
    intake.attach(deps);
    expect(() => intake.attach(deps)).toThrow();
  });
});

describe('异常路径：反射与记录都不能让泵停摆', () => {
  it('反射登记了却没有执行体 → 报错', async () => {
    const errors: unknown[] = [];
    const intake = new EventIntake({
      submit: () => Promise.reject(new Error('unused')),
      write: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      lookup: () => ({ types: ['x'], executor: 'reflex', note: '没有执行体' }),
      onError: (e) => errors.push(e),
    });
    intake.notify(event('x', LEVEL.STATE, 'X'));
    await intake.settle();
    expect(String(errors[0])).toContain('没有执行体');
  });

  it('反射抛错 → onError 记一笔，别的照常', async () => {
    const h = makeIntake([
      {
        types: ['boom'],
        executor: 'reflex',
        run: () => Promise.reject(new Error('反射炸了')),
      },
    ]);
    h.intake.notify(event('boom', LEVEL.STATE, 'B'));
    h.intake.notify(event('quiet', LEVEL.STATE, 'Q'));
    await h.intake.settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.errors).toHaveLength(1);
    expect(h.writes.flat().map((e) => e.text)).toEqual(['Q']);
  });

  it('同名反射跑了两次 → 计数配对，最后一个报告完成才解锁', async () => {
    const h = makeIntake();
    h.intake.notify(event('a', LEVEL.EMERGENCY, 'A', { reflex: 'escape' }));
    h.intake.notify(event('b', LEVEL.EMERGENCY, 'B', { reflex: 'escape' }));
    await h.intake.settle();
    expect(h.intake.runningReflexes).toEqual(['escape']);
    expect(h.locks).toEqual(['begin']);

    h.intake.notify(event('d1', LEVEL.STATE, 'D1', { completes: 'escape' }));
    await h.intake.settle();
    expect(h.intake.runningReflexes).toEqual(['escape']);
    expect(h.locks).toEqual(['begin']);

    h.intake.notify(event('d2', LEVEL.STATE, 'D2', { completes: 'escape' }));
    await h.intake.settle();
    expect(h.intake.runningReflexes).toEqual([]);
    expect(h.locks).toEqual(['begin', 'end']);
  });

  it('记录写不进去 → 退回队列，下次连同新事件一起重试（不丢）', async () => {
    const errors: unknown[] = [];
    const writes: string[] = [];
    let fail = true;
    const intake = new EventIntake({
      submit: () => Promise.reject(new Error('unused')),
      write: (_events, text) => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error('写盘炸了'));
        }
        writes.push(text);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
      onError: (e) => errors.push(e),
    });

    intake.notify(event('a', LEVEL.STATE, 'A'));
    await intake.settle();
    expect(errors).toHaveLength(1);
    expect(writes).toEqual([]);
    expect(intake.pendingCount).toBe(1);

    intake.notify(event('b', LEVEL.STATE, 'B'));
    await intake.settle();
    expect(writes).toEqual(['A\n\nB']);
  });

  it('运行时还没接上时 requestFinished 是空操作', () => {
    const intake = new EventIntake();
    intake.requestStarted();
    intake.requestFinished();
    expect(intake.attached).toBe(false);
    expect(intake.waitingCount).toBe(0);
  });
});

describe('L4 插队：打断立刻插入', () => {
  it('L4 插到普通队列前面，不排在几十条 L3 后面', async () => {
    const h = makeIntake();
    for (let i = 1; i <= 5; i++) h.intake.notify(event(`e${i}`, LEVEL.WAKE, `L3-${i}`));
    h.intake.notify(event('death', LEVEL.PREEMPT, 'L4-death'));
    await h.intake.settle();

    const order = h.actions.map((a) => a.split(':')[0] ?? '');
    expect(order.indexOf('L4-death')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('L4-death')).toBeLessThan(order.indexOf('L3-3'));
    expect(order.indexOf('L4-death')).toBeLessThan(order.indexOf('L3-5'));
  });

  it('插队不破坏各自的先后：L4 之间有序，L3 之间也有序', async () => {
    const h = makeIntake();
    h.intake.notify(event('a', LEVEL.WAKE, 'L3-a'));
    h.intake.notify(event('b', LEVEL.WAKE, 'L3-b'));
    h.intake.notify(event('c', LEVEL.PREEMPT, 'L4-1'));
    h.intake.notify(event('d', LEVEL.WAKE, 'L3-c'));
    h.intake.notify(event('e', LEVEL.PREEMPT, 'L4-2'));
    await h.intake.settle();

    const order = h.actions.map((a) => a.split(':')[0] ?? '');
    expect(order.indexOf('L4-1')).toBeLessThan(order.indexOf('L4-2'));
    expect(order.indexOf('L3-a')).toBeLessThan(order.indexOf('L3-b'));
    expect(order.indexOf('L3-b')).toBeLessThan(order.indexOf('L3-c'));
  });

  it('L5（紧急）同样走优先通道', async () => {
    const h = makeIntake();
    for (let i = 1; i <= 4; i++) h.intake.notify(event(`e${i}`, LEVEL.WAKE, `L3-${i}`));
    h.intake.notify(event('lava', LEVEL.EMERGENCY, 'L5-emergency'));
    await h.intake.settle();

    const order = h.actions.map((a) => a.split(':')[0] ?? '');
    expect(order.indexOf('L5-emergency')).toBeLessThan(order.indexOf('L3-3'));
  });
});
