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

import {
  DISCARD_CLAIM_WINDOW_MS,
  DISCARD_IGNORE_MS,
  DISCARD_IGNORE_RADIUS,
  itemNameMatches,
  type PickupTarget,
} from '../shared/auto_pickup.js';

export {
  PICKUP_RADIUS,
  PICKUP_INTERVAL_MS,
  PICKUP_TIMEOUT_MS,
  PICKUP_CONFIRM_DELAY_MS,
  PICKUP_GIVE_UP_ATTEMPTS,
  PICKUP_GIVE_UP_MS,
  PICKUP_SURVIVAL_SUPPRESS_MS,
  PICKUP_THREAT_RADIUS,
  confirmedPickupGains,
  positiveInventoryDelta,
  formatInventoryGains,
  itemNameMatches,
  normalizeItemName,
  shouldGiveUpPickup,
} from '../shared/auto_pickup.js';
export type { PickupGate, PickupTarget } from '../shared/auto_pickup.js';

/**
 * 刚被 `discard` 扔掉的东西，短时间内**不要**去捡。
 *
 * 模型真机报过"discard 自己走回来捡回"：discard 的流程是走开 5 格 → 扔掉 →
 * **再走回原地**，而自动拾取的半径是 8 格——走回去正好又进范围，等于白扔。
 * 与其让模型跟自己的自动行为打架，不如记住刚扔了什么、一小段时间内跳过它。
 *
 * ⚠️ **只按名字记是不够的**（真机回归：overnight_b 13:24 扔 256 下界岩，
 * 2.7 秒后被自己捡回，free 仍为 0）：
 *   - 掉落物实体名可能还没同步（`displayName` 缺失 → 名字匹配不上）；
 *   - 自动拾取反射可能不是"选中"它，而是**从落点上走过去踩到**（原版拾取，
 *     没有任何代码能拦）；
 *   - 名字本身也可能被服务端/插件改写。
 * 所以一条 discard 记录同时记**名字 + 落点 + 认领到的实体 id**，三条路一起屏蔽。
 */
interface DiscardRecord {
    name: string;
    at: number;
    x: number | null;
    y: number | null;
    z: number | null;
    /** 这次 discard 抛出的掉落物实体 id（由 `itemDrop` 事件认领）。 */
    ids: Set<number>;
}

const discarded: DiscardRecord[] = [];
/** 只保留最近这么多条 discard 记录，防止长跑进程里无限增长。 */
const MAX_DISCARD_RECORDS = 20;

/** 记下"刚扔了这个"。统一存小写；比较时再做分隔符归一化（见 `itemNameMatches`）。 */
export function markDiscarded(name: string, drop?: { x?: unknown; y?: unknown; z?: unknown } | null): void {
    discarded.push({
        name: name.toLowerCase(),
        at: Date.now(),
        x: num(drop?.x),
        y: num(drop?.y),
        z: num(drop?.z),
        ids: new Set<number>(),
    });
    if (discarded.length > MAX_DISCARD_RECORDS) discarded.shift();
}

/**
 * `itemDrop` 事件认领：把刚出现的掉落物实体挂到最近一次 discard 上。
 *
 * 只认 [0, DISCARD_CLAIM_WINDOW_MS] 内、且还没过期的那条；没有对应的 discard
 * 就返回 false（普通掉落物不该被免疫）。
 */
export function noteDiscardedEntity(id: unknown): boolean {
    const entityId = num(id);
    if (entityId == null) return false;
    const now = Date.now();
    for (let i = discarded.length - 1; i >= 0; i--) {
        const record = discarded[i] as DiscardRecord;
        if (now - record.at > DISCARD_CLAIM_WINDOW_MS) break;
        record.ids.add(entityId);
        return true;
    }
    return false;
}

/** 清空免疫表。**给测试用**：它跟着模块走，跨用例会互相污染。 */
export function clearDiscards(): void {
    discarded.length = 0;
}

/** 丢掉过期记录；顺带把"哪条记录命中"的判断集中在一处。 */
function matchedRecord(
    displayName: string,
    at: { x?: unknown; y?: unknown; z?: unknown } | null | undefined,
    id: unknown,
    now: number,
): DiscardRecord | null {
    for (let i = discarded.length - 1; i >= 0; i--) {
        const record = discarded[i] as DiscardRecord;
        if (now - record.at > DISCARD_IGNORE_MS) {
            discarded.splice(i, 1);
            continue;
        }
        const entityId = num(id);
        if (entityId != null && record.ids.has(entityId)) return record;
        const shown = displayName.toLowerCase();
        if (shown !== '' && itemNameMatches(record.name, shown)) return record;
        const x = num(at?.x);
        const y = num(at?.y);
        const z = num(at?.z);
        if (x != null && z != null && record.x != null && record.z != null) {
            const dy = y != null && record.y != null ? y - record.y : 0;
            if (Math.hypot(x - record.x, dy, z - record.z) <= DISCARD_IGNORE_RADIUS) return record;
        }
    }
    return null;
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
 *
 * `at` / `id` 是**另外两条**屏蔽路径：名字读不到时按落点，身份不确定时按实体 id。
 * 三条都不成立才放行。
 */
export function isDiscardedDrop(
    displayName: string,
    at?: { x?: unknown; y?: unknown; z?: unknown } | null,
    id?: unknown,
): boolean {
    return matchedRecord(displayName ?? '', at, id, Date.now()) != null;
}

/** 只按实体 id 判断（拾取走到一半时用：手上只有 id 和名字，位置可能已经过期）。 */
export function isDiscardedDropById(id: unknown): boolean {
    return matchedRecord('', null, id, Date.now()) != null;
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
    // 刚被自己扔掉的先别捡（名字 / 落点 / 实体 id 三条路都算），否则 discard 等于白干。
    if (
      isDiscardedDrop(
        typeof e.displayName === 'string' ? e.displayName : '',
        { x: e.position?.x, y: e.position?.y, z: e.position?.z },
        e.id,
      )
    ) {
      continue;
    }
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
  noteDiscardedEntity,
  isDiscardedDrop,
  isDiscardedDropById,
  clearDiscards,
};
