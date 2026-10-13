import { randomUUID } from 'node:crypto';

/**
 * headers 支持 `${VAR}` 占位，未设置的变量取一个新的 UUID。
 *
 * 用途：OpenCode 这类网关按会话路由，需要"每个进程一个会话 id"，而 profile
 * 是静态 JSON。写成 `"x-opencode-session": "${OPENCODE_SESSION_ID}"` 就
 * 既能表达这个头，又默认保持唯一（设了环境变量则全进程共用同一个）。
 *
 * 迁移说明（P1）：这是从 `src/models/gpt.ts` 原样搬过来的，行为逐字不变。
 * 迁到 pi-durable 之后，会话 id 由 `pi.provider` 文档持久化（UUIDv7）并经
 * `sessionId` 转发，`withOpenCodeSessionHeader()` 会自动补 `x-opencode-session`；
 * 这里的手写展开退化为"profile 显式配了 headers"时的兜底。
 */
export function resolveHeaders(raw: unknown): Record<string, string> | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    out[key] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
      const fromEnv = process.env[name];
      return fromEnv != null && fromEnv !== '' ? fromEnv : randomUUID();
    });
  }
  return Object.keys(out).length > 0 ? out : null;
}
