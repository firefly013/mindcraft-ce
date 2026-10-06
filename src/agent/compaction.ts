/*
 * 压仓：照 Pi（github.com/earendil-works/pi）的上下文机制。
 *
 * 三条规则，和 Pi 的 compaction.ts 一一对应：
 *
 *   1. 没有条数上限。唯一的裁剪机制是压仓本身——以前那个
 *      `max_messages`（默认 15）会在窗口还很空的时候就把历史压掉，
 *      压出来的又是一段有损的记忆摘要，于是模型看到的永远只有摘要。
 *
 *   2. 触发线是 `contextTokens > contextWindow - reserveTokens`。
 *      `contextTokens` 优先取**上一条 assistant 回复里 provider 报的
 *      usage**（那是真实 token 数），只有它之后新增的条目才用估算补。
 *      reserveTokens 默认 16384：给模型的回复留位置。
 *
 *   3. 切点从最新往前累加估算 token，攒够 `keepRecentTokens`（默认 20000）
 *      就切；只在 user/assistant 边界切——**绝不切在工具回执上**，
 *      回执必须跟着它属于的那一轮。切点之前的头部交给模型总结成一条
 *      摘要条目，尾部逐字保留。压仓只**追加**一条摘要，不删历史。
 *
 * 与 Pi 的一处有意偏差：Pi 用 `chars/4` 估算，中文会被严重低估（一个汉字
 * ≈1 token，不是 0.25）。这里沿用本项目的 CJK 感知估算，故意往大估。
 *
 * 本文件不调模型：`summarize` 由调用方注入，策略可单测。
 */

/** 没有配置窗口时的 fallback（保守取常见下限，估大了会晚压仓）。 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
/** 给模型回复留的空间。Pi 的默认值。 */
export const DEFAULT_RESERVE_TOKENS = 16_384;
/** 逐字保留的最近 token 量。Pi 的默认值。 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export interface CompactionPolicy {
  enabled: boolean;
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 从 profile 解析压仓策略。
 *   context_window      模型窗口（如 opencode-go 的 deepseek-v4.1-flash = 1000000）
 *   reserve_tokens      默认 16384
 *   keep_recent_tokens  默认 20000
 *   compaction_enabled  显式 false 可关掉自动压仓
 */
export function resolvePolicy(profile: unknown): CompactionPolicy {
  const p = (profile ?? {}) as Record<string, unknown>;
  return {
    enabled: p['compaction_enabled'] !== false,
    contextWindow: positiveNumber(p['context_window'], FALLBACK_CONTEXT_WINDOW),
    reserveTokens: positiveNumber(p['reserve_tokens'], DEFAULT_RESERVE_TOKENS),
    keepRecentTokens: positiveNumber(p['keep_recent_tokens'], DEFAULT_KEEP_RECENT_TOKENS),
  };
}

/**
 * token 粗估（预算 guard，不是计费表）：CJK 一个字 ≈1 token，
 * ASCII ≈1/4。故意往大了估，早压比晚压安全。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of String(text)) {
    // 用 charCodeAt 而不是 codePointAt：后者在类型上可能返回 undefined，
    // 而 for...of 迭代出的每一段都非空——那个 `?? 0` 是够不到的分支。
    // 代价是星平面字符按高代理位算（> 阈值 → 记 1 token），仍是往大估。
    tokens += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * 压仓能看见的最小条目形状。
 *
 * `role` / `content` 是**必填**：历史里的每一条都有（`ChatMessage` 本来
 * 就是必填）。以前写成可选，于是估算函数里得写 `entry.role ?? ''`、
 * `typeof content === 'string'` 这种永远走不到的分支——收紧类型比给死分支
 * 补测试诚实。
 */
export interface Compactable {
  role: string;
  content: string;
  kind?: string;
  level?: number;
  at?: number;
  usage?: { totalTokens?: number } | null;
}

/** 单条条目在上下文里占的估算 token。空条目（没有正文）不占。 */
export function estimateEntryTokens(entry: Compactable): number {
  if (entry.content === '') return 0;
  return estimateTokens(`${entry.role}:${entry.content}`);
}

/** 一整组条目的估算 token（没有 usage 锚点时用）。 */
export function estimateEntriesTokens(entries: Compactable[]): number {
  let n = 0;
  for (const e of entries) n += estimateEntryTokens(e);
  return n;
}

export interface ContextUsage {
  /** 估算的上下文占用量：锚点 usage + 其后新增条目的估算。 */
  tokens: number;
  /** 锚点报的实数；没有锚点时为 0。 */
  usageTokens: number;
  /** 锚点之后新增条目的估算量；没有锚点时等于 tokens。 */
  trailingTokens: number;
  /** 锚点在 entries 里的下标；没有时为 null。 */
  anchorIndex: number | null;
}

/**
 * 上下文占用量。锚点取**最后一条带 usage 的 assistant 回复**——
 * provider 报的 token 是唯一可信的实数，它之后新增的东西才需要估算。
 *
 * 锚点不能跨越压仓边界：压仓后头部被换成摘要，而被逐字保留的尾部里
 * 那些 assistant 条目**是在压仓之前**产生的，它们的 usage 描述的是
 * "压仓前那个更大的上下文"。拿它当基线会让压仓后的第一轮立刻再压一次，
 * 然后无限循环。判据用时间戳：锚点必须晚于最近一条摘要条目。
 * （Pi 在 branch entries 上用 `usageEntryIndex > latestInvalidatingEntryIndex`
 * 表达同一件事。）
 */
export function contextUsage(entries: Compactable[]): ContextUsage {
  let boundary = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind === 'summary') {
      boundary = i;
      break;
    }
  }
  const boundaryAt =
    boundary >= 0 && typeof entries[boundary].at === 'number'
      ? (entries[boundary].at as number)
      : null;

  let anchorIndex: number | null = null;
  let anchorTokens = 0;
  for (let i = entries.length - 1; i > boundary; i--) {
    const entry = entries[i];
    const total = entry.usage?.totalTokens;
    if (entry.role !== 'assistant' || typeof total !== 'number' || total <= 0) continue;
    // 有摘要时，只信压仓之后产生的 usage；老条目的 usage 已经过期。
    if (boundaryAt !== null && (typeof entry.at !== 'number' || entry.at <= boundaryAt)) continue;
    anchorIndex = i;
    anchorTokens = total;
    break;
  }

  if (anchorIndex === null) {
    const estimated = estimateEntriesTokens(entries);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, anchorIndex: null };
  }

  const usageTokens = anchorTokens;
  let trailingTokens = 0;
  for (let i = anchorIndex + 1; i < entries.length; i++) {
    trailingTokens += estimateEntryTokens(entries[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    anchorIndex,
  };
}

/** Pi 的触发线：`contextTokens > contextWindow - reserveTokens`。 */
export function shouldCompact(contextTokens: number, policy: CompactionPolicy): boolean {
  if (!policy.enabled) return false;
  return contextTokens > policy.contextWindow - policy.reserveTokens;
}

/**
 * 从最新往前累加，攒够 `keepRecentTokens` 就在最近的合法切点切。
 * 返回**第一个要保留的条目下标**；没有合法切点或整个对话都没到预算时
 * 返回第一个合法切点（通常就是 0，等于没什么可压）。
 *
 * 合法切点 = user/assistant 条目。工具回执（role=system）不能当切点：
 * 让尾部以一条"工具 …→ 结果"开头，模型会读不懂它是谁的动作。
 *
 * 兜底照 Pi：预算到了但该位置**没有**合法切点时，退到最后一个合法切点
 * （宁可多留，也不要把尾部切成空）。
 */
export function findCutPoint(entries: Compactable[], keepRecentTokens: number, startIndex = 0): number {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < entries.length; i++) {
    const role = entries[i].role;
    if (role === 'user' || role === 'assistant') cutPoints.push(i);
  }
  if (cutPoints.length === 0) return 0;

  let accumulated = 0;
  let cutIndex = cutPoints[0];
  for (let i = entries.length - 1; i >= startIndex; i--) {
    // 空条目加 0，跳过与否对累加结果没有区别——不需要那个 continue。
    accumulated += estimateEntryTokens(entries[i]);
    if (accumulated >= keepRecentTokens) {
      cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }
  return cutIndex;
}

export interface CompactResult<T> {
  compacted: boolean;
  /** 压仓前的上下文估算量。 */
  tokensBefore: number;
  /** 保留边界：第一个逐字保留的条目下标（未压仓时为 null）。 */
  firstKeptIndex: number | null;
  /** 被总结掉的条目数。 */
  summarizedCount: number;
  /** 逐字保留的条目数。 */
  keptCount: number;
  entries: T[];
  summary?: string;
  /** 压仓没发生的原因，便于诊断。 */
  reason?: string;
}

export interface CompactOptions<T extends Compactable> {
  entries: T[];
  policy: CompactionPolicy;
  /** 生成摘要；返回新记忆文本。 */
  summarize: ((entries: T[]) => string | Promise<string>) | null;
  /** 把摘要文本包成一条条目（通常是 role=system / kind=summary）。 */
  makeSummary: ((text: string, at: number) => T) | null;
  /** 忽略触发线强制压一次（上下文超限恢复用）。 */
  force?: boolean;
  now?: number;
}

/**
 * 压仓主流程。未到触发线（且没 force）就地返回；
 * 头部为空、或拿不到 summarize/makeSummary 也返回未压仓——
 * 宁可什么都不做，也不要造一条"摘要 + 原样全部"的条目：
 * 那会让长度 +1、一条没删，下一轮压力依旧，于是每来一条消息压一次。
 */
export async function maybeCompact<T extends Compactable>({
  entries,
  policy,
  summarize,
  makeSummary,
  force = false,
  now = Date.now(),
}: CompactOptions<T>): Promise<CompactResult<T>> {
  const usage = contextUsage(entries);
  const tokensBefore = usage.tokens;

  const unchanged = (reason: string): CompactResult<T> => ({
    compacted: false,
    tokensBefore,
    firstKeptIndex: null,
    summarizedCount: 0,
    keptCount: entries.length,
    entries,
    reason,
  });

  if (!force && !shouldCompact(tokensBefore, policy)) return unchanged('below-threshold');
  if (typeof summarize !== 'function' || typeof makeSummary !== 'function') {
    return unchanged('no-summarizer');
  }

  const cut = findCutPoint(entries, policy.keepRecentTokens);
  if (cut <= 0) return unchanged('nothing-to-summarize');

  // findCutPoint 只会返回 < entries.length 的合法切点，所以尾部一定非空。
  const head = entries.slice(0, cut);
  const tail = entries.slice(cut);

  const summary = await summarize(head);
  const summaryEntry = makeSummary(summary, now);
  return {
    compacted: true,
    tokensBefore,
    firstKeptIndex: 0,
    summarizedCount: head.length,
    keptCount: tail.length,
    entries: [summaryEntry, ...tail],
    summary,
  };
}

export default {
  maybeCompact,
  contextUsage,
  shouldCompact,
  findCutPoint,
  resolvePolicy,
  estimateTokens,
  estimateEntryTokens,
  estimateEntriesTokens,
};
