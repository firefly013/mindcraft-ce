/**
 * 调度器契约，端到端锁定。
 *
 * 每个用例只断言可观察的决策或状态变化：开什么请求、带什么事件、
 * 拒什么动作、哪个回调过期。不测实现细节。
 */
import { describe, expect, it } from 'vitest';
import { KIND, LEVEL, Scheduler } from '../src/agent/scheduler.js';
import type { Kind, Level } from '../src/agent/scheduler.js';

const ev = (level: Level, kind: Kind = KIND.WORLD, payload: unknown = {}) => ({ kind, level, payload });

describe('levels 1-2: stored, never wake', () => {
  it('level 1 is filed and never starts a request', () => {
    const s = new Scheduler();
    expect(s.pushEvent(ev(LEVEL.UNUSED))).toEqual({ decision: 'stored', seq: 1 });
    expect(s.describe().apiBusy).toBe(false);
  });

  it('level 2 is filed while idle and while busy', () => {
    const s = new Scheduler();
    expect(s.pushEvent(ev(LEVEL.STATE)).decision).toBe('stored');
    s.beginRequest();
    expect(s.pushEvent(ev(LEVEL.STATE)).decision).toBe('stored');
  });

  it('level 2 rides the next request that opens for another reason', () => {
    const s = new Scheduler();
    s.pushEvent({ kind: KIND.WORLD, level: LEVEL.STATE, payload: { t: 10000 } });
    s.pushEvent(ev(LEVEL.WAKE, KIND.USER));
    const { events } = s.beginRequest();
    expect(events.map((e) => e.level)).toEqual([LEVEL.STATE, LEVEL.WAKE]);
  });

  it('level 1 never rides a request', () => {
    const s = new Scheduler();
    s.pushEvent(ev(LEVEL.UNUSED));
    s.pushEvent(ev(LEVEL.WAKE));
    const { events } = s.beginRequest();
    expect(events.every((e) => e.level !== LEVEL.UNUSED)).toBe(true);
    expect(events).toHaveLength(1);
  });
});

describe('level 3: wake when idle, queue when busy', () => {
  it('idle API opens immediately, even with an action running', () => {
    const s = new Scheduler();
    s.startAction('run-long');
    expect(s.pushEvent(ev(LEVEL.WAKE)).decision).toBe('start');
  });

  it('busy API queues; the newcomer waits for the next request', () => {
    const s = new Scheduler();
    s.beginRequest();
    expect(s.pushEvent(ev(LEVEL.WAKE)).decision).toBe('queued');
    // 跑着的请求只带走了当时已有的东西，新来者还在 pending。
    expect(s.describe().pending).toBe(1);
  });

  it('finish with unseen level-3+ starts another round; otherwise idle', () => {
    const s = new Scheduler();
    const first = s.beginRequest();
    s.pushEvent(ev(LEVEL.WAKE));
    expect(s.finishRequest(first.requestId)).toEqual({ decision: 'start' });

    const next = s.beginRequest();
    expect(next.events).toHaveLength(1);
    expect(s.finishRequest(next.requestId)).toEqual({ decision: 'idle' });
    expect(s.describe().apiBusy).toBe(false);
  });

  it('a request carries only what it has not seen: no self-wake loop', () => {
    const s = new Scheduler();
    s.pushEvent(ev(LEVEL.WAKE));
    const first = s.beginRequest();
    expect(first.events).toHaveLength(1);
    // 没来新东西：finish 必须 idle，不能被同一个事件再唤醒。
    expect(s.finishRequest(first.requestId)).toEqual({ decision: 'idle' });
  });

  it('a stale finish (preempted request ending late) changes nothing', () => {
    const s = new Scheduler();
    const first = s.beginRequest();
    s.pushEvent({ kind: KIND.WORLD, level: LEVEL.PREEMPT, payload: {} });
    expect(s.finishRequest(first.requestId)).toEqual({ decision: 'stale' });
    expect(s.describe().apiBusy).toBe(false);
  });
});

describe('level 4: preempt the request, keep the action', () => {
  it('idle API just starts', () => {
    const s = new Scheduler();
    const r = s.pushEvent(ev(LEVEL.PREEMPT));
    expect(r.decision).toBe('start');
    expect('cancelledRequest' in r).toBe(false);
  });

  it('busy API cancels the request and names it; the action survives', () => {
    const s = new Scheduler();
    s.startAction('run-long');
    const first = s.beginRequest();
    const r = s.pushEvent({ kind: KIND.WORLD, level: LEVEL.PREEMPT, payload: { hp: 8 } });
    expect(r).toEqual({ decision: 'preempt', seq: 1, cancelledRequest: first.requestId });
    expect(s.describe().apiBusy).toBe(false);
    expect(s.describe().actionId).toBe('run-long');
  });

  it('the preempted request un-sees its events: the restart includes them again', () => {
    const s = new Scheduler();
    s.pushEvent({ kind: KIND.WORLD, level: LEVEL.WAKE, payload: { n: 1 } });
    const first = s.beginRequest();
    expect(first.events).toHaveLength(1);
    s.pushEvent(ev(LEVEL.PREEMPT));
    const restart = s.beginRequest();
    // 抢占事件和被 un-see 的 wake 事件都搭重启的车。
    expect(restart.events.map((e) => e.level).sort()).toEqual([LEVEL.WAKE, LEVEL.PREEMPT].sort());
  });
});

describe('level 5: stop everything and lock', () => {
  it('cancels the request, clears the action, bumps the generation, locks', () => {
    const s = new Scheduler();
    s.startAction('run-long');
    const first = s.beginRequest();
    const gen = s.describe().generation;
    const r = s.pushEvent({ kind: KIND.WORLD, level: LEVEL.EMERGENCY, payload: { hp: 4 } });
    expect(r).toEqual({ decision: 'emergency', seq: 1, cancelledRequest: first.requestId });
    expect(s.describe().actionId).toBeNull();
    expect(s.describe().generation).toBe(gen + 1);
    expect(s.describe().emergency).toBe(true);
  });

  it('emergency with nothing running still locks', () => {
    const s = new Scheduler();
    const r = s.pushEvent(ev(LEVEL.EMERGENCY));
    expect(r).toEqual({ decision: 'emergency', seq: 1, cancelledRequest: null });
  });

  it('while locked, wake and preempt events are only stored', () => {
    const s = new Scheduler();
    s.pushEvent(ev(LEVEL.EMERGENCY));
    expect(s.pushEvent(ev(LEVEL.WAKE)).decision).toBe('stored');
    expect(s.pushEvent(ev(LEVEL.PREEMPT)).decision).toBe('stored');
  });

  it('a cancelled request hands its events back: nothing is lost to the emergency', () => {
    const s = new Scheduler();
    s.pushEvent({ kind: KIND.WORLD, level: LEVEL.WAKE, payload: { n: 1 } });
    s.beginRequest();
    s.pushEvent(ev(LEVEL.EMERGENCY));
    expect(s.endEmergency()).toEqual({ decision: 'start' });
    const restart = s.beginRequest();
    expect(restart.events).toHaveLength(1);
    expect(restart.events[0]?.level).toBe(LEVEL.WAKE);
  });

  it('ending the lock with pending work restarts; without, idles and prunes', () => {
    const s = new Scheduler();
    s.pushEvent(ev(LEVEL.EMERGENCY));
    s.pushEvent(ev(LEVEL.WAKE));
    expect(s.endEmergency()).toEqual({ decision: 'start' });

    const clean = new Scheduler();
    clean.pushEvent(ev(LEVEL.EMERGENCY));
    expect(clean.endEmergency()).toEqual({ decision: 'idle' });
    expect(clean.describe().pending).toBe(0);
  });
});

describe('the action channel', () => {
  it('one action at a time: the second is refused, never queued or swapped', () => {
    const s = new Scheduler();
    expect(s.startAction('a')).toEqual({ accepted: true, actionId: 'a', generation: 0 });
    expect(s.startAction('b')).toEqual({ accepted: false, code: 'ACTION_BUSY' });
    expect(s.describe().actionId).toBe('a');
  });

  it('Stop frees the channel and invalidates the old generation', () => {
    const s = new Scheduler();
    const started = s.startAction('a');
    const stopped = s.stopAll();
    expect(stopped.generation).toBe((started.generation ?? 0) + 1);
    expect(s.isCurrent(started.generation ?? -1)).toBe(false);
    expect(s.isCurrent(stopped.generation)).toBe(true);
    expect(s.startAction('b')).toEqual({ accepted: true, actionId: 'b', generation: stopped.generation });
  });

  it('releaseAction frees without bumping: a natural end is not a stranger-making event', () => {
    const s = new Scheduler();
    expect(s.releaseAction()).toBe(false);
    s.startAction('a');
    const gen = s.describe().generation;
    expect(s.releaseAction()).toBe(true);
    expect(s.describe().generation).toBe(gen);
    expect(s.isCurrent(gen)).toBe(true);
    expect(s.startAction('b')).toEqual({ accepted: true, actionId: 'b', generation: gen });
  });

  it('an action starts fine while a request is running: independent channels', () => {
    const s = new Scheduler();
    s.beginRequest();
    expect(s.startAction('a').accepted).toBe(true);
  });

  it('locked channel refuses with EMERGENCY_LOCKED', () => {
    const s = new Scheduler();
    s.pushEvent(ev(LEVEL.EMERGENCY));
    expect(s.startAction('a')).toEqual({ accepted: false, code: 'EMERGENCY_LOCKED' });
  });
});

describe('validation and reporting', () => {
  it('unknown kind and out-of-range level throw', () => {
    const s = new Scheduler();
    expect(() => s.pushEvent({ kind: 'Server' as never, level: 3, payload: {} })).toThrow(RangeError);
    expect(() => s.pushEvent({ kind: 'Bot' as never, level: 3, payload: {} })).toThrow(RangeError);
    expect(() => s.pushEvent(ev(0 as Level))).toThrow(RangeError);
    expect(() => s.pushEvent(ev(6 as Level))).toThrow(RangeError);
    expect(() => s.pushEvent(ev(2.5 as Level))).toThrow(RangeError);
  });

  it('all four kinds dispatch', () => {
    const s = new Scheduler();
    for (const kind of [KIND.USER, KIND.WORLD, KIND.TOOL, KIND.MODEL]) {
      expect(s.pushEvent({ kind, level: LEVEL.WAKE, payload: {} }).decision).toBe('start');
    }
  });

  it('beginRequest while busy reuses the running request with nothing new', () => {
    const s = new Scheduler();
    const first = s.beginRequest();
    expect(s.beginRequest()).toEqual({ requestId: first.requestId, events: [], reused: true });
  });

  it('describe reports dispatch state, and idle finish prunes consumed events', () => {
    const s = new Scheduler();
    s.pushEvent(ev(LEVEL.WAKE));
    const d0 = s.describe();
    expect(d0.pending).toBe(1);
    expect(d0.actionId).toBeNull();

    const { requestId } = s.beginRequest();
    expect(s.describe().pending).toBe(0);
    s.finishRequest(requestId);
    expect(s.describe().pending).toBe(0);
  });
});
