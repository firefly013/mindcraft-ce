/**
 * 请求日志：**一个文件 = 一代上下文**（`agent-design.md` §10 D1–D3）。
 *
 * 主线那套是「每次请求覆盖写，压仓时翻页 `request-001` → `002`」。
 * pi-durable 没有这个概念——它有 `conversation.entries()` 和 `pi.usage`，
 * 是事件流而不是请求快照。所以这里用两个 hook 把同一组语义搭出来：
 *
 * | hook | 干什么 |
 * |---|---|
 * | `GenerationTask.beforeRequest` | 把**这次真正发出去的消息列**覆盖写进当前页 |
 * | `CompactionTask.beforeCompact` | 翻页（压仓 = 新一代上下文） |
 *
 * ## 为什么是覆盖写、不是追加
 *
 * 追加式日志要回答"上一轮模型看到了什么"必须往回翻，而且压缩点和文件边界
 * 对不上——复盘时分不清某条历史是压前还是压后。一文件一代上下文，打开就是
 * 那一代的全貌。
 *
 * ## D3：日志 = 模型实际收到的消息列
 *
 * `beforeRequest` 拿到的 `request.messages` **已经是模型形状**（pi-durable
 * 的投影早就把 `kind/level/at/usage` 这些内部字段剥掉了），所以这里不需要
 * 再过滤一遍——原样写就是模型看到的。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CompactionTask, GenerationTask, hook, type HookRegistration } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';

/** 页号补零到 3 位：`request-001.log`。 */
function pageFile(dir: string, page: number): string {
  return join(dir, `request-${String(page).padStart(3, '0')}.log`);
}

/** 一条消息的正文（多行缩进，别把日志撑散）。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.replace(/\n/g, '\n  ');
  try {
    return JSON.stringify(content) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

/** 把一条消息压成日志里的几行。 */
function renderMessage(message: Message): string {
  const lines: string[] = [`[${String(message.role)}] ${contentText(message.content)}`];
  // 系统消息的提示词正文在 `sections` 里，**不在 `content`**：pi-ai 的
  // `SystemMessage` 只有 `content`（基础提示）+ `sections`（具名段落，按顺序
  // 逐字渲染在后面）。只打 `content` 会让日志里出现一个空的 `[system]`，
  // D3（日志 = 模型实际收到的消息列）就不成立了。
  const sections = (message as { sections?: Record<string, string | null> }).sections;
  for (const [key, value] of Object.entries(sections ?? {})) {
    lines.push(`  [section:${key}]`);
    if (value == null) {
      lines.push('    (removed)');
      continue;
    }
    for (const line of value.split('\n')) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

export interface RequestLogOptions {
  /** 落盘目录，通常是 `./bots/<name>/logs`。 */
  dir: string;
  /** 工具名列表，写进日志头。 */
  tools: () => readonly string[];
  /** 注入时钟，便于测试。 */
  now?: () => Date;
}

export interface RequestLogSink {
  /** 写一代上下文（**覆盖写**当前页）。 */
  writeRequest(messages: readonly Message[]): void;
  /** 翻页：压仓发生，下一代上下文开始。 */
  nextPage(): void;
  /** 当前页号（从 1 开始）。 */
  readonly page: number;
  /** 当前页文件路径。 */
  readonly file: string;
}

export function createRequestLogSink(options: RequestLogOptions): RequestLogSink {
  const now = options.now ?? ((): Date => new Date());
  let page = 1;
  /** 本页内第几次请求（就是日志头的 `# round`）。 */
  let round = 0;

  const sink: RequestLogSink = {
    get page(): number {
      return page;
    },
    get file(): string {
      return pageFile(options.dir, page);
    },
    writeRequest(messages: readonly Message[]): void {
      round += 1;
      const header = [
        `# request at ${now().toISOString()}`,
        `# round ${round}`,
        `# tools ${options.tools().join(', ')}`,
      ].join('\n');
      const body = messages.map(renderMessage).join('\n\n');
      try {
        mkdirSync(options.dir, { recursive: true });
        writeFileSync(sink.file, `${header}\n\n${body}\n`);
      } catch (err: unknown) {
        // 日志写不进去不该拖垮 agent：这是旁路，不是主链路。
        console.error('request log write failed:', err instanceof Error ? err.message : String(err));
      }
    },
    nextPage(): void {
      page += 1;
      round = 0;
    },
  };
  return sink;
}

/**
 * 写请求的 hook。**返回 `undefined`**：只看不改，请求原样发出去。
 */
export function requestLogHook(sink: RequestLogSink): HookRegistration {
  return hook(GenerationTask, {
    beforeRequest: (request) => {
      sink.writeRequest(request.messages);
      return undefined;
    },
  });
}

/**
 * 翻页的 hook。**返回 `undefined`**：不拒绝、不提供摘要，用框架默认的压仓。
 */
export function compactionPageHook(sink: RequestLogSink): HookRegistration {
  return hook(CompactionTask, {
    beforeCompact: () => {
      sink.nextPage();
      return undefined;
    },
  });
}
