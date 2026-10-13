/*
 * 自动拾取的**共享策略**：多久允许试一次、能看多远、超时多长。
 *
 * 拾取本身是身体的本能（走路 + 踩到掉落物），但"什么时候值得试"这个判据
 * 是大脑侧轮询循环在用的（`brain/agent.ts`），而"半径内最近的掉落物"是
 * 身体侧在算的（`body/auto_pickup.ts`）。两边必须用同一组数字，
 * 所以它们住在这里，谁都不许自己再定一份。
 *
 * 本文件是纯数据/纯函数，不许 import 身体或大脑的实现。
 */

/** 认领通道时用的动作名（模型侧会在 Live State 的 action 字段里看到它）。 */
export const AUTO_PICKUP_ID = 'autoPickup';
/** 只捡这么近的掉落物（格）。太远就变成"满地图捡垃圾"了。 */
export const PICKUP_RADIUS = 8;
/** 两次拾取尝试之间的最小间隔（毫秒）。 */
export const PICKUP_INTERVAL_MS = 1500;
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
