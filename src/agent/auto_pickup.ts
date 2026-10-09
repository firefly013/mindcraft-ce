/*
 * 自动拾取：附近地上的掉落物，自己走过去捡起来。
 *
 * 为什么需要：`collectBlocks` 只负责把方块挖掉，**掉落物得有人去踩**才会进背包。
 * 模型经常挖完就走，原木/圆石/煤就留在地上——它以为"挖到了"，其实背包里没有。
 * 与其指望模型每次都记得回头捡，不如让它成为身体的本能。
 *
 * 与身体通道的关系：拾取要走路，所以它**必须**占用 Scheduler 的动作通道
 * （同一时刻只能有一个占用型动作）。规矩是：
 *   - 通道忙（模型的动作在跑）→ 这一轮不捡，等下个 tick；
 *   - 轮到它时用 `autoPickup` 这个名字认领，走完/超时立刻释放；
 *   - Stop 来了 generation 会失效，`isCurrent` 保证它不会去释放别人的通道。
 *
 * 本文件不碰 bot 之外的任何东西，纯函数便于单测。
 */

/** 认领通道时用的动作名（模型侧会在 Live State 的 action 字段里看到它）。 */
export const AUTO_PICKUP_ID = 'autoPickup';
/** 只捡这么近的掉落物（格）。太远就变成"满地图捡垃圾"了。 */
export const PICKUP_RADIUS = 8;
/** 两次拾取尝试之间的最小间隔（毫秒）。 */
export const PICKUP_INTERVAL_MS = 1500;
/** 单次拾取最多走多久（毫秒）；超时就放弃，下一轮再说。 */
/**
 * 走过去捡的**超时**。
 *
 * 原来是 **4 秒**——而检测半径是 8 格，8 格的寻路（还要绕路）根本走不完，
 * 于是每次都在半路超时、掉落物永远捡不到。模型真机实测报的就是这件事：
 * pia "自动拾取半径只有 ~1-2 格（不是 8）"——不是检测不到，是**走不到就放弃了**，
 * 只有脚下 1~2 格的东西能在 4 秒内够着。
 *
 * 放到 12 秒：8 格直线约 2 秒，留足绕路和爬升的余量。
 * 被模型抢占（generation 变了）仍然立刻收手，所以放长不会占着身体不放。
 */
export const PICKUP_TIMEOUT_MS = 12_000;

export interface PickupTarget {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  /** 到 bot 的距离（格）。 */
  distance: number;
}

/**
 * 半径内最近的掉落物；没有就是 null。
 *
 * mineflayer 里掉落物是 `name === 'item'` 的实体（真正的物品名在
 * `displayName`/`metadata` 上，拾取不需要它）。**只认 item**：玩家、怪物、
 * 船、经验球都不该触发"走过去捡"。
 */
/**
 * 刚被 `discard` 扔掉的东西，短时间内**不要**去捡。
 *
 * 模型真机报过"discard 自己走回来捡回"：discard 的流程是走开 5 格 → 扔掉 →
 * **再走回原地**，而自动拾取的半径是 8 格——走回去正好又进范围，等于白扔。
 * 与其让模型跟自己的自动行为打架，不如记住刚扔了什么、一小段时间内跳过它。
 */
const discardedAt = new Map<string, number>();
const DISCARD_IGNORE_MS = 30_000;

/** 记下"刚扔了这个"，30 秒内自动拾取会跳过它。 */
export function markDiscarded(name: string): void {
  discardedAt.set(name, Date.now());
}

/** 这个掉落物是不是刚被自己扔掉的（且还在忽略窗口内）。 */
function isJustDiscarded(name: string, now: number): boolean {
  const at = discardedAt.get(name);
  if (at == null) return false;
  if (now - at > DISCARD_IGNORE_MS) {
    discardedAt.delete(name);
    return false;
  }
  return true;
}

export function nearestDropWithin(bot: unknown, radius: number): PickupTarget | null {
  const b = bot as
    | {
        entity?: { id?: unknown; position?: { x?: number; y?: number; z?: number } };
        entities?: Record<string, unknown>;
      }
    | null
    | undefined;
  const self = b?.entity;
  const selfPos = self?.position;
  if (self == null || selfPos == null) return null;
  const sx = num(selfPos.x);
  const sy = num(selfPos.y);
  const sz = num(selfPos.z);
  if (sx == null || sy == null || sz == null) return null;

  let best: PickupTarget | null = null;
  const entities = b?.entities;
  if (entities == null) return null;
  for (const raw of Object.values(entities)) {
    // mineflayer 的实体表里每一项都是实体对象（不会出现 null），
    // id 也恒为 number——所以这里不写那些够不到的兜底分支。
    const e = raw as {
      id: number;
      name?: unknown;
      displayName?: unknown;
      position?: { x?: unknown; y?: unknown; z?: unknown };
    };
    if (e.id === self.id) continue;
    if (e.name !== 'item') continue;
    // 刚被自己扔掉的先别捡，否则 discard 等于白干。
    if (isJustDiscarded(typeof e.displayName === 'string' ? e.displayName : '', Date.now())) continue;
    const ex = num(e.position?.x);
    const ey = num(e.position?.y);
    const ez = num(e.position?.z);
    if (ex == null || ey == null || ez == null) continue;
    const distance = Math.hypot(ex - sx, ey - sy, ez - sz);
    if (distance > radius) continue;
    if (best != null && distance >= best.distance) continue;
    best = {
      id: e.id,
      name: typeof e.displayName === 'string' ? e.displayName : 'item',
      x: ex,
      y: ey,
      z: ez,
      distance,
    };
  }
  return best;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface PickupGate {
  /** 身体通道上已经有别的动作在跑。 */
  busy: boolean;
  /** 上一次拾取还没结束。 */
  pickingUp: boolean;
  /** 距离上次尝试过了多少毫秒。 */
  sinceLastAttemptMs: number;
}

/**
 * 这一轮该不该去捡（调用方已经确认半径内有掉落物）。
 *
 * 抽成纯函数是为了能把它测清楚：真正决定行为的就这几条，
 * 剩下的只是"什么时候调用它"。
 */
export function shouldAttemptPickup(gate: PickupGate): boolean {
  if (gate.pickingUp) return false;
  if (gate.busy) return false;
  return gate.sinceLastAttemptMs >= PICKUP_INTERVAL_MS;
}

export default {
  nearestDropWithin,
  shouldAttemptPickup,
  AUTO_PICKUP_ID,
  PICKUP_RADIUS,
  PICKUP_INTERVAL_MS,
  PICKUP_TIMEOUT_MS,
};
