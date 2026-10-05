/*
 * `Baritone` 工具：一条机器人命令行（不带 #），查询直返，动作占通道。
 *
 * 语义对齐 VLM-Bot 的 Baritone handler，线头换成我们自己的：
 *   - 查询类（只看不动）：不占通道，直接回结果；
 *   - 控制类（pause/resume/cancel/stop/forcecancel 及别名）：拒绝，
 *     停机是 Stop() 的活，执行器自己的刹车不递到模型手里；
 *   - 其他：认领通道后同步执行，起了新任务就后台盯着
 *     （500ms 看一次 runningTasks），任务排空且 generation
 *     没过期才放行 + Tool 事件上报；过期就地丢弃。
 *
 * 命令输出靠临时借用 `baritone.log` 抓（命令层写日志的正規下水道），
 * finally 原样归还。命令层自己会报错，这里不翻译聊天文本。
 */

import { Scheduler } from './scheduler.js';
import type { LoopToolResult } from './loop.js';

/** 只读命令：不占通道，直接回结果。`paused` 只读状态。 */
export const BARITONE_QUERY_COMMANDS: readonly string[] = Object.freeze([
  'look', 'inspect', 'scan', 'inventory', 'actions', 'capabilities',
  'eta', 'version', 'help', '?', 'paused', 'waypoints', 'waypoint', 'wp',
]);

/** 执行器自己的刹车：模型永远够不着，停机走 Stop()。 */
export const BARITONE_BLOCKED_COMMANDS: readonly string[] = Object.freeze([
  'pause', 'p', 'paws', 'resume', 'r', 'unpause', 'unpaws',
  'cancel', 'c', 'stop', 'forcecancel',
]);

/** `goto 100 64 200` → `goto`；空行 → null。 */
export function baritoneCommandNameOf(command: unknown): string | null {
  const line = String(command ?? '').trim().replace(/^#+/, '');
  if (line === '') return null;
  const first = line.split(/\s+/)[0];
  return (first ?? '').toLowerCase();
}

export interface BaritoneCommandManager {
  execute: (line: string) => void;
  getCommand?: (name: string) => unknown;
}

export interface BaritoneHandle {
  getCommandManager?: () => BaritoneCommandManager | null;
  runningTasks?: () => string[];
  log?: (text: string) => void;
}

export interface BaritoneToolDeps {
  getBaritone: () => BaritoneHandle | null;
  scheduler: Scheduler;
  notify: (payload: { call: string; result: LoopToolResult }) => void;
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

function runningTaskNames(baritone: BaritoneHandle): string[] {
  try {
    return baritone.runningTasks?.() ?? [];
  } catch {
    return [];
  }
}

function runCaptured(
  baritone: BaritoneHandle,
  manager: BaritoneCommandManager,
  command: string,
): { lines: string[]; error?: string } {
  const lines: string[] = [];
  const hadLog = 'log' in Object(baritone);
  const prev = baritone.log;
  baritone.log = (text: string) => {
    lines.push(String(text));
  };
  let error: string | null = null;
  try {
    manager.execute(String(command).trim().replace(/^#+/, ''));
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (!hadLog) {
    delete baritone.log;
  } else {
    baritone.log = prev;
  }
  return error == null ? { lines } : { lines, error };
}

export function createBaritoneTool(deps: BaritoneToolDeps): (args: unknown) => Promise<LoopToolResult> {
  if (typeof deps.getBaritone !== 'function') throw new Error('createBaritoneTool needs getBaritone');
  const scheduler = deps.scheduler;
  const notify = deps.notify;
  const pollMs = deps.pollMs ?? 500;
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((t: unknown): void => clearInterval(t as NodeJS.Timeout));
  let seq = 0;

  // eslint-disable-next-line require-await -- handler interface is promise-based; sync paths resolve immediately
  return async function baritoneTool(args: unknown): Promise<LoopToolResult> {
    const command = (args as { command?: unknown } | null)?.command;
    const baritone = deps.getBaritone();
    if (baritone == null) {
      return { status: 'rejected', code: 'NO_BARITONE', reason: 'Baritone is not attached.' };
    }
    const name = baritoneCommandNameOf(command);
    if (name == null) {
      return { status: 'rejected', code: 'BAD_COMMAND', reason: 'Baritone needs a command line.' };
    }
    if (BARITONE_BLOCKED_COMMANDS.includes(name)) {
      return { status: 'rejected', code: 'CONTROL_BLOCKED', reason: `${name} is an executor control; use Stop().` };
    }
    const manager = baritone.getCommandManager?.() ?? null;
    if (manager == null || typeof manager.execute !== 'function') {
      return { status: 'rejected', code: 'NO_COMMANDS', reason: 'No command manager is attached.' };
    }
    if (manager.getCommand?.(name) == null) {
      return { status: 'rejected', code: 'UNKNOWN_COMMAND', reason: `No such robot command: ${name}.` };
    }

    if (BARITONE_QUERY_COMMANDS.includes(name)) {
      const output = runCaptured(baritone, manager, String(command));
      if (output.error != null) {
        return { status: 'rejected', code: 'EXEC_FAILED', reason: output.error };
      }
      return { status: 'completed', data: { command, output: output.lines.join('\n') } };
    }

    const claim = scheduler.startAction(`baritone-${++seq}`);
    if (!claim.accepted) {
      return { status: 'rejected', code: claim.code ?? 'ACTION_BUSY', reason: 'Another action runs; call Stop() first.' };
    }
    const actionId = claim.actionId;
    const generation = claim.generation ?? 0;
    const before = new Set(runningTaskNames(baritone));
    const output = runCaptured(baritone, manager, String(command));
    if (output.error != null) {
      scheduler.releaseAction();
      return { status: 'rejected', code: 'EXEC_FAILED', reason: output.error };
    }
    const started = runningTaskNames(baritone).filter((t) => !before.has(t));
    if (started.length === 0) {
      scheduler.releaseAction();
      return { status: 'completed', data: { command, output: output.lines.join('\n') } };
    }
    const watched = new Set(started);
    const timer: unknown = setTimer(() => {
      if (!scheduler.isCurrent(generation)) {
        clearTimer(timer);
        return;
      }
      const still = new Set(runningTaskNames(baritone));
      for (const t of watched) {
        if (still.has(t)) return;
      }
      clearTimer(timer);
      scheduler.releaseAction();
      notify({
        call: 'Baritone',
        result: {
          status: 'completed',
          data: { command, output: output.lines.join('\n') },
        },
      });
    }, pollMs);
    const unref = (timer as { unref?: unknown }).unref;
    if (typeof unref === 'function') {
      try {
        (unref as () => void).call(timer);
      } catch {
        // 计时器桩没 unref 也行，上报不依赖它。
      }
    }
    return { status: 'accepted', data: { action_id: actionId, generation } };
  };
}

export default { createBaritoneTool, baritoneCommandNameOf, BARITONE_QUERY_COMMANDS, BARITONE_BLOCKED_COMMANDS };
