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
export const PICKUP_TIMEOUT_MS = 4000;

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
