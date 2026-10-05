/*
 * Compaction 压仓策略：90% 动手，25% 定级。
 *
 * 历史攒到有压力（usageRatio >= 90%）才动手。动手分两级：
 * 先干跑一次删除——能删掉 25% 以上就真删（level 1，只删过期
 * 的：level-1 条目，或放超 60 秒的 world 条目；工具往来和
 * 模型原文永远不删）；删不动才走总结（level 2，把 `keepLast`
 * 条之外的头部交给注入的 summarize 函数，尾部逐字保留）。
 *
 * 本文件不调模型——summarize 由调用方注入。操作纯数组，
 * 返回新数组，不偷改入参。
 */

/** 压力线：usage 到 90% 才看要不要压。 */
export const COMPACT_AT = 0.9;
/** 干跑能删掉 25% 以上才真删，否则走总结。 */
export const SUMMARIZE_BELOW = 0.25;
/** 总结时逐字保留的尾部条数。 */
export const DEFAULT_KEEP_LAST = 20;
/** World 条目超过这么久没被用过就可删（占位值，等实测数据再调）。 */
export const WORLD_TTL_MS = 60_000;

export interface Compactable {
  kind?: string;
  level?: number;
  at?: number;
  role?: string;
  content?: string;
}

/** 没有配置窗口时的 fallback（主流模型的常见量级，往小了估更安全）。 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * 从 profile 读上下文窗口：profile.context_window > 0 就用，
 * 否则回退。回退值故意取常见下限——估大了会晚压仓。
 */
export function resolveContextWindow(profile: unknown): number {
  const w = (profile as { context_window?: unknown } | null)?.context_window;
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : FALLBACK_CONTEXT_WINDOW;
}

/** 一组条目的 token 粗估（role+content；compaction 预算用）。 */
export function entriesTokens(entries: Compactable[]): number {
  let n = 0;
  for (const e of entries) {
    n += estimateTokens(`${e.role ?? ''}:${typeof e.content === 'string' ? e.content : ''}`);
  }
  return n;
}

/**
 * token 粗估（预算 guard，不是计费表）：CJK 一个字 ~1 token，
 * ASCII ~1/4。故意往大了估，早合并比晚合并安全。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of String(text)) {
    tokens += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * Level-1 条目，以及过期的 World 条目。`now` 传历史自己的时钟，
 * 单测用固定时间 deterministic。
 */
export function defaultIsObsolete(entry: Compactable, now: number): boolean {
  if (entry.level === 1) return true;
  if (entry.kind !== 'world') return false;
  if (typeof now !== 'number' || typeof entry.at !== 'number') return false;
  return now - entry.at > WORLD_TTL_MS;
}

/** 数一下 `isObsolete` 能删几条，不碰数组。 */
export function countObsolete<T extends Compactable>(
  entries: T[],
  isObsolete: (entry: T, now: number) => boolean = defaultIsObsolete as (
    entry: T,
    now: number,
  ) => boolean,
  now: number = Date.now(),
): number {
  return entries.filter((entry) => isObsolete(entry, now)).length;
}

export interface CompactResult<T> {
  compacted: boolean;
  level: 0 | 1 | 2;
  removed: number;
  freedRatio: number;
  entries: T[];
  summary?: string;
}

export interface CompactOptions<T> {
  entries: T[];
  usageRatio?: number;
  isObsolete?: (entry: T, now: number) => boolean;
  keepLast?: number;
  summarize?: ((entries: T[]) => string | Promise<string>) | null;
  makeSummary?: ((text: string, now: number) => T) | null;
  now?: number | null;
}

export async function maybeCompact<T extends Compactable>({
  entries,
  usageRatio = 0,
  isObsolete = defaultIsObsolete as (entry: T, now: number) => boolean,
  keepLast = DEFAULT_KEEP_LAST,
  summarize = null,
  makeSummary = null,
  now = null,
}: CompactOptions<T>): Promise<CompactResult<T>> {
  if (usageRatio < COMPACT_AT) {
    return { compacted: false, level: 0, removed: 0, freedRatio: 0, entries };
  }
  const at = now ?? Date.now();
  const deletable = entries.filter((entry) => isObsolete(entry, at)).length;
  const freedRatio = entries.length > 0 ? deletable / entries.length : 0;
  if (freedRatio >= SUMMARIZE_BELOW) {
    const kept = entries.filter((entry) => !isObsolete(entry, at));
    return { compacted: true, level: 1, removed: entries.length - kept.length, freedRatio, entries: kept };
  }
  if (typeof summarize !== 'function' || typeof makeSummary !== 'function') {
    return { compacted: true, level: 1, removed: 0, freedRatio, entries };
  }
  const tail = entries.slice(-keepLast);
  const head = entries.slice(0, Math.max(0, entries.length - tail.length));
  const text = await summarize(head);
  const summaryEntry = makeSummary(text, at);
  return {
    compacted: true,
    level: 2,
    removed: 0,
    freedRatio,
    entries: [summaryEntry, ...tail],
    summary: text,
  };
}

export default { maybeCompact, defaultIsObsolete, countObsolete, estimateTokens };
