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

/**
 * 授权记录。**两种模式，二选一**：
 *
 * - **时间制**（`minutes`）：`expiresAt` 有值、`callsLeft` 为 null。
 * - **次数制**（`calls`）：`callsLeft` 有值、`expiresAt` 为 null。
 *
 * 次数制是为了水下作业这种场景：模型说"接下来 3 次动作别拦我"，于是它能连着
 * 寻路 → 挖洞 → 封顶；中间哪一步失败了，这一次额度就没了，闸门立刻回到默认禁止，
 * 保命程序重新接管。**按时间做不到这一点** —— 授权 5 分钟，模型在这 5 分钟里怎么
 * 折腾都没人管，淹死了也白淹。
 */
interface Grant {
  /** null = 全部授权。 */
  ops: string[] | null;
  /** 时间制到期时刻；次数制为 null。 */
  expiresAt: number | null;
  /** 次数制剩余次数；时间制为 null。 */
  callsLeft: number | null;
  reason: string;
  grantedAt: number;
}

export interface Permits {
  isAllowed(opId: string, ctx: OpContext, now: number): Verdict;
  /** `opIds` 省略/null = 授权全部；给了列表 = 只授权这几个（未注册 id 抛错）。**按时间**。 */
  grant(opIds: string[] | null, minutes: number, reason: string, now: number): Grant;
  /** 同上，但**按次数**：每次工具调用消耗一次，**失败也算**（见 `consumeCall`）。 */
  grantCalls(opIds: string[] | null, calls: number, reason: string, now: number): Grant;
  revoke(): void;
  /**
   * 彻底清干净：模型授权**和**内部豁免票一起清。
   *
   * `revoke()` 只清前者 —— 它回答的是"你不再被特别批准"。而"一键恢复保护"要的是
   * 连我们写死的保命代码发出去的票也收回来，否则"立刻恢复"里有残留。
   */
  revokeAll(): void;
  /**
   * 消耗一次工具调用额度。只对次数制生效。
   *
   * **失败也要消耗** —— 这是次数制全部意义所在：模型申请了 3 次，第 2 次寻路失败，
   * 它就该只剩 1 次，而不是可以无限重试。返回值 `true` 表示这一次正好把额度用尽。
   */
  consumeCall(now: number): boolean;
  /** 只给我们自己的保命代码用：给某一项发一张极短的豁免票。 */
  bypassFor(opId: string, ms: number, reason: string, now: number): void;
  describe(now: number): string;
  /** 当前授权（测试/诊断用）。 */
  current(now: number): Grant | null;
}

export function createPermits(): Permits {
  let grant: Grant | null = null;
  const bypasses = new Map<string, number>(); // opId -> expiresAt

  /** 授权是否还有效（顺带清掉过期的）。两种模式统一在这里判。 */
  function liveGrant(now: number): Grant | null {
    if (grant == null) return null;
    if (grant.expiresAt != null && now >= grant.expiresAt) {
      grant = null;
      return null;
    }
    if (grant.callsLeft != null && grant.callsLeft <= 0) {
      grant = null;
      return null;
    }
    return grant;
  }

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
    const g = liveGrant(now);
    if (g != null && (g.ops == null || g.ops.includes(opId))) {
      return { allowed: true, why: 'granted', op };
    }

    return { allowed: false, why: 'none', op };
  }

  return {
    isAllowed,
    grant(opIds, minutes, reason, now) {
      grant = {
        ops: opIds == null || opIds.length === 0 ? null : [...opIds],
        expiresAt: now + Math.max(1, minutes) * 60_000,
        callsLeft: null,
        reason,
        grantedAt: now,
      };
      return grant;
    },
    grantCalls(opIds, calls, reason, now) {
      grant = {
        ops: opIds == null || opIds.length === 0 ? null : [...opIds],
        expiresAt: null,
        callsLeft: Math.max(1, Math.floor(calls)),
        reason,
        grantedAt: now,
      };
      return grant;
    },
    revoke() {
      grant = null;
    },
    revokeAll() {
      grant = null;
      bypasses.clear();
    },
    consumeCall(now) {
      const g = liveGrant(now);
      if (g == null || g.callsLeft == null) return false; // 时间制不消耗
      g.callsLeft -= 1;
      if (g.callsLeft <= 0) {
        grant = null;
        return true;
      }
      return false;
    },
    bypassFor(opId, ms, reason, now) {
      void reason;
      bypasses.set(opId, now + Math.max(1, ms));
    },
    current(now) {
      return liveGrant(now);
    },
    describe(now) {
      // 先清掉已经过期的票。**不清的话"内部豁免 N 项"会一直挂着失效的项**，
      // 而 describe() 是要进 Live State 给模型看的——模型会以为自己还有豁免。
      for (const [id, until] of bypasses) {
        if (now >= until) bypasses.delete(id);
      }
      grant = liveGrant(now);

      const parts: string[] = [];
      const g = grant;
      if (g != null) {
        const scope = g.ops == null ? '全部危险操作' : g.ops.join('/');
        // 两种模式说两种话：时间制说剩多少秒，次数制说剩几次。模型得知道
        // 自己还剩多少"动作额度"——它要靠这个决定还要不要再多申请几个。
        const left =
          g.callsLeft != null
            ? `还剩 ${g.callsLeft} 次工具调用`
            : `还剩 ${Math.max(0, Math.round(((g.expiresAt as number) - now) / 1000))} 秒`;
        parts.push(`${scope} 已授权，${left}（原因：${g.reason}）`);
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

/**
 * 进水许可：着火（实时判定）或者模型授权过 `enter_deep_water`。
 *
 * **判据必须只有这一个出处** —— 路径闸门（`movements.ts`）和目标点/传送落点闸门
 * （`dangerousWaterRefusal`）都调它，否则"能走过去"和"肯走过去"会漂移成两套规则。
 *
 * 放在 `permits.ts` 而不是 `skills.ts`：后者是两千多行的工具实现，import 它会
 * 连带拖进 mineflayer / pathfinder / canvas，任何想测這個判据的测试都得背上这份
 * 重（真机教训：就是这么把一个单测文件拖垮的）。
 */
export function deepWaterAllowed(bot: unknown): boolean {
  return permits.isAllowed('enter_deep_water', opContextFor(bot), Date.now()).allowed;
}

export default { createPermits, permits, opContextFor, FIRE_EXEMPT_OPS };
