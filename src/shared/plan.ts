/*
 * 计划（单一 goal）的**共享数据结构**。
 *
 * 它同时出现在两个地方，所以必须是共享的、纯数据的：
 *   - 大脑侧：`PlanStore`（模型用 UpdateGoal 维护的计划）；
 *   - 身体侧：Live State 采样要把当前的 goal 拍进快照。
 *
 * 只放类型，不放逻辑——计划的真源在大脑的会话文档里。
 */

export interface PlanSnapshot {
  goal: string | null;
}
