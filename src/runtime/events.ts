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
  private readonly deps: EventIntakeDeps;
  private readonly context: Context;
  /** 串行化异步动作，保证 abort 与 submit 的相对顺序。 */
  private chain: Promise<void> = Promise.resolve();
  /** 已提交但**尚未落定**的输入——abort 会撤回它们。write 不进这里。 */
  private outstanding: Array<{ event: GameEvent; submission: Submission }> = [];

  constructor(deps: EventIntakeDeps, context: Context = BACKGROUND_CONTEXT) {
    this.deps = deps;
    this.context = context;
  }

  /** 收一个事件：**同步返回**（旧调度协议是同步的），异步动作排在链上。 */
  notify(event: GameEvent): void {
    this.chain = this.chain
      .then(() => this.react(event))
      .catch((error: unknown) => this.deps.onError?.(error));
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

  private async react(event: GameEvent): Promise<void> {
    if (event.level <= LEVEL.STATE) {
      // L1/L2：只记账。**不 track**——`abort()` 明确"queued writes stay"，
      // 被动写入不会被撤回，不需要重新提交。
      await this.deps.write(event);
      this.deps.onEvent?.(event, 'write');
      return;
    }
    if (event.level === LEVEL.WAKE) {
      await this.steer(event);
      this.deps.onEvent?.(event, 'steer');
      return;
    }
    if (event.level === LEVEL.PREEMPT) {
      await this.interrupt(event);
      this.deps.onEvent?.(event, 'preempt');
      return;
    }
    // L5：冻住 → 保命 → 接着干。
    // 紧急事件本身由反射消化，**不再喂给模型**（旧实现的 pushEvent 也把它
    // 标成 consumed，免得锁解除后它再唤醒一次请求）。
    await this.interrupt(null);
    await this.deps.rescue();
    this.deps.onEvent?.(event, 'emergency');
  }

  private async steer(event: GameEvent): Promise<void> {
    const submission = await this.deps.submit(event.text, 'steer');
    this.track(event, submission);
  }

  /**
   * 中断当前工作。
   *
   * `alsoSubmit` 是"中断完要立刻发过去"的事件（L4 用它；L5 传 null）。
   * 被撤回的排队事件**先于**它重新提交，保持时间顺序。
   */
  private async interrupt(alsoSubmit: GameEvent | null): Promise<void> {
    const withdrawn = this.outstanding.map((item) => item.event);
    this.outstanding = [];
    await this.deps.abort();
    for (const pending of withdrawn) await this.steer(pending);
    if (alsoSubmit != null) await this.steer(alsoSubmit);
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
