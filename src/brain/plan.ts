/*
 * 计划存储：模型自己维护的"当前目标"。
 *
 * 任务目标（task.goal）是外部派的，一次性的；plan 是模型在
 * ReAct 里自己写的、随时改的。两者都进 Live State，任务目标
 * 优先，plan 为空就只显示任务目标。
 *
 * 纯数据结构，无 I/O，随便单测。语义是整单替换（UpdateGoal
 * 一次把 goal 写全），不做合并——合并是模型的活。
 *
 * `PlanSnapshot` 形状住在 `shared/plan.ts`：身体的 Live State 采样
 * 也要读同一份 goal，形状不能各写一份。
 */

import type { PlanSnapshot } from '../shared/plan.js';

export type { PlanSnapshot } from '../shared/plan.js';

/**
 * 计划（单一 goal）的存储。
 *
 * **它自己不落盘**——持久化由 `stateAccess`（`runtime/state_access.ts`）负责，
 * 那才是 Pi Durable 文档（`PlanDoc`）的门面。这里只管内存里的形状，
 * 以及"把已恢复的内容灌进来 / 把当前内容交出去"两个动作。
 *
 * 为什么必须走 `state` 而不是自己写文件：Pi Durable 的会话是跨重启续的，
 * 计划属于那个会话（和 memory / places 一样写在 `mc.places` / `mc.plan` 文档里）。
 * 自己再写一份文件就等于同一个事实有第二个真源，两份迟早漂移——而漂移的表现
 * 恰好就是模型抱怨的那种："回执说存好了，重启后却没有"（Feedback #23）。
 */
export class PlanStore {
  private goal: string | null = null;

  /** 把恢复出来的目标灌进来（启动时用）。 */
  hydrate(goal: string | null): void {
    const trimmed = typeof goal === 'string' ? goal.trim() : '';
    this.goal = trimmed !== '' ? trimmed : null;
  }

  /** 整单替换：goal 空串表示清空。 */
  update(goal?: string | null): PlanSnapshot {
    if (goal !== undefined) {
      const trimmed = typeof goal === 'string' ? goal.trim() : '';
      this.goal = trimmed !== '' ? trimmed : null;
    }
    return this.snapshot();
  }

  clear(): PlanSnapshot {
    this.goal = null;
    return this.snapshot();
  }

  snapshot(): PlanSnapshot {
    return { goal: this.goal };
  }
}

export default { PlanStore };
