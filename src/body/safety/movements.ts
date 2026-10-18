/**
 * 寻路配置（`Movements`）的唯一出口。
 *
 * ## 为什么不能有第二处 `new Movements(bot)`
 *
 * 这个模块写之前，全仓库有 **18 处** `new Movements(bot)`，而安全配置只写在其中
 * **一处**（`goToGoal`）里。后果是：追怪、逃跑、绕后、捡东西、保命 fleeTo——
 * **16 条路径上的深水闸门全是关着的**。闸门放在"某个函数里"而不是"配置从哪儿
 * 来"，等于把安全交给了调用方记得不记得。
 *
 * 而 pathfinder 是**按 Movements 实例**判安全的（`movements.js`:
 * `b.safe = ... && !this.blocksToAvoid.has(b.type)`），谁给它的实例没配过，
 * 它就老老实实往水里走。所以正确做法不是在每个调用点补一遍，而是**让实例只有
 * 一个来源**。
 *
 * ## 三层防线，这层是第 1 层
 *
 * 1. **路径层（这里）** —— 任何寻路都不许规划穿过水的路线。100% 覆盖，不依赖
 *    调用点。
 * 2. **目标层** —— 有明确坐标的目标点预先拒绝（`goToGoal` 里那道）。
 * 3. **执行层** —— 已经进水了就强制出水（`forceExitWater`）。
 *
 * 只有第 1 层是"在任何情况下都有效"的：第 2 层管不了动态目标（追怪时怪跳进
 * 水里），第 3 层是事后补救。
 */

import pf from 'mineflayer-pathfinder';
import * as mc from '../data/mcdata.js';
import { deepWaterAllowed } from './permits.js';

/** 判据的出处在 `permits.ts`（那里只有纯逻辑，不拖重依赖），这里原样转出。 */
export { deepWaterAllowed };

/** 落差上限。默认 4 太大，真机上被带着摔死过。 */
export const MAX_DROP_DOWN = 2;

/**
 * 水的方块 id。
 *
 * **优先从 bot 自己的 registry 拿**，不用 `mcdata.getBlockId`：后者模块里的
 * `mcdata` 初始是 `null`、连上服务器才赋值，而它内部直接 `mcdata.blocksByName`
 * ——没连上时是 **TypeError，不是返回 null**。工厂被 18 个调用点共用，在这里
 * 抛一次就是全 bot 瘫痪，比"这次不拦水"糟得多。
 *
 * pathfinder 自己造 Movements 时也是读 `bot.registry`（它往 blocksToAvoid 里
 * 塞 fire / cobweb / lava 用的就是这套），跟它对齐最稳。
 *
 * 拿不到就返回 null —— 调用方据此跳过水策略，而不是崩。
 */
export function waterBlockId(bot: unknown): number | null {
  const reg = (bot as { registry?: { blocksByName?: Record<string, { id?: unknown }> } } | null)?.registry
    ?.blocksByName?.water;
  if (reg != null && typeof reg.id === 'number') return reg.id;
  try {
    return mc.getBlockId('water');
  } catch {
    // mcdata 还没初始化（bot 没连上）。这时候也谈不上寻路，跳过即可。
    return null;
  }
}

/**
 * 水策略：**只改 `blocksToAvoid`**。
 *
 * 为什么不是 `allowWater`：这个版本的 pathfinder 根本没有那个字段（只有
 * allowSprinting / allowParkour / allow1by1towers / allowFreeMotion /
 * allowEntityDetection）。写上去不报错、也完全没用——寻路照样下水。
 * 真正管用的是把水的 block id 塞进 `blocksToAvoid`，跟它自己对 fire / cobweb /
 * lava 的做法一样。
 *
 * `waterId` 由调用方给（见 `waterBlockId`），所以这里是**纯函数**，能直接单测；
 * 传 null 就什么都不做，不抛。
 */
export function applyWaterPolicy(movements: unknown, waterAllowed: boolean, waterId: number | null): void {
  if (waterId == null) return;
  const m = movements as { blocksToAvoid?: { add?: (id: number) => void; delete?: (id: number) => void } } | null;
  const set = m?.blocksToAvoid;
  if (set == null || typeof set.add !== 'function' || typeof set.delete !== 'function') return;
  if (waterAllowed) set.delete(waterId);
  else set.add(waterId);
}

/**
 * 应用全部安全基线。调用方在**之后**再覆盖自己的偏好（digCost / canDig /
 * allow1by1towers 之类），这样安全项永远不会被业务偏好盖掉。
 */
export function applySafety(bot: unknown, movements: unknown): void {
  const m = movements as Record<string, unknown> | null;
  if (m == null) return;
  // 落差：默认 4，真机被带着直落 12~13 格摔死过
  // （pib "从 y=29 掉回来 12 格"、pia "竖井直落 13 格"）。
  m.maxDropDown = MAX_DROP_DOWN;
  // 冲刺不只是快：`movements.js` 里 `const maxD = this.allowSprinting ? 4 : 2`，
  // 开着它寻路会认为"跳/落 4 格"可达，于是敢往边缘冲。真机证据（pib）：
  // 38.5,9.92,10.84 → 被 sprint 往北拖 20+ 格 → 坠落，血只剩 6。跑酷同理。
  m.allowSprinting = false;
  m.allowParkour = false;
  applyWaterPolicy(movements, deepWaterAllowed(bot), waterBlockId(bot));
}

/**
 * 1x1 搭塔的垫脚方块：**从背包里实际有的整方块来**。
 *
 * 库默认只认 `dirt` + `cobblestone`（`node_modules/mineflayer-pathfinder/lib/movements.js:90-92`），
 * 而我们的机器人在下界手上是 **netherrack / cobbled_deepslate** —— `movements.js:576`
 * 在 `remainingBlocks === 0` 时直接拒绝 tower move，于是"允许搭方块"
 * （`allow1by1towers` 默认就是 true）变成一句空话：背包里 400 块也搭不起来。
 * 用户 2026-10-18 的原话就是"默认应该允许挖、允许搭才比较合理吧"。
 *
 * 这里把背包里每个**能整块放下**的方块 id 补进 `scafoldingBlocks`。
 * 注意：这只解除"硬拒绝"，**没有**降低放方块的代价——`placeCost` 说了算，
 * 搭塔该贵还是贵。
 */
export function applyScaffoldingBlocks(bot: unknown, movements: unknown): void {
  const m = movements as { scafoldingBlocks?: unknown } | null;
  if (m == null) return;
  const scaffold: number[] = Array.isArray(m.scafoldingBlocks)
    ? [...(m.scafoldingBlocks as number[])]
    : [];
  const b = bot as
    | {
        registry?: {
          blocksByName?: Record<string, { id?: unknown; boundingBox?: unknown }>;
          itemsByName?: Record<string, { id?: unknown }>;
        };
        inventory?: { items?: () => Array<{ name?: unknown }> };
      }
    | null
    | undefined;
  let items: Array<{ name?: unknown }> = [];
  try {
    items = b?.inventory?.items?.() ?? [];
  } catch {
    items = [];
  }
  const blocks = b?.registry?.blocksByName ?? {};
  const itemDefs = b?.registry?.itemsByName ?? {};
  for (const item of items) {
    const name = typeof item?.name === 'string' ? item.name : null;
    if (name == null) continue;
    const def = blocks[name];
    if (def == null) continue;                       // 不是方块（煤/铁锭/羽毛…）
    if (def.boundingBox != null && def.boundingBox !== 'block') continue;  // 火把/铁轨放不成整块
    // ⚠️ **必须是物品 id，不是方块 id。** pathfinder 的塔移动拿背包物品的
    // `item.type`（物品注册表 id）和 `scafoldingBlocks` 比（movements.js:576），
    // 而库自己的默认值也是 `registry.itemsByName.dirt.id`。1.13+ 之后方块 id 和
    // 物品 id **不是一回事**：泥土 方块 9 / 物品 28，下界岩 方块 255 / 物品 324。
    // 用方块 id 填进去等于一条也匹配不上——"允许搭塔"还是句空话。
    const id = itemDefs[name]?.id ?? def.id;
    if (typeof id === 'number' && !scaffold.includes(id)) scaffold.push(id);
  }
  m.scafoldingBlocks = scaffold;
}

/**
 * 拿一套配好安全基线的 Movements。
 *
 * **所有**需要寻路的地方都必须走这里。想要破坏性寻路就在返回值上改 `digCost`
 * 之类，别自己 new 一个。
 */
export function movementsFor(bot: unknown): any {
  const m = new (pf as any).Movements(bot);
  applySafety(bot, m);
  applyScaffoldingBlocks(bot, m);
  return m;
}

export default {
  MAX_DROP_DOWN,
  deepWaterAllowed,
  applyWaterPolicy,
  applySafety,
  applyScaffoldingBlocks,
  movementsFor,
};
