/*
 * 自动拾取：附近地上的掉落物，自己走过去捡起来。
 *
 * 为什么需要：`collectBlocks` 只负责把方块挖掉，**掉落物得有人去踩**才会进背包。
 * 模型经常挖完就走，原木/圆石/煤就留在地上——它以为"挖到了"，其实背包里没有。
 * 与其指望模型每次都记得回头捡，不如让它成为身体的本能。
 *
 * 这个文件只管**身体这一半**：
 *   - `nearestDropWithin`：半径内最近的掉落物（读 mineflayer 实体表）；
 *   - `markDiscarded` / 丢弃免疫表：刚扔出去的东西别马上捡回来。
 * "该不该试、多久试一次"的判据在大脑侧**那条事件的处理**里（`Agent.reflexAutoPickup`），
 * 用的是 `shared/auto_pickup.ts` 里的同一组常量——两边不许各写一份数字。
 */

import { DISCARD_IGNORE_MS, itemNameMatches, type PickupTarget } from '../shared/auto_pickup.js';

export {
  PICKUP_RADIUS,
  PICKUP_INTERVAL_MS,
  PICKUP_TIMEOUT_MS,
  PICKUP_CONFIRM_DELAY_MS,
  confirmedPickupGains,
  positiveInventoryDelta,
  formatInventoryGains,
  itemNameMatches,
  normalizeItemName,
} from '../shared/auto_pickup.js';
export type { PickupGate, PickupTarget } from '../shared/auto_pickup.js';

/**
 * 刚被 `discard` 扔掉的东西，短时间内**不要**去捡。
 *
 * 模型真机报过"discard 自己走回来捡回"：discard 的流程是走开 5 格 → 扔掉 →
 * **再走回原地**，而自动拾取的半径是 8 格——走回去正好又进范围，等于白扔。
 * 与其让模型跟自己的自动行为打架，不如记住刚扔了什么、一小段时间内跳过它。
 */
const discardedAt = new Map<string, number>();

/** 记下"刚扔了这个"。统一存小写；比较时再做分隔符归一化（见 `itemNameMatches`）。 */
export function markDiscarded(name: string): void {
  discardedAt.set(name.toLowerCase(), Date.now());
}

/** 清空免疫表。**给测试用**：它跟着模块走，跨用例会互相污染。 */
export function clearDiscards(): void {
  discardedAt.clear();
}

/**
 * 这个掉落物是不是刚被自己扔掉的（且还在忽略窗口内）。
 *
 * ⚠️ **这里以前有个让免疫永远不生效的坑**：调用方传入的是掉落物的
 * `displayName`（"Oak Log" 这类**显示名**），而 `markDiscarded` 记的是
 * `oak_log` 这种**物品 id**——下划线/空格/大小写都不一样，严格相等永远 false，
 * 于是"扔了又自动捡回来"，回执的承诺成了空话（模型实测并报了账）。
 *
 * 所以比较前两边都归一化：`"Oak Log"` / `"oak_log"` 会归到同一形式，
 * `"Dirt Block"` 也能按整段 `"dirt"` 命中。宽松匹配的代价极小（最坏是多跳过一个
 * 恰好同名的掉落物几秒钟），收益是承诺真的成立。
 */
function isJustDiscarded(displayName: string, now: number): boolean {
  const shown = displayName.toLowerCase();
  for (const [name, at] of discardedAt) {
    if (now - at > DISCARD_IGNORE_MS) {
      discardedAt.delete(name);
      continue;
    }
    if (itemNameMatches(name, shown)) return true;
  }
  return false;
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

export default {
  nearestDropWithin,
  markDiscarded,
  clearDiscards,
};
