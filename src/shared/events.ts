/*
 * 事件分级词汇表：L1–L5 与事件类别。
 *
 * 这是**两侧共用的词**，不是大脑的私有枚举：
 *   - 身体侧的边沿检测器（`body/edges.ts`）要按等级给事件定级；
 *   - 大脑侧的调度器（`brain/scheduler.ts`）与事件接入（`brain/runtime/events.ts`）
 *     要按同一个等级决定 write / steer / abort / rescue。
 * 两边各写一份数字，迟早会漂——而漂了的表现是"某类事件不再唤醒模型"，
 * 没有任何报错。
 *
 * Levels:
 *   1  只记账，从不唤醒
 *   2  只记账，随下一次请求顺带发给模型
 *   3  推理线空闲就立刻开请求；忙就排队等本轮结束
 *   4  中断当前请求重开；动作不受影响继续跑
 *   5  中断请求并停掉动作，锁住动作通道直到 emergency 结束
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

/** 合法 kind 的集合视图（校验用）。 */
export const KINDS: ReadonlySet<string> = new Set(Object.values(KIND));

/** 事件类别 -> 事件等级 + 载荷。 */
export interface EventPayload {
  kind: Kind;
  level: Level;
  payload: unknown;
}
