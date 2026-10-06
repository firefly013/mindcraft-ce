/**
 * P6：抢占桥 —— 冻结的反射层（同步 Verdict 协议）↔ pi-durable（异步会话）。
 *
 * ## 为什么需要这一层
 *
 * `Scheduler.pushEvent()` 是**同步**的，返回 `PushVerdict`；pi-durable 的
 * `submit()` / `abort()` 是**异步**的。旧循环靠同步返回值 + 一个
 * `requestId` 比对来作废在途响应（`loop.ts:142`），新世界必须把这个协议
 * 翻译成「同步判定 → 异步动作」，且**不能让异步动作阻塞判定**。
 *
 * ## 语义映射（逐条对照旧实现）
 *
 * | verdict | 旧行为 | 新行为 |
 * |---|---|---|
 * | `stored`（L1/L2 或 emergency 锁定） | 只记账 | 什么都不做 |
 * | `start`（L3 空闲 / L4 空闲） | 开一次请求 | `startRun()` |
 * | `queued`（L3 忙） | 搭下一次请求的车 | **什么都不做**——在途 run 结束时
 *   `finishRequest()` 会因存在未见的 L3+ 事件而回 `start`，由那条路径续跑 |
 * | `preempt`（L4 忙） | 作废在途响应、带事件重开 | `abortRun()` → `startRun()` |
 * | `emergency`（L5） | 作废 + 停动作 + 锁通道 | `abortRun()` → `onEmergency()`
 *   （**不**开 run：紧急反射全程绕过模型） |
 *
 * ## 作废在途响应的落点
 *
 * 旧实现比对 `describe().currentRequestId !== begun.requestId`。这里等价物是
 * `current.requestId !== requestId`：被抢占的那一轮结束时不会再去
 * `finishRequest`，于是既不会续跑、也不会污染新一轮的分发状态。
 * （即使时序错开让 `finishRequest(旧 id)` 真的被调到，`pushEvent(preempt)`
 * 已把 `currentRequestId` 清零，它只会得到 `stale`——双保险。）
 */
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { BeginVerdict, EventPayload, PushVerdict, Scheduler } from '../agent/scheduler.js';

/** 一轮运行的句柄：`settled` 在这轮结束时落定。 */
export interface RunHandle {
  settled: Promise<void>;
}

export interface PreemptionBridgeDeps {
  scheduler: Scheduler;
  /**
   * 开一轮。收到的是 `beginRequest()` 收集到的**未见事件**——调用方负责把它们
   * 渲染进尾巴（`composeLiveTail`）再提交。
   */
  startRun: (events: BeginVerdict['events'], context: Context) => Promise<RunHandle>;
  /** 中断在途的一轮（L4/L5）。 */
  abortRun: (context: Context) => Promise<void>;
  /** L5：紧急反射接管，绕过模型。 */
  onEmergency: (context: Context) => Promise<void>;
  /** 测试/关停用：收到未处理错误时的回调。 */
  onError?: (error: unknown) => void;
}

export class PreemptionBridge {
  private readonly deps: PreemptionBridgeDeps;
  private readonly context: Context;
  /** 串行化异步动作，保证 abort 与 start 的相对顺序。 */
  private chain: Promise<void> = Promise.resolve();
  private current: { requestId: number } | null = null;
  private lastEvents: BeginVerdict['events'] = [];

  constructor(deps: PreemptionBridgeDeps, context: Context = BACKGROUND_CONTEXT) {
    this.deps = deps;
    this.context = context;
  }

  /** 最近一轮 `beginRequest()` 收集到的事件，供尾巴渲染。 */
  get currentEvents(): BeginVerdict['events'] {
    return this.lastEvents;
  }

  /** 现在是否有一轮在跑。 */
  get running(): boolean {
    return this.current != null;
  }

  /**
   * 收一个事件。**同步返回** verdict（与旧协议同形），异步动作排在链上。
   */
  notify(event: EventPayload): PushVerdict {
    const verdict = this.deps.scheduler.pushEvent(event);
    this.chain = this.chain.then(() => this.react(verdict)).catch((error: unknown) => {
      this.deps.onError?.(error);
    });
    return verdict;
  }

  /**
   * 等已排队的异步动作落定。
   *
   * 必须**循环**：链会在动作执行过程中把自身替换掉（一轮跑完发现还有未见的
   * L3+ 事件时，`onRunSettled` 会往链上追加下一轮）。只 await 一次会漏掉
   * 后追加的工作——那正是测试里最容易踩的陷阱。
   */
  async settle(): Promise<void> {
    let previous: Promise<void> | null = null;
    while (previous !== this.chain) {
      previous = this.chain;
      await previous;
    }
  }

  private async react(verdict: PushVerdict): Promise<void> {
    switch (verdict.decision) {
      case 'stored':
      case 'idle':
      case 'stale':
        return;
      case 'queued':
        // 搭车：在途 run 结束时 `finishRequest` 会回 `start`，那条路径续跑。
        return;
      case 'start':
        await this.startRun();
        return;
      case 'preempt':
        await this.deps.abortRun(this.context);
        await this.startRun();
        return;
      case 'emergency':
        await this.deps.abortRun(this.context);
        await this.deps.onEmergency(this.context);
        return;
    }
  }

  private async startRun(): Promise<void> {
    const begun = this.deps.scheduler.beginRequest();
    // `reused` = 调度器认为已有一轮在跑。此时不该再开一轮。
    if (begun.reused === true) return;

    this.lastEvents = begun.events;
    const handle = await this.deps.startRun(begun.events, this.context);
    this.current = { requestId: begun.requestId };

    // 刻意**不** await：抢占要能在这一轮还跑着的时候插进来。
    void handle.settled.then(
      () => this.onRunSettled(begun.requestId),
      (error: unknown) => {
        this.deps.onError?.(error);
        this.onRunSettled(begun.requestId);
      },
    );
  }

  private onRunSettled(requestId: number): void {
    // 被抢占的那一轮：不再是当前轮，什么都不改（等价于旧实现作废在途响应）。
    if (this.current?.requestId !== requestId) return;
    this.current = null;
    const finished = this.deps.scheduler.finishRequest(requestId);
    // 还有未见的 L3+ 事件 → 再来一轮（这就是 `queued` 搭车落地的地方）。
    if (finished.decision === 'start') {
      this.chain = this.chain.then(() => this.startRun()).catch((error: unknown) => {
        this.deps.onError?.(error);
      });
    }
  }
}
