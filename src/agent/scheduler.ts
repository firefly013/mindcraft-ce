/*
 * 事件调度器：决定哪个事件开启一次模型请求、哪个搭车、哪个抢占。
 *
 * 纯逻辑，无 I/O。Agent 有两条相互独立的线：
 *   - 推理线：一次模型请求是否正在进行（apiBusy）；
 *   - 动作线：同一时刻最多一个占用的身体动作（ActionManager 串行执行）。
 * 本类是到达事件与这两条线之间的裁判。
 *
 * Levels:
 *   1  只记账，从不唤醒
 *   2  只记账，随下一次请求顺带发给模型
 *   3  推理线空闲就立刻开请求；忙就排队等本轮结束
 *   4  中断当前请求重开；动作不受影响继续跑
 *   5  中断请求并停掉动作，锁住动作通道直到 emergency 结束
 *
 * 事件被某个请求带上即视为 "seen"。被抢占的请求会 un-see
 * 它带走的东西，让重启的新请求重新带上而不是丢掉。跑完
 * `finishRequest` 的请求消费掉它看到的东西；循环回到 idle
 * 时剪掉已消费的分发状态（真正的历史由 History 保管，
 * 这里的 map 只是分发状态，不是日志）。
 */

export const LEVEL = Object.freeze({
  UNUSED: 1,
  STATE: 2,
  WAKE: 3,
  PREEMPT: 4,
  EMERGENCY: 5,
} as const);

export type Level = (typeof LEVEL)[keyof typeof LEVEL];

export const KIND = Object.freeze({
  USER: 'User',
  WORLD: 'World',
  TOOL: 'Tool',
  MODEL: 'Model',
} as const);

export type Kind = (typeof KIND)[keyof typeof KIND];

const KINDS: ReadonlySet<string> = new Set(Object.values(KIND));

export interface EventPayload {
  kind: Kind;
  level: Level;
  payload: unknown;
}

interface StoredEvent extends EventPayload {
  seq: number;
  consumed: boolean;
  seenBy: number;
}

export type Decision =
  | 'stored'
  | 'start'
  | 'queued'
  | 'preempt'
  | 'emergency'
  | 'idle'
  | 'stale';

export interface PushVerdict {
  decision: Decision;
  seq: number;
  cancelledRequest?: number | null;
}

export interface BeginVerdict {
  requestId: number;
  events: StoredEvent[];
  reused?: boolean;
}

export interface FinishVerdict {
  decision: Decision;
}

export interface StartActionVerdict {
  accepted: boolean;
  actionId?: string;
  generation?: number;
  code?: 'ACTION_BUSY' | 'EMERGENCY_LOCKED';
}

export interface SchedulerSnapshot {
  apiBusy: boolean;
  currentRequestId: number;
  actionId: string | null;
  generation: number;
  emergency: boolean;
  pending: number;
}

export class Scheduler {
  private apiBusy = false;
  private currentRequestId = 0;
  private requestSeq = 0;
  private action: { id: string } | null = null;
  private generation = 0;
  private emergency = false;
  private eventSeq = 0;
  private events = new Map<number, StoredEvent>();

  /**
   * 收进一个事件，返回循环此刻该怎么处理它。
   *
   * `stored` = 归档，不唤醒；`start` = 立刻开请求；
   * `queued` = 搭下一次请求的车；`preempt` = 取消当前请求重开；
   * `emergency` = 一切停下。
   */
  pushEvent({ kind, level, payload }: EventPayload): PushVerdict {
    if (!KINDS.has(kind)) throw new RangeError(`unknown event kind: ${kind}`);
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      throw new RangeError(`event level must be 1-5, got ${level}`);
    }
    const seq = ++this.eventSeq;
    this.events.set(seq, { seq, kind, level, payload, consumed: false, seenBy: 0 });

    if (level <= LEVEL.STATE) return { decision: 'stored', seq };
    if (this.emergency) return { decision: 'stored', seq };
    if (level === LEVEL.WAKE) {
      return { decision: this.apiBusy ? 'queued' : 'start', seq };
    }
    if (level === LEVEL.PREEMPT) {
      if (!this.apiBusy) return { decision: 'start', seq };
      const cancelledRequest = this.currentRequestId;
      this.unsee(cancelledRequest);
      this.apiBusy = false;
      this.currentRequestId = 0;
      return { decision: 'preempt', seq, cancelledRequest };
    }
    // LEVEL.EMERGENCY
    const cancelledRequest = this.apiBusy ? this.currentRequestId : null;
    if (cancelledRequest != null) this.unsee(cancelledRequest);
    this.apiBusy = false;
    this.currentRequestId = 0;
    this.action = null;
    this.generation++;
    this.emergency = true;
    // emergency handler 接管这个事件：锁结束时它不能再以未见工作的
    // 面目出现，否则会为自己再唤醒一次请求。
    const stored = this.events.get(seq);
    if (stored) stored.consumed = true;
    return { decision: 'emergency', seq, cancelledRequest };
  }

  /**
   * 开一个请求。收走所有未消费的 level-2+ 事件（最老的先），
   * 记为被本次请求 seen。Level-1 事件永不搭请求。
   */
  beginRequest(): BeginVerdict {
    if (this.apiBusy) return { requestId: this.currentRequestId, events: [], reused: true };
    const requestId = ++this.requestSeq;
    const events: StoredEvent[] = [];
    for (const event of this.events.values()) {
      if (!event.consumed && event.level >= LEVEL.STATE) {
        event.consumed = true;
        event.seenBy = requestId;
        events.push({ ...event });
      }
    }
    this.apiBusy = true;
    this.currentRequestId = requestId;
    return { requestId, events };
  }

  /**
   * 模型调了 `Finish()`。过期 id（被抢占的请求姗姗来迟）什么都不改变。
   * 否则：还有未见的 level-3+ 事件就再来一轮（`start`），没有则推理线
   * 转 idle 并剪掉已消费的分发状态。
   */
  finishRequest(requestId: number): FinishVerdict {
    if (requestId !== this.currentRequestId) return { decision: 'stale' };
    this.apiBusy = false;
    this.currentRequestId = 0;
    if (this.hasUnseen(LEVEL.WAKE)) return { decision: 'start' };
    this.pruneConsumed();
    return { decision: 'idle' };
  }

  /**
   * 认领动作通道。动作跑着（`ACTION_BUSY`）或 emergency 锁住
   * （`EMERGENCY_LOCKED`）就拒绝——不排队、不顶替。
   */
  startAction(id: string): StartActionVerdict {
    if (this.emergency) return { accepted: false, code: 'EMERGENCY_LOCKED' };
    if (this.action != null) return { accepted: false, code: 'ACTION_BUSY' };
    this.action = { id };
    return { accepted: true, actionId: id, generation: this.generation };
  }

  /** `Stop()`：丢掉动作，并让所有在途回调的 generation 失效。 */
  stopAll(): { generation: number } {
    this.action = null;
    this.generation++;
    return { generation: this.generation };
  }

  /**
   * 动作自己正常结束时释放通道。与 `stopAll` 不同，这里不 bump
   * generation：没有东西被作废，run 只是跑完上报了，下一个动作
   * 不能让还合法活着的回调看起来像陌生人。
   */
  releaseAction(): boolean {
    if (this.action == null) return false;
    this.action = null;
    return true;
  }

  /** 这个 generation 还是活的吗？过期的 tool 回调必须检查。 */
  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  /** 结束 emergency 锁。有堆积的 level-3+ 事件就再唤醒循环。 */
  endEmergency(): FinishVerdict {
    this.emergency = false;
    if (this.hasUnseen(LEVEL.WAKE)) return { decision: 'start' };
    this.pruneConsumed();
    return { decision: 'idle' };
  }

  /** 给状态上报（dashboard / 调试日志）看的分发状态快照。 */
  describe(): SchedulerSnapshot {
    return {
      apiBusy: this.apiBusy,
      currentRequestId: this.currentRequestId,
      actionId: this.action?.id ?? null,
      generation: this.generation,
      emergency: this.emergency,
      pending: [...this.events.values()].filter((e) => !e.consumed).length,
    };
  }

  private hasUnseen(minLevel: Level): boolean {
    for (const event of this.events.values()) {
      if (!event.consumed && event.level >= minLevel) return true;
    }
    return false;
  }

  private unsee(requestId: number): void {
    for (const event of this.events.values()) {
      if (event.seenBy === requestId) {
        event.consumed = false;
        event.seenBy = 0;
      }
    }
  }

  private pruneConsumed(): void {
    for (const [seq, event] of this.events) {
      if (event.consumed) this.events.delete(seq);
    }
  }
}

export default Scheduler;
