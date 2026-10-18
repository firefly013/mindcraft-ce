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
 * 1. **路径层（这里）** —— 寻路不许规划穿过水的路线；**但「避开 X」永远不能
 *    用在「你此刻正站在 X 里」上**（用户 2026-10-18 的原话，见
 *    `relaxAvoidedTypesBotIsInside`）：站在水里时水必须对该次搜索可通行，
 *    否则避水规则会把它自己那格的**所有邻居**判成危险，A* 连第一步都没有，
 *    报 `No path to the goal` —— 用来出水的那条路被"防水"关掉了。
 * 2. **目标层** —— 有明确坐标的目标点预先拒绝（`goToGoal` 里那道）。
 * 3. **执行层** —— 已经进水了就强制出水（`forceExitWater`）。
 *
 * 第 1 层是"在任何情况下都有效"的那层；它现在按**状态**评估（每次
 * `movementsFor()` 都重新读 bot 此刻站的那两格），不是启动时算一次。
 */

import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
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
 * **「避开 X」永远不能应用在「你此刻正站在 X 里」的情况上。**
 *
 * 这是用户 2026-10-18 的原话，也是今晚两个 bot 被自己的安全策略锁死的根因：
 * 脚在水里时，水在 `blocksToAvoid` 里 → 自己那格的**每个邻居**都是"危险" →
 * A* 第一步都迈不出去 → `No path to the goal`。用来出水的那条路，被"防水"关掉了。
 *
 * 做法是把它当**状态**而不是常量：
 *   - 逐次寻路评估（`movementsFor()` 每次新建实例时都重新读 bot 的位置）；
 *   - **泛化到整个 `blocksToAvoid`**，不是只给 water 开洞：任何"被避开的方块类型"
 *     只要 bot 此刻脚/头就在里面，就从这一套 Movements 里摘掉；
 *   - 只在这一套实例上生效——bot 一上岸，下一次寻路又是全避让（不会"刚才碰过水，
 *     以后就能穿湖"）。
 *
 * @returns 这次被临时放开的方块 id（调试/日志用）。
 */
export function relaxAvoidedTypesBotIsInside(bot: unknown, movements: unknown): number[] {
  const m = movements as { blocksToAvoid?: Set<number> } | null;
  const set = m?.blocksToAvoid;
  if (set == null || typeof set.delete !== 'function') return [];
  const relaxed: number[] = [];
  for (const id of blockIdsBotIsInside(bot)) {
    if (typeof set.has === 'function' && set.has(id)) {
      set.delete(id);
      relaxed.push(id);
    }
  }
  return relaxed;
}

/** bot 脚/头所在两格的方块 id（读不到就返回空集）。 */
function blockIdsBotIsInside(bot: unknown): Set<number> {
  const ids = new Set<number>();
  const b = bot as
    | { entity?: { position?: { x?: unknown; y?: unknown; z?: unknown } }; blockAt?: (pos: unknown) => unknown }
    | null
    | undefined;
  const p = b?.entity?.position;
  if (p == null || typeof b?.blockAt !== 'function') return ids;
  const x = Math.floor(Number(p.x));
  const y = Math.floor(Number(p.y));
  const z = Math.floor(Number(p.z));
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return ids;
  for (const dy of [0, 1]) {
    try {
      const block = b.blockAt(new Vec3(x, y + dy, z)) as { type?: unknown } | null | undefined;
      const id = Number(block?.type);
      if (Number.isFinite(id) && id >= 0) ids.add(id);
    } catch {
      // 这一格读不到就算了：宁可少放开一个类型，也不能让寻路崩掉。
    }
  }
  return ids;
}

/**
 * 应用全部安全基线。调用方在**之后**再覆盖自己的偏好（digCost / canDig /
 * allow1by1towers 之类），这样安全项永远不会被业务偏好盖掉。
 *
 * `options.allowWater` 是给**逃生专用**的一次性放宽：只允许 `escapeWater`
 * 这类"我已经在水里了"的动作传 true。普通移动绝不能传——见下面的注释。
 */
export function applySafety(bot: unknown, movements: unknown, options?: { allowWater?: boolean }): void {
  const m = movements as Record<string, unknown> | null;
  if (m == null) return;
  // 落差：默认 4，真机被带着直落 12~13 格摔死过
  // （pib "从 y=29 掉回来 12 格"、pia "竖井直落 13 格"）。
  m.maxDropDown = MAX_DROP_DOWN;
  // **冲刺与跑酷：用户明确要求不许禁（2026-10-18 17:26 原话："这玩意不能禁止"）。**
  //
  // 这里曾经是 `= false`，理由是"开着它寻路会认为跳/落 4 格可达，于是敢往边缘冲"
  // （真机 pib：被 sprint 往北拖 20+ 格 → 坠落，血剩 6）。但那是**一刀切**：
  // 库里 `const maxD = this.allowSprinting ? 4 : 2`（movements.js:664），
  // **关掉冲刺等于把能考虑的跳跃距离从 4 格砍到 2 格**，可行走图大幅缩小——
  // 在下界"实心岩体与空腔交替"的地形里（实测 y70-85 实心率逐列在 0%~100% 跳变），
  // 直接后果就是"绕不过去就只能挖"，也就是模型反馈的"30 回合只推进 100 格"。
  // 用户的判断成立：为了防几次摔死而砍掉整张图，代价大于收益。
  //
  // 现在改成默认开；真正致命的东西（脚下岩浆/虚空、落差）继续由 `maxDropDown`
  // 与避让集合去管，而不是靠"把能力关掉"。
  m.allowSprinting = true;
  m.allowParkour = true;
  // **逃生例外**：`escapeWater` 只有在"脚已经在水中"时才会被调用，而避水规则
  // 会把水里那格的**所有相邻格**都判成危险 —— A* 一步都迈不出去，工具自相矛盾
  // （真机 2026-10-18 21:37，overnight_b 卡在 1×1 水坑里，rung 1 的原话就是
  // "避水规则把所有相邻格都判成危险，A* 因此一步都走不出去"）。
  // 所以逃生寻路要临时允许走水；**普通移动仍然严格避水**（这条策略没变，
  // 只是多了一个只给逃生用的开关，见 `goToPosition` 的 `allowWater` 参数）。
  applyWaterPolicy(movements, options?.allowWater === true || deepWaterAllowed(bot), waterBlockId(bot));
  // **状态化豁免（用户规则）：站在 X 里就不许再"避开 X"。**
  // 顺序很重要：先按策略把水加进/摘出避让集，再把"bot 此刻身体所在类型"放开。
  relaxAvoidedTypesBotIsInside(bot, movements);
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
export function movementsFor(bot: unknown, options?: { allowWater?: boolean }): any {
  const m = new (pf as any).Movements(bot);
  applySafety(bot, m, options);
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
