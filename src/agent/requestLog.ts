/*
 * 请求日志：每次发给模型的 API 请求原文，覆盖写进同一个文件；压仓翻页。
 *
 * 语义（对齐 VLM 的 requestLog，也是本项目的既定设计）：
 *   - 每次请求覆盖写 `request-001.log`，所以那个文件**永远是最近一次请求**，
 *     打开它就知道模型此刻看到了什么；
 *   - 压仓发生时 `rotate()` 把序号 +1，下一次请求落到 `request-002.log`。
 *     于是一个文件 = 一代上下文：从上次压缩到下次压缩之间的所有请求，
 *     且同样只留最后一条。
 *
 * 不写 JSONL、不追加：追加式日志要看"上一轮模型看到了什么"必须往回翻，
 * 而且压缩点与文件边界对不上，复盘时无法判断某条历史是压前还是压后。
 *
 * 写日志永不炸轮次——IO 全吞错。
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { toLlmMessages } from '../utils/text.js';
import type { ChatMessage } from '../types/common.js';

export interface LoggedRequest {
  /** 请求正文（已按角色渲染好的完整请求）。 */
  text: string;
  /** 当轮工具名（只记名，不记 schema，省空间）。 */
  tools: string[];
  /** 第几轮模型调用，便于把日志和会话对上。 */
  round?: number | null;
  at?: number;
}

export interface RequestLog {
  /** 覆盖写当前文件，返回落盘路径；写失败返回 null（绝不抛）。 */
  logRequest(entry: LoggedRequest): string | null;
  /** 压仓：下一次请求写到新文件。返回新文件路径。 */
  rotate(): string;
  /** 当前正在写的文件；第一次写之前为 null。 */
  readonly path: string | null;
}

/** `request-001.log` 的序号格式（三位，和 VLM 一致）。 */
function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/** `2026-10-06 15:04:12` 本地时间，人看的。 */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * 把一次请求渲染成日志正文：**按实际发出的消息列**逐条列出。
 *
 * 纯函数，便于单测锁住格式——日志的意义就是"打开它就知道模型此刻看到了什么"，
 * 格式漂了这份日志就白记了。
 */
export function renderRequestLog({
  systemPrompt,
  messages,
  tail = '',
  imageChars = 0,
}: {
  systemPrompt: string;
  messages: ChatMessage[];
  tail?: string;
  imageChars?: number;
}): string {
  const blocks: string[] = [`[system] ${systemPrompt}`];
  for (const msg of toLlmMessages(messages)) {
    blocks.push(`[${msg.role}] ${msg.content}`);
  }
  if (tail.trim() !== '') blocks.push(`[user] ${tail}`);
  if (imageChars > 0) blocks.push(`[user] <image/jpeg base64, ${imageChars} chars>`);
  return blocks.join('\n\n');
}

export function createRequestLog({
  dir,
  clock = Date.now,
}: {
  dir: string;
  clock?: () => number;
}): RequestLog {
  const logDir = join(dir, 'logs');
  let index = 0;
  let ensured = false;

  const file = (): string => join(logDir, `request-${pad(index)}.log`);

  const ensure = (): boolean => {
    if (ensured) return true;
    try {
      mkdirSync(logDir, { recursive: true });
      ensured = true;
      return true;
    } catch {
      return false;
    }
  };

  return {
    get path(): string | null {
      return index === 0 ? null : file();
    },

    logRequest(entry: LoggedRequest): string | null {
      try {
        if (!ensure()) return null;
        if (index === 0) index = 1;
        const at = entry.at ?? clock();
        const names = entry.tools.join(', ');
        const head = [
          `# request at ${stamp(at)}`,
          `# round: ${entry.round ?? '-'}`,
          `# tools: ${names}`,
          '',
        ].join('\n');
        const target = file();
        writeFileSync(target, `${head}\n${entry.text}\n`, 'utf8');
        return target;
      } catch {
        // 日志写失败不影响轮次。
        return null;
      }
    },

    rotate(): string {
      index = index === 0 ? 1 : index + 1;
      return file();
    },
  };
}

export default { createRequestLog };
