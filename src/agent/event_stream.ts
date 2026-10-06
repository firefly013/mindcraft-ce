/*
 * 事件流：把调度器这一轮交给循环的"未见事件"渲染成给模型看的文本。
 *
 * 为什么必须有：事件是"刚刚发生了什么"的唯一来源。Live State 只
 * 描述"现在是什么样"——模型看不到挨打、卡住、有人开箱子、心跳这些
 * 因果，就会对着一个静止的世界反复重规划，而且不知道自己为什么被
 * 叫醒。调度器已经按等级把该看的事件挑出来了，这个文件只负责
 * 别在组装上下文时把它们丢掉。
 *
 * 未读事件不设总预算（丢一个事件就是丢一份工作），只对单条封顶：
 * 工具回执和聊天记录都可能很长，截断标记会说明截掉了多少。
 */

/** 单条事件正文上限（字符）。 */
export const ENTRY_LIMIT = 1000;

/** loopLog 审计缓冲上限，防止只写不读的台账无声长大。 */
export const EVENT_LOG_LIMIT = 500;

export interface EventEntry {
  seq?: number;
  kind?: string;
  level?: number;
  payload?: unknown;
}

/**
 * 一条事件一行：`#seq kind/Llevel {json}`。
 * JSON 序列化失败（循环引用等）不抛错，降级成标记。
 */
export function formatEventEntry(entry: EventEntry): string {
  const head = `#${entry.seq ?? '?'} ${entry.kind ?? 'Event'}/L${entry.level ?? '?'}`;
  let body: string;
  try {
    body = JSON.stringify(entry.payload) ?? 'null';
  } catch {
    body = '[unserializable]';
  }
  if (body.length > ENTRY_LIMIT) {
    body = `${body.slice(0, ENTRY_LIMIT)}…[truncated ${body.length - ENTRY_LIMIT} chars]`;
  }
  return `${head} ${body}`;
}

/**
 * 渲染整个未见事件块。没有事件返回空串，调用方就不追加空段
 * （不留一个只有标题的空段落骗模型）。
 *
 * **模型路径已不再用它**：事件现在是消息（L1/L2 走 `write`、L3 走 `steer`），
 * 见 `src/runtime/events.ts`。这里留给前端 / 日志 / 调试。
 */
export function renderEvents(entries: readonly EventEntry[] | null | undefined): string {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return ['## 事件', ...entries.map(formatEventEntry)].join('\n');
}

/**
 * 单条事件的**消息文本**。
 *
 * 事件现在作为消息进入上下文，所以要能单独读懂——没有 `#seq`（没有批次了），
 * 但保留 `kind/Llevel` 与 JSON 原文：坐标、伤害量、物品名这些结构化信息
 * 一个都不能改写，模型要靠它们做判断。
 *
 * 形状刻意贴近旧的台账行，模型已经习惯读 `kind/L3 {...}` 这种写法。
 */
export function renderEventText(kind: string, level: number, payload: unknown): string {
  let body: string;
  try {
    body = JSON.stringify(payload) ?? 'null';
  } catch {
    body = '[unserializable]';
  }
  if (body.length > ENTRY_LIMIT) {
    body = `${body.slice(0, ENTRY_LIMIT)}…[truncated ${body.length - ENTRY_LIMIT} chars]`;
  }
  return `[事件] ${kind}/L${level} ${body}`;
}

/**
 * 最后一条 user 消息的正文：事件 → 记忆 → Live 快照。
 * 快照永远收尾——它是这一轮最新鲜的东西，也是缓存前缀的边界。
 * 空块直接丢掉，不留只有标题的空段。
 */
export function composeTail(...blocks: Array<string | null | undefined>): string {
  return blocks.filter((block): block is string => typeof block === 'string' && block !== '').join('\n\n');
}

export default { formatEventEntry, renderEvents, renderEventText, composeTail, ENTRY_LIMIT, EVENT_LOG_LIMIT };
