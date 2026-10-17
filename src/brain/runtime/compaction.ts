/**
 * 压缩接线：profile 参数 → pi-durable 的 `CompactionPolicy`。
 *
 * 主线（重构前的 `agent/compaction.ts`）注释里明确写着照 Pi 实现
 * （`github.com/earendil-works/pi`），而 pi-durable 的 `CompactionTask` **就是**
 * Pi 的上下文压缩。所以这一层是**接线**，不是重实现：
 *
 * | profile | → | pi-durable |
 * |---|---|---|
 * | `compaction.reserveTokens` | → | `CompactionPolicy.reserveTokens` |
 * | `compaction.keepRecentTokens` | → | `CompactionPolicy.keepRecentTokens` |
 * | `compaction.backgroundTokens` | → | `CompactionPolicy.backgroundTokens` |
 * | `compaction.enabled` | → | `CompactionPolicy.enabled` |
 * | 模型窗口 | → | **不进 policy**：窗口由 `providers.json` / 内置目录的 `contextWindow` 决定 |
 *
 * 主线手写的另外几件事 pi-durable 原生就有，不用接：真实 usage 锚点、
 * 超限压缩后重试一次、只追加摘要不删历史、切点不落在工具回执上。
 */
import type { CompactionPolicy } from '@earendil-works/pi-durable';

/**
 * pi-durable 的内置默认（`DEFAULT_COMPACTION_POLICY`）。
 * 主线 profile 的 `compaction.reserveTokens: 16384` / `keepRecentTokens: 20000`
 * 与之一字不差——不是巧合，两边都在照 Pi。
 */
export const DEFAULT_RESERVE_TOKENS = 16_384;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_BACKGROUND_TOKENS = 32_768;

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 从 profile 解析上下文压缩策略。缺字段一律落回 pi-durable 的默认值。 */
export function compactionPolicyFromProfile(profile: unknown): CompactionPolicy {
  const source = (profile ?? {}) as Record<string, unknown>;
  const compaction = (source['compaction'] ?? {}) as Record<string, unknown>;
  return {
    enabled: compaction['enabled'] !== false,
    reserveTokens: positiveNumber(compaction['reserveTokens'], DEFAULT_RESERVE_TOKENS),
    keepRecentTokens: positiveNumber(compaction['keepRecentTokens'], DEFAULT_KEEP_RECENT_TOKENS),
    // 后台压缩的提前量。主线还没这个参数，落回 pi-durable 默认。
    backgroundTokens: positiveNumber(compaction['backgroundTokens'], DEFAULT_BACKGROUND_TOKENS),
  };
}

/**
 * 触发线：`contextWindow - reserveTokens`（超过它，generation 会阻塞等待上下文压缩）。
 *
 * **窗口来自模型定义，不是 profile。** 旧实现 `resolveContextWindow()` 读不到
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
