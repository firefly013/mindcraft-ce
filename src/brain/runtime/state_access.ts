/**
 * P5：跨会话状态的读写门面（memory / places / plan）。
 *
 * P2 定义了文档，这里给它们一个窄接口：`liveTail` 要 memory，`UpdatePlan`
 * 要 plan 的读写与快照，`rememberHere`/`goToRememberedPlace` 要 places。
 *
 * 约定：**读不到就返回默认值**，而不是 `undefined`——调用方不该到处判空。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Context } from '@earendil-works/chord';
import type { ConversationId, Harness } from '@earendil-works/pi-durable';
import {
  EMPTY_MEMORY,
  EMPTY_PLACES,
  EMPTY_PLAN,
  MemoryDoc,
  PlacesDoc,
  PlanDoc,
  type PlaceCoords,
  type PlanState,
} from './state.js';

export interface BotStateAccess {
  memory(): Promise<string>;
  setMemory(text: string): Promise<void>;
  places(): Promise<Record<string, PlaceCoords>>;
  setPlaces(places: Record<string, PlaceCoords>): Promise<void>;
  plan(): Promise<PlanState>;
  setPlan(plan: PlanState): Promise<void>;
}

export function createStateAccess(
  harness: Harness,
  conversationId: ConversationId,
  context: Context = BACKGROUND_CONTEXT,
): BotStateAccess {
  return {
    memory: async () =>
      (await harness.snapshot(MemoryDoc, conversationId, context))?.text ?? EMPTY_MEMORY,

    setMemory: async (text) => {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(MemoryDoc, conversationId);
        doc.text = text;
      }, context);
    },

    places: async () => {
      const stored = await harness.snapshot(PlacesDoc, conversationId, context);
      return stored == null ? { ...EMPTY_PLACES } : { ...stored.places };
    },

    setPlaces: async (places) => {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(PlacesDoc, conversationId);
        doc.places = { ...places };
      }, context);
    },

    plan: async () => {
      const stored = await harness.snapshot(PlanDoc, conversationId, context);
      if (stored == null) return { ...EMPTY_PLAN, todos: [] };
      // 深拷贝：调用方改快照不该反噬存储（与 PlanStore.snapshot 的约定一致）。
      return { goal: stored.goal, todos: stored.todos.map((todo) => ({ ...todo })) };
    },

    setPlan: async (plan) => {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(PlanDoc, conversationId);
        doc.goal = plan.goal;
        doc.todos = plan.todos.map((todo) => ({ ...todo }));
      }, context);
    },
  };
}
