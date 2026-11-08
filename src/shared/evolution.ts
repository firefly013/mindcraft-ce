/**
 * 自进化模式的开关与重启退出码。
 *
 * 模式只由 `scripts/evolve.mjs`（`npm run evolve`）打开：那个守护进程负责在
 * 应用退出之后把它重新拉起来。没有守护进程的话，restartApp 只会把应用关掉，
 * 所以这两项放在共享层而不是各自写死：大脑按开关装工具，AgentProcess 按退出码
 * 认出"这是一次整应用重启"，守护进程写死同一个数字（它不加载 TS，import 不了）。
 */

/** 守护进程传给应用的环境变量；值为 `'1'` 时打开自进化模式。 */
export const EVOLVE_MODE_ENV = 'MINDCRAFT_EVOLVE';

/**
 * 模型请求重启应用时的退出码。
 *
 * 选 75 是因为它既不是 0（正常退出）也不是 1 和 2（AgentProcess 的崩溃/任务失败
 * 语义）。主线看到它会把整棵进程树收掉并退出 75，守护进程据此重启。
 */
export const EVOLVE_RESTART_EXIT_CODE = 75;

/**
 * 工具调用返回之后等多久再退出。
 *
 * 工具回执要落进 SQLite 才能被重启后的会话看到，而 durable 的工具结果是在
 * `execute` 返回之后才提交的。留 1.5 秒足够走完提交和下一次请求的准备；
 * 就算真的在请求中途退出，durable 也会在重启后接着跑那一轮。
 */
export const EVOLVE_RESTART_DELAY_MS = 1500;

/** 当前进程是否在自进化模式下。参数只为单测注入环境，生产不传。 */
export function isEvolutionMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EVOLVE_MODE_ENV] === '1';
}
