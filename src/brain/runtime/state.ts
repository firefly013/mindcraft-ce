/**
 * P2：跨会话状态的文档定义。
 *
 * 这些字段原先散落在 `bots/<name>/memory.json` 的 `HistorySaveData` 里
 * （见 `src/agent/history.ts`）。迁到 pi-durable 后它们是**文档**：
 * 与 entry 同一事务提交、原子落盘、带 fork 语义、可按地址观察。
 *
 * 只迁"跨会话真正有价值"的三项——memory / places / plan。
 * `turns` 是易失上下文，交给 Conversation 的 entry 流，不做迁移。
 */
import { defineDoc } from '@earendil-works/pi-durable';

/** 地点坐标（原 `MemoryBank` 的落盘形状，保持三元组不变）。 */
export type PlaceCoords = [number, number, number];

/**
 * 模型自己维护的计划（原 `PlanStore` 的落盘形状）。
 *
 * 必须是 `type` 而不是 `interface`：TypeScript 只给对象字面量类型隐式索引签名，
 * `interface` 没有，于是不满足 pi-durable 要求的 `JsonObject`。
 */
export type PlanState = {
  goal: string | null;
  todos: Array<{ text: string; done: boolean }>;
};

/** 跨会话自然语言记忆（原 `memory.json` 的 `memory` 字段）。 */
export const MemoryDoc = defineDoc<{ text: string }>({
  kind: 'mc.memory',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ text: '' }),
});

/** 记住的地点（原 `MemoryBank.getJson()` 的落盘内容）。 */
export const PlacesDoc = defineDoc<{ places: Record<string, PlaceCoords> }>({
  kind: 'mc.places',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ places: {} }),
});

/** 模型自己维护的计划（原 `PlanStore.snapshot()` 的落盘内容）。 */
export const PlanDoc = defineDoc<PlanState>({
  kind: 'mc.plan',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ goal: null, todos: [] }),
});

/** 记忆文档的默认值，供"读不到就当作空"的调用方使用。 */
export const EMPTY_MEMORY = '';
/** 地点文档的默认值。 */
export const EMPTY_PLACES: Record<string, PlaceCoords> = {};
/** 计划文档的默认值。 */
export const EMPTY_PLAN: PlanState = { goal: null, todos: [] };
