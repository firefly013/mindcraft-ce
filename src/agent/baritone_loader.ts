/*
 * Baritone 包加载器：VLM-Bot 的 mineflayer-baritone 是本地包
 * （npm 整树重解会触发无关的 eslint peer 冲突），这里按目录
 * 绝对路径动态 import，`BARITONE_DIR` 环境变量可覆盖默认位置。
 */

import { pathToFileURL } from 'url';
import path from 'path';

export function defaultBaritoneDir(): string {
  return path.resolve('..', 'VLM-Bot', 'packages', 'mineflayer-baritone');
}

export interface BaritoneHandle {
  getCommandManager?: () => {
    execute: (line: string) => void;
    getCommand?: (name: string) => unknown;
  } | null;
  runningTasks?: () => string[];
  log?: (text: string) => void;
}

export interface BaritonePackage {
  attach: (bot: unknown, options?: Record<string, unknown>) => BaritoneHandle;
}

export async function loadBaritonePackage(dir?: string): Promise<BaritonePackage> {
  const base = dir ?? process.env['BARITONE_DIR'] ?? defaultBaritoneDir();
  const entry = pathToFileURL(path.join(base, 'src', 'index.js')).href;
  const mod = (await import(entry)) as { attach?: unknown };
  if (typeof mod.attach !== 'function') {
    throw new Error(`mineflayer-baritone at ${base} does not export attach()`);
  }
  return { attach: mod.attach as BaritonePackage['attach'] };
}

/**
 * 给 bot 接上 Baritone，失败返回 null（工具侧报 NO_BARITONE，
 * 不炸启动）。attach 包 bot.chat 包裹（只拦 # 前缀行），
 * 正常聊天原样放行。
 */
export async function attachBaritone(bot: unknown): Promise<BaritoneHandle | null> {
  try {
    const pkg = await loadBaritonePackage();
    const handle = pkg.attach(bot, {});
    return handle ?? null;
  } catch (err: unknown) {
    console.warn('Baritone attach failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export default { loadBaritonePackage, defaultBaritoneDir, attachBaritone };
