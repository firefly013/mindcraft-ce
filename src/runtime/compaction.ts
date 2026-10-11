/**
 * 压缩接线：profile 参数 → pi-durable 的 `CompactionPolicy`。
 *
 * 主线正在改的 `src/agent/compaction.ts` 注释里明确写着照 Pi 实现
 * （`github.com/earendil-works/pi`），而 pi-durable 的 `CompactionTask` **就是**
 * Pi 的压仓。所以这一层是**接线**，不是重实现：
 *
 * | profile | → | pi-durable |
 * |---|---|---|
 * | `reserve_tokens` | → | `CompactionPolicy.reserveTokens` |
 * | `keep_recent_tokens` | → | `CompactionPolicy.keepRecentTokens` |
 * | `background_tokens` | → | `CompactionPolicy.backgroundTokens` |
 * | `compaction_enabled` | → | `CompactionPolicy.enabled` |
 * | `context_window` | → | **不进 policy**：窗口由 pi-ai 目录的 `model.contextWindow` 决定 |
 *
 * 主线手写的另外几件事 pi-durable 原生就有，不用接：真实 usage 锚点、
 * 超限压缩后重试一次、只追加摘要不删历史、切点不落在工具回执上。
 */
import type { CompactionPolicy } from '@earendil-works/pi-durable';

/**
 * pi-durable 的内置默认（`DEFAULT_COMPACTION_POLICY`）。
 * 主线的 profile 里 `reserve_tokens: 16384` / `keep_recent_tokens: 20000`
 * 与之一字不差——不是巧合，两边都在照 Pi。
 */
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_BACKGROUND_TOKENS = 32_768;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 从 profile 解析压仓策略。缺字段一律落回 pi-durable 的默认值。 */
export function compactionPolicyFromProfile(profile: unknown): CompactionPolicy {
  const p = (profile ?? {}) as Record<string, unknown>;
  const reserveTokens = positiveNumber(p['reserve_tokens'], DEFAULT_RESERVE_TOKENS);
  return {
    enabled: p['compaction_enabled'] !== false,
    reserveTokens,
    keepRecentTokens: positiveNumber(p['keep_recent_tokens'], DEFAULT_KEEP_RECENT_TOKENS),
    // 后台压缩的提前量。主线还没这个参数，落回 pi-durable 默认。
    backgroundTokens: positiveNumber(p['background_tokens'], DEFAULT_BACKGROUND_TOKENS),
  };
}

/**
 * 触发线：`contextWindow - reserveTokens`（超过它，generation 会阻塞等待压仓）。
 *
 * **窗口来自模型目录，不是 profile。** 旧实现 `resolveContextWindow()` 读不到
 * `profile.context_window` 就回退 `128_000`，触发线成了 `115_200`；而 OpenCode Go
 * 的 `deepseek-v4.1-flash` 真实窗口是 `1_000_000`，触发线本该是 `983_616`——
 * **算错 8.7 倍**，白白过度压缩。
 */
export function compactionTriggerTokens(
  contextWindow: number,
  policy: CompactionPolicy,
): number {
  return contextWindow - policy.reserveTokens;
}
