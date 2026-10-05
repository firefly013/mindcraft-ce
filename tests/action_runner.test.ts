/**
 * 动作执行器契约：动作类即时回 accepted、以后报；查询类阻塞直返；
 * 过期 generation 的完成回调就地丢弃。
 */
import { describe, expect, it } from 'vitest';
import { ActionRunner } from '../src/agent/action_runner.js';
import type { LoopToolResult } from '../src/agent/loop.js';
import { Scheduler } from '../src/agent/scheduler.js';

interface Harness {
  runner: ActionRunner;
  scheduler: Scheduler;
  records: string[];
  spoken: string[];
  notices: Array<{ call: string; result: LoopToolResult }>;
  hold: boolean;
  resolveExecute: (value: string) => void;
  rejectExecute: (err: unknown) => void;
  executed: string[];
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(): Harness {
  const scheduler = new Scheduler();
  const records: string[] = [];
  const spoken: string[] = [];
  const notices: Array<{ call: string; result: LoopToolResult }> = [];
  const executed: string[] = [];
  const harness = {
    runner: null as unknown as ActionRunner,
    scheduler,
    records,
    spoken,
    notices,
    hold: false,
    executed,
    resolveExecute: (value: string) => {
      gate.resolve(value);
      gate = deferred<string>();
    },
    rejectExecute: (err: unknown) => {
      gate.reject(err);
      gate = deferred<string>();
    },
  };
  let gate = deferred<string>();
  harness.runner = new ActionRunner({
    scheduler,
    record: (outcome: string) => {
      records.push(outcome);
      return Promise.resolve();
    },
    speak: (text: string) => {
      spoken.push(text);
    },
    execute: (name: string) => {
      executed.push(name);
      return harness.hold ? gate.promise : Promise.resolve('{"ok":true}');
    },
    notify: (payload) => {
      notices.push(payload);
    },
  });
  return harness;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('ActionRunner', () => {
  it('query tools block and return content, never touching the channel', async () => {
    const h = makeHarness();
    const res = await h.runner.run('stats', {});
    expect(res.status).toBe('completed');
    expect(h.executed).toEqual(['stats']);
    expect(h.records).toEqual(['{"ok":true}']);
    expect(h.scheduler.describe().actionId).toBeNull();
    expect(h.notices).toEqual([]);
  });

  it('action tools return accepted at once and report later', async () => {
    const h = makeHarness();
    h.hold = true;
    const res = await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 });
    expect(res.status).toBe('accepted');
    expect(h.executed).toEqual(['goToPlayer']);
    expect(h.records).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.scheduler.describe().actionId).not.toBeNull();

    h.resolveExecute('arrived');
    await tick();
    await tick();
    expect(h.records).toEqual(['arrived']);
    expect(h.scheduler.describe().actionId).toBeNull();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.call).toBe('goToPlayer');
    expect(h.notices[0]?.result.status).toBe('completed');
  });

  it('a stale completion is dropped on the floor, never recorded or reported', async () => {
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 });
    h.scheduler.stopAll(); // Stop 作废了这一代。
    h.resolveExecute('arrived late');
    await tick();
    await tick();
    expect(h.records).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('validation failures are recorded without claiming the channel', async () => {
    const h = makeHarness();
    const res = await h.runner.run('NoSuchTool', {});
    expect(res.status).toBe('rejected');
    expect(h.executed).toEqual([]);
    expect(h.scheduler.describe().actionId).toBeNull();
    expect(h.records).toHaveLength(1);
  });

  it('a second action while one runs is refused, the first is unaffected', async () => {
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 });
    const busy = await h.runner.run('collectBlocks', { type: 'oak_log' });
    expect(busy.status).toBe('rejected');
    expect(h.executed).toEqual(['goToPlayer']);

    h.resolveExecute('arrived');
    await tick();
    await tick();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.call).toBe('goToPlayer');
  });

  it('an executing crash still reports a failure verdict when current', async () => {
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 });
    h.rejectExecute(new Error('boom'));
    await tick();
    await tick();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toContain('boom');
    expect(h.notices).toHaveLength(1);
  });
});
