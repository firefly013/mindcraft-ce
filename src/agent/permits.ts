/**
 * 危险操作许可。
 *
 * ## 三种例外，只有这三种
 *
 * 1. **身上着火** —— 实时判定（**不落成授权**）。所以火一灭，下一轮立刻恢复
 *    默认禁止：碰水灭火那一下是允许的，火灭之后想再泡在水里就不行了。
 * 2. **模型明确授权** —— `grant()`，带过期时间。可以只授权某几项。
 * 3. **我们写死的保命代码** —— `bypassFor()`，只有自己的代码能调（救援、溺水自救）。
 *
 * ## 为什么着火要"实时判定"而不是"授权一下"
 *
 * 如果着火时发一张授权，火灭了它还在，机器人就会借这张票在水里泡着。实时判定
 * 没有这个漏洞——它只看**此刻**是不是着着火。
 */

import { type DangerousOp, type OpContext, findOp, isDangerousHere, normalizeDimension } from './dangerous_ops.js';

export interface Verdict {
  allowed: boolean;
  /** `fire` = 着火例外；`granted` = 模型授权；`bypass` = 写死的保命代码；
   *  `not-dangerous-here` = 这里压根不危险；`none` = 禁止。 */
  why: 'fire' | 'granted' | 'bypass' | 'not-dangerous-here' | 'none';
  /** `why === 'none'` 时，是哪条记录挡的（给回执用）。 */
  op?: DangerousOp;
}

/** 着火**只**豁免这一项：跳进水里把自己浇灭。倒水/倒岩浆/点火/睡觉都不豁免。 */
export const FIRE_EXEMPT_OPS: readonly string[] = ['enter_deep_water'];

interface Grant {
  /** null = 全部授权。 */
  ops: string[] | null;
  expiresAt: number;
  reason: string;
  grantedAt: number;
}

export interface Permits {
  isAllowed(opId: string, ctx: OpContext, now: number): Verdict;
  /** `opIds` 省略/null = 授权全部；给了列表 = 只授权这几个（未注册 id 抛错）。 */
  grant(opIds: string[] | null, minutes: number, reason: string, now: number): Grant;
  revoke(): void;
  /** 只给我们自己的保命代码用：给某一项发一张极短的豁免票。 */
  bypassFor(opId: string, ms: number, reason: string, now: number): void;
  describe(now: number): string;
  /** 当前授权（测试/诊断用）。 */
  current(now: number): Grant | null;
}

export function createPermits(): Permits {
  let grant: Grant | null = null;
  const bypasses = new Map<string, number>(); // opId -> expiresAt

  function isAllowed(opId: string, ctx: OpContext, now: number): Verdict {
    const op = findOp(opId);
    // 未注册的 id 不归这张表管 —— 授权时已经用 isAuthorizable 挡过打错字了。
    if (op == null) return { allowed: true, why: 'not-dangerous-here' };

    // 这里压根不危险（比如在主世界睡觉）→ 直接放行，不需要授权。
    if (!isDangerousHere(op, ctx)) return { allowed: true, why: 'not-dangerous-here', op };

    // 1) 着火（实时判定，不落成授权）
    if (ctx.onFire && FIRE_EXEMPT_OPS.includes(opId)) return { allowed: true, why: 'fire', op };

    // 3) 写死的保命代码
    const until = bypasses.get(opId);
    if (until != null) {
      if (now < until) return { allowed: true, why: 'bypass', op };
      bypasses.delete(opId);
    }

    // 2) 模型授权
    if (grant != null) {
      if (now >= grant.expiresAt) {
        grant = null;
      } else if (grant.ops == null || grant.ops.includes(opId)) {
        return { allowed: true, why: 'granted', op };
      }
    }

    return { allowed: false, why: 'none', op };
  }

  return {
    isAllowed,
    grant(opIds, minutes, reason, now) {
      grant = {
        ops: opIds == null || opIds.length === 0 ? null : [...opIds],
        expiresAt: now + Math.max(1, minutes) * 60_000,
        reason,
        grantedAt: now,
      };
      return grant;
    },
    revoke() {
      grant = null;
    },
    bypassFor(opId, ms, reason, now) {
      void reason;
      bypasses.set(opId, now + Math.max(1, ms));
    },
    current(now) {
      if (grant == null) return null;
      if (now >= grant.expiresAt) {
        grant = null;
        return null;
      }
      return grant;
    },
    describe(now) {
      const parts: string[] = [];
      const g = grant != null && now < grant.expiresAt ? grant : null;
      if (g != null) {
        const left = Math.max(0, Math.round((g.expiresAt - now) / 1000));
        parts.push(`${g.ops == null ? '全部危险操作' : g.ops.join('/')} 已授权，还剩 ${left} 秒（原因：${g.reason}）`);
      } else {
        parts.push('没有任何授权，危险操作全部禁止');
      }
      if (bypasses.size > 0) parts.push(`内部豁免 ${bypasses.size} 项（写死的保命代码）`);
      return parts.join('；');
    },
  };
}

/**
 * 从 mineflayer 的 bot 读出"判危险"需要的上下文。
 *
 * - 维度：`bot.game.dimension`（形如 `minecraft:the_end`，规范化掉命名空间）
 * - 着火：**mineflayer 不直接暴露 `onFire`**，要自己读实体元数据第 0 项的
 *   flags 字节的 bit0 —— 和 `edges.ts` 里 `snapshotFromBot` 用的同一个来源，
 *   两处必须是同一套判据，否则"事件里说烧着、闸门说没烧"。
 */
export function opContextFor(bot: unknown): OpContext {
  const b = bot as
    | { game?: { dimension?: unknown }; entity?: { metadata?: unknown } }
    | null
    | undefined;
  let onFire = false;
  const meta = b?.entity?.metadata;
  if (Array.isArray(meta)) {
    const flags = meta[0];
    if (typeof flags === 'number') onFire = (flags & 1) === 1;
  }
  return { dimension: normalizeDimension(b?.game?.dimension), onFire };
}

/**
 * 全局唯一实例。**本进程只跑一个 bot**，所以库里的工具（`skills.ts` 深处）直接
 * 问这个实例就行，不必把许可对象一路透传下来。
 *
 * 纯逻辑（`createPermits`）另外导出，测试用新实例，避免互相污染。
 */
export const permits = createPermits();

export default { createPermits, permits, opContextFor, FIRE_EXEMPT_OPS };
