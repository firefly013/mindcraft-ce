/**
 * 动作执行器契约：动作类即时回 accepted、以后报；查询类阻塞直返；
 * 过期 generation 的完成回调就地丢弃。
 */
import { describe, expect, it, vi } from 'vitest';
import { ACTION_PROGRESS_NOTICE_MS, ActionRunner } from '../src/brain/action_runner.js';
import { createToolCatalog } from '../src/brain/tools/catalog.js';
import type { ToolOutcome } from '../src/brain/tools/tools.js';
import { Scheduler } from '../src/brain/scheduler.js';
import { toolDeclarations } from '../src/body/commands/registry.js';

/** 与生产一致：工具目录来自身体握手报上来的声明。 */
const CATALOG = createToolCatalog(toolDeclarations());

interface Harness {
  runner: ActionRunner;
  scheduler: Scheduler;
  records: string[];
  spoken: string[];
  notices: Array<{ call: string; result: ToolOutcome }>;
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
  const notices: Array<{ call: string; result: ToolOutcome }> = [];
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
    catalog: CATALOG,
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
    const accepted = res.data as { action_id: string; call_id: string; generation: number };
    // action_id 仍是工具名（旧观测依赖它）；call_id 才是这一次调用的唯一标识。
    expect(accepted.action_id).toBe('goToPlayer');
    expect(accepted.call_id).toMatch(/^goToPlayer#\d+$/);
    expect(h.executed).toEqual(['goToPlayer']);
    expect(h.records).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.scheduler.describe().actionId).not.toBeNull();

    h.resolveExecute('arrived');
    await tick();
    await tick();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toContain('arrived');
    expect(h.records[0]).toContain(accepted.call_id);
    expect(h.scheduler.describe().actionId).toBeNull();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.call).toBe('goToPlayer');
    expect(h.notices[0]?.result.status).toBe('completed');
    const notice = h.notices[0] as unknown as { call_id: string; generation: number };
    expect(notice.call_id).toBe(accepted.call_id);
    expect(notice.generation).toBe(accepted.generation);
    expect(String(h.notices[0]?.result.data)).toContain(accepted.call_id);
  });

  it('a stale completion is not recorded, but IS reported as interrupted', async () => {
    // 行为改过（模型反馈）：以前过期就地丢弃、什么都不说，模型看到的是"调用后
    // 再无音讯"，只能反复拍快照猜。现在仍然不记账（结果不作数），但报一条
    // "被中断"，给它一个交代。
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 });
    h.scheduler.stopAll(); // Stop 作废了这一代。
    h.resolveExecute('arrived late');
    await tick();
    await tick();
    expect(h.records).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.call).toBe('goToPlayer');
    const text = String((h.notices[0]?.result as { data?: unknown }).data);
    expect(text).toContain('被中断');
    expect(text).toContain('Stop 停掉了它');
    expect(text).not.toContain('保命反射');
  });

  it('保命反射打断时明确写保命，不把锅扣给 Stop；如果身体仍返回结果就保留', async () => {
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('searchForBlock', { type: 'lava', search_range: 512 });
    h.scheduler.beginEmergency();
    h.resolveExecute('Found lava at (10, 20, 30).');
    await tick();
    await tick();
    expect(h.notices).toHaveLength(1);
    const text = String((h.notices[0]?.result as { data?: unknown }).data);
    expect(text).toContain('保命反射');
    expect(text).toContain('不是你调用的 Stop');
    expect(text).toContain('供参考');
    expect(text).toContain('Found lava at (10, 20, 30).');
    expect(h.records.some((line) => line.includes('Found lava'))).toBe(true);
  });

  it('保命反射且没有结果：回执只写保命打断，不写 Stop 作废', async () => {
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('searchForBlock', { type: 'lava', search_range: 512 });
    h.scheduler.beginEmergency();
    h.resolveExecute('');
    await tick();
    await tick();
    expect(h.notices).toHaveLength(1);
    const text = String((h.notices[0]?.result as { data?: unknown }).data);
    expect(text).toContain('保命反射/急停抢走了身体');
    expect(text).not.toContain('Stop 停掉了它');
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
    // busy 回执要带占用者/时长/generation，模型才知道谁卡着。
    expect(busy.reason).toContain('generation');
    expect(busy.reason).toContain('秒');
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

  it('连续两次调用拿到不同的 call_id，结果能对回各自那一次', async () => {
    const h = makeHarness();
    const first = (await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 })).data as {
      call_id: string;
    };
    await tick();
    await tick();
    const second = (await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 })).data as {
      call_id: string;
    };
    await tick();
    await tick();
    expect(first.call_id).not.toBe(second.call_id);
    expect(h.notices.map((n) => (n as unknown as { call_id: string }).call_id)).toEqual([
      first.call_id,
      second.call_id,
    ]);
  });

  it('身体返回空串时也给出可行动的回执，不落下 (no output)', async () => {
    const h = makeHarness();
    h.hold = true;
    await h.runner.run('searchForBlock', { type: 'oak_log', search_range: 64 });
    h.resolveExecute('   ');
    await tick();
    await tick();
    expect(h.notices).toHaveLength(1);
    const text = String(h.notices[0]?.result.data);
    expect(text).toMatch(/searchForBlock#\d+/);
    expect(text).not.toBe('(no output)');
    expect(text).toContain('searchForBlock');
    expect(text).toContain('stats');
  });

  it('完成回执的 payload 带 action_id / call_id / generation', async () => {
    const h = makeHarness();
    await h.runner.run('collectBlocks', { type: 'oak_log', num: 1 });
    await tick();
    await tick();
    const notice = h.notices[0] as unknown as {
      action_id: string;
      call_id: string;
      generation: number;
    };
    expect(notice.action_id).toBe('collectBlocks');
    expect(notice.call_id).toMatch(/^collectBlocks#\d+$/);
    expect(typeof notice.generation).toBe('number');
  });

  it('长时间没有结果时主动发一条仍在跑的进度回执', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      h.hold = true;
      const accepted = (await h.runner.run('goToPlayer', { player_name: 's', closeness: 2 })).data as {
        call_id: string;
      };
      await vi.advanceTimersByTimeAsync(ACTION_PROGRESS_NOTICE_MS + 1000);
      const progress = h.notices.filter((n) => String(n.result.data).includes('还在跑'));
      expect(progress).toHaveLength(1);
      expect(String(progress[0]?.result.data)).toContain(accepted.call_id);
      // 放行真实结果，确认进度回执不会替代最终回执。
      h.resolveExecute('arrived');
      await Promise.resolve();
      await Promise.resolve();
      expect(h.notices.some((n) => String(n.result.data).includes('arrived'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
