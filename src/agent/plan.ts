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

export interface PlanTodo {
  text: string;
  done: boolean;
}

export interface PlanSnapshot {
  goal: string | null;
  todos: PlanTodo[];
}

/** 兼容旧格式：纯字符串按"未完成"折算。 */
export type PlanTodoInput = PlanTodo | string;

export class PlanStore {
  private goal: string | null = null;
  private todos: PlanTodo[] = [];

  /** 整单替换：goal 空串表示清空；todos 不传表示不动。 */
  update(goal?: string | null, todos?: PlanTodoInput[] | null): PlanSnapshot {
    if (goal !== undefined) {
      const trimmed = typeof goal === 'string' ? goal.trim() : '';
      this.goal = trimmed !== '' ? trimmed : null;
    }
    if (todos !== undefined && todos !== null) {
      this.todos = todos
        .map((t): PlanTodo => {
          if (typeof t === 'string') return { text: t.trim(), done: false };
          const text = typeof t?.text === 'string' ? t.text.trim() : '';
          return { text, done: t?.done === true };
        })
        .filter((t) => t.text !== '');
    }
    return this.snapshot();
  }

  clear(): PlanSnapshot {
    this.goal = null;
    this.todos = [];
    return this.snapshot();
  }

  /** 深拷贝返回：调用方改快照不该反噬存储。 */
  snapshot(): PlanSnapshot {
    return { goal: this.goal, todos: this.todos.map((t) => ({ ...t })) };
  }
}

export default { PlanStore };
