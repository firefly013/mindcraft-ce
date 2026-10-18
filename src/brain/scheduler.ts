/*
 * 动作通道仲裁 + 紧急锁。
 *
 * **它不再是事件调度器。**事件的分发在 `runtime/events.ts`：处理由**事件类型**
 * 决定（`runtime/handlers.ts`），等级只决定"用多大力气把模型叫来看一眼"。
 * 这里剩下的只有两条**独立**的线之间的仲裁：
 *
 *   - **动作线**：同一时刻最多一个占用型动作（`ActionRunner` 认领/释放）。
 *     大脑是这条线的唯一真相——身体只执行，不仲裁，所以两侧不会各说各话。
 *   - **紧急锁**：L5 的身体侧反射在跑的时候锁住通道，模型的动作不许插进来
 *     （它在水底下上浮，模型这时发个 `mineBlock` 只会打乱节奏）。锁由事件驱动：
 *     反射**开始**的事件锁，反射**完成**的事件（`completes`）解锁。
 *
 * 纯逻辑，无 I/O。
 */

/** 当前占着身体通道的动作：名字 + 调用参数 + 认领时刻。 */
export interface CurrentAction {
  id: string;
  args: unknown;
  startedAt: number;
  /** 认领时的调度器 generation，busy 回执/锁快照用。 */
  generation: number;
}

/** generation 失效的原因：Stop 还是保命急停。 */
export type ActionInvalidationReason = 'stop' | 'emergency' | null;

export interface StartActionVerdict {
  accepted: boolean;
  actionId?: string;
  generation?: number;
  code?: 'ACTION_BUSY' | 'EMERGENCY_LOCKED';
}

/** 给状态上报（dashboard / 调试日志）看的快照。 */
export interface SchedulerSnapshot {
  actionId: string | null;
  generation: number;
  emergency: boolean;
}

export class Scheduler {
  private action: CurrentAction | null = null;
  private generation = 0;
  private emergency = false;
  private invalidationReason: ActionInvalidationReason = null;

  /**
   * 认领动作通道。动作跑着（`ACTION_BUSY`）或紧急锁住（`EMERGENCY_LOCKED`）
   * 就拒绝——不排队、不顶替。
   *
   * 记下名字与参数，是为了让调用方能回答"被拒的这次是不是就是正在跑的那件事"：
   * 同一个动作重复下发应当幂等忽略，而不是逼模型先 Stop 再重开（那会把模型
   * 自己正在做的事打断）。
   */
  startAction(id: string, args: unknown = null): StartActionVerdict {
    if (this.emergency) return { accepted: false, code: 'EMERGENCY_LOCKED' };
    if (this.action != null) return { accepted: false, code: 'ACTION_BUSY' };
    this.action = { id, args, startedAt: Date.now(), generation: this.generation };
    return { accepted: true, actionId: id, generation: this.generation };
  }

  /** 正在跑的动作；空闲时为 null。 */
  currentAction(): CurrentAction | null {
    return this.action == null ? null : { ...this.action };
  }

  /**
   * `Stop()`：丢掉动作，并让所有在途回调的 generation 失效。
   *
   * 一并回报"刚才到底停掉了什么"：没在跑的时候 Stop 是空操作，
   * 模型据此才能分清"我停掉了 collectBlocks"和"我什么也没停"。
   */
  stopAll(): { generation: number; hadAction: boolean; actionId: string | null } {
    const hadAction = this.action != null;
    const actionId = this.action?.id ?? null;
    this.action = null;
    this.generation++;
    this.invalidationReason = 'stop';
    // **Stop 也解锁紧急锁。** 真机 2026-10-18 17:15（overnight_b）：保命反射
    // 一直重新触发，紧急锁跟着一直是开的；Stop 回了 `{"stopped":true}`、事件也说
    // "身体通道已释放"，可**通道其实还锁着**——stairUp / restart /
    // disableSafeguards 全被拒，快照还写着 `escape（已 102s）`。
    // Stop 是模型明确说"把身体给我"，它必须一次到位；真正的危险还会再触发反射
    // （下一条 L5 会重新上锁），所以这里解锁不会漏掉保命。
    this.emergency = false;
    return { generation: this.generation, hadAction, actionId };
  }

  /**
   * 上一次 generation 为什么失效。
   *
   * ActionRunner 在途回调过期时据此区分「被 Stop 停掉」和「被保命反射抢走」，
   * 不能把两者都写成模棱两可的「Stop / 急停作废」——Feedback #22 里模型
   * 从未调 Stop，却读到 Stop 字样的回执。
   */
  lastInvalidationReason(): ActionInvalidationReason {
    return this.invalidationReason;
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

  /**
   * 紧急锁：L5 的身体侧反射开始跑。
   *
   * **锁的时候顺带把正在跑的动作作废**——它多半就是"正在水里往下挖"那种
   * 把机器人送进险境的动作，让保命反射和它抢身体没有意义。
   */
  beginEmergency(): void {
    if (this.emergency) return;
    this.emergency = true;
    this.action = null;
    this.generation++;
    this.invalidationReason = 'emergency';
  }

  /** 紧急锁解除：最后一个反射报告完成。没有锁的时候是空操作。 */
  endEmergency(): void {
    this.emergency = false;
  }

  /** 现在是否处于紧急锁。 */
  get locked(): boolean {
    return this.emergency;
  }

  /** 给状态上报（dashboard / 调试日志）看的分发状态快照。 */
  describe(): SchedulerSnapshot {
    return {
      actionId: this.action?.id ?? null,
      generation: this.generation,
      emergency: this.emergency,
    };
  }
}

export default Scheduler;
