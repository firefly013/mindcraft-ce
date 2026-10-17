/*
 * 事件分级词汇表：L1–L5 与事件类别。
 *
 * 这是**两侧共用的词**，不是大脑的私有枚举：
 *   - 身体侧的边沿检测器（`body/edges.ts`）按等级给事件定级；
 *   - 大脑侧的事件接入（`brain/runtime/events.ts`）按同一个等级决定投递力度
 *     （写进上下文 / 唤醒 / 打断 / 锁通道）。
 * 两边各写一份数字，迟早会漂——而漂了的表现是"某类事件不再唤醒模型"，
 * 没有任何报错。
 *
 * **等级是事件的属性，不是处理的属性。**它只回答"这条事件要用多大力气把模型
 * 叫来看一眼"；谁来处理（身体侧的反射 / 大脑侧的反射 / 模型）由事件**类型**
 * 决定，见 `brain/runtime/handlers.ts`。
 *
 * Levels:
 *   1  【保留空位】不许使用。这里只占一个数字，防止将来加档时挤掉别的档；
 *      **没有任何地方会产生它，也没有任何分支会接受它**（收到 1 一律判非法）。
 *   2  只记录，不唤醒：写进上下文（durable），搭下一次请求的车
 *   3  推理线空闲就立刻开请求；忙就排队等本轮结束
 *   4  中断当前请求重开；动作不受影响继续跑
 *   5  中断请求并锁住动作通道，直到身体侧的保命处理报告完成
 *
 * **等级是事件的属性，不是处理的属性。**它只回答"这条事件要用多大力气把模型
 * 叫来看一眼"；至于谁来处理（模型 / 反射），是事件类型决定的，见
 * `brain/runtime/handlers.ts`。
 */

export const LEVEL = Object.freeze({
  UNUSED: 1,
  STATE: 2,
  WAKE: 3,
  PREEMPT: 4,
  EMERGENCY: 5,
} as const);

export type Level = (typeof LEVEL)[keyof typeof LEVEL];

/**
 * 合法等级判定。**1 是保留空位，永远非法**——它不是一个"更弱的记账档"。
 *
 * 有没有这个判断是设计干净与否的分界线：只要代码里存在一个能接受 1 的分支
 * （比如 `level <= STATE`），那个空位就迟早会被谁填上，而填上之后没有报错。
 */
export function isValidEventLevel(level: number): level is Level {
  return Number.isInteger(level) && level >= LEVEL.STATE && level <= LEVEL.EMERGENCY;
}

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
