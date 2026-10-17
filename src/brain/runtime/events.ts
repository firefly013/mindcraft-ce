/**
 * 事件接入层：**事件 → 处理，一一对应**。
 *
 * ## 三条规则（改之前先读）
 *
 * 1. **一切皆事件。**世界发生了什么、身体做了什么、模型做了什么、工具跑完
 *    什么——全都是事件。**轮询、定时器、直接调用都不许用来"制造"事件**：
 *    轮询会在世界没有任何变化的时候声称"发生了"，那是伪造一个发生。
 * 2. **每个事件都有处理，一个不多一个不少。**处理由**事件类型**决定
 *    （`handlers.ts`）；等级只是事件的属性，回答"这条事件要用多大力气把模型
 *    叫来看一眼"，**它不决定谁来处理**。
 * 3. **事件和处理都进上下文，每个恰好一次。**模型必须知道所有东西——包括
 *    别人替它做了什么。所以投递只有两条路：`write`（记录，不唤醒）和
 *    `submit`（记录并唤醒）。
 *
 * ## 投递矩阵
 *
 * | 等级 | 投递 |
 * |---|---|
 * | 1 | **保留空位，非法**：收到就是协议错误，见 `isValidEventLevel` |
 * | 2 STATE | `write`：写进上下文（durable），不唤醒，搭下一次请求的车 |
 * | 3 WAKE | `submit`：空闲立刻起一轮，忙就整流到本轮结束 |
 * | 4 PREEMPT | `abort` → 连同被撤回的那批一起重新 `submit` |
 * | 5 EMERGENCY | `abort` → 锁动作通道 → `submit`；身体侧处理跑完发 `completes` 解锁 |
 *
 * ## 为什么只有这里能改队列
 *
 * 旧实现按**等级**统一派发（≤2 记账 / 3 steer / 4 abort+submit / 5 abort+保命），
 * 于是所有 L5 事件共用同一个处理，处理器进去以后再自己看一遍世界猜该干嘛。
 * 那是"处理被按等级归并"，事件类型的信息在到达处理的那一刻就丢了。
 * 现在等级只决定投递，处理由类型查表。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import type { Submission } from '@earendil-works/pi-durable';
import { isValidEventLevel, LEVEL, type Kind, type Level } from '../../shared/events.js';
import type { EventHandler, HandlerLookup, HandlingContext } from './handlers.js';

/**
 * 一条事件。
 *
 * `type` 是**处理的匹配键**，也是两侧唯一的共同词汇（身体侧的检测器 type
 * 与这里逐字一致）。
 */
export interface GameEvent {
  /** 事件类型，如 `world.water.drowning`。 */
  type: string;
  /** 事件类别（User/World/Tool/Model）。 */
  kind: Kind;
  /** 事件的属性：要用多大力气把模型叫来看一眼。**不决定谁来处理**。 */
  level: Level;
  /** 原始载荷。不许改写结构化信息（坐标、数量），模型要靠它们判断。 */
  payload: unknown;
  /** 给模型看的文本。身体能渲染就带过来，不能（Java）就由大脑渲。 */
  text: string;
  /** 发生时刻（毫秒）。 */
  ts: number;
  /**
   * 这条事件**已经由哪个身体侧处理接手**（身体自己声明；没有就是 null）。
   *
   * 身体是唯一知道"我为这条事件启动了哪个反射"的地方，所以由它声明，
   * 大脑不维护第二份名单。
   */
  reflex?: string | null;
  /** 这条事件是哪个处理的**完成报告**（挂在 `reflex` 上，负责解锁配对）。 */
  completes?: string | null;
}

/** 事件实际落到了哪里。 */
export type EventAction = 'written' | 'steer' | 'preempt' | 'emergency' | 'reflex';

/** 这一层对运行时的最小依赖，便于单测注入假实现。 */
export interface EventIntakeDeps {
  /** 记录并唤醒：把攒下的一整批作为一次引导提交。 */
  submit: (text: string, whenBusy: 'steer') => Promise<Submission>;
  /** 只记录、不唤醒（L2）。一次可以带多条（同一拍里攒下的）。 */
  write: (events: readonly GameEvent[], text: string) => Promise<void>;
  /** L4/L5 的中断。 */
  abort: () => Promise<void>;
  /** 事件类型 → 处理。查不到 = 交给模型。 */
  lookup?: HandlerLookup;
  /** 动作通道锁：L5 进来时锁，最后一个处理报告完成时解锁。 */
  beginEmergency?: () => void;
  endEmergency?: () => void;
  /** 观测钩子：每个事件实际落到了哪个动作。 */
  onEvent?: (event: GameEvent, action: EventAction) => void;
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
  /** 普通通道：L3。先进先出。 */
  private normal: GameEvent[] = [];
  /** 正在排空的泵；null = 空闲。 */
  private pump: Promise<void> | null = null;
  /** **要被提交（唤醒）的一批**：L3+。 */
  private pending: GameEvent[] = [];
  /** **要被写进上下文（不唤醒）的一批**：L2。 */
  private pendingWrites: GameEvent[] = [];
  /** 有 L3 攒着 = 该主动发一次。 */
  private needsRequest = false;
  /** 有一次 provider 请求正在飞：这期间 L3 不发，攒着（整流）。 */
  private requestInFlight = false;
  /** 已经提交、还没落定的那一批——`abort()` 会撤回它，所以中断时要退回。 */
  private inFlight: GameEvent[] | null = null;
  /** 运行时还没接上时收到的事件，按顺序暂存。 */
  private waiting: GameEvent[] = [];
  /** 还没报告完成的反射（按名字计数）。全空时解锁动作通道。 */
  private outstandingReflexes = new Map<string, number>();
  /**
   * 锁是不是**我们**上的。
   *
   * 反射分两类：L5 那种要锁通道的（身体在逃命，模型别插动作），和
   * L2 那种不锁的（走过去捡个东西）。完成报告对两者长得一样，所以解锁必须
   * 认自己上过的锁——否则一条普通反射的完成报告会去解一把不存在的锁。
   */
  private emergencyLocked = false;

  constructor(deps?: EventIntakeDeps, context: Context = BACKGROUND_CONTEXT) {
    this.deps = deps ?? null;
    this.context = context;
  }

  /**
   * 接上运行时，并把等待中的事件**按顺序**补投，一个都不丢。
   *
   * 为什么需要这个阶段：SQLite 打开要几毫秒，而边沿检测和 `bot.on(...)` 在
   * 连接建立后**立刻**就开始产生事件了。没有这个缓冲，连接后到就绪之间的事件
   * 会真丢——而"丢一个事件就是丢一份工作"。
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

  /** 攒着还没投出去的事件条数（诊断用）。 */
  get pendingCount(): number {
    return this.pending.length + this.pendingWrites.length;
  }

  /** 已提交但**尚未落定**的那一批——`abort()` 会撤回它。 */
  get outstandingEvents(): readonly GameEvent[] {
    return this.inFlight ?? [];
  }

  /** 还没报告完成的反射名（诊断用）。 */
  get runningReflexes(): readonly string[] {
    return [...this.outstandingReflexes.keys()];
  }

  /**
   * 一次 provider 请求开始了：这期间 L3 只攒不发。
   *
   * 模型正在生成，它**本来就不能反应**新事件——攒着零成本。等这次请求结束
   * （`requestFinished`）再一次性带走。
   */
  requestStarted(): void {
    this.requestInFlight = true;
  }

  /** 一次 provider 请求结束了：有 L3 攒着就把整批一次发出去。 */
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
    // **等级 1 是保留空位**：任何一条 1 都是协议错误，不是"更弱的记账档"。
    // 这里不 throw（notify 是在 socket / bot 回调里就地调的，抛出去会变成
    // 未捕获异常），但绝不静默收下——记一笔错，然后丢掉。
    if (!isValidEventLevel(event.level)) {
      deps.onError?.(new RangeError(`非法事件等级 ${String(event.level)}（1 是保留空位，不许使用）：${event.type}`));
      return;
    }
    // 完成报告先结算配对：解锁要发生在它自己被投递之前。
    if (event.completes != null) this.finishReflex(deps, event.completes);
    // 按等级分流。L4/L5 走优先通道——这就是"打断立刻插入"的实现。
    if (event.level >= LEVEL.PREEMPT) this.urgent.push(event);
    else this.normal.push(event);
    void this.start(deps);
  }

  /**
   * 起泵（已经在跑就什么都不做）。
   *
   * **推到微任务里起**：`notify` 必须同步返回、且同步阶段不产生任何副作用——
   * 它是在 socket 消息回调里被就地调用的，当场干活会重入。
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
    // 记录（不唤醒）的一批一次写完：同一拍里攒下的合并成一条 entry。
    try {
      await this.flushWrites(deps);
    } catch (error: unknown) {
      deps.onError?.(error);
    }
    // 唤醒的一批：按等级规则决定发不发。
    try {
      await this.flush(deps);
    } catch (error: unknown) {
      deps.onError?.(error);
    }
  }

  /**
   * 等已排队的动作落定。
   *
   * **不含反射**：反射是长生命周期的（走到掉落物那儿可能好几秒），等它会
   * 把"排空队列"变成"等一次动作跑完"。反射的完成由它自己发事件报告。
   */
  async settle(): Promise<void> {
    while (this.pump != null) await this.pump;
  }

  /** 一条事件的处理。 */
  private async react(event: GameEvent, deps: EventIntakeDeps): Promise<void> {
    const handler: EventHandler | undefined = deps.lookup?.(event.type);

    // 反射：**立刻执行，但不等它**（它可能跑好几秒，不能堵住后面的事件）。
    if (handler?.executor === 'reflex') {
      deps.onEvent?.(event, 'reflex');
      this.runReflex(handler, event, deps);
      return;
    }

    // 模型处理：等级决定投递力度。
    if (event.level === LEVEL.STATE) {
      // 只记录：立刻进上下文，但不唤醒。
      this.pendingWrites.push(event);
      deps.onEvent?.(event, 'written');
      return;
    }

    // L3+：进提交批。事件与处理都会因此进上下文（提交本身就是一条 user entry）。
    this.pending.push(event);
    // L5 且身体声明了处理 → 锁住动作通道，等它报告完成。
    if (event.level === LEVEL.EMERGENCY && event.reflex != null) this.beginReflex(deps, event.reflex);

    if (event.level === LEVEL.WAKE) {
      this.needsRequest = true;
      deps.onEvent?.(event, 'steer');
      return;
    }
    if (event.level === LEVEL.PREEMPT) {
      await this.abortAndWithdraw(deps);
      await this.flush(deps, true);
      deps.onEvent?.(event, 'preempt');
      return;
    }
    // LEVEL.EMERGENCY：中断 → 提交换取注意力。**保命不在这里做**——那是
    // 身体侧节点的处理，它自己跑、自己报告结果。这里只负责让模型看见。
    await this.abortAndWithdraw(deps);
    await this.flush(deps, true);
    deps.onEvent?.(event, 'emergency');
  }

  /** 起一个反射处理（不 await）：完成由它自己 `emit()` 一条 `completes` 事件。 */
  private runReflex(handler: EventHandler, event: GameEvent, deps: EventIntakeDeps): void {
    if (handler.run == null) {
      deps.onError?.(new Error(`反射处理没有执行体：${event.type}`));
      return;
    }
    const ctx: HandlingContext = { emit: (emitted: GameEvent): void => this.notify(emitted) };
    void handler.run(event, ctx).catch((error: unknown) => {
      deps.onError?.(error);
    });
  }

  /** 一个反射开始了：第一次上锁时锁动作通道。 */
  private beginReflex(deps: EventIntakeDeps, name: string): void {
    this.outstandingReflexes.set(name, (this.outstandingReflexes.get(name) ?? 0) + 1);
    if (!this.emergencyLocked) {
      this.emergencyLocked = true;
      deps.beginEmergency?.();
    }
  }

  /** 一个反射报告完成：全空时解锁——**只解自己上过的那把**。 */
  private finishReflex(deps: EventIntakeDeps, name: string): void {
    const count = this.outstandingReflexes.get(name) ?? 0;
    if (count <= 1) this.outstandingReflexes.delete(name);
    else this.outstandingReflexes.set(name, count - 1);
    if (this.outstandingReflexes.size === 0 && this.emergencyLocked) {
      this.emergencyLocked = false;
      deps.endEmergency?.();
    }
  }

  /**
   * 把记录（不唤醒）的一批一次性写进上下文。
   *
   * **必须落成 durable entry**：旧实现把它们放在内存缓冲区里等"顺风车"，
   * 于是没有下一次唤醒时它们永远不进上下文、重启即丢——而事件在发生的那一刻
   * 就该进上下文。
   */
  private async flushWrites(deps: EventIntakeDeps): Promise<void> {
    if (this.pendingWrites.length === 0) return;
    const batch = this.pendingWrites;
    this.pendingWrites = [];
    try {
      await deps.write(batch, batchText(batch));
    } catch (error: unknown) {
      // 写不进去就退回队列，别让事件凭空消失（下次 flush 重试）。
      this.pendingWrites.unshift(...batch);
      throw error;
    }
  }

  /**
   * 把要唤醒模型的一批一次性提交出去。
   *
   * @param force 中断路径用：请求在飞也要发（那是"打断立刻插入"）。
   *
   * 不 force 时只认 `needsRequest`——没有 L3 攒着就什么都不做。
   * **调用方保证 `pending` 非空**：`needsRequest` 为真时缓冲区必然有事件。
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
   * 由调用方决定什么时候重发。
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
