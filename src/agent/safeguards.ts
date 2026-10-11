/**
 * 保命程序开关。
 *
 * ## 为什么它必须和 `permits` 分开
 *
 * 这是两件不同的事：
 *
 * - `permits` 管**闸门**：「不拦你做危险动作」。
 * - 这里管**保命**：「不救你」。
 *
 * 原来它们是耦合的 —— `forceExitWater` 里一句"有进水许可就别管"，等于拿到危险
 * 操作授权就顺手把保命也关了。这对"模型想下水"是对的（它自己有安排，别抢方向盘），
 * 但对"模型想关掉保命自己承担风险"就不对：那是另一个语义，得能独立表达。
 *
 * 用户的原话是这两件事配合使用：
 *
 * > 允许进行危险操作……但如果用这个工具禁用了保命程序，它就不会发挥作用，角色会一直
 * > 在水里泡着。
 *
 * **"一直泡着"就是字面意思** —— 连 L5 溺水保命也不再上浮。模型自己签了生死状。
 *
 * ## 两种模式，和 permits 对齐
 *
 * 时间制（分钟）和次数制（工具调用数）都支持。次数制的好处一样：模型申请 3 次，
 * 第 2 次寻路失败，额度当场用完，保命立刻回来 —— 按时间做不到。
 */

/** 保命抑制记录。两种模式二选一，和 `permits` 的 Grant 一个路子。 */
export interface Suppression {
  /** 次数制剩余次数；时间制为 null。 */
  callsLeft: number | null;
  /** 时间制到期时刻；次数制为 null。 */
  expiresAt: number | null;
  reason: string;
  startedAt: number;
}

export interface Safeguards {
  /** 保命是不是被关掉了。关掉了调用方就**别碰身体**。 */
  isSuppressed(now: number): boolean;
  /** 按时间关闭。 */
  suppressFor(minutes: number, reason: string, now: number): Suppression;
  /** 按次数关闭。每次工具调用消耗一次，**失败也算**。 */
  suppressCalls(calls: number, reason: string, now: number): Suppression;
  /** 重新开启（对应工具 disableSafeguards 的 restore=true）。 */
  release(): void;
  /** 消耗一次额度。返回 true 表示这一次正好用尽。 */
  consumeCall(now: number): boolean;
  describe(now: number): string;
  current(now: number): Suppression | null;
}

export function createSafeguards(): Safeguards {
  let sup: Suppression | null = null;

  function live(now: number): Suppression | null {
    if (sup == null) return null;
    if (sup.expiresAt != null && now >= sup.expiresAt) {
      sup = null;
      return null;
    }
    if (sup.callsLeft != null && sup.callsLeft <= 0) {
      sup = null;
      return null;
    }
    return sup;
  }

  return {
    isSuppressed(now) {
      return live(now) != null;
    },
    suppressFor(minutes, reason, now) {
      sup = {
        callsLeft: null,
        expiresAt: now + Math.max(1, minutes) * 60_000,
        reason,
        startedAt: now,
      };
      return sup;
    },
    suppressCalls(calls, reason, now) {
      sup = {
        callsLeft: Math.max(1, Math.floor(calls)),
        expiresAt: null,
        reason,
        startedAt: now,
      };
      return sup;
    },
    release() {
      sup = null;
    },
    consumeCall(now) {
      const s = live(now);
      if (s == null || s.callsLeft == null) return false;
      s.callsLeft -= 1;
      if (s.callsLeft <= 0) {
        sup = null;
        return true;
      }
      return false;
    },
    current(now) {
      return live(now);
    },
    describe(now) {
      const s = live(now);
      if (s == null) return '保命程序正常（进水会自动上岸、溺水会自动上浮）';
      const left =
        s.callsLeft != null
          ? `还剩 ${s.callsLeft} 次工具调用`
          : `还剩 ${Math.max(0, Math.round(((s.expiresAt as number) - now) / 1000))} 秒`;
      return `保命程序已关闭，${left}（原因：${s.reason}）——这段时间里出事没人救`;
    },
  };
}

/**
 * 全局实例。**本进程只跑一个 bot**，保命代码（`forceExitWater`、`runEmergency`）
 * 直接问它就行。
 */
export const safeguards = createSafeguards();

export default { createSafeguards, safeguards };