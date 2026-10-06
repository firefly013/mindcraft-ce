/**
 * 事件接入层：L1–L5 → pi-durable 原生原语。
 *
 * 这**不是**一个独立子系统，就是"打断消息队列"——和普通 Agent 的引导/排队/ESC
 * 是同一件事：
 *
 * | 级别 | 普通 Agent 里的对应物 | 落点 |
 * |---|---|---|
 * | L1/L2 | 记一笔，不打断 | `write`（被动 entry，不唤醒模型） |
 * | L3 | 引导：下一次 API 请求带上 | `submit({whenBusy:'steer'})` |
 * | L4 | 双击 ESC：停掉当前回答再发 | `abort()` → `submit()` |
 * | L5 | 冻住 → 保命 → 接着干 | `abort()` → `rescue()` → 重新提交 |
 *
 * ## 唯一需要自己写的那点"队列"
 *
 * `abort()` 会**撤回排队中的输入**（而**排队中的 write 会留下**）。旧实现靠
 * `unsee()` 把事件退回、让新请求重新带上；这里必须自己缓冲一份，abort 之后
 * 重新提交，否则 L3 排队中的事件会被 L4/L5 悄悄吃掉。
 *
 * 之所以要缓冲，是因为 pi-durable 不知道"这个输入是从哪个事件来的"——它只认
 * 输入。所以这一层是薄薄一层账，不是另一套调度器。
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
  /** L3/L4 的输入提交（引导）。 */
  submit: (text: string, whenBusy: 'steer') => Promise<Submission>;
  /** L1/L2 的被动写入：不唤醒模型，但会出现在下一次请求的上下文里。 */
  write: (event: GameEvent) => Promise<Submission>;
  /** L4/L5 的中断。 */
  abort: () => Promise<void>;
  /** L5 的保命反射，绕过模型。 */
  rescue: () => Promise<void>;
  /** 观测钩子：每个事件实际落到了哪个动作。 */
  onEvent?: (event: GameEvent, action: 'write' | 'steer' | 'preempt' | 'emergency') => void;
  onError?: (error: unknown) => void;
}

export class EventIntake {
  private deps: EventIntakeDeps | null;
  private readonly context: Context;
  /** 串行化异步动作，保证 abort 与 submit 的相对顺序。 */
  private chain: Promise<void> = Promise.resolve();
  /** 已提交但**尚未落定**的输入——abort 会撤回它们。write 不进这里。 */
  private outstanding: Array<{ event: GameEvent; submission: Submission }> = [];
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

  /** 收一个事件：**同步返回**（旧调度协议是同步的），异步动作排在链上。 */
  notify(event: GameEvent): void {
    const deps = this.deps;
    if (deps == null) {
      // 运行时就绪前：暂存，接上后按顺序补投。
      this.waiting.push(event);
      return;
    }
    // 把非空的 `deps` **捕获进闭包**：链上每个步骤都拿得到它，于是
    // react/steer/interrupt 里不需要再写一层够不到的 `deps == null` 判断。
    this.chain = this.chain
      .then(() => this.react(event, deps))
      .catch((error: unknown) => deps.onError?.(error));
  }

  /**
   * 等已排队的动作落定。
   *
   * 必须**循环**：链会在动作执行过程中被替换（一次 interrupt 之后要重新提交
   * 被撤回的事件，那会往链上追加工作）。只 await 一次会漏掉后追加的。
   */
  async settle(): Promise<void> {
    let previous: Promise<void> | null = null;
    while (previous !== this.chain) {
      previous = this.chain;
      await previous;
    }
  }

  /** 尚未落定的输入事件（abort 撤回后需要重新提交的那些）。 */
  get outstandingEvents(): readonly GameEvent[] {
    return this.outstanding.map((item) => item.event);
  }

  private async react(event: GameEvent, deps: EventIntakeDeps): Promise<void> {
    if (event.level <= LEVEL.STATE) {
      // L1/L2：只记账。**不 track**——`abort()` 明确"queued writes stay"，
      // 被动写入不会被撤回，不需要重新提交。
      await deps.write(event);
      deps.onEvent?.(event, 'write');
      return;
    }
    if (event.level === LEVEL.WAKE) {
      await this.steer(event, deps);
      deps.onEvent?.(event, 'steer');
      return;
    }
    if (event.level === LEVEL.PREEMPT) {
      await this.interrupt(event, deps);
      deps.onEvent?.(event, 'preempt');
      return;
    }
    // L5：冻住 → 保命 → 接着干。
    // 紧急事件本身由反射消化，**不再喂给模型**（旧实现的 pushEvent 也把它
    // 标成 consumed，免得锁解除后它再唤醒一次请求）。
    await this.interrupt(null, deps);
    await deps.rescue();
    deps.onEvent?.(event, 'emergency');
  }

  private async steer(event: GameEvent, deps: EventIntakeDeps): Promise<void> {
    const submission = await deps.submit(event.text, 'steer');
    this.track(event, submission);
  }

  /**
   * 中断当前工作。
   *
   * `alsoSubmit` 是"中断完要立刻发过去"的事件（L4 用它；L5 传 null）。
   * 被撤回的排队事件**先于**它重新提交，保持时间顺序。
   */
  private async interrupt(alsoSubmit: GameEvent | null, deps: EventIntakeDeps): Promise<void> {
    const withdrawn = this.outstanding.map((item) => item.event);
    this.outstanding = [];
    await deps.abort();
    for (const pending of withdrawn) await this.steer(pending, deps);
    if (alsoSubmit != null) await this.steer(alsoSubmit, deps);
  }

  private track(event: GameEvent, submission: Submission): void {
    const record = { event, submission };
    this.outstanding.push(record);
    const forget = (): void => {
      this.outstanding = this.outstanding.filter((item) => item !== record);
    };
    void submission.wait(this.context).then(forget, forget);
  }
}
