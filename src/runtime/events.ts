/**
 * 事件接入层：L1–L5 → pi-durable 原生原语。
 *
 * 这**不是**一个独立子系统，就是"打断消息队列"——和普通 Agent 的引导/排队/ESC
 * 是同一件事。
 *
 * ## 统一的第一步：所有事件在发生的一瞬间都进"下一次要发的内容"
 *
 * 只有一个缓冲区 `pending`，它是**下一次请求将要发送的完整内容**。任何级别的事件
 * 一到就追加进去，不分彼此。差别**只在之后**：
 *
 * | 级别 | 之后做什么 |
 * |---|---|
 * | L1/L2 | 到此为止。搭下一次请求的车，**不额外唤醒** |
 * | L3 | 标记"需要请求" |
 * | L4 | 立刻 `abort()`，然后把这一整批发出去 |
 * | L5 | 立刻 `abort()` → 保命反射 → 把这一整批发出去 |
 *
 * ## 为什么这么写：整流
 *
 * 原来每个 L3 都 `submit` 一次。实测（faux provider，5 条 steer）：**5 次 API
 * 调用**，请求内容还一层层累积（第 5 次带上 L3-1..4）——每条事件都把模型多唤醒
 * 一次。真机上那场骷髅战掉 8 次血，就是 8 次完整请求。
 *
 * 现在：**一次请求在飞的时候什么都不发**（模型本来就不能反应，攒着零成本）；
 * 请求结束才检查"需要请求"标志，把整批一次带走。所以"5 秒的不可打断请求里产生
 * 99999 个 L3"也只是一次请求——这就是天然整流。
 *
 * 附带好处：`pending` 是**还没提交**的，`abort()` 撤不到它。真机上死亡消息就是
 * 因为走了 L4 的 `abort()` 被卷走的（19 秒后才落地，最后彻底没了）。
 *
 * ## L4/L5 的优先级
 *
 * `urgent` 队列专门装 L4/L5，泵每取下一个都先看它。原来是一条 FIFO promise 链，
 * 等级只决定**做什么**、不决定**什么时候做**——"打断立刻插入"根本没实现，死亡
 * 事件排在 30 条 L3 后面干等了 19 秒。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import type { Submission } from '@earendil-works/pi-durable';
import { LEVEL, type Level } from '../agent/scheduler.js';

/** 一个游戏事件：级别 + 已渲染成模型能读的文本。 */
export interface GameEvent {
  level: Level;
  /** 给模型看的文本（`## 事件` 那套标题由调用方渲染）。 */
  text: string;
}

/** 这一层对运行时的最小依赖，便于单测注入假实现。 */
export interface EventIntakeDeps {
  /** 把攒下的一整批内容作为一次引导提交。 */
  submit: (text: string, whenBusy: 'steer') => Promise<Submission>;
  /** L4/L5 的中断。 */
  abort: () => Promise<void>;
  /** L5 的保命反射，绕过模型。 */
  rescue: () => Promise<void>;
  /** 观测钩子：每个事件实际落到了哪个动作。 */
  onEvent?: (event: GameEvent, action: 'write' | 'steer' | 'preempt' | 'emergency') => void;
  onError?: (error: unknown) => void;
}

/** 一批事件的正文：一条一行，空行分隔，模型能读。 */
function batchText(batch: readonly GameEvent[]): string {
  return batch.map((event) => event.text).join('\n\n');
}

export class EventIntake {
  private deps: EventIntakeDeps | null;
  private readonly context: Context;
  /** 优先通道：L4/L5。泵每次取下一个都先看它。 */
  private urgent: GameEvent[] = [];
  /** 普通通道：L1–L3，先进先出。 */
  private normal: GameEvent[] = [];
  /** 正在排空的泵；null = 空闲。 */
  private pump: Promise<void> | null = null;
  /** **下一次请求将要发送的完整内容**。任何级别的事件都立刻进这里。 */
  private pending: GameEvent[] = [];
  /** 有 L3 攒着 = 该主动发一次；只有 L1/L2 就搭下一次请求的车。 */
  private needsRequest = false;
  /** 有一次 provider 请求正在飞：这期间不发，攒着。 */
  private requestInFlight = false;
  /** 已经提交、还没落定的那一批——`abort()` 会撤回它，所以中断时要退回缓冲区。 */
  private inFlight: GameEvent[] | null = null;
  /** 运行时还没接上时收到的事件，按顺序暂存。 */
  private waiting: GameEvent[] = [];

  constructor(deps?: EventIntakeDeps, context: Context = BACKGROUND_CONTEXT) {
    this.deps = deps ?? null;
    this.context = context;
  }

  /**
   * 接上运行时，并把等待中的事件**按顺序**补投，一个都不丢。
   *
   * 为什么需要这个阶段：SQLite 打开要几毫秒，而 `edges` 的轮询和
   * `bot.on(...)` 在连接建立后**立刻**就开始产生事件了。没有这个缓冲，
   * 连接后到就绪之间的事件会真丢——而"丢一个事件就是丢一份工作"。
   */
  attach(deps: EventIntakeDeps): void {
    if (this.deps != null) throw new Error('EventIntake 已经接上运行时，不能重复接');
    this.deps = deps;
    const queued = this.waiting;
    this.waiting = [];
    for (const event of queued) this.notify(event);
  }

  /** 运行时是否已接上。 */
  get attached(): boolean {
    return this.deps != null;
  }

  /** 还没接上运行时、正在等待的事件数。 */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /** 攒着还没发出去的内容条数（诊断用）。 */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** 已提交但**尚未落定**的那一批——`abort()` 会撤回它。 */
  get outstandingEvents(): readonly GameEvent[] {
    return this.inFlight ?? [];
  }

  /**
   * 一次 provider 请求开始了：这期间只攒不发。
   *
   * 模型正在生成，它**本来就不能反应**新事件——攒着零成本。等这次请求结束
   * （`requestFinished`）再一次性带走。
   */
  requestStarted(): void {
    this.requestInFlight = true;
  }

  /**
   * 一次 provider 请求结束了：检查"需要请求"标志。
   *
   * 有 L3 攒着就把整批一次发出去；只有 L1/L2 就什么都不做——它们搭下一次
   * 请求的车（这是 L2 与 L3 唯一的区别）。
   */
  requestFinished(): void {
    this.requestInFlight = false;
    const deps = this.deps;
    if (deps == null || !this.needsRequest) return;
    void this.start(deps);
  }

  /** 收一个事件：**同步返回**（旧调度协议是同步的），异步动作排在队列上。 */
  notify(event: GameEvent): void {
    const deps = this.deps;
    if (deps == null) {
      // 运行时就绪前：暂存，接上后按顺序补投。
      this.waiting.push(event);
      return;
    }
    // 按等级分流。L4/L5 走优先通道——这就是"打断立刻插入"的实现。
    if (event.level >= LEVEL.PREEMPT) this.urgent.push(event);
    else this.normal.push(event);
    void this.start(deps);
  }

  /**
   * 起泵（已经在跑就什么都不做）。
   *
   * **推到微任务里起**：`notify` 必须同步返回、且同步阶段不产生任何副作用——
   * 它是在 `bot.on('chat')` / 轮询回调里被就地调用的，当场干活会重入。
   *
   * 清 `pump` 这一步**必须与"判空"同步**（中间不能有 await）：否则中间进来的
   * 事件会看到 `pump` 还在、把自己留在队列里没人取。
   */
  private start(deps: EventIntakeDeps): Promise<void> {
    if (this.pump == null) {
      this.pump = Promise.resolve().then(async () => {
        await this.drain(deps);
        this.pump = null;
      });
    }
    return this.pump;
  }

  /** 排空两个队列；每一步都重新取，所以优先通道永远插得进来。 */
  private async drain(deps: EventIntakeDeps): Promise<void> {
    for (;;) {
      const event = this.urgent.shift() ?? this.normal.shift();
      if (event === undefined) break;
      try {
        await this.react(event, deps);
      } catch (error: unknown) {
        // 一条事件处理失败不该让整个泵停摆——后面还有几十条在排队。
        deps.onError?.(error);
      }
    }
    // 队列空了：按规则把攒下的内容发出去（L4/L5 在 interrupt 里已经强制发过，
    // 那时 pending 已空，这里是空操作）。
    try {
      await this.flush(deps);
    } catch (error: unknown) {
      deps.onError?.(error);
    }
  }

  /**
   * 等已排队的动作落定。
   *
   * 循环 await：处理过程中会不断入队（一次 interrupt 之后要重新提交被撤回的
   * 事件，那又是新的入队）。只 await 一次会漏掉后追加的。
   */
  async settle(): Promise<void> {
    while (this.pump != null) await this.pump;
  }

  private async react(event: GameEvent, deps: EventIntakeDeps): Promise<void> {
    // **统一的第一步**：任何级别的事件都在这一瞬间进入"下一次要发的内容"。
    this.pending.push(event);

    if (event.level <= LEVEL.STATE) {
      // L1/L2：到此为止。搭下一次请求的车，不额外唤醒。
      deps.onEvent?.(event, 'write');
      return;
    }
    if (event.level === LEVEL.WAKE) {
      // L3：标记"需要请求"。真正发出去要等这次请求结束（整流）。
      this.needsRequest = true;
      deps.onEvent?.(event, 'steer');
      return;
    }
    if (event.level === LEVEL.PREEMPT) {
      // L4：立刻打断，然后把整批发出去（插队）。
      await this.abortAndWithdraw(deps);
      await this.flush(deps, true);
      deps.onEvent?.(event, 'preempt');
      return;
    }
    // L5：冻住 → 保命 → 接着干。
    // **保命在前、提交在后**：保命要跑好几秒，先提交的话模型会在这几秒里
    // 对着一份过时的世界做判断。
    await this.abortAndWithdraw(deps);
    await deps.rescue();
    await this.flush(deps, true);
    deps.onEvent?.(event, 'emergency');
  }

  /**
   * 把攒下的内容一次性发出去。
   *
   * @param force 中断路径用：请求在飞也要发（那是"打断立刻插入"）。
   *
   * 不 force 时只认 `needsRequest`——只有 L1/L2 攒着的话什么都不做，让它们搭
   * 下一次请求的车。
   *
   * **调用方保证 `pending` 非空**，所以这里不写"空批次"守卫（那是够不到的分支）：
   * `needsRequest` 为真时缓冲区必然有事件（两者在 `react` 里一起成立、在
   * `flush` 里一起清掉）；强制路径刚把当前事件推进去。
   */
  private async flush(deps: EventIntakeDeps, force = false): Promise<void> {
    if (!force && (this.requestInFlight || !this.needsRequest)) return;
    const batch = this.pending;
    this.pending = [];
    this.needsRequest = false;
    this.inFlight = batch;
    let submission: Submission;
    try {
      submission = await deps.submit(batchText(batch), 'steer');
    } catch (error: unknown) {
      // 提交失败：把这一批**放回缓冲区**，别让事件凭空消失（下次 flush 会重试）。
      this.inFlight = null;
      this.pending.unshift(...batch);
      throw error;
    }
    const clear = (): void => {
      if (this.inFlight === batch) this.inFlight = null;
    };
    void submission.wait(this.context).then(clear, clear);
  }

  /**
   * 中断：撤回在途那一批 + `abort()`。
   *
   * `abort()` 会**撤回排队中的输入**，所以先把在途那一批**退回缓冲区**——不然
   * 它连同被 abort 的那一轮一起丢（真机上死亡消息就是这么没的）。退回去之后
   * 由调用方决定什么时候重发（L4 立刻发；L5 等保命跑完再发）。
   */
  private async abortAndWithdraw(deps: EventIntakeDeps): Promise<void> {
    const withdrawn = this.inFlight;
    if (withdrawn != null) {
      this.inFlight = null;
      this.pending.unshift(...withdrawn);
    }
    await deps.abort();
  }
}
