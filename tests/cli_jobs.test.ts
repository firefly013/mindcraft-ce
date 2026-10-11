/**
 * CLI 任务表的契约。
 *
 * 这里最重要的不是"能不能存任务"，而是**状态机那几处反直觉的地方**：
 * 取消之后不能被写成 done、wait 超时不是失败。这两处写错了都不报错，
 * 只是行为静静变错——点了取消跟没点一样，或者"超时"让人以为机器人停了。
 */
import { describe, expect, it } from 'vitest';
import { CliJobTracker } from '../src/agent/cli_jobs.js';

function tracker(stop: () => Promise<void> = async () => {}): CliJobTracker {
  return new CliJobTracker({ stop });
}

/** 一个可控完成的任务：手动 resolve/reject。 */
function deferred() {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('提交与完成', () => {
  it('start 立即返回 id，任务此时还在跑', async () => {
    const t = tracker();
    const d = deferred();
    const { id } = t.start('goToCoordinates', () => d.promise);
    expect(t.status(id).state).toBe('running');
    d.resolve('到了');
    await d.promise;
    await new Promise((r) => setTimeout(r, 0));
    expect(t.status(id).state).toBe('done');
    expect(t.status(id).output).toBe('到了');
  });

  it('命令抛错 → error，并且把原因带出来', async () => {
    const t = tracker();
    const d = deferred();
    const { id } = t.start('mineBlock', () => d.promise);
    d.reject(new Error('够不着'));
    await d.promise.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.status(id).state).toBe('error');
    expect(t.status(id).error).toContain('够不着');
  });

  it('id 递增，list 能列出全部', () => {
    const t = tracker();
    const a = t.start('a', () => Promise.resolve(''));
    const b = t.start('b', () => Promise.resolve(''));
    expect(a.id).toBe('1');
    expect(b.id).toBe('2');
    expect(t.list().map((j) => j.name)).toEqual(['a', 'b']);
  });
});

describe('取消', () => {
  it('取消过的任务，结束时**不能**被写回 done', async () => {
    // 这是整个状态机最容易写错的一处：`stop()` 不会让那个 await 立刻返回，
    // 等它真结束时 .then 还会跑一次。没有独立标记的话，cancel 点了跟没点一样。
    const t = tracker();
    const d = deferred();
    const { id } = t.start('goToCoordinates', () => d.promise);

    expect(await t.cancel(id)).toBe(true);
    // 动作"终于停下来了"，命令返回了——但它不是成功。
    d.resolve('走到了');
    await d.promise;
    await new Promise((r) => setTimeout(r, 0));

    expect(t.status(id).state).toBe('cancelled');
    expect(t.peek(id)?.output).toBeUndefined();
  });

  it('取消会真的去停动作', async () => {
    let stopped = 0;
    const t = tracker(() => {
      stopped++;
      return Promise.resolve();
    });
    const d = deferred();
    const { id } = t.start('goToCoordinates', () => d.promise);
    await t.cancel(id);
    expect(stopped).toBe(1);
    d.resolve('');
    await d.promise;
  });

  it('stop 抛错也算取消成功（标记已经置上了）', async () => {
    const t = tracker(() => Promise.reject(new Error('停不掉')));
    const d = deferred();
    const { id } = t.start('x', () => d.promise);
    expect(await t.cancel(id)).toBe(true);
    expect(t.peek(id)?.cancelRequested).toBe(true);
    d.resolve('');
    await d.promise;
  });

  it('已经结束的任务取消不了', async () => {
    const t = tracker();
    const { id } = t.start('stats', () => Promise.resolve('ok'));
    await new Promise((r) => setTimeout(r, 0));
    expect(t.status(id).state).toBe('done');
    expect(await t.cancel(id)).toBe(false);
  });

  it('不存在的 id 取消不了', async () => {
    expect(await tracker().cancel('999')).toBe(false);
  });
});

describe('等待', () => {
  it('等到了就给结果', async () => {
    const t = tracker();
    const d = deferred();
    const { id } = t.start('x', () => d.promise);
    setTimeout(() => d.resolve('完成'), 10);
    const res = await t.wait(id, 2000);
    expect(res.state).toBe('done');
    expect(res.output).toBe('完成');
  });

  it('**超时不是失败**：还在跑就说还在跑', async () => {
    const t = tracker();
    const d = deferred();
    const { id } = t.start('goToCoordinates', () => d.promise);
    const res = await t.wait(id, 20);
    expect(res.state).toBe('running');
    expect(res.error).toBeUndefined();
    d.resolve('');
    await d.promise;
  });

  it('等一个不存在的 id → unknown，并说清可能被挤掉了', async () => {
    const res = await tracker().wait('404', 10);
    expect(res.state).toBe('unknown');
    expect(res.error).toContain('404');
  });

  it('status 查不到也是 unknown，不炸', () => {
    expect(tracker().status('404').state).toBe('unknown');
  });
});

describe('任务表不会无限长', () => {
  it('超过上限就挤掉最老的', () => {
    const t = tracker();
    for (let i = 0; i < 60; i++) t.start(`job${i}`, () => Promise.resolve(''));
    const ids = t.list().map((j) => Number(j.id));
    expect(ids.length).toBe(50);
    expect(Math.min(...ids)).toBe(11); // 1..10 被挤出去了
  });
});
