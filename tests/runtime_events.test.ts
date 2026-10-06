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
    write: (event) => {
      writes.push(event);
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

describe('L1/L2：只记账，不唤醒', () => {
  it('走 write，不 submit', async () => {
    const h = makeIntake();
    h.intake.notify(event('L1', LEVEL.UNUSED));
    h.intake.notify(event('L2', LEVEL.STATE));
    await h.intake.settle();

    expect(h.writes.map((e) => e.text)).toEqual(['L1', 'L2']);
    expect(h.submits).toHaveLength(0);
    expect(h.actions).toEqual(['L1:write', 'L2:write']);
  });

  it('write 不进 outstanding——`abort()` 明确"queued writes stay"', async () => {
    const h = makeIntake();
    h.intake.notify(event('L2', LEVEL.STATE));
    await h.intake.settle();
    expect(h.intake.outstandingEvents).toHaveLength(0);
  });
});

describe('L3：引导（steer）', () => {
  it('走 submit(whenBusy=steer)，并记入 outstanding', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();

    expect(h.submits).toEqual([{ text: 'L3', whenBusy: 'steer' }]);
    expect(h.intake.outstandingEvents.map((e) => e.text)).toEqual(['L3']);
    expect(h.actions).toEqual(['L3:steer']);
  });

  it('落定后从 outstanding 移除', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();
    h.releaseAll();
    // 等 forget 的微任务跑完
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.intake.outstandingEvents).toHaveLength(0);
  });
});

describe('L4：中断（abort + submit）', () => {
  it('排队中的 L3 被 abort 撤回后**重新提交**，然后才是 L4 自己', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();
    expect(h.submits.map((s) => s.text)).toEqual(['L3']);

    h.intake.notify(event('L4', LEVEL.PREEMPT));
    await h.intake.settle();

    expect(h.aborts).toHaveLength(1);
    // L3 先于 L4 重新提交：保持时间顺序，且一个都不能丢
    expect(h.submits.map((s) => s.text)).toEqual(['L3', 'L3', 'L4']);
    expect(h.submits.every((s) => s.whenBusy === 'steer')).toBe(true);
    expect(h.actions).toEqual(['L3:steer', 'L4:preempt']);
  });

  it('没有排队事件时只提交自己', async () => {
    const h = makeIntake();
    h.intake.notify(event('L4', LEVEL.PREEMPT));
    await h.intake.settle();
    expect(h.aborts).toHaveLength(1);
    expect(h.submits.map((s) => s.text)).toEqual(['L4']);
  });
});

describe('L5：冻住 → 保命 → 接着干', () => {
  it('abort + rescue，被撤回的 L3 在保命之后重新提交，**L5 自己不提交**', async () => {
    const h = makeIntake();
    h.intake.notify(event('L3', LEVEL.WAKE));
    await h.intake.settle();

    h.intake.notify(event('L5', LEVEL.EMERGENCY));
    await h.intake.settle();

    expect(h.aborts).toHaveLength(1);
    expect(h.rescues).toHaveLength(1);
    // L5 由反射消化，不再喂给模型——所以只有 L3 被重新提交
    expect(h.submits.map((s) => s.text)).toEqual(['L3', 'L3']);
    expect(h.actions).toEqual(['L3:steer', 'L5:emergency']);
  });

  it('空闲时 L5 也能触发（abort + rescue）', async () => {
    const h = makeIntake();
    h.intake.notify(event('L5', LEVEL.EMERGENCY));
    await h.intake.settle();
    expect(h.aborts).toHaveLength(1);
    expect(h.rescues).toHaveLength(1);
    expect(h.submits).toHaveLength(0);
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

  it('一个动作抛错不阻断后续事件', async () => {
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
      write: () => Promise.resolve({} as never),
      abort: () => Promise.resolve(),
      rescue: () => Promise.resolve(),
      onError: (error) => h.errors.push(error),
    });

    intake.notify(event('bad', LEVEL.WAKE));
    intake.notify(event('good', LEVEL.WAKE));
    await intake.settle();

    expect(h.errors).toHaveLength(1);
    expect(h.submits.map((s) => s.text)).toEqual(['good']);
  });
});
