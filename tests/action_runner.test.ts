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
    const busy = await h.runner.run('collectBlocks', { type: 'oak_log', num: 4 });
    expect(busy.status).toBe('rejected');
    expect(busy.reason).toContain('goToPlayer');
    // 拒绝文案不再命令模型先 Stop：要不要打断由模型自己判断。
    expect(busy.reason).toContain('确实要改做别的事');
    expect(h.executed).toEqual(['goToPlayer']);

    h.resolveExecute('arrived');
    await tick();
    await tick();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.call).toBe('goToPlayer');
  });

  it('re-issuing the SAME action while it runs is an idempotent no-op, not an error', async () => {
    // 这是内测里"模型反复 Stop"的根因：被 L3 事件叫醒后把同一个动作
    // 再下一次，旧行为报 "Stop() first, then retry"，模型就真的去停掉
    // 自己正在做的事。
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('collectBlocks', { type: 'oak_log', num: 6 });
    const again = await h.runner.run('collectBlocks', { type: 'oak_log', num: 4 });
    expect(again.status).toBe('accepted');
    expect(again.data).toMatchObject({ already_running: true, action_id: 'collectBlocks' });
    // 没有真的再跑一次，也没占第二份通道。
    expect(h.executed).toEqual(['collectBlocks']);
    expect(h.scheduler.describe().actionId).toBe('collectBlocks');
    // 记账里说明了"已经在做了"，而不是"rejected"。
    expect(h.records.at(-1)).toContain('already running');
    expect(h.records.at(-1)).not.toContain('rejected');

    h.resolveExecute('done');
    await tick();
    await tick();
    expect(h.notices).toHaveLength(1);
  });

  it('the model preempts a background autoPickup instead of getting a busy error', async () => {
    // 自动拾取是后台房客：它由 Agent 直接用 scheduler.startAction 认领
    // （不是普通工具），模型要用身体时它立刻让位——否则模型会莫名吃到忙音。
    const h = makeHarness();
    h.scheduler.startAction('autoPickup', { id: 7 });
    expect(h.scheduler.describe().actionId).toBe('autoPickup');
    const res = await h.runner.run('collectBlocks', { type: 'oak_log', num: 4 });
    expect(res.status).toBe('accepted');
    expect(h.scheduler.describe().actionId).toBe('collectBlocks');
  });

  it('Stop reports what it actually stopped, and frees the channel for the next action', async () => {
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('collectBlocks', { type: 'oak_log', num: 4 });
    const stopped = h.scheduler.stopAll();
    expect(stopped).toMatchObject({ hadAction: true, actionId: 'collectBlocks' });
    // 通道当场释放：下一个动作立刻能认领（不需要"再 Stop 一次"）。
    expect(h.scheduler.describe().actionId).toBeNull();
    h.hold = false;
    const next = await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 });
    expect(next.status).toBe('accepted');
    expect(h.scheduler.describe().actionId).toBe('goToPlayer');
  });

  it('Stop with nothing running is honestly reported as a no-op', () => {
    const h = makeHarness();
    expect(h.scheduler.stopAll()).toMatchObject({ hadAction: false, actionId: null });
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
