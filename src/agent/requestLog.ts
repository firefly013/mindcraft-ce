/*
 * 请求日志：每轮发给模型的请求原文落盘，方便复盘"当时模型看到了什么"。
 *
 * 设计对齐 VLM 的 requestLog：append-only JSONL，需要时 rotate
 * 切走（比如压仓之后另起一段）。写日志永不炸轮次——IO 全吞错。
 */

import { appendFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join } from 'path';

export interface LoggedRequest {
  at: number;
  /** 提示词正文（含 Live State 尾巴）。 */
  text: string;
  /** 当轮工具名（只记名，不记全 schema，省空间）。 */
  tools: string[];
}

export interface RequestLog {
  logRequest(entry: Omit<LoggedRequest, 'at'> & { at?: number }): void;
  rotate(): string | null;
}

export function createRequestLog({ dir }: { dir: string }): RequestLog {
  const file = join(dir, 'requests.jsonl');
  const ensureDir = (): boolean => {
    try {
      mkdirSync(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  };

  return {
    logRequest(entry) {
      try {
        if (!ensureDir()) return;
        const line = JSON.stringify({ at: Date.now(), ...entry });
        appendFileSync(file, `${line}\n`, 'utf8');
      } catch {
        // 日志写失败不影响轮次。
      }
    },
    rotate() {
      try {
        if (!existsSync(file)) return null;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = join(dir, `requests-${stamp}.jsonl`);
        renameSync(file, backup);
        return backup;
      } catch {
        return null;
      }
    },
  };
}

export default { createRequestLog };
