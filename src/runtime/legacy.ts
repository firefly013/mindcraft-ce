/**
 * P2：旧存档（`bots/<name>/memory.json`）→ pi-durable 文档的一次性迁移。
 *
 * 只迁跨会话真正有价值的三项：`memory` / `places` / `plan`。
 * `turns` 故意不迁——那是易失上下文，把上一局的对话原样塞进新会话没有意义，
 * 而且模型看到的世界已经变了。
 *
 * 迁移是**幂等**的：只在文档"从未创建"时才写入，重复调用不会覆盖新状态。
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Context } from '@earendil-works/chord';
import type { ConversationId, Harness } from '@earendil-works/pi-durable';
import { MemoryDoc, PlacesDoc, PlanDoc, type PlaceCoords, type PlanState } from './state.js';

/** 旧 `memory.json` 的形状（`HistorySaveData` 里与跨会话状态相关的子集）。 */
export interface LegacySaveData {
  memory?: string;
  turns?: unknown[];
  taskStart?: number;
  places?: Record<string, PlaceCoords>;
  plan?: PlanState | null;
  [key: string]: unknown;
}

/** 迁移结果，供调用方日志/断言。 */
export interface LegacyMigration {
  memory: boolean;
  places: number;
  plan: boolean;
}

/** 读旧存档；不存在或损坏都返回 null（迁移不是启动的必经步骤）。 */
export function readLegacySave(baseDir: string): LegacySaveData | null {
  const file = `${baseDir}/memory.json`;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LegacySaveData;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read legacy memory at ${file}: ${message}`);
    return null;
  }
}

/** 把旧存档里的跨会话状态灌进文档。重复调用安全。 */
export async function migrateLegacyState(
  harness: Harness,
  conversationId: ConversationId,
  legacy: LegacySaveData | null,
  context: Context,
): Promise<LegacyMigration> {
  const migrated: LegacyMigration = { memory: false, places: 0, plan: false };
  if (legacy == null) return migrated;

  // 幂等判据：文档未创建 = 这块状态还没有新主人。已存在就一律不动。
  const currentMemory = await harness.snapshot(MemoryDoc, conversationId, context);
  const currentPlaces = await harness.snapshot(PlacesDoc, conversationId, context);
  const currentPlan = await harness.snapshot(PlanDoc, conversationId, context);

  const legacyPlaces = legacy.places ?? {};
  const wantMemory =
    currentMemory === undefined && typeof legacy.memory === 'string' && legacy.memory !== '';
  const wantPlaces = currentPlaces === undefined && Object.keys(legacyPlaces).length > 0;
  const wantPlan = currentPlan === undefined && legacy.plan != null;
  if (!wantMemory && !wantPlaces && !wantPlan) return migrated;

  await harness.commit(async (tx) => {
    if (wantMemory) {
      const doc = await tx.doc(MemoryDoc, conversationId);
      doc.text = legacy.memory as string;
      migrated.memory = true;
    }
    if (wantPlaces) {
      const doc = await tx.doc(PlacesDoc, conversationId);
      doc.places = { ...legacyPlaces };
      migrated.places = Object.keys(legacyPlaces).length;
    }
    if (wantPlan && legacy.plan != null) {
      const doc = await tx.doc(PlanDoc, conversationId);
      doc.goal = legacy.plan.goal ?? null;
      doc.todos = legacy.plan.todos ?? [];
      migrated.plan = true;
    }
  }, context);

  return migrated;
}
