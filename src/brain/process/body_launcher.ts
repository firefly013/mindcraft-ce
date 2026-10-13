/**
 * 身体进程的拉起与善后（由**大脑**负责）。
 *
 * ## 为什么是大脑拉身体，而不是主进程拉两个
 *
 * settings 的来源是 MindServer（主进程 `registerAgent` 存进去、agent 用
 * `get-settings` 取出来）。**只有大脑会走那条路**——身体不注册身份。
 * 所以身体要拿到 host/port/version，最省事、最少真相来源的做法是：
 * 大脑先把 settings 取到手，再原样转交给身体。
 *
 * 代价是身体的生死挂在脑上：脑死 → 身体必须跟着死（见 `stopBody`），
 * 否则会留下一堆没人叫停的 Mineflayer 连接在服务器里晃。
 *
 * ## 为什么走环境变量传 settings
 *
 * JSON 里有引号、Windows 命令行转义规则又各版本不同；环境变量是唯一
 * 在 Windows/macOS/Linux 上都不用转义的正经通道。
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import settings from '../../shared/settings.js';

/**
 * 与 `AgentProcess.childCommand` 同一个套路：源码形态起 .ts（走 tsx），
 * 构建产物起同目录 .js。别在这里引 shell，Windows 上会炸。
 *
 * 身体入口住在**另一个目录**（`src/body/index.ts`）——这条 URL 是身体与大脑
 * 之间唯一的进程边界指针，别指望它在 import 图里出现。
 */
function bodyCommand(): { exec: string; prefixArgs: string[]; entry: string } {
    const tsEntry = fileURLToPath(new URL('../../body/index.ts', import.meta.url));
    if (existsSync(tsEntry)) {
        return { exec: process.execPath, prefixArgs: ['--import', 'tsx'], entry: tsEntry };
    }
    return {
        exec: process.execPath,
        prefixArgs: [],
        entry: fileURLToPath(new URL('../../body/index.js', import.meta.url)),
    };
}

/** 身体协议端口：固定基数 + agent 序号，两侧各自算得出来，不用握手协商。 */
export const BODY_PORT_BASE = 9400;

export function bodyPortFor(countId: number): number {
    return BODY_PORT_BASE + countId;
}

let bodyProcess: ChildProcess | null = null;

/**
 * 身体进程结束时的退出信息；`null` = 还活着（或还没起来）。
 *
 * **存在的理由**：`RemoteBody.connectWithRetry` 会等最多 120 秒。身体要是
 * 在**开门之前**就崩了（写 Java 身体时这是常态），那 120 秒纯属白等——
 * 而报出来的错（"body did not come up within 120000ms"）指向的是错误的方向。
 */
let bodyExit: { code: number | null; signal: string | null } | null = null;

/** 身体进程已经结束的话，给出它是怎么结束的。 */
export function bodyExitInfo(): { code: number | null; signal: string | null } | null {
    return bodyExit;
}

/**
 * 拉起身体进程。
 *
 * `stdio: 'inherit'` 与主进程起 agent 的做法一致——身体的日志要和大脑的混在
 * 同一股输出里，否则排障时要在两个终端之间对时间戳。
 */
export function startBody(name: string, countId: number, port: number): void {
    if (bodyProcess != null) return;
    bodyExit = null;
    const child = bodyCommand();
    const args: string[] = [...child.prefixArgs, child.entry, '-n', name, '-c', String(countId), '--body-port', String(port)];
    bodyProcess = spawn(child.exec, args, {
        stdio: 'inherit',
        env: { ...process.env, MINDCRAFT_BODY_SETTINGS: JSON.stringify(settings) },
    });
    bodyProcess.on('exit', (code, signal) => {
        console.log(`Body process exited with code ${code} and signal ${signal}`);
        bodyExit = { code, signal };
        bodyProcess = null;
    });
    bodyProcess.on('error', (err: Error) => {
        console.error('Body process error:', err);
        bodyProcess = null;
    });
}

/** 收摊。脑死之前必须叫一次，否则身体会变成孤儿连接。 */
export function stopBody(): void {
    if (bodyProcess == null) return;
    try {
        bodyProcess.kill('SIGINT');
    } catch {
        // 已经死了就算了。
    }
    bodyProcess = null;
}
