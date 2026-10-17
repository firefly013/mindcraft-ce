/**
 * 事件 → 处理：**一一对应的那张表**。
 *
 * ## 为什么只有这张表，没有第二套机制
 *
 * 统一抽象是"事件 → 处理"：
 *
 *   - **事件**宣告某个东西发生。它没有执行者——`world.water.drowning` 只是
 *     说"头在水里"，它自己不做事。
 *   - **处理**是对应的实际动作。它有执行者。
 *   - 两者**一一对应**，而且**都进上下文**（模型必须知道所有东西，包括
 *     别人替它做了什么）。
 *
 * 所以事件类型是处理的匹配键，等级只是事件自己的属性（"要用多大力气把模型
 * 叫来看一眼"）。**等级不决定谁来处理**——那是这里的事。
 *
 * ## 三种执行者
 *
 * | 执行者 | 住哪 | 谁报告结果 |
 * |---|---|---|
 * | `body-reflex` | 身体进程 | 身体：事件里带 `reflex`，跑完再发 `completes` 事件 |
 * | `brain-reflex` | 大脑进程（本表） | 处理体自己 `emit()` 一条完成事件 |
 * | `model` | 模型 | 事件本身被投给模型，模型的动作是它的处理 |
 *
 * 前两种是"反射"：毫秒级或秒级的事，不能等一轮推理（溺水、掉落物）。
 * 它们在**发生的那一刻**就执行，然后把结果也当成事件记录下来。
 *
 * ## 为什么没有 body-reflex 的条目
 *
 * 身体侧的处理由**身体自己在事件里声明**（`event.reflex`）——身体是唯一知道
 * "我为这条事件启动了什么"的地方。大脑不需要第二份名单，那会漂。
 * 本表只登记**大脑侧**的反射，以及给几个事件类型留说明。
 */
import type { GameEvent } from './events.js';

/** 处理的执行者。 */
export type HandlerExecutor = 'model' | 'reflex';

/** 反射处理器拿到的东西。 */
export interface HandlingContext {
  /**
   * 报告结果：**再发一条事件**。
   *
   * 这就是"处理也进上下文"的落点——处理不做隐式副作用，它留下一条记录。
   * 记录走的通道和别的事件完全一样（`completes` 字段负责把结果挂回原处理）。
   */
  emit: (event: GameEvent) => void;
}

/** 一条事件类型对应的处理。 */
export interface EventHandler {
  /** 匹配的事件类型（精确串，与 `edges.ts` 的检测器 type 一致）。 */
  types: readonly string[];
  executor: HandlerExecutor;
  /** `executor: 'reflex'` 的执行体；`model` 不需要。 */
  run?: (event: GameEvent, ctx: HandlingContext) => Promise<void>;
  /** 人话说明，只用于日志与排障。 */
  note?: string;
}

/**
 * 查表：事件类型 → 处理。
 *
 * **查不到就是"交给模型"**，这不是兜底而是默认语义：绝大多数事件的处理就是
 * "让模型看看、它来决定"。所以"没有任何一个事件没有处理"这条恒真。
 */
export type HandlerLookup = (type: string) => EventHandler | undefined;

export function createHandlerLookup(handlers: readonly EventHandler[]): HandlerLookup {
  const byType = new Map<string, EventHandler>();
  for (const handler of handlers) {
    for (const type of handler.types) {
      if (byType.has(type)) {
        // 一条事件两个处理 = 一一对应被破坏，直接炸，别让它悄悄跑起来。
        throw new Error(`事件类型 ${type} 注册了两个处理：${byType.get(type)?.note ?? ''} / ${handler.note ?? ''}`);
      }
      byType.set(type, handler);
    }
  }
  return (type: string): EventHandler | undefined => byType.get(type);
}
