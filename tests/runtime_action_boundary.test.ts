/**
 * §10 点名「最容易在迁移中丢掉」的 B2 / E1 / E2 / E3。
 *
 * 它们**不是框架自带的东西**，而是本项目踩过的坑，而且全都跨在
 * 「事件接入 ↔ 身体通道」这条边界上。这里在真实的
 * `Scheduler + ActionRunner + EventIntake` 边界上把它们钉死——
 * 不需要 `agent.ts` 翻面就能验。
 *
 * 用真实工具名（`followPlayer` / `goToPlayer`）：`ActionRunner.run` 会走
 * `validateToolCall`，编出来的名字过不了校验——那样测的就不是真实路径了。
 *
 * ## 这个文件**钉住了什么、没钉住什么**
 *
 * 钉住的是**契约**：`ActionRunner` / `Scheduler` 在忙时、Stop 时、L4 时的
 * 行为。这些是主线 `92309d1` 修好的，翻转时不能丢。
 *
 * **没钉住的是接线**：如果 `agent.ts` 翻面时把游戏工具的 `execute` 直连
 * `executeToolCall`（绕过 `ActionRunner`），这个文件照样全绿——因为它是直接
 * 调 `ActionRunner` 的。要防住那种回归，得有一条**跑翻转后装配**的测试
 * （见 `runtime_bot.test.ts` 的装配层，翻面后要在那里补一条"动作类工具真的
 * 占用了身体通道"）。留这条注释是为了不让它被误当成完整覆盖。
 */
import { describe, expect, it } from 'vitest';
import type { Submission } from '@earendil-works/pi-durable';
import { ActionRunner } from '../src/agent/action_runner.js';
import { LEVEL, Scheduler } from '../src/agent/scheduler.js';
import { EventIntake } from '../src/runtime/events.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Boundary {
  scheduler: Scheduler;
  runner: ActionRunner;
  records: string[];
  notified: Array<{ call: string; result: { status: string; data?: unknown } }>;
  /** 放行后台动作。 */
  release: () => void;
  /** 后台动作真的开始了。 */
  started: Promise<void>;
}

function makeBoundary(): Boundary {
  const scheduler = new Scheduler();
  const records: string[] = [];
  const notified: Boundary['notified'] = [];
  const gate = deferred();
  const startedSignal = deferred();

  const runner = new ActionRunner({
    scheduler,
    record: (outcome, name) => {
      records.push(`${name}: ${outcome}`);
      return Promise.resolve();
    },
    speak: () => {},
    execute: (name) => {
      if (name === 'followPlayer') {
        startedSignal.resolve();
        return gate.promise.then(() => '跟随中');
      }
      return Promise.resolve(`${name} 完成`);
    },
    notify: (payload) => {
      notified.push(payload as Boundary['notified'][number]);
    },
  });

  return {
    scheduler,
    runner,
    records,
    notified,
    release: gate.resolve,
    started: startedSignal.promise,
  };
}

/** 一个不会落定的假 submission（事件层用不到它的结果）。 */
function fakeSubmission(): Submission {
  return {
    id: 'sub' as unknown as Submission['id'],
    status: () => Promise.resolve({} as never),
    wait: () => new Promise(() => {}),
    abort: () => Promise.resolve('settled' as const),
  } as Submission;
}

describe('E1：请求的动作就是正在跑的那个 → 幂等忽略，不催 Stop', () => {
  it('回「已经在做了」，动作**没有**被打断', async () => {
    const b = makeBoundary();
    const first = await b.runner.run('followPlayer', { player_name: 'bobo', follow_dist: 3 });
    expect(first.status).toBe('accepted');
    await b.started;

    // 模型被事件叫醒后，常常把同一个动作再下一次
    const again = await b.runner.run('followPlayer', { player_name: 'bobo', follow_dist: 3 });
    expect(again.status).toBe('accepted');
    expect(again.data).toMatchObject({ already_running: true });

    // 关键：身体通道还是它，没有被 Stop 掉
    expect(b.scheduler.currentAction()?.id).toBe('followPlayer');
    // 而且回执里不该出现「先 Stop 再重试」这种命令
    expect(JSON.stringify(again.data)).not.toContain('Stop() first');
    expect(JSON.stringify(again.data)).toContain('不用重发');
    b.release();
  });
});

describe('E2：确实是另一个动作 → 说清谁在跑、跑多久，不命令 Stop', () => {
  it('报出在跑的动作名与时长，把判断交还模型', async () => {
    const b = makeBoundary();
    await b.runner.run('followPlayer', { player_name: 'bobo', follow_dist: 3 });
    await b.started;

    const other = await b.runner.run('goToPlayer', { player_name: 'bobo', closeness: 2 });
    expect(other.status).toBe('rejected');
    expect(other.code).toBe('ACTION_BUSY');
    expect(other.reason).toContain('followPlayer');
    expect(other.reason).toContain('秒');
    // 「只有你确实要改做别的事时，才需要先 Stop」——交还判断，而不是命令
    expect(other.reason).toContain('才需要先 Stop');
    // 在跑的动作不受影响
    expect(b.scheduler.currentAction()?.id).toBe('followPlayer');
    b.release();
  });
});

describe('E3：Stop 一次停干净且说真话', () => {
  it('有动作在跑：当场释放通道，且立刻能起新动作', async () => {
    const b = makeBoundary();
    await b.runner.run('followPlayer', { player_name: 'bobo', follow_dist: 3 });
    await b.started;
    expect(b.scheduler.currentAction()?.id).toBe('followPlayer');

    const stop = b.scheduler.stopAll();
    expect(stop.hadAction).toBe(true);
    expect(stop.actionId).toBe('followPlayer');
    expect(b.scheduler.currentAction()).toBeNull();

    // 不需要「再 Stop 一次」：马上就能起新动作
    const next = await b.runner.run('goToPlayer', { player_name: 'bobo', closeness: 2 });
    expect(next.status).toBe('accepted');
    expect(b.scheduler.currentAction()?.id).toBe('goToPlayer');
    b.release();
  });

  it('本来没在跑：如实回报 had_action=false', () => {
    const b = makeBoundary();
    expect(b.scheduler.stopAll()).toMatchObject({ hadAction: false, actionId: null });
  });
});

describe('B2：L4 打断在途回答，但**动作不受影响**', () => {
  it('abort 掐掉的是生成，不是身体', async () => {
    const b = makeBoundary();
    // 身体上有一个动作在跑
    await b.runner.run('followPlayer', { player_name: 'bobo', follow_dist: 3 });
    await b.started;
    expect(b.scheduler.currentAction()?.id).toBe('followPlayer');

    // 生成线：一个假 run，abort 把它掐掉
    let generationAlive = true;
    const intake = new EventIntake();
    intake.attach({
      submit: () => Promise.resolve(fakeSubmission()),
      abort: () => {
        generationAlive = false;
        return Promise.resolve();
      },
      rescue: () => Promise.resolve(),
    });

    intake.notify({ level: LEVEL.PREEMPT as never, text: '换个目标' });
    await intake.settle();

    // 回答被掐掉、事件重新提交（生成线重开）
    expect(generationAlive).toBe(false);
    // 但身体照跑——这正是以前被写反过的地方（一被打断就去 Stop）
    expect(b.scheduler.currentAction()?.id).toBe('followPlayer');
    b.release();
  });
});

describe('动作跑完以 L3 事件回来（E 段的闭环）', () => {
  it('完成时上报结果并释放通道', async () => {
    const b = makeBoundary();
    await b.runner.run('followPlayer', { player_name: 'bobo', follow_dist: 3 });
    await b.started;

    b.release();
    await until(() => b.notified.length > 0);

    expect(b.notified[0]?.call).toBe('followPlayer');
    expect(b.notified[0]?.result.status).toBe('completed');
    // 通道释放了，下一个动作能起
    expect(b.scheduler.currentAction()).toBeNull();
  });

  it('Stop 之后在途动作的完成回调**认得自己已过期**：不记账，但**要报一条**', async () => {
    const b = makeBoundary();
    await b.runner.run('followPlayer', { player_name: 'bobo', follow_dist: 3 });
    await b.started;

    b.scheduler.stopAll();
    b.release();
    await until(() => b.notified.length > 0);

    // 不记账：这次的结果不作数
    expect(b.records.some((line) => line.includes('跟随中'))).toBe(false);
    // 但必须给模型一个交代。动作没了、通道空了却毫无音讯，模型只能反复拍快照猜
    // ——它反馈过这件事（"viewChest / goToSurface 调用后再无音讯"）。
    expect(b.notified).toHaveLength(1);
    expect(b.notified[0]?.call).toBe('followPlayer');
    expect(String((b.notified[0]?.result as { data?: unknown }).data)).toContain('被中断');
  });
});
