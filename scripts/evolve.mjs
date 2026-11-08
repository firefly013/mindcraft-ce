/**
 * 自进化模式的守护进程。
 *
 * 为什么需要它：restartApp 只把应用变成一次退出码 75 的退出，进程没办法用
 * 自己刚改过的代码重新拉起自己。外面必须有一层循环来做这件事，这层循环只
 * 负责重启、快速失败保护和信号转发，应用内部的行为一概不碰。
 *
 * 退出码 75 的真源是 src/shared/evolution.ts 的 EVOLVE_RESTART_EXIT_CODE。
 * 这里写死一份是为了让脚本不依赖 TypeScript 源码，改常量时两处一起改。
 *
 * 用法是 `npm run evolve -- <启动参数>`，参数原样传给 main.ts。
 * 环境变量 MINDCRAFT_EVOLVE_ENTRY 存在时直接用它当入口（不经 tsx 转译），
 * 给构建产物和单元测试用，测试因此不需要真的去启动 main.ts。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESTART_EXIT_CODE = 75;
const RESTART_DELAY_MS = 500;
const QUICK_RESTART_WINDOW_MS = 10_000;
const MAX_QUICK_RESTARTS = 5;

const args = process.argv.slice(2);
const entryOverride = process.env.MINDCRAFT_EVOLVE_ENTRY;

let child = null;
let restartTimer = null;
let quickRestartCount = 0;
let childStartedAt = 0;
let shuttingDown = false;
let exitCodeAfterChild = 130;

/** 按运行形态拼出这次要执行的命令和参数。 */
function childCommand() {
    if (entryOverride != null && entryOverride !== '') {
        // 构建产物或测试用的入口已经是能直接跑的 JS，不需要也不应该再挂 tsx。
        return { command: process.execPath, childArgs: [entryOverride, ...args] };
    }
    return {
        command: process.execPath,
        childArgs: ['--import', 'tsx', join(ROOT, 'main.ts'), ...args],
    };
}

/** 拉起一次应用。每次重启都走这里，快速失败计数在 handleExit 里维护。 */
function start() {
    const { command, childArgs } = childCommand();
    childStartedAt = Date.now();
    console.log('[evolve] 启动应用。');

    const spawned = spawn(command, childArgs, {
        cwd: ROOT,
        env: { ...process.env, MINDCRAFT_EVOLVE: '1' },
        stdio: 'inherit',
    });
    child = spawned;

    spawned.on('exit', (code, signal) => {
        child = null;
        handleExit(code, signal);
    });
    spawned.on('error', (err) => {
        // spawn 本身就失败时不会有 exit 事件，这里必须自己收尾，否则守护进程会吊死。
        console.error('[evolve] 启动应用失败，' + err.message);
        if (!shuttingDown) {
            shuttingDown = true;
            process.exit(1);
        }
    });
}

/** 子进程结束之后决定下一步：重启、放弃、还是跟着退出。 */
function handleExit(code, signal) {
    if (shuttingDown) {
        process.exit(exitCodeAfterChild);
    }
    if (signal != null) {
        // 子进程被外部信号杀掉，不是 restartApp 的语义，没有理由重启。
        console.log('[evolve] 应用被信号 ' + signal + ' 终止，守护进程一起退出。');
        process.exit(1);
    }
    if (code === RESTART_EXIT_CODE) {
        const runtimeMs = Date.now() - childStartedAt;
        if (runtimeMs >= QUICK_RESTART_WINDOW_MS) {
            // 稳定跑过窗口期再退出 75 是正常进化，不算快速失败。
            quickRestartCount = 0;
        } else {
            quickRestartCount += 1;
            // 和 AgentProcess 的语义保持一致：允许 5 次快速重启，第 6 次不再拉起。
            // 计数器数的是"第几次请求重启"，所以用 > 而不是 >=。
            if (quickRestartCount > MAX_QUICK_RESTARTS) {
                console.error(
                    '[evolve] 连续 ' + MAX_QUICK_RESTARTS + ' 次在 ' +
                    QUICK_RESTART_WINDOW_MS / 1000 + ' 秒内重启，上一次只运行了 ' +
                    runtimeMs + ' 毫秒，放弃重启并退出。',
                );
                process.exit(1);
            }
        }
        console.log('[evolve] 应用以退出码 75 退出，' + RESTART_DELAY_MS + ' 毫秒后重启。');
        restartTimer = setTimeout(() => {
            restartTimer = null;
            start();
        }, RESTART_DELAY_MS);
        return;
    }
    const exitCode = code == null ? 1 : code;
    console.log('[evolve] 应用以退出码 ' + exitCode + ' 退出，守护进程一起退出。');
    process.exit(exitCode);
}

/** 收到退出信号：这个模式下守护进程和子进程是同一条命，一起收掉。 */
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCodeAfterChild = signal === 'SIGTERM' ? 143 : 130;
    if (restartTimer != null) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    if (child != null) {
        console.log('[evolve] 收到 ' + signal + '，给应用发 SIGINT，然后退出。');
        child.kill('SIGINT');
        return;
    }
    process.exit(exitCodeAfterChild);
}

process.on('SIGINT', () => {
    shutdown('SIGINT');
});
process.on('SIGTERM', () => {
    shutdown('SIGTERM');
});

start();
