import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindserver/mindserver.js';
import { BODY_PORT_BASE } from './body_launcher.js';

/**
 * 子进程入口随运行形态而定：源码形态（tsx main.ts）起 .ts，
 * 构建产物（node dist/main.js）起同目录的 .js。开发态用 node
 * 自带的 `--import tsx` 转译，不依赖 shell 或 .bin shim，
 * Windows 也能直接 spawn（tsx 是 devDependencies，构建产物
 * 走纯 node 分支，不受影响）。
 */
function childCommand(): { exec: string; prefixArgs: string[]; entry: string } {
    const tsEntry = fileURLToPath(new URL('../index.ts', import.meta.url));
    if (existsSync(tsEntry)) {
        return { exec: process.execPath, prefixArgs: ['--import', 'tsx'], entry: tsEntry };
    }
    return {
        exec: process.execPath,
        prefixArgs: [],
        entry: fileURLToPath(new URL('../index.js', import.meta.url)),
    };
}

/**
 * 主进程只派生**大脑**。身体由大脑自己拉（见 `body_launcher.ts`）：
 * 身体要的 settings 只有大脑手上有（它从 MindServer 取回来的那一份）。
 */
function bodyPortArg(count_id: number): string[] {
    return ['-b', String(BODY_PORT_BASE + count_id)];
}

/**
 * 启动后多久内退出算快速崩溃。快速崩溃不再永久放弃，而是做有限次
 * 指数退避重启；超过上限才停手，避免整晚空转刷日志。
 */
export const QUICK_EXIT_WINDOW_MS = 10_000;

/** 连续快速崩溃最多自动重启多少次。 */
export const MAX_QUICK_RESTARTS = 5;

/** 退避基数与上限。 */
export const RESTART_BACKOFF_BASE_MS = 1_000;
export const RESTART_BACKOFF_MAX_MS = 30_000;

/**
 * 第 N 次快速崩溃对应的退避时长：1s、2s、4s、8s、16s……上限 30s。
 *
 * 导出成纯函数是为了测试能直接盯住退避曲线，不用真的等时间。
 */
export function quickRestartBackoffMs(quickCrashCount: number): number {
    const exponent = Math.max(0, quickCrashCount - 1);
    return Math.min(RESTART_BACKOFF_BASE_MS * 2 ** exponent, RESTART_BACKOFF_MAX_MS);
}

/** spawn 的最小依赖面；测试注入假子进程时用得到。 */
export type SpawnChildProcess = (
    command: string,
    args: string[],
    options: { stdio: 'inherit' },
) => ChildProcess;

/**
 * AgentProcess 的可注入依赖。生产环境用默认实现；测试用它替换
 * spawn / 定时器 / process.exit，把快速崩溃到重启退避的流程变成
 * 确定性验证。
 */
export interface AgentProcessDependencies {
    spawn: SpawnChildProcess;
    now: () => number;
    setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
    exit: (code: number) => void;
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string | Error) => void;
}

const defaultDependencies: AgentProcessDependencies = {
    spawn: (command, args, options) => spawn(command, args, options),
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    exit: (code) => process.exit(code),
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
};

export class AgentProcess {
    name: string;
    port: number | string;
    process?: ChildProcess;
    count_id?: number;
    running?: boolean;

    private readonly deps: AgentProcessDependencies;
    /** 连续启动后不到 10s 就退出的次数；稳定运行一次后清零。 */
    private quickCrashCount = 0;
    /** 这个 Agent 已经自动重启过多少次（含普通重启与退避重启）。 */
    private restartCount = 0;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private stopRequested = false;
    private spawnedAt = 0;

    constructor(
        name: string,
        port: number | string,
        dependencies: Partial<AgentProcessDependencies> = {},
    ) {
        this.name = name;
        this.port = port;
        this.deps = { ...defaultDependencies, ...dependencies };
    }

    /**
     * 初次启动（或用户手动重启）：清零自动重启计数。
     *
     * 内部自动重启走 spawnChild，不会碰计数——否则连续快速崩溃永远
     * 到不了上限。
     */
    start(
        load_memory: boolean | string = false,
        init_message: string | null = null,
        count_id = 0,
    ): void {
        this.stopRequested = false;
        this.quickCrashCount = 0;
        this.restartCount = 0;
        this.clearRestartTimer();
        this.spawnChild(load_memory, init_message, count_id);
    }

    /** 真正派生一个子进程并挂好 exit / error 处理。 */
    private spawnChild(
        load_memory: boolean | string,
        init_message: string | null,
        count_id: number,
    ): void {
        this.count_id = count_id;
        this.running = true;

        const child = childCommand();
        const args: string[] = [...child.prefixArgs, child.entry, this.name];
        args.push('-n', this.name);
        args.push('-c', String(count_id));
        if (load_memory)
            args.push('-l', String(load_memory));
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', String(this.port));
        args.push(...bodyPortArg(count_id));

        const agentProcess = this.deps.spawn(child.exec, args, {
            stdio: 'inherit', // stdio:inherit 已覆盖 stdout/stderr，原 JS 多余的 stderr 字段被 spawn 忽略
        });

        this.spawnedAt = this.deps.now();

        agentProcess.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
            this.handleExit(agentProcess, code, signal, count_id);
        });

        agentProcess.on('error', (err: Error) => {
            this.deps.error('Agent process error for ' + this.name + ': ' + err.message);
        });

        this.process = agentProcess;
    }

    private handleExit(
        agentProcess: ChildProcess,
        code: number | null,
        signal: NodeJS.Signals | null,
        count_id: number,
    ): void {
        const runtimeMs = this.deps.now() - this.spawnedAt;
        this.running = false;
        if (this.process === agentProcess) this.process = undefined;
        logoutAgent(this.name);

        this.deps.log(
            'Agent ' + this.name + ' exited after ' + runtimeMs + 'ms ' +
            '(code=' + (code ?? 'null') + ', signal=' + (signal ?? 'null') + ').',
        );

        // 保留语义：code > 1 是任务级失败，结束整个主进程，不自动重启。
        if (code !== null && code > 1) {
            this.clearRestartTimer();
            this.deps.log(
                'Agent ' + this.name + ' ended the task with exit code ' + code + '; not restarting.',
            );
            this.deps.exit(code);
            return;
        }

        // 主动 stop()（或用户 Ctrl+C 传到子进程）不重启。
        if (this.stopRequested || signal === 'SIGINT') {
            this.deps.log('Agent ' + this.name + ' was stopped intentionally; not restarting.');
            return;
        }

        // code 0 = 正常退出，维持原语义不重启。
        if (code === 0) {
            this.deps.log('Agent ' + this.name + ' exited cleanly (code 0); not restarting.');
            return;
        }

        this.scheduleRestart(runtimeMs, count_id);
    }

    private scheduleRestart(runtimeMs: number, count_id: number): void {
        this.restartCount += 1;

        if (runtimeMs < QUICK_EXIT_WINDOW_MS) {
            this.quickCrashCount += 1;
            if (this.quickCrashCount > MAX_QUICK_RESTARTS) {
                this.deps.error(
                    'Agent ' + this.name + ' crashed ' + this.quickCrashCount + ' times within ' +
                    QUICK_EXIT_WINDOW_MS + 'ms; reached the limit of ' + MAX_QUICK_RESTARTS + ' ' +
                    'quick restarts and will not restart again.',
                );
                return;
            }

            const delayMs = quickRestartBackoffMs(this.quickCrashCount);
            this.deps.warn(
                'Agent ' + this.name + ' crashed quickly (' + runtimeMs + 'ms after start, ' +
                'quick crash ' + this.quickCrashCount + '/' + MAX_QUICK_RESTARTS + '). ' +
                'Restart #' + this.restartCount + ' scheduled in ' + delayMs + 'ms.',
            );

            this.restartTimer = this.deps.setTimer(() => {
                this.restartTimer = undefined;
                if (this.stopRequested) return;
                this.deps.log(
                    'Restarting agent ' + this.name + ' now ' +
                    '(restart #' + this.restartCount + ', after ' + delayMs + 'ms backoff).',
                );
                this.spawnChild(true, 'Agent process restarted.', count_id);
            }, delayMs);
            return;
        }

        // 稳定运行超过窗口：这次不算快速崩溃，立刻重启并清空快速崩溃计数。
        this.quickCrashCount = 0;
        this.deps.log(
            'Agent ' + this.name + ' ran for ' + runtimeMs + 'ms before exit; ' +
            'restart #' + this.restartCount + ' starting immediately.',
        );
        this.spawnChild(true, 'Agent process restarted.', count_id);
    }

    stop(): void {
        this.stopRequested = true;
        if (this.restartTimer !== undefined) {
            this.clearRestartTimer();
            this.deps.log('Cancelled pending restart for agent ' + this.name + '.');
        }
        if (!this.running) return;
        this.process?.kill('SIGINT');
    }

    forceRestart(): void {
        if (this.running && this.process && !this.process.killed) {
            this.deps.log(
                'Agent process for ' + this.name + ' is still running. Attempting to force restart.',
            );

            const restartTimeout = this.deps.setTimer(() => {
                this.deps.warn('Agent ' + this.name + ' did not stop in time. It might be stuck.');
            }, 5000); // 5 seconds to exit

            this.process.once('exit', () => {
                this.deps.clearTimer(restartTimeout);
                this.deps.log('Stopped hanging agent ' + this.name + '. Now restarting.');
                this.start(true, 'Agent process restarted.', this.count_id ?? 0);
            });
            this.stop(); // sends SIGINT
        } else {
            this.start(true, 'Agent process restarted.', this.count_id ?? 0);
        }
    }

    private clearRestartTimer(): void {
        if (this.restartTimer === undefined) return;
        this.deps.clearTimer(this.restartTimer);
        this.restartTimer = undefined;
    }
}
