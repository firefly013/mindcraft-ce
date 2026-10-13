/*
 * 计划（goal / todos）的**共享数据结构**。
 *
 * 它同时出现在两个地方，所以必须是共享的、纯数据的：
 *   - 大脑侧：`PlanStore`（模型用 UpdatePlan 维护的计划）；
 *   - 身体侧：Live State 采样要把当前的 goal/todos 拍进快照
 *     （`SampleContext.todos`）。
 *
 * 只放类型，不放逻辑——计划的真源在大脑的会话文档里。
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
