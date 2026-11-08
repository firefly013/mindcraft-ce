/**
 * `restartApp`：让模型重启整个应用。
 *
 * 工具只负责**排一次重启**。真正退出进程、停掉身体、让主进程收摊的动作在
 * `Agent` 里（它持有 killing 标记和 `cleanKill` 这条唯一退出路径）。这里不直接
 * `process.exit`：工具结果是在 `execute` 返回之后才提交的，当场退出会把这次调用
 * 变成"中断"，模型在重启后的会话里就看不到自己这条回执了。
 *
 * 退出码走 `EVOLVE_RESTART_EXIT_CODE`。主进程把它当整应用重启而不是任务失败，
 * 守护进程据此用磁盘上的新代码重新拉起。普通模式没有这个工具，因为退出之后
 * 没有人负责重启。
 */
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { td } from '../../shared/prompts.js';

export interface RestartAppDeps {
  /**
   * 排一次重启。已经排过（或者进程正在退出）返回 false，这样模型重复调用
   * 只会收到一句事实，不会把退出时间越推越远。
   */
  schedule: () => boolean;
}

/** 回执只报会发生什么，不劝模型"重启前先检查"——那是它自己的决定。 */
export const RESTART_SCHEDULED_TEXT =
  '重启已经安排，进程马上退出，守护进程会用磁盘上的代码重新拉起应用。会话保存在 SQLite 里，重启后接着跑。';

/** 进程已经在退出了（重复调用，或 Stop/退出路径抢先一步）。 */
export const RESTART_ALREADY_TEXT = '重启已经安排过了，进程正在退出。';

export function createRestartAppTool(deps: RestartAppDeps): ToolRegistration {
  return defineTool({
    name: 'restartApp',
    description: td('restartApp'),
    parameters: Type.Object({}, { additionalProperties: false }),
    // 全同步逻辑；`execute` 契约要求 Promise，但不该写 async（require-await）。
    execute: () => {
      if (!deps.schedule()) {
        return Promise.resolve({ content: [{ type: 'text' as const, text: RESTART_ALREADY_TEXT }] });
      }
      return Promise.resolve({
        content: [{ type: 'text' as const, text: RESTART_SCHEDULED_TEXT }],
        // 这一轮不再向模型要请求：回执已经说明进程要退出，继续生成只会被进程
        // 退出打断，在 durable 里留下一次没有意义的续跑。
        control: { terminate: true },
      });
    },
  });
}
