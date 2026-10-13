/*
 * 身体侧日志出口。
 *
 * **身体不连 MindServer**（那是大脑的身份），所以这里只有终端输出：
 * `sendOutputToServer` 那条路在身体进程里本来就没有 socket，走过去只会失败。
 * 错误分类的判据在 `shared/connection.ts`，两侧共用同一份。
 */

import { parseKickReason } from '../shared/connection.js';

export { parseKickReason, validateNameFormat } from '../shared/connection.js';
export type { KickInfo } from '../shared/connection.js';

// Helper to log messages to console (once).
export const log = (_agentName: string, msg: string): void => {
    // Use console.error for visibility in terminal
    console.error(msg);
};

// Centralized handler for disconnections.
export function handleDisconnection(agentName: string, reason: unknown): { type: string; msg: string } {
    const { type, msg } = parseKickReason(reason);

    // Format: [LoginGuard] Error Message
    const finalMsg = `[LoginGuard] ${msg}`;

    // Only call log once (it handles console printing)
    log(agentName, finalMsg);

    return { type, msg: finalMsg };
}
