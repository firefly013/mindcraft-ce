/*
 * 自动拾取的**共享策略**：多久允许试一次、能看多远、超时多长。
 *
 * 拾取本身是身体的本能（走路 + 踩到掉落物）：**处理住在身体侧**
 * （`MineflayerBody.schedulePickup`），"什么时候值得试"那条闸门也用它。
 * 触发它的边沿（地上出现掉落物）由身体在**变化的那一刻**报成事件
 * （`item.drop.nearby`），所以没有"每 300ms 问一次"这种代码。
 *
 * 本文件是纯数据/纯函数，不许 import 身体或大脑的实现。
 */

/** 只捡这么近的掉落物（格）。太远就变成"满地图捡垃圾"了。 */
export const PICKUP_RADIUS = 8;
/** 两次拾取尝试之间的最小间隔（毫秒）。 */
export const PICKUP_INTERVAL_MS = 1500;
/** 连续失败后的最大退避（毫秒）。 */
export const PICKUP_BACKOFF_MAX_MS = 30_000;
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

/** 刚被 `discard` 扔掉的东西，多久之内不要去捡。 */
export const DISCARD_IGNORE_MS = 180_000;
/**
 * 连续失败到这个次数就**放弃这次拾取**（不再 3 秒一次地无限重试）。
 *
 * 真机 2026-10-18 15:56：`{"reflex":"pickup","outcome":"failed",…"退避 3 秒后再试
 * （连续失败 1 次）"}` 反复出现，每次都把身体通道占住——而模型那时正被骷髅和
 * 末影人围攻、血从 17.26 掉到 0.045，所有自救动作都被"动作已在跑"拒掉。
 * 走到一件掉落物的时间是有上限的，走不到就是走不到，认了比耗着强。
 */
export const PICKUP_GIVE_UP_ATTEMPTS = 2;
/** 放弃之后静默多久（毫秒）：期间即使地上有新掉落物也不再自动捡。 */
export const PICKUP_GIVE_UP_MS = 60_000;
/** 保命抢占后，拾取静默多久（毫秒）——先保命，命保住了再谈捡东西。 */
export const PICKUP_SURVIVAL_SUPPRESS_MS = 30_000;
/** 敌对生物在这个距离内就不启动拾取（格）。 */
export const PICKUP_THREAT_RADIUS = 16;
/**
 * 连续失败够次数了没有？够就放弃这次拾取（回执里说清"放弃"，不再承诺"再试"）。
 */
export function shouldGiveUpPickup(failures: number): boolean {
  return Number.isFinite(failures) && failures >= PICKUP_GIVE_UP_ATTEMPTS;
}
/**
 * discard 免疫的**空间半径**（格）。
 *
 * 只按名字匹配挡不住真机那条路径：overnight_b 13:24 扔了 256 下界岩，2.7 秒后
 * 又被自己捡回（`auto_pickup: true`，free 仍为 0）。原因是反射走过去时**踩过**
 * 落点——掉落物实体名可能还没同步，也可能根本不是反射"选中"的那一件，而是
 * 顺路踩到的。落点附近的这些东西，同样不能捡。
 */
export const DISCARD_IGNORE_RADIUS = 2.5;
/**
 * discard 之后多久内出现的掉落物实体算"刚扔的那件"（毫秒）。
 *
 * 用来把 `itemDrop` 事件里的实体 id 认领到最近一次 discard 上：
 * id 是身份，不怕实体名缺失或被改写。
 */
export const DISCARD_CLAIM_WINDOW_MS = 2_000;
/**
 * 拾取事件发生后，等多久再重读 player inventory 做核验。
 *
 * 真机 Feedback #62：playerCollect 先到、背包后到；而旧实现拿一份可能很旧的
 * 快照做差，导致"捡到 porkchop×1"但背包里没有。200ms 是给客户端背包同步留的
 * 窗口：既不能太短（读到的还是旧背包），也不能太长（把别处的变化算进来）。
 */
export const PICKUP_CONFIRM_DELAY_MS = 200;

/** 背包账目：物品 id → 总数量。 */
export type InventoryCounts = Record<string, number>;

/**
 * 归一化物品 id / 掉落物显示名，便于跨下划线、空格、连字符比较。
 *
 * 例：`"Oak Log"` / `"oak_log"` / `"oak-log"` → `"oak_log"`。
 */
export function normalizeItemName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * 宽松匹配物品 id 与掉落物显示名。
 *
 * 只做整段前缀/后缀/中间段匹配，避免 `"dirt"` 匹配到 `"dirt_block"` 以外的
 * 无关物品。用于 `discard` 免疫表（记的是 `oak_log`，掉落物读的是 `Oak Log`）。
 */
export function itemNameMatches(expected: string, actual: string): boolean {
  const a = normalizeItemName(expected);
  const b = normalizeItemName(actual);
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const hasSegment = (long: string, short: string): boolean =>
    long.startsWith(`${short}_`) || long.endsWith(`_${short}`) || long.includes(`_${short}_`);
  return hasSegment(a, b) || hasSegment(b, a);
}

/**
 * 当前背包相对 `before` 的正增量。
 *
 * 读不到任一侧时返回空表：宁可不报，也不能把"读失败"当成"没变化"再报 gained。
 */
export function positiveInventoryDelta(
  before: InventoryCounts | null | undefined,
  after: InventoryCounts | null | undefined,
): InventoryCounts {
  if (before == null || after == null) return {};
  const gained: InventoryCounts = {};
  for (const [name, count] of Object.entries(after)) {
    const delta = count - (before[name] ?? 0);
    if (delta > 0) gained[name] = delta;
  }
  return gained;
}

/**
 * 拾取核验：只有 `after` 里确实比 `before` 多出来的才算 gained。
 *
 * 知道掉落物名（expectedItem）时只认这个物品，避免把同一窗口内背包里别的
 * 变化算成"捡到了"；不知道时退回全部正增量。返回空对象 = 这次不报 gained。
 */
export function confirmedPickupGains(
  before: InventoryCounts | null | undefined,
  after: InventoryCounts | null | undefined,
  expectedItem?: string | null,
): InventoryCounts {
  const gained = positiveInventoryDelta(before, after);
  if (expectedItem == null || expectedItem.trim() === '') return gained;
  const confirmed: InventoryCounts = {};
  for (const [name, count] of Object.entries(gained)) {
    if (itemNameMatches(expectedItem, name)) confirmed[name] = count;
  }
  return confirmed;
}

/** 把 gained 渲染成模型能读的 `porkchop×1、oak_log×2`。 */
export function formatInventoryGains(gained: InventoryCounts): string {
  return Object.entries(gained)
    .map(([name, count]) => `${name}×${count}`)
    .join('、');
}

export interface PickupTarget {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  /** 到 bot 的距离（格）。 */
  distance: number;
}

export interface PickupGate {
  /** 身体通道上已经有别的动作在跑，或模型动作请求已经在路上。 */
  busy: boolean;
  /** 上一次拾取还没结束。 */
  pickingUp: boolean;
  /** 距离上次尝试过了多少毫秒。 */
  sinceLastAttemptMs: number;
  /** 连续失败后的剩余退避；>0 就不许再抢身体。 */
  backoffRemainingMs?: number;
  /**
   * 保命反射正在跑（或还在队列里）：非保命反射不许在这时候抢身体。
   *
   * 真机 2026-10-18 15:56（overnight_a）：一边挨打一边被拾取反射带着走，
   * 模型 consume/move/stay/goToCoordinates 全被拒，血从 17.26 掉到 0.045。
   */
  reflexBusy?: boolean;
  /** 威胁范围内有敌对生物：**别去捡东西**，先活下来。 */
  threatNear?: boolean;
}

/**
 * 这一轮该不该去捡（调用方已经确认半径内有掉落物）。
 *
 * 抽成纯函数是为了能把它测清楚：真正决定行为的就这几条，
 * 剩下的只是"什么时候调用它"。
 */
export function shouldAttemptPickup(gate: PickupGate): boolean {
  // **保命第一**：保命反射占着身体、或敌人在附近时，捡东西这件事排最后。
  // 一个"替模型打输这场架"的反射比没有反射更糟。
  if (gate.reflexBusy === true) return false;
  if (gate.threatNear === true) return false;
  if (gate.pickingUp) return false;
  if (gate.busy) return false;
  if ((gate.backoffRemainingMs ?? 0) > 0) return false;
  return gate.sinceLastAttemptMs >= PICKUP_INTERVAL_MS;
}

/**
 * 连续失败 n 次后的退避时长（指数退避，封顶 30 秒）。
 *
 * 真机 Feedback #28：拾取连续失败却每 1.5 秒继续抢身体，模型工具调用被
 * ACTION_BUSY 连拒。失败一次就该拉长下一次尝试间隔，别和模型抢方向盘。
 */
export function nextPickupBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  const base = PICKUP_INTERVAL_MS * Math.pow(2, Math.min(failures, 5));
  return Math.min(PICKUP_BACKOFF_MAX_MS, base);
}
