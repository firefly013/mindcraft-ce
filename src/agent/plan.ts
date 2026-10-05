/*
 * 计划存储：模型自己维护的"要做什么、做到哪了"。
 *
 * 任务目标（task.goal）是外部派的，一次性的；plan 是模型在
 * ReAct 里自己写的、随时改的。两者都进 Live State，任务目标
 * 优先，plan 为空就只显示任务目标。
 *
 * 纯数据结构，无 I/O，随便单测。语义是整单替换（UpdatePlan
 * 一次把 goal/todos 写全），不做合并——合并是模型的活，
 * 存这里只会制造"到底以哪个为准"的糊涂账。
 */

export interface PlanSnapshot {
  goal: string | null;
  todos: string[];
}

export class PlanStore {
  private goal: string | null = null;
  private todos: string[] = [];

  /** 整单替换：goal 空串表示清空；todos 不传表示不动。 */
  update(goal?: string | null, todos?: string[] | null): PlanSnapshot {
    if (goal !== undefined) {
      const trimmed = typeof goal === 'string' ? goal.trim() : '';
      this.goal = trimmed !== '' ? trimmed : null;
    }
    if (todos !== undefined && todos !== null) {
      this.todos = todos
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t !== '');
    }
    return this.snapshot();
  }

  clear(): PlanSnapshot {
    this.goal = null;
    this.todos = [];
    return this.snapshot();
  }

  snapshot(): PlanSnapshot {
    return { goal: this.goal, todos: [...this.todos] };
  }
}

export default { PlanStore };
