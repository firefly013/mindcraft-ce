/**
 * 水到底危不危险：深度 + 连通性。
 *
 * ## 为什么不能只看"脚下方块是不是水"
 *
 * 用户的原话是：一格深的静水踩上去无所谓，怕的是"那个静水其实是一桶水倒下来
 * 之后形成的水源，它下面连通着一些流动的水，不知道会把机器人冲到哪儿去"。
 *
 * 所以判据有两条，各管一种死法：
 *
 * 1. **深度** —— 脚下这格往下数，连续的水有几格。1 格是踩一脚，2 格以上就可能
 *    没顶（机器人身高约 1.8 格）。这是"淹死"。
 * 2. **连通性** —— 从脚下这滩水往外搜，有没有连到**流动的水**。连到了就说明这
 *    滩水正在往外流，站上去会被冲走，冲到哪儿不知道。这是"冲走"。
 *
 * 两条都不看的话，一桶水倒在矿洞里就能把机器人带走——真机上发生过。
 *
 * ## 为什么是纯函数
 *
 * 拿不到实机（额度打满）的时候，唯一还能证明它对的方式就是单测。所以这里不碰
 * mineflayer、不碰全局状态，`blockAt` 由调用方注入，测试里用假世界就能跑。
 */

import Vec3 from 'vec3';
import { deepWaterAllowed } from './permits.js';

/** mineflayer 的方块我们只需要这两个字段。 */
export interface BlockLike {
  name?: unknown;
  /** 水的 level：0 = 静水源（满格），> 0 = 在流动。旧版协议叫 metadata。 */
  metadata?: unknown;
  _properties?: { level?: unknown } | null;
}

/** 注入式取块：`(x, y, z) => block | null`。整数坐标。 */
export type BlockAt = (x: number, y: number, z: number) => BlockLike | null;

/** 判定结果。`reason` 是人话，**直接进拒绝回执给模型看**。 */
export interface WaterClass {
  /** 脚下这格是不是水。不是水就什么都不拦。 */
  isWater: boolean;
  /** 脚下这格本身是不是流动的水（不是源头）。 */
  flowingHere: boolean;
  /** 脚下这格往下数，连续的水有几格。不是水时为 0。 */
  depth: number;
  /** 连通检测：这滩水在半径内连到流动的水没有。 */
  flowingReachable: boolean;
  /** 综合结论。 */
  dangerous: boolean;
  /** 危险的原因（`dangerous === false` 时为空串）。 */
  reason: string;
}

/** 允许踩的水深：1 格。超过就开始有没顶风险。 */
export const SAFE_WATER_DEPTH = 1;
/** 连通搜索最多看多少个格子（防整片海把主线程吃满）。 */
export const BFS_MAX_NODES = 256;
/** 连通搜索的半径（格）。远到这个距离还连着，就不算"这滩水"了。 */
export const BFS_RADIUS = 6;
/** 往下数深度最多数多少格。 */
export const MAX_DEPTH_LOOK = 8;

/** "这里没水"的统一返回值，避免每个调用点各写一份。 */
const EMPTY_WATER: WaterClass = Object.freeze({
  isWater: false,
  flowingHere: false,
  depth: 0,
  flowingReachable: false,
  dangerous: false,
  reason: '',
});

/**
 * 读出水的 level。
 *
 * 仓库里已有的判据是 `block.metadata === 0`（`skills.ts` 找水源、判断桶能不能
 * 装水都用它）。新版 mineflayer 改挂 `_properties.level`，所以两个都认。
 *
 * **读不出来时当静水** —— 保守在这里反而是错的方向：绝大多数水都是静水，全按
 * 流动处理会让机器人连河边都不敢去。深度那条判据仍然拦得住深水。
 */
export function waterLevel(block: BlockLike | null | undefined): number {
  if (block == null) return 0;
  const md = block.metadata;
  if (typeof md === 'number' && Number.isFinite(md)) return md;
  const lv = block._properties?.level;
  if (typeof lv === 'number' && Number.isFinite(lv)) return lv;
  if (typeof lv === 'string') {
    const n = Number(lv);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** 这一格是不是水。 */
export function isWater(block: BlockLike | null | undefined): boolean {
  return block?.name === 'water';
}

/** 往下数：从 `(x, y, z)` 开始连续的水方块有几格。 */
export function waterDepthAt(blockAt: BlockAt, x: number, y: number, z: number): number {
  let depth = 0;
  for (let i = 0; i < MAX_DEPTH_LOOK; i++) {
    if (!isWater(blockAt(x, y - i, z))) break;
    depth++;
  }
  return depth;
}

/**
 * 连通检测：从脚下这滩静水往外搜，能不能碰到**流动的水**。
 *
 * 只搜**水方块**（不穿陆地），因为被冲走的路径就是水连成的那一张网。搜到
 * 流动水立刻返回——不需要搜完整张网，只要知道"连着"就够了。
 *
 * 起点本身是流动水的情况不算（那是 `flowingHere` 那条判据的事）。
 */
export function reachesFlowingWater(blockAt: BlockAt, x: number, y: number, z: number): boolean {
  const start = blockAt(x, y, z);
  if (!isWater(start)) return false;

  const seen = new Set<string>();
  const queue: Array<{ x: number; y: number; z: number }> = [{ x, y, z }];
  seen.add(`${x},${y},${z}`);

  while (queue.length > 0 && seen.size < BFS_MAX_NODES) {
    const cur = queue.shift() as { x: number; y: number; z: number };
    // 6 向：水平四个 + 上下。上下也要，因为水会顺着竖井往下淌。
    const around: Array<[number, number, number]> = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0],
      [0, -1, 0],
    ];
    for (const [dx, dy, dz] of around) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nz = cur.z + dz;
      if (Math.abs(nx - x) > BFS_RADIUS) continue;
      if (Math.abs(nz - z) > BFS_RADIUS) continue;
      if (Math.abs(ny - y) > BFS_RADIUS) continue;
      const key = `${nx},${ny},${nz}`;
      if (seen.has(key)) continue;
      const b = blockAt(nx, ny, nz);
      if (!isWater(b)) continue;
      seen.add(key);
      // 流动的水：这滩水的出口，站上去就会被冲走。
      if (waterLevel(b) !== 0) return true;
      queue.push({ x: nx, y: ny, z: nz });
    }
  }
  return false;
}

/**
 * 综合判定：站到 `(x, y, z)` 这一格（脚的位置）危不危险。
 *
 * 三条判据，命中任意一条就危险，**按最要命的顺序排列**，因为 `reason` 要进回执、
 * 模型只看到第一条：
 *
 * 1. 这一格本身在流动 → 站上去直接被冲走。
 * 2. 水深超过 1 格 → 可能没顶。
 * 3. 这滩水连着流动的水 → 会被冲到不知道哪儿去。
 */
export function classifyWaterAt(blockAt: BlockAt, x: number, y: number, z: number): WaterClass {
  const here = blockAt(x, y, z);
  const wet = isWater(here);
  const base: WaterClass = {
    isWater: wet,
    flowingHere: false,
    depth: 0,
    flowingReachable: false,
    dangerous: false,
    reason: '',
  };
  if (!wet) return base;

  const flowingHere = waterLevel(here) !== 0;
  const depth = waterDepthAt(blockAt, x, y, z);
  const flowingReachable = !flowingHere && depth <= MAX_DEPTH_LOOK && reachesFlowingWater(blockAt, x, y, z);

  let reason = '';
  if (flowingHere) reason = '这一格的水正在流动，站上去会被冲走';
  else if (depth > SAFE_WATER_DEPTH) reason = `这里的水有 ${depth} 格深，可能没过头顶`;
  else if (flowingReachable) reason = '这滩静水连着流动的水，会被冲到不知道哪儿去';

  return {
    isWater: true,
    flowingHere,
    depth,
    flowingReachable,
    dangerous: reason !== '',
    reason,
  };
}

/** 只问一句：危不危险。闸门要的其实就是这个。 */
export function isDangerousWaterAt(blockAt: BlockAt, x: number, y: number, z: number): boolean {
  return classifyWaterAt(blockAt, x, y, z).dangerous;
}

/**
 * 落点是不是危险的水：是就返回给模型的回执，不是就返回 null。
 *
 * **判据只有一份** —— `goToGoal` 的目标点判定和 `goToPosition` 的传送落点判定
 * 都走这里。两处各写一遍迟早漂移成两套规则，而它们本该是同一条。
 *
 * 放在这里而不是 `skills.ts`：后者是两千多行的工具实现，import 它会连带拖进
 * mineflayer / pathfinder / canvas —— 测这条判据不该背上这么重的依赖。
 */
export function dangerousWaterRefusal(
  bot: unknown,
  x: number,
  y: number,
  z: number,
  verb: string = '走到',
): string | null {
  if (deepWaterAllowed(bot)) return null;
  const cls = classifyWaterAt(blockAtFrom(bot), Math.floor(x), Math.floor(y), Math.floor(z));
  if (!cls.dangerous) return null;
  return (
    `默认不允许${verb}那片水里（${cls.reason}）。` +
    `要做得先授权：allowDangerousOps(5, "原因", "enter_deep_water")。`
  );
}

/**
 * 把 mineflayer 的 `bot.blockAt` 包成这里要的 `BlockAt`。
 *
 * **必须传真的 Vec3**：mineflayer 的 `blockAt` 把参数原样交给 prismarine-world，
 * 后者在区块已加载时会调 `pos.floored()` —— plain 对象会抛 TypeError。这个坑
 * `edges.ts` 的快照里踩过一次（整片字段静默变 undefined），这里照抄它的写法。
 *
 * 取块失败一律返回 null（= 当成空气），不去猜。
 */
export function blockAtFrom(bot: unknown): BlockAt {
  const b = bot as
    | { blockAt?: (pos: unknown) => BlockLike | null; world?: { getBlock?: (pos: unknown) => BlockLike | null } }
    | null
    | undefined;
  return (x: number, y: number, z: number): BlockLike | null => {
    const pos = new Vec3(x, y, z);
    try {
      if (typeof b?.blockAt === 'function') {
        const got = b.blockAt(pos);
        if (got != null) return got;
      }
    } catch {
      // 掉进 world 的兜底。
    }
    try {
      return b?.world?.getBlock?.(pos) ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * 脚底下这滩水什么样。
 *
 * 判据跟 `edges.ts` 的 `world.water.contact` 用**同一套取法**（脚底坐标 floored），
 * 否则会出现"事件说在水里、闸门说不在"这种互相打架的情况。
 */
/**
 * 头是不是也泡在水里（真正开始溺水）。
 *
 * 单独一条是因为**"在水里"和"会淹死"是两件事**：淹死的条件是头进水，不是身体
 * 进水。所以找不到岸的时候，正确的目标不是"上岸"，而是"把头露出水面"——
 * 做不到前者时后者仍然救得了命。
 *
 * 跟 `edges.ts` 的 `submerged` 用的是同一个取法（脚底 +1.6 格 = 头），两处必须
 * 一致，否则会出现"事件说溺水、出水代码说没有"。
 */
export function headInWater(bot: unknown): boolean {
  const p = (bot as { entity?: { position?: { x?: unknown; y?: unknown; z?: unknown } } } | null)?.entity
    ?.position;
  if (p == null) return false;
  const x = Math.floor(Number(p.x ?? 0));
  const y = Math.floor(Number(p.y ?? 0) + 1.6);
  const z = Math.floor(Number(p.z ?? 0));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  return isWater(blockAtFrom(bot)(x, y, z));
}

export function waterUnderFeet(bot: unknown): WaterClass {
  const p = (bot as { entity?: { position?: { x?: unknown; y?: unknown; z?: unknown } } } | null)?.entity
    ?.position;
  if (p == null) return EMPTY_WATER;
  const x = Math.floor(Number(p.x ?? 0));
  const y = Math.floor(Number(p.y ?? 0));
  const z = Math.floor(Number(p.z ?? 0));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return EMPTY_WATER;
  return classifyWaterAt(blockAtFrom(bot), x, y, z);
}

export default {
  SAFE_WATER_DEPTH,
  BFS_MAX_NODES,
  BFS_RADIUS,
  MAX_DEPTH_LOOK,
  waterLevel,
  isWater,
  waterDepthAt,
  reachesFlowingWater,
  classifyWaterAt,
  isDangerousWaterAt,
  blockAtFrom,
};
