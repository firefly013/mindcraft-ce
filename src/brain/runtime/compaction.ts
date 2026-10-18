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

/**
 * reserve 至少要占上下文窗口的这个比例。**这是防死锁的硬底线。**
 *
 * 真实事故（2026-10-18 16:49，overnight_b）：触发线 = `1_000_000 − 16_384 = 983_616`，
 * 而 pi-durable 判断"超没超"用的是 `estimateContext()` **估算**值——实测它比真实
 * token 数**低 14% 以上**（真实 1.14M 时估算仍未过 983K）。于是阈值压缩永不触发；
 * 等到请求被上游以 `maximum context length is 1048576` 拒绝时，走的是"溢出"路径：
 * 先压缩再重试——**而压缩要总结的那段前缀本身就是 1.1M，总结请求同样 400**。
 * 结果：生成永远失败、压缩永远做不完、prompt 还在长——bot 卡死 20 分钟，
 * 只有重置会话才能救回来（`summarize` 检查点一直停在那里）。
 *
 * 留 20% 余量后，触发线降到窗口的 80%，即使估算偏低 20% 也能在硬上限之前先压缩；
 * 而压缩时的前缀 ≈ 窗口的 80% − keepRecent，仍装得进一次总结请求。宁可多压缩几次，
 * 也不能让 bot 变成砖。
 */
export const MIN_RESERVE_RATIO = 0.2;

/**
 * reserve 的**上限**：窗口的一半。对抗验证（tmp/verify/compaction_floor.probe.test.ts）发现
 * 只抬不封顶会出事——8K 窗口下 reserve 被抬到 16_384（**大于窗口本身**），
 * 触发线成了 `−8192`；而且 `keepRecentTokens=20_000 > window − reserve`，pi-durable 的
 * `selectCut` 永远返回 undefined，于是阈值压缩和**溢出压缩**都选不出切点，
 * 溢出直接变成 "An overflow is never retried" ——**又是 F-21 那个形状，只是换了个窗口大小**。
 * 本机跑的是 1M 窗口所以今晚没踩到，但这段代码是通用的，不能只在 1M 下正确。
 */
export const MAX_RESERVE_RATIO = 0.5;

/** 从 profile 解析上下文压缩策略。缺字段一律落回 pi-durable 的默认值。 */
export function compactionPolicyFromProfile(profile: unknown, contextWindow?: number): CompactionPolicy {
  const source = (profile ?? {}) as Record<string, unknown>;
  const compaction = (source['compaction'] ?? {}) as Record<string, unknown>;
  const configured = positiveNumber(compaction['reserveTokens'], DEFAULT_RESERVE_TOKENS);
  const configuredKeepRecent = positiveNumber(compaction['keepRecentTokens'], DEFAULT_KEEP_RECENT_TOKENS);
  const hasWindow =
    typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0;
  // 窗口已知时：reserve 抬到窗口 20% 之上、**封顶在窗口 50%**（既留足余量，又保证触发线为正）。
  const floor = hasWindow ? Math.round(contextWindow * MIN_RESERVE_RATIO) : 0;
  const cap = hasWindow ? Math.round(contextWindow * MAX_RESERVE_RATIO) : Number.POSITIVE_INFINITY;
  const reserveTokens = Math.min(Math.max(configured, floor), Math.max(cap, 1));
  // `keepRecentTokens` 必须给"窗口 − reserve"留得下：否则 pi-durable 选不出切点，
  // 压缩（含溢出压缩）永远做不成。收敛到剩余空间的 50%，1M 窗口下 20_000 不变。
  const headroom = hasWindow ? contextWindow - reserveTokens : Number.POSITIVE_INFINITY;
  const keepRecentTokens = Number.isFinite(headroom)
    ? Math.max(1, Math.min(configuredKeepRecent, Math.floor(headroom * 0.5)))
    : configuredKeepRecent;
  return {
    enabled: compaction['enabled'] !== false,
    reserveTokens,
    keepRecentTokens,
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
