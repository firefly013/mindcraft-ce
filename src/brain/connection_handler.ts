/*
 * 大脑侧日志出口：控制台 + MindServer（UI 的 bot-output）。
 *
 * 错误分类的判据在 `shared/connection.ts`——身体侧有它自己的日志出口
 * （`body/connection_handler.ts`，只有终端），两份共用一个分类器。
 */

import { sendOutputToServer } from './mindserver_proxy.js';

export { parseKickReason, validateNameFormat } from '../shared/connection.js';
export type { KickInfo } from '../shared/connection.js';

// Helper to log messages to console (once) and MindServer.
export const log = (agentName: string, msg: string): void => {
    // Use console.error for visibility in terminal
    console.error(msg);
    try { sendOutputToServer(agentName || 'system', msg); } catch (_: unknown) { void _; /* best-effort logging; ignore */ }
};
