/**
 * 交互类工具：`useBlock` / `useEntity` / `craft`。
 *
 * ## 为什么要把一批中层工具收成一个
 *
 * 原来有十个工具把"固定流程"写死在里面：`craftRecipe`（放工作台+合成）、
 * `smeltItem`（放炉子+烧+取）、`putInChest`/`takeFromChest`/`viewChest`、
 * `tradeWithVillager`/`showVillagerTrades`、`goToBed`、`clearFurnace`、
 * `givePlayer`（跑过去+扔）。流程一写死，环境不配合就整条失败，而且**失败在
 * 哪一步模型看不见**——模型反馈里那两条"调用后再无音讯、不知道成功失败还是
 * 被中断"，根子就是这个黑盒。
 *
 * ## `useBlock`：四个参数说清绝大多数交互
 *
 * | `input` | `output` | 做什么 |
 * |---|---|---|
 * | 有 | 无 | **存进去**（箱子） |
 * | 无 | 有 | **取出来**（箱子 / 熔炉取成品） |
 * | 有 | 有 | **加工**（合成 / 烧炼 / 铁砧），`output` 是**断言** |
 * | 无 | 无 | **直接用这个方块**（开箱子读内容 / 睡 / 开关门 / 附魔台读可选附魔） |
 *
 * `action` 参数**不需要**——谁为 null 就决定了干什么；`type` 天然消歧（同样
 * `input={stone_pickaxe}`，`type=chest` 是"存进去"，`type=crafting_table`
 * 是"要合出这个"）。
 *
 * ## 走路：给了 coords 才走
 *
 * 给了 `coords` → 走过去用那一格（坐标上不是该方块就明确报"是 X 不是 Y"）；
 * 没给（**常态**）→ 用够得着的最近一个，不走动。走路因此只是流程里**可被看见
 * 的一段**，不是隐藏段。
 *
 * ## 分阶段报告
 *
 * 结果逐段写清楚：走到哪 → 放入了什么 → 产出了什么 → 有没有收进背包。
 * 失败也分段："走到 (x,y,z) 失败：路径被堵" / "输入不够：石头只有 2 个"。
 * 同样的流程，摊开就不再是黑盒。
 */
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../data/mcdata.js';
import { describeDyedShortfall, formatUnknownItemReceipt } from '../library/item_names.js';
import { describeCraftShortfallForBot } from '../library/craft_shortfall.js';
import { planRouteThreatResponse, threatsNearRoute } from '../safety/path_threat.js';
import Vec3 from 'vec3';
import { td, tp } from '../../shared/prompts.js';
import { inventoryLossAdvice } from '../../shared/inventory_advice.js';
import { FOOD_VALUE } from '../safety/emergency.js';
import type { AgentCommand } from './actions.js';

/** 物品规格：`{name, count}` 或裸名字。 */
export interface ItemSpec {
  name: string;
  count: number;
  /**
   * 模型是否**显式**给了数量。
   *
   * 没给时 `count=1` 只是默认值，**不能**当成"只要 1 个"——真机报告
   * 「从熔炉取物一次只取 1 个」就是这个默认值被当成了语义：原版熔炉取物是
   * **把产物槽里现有的全拿走**。显式给了数量才按数量取，并报告剩下多少。
   */
  countGiven?: boolean;
}

/**
 * 把模型给的 `input`/`output` 归一成物品规格。
 *
 * 收 `unknown` 是因为它直接从工具参数来（模型可能写 `"3 stone"`、`{name, count}`
 * 或者 `[{...}, {...}]`）。**归一失败要说清怎么改**，不能吞。
 */
export function parseItems(raw: unknown): { items: ItemSpec[]; error?: string } {
  const value = coerceJson(raw);
  if (value == null) return { items: [] };
  // **按逗号拆**：模型很自然会写 `"coal, stick"` / `"white_wool, white_wool, oak_planks"`。
  // 不拆的话整串会被当成**一个物品名**去找，回显就成了"去重成 ×1"——真机上两个模型
  // 都撞到这条，还各自做了对照实验来定位。
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.includes(',')
      ? value.split(',')
      : [value];
  const list = source.map((entry) => (typeof entry === 'string' ? entry.trim() : entry)).filter((entry) => entry !== '');
  const items: ItemSpec[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      // 支持 "3 stone" / "stone 3" / "stone"
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(entry) ?? /^\s*(.+?)\s+(\d+)\s*$/.exec(entry);
      if (m != null) {
        const a = m[1] ?? '';
        const b = m[2] ?? '';
        const count = /^\d+$/.test(a) ? Number(a) : Number(b);
        const name = /^\d+$/.test(a) ? b : a;
        items.push({ name, count, countGiven: true });
      } else {
        items.push({ name: entry.trim(), count: 1, countGiven: false });
      }
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const obj = entry as Record<string, unknown>;
      const name = obj['name'] ?? obj['item'] ?? obj['item_name'];
      if (typeof name !== 'string' || name === '') {
        return { items: [], error: '每项都要有 name（例如 {"name":"stone","count":3}）。' };
      }
      const rawCount = obj['count'] ?? obj['num'] ?? 1;
      const count = typeof rawCount === 'number' ? rawCount : Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) {
        return { items: [], error: `"${name}" 的数量要是正整数。` };
      }
      items.push({ name, count, countGiven: true });
      continue;
    }
    return { items: [], error: 'input/output 只能是物品名、{name,count} 或它们的数组。' };
  }
  return { items };
}

/** 背包里某物品的数量。读不到就返回 null（宁可说"不知道"也不猜）。 */
export function countInInventory(bot: unknown, name: string): number | null {
  const b = bot as {
    inventory?: { items?: () => Array<{ name?: unknown; count?: unknown }> };
    /** 身体在"登录后、背包第一次同步前"会把这里置 false（见 MineflayerBody）。 */
    __inventorySynced?: boolean;
  };
  // **还没同步过就返回 null，不许返回 0**：刚重连时 `items()` 是空数组，
  // 那是"还没到"不是"没有"。把它当 0 会让"我有几个 X?"的判断全部走成
  // "一个都没有"，于是重采/重做/以为丢东西（真机 2026-10-18 事故）。
  if (b?.__inventorySynced === false) return null;
  try {
    const items = b.inventory?.items?.() ?? [];
    let total = 0;
    let seen = false;
    for (const item of items) {
      if (item?.name !== name) continue;
      seen = true;
      total += typeof item.count === 'number' ? item.count : 1;
    }
    return seen ? total : 0;
  } catch {
    return null;
  }
}

/** 结算客户端背包：等几拍，让 window_items / set_slot 包落地。 */
export async function settleInventory(bot: unknown, rounds = 3, waitMs = 50): Promise<void> {
  const b = bot as { waitForTicks?: (n: number) => Promise<unknown> | unknown };
  for (let i = 0; i < rounds; i++) {
    try {
      if (typeof b?.waitForTicks === 'function') {
        await b.waitForTicks(1);
        continue;
      }
    } catch {
      // 等 tick 失败就退到定时等待。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * 合成/加工前读数量：如果本地背包暂时看不到材料，先等几拍让它同步，再读一次。
 *
 * 真机故障：craft iron_leggings 连续报缺材料，重启才同步。客户端背包是
 * 服务端 packet 推下来的，包在飞的时候直接读会读到旧值；这里最多等
 * `maxWaitMs`，把"有材料却报缺"压到最小。
 */
export async function countInInventoryWithSync(
  bot: unknown,
  name: string,
  wantedMin = 1,
  maxWaitMs = 800,
): Promise<number | null> {
  const started = Date.now();
  let count = countInInventory(bot, name);
  while ((count == null || count < wantedMin) && Date.now() - started < maxWaitMs) {
    await settleInventory(bot, 1, 50);
    count = countInInventory(bot, name);
  }
  return count;
}

/**
 * 够得着的最近一个 `type` 方块；没有就 null。
 *
 * "够得着"用与方块交互的距离（约 4.5 格，取 4 保守一点）。
 */
export function nearestReachableBlock(
  bot: unknown,
  type: string,
  maxDistance = 4,
): { x: number; y: number; z: number } | null {
  const b = bot as {
    entity?: { position?: { x?: number; y?: number; z?: number } };
    blockAt?: (p: unknown) => { name?: unknown } | null;
  };
  const pos = b.entity?.position;
  if (pos == null || typeof b.blockAt !== 'function') return null;
  const px = Number(pos.x);
  const py = Number(pos.y);
  const pz = Number(pos.z);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
  // task-9：**故意不用 `bot.findBlocks`**——它只在自己维护的世界视图里翻，刚放下的方块、
  // 就在脚边 1 格的方块都会漏（模型真机：工作台在 1 米外、快照也写着，useBlock 却报
  // "身边 4 格内没有够得着的 crafting_table"）。改成以 `blockAt` 逐格扫一个小立方体，
  // 读到什么算什么，和 Live State 的方块感知同一口径。
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const cz = Math.floor(pz);
  const r = Math.max(1, Math.min(8, Math.ceil(maxDistance)));
  let best: { x: number; y: number; z: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        let block: { name?: unknown } | null;
        try {
          block = b.blockAt(new Vec3(x, y, z));
        } catch {
          continue;
        }
        if (block == null || block.name !== type) continue;
        const d = Math.hypot(x - px, y - py, z - pz);
        if (d > maxDistance + 0.5) continue;
        if (d < bestD) {
          bestD = d;
          best = { x, y, z };
        }
      }
    }
  }
  return best;
}

/**
 * task-9：燃料的跨堆统计与预投料。
 *
 * 真机 bug：`skills.smeltItem` 用 `mc.getSmeltingFuel(bot)` 只拿到**第一个**燃料堆，
 * 再拿 `fuel.count`（单堆数量）去比 `put_fuel`。模型背包 14 个煤分散成几堆时，
 * 第一堆也许只有 2 个，于是回执写「you need 2 coal」——明明全背包合计够。
 * skills.ts / mcdata.ts 不在本任务改动范围，所以这层修在交互层：调 smeltItem 之前
 * 先按**全背包求和**把燃料投进熔炉，让它进到 `if (!furnace.fuelItem())` 的 false
 * 分支，绕开那段单堆判断。
 */
export interface FuelPlan {
  name: string;
  unitOutput: number;
  needed: number;
  available: number;
  stacks: number;
  ok: boolean;
}

/** 燃料优先级：优质燃料(煤/木炭/烈焰棒) → 木头 → 煤块/岩浆桶。数字越小越优先。 */
export function fuelTier(name: string): number {
  if (name === 'coal' || name === 'charcoal' || name === 'blaze_rod') return 0;
  if (name.includes('log') || name.includes('planks')) return 1;
  if (name === 'coal_block' || name === 'lava_bucket') return 2;
  return 3;
}

/**
 * 按全背包求和挑一种燃料，并算清"要几个、现在有几个（分几堆）、够不够"。
 * 优先挑总量够烧的燃料；都够就按优先级；都不够就挑覆盖率最高的报清楚。
 * 完全没有燃料返回 null。
 */
export interface FuelTotals {
  ok: boolean;
  capacity: number;
  entries: Array<{ name: string; count: number; unit: number; capacity: number }>;
}

/**
 * **按全背包求和所有燃料**（Lead 2026-10-21：燃料判定只认 oak_planks，B 背包有
 * `oak_planks×1 + stick×4`（合计 3.5 个物品）却被判"燃料不够：需要 2 个 oak_planks"，
 * 卡在"有原料、有燃料、系统说没燃料"）。用 mcdata 的燃料表，任何名字都不硬编码。
 */
export function planFuelTotals(bot: unknown, smeltCount: number): FuelTotals | null {
  const b = bot as { inventory?: { items?: () => Array<{ name?: unknown; count?: unknown }> } };
  let items: Array<{ name?: unknown; count?: unknown }>;
  try {
    items = b.inventory?.items?.() ?? [];
  } catch {
    return null;
  }
  const totals = new Map<string, number>();
  for (const item of items) {
    if (typeof item?.name !== 'string') continue;
    const unit = mc.getFuelSmeltOutput(item.name);
    if (!(unit > 0)) continue;
    const count = typeof item.count === 'number' ? item.count : 1;
    totals.set(item.name, (totals.get(item.name) ?? 0) + count);
  }
  if (totals.size === 0) return null;
  const entries = [...totals.entries()]
    .map(([name, count]) => ({ name, count, unit: mc.getFuelSmeltOutput(name), capacity: mc.getFuelSmeltOutput(name) * count }))
    .sort((x, y) => y.unit - x.unit);
  const capacity = entries.reduce((sum, entry) => sum + entry.capacity, 0);
  return { ok: capacity >= smeltCount, capacity, entries };
}

export function planAggregateFuel(bot: unknown, smeltCount: number): FuelPlan | null {
  const b = bot as { inventory?: { items?: () => Array<{ name?: unknown; count?: unknown }> } };
  let items: Array<{ name?: unknown; count?: unknown }>;
  try {
    items = b.inventory?.items?.() ?? [];
  } catch {
    return null;
  }
  const totals = new Map<string, { count: number; stacks: number }>();
  for (const item of items) {
    if (typeof item?.name !== 'string') continue;
    const count = typeof item.count === 'number' ? item.count : 1;
    const entry = totals.get(item.name) ?? { count: 0, stacks: 0 };
    entry.count += count;
    entry.stacks += 1;
    totals.set(item.name, entry);
  }
  const plans: FuelPlan[] = [];
  for (const [name, entry] of totals) {
    const unitOutput = mc.getFuelSmeltOutput(name);
    if (!(unitOutput > 0) || entry.count <= 0) continue;
    const needed = Math.max(1, Math.ceil(smeltCount / unitOutput));
    plans.push({ name, unitOutput, needed, available: entry.count, stacks: entry.stacks, ok: entry.count >= needed });
  }
  if (plans.length === 0) return null;
  plans.sort((a, b2) => {
    if (a.ok !== b2.ok) return a.ok ? -1 : 1;
    const ta = fuelTier(a.name);
    const tb = fuelTier(b2.name);
    if (ta !== tb) return ta - tb;
    const ca = a.available / a.needed;
    const cb = b2.available / b2.needed;
    if (cb !== ca) return cb - ca;
    return b2.available - a.available || a.name.localeCompare(b2.name);
  });
  return plans[0] ?? null;
}

/** 一种燃料 × 个数的可烧数量（考虑木板 1.5 这种小数）。 */
function fuelCapacity(name: string, count: number): number {
  return mc.getFuelSmeltOutput(name) * count;
}

/**
 * 调 smeltItem 之前，按全背包求和把燃料准备好。返回 ok=false 时调用方**不要**再
 * 调 smeltItem，否则又会被它的单堆判断误报。
 */
export async function ensureAggregateFuel(
  bot: any,
  smeltCount: number,
  // useBlock 已经定位到的熔炉坐标。**优先用它**：`world.getNearestBlock` 走
  // `findBlocks`，真机上刚放下/就在 1 格外的方块都可能漏（和 nearestReachableBlock
  // 是同一个坑），不能让它把这个 bug 从后门带回来。
  furnaceAt: { x: number; y: number; z: number } | null = null,
): Promise<{ ok: boolean; detail: string }> {
  let furnaceBlock: any = null;
  if (furnaceAt != null && typeof bot?.blockAt === 'function') {
    try {
      furnaceBlock = bot.blockAt(new Vec3(furnaceAt.x, furnaceAt.y, furnaceAt.z));
    } catch {
      furnaceBlock = null;
    }
  }
  if (furnaceBlock == null) furnaceBlock = world.getNearestBlock(bot, 'furnace', 16);
  if (furnaceBlock == null) {
    const hasFurnace = Number(world.getInventoryCounts(bot)['furnace'] ?? 0) > 0;
    if (!hasFurnace) {
      return { ok: false, detail: '附近 16 格没有熔炉，背包里也没有熔炉——先做一个（8 个圆石）或找到一个熔炉。' };
    }
    const free = world.getNearestFreeSpace(bot, 1, 16);
    if (free == null) return { ok: false, detail: '想放熔炉，但附近找不到合适的空地。' };
    await skills.placeBlock(bot, 'furnace', free.x, free.y, free.z);
    furnaceBlock = world.getNearestBlock(bot, 'furnace', 16);
    if (furnaceBlock == null) return { ok: false, detail: '放了熔炉却读不回来——区块可能没加载，稍后再试。' };
  }
  if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
    await skills.goToNearestBlock(bot, 'furnace', 4, 16);
  }
  let furnace: any = null;
  try {
    furnace = await bot.openFurnace(furnaceBlock);
    const existing = furnace?.fuelItem?.() as { name?: string; count?: number } | null | undefined;
    if (existing != null && Number(existing.count ?? 0) > 0 && typeof existing.name === 'string') {
      const capacity = fuelCapacity(existing.name, Number(existing.count ?? 0));
      if (capacity >= smeltCount) {
        return { ok: true, detail: `熔炉里已有 ${existing.name}×${existing.count}（够烧约 ${Math.floor(capacity)} 个），直接烧。` };
      }
      const have = countInInventory(bot, existing.name) ?? 0;
      if (have > 0 && capacity + fuelCapacity(existing.name, have) >= smeltCount) {
        const more = Math.max(1, Math.ceil((smeltCount - capacity) / mc.getFuelSmeltOutput(existing.name)));
        await furnace.putFuel(mc.getItemId(existing.name), null, more);
        return { ok: true, detail: `熔炉里有 ${existing.name}×${existing.count}，再从背包补投 ${more} 个（合计够烧 ${smeltCount} 个）。` };
      }
      const plan2 = planAggregateFuel(bot, smeltCount);
      return {
        ok: false,
        detail:
          `熔炉里的 ${existing.name}×${existing.count} 不够烧 ${smeltCount} 个，背包里也不够同种续投。` +
          (plan2 != null ? `背包跨堆合计：${plan2.name} 有 ${plan2.available} 个（需要 ${plan2.needed}）。` : '背包里没有任何燃料。'),
      };
    }
    // **所有燃料求和**（Lead 2026-10-21：只认 oak_planks 会判「有 stick×4 却燃料不够」）；
    // 够了就按单位从大到小投，不够就打印燃料账本，让模型自己判断。
    const totals = planFuelTotals(bot, smeltCount);
    if (totals == null) {
      return { ok: false, detail: '没有燃料：需要煤 / 木炭 / 木头 / 木棍（任何可烧的东西）——放进背包再来。' };
    }
    const ledger = totals.entries
      .map((entry) => `${entry.name}×${entry.count} = ${Math.round(entry.capacity * 10) / 10} 个`)
      .join(' · ');
    if (!totals.ok) {
      return {
        ok: false,
        detail:
          `燃料不够：烧 ${smeltCount} 个需要 ${smeltCount} 个物品的燃料，可用燃料：${ledger}，` +
          `**合计只能烧 ${Math.round(totals.capacity * 10) / 10} 个**（所有可烧的东西都算进去了）。` +
          '补燃料，或减少要烧的数量。',
      };
    }
    let remaining = smeltCount;
    const put: string[] = [];
    for (const entry of totals.entries) {
      if (remaining <= 0) break;
      const itemsNeeded = Math.max(1, Math.ceil(remaining / entry.unit));
      const itemsToPut = Math.min(entry.count, itemsNeeded);
      await furnace.putFuel(mc.getItemId(entry.name), null, itemsToPut);
      put.push(`${entry.name}×${itemsToPut}`);
      remaining -= itemsToPut * entry.unit;
    }
    return {
      ok: true,
      detail:
        `燃料就绪（全背包求和）：${ledger} → 合计可烧 ${Math.round(totals.capacity * 10) / 10} 个，` +
        `够烧 ${smeltCount} 个；已投 ${put.join('、')}。`,
    };
  } catch (error: unknown) {
    return { ok: false, detail: `预处理燃料失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      if (furnace != null) await bot.closeWindow(furnace);
    } catch {
      /* 关不上就算了，别把好端端的加工流程带崩 */
    }
  }
}

/** 到目标方块的直线距离；读不到位置返回 null。 */
export function distanceToBlock(bot: unknown, x: number, y: number, z: number): number | null {
  const pos = (bot as { entity?: { position?: { x?: unknown; y?: unknown; z?: number } } })?.entity?.position;
  const px = Number(pos?.x);
  const py = Number(pos?.y);
  const pz = Number(pos?.z);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return null;
  return Math.hypot(px - x, py - y, pz - z);
}

function passableBlock(block: { name?: unknown; boundingBox?: unknown } | null | undefined): boolean {
  if (block == null) return false;
  if (block.boundingBox === 'empty') return true;
  return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air';
}

function solidBlock(block: { name?: unknown; boundingBox?: unknown } | null | undefined): boolean {
  if (block == null) return false;
  if (block.boundingBox === 'empty') return false;
  return block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air'
    && block.name !== 'water' && block.name !== 'lava';
}

/**
 * 目标方块本身不能站立（熔炉/工作台/箱子）时，找出它周围可以站人的格子。
 *
 * 真机反馈：人就在熔炉旁 0.7 格，`useBlock` 却反复报「路径被堵或到不了」。
 * 根因是拿方块自身坐标当寻路终点。交互只需要「够得着」，所以先试相邻可
 * 站立的格子，别把不可站立的方块当成目的地。
 */
export function findAdjacentStandable(
  bot: unknown,
  x: number,
  y: number,
  z: number,
): Array<{ x: number; y: number; z: number }> {
  const b = bot as { blockAt?: (p: unknown) => { name?: unknown; boundingBox?: unknown } | null };
  if (typeof b.blockAt !== 'function') return [];
  const offsets: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
  ];
  const spots: Array<{ x: number; y: number; z: number }> = [];
  for (const [dx, dy, dz] of offsets) {
    const feet = new Vec3(x + dx, y + dy, z + dz);
    const head = feet.offset(0, 1, 0);
    const below = feet.offset(0, -1, 0);
    try {
      if (!passableBlock(b.blockAt(feet))) continue;
      if (!passableBlock(b.blockAt(head))) continue;
      if (!solidBlock(b.blockAt(below))) continue;
      spots.push({ x: feet.x, y: feet.y, z: feet.z });
    } catch {
      continue;
    }
  }
  return spots;
}

/** 坐标上那个方块的名字（读不到返回 null）。 */
export function blockNameAt(bot: unknown, x: number, y: number, z: number): string | null {
  const b = bot as {
    blockAt?: (p: unknown) => { name?: unknown } | null;
  };
  try {
    // **必须给 Vec3**：mineflayer 的 blockAt 会转给 prismarine-world 的
    // `getBlock(pos)`，后者第一件事是 `pos.floored()`——普通对象没有这个方法，
    // 直接抛异常被下面的 catch 吞成 null（真机事故见 progression.ts 的 vec3At）。
    const block = b.blockAt?.(new Vec3(x, y, z));
    return typeof block?.name === 'string' ? block.name : null;
  } catch {
    return null;
  }
}

/**
 * 把一格里的东西挪到另一格。
 *
 * **逐级回退**：不同 mineflayer 版本把 `moveSlotItem` 放在不同地方——模型真机报过
 * `container.moveSlotItem is not a function`。所以依次试 window 上的、bot 上的，
 * 最后退到 `clickWindow` 的 shift 点击（整栈快速移动，够用且到处都有）。
 */
async function moveOne(bot: any, container: any, src: number, dest: number, count: number): Promise<void> {
  // **优先 shift 点击（原子操作）**。
  //
  // 模型真机给的线索：「挪了 cobblestone×12」**真的从背包消失了**（[34]12→没了、
  // free 0→1），**但重开箱子看内容没变化**——东西离开了背包却没到箱子。
  // 这是典型的**物品卡在光标上**：moveSlotItem 是"点起 + 放下"两次点击，第二次没落地，
  // 物品就留在 cursor，关箱子时被丢到地上。
  //
  // shift 点击（mode 1）**一次点击搬整栈、根本不碰光标**，没有中间状态可丢。
  // 所以先试它；只有它不可用时才退回两次点击的 moveSlotItem。
  if (typeof bot?.clickWindow !== 'function') {
      if (typeof container?.moveSlotItem === 'function') {
          await container.moveSlotItem(src, dest, count);
          return;
      }
      if (typeof bot?.moveSlotItem === 'function') {
          await bot.moveSlotItem(src, dest, count);
          return;
      }
      throw new Error('这个 mineflayer 版本既没有 moveSlotItem 也没有 clickWindow，挪不了物品');
  }

  // **数量必须被尊重。** 以前这里一律 shift 点击——它一次搬**整栈**，于是
  // "存 5 个"变成"整栈 10 个全进去、背包一个不剩"，模型实测后连着报了三次
  // （Feedback：「背包 gravel×10，input=\"5 gravel\" → 真的进了 gravel×10，背包变 0」）。
  // 要全部才走 shift 点击（原子、快）；要一部分就得手工：拿起整栈 → 右键一个个
  // 放 → 把剩下的放回原槽。
  const have = Number((container?.slots?.[src] as { count?: number } | null)?.count ?? 0);
  const want = count > 0 ? count : have;
  if (want >= have || have <= 1) {
      // 整栈：shift 点击一次搞定，不碰光标。
      await bot.clickWindow(src, 0, 1);
      return;
  }

  // 部分搬运：左键拿起整栈 → 右键在目标槽放下 1 个 ×N → 左键把余下的放回源槽。
  await bot.clickWindow(src, 0, 0);
  for (let i = 0; i < want; i++) {
      await bot.clickWindow(dest, 1, 0);
  }
  // 手里还有剩下的，放回源槽——**不放回去就等于把东西留在光标上**，关窗时掉地上。
  const carried = Number(container?.slots?.[-1]?.count ?? 0);
  if (carried > 0) await bot.clickWindow(src, 0, 0);
  if (typeof container?.moveSlotItem === 'function') {
      await container.moveSlotItem(src, dest, count);
      return;
  }
  if (typeof bot?.moveSlotItem === 'function') {
      await bot.moveSlotItem(src, dest, count);
      return;
  }
  throw new Error('这个 mineflayer 版本既没有 moveSlotItem 也没有 clickWindow，挪不了物品');
}

/**
 * 和容器（箱子/桶）之间挪物品。
 *
 * **故意不用 `skills.putInChest`/`takeFromChest`**：它们最终落到 mineflayer 的
 * `window.deposit`/`withdraw`，而那两个只在窗口的 `[inventoryStart, inventoryEnd]`
 * （箱子窗口是 `[27,63]`）里找物品。真机上模型撞到
 * `Can't find oak_log in slots [27 - 63]`，可 `findInventoryItem` 明明找得到——
 * 同一个物品，两条路结论相反。模型还做了对照：`"4 oak_log"` 失败、`"oak_log"`
 * 成功（两者只差 count），把这条 bug 钉得很死。
 *
 * 这里改成**自己扫全部背包槽**再 `moveSlotItem`，失败时把扫了哪些槽、每格是什么
 * 一并报出来——模型说光看 `[27 - 63]` 它完全没法自查。
 */
/** 容器转移的可核对账目；early failure 时字段可以缺省。 */
export interface TransferDetail {
  ok: boolean;
  detail: string;
  containerReadable?: boolean;
  containerBefore?: number | null;
  containerAfter?: number | null;
  containerDelta?: number | null;
  localMoved?: number;
}

function backpackCountLine(name: string, before: number | null, after: number | null): string {
  if (before == null || after == null) return '背包：' + name + ' 读不到（不代表背包是空的）';
  const delta = after - before;
  const sign = delta >= 0 ? '+' : '';
  return '背包：' + name + ' ' + before + ' → ' + after + '（' + sign + delta + '）';
}

/**
 * 取物/存物回执的统一口径。
 *
 * 真机故障：回执先写「取出 iron_ingot×1」（请求量），又写「真的取出了×15」
 * （容器减少量），模型无法判断到底拿到几个；客户端背包又可能延迟十几轮
 * 才看到铁锭。这里拆成三行：请求 / 容器实际变化 / 背包 before→after，
 * 并明确不一致时以哪份账为准、同步延迟不要判定物品蒸发。
 */
export function formatTransferReceipt(
  name: string,
  requested: number,
  direction: 'deposit' | 'withdraw',
  result: TransferDetail,
  backpackBefore: number | null,
  backpackAfter: number | null,
): string {
  const bpLine = backpackCountLine(name, backpackBefore, backpackAfter);
  if (
    result.containerBefore === undefined &&
    result.containerAfter === undefined &&
    result.containerDelta === undefined
  ) {
    return result.detail + '\n    ' + bpLine;
  }
  if (result.containerReadable === false || result.containerDelta == null) {
    const local = result.localMoved ?? 0;
    return (
      '容器读取不可用（重开失败或客户端同步延迟），不能据此判断容器是空还是满；' +
      (local > 0 ? '本地账记录挪了 ' + local + ' 个。' : '本地账没记到明确的挪动。') +
      '\n    ' + bpLine + '。以 stats 为准，稍后再核对。\n    ' + result.detail
    );
  }
  const delta = result.containerDelta;
  const directionLabel = direction === 'deposit' ? (delta >= 0 ? '增加' : '减少') : (delta >= 0 ? '减少' : '增加');
  const containerText =
    result.containerBefore != null && result.containerAfter != null
      ? '容器：' + name + ' ' + result.containerBefore + ' → ' + result.containerAfter + '（' + directionLabel + ' ' + Math.abs(delta) + '）'
      : '容器：' + name + ' 实际变化 ' + delta + '（明细读不到）';
  const lines = [containerText, bpLine];
  const backpackDelta = backpackBefore != null && backpackAfter != null ? backpackAfter - backpackBefore : null;
  if (direction === 'withdraw' && delta > 0 && (backpackDelta == null || backpackDelta <= 0)) {
    lines.push(
      '注意：容器已经少了，但客户端背包暂时没看到增加——这是已知的客户端背包同步延迟（真机里铁锭十几轮后才出现）。不要判定物品蒸发，以 stats 为准，稍后再核对，别重复挖/重复取。',
    );
  }
  if (requested !== Math.abs(delta)) {
    lines.push(
      '口径说明：你请求' + (direction === 'deposit' ? '放入' : '取出') + ' ' + requested + ' 个，服务端容器实际' + directionLabel + ' ' + Math.abs(delta) + ' 个；差值可能包含客户端窗口同步误差，若与 stats 不一致以 stats 为准。',
    );
  } else if (direction === 'withdraw' && backpackDelta != null && backpackDelta > 0) {
    lines.push('核对一致：容器少了 ' + Math.abs(delta) + '，本次进包 ' + backpackDelta + '。');
  }
  if (Math.abs(delta) === 0 && (result.localMoved ?? 0) > 0) lines.push(result.detail);
  return lines.join('\n    ');
}

/** 熔炉族：blasting/smoking 和普通熔炉一样有 input/fuel/output 三个槽。 */
export function isFurnaceLikeBlock(name: unknown): boolean {
  return name === 'furnace' || name === 'blast_furnace' || name === 'smoker';
}

/**
 * 从熔炉**产物槽**取物。
 *
 * 契约（Lead 裁定，2026-10-19）：
 *   - 没显式给数量 ⇒ **取走产物槽里现有的全部**（原版熔炉界面的直觉），报告取到几个；
 *   - 显式给了数量 ⇒ 按数量取，并报告**还剩多少**；
 *   - **不碰原料槽/燃料槽**，并且回执点名只动了产物槽；
 *   - 取到几个必须来自**背包实际增量**（操作前后 countInInventory 的差），
 *     不能来自"我打算取几个"——这是整晚反复用的证据规则。
 *   - 产物槽里只有 1 个时要说"只有 1 个（其余还在烧）"，别让小数看起来像失败。
 */
export async function takeFromFurnace(
  bot: any,
  located: { x: number; y: number; z: number },
  item: ItemSpec,
  type: string,
): Promise<string[]> {
  const lines: string[] = [];
  const block = bot?.blockAt?.(new Vec3(located.x, located.y, located.z));
  if (block == null || !isFurnaceLikeBlock(block.name)) {
    return [`- 目标 (${located.x},${located.y},${located.z}) 读不到 ${type}（区块没加载或坐标偏了），这次没动任何槽位。`];
  }
  const before = countInInventory(bot, item.name);
  let furnace: any = null;
  try {
    furnace = await skills.openBlockUi(bot, block);
  } catch (error: unknown) {
    return [
      `- 打开 ${type} 失败：${error instanceof Error ? error.message : String(error)}`,
      '    （没有从任何槽里取东西；这是"打不开"，不是"里面没有"。）',
    ];
  }
  try {
    const slot = (() => {
      try {
        return furnace?.outputItem?.() ?? null;
      } catch {
        return null;
      }
    })();
    const slotName = typeof slot?.name === 'string' ? slot.name : null;
    const slotCount = Number(slot?.count ?? 0);
    if (slotName == null || !Number.isFinite(slotCount) || slotCount <= 0) {
      return [`- ${type} 的**产物槽是空的**：没有东西可取（原料槽/燃料槽没动；还在烧就再等一会儿）。`];
    }
    if (slotName !== item.name) {
      return [
        `- 产物槽里是 ${slotName}×${slotCount}，不是 ${item.name}——没有取（避免拿错）。` +
          `要取它就写 useBlock(type=${type}, output="${slotName}")；原料槽/燃料槽没动。`,
      ];
    }
    // **显式数量和整叠取物冲突时要诚实**：mineflayer 的 `takeOutput()` 只能整叠取，
    // 没有"取 2 留 3"的接口。数量 < 槽内数量时**不取**并说明，而不是偷偷全拿走
    // 再声称只取了 2 个。
    if (item.countGiven === true && item.count < slotCount) {
      return [
        `- 产物槽里是 ${slotName}×${slotCount}（整叠）：取物接口只能**整叠取**，做不到"只取 ${item.count} 个"——这次**没动**任何槽位（原料槽/燃料槽也没动），${slotCount} 个仍在产物槽里。`,
        `    要精确数量：先整叠取出来（useBlock(type=${type}, output="${item.name}") 不带数量），再把多余的存回去。`,
      ];
    }
    const wanted = item.countGiven === true ? Math.min(item.count, slotCount) : slotCount;
    let remaining = slotCount;
    let passes = 0;
    while (remaining > 0 && passes < 8) {
      passes += 1;
      const got = await (async (): Promise<number> => {
        try {
          const taken = await furnace.takeOutput?.();
          const count = Number(taken?.count ?? 0);
          return Number.isFinite(count) ? count : 0;
        } catch {
          return 0;
        }
      })();
      if (got <= 0) break;
      remaining -= got;
    }
    await settleInventory(bot, 3, 50);
    const after = countInInventory(bot, item.name);
    const delta = before != null && after != null ? after - before : null;
    const takenReport = delta != null ? `${delta} 个` : '（背包读数暂时不可用，取出的数量以 stats 为准）';
    lines.push(`- 从 ${type} 的**产物槽**取出 ${takenReport} ${item.name}（只动了产物槽，原料槽/燃料槽没动）。`);
    if (delta != null && delta < wanted) {
      lines.push(`    注意：这次只拿到 ${delta} 个（产物槽原有 ${slotCount}，这次想取 ${wanted}）——其余可能还在烧，或背包同步延迟；以 stats 为准。`);
    } else if (item.countGiven === true && item.count > wanted) {
      lines.push(`    请求 ${item.count} 个，产物槽只有 ${wanted} 个，剩下的 ${item.count - wanted} 个**没有**可取的了（其余还在烧就再等）。`);
    }
    if (item.countGiven === true) {
      const left = Math.max(0, remaining);
      lines.push(`    显式指定了数量 ${item.count}：这次取 ${wanted} 个，产物槽里还剩 ${left} 个。`);
    } else if (slotCount === 1) {
      lines.push('    产物槽里只有 1 个（其余还在烧）——一次调用取走 1 个，不是失败。');
    }
    return lines;
  } finally {
    try {
      if (furnace != null) await bot.closeWindow(furnace);
    } catch {
      /* 关不上不影响已经取到的结果 */
    }
  }
}

async function transferWithContainer(
  bot: any,
  chestBlock: { x: number; y: number; z: number },
  name: string,
  count: number,
  direction: 'deposit' | 'withdraw',
): Promise<TransferDetail> {
  let container: any;
  try {
    const ok = await skills.goToPosition(bot, chestBlock.x, chestBlock.y, chestBlock.z, 2);
    if (!ok) return { ok: false, detail: '走不到容器旁边' };
    // `openContainer` 要的是 **Block 对象**，不是 `{x,y,z}`——传裸坐标它会报
    // `containerToOpen is neither a block nor an entity`（模型真机报回来的）。
    // 而 `blockAt` 要的是 **Vec3**（内部会调 `.floored()`），传裸对象会报
    // `pos.floored is not a function`（模型紧接着报回来的第二条）。
    const block = bot.blockAt?.(new Vec3(chestBlock.x, chestBlock.y, chestBlock.z));
    if (block == null) return { ok: false, detail: `(${chestBlock.x},${chestBlock.y},${chestBlock.z}) 那里没有方块` };
    // **按方块类型分路**：熔炉族走 `bot.openFurnace`，箱子族才走 `openContainer`。
    // `openContainer` 的白名单里没有 furnace，所以传熔炉进去**必然**抛
    // `containerToOpen is neither a block nor an entity`——见 `skills.openBlockUi`。
    container = await skills.openBlockUi(bot, block);
  } catch (error: unknown) {
    return { ok: false, detail: `打不开容器：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const slots: Array<{ name?: string; count?: number } | null> = container.slots ?? [];
    const invStart = Number(container.inventoryStart ?? 9);
    const invEnd = Number(container.inventoryEnd ?? slots.length);
    // **箱子部分永远是 [0, inventoryStart)**——不要用 containerStart/containerEnd。
    // 模型真机报过"存物回执说挪了 12 个，开箱一看没进去"：如果这两个字段和
    // inventoryStart 对不上，我算出来的"箱子区间"就会指回**玩家背包**，于是物品只是在
    // 背包里换了个格子（源槽确实减少了 → 计数看着像成功），箱子纹丝不动。
    // inventoryStart 是容器部分和玩家部分的分界，这个是可靠的。
    const boxStart = 0;
    const boxEnd = invStart;
    const from = direction === 'deposit' ? { s: invStart, e: invEnd } : { s: boxStart, e: boxEnd };
    const to = direction === 'deposit' ? { s: boxStart, e: boxEnd } : { s: invStart, e: invEnd };

    // 源：按名字找（扫**全部**源槽，不看数量写法）
    const source: number[] = [];
    for (let i = from.s; i < Math.min(from.e, slots.length); i++) {
      if (slots[i]?.name === name) source.push(i);
    }
    if (source.length === 0) {
      // **读不到 ≠ 空**：槽位表本身为空/读不到时，不能写「容器是空的」——
      // 真机上客户端窗口包延迟时就是这样误导模型的。
      // **只列容器区间 [0, inventoryStart)**：不能把查看者背包槽也列出来。
      const slotList = slots
        .slice(0, Math.min(boxEnd, slots.length))
        .map((slot, i) => (slot?.name != null ? `${i}:${slot.name}×${slot.count ?? 1}` : null))
        .filter((slot) => slot != null)
        .slice(0, 24)
        .join(' ');
      if (slots.length === 0) {
        return {
          ok: false,
          detail:
            `容器槽位表读不到（数组为空）：**不能据此判断容器是空的**。` +
            '可能是客户端窗口同步延迟，稍后重开容器或用 stats 核对，再决定要不要重试。',
        };
      }
      return {
        ok: false,
        detail:
          `容器里没找到 ${name}（扫了源槽 [${from.s},${from.e})）。当前容器内容：` +
          (slotList === '' ? '读不到物品名，不能判断是否为空' : slotList) +
          '。如果刚放入/刚取出，可能是客户端同步延迟，稍后 stats 再核对。',
      };
    }

    // **基线**：搬之前箱子里这个物品有多少。最后用它和服务端重开后的数字对比，
    // 由"箱子到底多了没有"决定成败——而不是由"我点了几个槽"决定。
    const countInBox = (slotsArr: Array<{ name?: string; count?: number } | null>): number => {
      let total = 0;
      for (let i = boxStart; i < Math.min(boxEnd, slotsArr.length); i++) {
        const it = slotsArr[i];
        if (it?.name === name) total += Number(it.count ?? 1);
      }
      return total;
    };
    const boxBefore = countInBox(container.slots ?? []);

    let left = count <= 0 ? Number.MAX_SAFE_INTEGER : count;


    let moved = 0;


    const countOf = (idx: number): number => {


      const slot = container.slots?.[idx] as { name?: string; count?: number } | null | undefined;


      return slot != null && slot.name === name ? Number(slot.count ?? 0) : 0;


    };


    for (const src of source) {


      // **每一格搬到搬不动为止**。原来只调用一次 moveOne 就按请求量计数——模型真机


      // 报过"回执说挪了 cobblestone×408，开箱一看只进去 64 个（1 组）"：clickWindow


      // 的 shift 点击一次只搬**一栈**。所以搬完要**回头读容器**，按实际减少量计数。


      let guard = 0;


      while (left > 0 && guard++ < 24) {


        const have = countOf(src);


        if (have <= 0) break;


        const take = Math.min(left, have);


        let dest: number | null = null;


        for (let i = to.s; i < Math.min(to.e, slots.length); i++) {


          const target = container.slots?.[i] as { name?: string } | null | undefined;


          if (target == null) { dest = i; break; }


          if (target.name === name) { dest = i; break; }


        }


        if (dest == null) {
            // **满箱在"找目标槽"这一步就暴露了**：箱子里既没有 ${name} 的堆可并入、
            // 又没有空槽。prober 实测的文案问题就出在这条提前返回——它绕过了
            // 下面那套核对回执，只留下一句内部口径的"挪了 0 个后目标槽满了"。
            // 直接说人话 + 给建议。
            const boxSlots = (container.slots ?? []).slice(0, Math.min(boxEnd, (container.slots ?? []).length));
            const empty = boxSlots.filter((it: { name?: string } | null | undefined) => it?.name == null).length;
            return {
                ok: false,
                detail:
                    `${name} 没能存进箱子：**箱子满了**（${boxSlots.length} 格全有东西、没有能并入的 ${name} 堆）。` +
                    `东西还在你背包里，一件没丢。可以先取走一些、或换一个箱子。` +
                    (empty > 0 ? `（诊断异常：按槽位表还有 ${empty} 格空位却找不到落点，请报给开发者）` : ''),
            };
        }


        await moveOne(bot, container, src, dest, take);


        const after = countOf(src);


        const actual = have - after;


        if (actual <= 0) break; // 没搬动，别死循环


        moved += actual;
        left -= actual;
        // **一次调用只搬一栈就收手**。模型真机实测：整栈（64）能进箱子 ✓，但
        // **非整栈**的（12、11）会"幽灵丢失"——本地账记着搬走了、服务端没接受，
        // 东西既不在箱子也不在背包。一次窗口会话里连做多次点击容易累积这种不同步，
        // 所以搬成功一栈就关箱复核，让模型再调一次搬下一栈（每次都是原子的）。
        break;
      }
      break;
    }
    // **存完把箱子内容读出来**。模型真机报过"回执说挪了 cobblestone×12，开箱一看
    // 没进去"——光看自己的计数分不清"真挪了"还是"窗口索引读错了"。把箱子实际内容
    // 摊开，一眼就能判：挪了却不在箱子里 = 索引/API 用错了，不是模型操作错。
    const boxNow: string[] = [];
    // **用服务端的话来判定**：container.slots 是 mineflayer 的**本地乐观镜像**，
    // 点击后它先改本地账本，所以我能读到"源槽少了"、据此报"挪了 N"，而服务端可能
    // 根本没接受这个操作——模型真机报的"空箱 25 槽仍报账不搬"就是这么来的：
    // 账是本地账、箱子是服务端的箱子。
    //
    // 所以搬完**关掉箱子重开一次**，用服务端返回的新窗口内容做判定。
    let fresh: any = container;
    let freshReadable = false;
    try {
      await container.close?.();
      await new Promise((resolve) => setTimeout(resolve, 250));
      fresh = await skills.openBlockUi(
        bot,
        bot.blockAt?.(new Vec3(chestBlock.x, chestBlock.y, chestBlock.z)),
      );
      freshReadable = Array.isArray(fresh?.slots);
    } catch {
      fresh = container; // 重开失败就退回本地镜像，但下面会说明
      freshReadable = Array.isArray(fresh?.slots);
    }
    const freshSlots: Array<{ name?: string; count?: number } | null> = fresh?.slots ?? [];
    for (let i = boxStart; i < Math.min(boxEnd, freshSlots.length); i++) {
      const it = freshSlots[i];
      if (it?.name != null) boxNow.push(`${it.name}×${it.count ?? 1}`);
    }
    // **读不到 ≠ 空**：重开失败时不要写「（空）」——模型会以为东西没了。
    const boxText = !freshReadable
      ? '读不到（重开容器失败，不能据此判断箱子为空）'
      : boxNow.length > 0
        ? boxNow.join('、')
        : '（重开后服务端返回空；如果刚放入/取出，可能是客户端同步延迟，稍后 stats 再核对）';
    // **成败由服务端说了算**：重开后箱子里这个物品比之前多了多少，才是真正搬进去
    // 的数量。"我点了几个槽"（moved）只是本地账——模型真机报过"挪了 114、箱子没变"，
    // 就是本地账在撒谎（箱子其实满了，服务端拒收）。
    const boxAfter = countInBox(freshSlots);
    // ⚠️ **"箱子多了多少"只在"存入"这个方向成立。**
    //
    // 以前这里一律算 `boxAfter - boxBefore`，于是**取出**方向必然是负的——箱子里的
    // 东西变少了嘛——判定 `landed > 0` 因此恒为 false，一次**成功**的取出被报成
    // "一个都没进去"，还附上一句"它们在服务端不存在、幽灵丢失了"。模型的 Feedback
    // #21 把账对得很清楚：它的 diamond 从 3 变 5、箱子清单里 diamond 也没了，
    // 那就是取到了，而回执硬说失败。危害很实际——它会以为手上是假货，白白重做
    // 甚至丢掉真的东西。
    //
    // 所以按方向取符号：存入看箱子**增加**，取出看箱子**减少**。
    const containerDelta = freshReadable
      ? (direction === 'deposit' ? boxAfter - boxBefore : boxBefore - boxAfter)
      : null;
    const verdict = containerDelta == null
      ? '容器读取不可用（重开失败或客户端同步延迟）；本地账记录挪了 ' + moved + ' 个，不能据此判断容器是空还是满。'
      : containerDelta > 0
        ? direction === 'deposit'
          ? `容器里 ${name} 增加 ${containerDelta}`
          : `容器里 ${name} 减少 ${containerDelta}`
        : `${name}：容器里没看出变化（${direction === 'deposit' ? '没多出来' : '没少下去'}）` +
          (moved > 0
            ? '；本地账记了挪 ' + moved + '，但以重开容器看到的服务端口径为准——结果存疑，请以世界状态复查，不要当成东西凭空消失了'
            : '；一步都没挪动（源槽可能已经空了）') +
          (direction === 'deposit'
            ? (() => {
                const boxSlots = freshSlots.slice(0, Math.min(boxEnd, freshSlots.length));
                const empty = boxSlots.filter((it: { name?: string } | null | undefined) => it?.name == null).length;
                return empty === 0
                  ? '；箱子满了（' + boxSlots.length + ' 格全有东西），要放新物品得先取走一些或换个箱子'
                  : '；箱子还有 ' + empty + ' 格空位';
              })()
            : '');
    return {
      ok: containerDelta != null ? containerDelta > 0 : moved > 0,
      // *不把窗口几何写进回执*：模型要的是这次到底成没成、容器里现在有什么。
      detail: verdict + '；重开容器看到的（服务端口径）：' + boxText,
      containerReadable: freshReadable,
      containerBefore: boxBefore,
      containerAfter: freshReadable ? boxAfter : null,
      containerDelta,
      localMoved: moved,
    };
  } catch (error: unknown) {
    return { ok: false, detail: `挪物品时出错：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      await container?.close?.();
    } catch {
      /* 关不上就算了 */
    }
  }
}

/**
 * 给工具体加超时。
 *
 * 模型真机报过：`useBlock` 挂死 70s+、`Stop` 无效、"机器人被 useBlock 永久锁死，
 * 只能 restart"。原因是这三个新工具是**裸 async**，不像老工具那样包在
 * `ActionManager.runAction` 里，于是卡住就永远占着身体通道。
 *
 * 超时到点后 `ActionRunner.finish` 会继续走到 `releaseAction`，通道被放掉；
 * 同时给模型一句"超时了、卡在哪一步"——比静默锁死好得多。
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(onTimeout === undefined ? (undefined as T) : onTimeout);
        void error;
      },
    );
  });
}

/** 单次 useBlock/useEntity/craft 最多跑多久（毫秒）。 */
const TOOL_TIMEOUT_MS = 45_000;

/** 「这一槽读不到」的哨兵。它和 null（真的空槽）不是一回事。 */
const SLOT_UNREADABLE: unique symbol = Symbol('slot-unreadable');

/** 读容器槽；方法不存在或抛错都归为读不到，不伪装成空槽。 */
function readSlot(container: any, method: string): unknown {
  try {
    if (typeof container?.[method] !== 'function') return SLOT_UNREADABLE;
    return container[method]();
  } catch {
    return SLOT_UNREADABLE;
  }
}

/** 把一个容器槽描述成一行（空槽也说出来，读不到也说出来，别让人猜）。 */
function slotLine(slot: unknown, label: string): string {
  if (slot === SLOT_UNREADABLE) return label + '：读不到（不代表这一槽是空的）';
  const s2 = slot as { name?: unknown; count?: unknown } | null | undefined;
  const name = typeof s2?.name === 'string' ? s2.name : null;
  if (name == null) return label + '：空';
  return label + '：' + name + '×' + String(s2?.count ?? 1);
}

/** 一步的结果行——逐段报告就是靠它拼出来的。 */
function step(text: string): string {
  return `- ${text}`;
}

/**
 * 背包数量变化的**诚实**写法。
 *
 * 原来两处合成回执都写成 `+${now - have}`，于是"材料被吃掉、产物没出来"
 * （`now-have = -1`）会渲染成 **`+-1`**——一个既不是成功也不是失败的字符串。
 * 真机（1.21.11 新档 overnight_b）：
 * 「craft(input="1 oak_log", output="4 oak_planks") → 合成 oak_planks：**+-1**（现在 0 个）」，
 * 背包 oak_log 少 1、oak_planks 仍是 0，模型看不懂这个数，于是反复重试、继续丢材料。
 *
 * 按 LLM-First：回执的职责是**把实测事实说清楚**，让模型自己判断，
 * 不是替它下结论、更不是抛一个自相矛盾的符号。
 */
export function formatItemDelta(have: number, now: number): string {
  const d = now - have;
  const sign = d > 0 ? `+${d}` : d < 0 ? `-${Math.abs(d)}` : '±0';
  return `${sign}（现在 ${now} 个）`;
}

/**
 * 合成"技能报成功、但实测没有产出"时的说明。
 *
 * 旧文案是「可能背包同步延迟……**不要判定材料/产物蒸发**」——这条在真机被证伪：
 * 材料确实少了、产物确实没出来，而这句话明确让模型**不要**怀疑丢东西，
 * 于是它只能反复重试同一个合成。**这是"拿一句安抚把模型的观察力关掉"，正是 LLM-First 的反面。**
 *
 * 现在只说事实 + 给模型可执行的下一步，**不替它下结论**：产物没增加、材料变化是几、
 * 要不要继续由它按 stats 决定。
 */
export function craftNoOutputNote(name: string, have: number, now: number): string {
  const d = now - have;
  return (
    `**实测没有产出**：${name} ${have} → ${now}（变化 ${d > 0 ? '+' : ''}${d}）。` +
    '「技能报成功」不等于背包里有东西，以 stats 的实测数为准。' +
    '你可以先 stats 核对材料：材料也少了，就是真的消耗了，别再重复同一个合成——把这行原样 Feedback 给我们。'
  );
}

/**
 * 跑一个技能，并把它自己写进 `bot.output` 的那几行**如实带回**。
 *
 * 为什么必须这样：技能内部 `log(bot, ...)` 写的是**具体原因**——"You have no
 * fuel to smelt X" / "You do not have enough raw_iron to smelt" / "The furnace
 * is currently smelting Y"。只看布尔值就会把真因换成一句笼统的"缺原料或燃料？"，
 * 真机上两个模型就是这样被误导的：它们交叉验证了 7 种写法，最后一起推断出
 * **错误的**根因（"熔炉需要原料槽+燃料槽两个入口"），还写进了正式反馈。
 * 同样的流程，摊开就不再是黑盒。
 */
async function runSkill(
  bot: unknown,
  lines: string[],
  fn: () => Promise<boolean>,
  okText: string,
  failText: string,
): Promise<boolean> {
  const read = (): string => String((bot as { output?: unknown })?.output ?? '');
  const before = read();
  // **超时兜底**：技能可能长时间不返回（`smeltItem` 会一直循环到全烧完——
  // 真机上就是它把通道占了 70s+，Stop 也没用）。到点就放弃，通道照样释放。
  const timedOut = Symbol('timeout');
  const ok = await withTimeout<boolean | typeof timedOut>(
    fn(),
    TOOL_TIMEOUT_MS,
    timedOut,
  );
  const after = read();
  const delta = (after.startsWith(before) ? after.slice(before.length) : after).trim();
  if (ok === timedOut) {
    lines.push(
      step(
        `${failText}：**超时**（${TOOL_TIMEOUT_MS / 1000} 秒没返回），已释放身体通道。` +
          '注意：**超时 ≠ 没做成**——熔炉这类异步动作常常已经投料成功、在后台继续跑（模型真机验证过：回执超时，但铁锭后来一个个到账）。先看一眼实际状态再决定要不要重试，别盲目重发。',
      ),
    );
    if (delta !== '') {
      for (const line of delta.split('\n')) {
        if (line.trim() !== '') lines.push(`    ${line.trim()}`);
      }
    }
    return false;
  }
  lines.push(step(ok ? okText : failText));
  if (delta !== '') {
    for (const line of delta.split('\n')) {
      if (line.trim() !== '') lines.push(`    ${line.trim()}`);
    }
  }
  return ok;
}

/**
 * 物品规格的容错解析。
 *
 * **必须容忍 JSON 字符串**：工具 schema 把 `input`/`output` 声明成 string，
 * 所以模型传数组时会被序列化成 `[{"name":"raw_copper","count":45},…]` 这样的
 * **一个字符串**。真机上模型按文档写了数组，工具却把整段 JSON 当成一个物品名
 * 去找，回"背包里没有 [{...}]"——模型自己把这条报上来了。
 */
function coerceJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text.startsWith('[') && !text.startsWith('{')) return raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
}

function itemText(items: readonly ItemSpec[]): string {
  return items.map((i) => `${i.name}×${i.count}`).join('、');
}

/** 加工类方块（有 input 也有 output 时走这条）。 */
const PROCESSING_BLOCKS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil']);
/** 熔炉族：既能加工，也能只给 output 把成品取出来。 */
const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);
/**
 * 烧炼的三本账：**背包 / 炉内 / 真丢**（Lead 2026-10-20 裁定）。
 *
 * 真机 overnight_b：`useBlock(type="furnace", coords="27,43,-8", input="5 raw_iron",
 * output="5 iron_ingot")` ⇒ 「燃料就绪…- 烧不了 raw_iron / **Only smelted 1 iron_ingot**
 * - 背包账目：**raw_iron 5 → 0；iron_ingot 0 → 1**」。
 * 那 4 块粗铁**很可能还在熔炉输入槽里**（`smeltItem` 的 11 秒空等退出），
 * 但我们的回执只印了背包，模型于是报"材料没影了"——**是引擎的账先撒了谎**。
 *
 * 规则：**只报测量到的事实**，三个数分开；`真丢` 必须由三个读数算出来，
 * 且**永远不许**在没读炉子的情况下说"消失/没影"。
 */
export interface SmeltAccounting {
    /** 原料名（raw_iron 等）。 */
    rawName: string;
    /** 产物名（iron_ingot 等）。 */
    productName: string;
    /** 开始前背包里的原料数（读不到 = null）。 */
    bagBefore: number | null;
    /** 现在背包里的原料数。 */
    bagAfter: number | null;
    /** 熔炉输入槽里的原料数（读不到 = null）。 */
    furnaceInput: number | null;
    /** 熔炉燃料槽里的燃料数。 */
    furnaceFuel: number | null;
    /** 熔炉产物槽里的成品数。 */
    furnaceOutput: number | null;
    /** 背包里产物数的变化（读不到 = null）。 */
    productGained: number | null;
    /** 目标数：这次想烧多少个。 */
    /** 配方比例：每个原料出几个成品（原版烧炼都是 1:1，默认 1）。 */
    recipeRatio?: number;
    target: number;
}

/** **真丢的定义**（Lead 2026-10-20 修正）：
 * 减少的原料 = 变成产物（炉内产物槽 + 背包增量）/ 配方比例 + 还在输入槽里的。
 * 三者都读到才结算；任一读不到 ⇒ null（算不出来 ≠ 丢了）。
 * 真机反例：input 0、产物槽 1 个 iron_ingot、背包 +0 ⇒ 原料**已经烧成成品、只是还在炉里**，
 * 旧算法说"真丢 1"，会害得模型不敢再用熔炉。 */
/**
 * 炉内三项读数是否可信（真机 2026-10-20：`Failed to smelt` + 输入/燃料/产物全 0 ⇒ 算成
 * "真丢 1"，可同一坐标方块还在、窗口也报过 39 个槽内容——两件事互相矛盾）。
 * 规则：全 0 只有在"容器还在 + 名字还是熔炉 + 窗口内容到过"时才算可信；否则 uncertain。
 */
export function furnaceSlotsVerdict(input: {
  blockPresent: boolean;
  blockName: string | null;
  windowContentsArrived: boolean;
  slots: { input: number | null; fuel: number | null; output: number | null };
}): 'ok' | 'uncertain' | 'trusted-loss' {
  const { input: rawIn, fuel, output } = input.slots;
  if (rawIn == null || fuel == null || output == null) return 'uncertain';
  const allZero = rawIn === 0 && fuel === 0 && output === 0;
  if (!allZero) return 'ok';
  if (!input.blockPresent) return 'uncertain';
  if (!/furnace|blast_furnace|smoker/.test(String(input.blockName ?? ''))) return 'uncertain';
  if (!input.windowContentsArrived) return 'uncertain';
  return 'trusted-loss';
}

export function unaccountedInput(accounting: SmeltAccounting): number | null {
    const { bagBefore, bagAfter, furnaceInput, furnaceOutput, productGained } = accounting;
    if (bagBefore == null || bagAfter == null || furnaceInput == null) return null;
    if (furnaceOutput == null || productGained == null) return null;
    const ratio = Number(accounting.recipeRatio ?? 1) > 0 ? Number(accounting.recipeRatio ?? 1) : 1;
    // 从背包里拿走的原料 − 还留在输入槽的 = 真正被消耗的原料。
    const consumed = Math.max(0, bagBefore - bagAfter - furnaceInput);
    // 已经变成成品的有两部分：**炉内产物槽**（还没取）和背包增量。
    const producedInputEquivalent = (Math.max(0, furnaceOutput) + Math.max(0, productGained)) / ratio;
    return Math.max(0, Math.round((consumed - producedInputEquivalent) * 100) / 100);
}

/** 下一步该怎么办（纯判据；调用方负责真的去做）。 */
export type SmeltNext = 'done' | 'continue' | 'stop-fuel' | 'stop-input' | 'stop-time';

export function nextSmeltStep(input: {
    /** 已完成（背包增量 + 炉内产物）够不够目标。 */
    produced: number;
    target: number;
    furnaceInput: number | null;
    furnaceFuel: number | null;
    /** 已经花了多久（毫秒）与轮数。 */
    elapsedMs: number;
    rounds: number;
    maxMs?: number;
    maxRounds?: number;
}): SmeltNext {
    if (input.produced >= input.target) return 'done';
    if (input.rounds >= (input.maxRounds ?? 6)) return 'stop-time';
    if (input.elapsedMs >= (input.maxMs ?? 90_000)) return 'stop-time';
    if (input.furnaceInput != null && input.furnaceInput <= 0) return 'stop-input';
    if (input.furnaceFuel != null && input.furnaceFuel <= 0) return 'stop-fuel';
    if (input.furnaceInput == null && input.furnaceFuel == null) return 'stop-time';
    return 'continue';
}

/**
 * 渲染成模型能读的回执。**三件事分开写**：背包账、炉内账、真丢。
 * 「凭空消失」「没影了」这类词**只能**在 `真丢 > 0` 且已读到炉子时出现。
 */
export function formatSmeltAccounting(accounting: SmeltAccounting, rounds: number): string[] {
    const lines: string[] = [];
    const fmt = (value: number | null): string => (value == null ? '读不到' : String(value));
    lines.push(
        `- 背包账：${accounting.rawName} ${fmt(accounting.bagBefore)} → ${fmt(accounting.bagAfter)}；` +
            `${accounting.productName} 实测 +${fmt(accounting.productGained)}。`,
    );
    lines.push(
        `- 炉内账（**这才是关键**）：输入槽 ${fmt(accounting.furnaceInput)} 个 ${accounting.rawName}、` +
            `燃料槽 ${fmt(accounting.furnaceFuel)}、产物槽 ${fmt(accounting.furnaceOutput)} 个 ${accounting.productName}。`,
    );
    const lost = unaccountedInput(accounting);
    if (lost == null) {
        lines.push(
            '- 真丢：**算不出来**（背包或炉子有一项读不到）——这不能当成"丢了"，先重开一次熔炉或用 stats 核对再判断。',
        );
    } else if (lost === 0) {
        const outputSlotNote =
            accounting.furnaceOutput != null && accounting.furnaceOutput > 0
                ? `；**产物槽里还有 ${accounting.furnaceOutput} 个 ${accounting.productName} 没取**——再发一次 useBlock(type=furnace) 取走就行。`
                : '。';
        lines.push('- 真丢：**0**。原料要么变成了成品、要么还在炉内输入槽里' + outputSlotNote);
    } else if (lost > 0) {
        lines.push(
            `- 真丢：**${lost} 个**原料既不在背包、也不在炉内输入槽、也没变成成品——这是真的对不上账，` +
                '请把这条回执原样告诉开发者（不要自己重挖补上，先把事实留下来）。',
        );
    }
    if (rounds > 1) lines.push(`- 这次分 ${rounds} 轮烧（每轮都重新开炉读数，不是一口气硬等）。`);
    return lines;
}

/** 批次没烧完时，告诉模型**剩下的在哪、缺什么**（不写"消失"）。 */
export function formatSmeltUnfinished(accounting: SmeltAccounting, next: SmeltNext): string {
    const remainInFurnace = accounting.furnaceInput ?? 0;
    const done = Math.max(0, accounting.productGained ?? 0);
    const head = `这次烧到 ${done}/${accounting.target}。`;
    if (next === 'stop-fuel') {
        return (
            head +
            `剩余 ${remainInFurnace} 个 ${accounting.rawName} **还在熔炉输入槽里**（安全，不会丢）。` +
            '缺燃料：再带 1–2 个煤/木炭放进背包，再发一次同样的 useBlock 就能接着烧。'
        );
    }
    if (next === 'stop-input') {
        return head + '熔炉输入槽已经空了：这一批的原料都处理过了，缺的数量在背包里没有更多原料。';
    }
    return (
        head +
        (remainInFurnace > 0
            ? `剩余 ${remainInFurnace} 个 ${accounting.rawName} **还在熔炉里**（安全）。`
            : '炉内没有剩余原料。') +
        '这次到时间上限了：**直接再发一次同样的 useBlock** 就会接着烧（进度不会丢）。'
    );
}

/** 容器类方块（只存或只取）。 */
const CONTAINER_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box']);

/** 开箱拿东西用（含 shulker 变体，下面用 endsWith 兜住）。 */
const CONTAINER_TYPES = CONTAINER_BLOCKS;

/**
 * `useBlock` 的落点分派。
 *
 * 抽成纯函数是为了能单测：给定 type / input / output 该走哪条路，是这套设计里
 * 唯一容易搞错的地方（`action` 参数就是被它取代的）。
 */
export type BlockPlan =
  | { kind: 'deposit' }
  | { kind: 'withdraw' }
  | { kind: 'process' }
  | { kind: 'interact' }
  | { kind: 'unsupported'; reason: string };

export function planUseBlock(
  type: string,
  hasInput: boolean,
  hasOutput: boolean,
): BlockPlan {
  if (hasInput && hasOutput) {
    if (PROCESSING_BLOCKS.has(type)) return { kind: 'process' };
    return {
      kind: 'unsupported',
      reason: `${type} 不能同时收下 input 和 output：加工类方块（工作台/熔炉/铁砧）才可以。`,
    };
  }
  if (hasInput) {
    if (CONTAINER_BLOCKS.has(type)) return { kind: 'deposit' };
    if (PROCESSING_BLOCKS.has(type)) {
      return {
        kind: 'unsupported',
        reason:
          `${type} 加工必须同时给 input（原料）和 output（期望产物）；只给 input 不是加工。` +
          `正确例子：useBlock(type="${type}", input="8 raw_iron", output="8 iron_ingot")。`,
      };
    }
    return { kind: 'unsupported', reason: `${type} 不能只"存进去"——那是容器（箱子/桶）才有的用法。` };
  }
  if (hasOutput) {
    if (CONTAINER_BLOCKS.has(type)) return { kind: 'withdraw' };
    // 熔炉取成品：output 单独给就是"把烤好的拿出来"。
    if (FURNACE_BLOCKS.has(type)) return { kind: 'withdraw' };
    if (PROCESSING_BLOCKS.has(type)) {
      return {
        kind: 'unsupported',
        reason:
          `${type} 要加工必须同时给 input 和 output；只给 output 不是加工，也没有可取的成品槽。` +
          `正确例子：useBlock(type="${type}", input="3 stone", output="1 stone_pickaxe")。`,
      };
    }
    return { kind: 'unsupported', reason: `${type} 不能只"取出来"——箱子或熔炉才行。` };
  }
  return { kind: 'interact' };
}

/** 把结果行拼成一段人类（和模型）都读得懂的正文。 */
export function renderReport(lines: readonly string[], tail?: string): string {
  const body = lines.join('\n');
  return tail == null ? body : `${body}\n${tail}`;
}

const ACTION_TIMEOUT = Symbol('interact-timeout');

/**
 * 交互类工具统一走身体通道。
 *
 * 为什么必须包一层：useBlock/useEntity/craft 以前是裸 async，不设置
 * `actions.executing`，于是自动拾取可以在它们跑的时候抢走身体（快照里 Meta
 * 变成 autoPickup，模型以为自己的动作根本没跑），Stop 也停不掉它们。
 *
 * 同时给每次调用一个明确的结局：完成 / 失败 / 超时 / 被中断，绝不再出现
 * 「只回一个 action_id 然后静默消失」。
 */
export async function runInteractiveAction(
  agent: any,
  label: string,
  work: () => Promise<string> | string,
): Promise<string> {
  let result: string | typeof ACTION_TIMEOUT = ACTION_TIMEOUT;
  let error: unknown = null;
  const actionFn = async (): Promise<void> => {
    try {
      result = await withTimeout(Promise.resolve().then(work), TOOL_TIMEOUT_MS + 5000, ACTION_TIMEOUT);
    } catch (err: unknown) {
      error = err;
    }
  };
  let outcome: { interrupted?: boolean; timedout?: boolean } | null = null;
  if (typeof agent?.actions?.runAction === 'function') {
    outcome = (await agent.actions.runAction(`action:${label}`, actionFn, { timeout: 2 })) as {
      interrupted?: boolean;
      timedout?: boolean;
    } | null;
  } else {
    await actionFn();
  }
  if (error != null) {
    return `${label} 执行出错：${error instanceof Error ? error.message : String(error)}`;
  }
  if (outcome?.interrupted === true && outcome.timedout !== true) {
    return (
      `${label} 被中断（Stop / 保命反射 / autoPickup 抢走了身体），本次没有完整结果。` +
      '不要盲目重发；先用 stats 看当前位置和背包，再决定继续还是换路。'
    );
  }
  if (outcome?.timedout === true || result === ACTION_TIMEOUT) {
    return (
      `${label} 超时（${TOOL_TIMEOUT_MS / 1000} 秒没返回），已释放身体通道。` +
      '注意：超时 ≠ 没做成——异步动作可能已经生效，先核对背包/容器状态再决定要不要重试。'
    );
  }
  const text = String(result).trim();
  if (text === '') {
    return `${label} 执行结束，但身体没有返回具体结果（可能被中断）。请用 stats 核对当前状态。`;
  }
  return text;
}

function wrapInteractiveCommand(command: AgentCommand): AgentCommand {
  const label = command.name.replace(/^!/, '');
  const original = command.perform;
  const perform = (async function (agent: any, ...args: any[]): Promise<string> {
    return await runInteractiveAction(agent, label, () => Promise.resolve(original(agent, ...args)) as Promise<string>);
  }) as AgentCommand['perform'];
  (perform as { longRunning?: boolean }).longRunning = true;
  return { ...command, perform };
}


// ---------------------------------------------------------------
// task-17：合成支持同类标签（任何木板 / 原木 / 煤炭 / 羊毛）。
//
// 背景：minecraft-data 把 `#planks` 这类 tag 解析成一个具体物品（oak_planks），
// 于是 oak×2 + birch×2 做 crafting_table 会被判「缺 oak_planks」。原版允许同类混用。
// 这里在交互层补：把配方里同 family 的格子按背包实际成员分配，再用 `bot.craft`
// 执行（`bot.recipesAll` 拿到不看库存的配方，克隆后逐格换成实际物品 id）。
// ---------------------------------------------------------------

/** 同类可互换的 family（原版 tag 的最小实现，按注册名后缀识别）。 */
const FAMILY_PATTERNS: ReadonlyArray<{ tag: string; test: (name: string) => boolean }> = [
  { tag: 'planks', test: (n) => n.endsWith('_planks') },
  { tag: 'logs', test: (n) => n.endsWith('_log') || n.endsWith('_wood') || n.endsWith('_stem') || n.endsWith('_hyphae') },
  { tag: 'coals', test: (n) => n === 'coal' || n === 'charcoal' },
  { tag: 'wool', test: (n) => n.endsWith('_wool') },
];

/** 这个物品属于哪个同类 family（不属于返回 null）。 */
export function familyTagOf(itemName: string): string | null {
  for (const family of FAMILY_PATTERNS) if (family.test(itemName)) return family.tag;
  return null;
}

export function sameFamily(a: string, b: string): boolean {
  const fa = familyTagOf(a);
  return fa != null && fa === familyTagOf(b);
}

export interface TagGroupPlan {
  tag: string;
  required: number;
  available: number;
  members: Array<{ name: string; count: number }>;
  missing: number;
  /** 同一种凑不够、必须靠混用才能达到 required。 */
  needsMixing: boolean;
}

export interface TagCraftPlan {
  ok: boolean;
  groups: TagGroupPlan[];
  missingText: string;
}

/**
 * 按「同类可混用」检查一次配方需求：required 里每个物品按 family 归组，
 * 统计背包里同 family 的合计。纯函数，可单测。
 */
export function planTagCraft(
  required: Record<string, number>,
  inventory: Record<string, number>,
): TagCraftPlan {
  const groups = new Map<string, TagGroupPlan>();
  for (const [name, need] of Object.entries(required)) {
    if (!Number.isFinite(need) || need <= 0) continue;
    const tag = familyTagOf(name) ?? name;
    const group = groups.get(tag) ?? { tag, required: 0, available: 0, members: [], missing: 0, needsMixing: false };
    group.required += need;
    group.members = Object.entries(inventory)
      .filter(([item, count]) => (familyTagOf(item) ?? item) === tag && Number.isFinite(count) && count > 0)
      .map(([item, count]) => ({ name: item, count: Math.floor(count) }));
    groups.set(tag, group);
  }
  const out: TagGroupPlan[] = [];
  for (const group of groups.values()) {
    group.available = group.members.reduce((sum, m) => sum + m.count, 0);
    group.missing = Math.max(0, group.required - group.available);
    const maxSingle = group.members.reduce((max, m) => Math.max(max, m.count), 0);
    group.needsMixing = group.available >= group.required && maxSingle < group.required;
    group.members.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    out.push(group);
  }
  const ok = out.every((g) => g.available >= g.required);
  const missingText = out
    .filter((g) => g.missing > 0)
    .map((g) => {
      const have = g.members.length > 0 ? g.members.map((m) => `${m.name}×${m.count}`).join('、') : '无';
      return `${g.tag} 还缺 ${g.missing}（需要 ${g.required}，现有 ${have}，合计 ${g.available}；同类可混用也还差 ${g.missing}）`;
    })
    .join('；');
  return { ok, groups: out, missingText };
}

export interface RecipeAssignResult {
  recipe: any;
  used: Record<string, number>;
  mixed: boolean;
}

function isFilledCell(cell: any): boolean {
  return cell != null && typeof cell.id === 'number' && cell.id >= 0;
}

export function formatUsedItems(used: Record<string, number>): string {
  const parts = Object.entries(used).map(([name, count]) => `${name}×${count}`);
  return parts.length > 0 ? parts.join('、') : '（无）';
}

/**
 * 把配方里属于 family 的格子替换成背包里实际有的成员 id：每个 family 的格子
 * 按剩余数量从多到少取（优先配方原本的代表物）。取不满返回 null。
 */
export function assignRecipeToInventory(
  recipe: any,
  inventory: Record<string, number>,
  idToName: (id: number) => string | null,
  nameToId: (name: string) => number | null,
): RecipeAssignResult | null {
  if (recipe == null) return null;
  let clone: any;
  try {
    clone = JSON.parse(JSON.stringify(recipe));
  } catch {
    return null;
  }
  const pool = new Map<string, number>();
  for (const [name, count] of Object.entries(inventory)) {
    if (Number.isFinite(count) && count > 0) pool.set(name, Math.floor(count));
  }
  const used = new Map<string, number>();
  const take = (name: string, n = 1): boolean => {
    const have = pool.get(name) ?? 0;
    if (have < n) return false;
    pool.set(name, have - n);
    used.set(name, (used.get(name) ?? 0) + n);
    return true;
  };
  const assignCell = (cell: any): boolean => {
    if (!isFilledCell(cell)) return true;
    const originalName = idToName(cell.id);
    const tag = originalName == null ? null : familyTagOf(originalName);
    const need = typeof cell.count === 'number' && cell.count > 0 ? cell.count : 1;
    if (tag == null) return take(originalName ?? '', need);
    const candidates = [...pool.entries()]
      .filter(([name, count]) => count > 0 && sameFamily(name, originalName as string))
      .sort((a, b) => (a[0] === originalName ? -1 : b[0] === originalName ? 1 : 0) || b[1] - a[1] || a[0].localeCompare(b[0]));
    const pick = candidates[0];
    if (pick == null || !take(pick[0], need)) return false;
    const id = nameToId(pick[0]);
    if (id == null) return false;
    cell.id = id;
    return true;
  };
  if (Array.isArray(clone.inShape)) {
    for (const row of clone.inShape) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) if (!assignCell(cell)) return null;
    }
  } else if (Array.isArray(clone.ingredients)) {
    for (const cell of clone.ingredients) if (!assignCell(cell)) return null;
  } else {
    return null;
  }
  const familyUsed = new Map<string, Set<string>>();
  for (const name of used.keys()) {
    const tag = familyTagOf(name);
    if (tag == null) continue;
    if (!familyUsed.has(tag)) familyUsed.set(tag, new Set());
    const family = familyUsed.get(tag);
    if (family != null) family.add(name);
  }
  const mixed = [...familyUsed.values()].some((set) => set.size > 1);
  return { recipe: clone, used: Object.fromEntries(used), mixed };
}

export interface TagCraftOutcome {
  ok: boolean;
  detail: string;
  mixed: boolean;
}

/**
 * 用同类混用真去合成：只处理 2×2（不需要工作台）的配方，交给 `bot.craft`。
 * 返回回执；调用方负责把 detail 写进 bot.output。
 */
/** 把模型常用的错名映射到注册名（金装备是 golden_*，不是 gold_*）。 */
export function resolveCraftItemName(raw: string): { name: string; aliasOf: string | null; valid: boolean } {
  const name = String(raw ?? '').trim().toLowerCase();
  if (name === '') return { name, aliasOf: null, valid: false };
  if (mc.getItemId(name) != null) return { name, aliasOf: null, valid: true };
  if (name.startsWith('gold_')) {
    const golden = `golden_${name.slice('gold_'.length)}`;
    if (mc.getItemId(golden) != null) return { name: golden, aliasOf: name, valid: true };
  }
  return { name, aliasOf: null, valid: false };
}


export async function craftRecipeWithTags(
  bot: any,
  itemName: string,
  num = 1,
): Promise<TagCraftOutcome> {
  const itemId = mc.getItemId(itemName);
  const recipeInfos = itemId == null ? null : mc.getItemCraftingRecipes(itemName);
  if (itemId == null || recipeInfos == null || recipeInfos.length === 0) {
    return { ok: false, detail: `没有 ${itemName} 的合成配方。`, mixed: false };
  }
  const required = (recipeInfos[0]?.[0] ?? {}) as Record<string, number>;
  const counts: Record<string, number> = world.getInventoryCounts(bot) ?? {};
  const plan = planTagCraft(required, counts);
  const bases: any[] = typeof bot?.recipesAll === 'function' ? (bot.recipesAll(itemId, null, null) ?? []) : [];
  if (bases.length === 0) {
    const needText = Object.entries(required).map(([n, c]) => `${n}×${c}`).join('、');
    return {
      ok: false,
      detail:
        `做不出 ${itemName}：这个配方要 3×3 工作台（或需要先放工作台）。` +
        (plan.ok ? `材料按同类合计是够的（${plan.groups.map((g) => `${g.tag} 合计 ${g.available}/${g.required}`).join('、')}）。` : `还缺：${plan.missingText}。`) +
        '请用 useBlock(type=crafting_table, input=…, output=…) 或先 placeHere 放下工作台。',
      mixed: false,
    };
  }
  const idToName = (id: number): string | null => mc.getItemName(id);
  const nameToId = (name: string): number | null => mc.getItemId(name);
  for (const base of bases) {
    const assigned = assignRecipeToInventory(base, counts, idToName, nameToId);
    if (assigned == null) continue;
    const perCraft = Math.max(1, Math.floor(Number(base?.result?.count ?? 1)) || 1);
    const runs = Math.max(1, Math.ceil(num / perCraft));
    try {
      await bot.craft(assigned.recipe, runs, null);
    } catch (error: unknown) {
      return {
        ok: false,
        detail: `${assigned.mixed ? '混用同类材料' : '用同一种材料'}合成 ${itemName} 时失败：${error instanceof Error ? error.message : String(error)}。`,
        mixed: assigned.mixed,
      };
    }
    return {
      ok: true,
      detail:
        `${assigned.mixed ? '混用同类材料' : '用同一种材料'}合成了 ${itemName}×${runs * perCraft}` +
        `（${formatUsedItems(assigned.used)}${assigned.mixed ? '，原版允许同类混用' : ''}）。`,
      mixed: assigned.mixed,
    };
  }
  return {
    ok: false,
    detail:
      `做不出 ${itemName}：同类混用也凑不齐。` +
      (plan.missingText !== ''
        ? `缺：${plan.missingText}。`
        : `配方需要 ${Object.entries(required).map(([n, c]) => `${n}×${c}`).join('、')}，背包里对不上（可能名字不同或不是同类）。`),
    mixed: false,
  };
}

/**
 * 合成入口：先用原来的 skills.craftRecipe（支持工作台/精确配方），失败再走
 * 同类标签混用。两个回执都会写进 bot.output，最后一行是明确结论。
 */
export async function craftSmartDetailed(
  bot: any,
  itemName: string,
  num = 1,
): Promise<{ ok: boolean; detail: string }> {
  const resolved = resolveCraftItemName(itemName);
  if (!resolved.valid) {
    return {
      ok: false,
      detail:
        formatUnknownItemReceipt(itemName) +
        (describeDyedShortfall(itemName, () => null, []) == null ? '' : ''),
    };
  }
  const targetName = resolved.name;
  const aliasNote = resolved.aliasOf != null ? `（${resolved.aliasOf} 不是注册名，已按 ${targetName} 处理）` : '';
  // **染色配方要同色**（真机 A：`white_wool×2 + black_wool×1` 做床——混色不行）：
  // 材料不够时直接说清"需要 3 块同色 white_wool，你还差 1 块白"，别让 `craft` 去撞一个注定失败的配方。
  try {
    const inventoryNames = ((bot?.inventory?.items?.() ?? []) as Array<{ name?: string }>)
      .map((item) => String(item?.name ?? ''))
      .filter((name) => name !== '');
    const shortfall = describeDyedShortfall(
      targetName,
      (name) => countInInventory(bot, name),
      inventoryNames,
    );
    if (shortfall != null) return { ok: false, detail: shortfall };
  } catch {
    // 读不到背包就照常尝试合成（不让守卫变成墙）。
  }
  try {
    if (await skills.craftRecipe(bot, targetName, num)) {
      return { ok: true, detail: `${aliasNote}合成 ${targetName} 成功（原配方）。` };
    }
  } catch (error: unknown) {
    skills.log(bot, `craftRecipe 抛错：${error instanceof Error ? error.message : String(error)}`);
  }
  const outcome = await craftRecipeWithTags(bot, targetName, num);
  // **失败时给算术**（Lead 2026-10-21：机器人常"只差一件基础物品"，引擎从不说清）。
  // 不是门：只在失败回执里追加一行缺口，不阻止任何行动。
  const shortfallNote = outcome.ok ? '' : describeCraftShortfallForBot(bot, targetName, num);
  return {
    ok: outcome.ok,
    detail: `${aliasNote}${outcome.detail}${shortfallNote === '' ? '' : ` ${shortfallNote}`}`,
  };
}


export async function craftSmart(bot: any, itemName: string, num = 1): Promise<boolean> {
  const outcome = await craftSmartDetailed(bot, itemName, num);
  skills.log(bot, outcome.detail);
  return outcome.ok;
}

const interactCommands: AgentCommand[] = [
  {
    name: '!useBlock',
    description: td('useBlock'),
    params: {
      type: { type: 'BlockOrItemName', description: tp('useBlock', 'type') },
      coords: { type: 'string', description: tp('useBlock', 'coords'), optional: true },
      input: { type: 'string', description: tp('useBlock', 'input'), optional: true },
      output: { type: 'string', description: tp('useBlock', 'output'), optional: true },
    },
    perform: async function (
      agent: any,
      type: string,
      coords?: unknown,
      input?: unknown,
      output?: unknown,
    ): Promise<string> {
      const lines: string[] = [];
      const parsedIn = parseItems(input);
      const parsedOut = parseItems(output);
      if (parsedIn.error != null) return `useBlock 参数不对：${parsedIn.error}`;
      if (parsedOut.error != null) return `useBlock 参数不对：${parsedOut.error}`;

      const plan = planUseBlock(type, parsedIn.items.length > 0, parsedOut.items.length > 0);
      if (plan.kind === 'unsupported') return `useBlock 用不了：${plan.reason}`;

      // 定位：给了 coords 就过去；没给就用够得着的最近一个。
      let located: { x: number; y: number; z: number } | null;
      if (typeof coords === 'string' && coords.trim() !== '') {
        const parts = coords.split(',').map((p) => Number(p.trim()));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
          return `useBlock 参数不对：coords 要写成 "x,y,z"（收到 "${coords}"）。`;
        }
        const [x, y, z] = parts as [number, number, number];
        const actual = blockNameAt(agent.bot, x, y, z);
        if (actual != null && actual !== type) {
          return `useBlock 用不了：(${x},${y},${z}) 是 ${actual}，不是 ${type}。`;
        }
        const startDistance = distanceToBlock(agent.bot, x, y, z);
        if (startDistance != null && startDistance <= 4.5) {
          // 人已经够得着就别再寻路：交互只需要够得着，寻路到方块自身坐标
          // 反而会因为方块不可站立而失败（真机：人离熔炉 0.7 格仍报路径被堵）。
          lines.push(step(`已经在 (${x},${y},${z}) 的 ${type} 旁边（${startDistance.toFixed(1)} 格），不用再走。`));
        } else {
          lines.push(step(`走过去 (${x},${y},${z})`));
          let ok = await skills.goToPosition(agent.bot, x, y, z, 2);
          if (!ok) {
            // 目标方块本身不可站立：改试相邻可站立格，而不是反复报同一句。
            const spots = findAdjacentStandable(agent.bot, x, y, z);
            for (const spot of spots.slice(0, 4)) {
              const reached = await skills.goToPosition(agent.bot, spot.x, spot.y, spot.z, 0);
              if (reached) {
                lines.push(step(`目标格不可站立，改走到相邻格 (${spot.x},${spot.y},${spot.z})。`));
                ok = true;
                break;
              }
            }
          }
          if (!ok) {
            const nowDistance = distanceToBlock(agent.bot, x, y, z);
            return renderReport(
              lines,
              `走到 (${x},${y},${z}) 失败：路径被堵或到不了（当前离目标 ${nowDistance == null ? '未知' : nowDistance.toFixed(1)} 格，` +
                '相邻可站立格也走不过去）。可以先 goToCoordinates，或者换一个方块。',
            );
          }
        }
        const finalDistance = distanceToBlock(agent.bot, x, y, z);
        lines.push(step(`离目标 ${finalDistance == null ? '未知' : finalDistance.toFixed(1)} 格。`));
        located = { x, y, z };
      } else {
        const nearby = nearestReachableBlock(agent.bot, type);
        if (nearby == null) {
          return `身边 4 格内没有够得着的 ${type}。要么先 goToCoordinates 走过去再给 coords，要么先 placeHere 放一个。`;
        }
        lines.push(step(`用够得着的 ${type} @(${nearby.x},${nearby.y},${nearby.z})`));
        located = nearby;
      }

      // 分派到已有技能。每一步都写进 lines，失败也写清楚。
      if (plan.kind === 'interact') {
        // **开箱 = 拿东西**（用户要求「世界里有奖励箱，他们得拿」）。
        // 不新增工具：模型能调用的只有 `useBlock`，所以能力就放在它的 interact 分支里
        // （`takeFromChest`/`viewChest` 从来不是工具，模型根本调不到——那些文案今晚一并删掉）。
        if (CONTAINER_TYPES.has(type) || type.endsWith('shulker_box')) {
          if (located == null) return renderReport(lines, '定位不到容器。');
          const containerBlock = agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z));
          if (containerBlock == null) {
            lines.push(step(`读不到 (${located.x},${located.y},${located.z}) 那一格——区块可能没加载，先 goToCoordinates 靠近再试。`));
            return renderReport(lines);
          }
          try {
            const outcome = await skills.lootContainer(agent.bot, containerBlock);
            lines.push(...skills.formatLootReport(outcome));
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            lines.push(step(`开箱失败：${message}`));
            // **一行说清 + 指非容器兜底**：容器是本仓最不稳的一条路（旧世界 100% 超时）。
            lines.push(
              step(
                '容器这条路不稳时**别原地反复开**：换个位置/换个箱子重试一次，' +
                  '或先用 stats 核对背包；实在打不开就先做别的（东西不会跑，但别在开箱上耗死）。',
              ),
            );
          }
          return renderReport(lines);
        }
        if (type === 'bed') {
          await runSkill(agent.bot, lines, () => skills.goToBed(agent.bot), '睡下了', '睡不了（不是夜晚，或旁边有怪）');
          return renderReport(lines);
        }

        if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') {

          // **打开熔炉要看得到槽里的东西**。模型真机报过"furnace 打开时不像箱子那样列内容"——

          // 她怀疑炉子里有残留物占着输入槽（这正是"加了煤却烧不了铁"的原因），但看不到，

          // 只能靠反复试各种写法去猜。箱子能列内容，炉子没理由不能。

          if (located == null) return renderReport(lines, '定位不到熔炉。');

          try {

            // **blockAt 可能返回 null**（那一格没加载/读不到），直接传给 openContainer 会
            // 抛 mineflayer 的 'containerToOpen is neither a block nor an entity'——模型真机
            // 报过这条：两条路径都打不开炉子。先自己判空，报一句人话。
            const furnaceBlock = agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z));
            if (furnaceBlock == null) {
              lines.push(step(`读不到 (${located.x},${located.y},${located.z}) 那一格——区块可能没加载，或者坐标偏了。`));
              return renderReport(lines);
            }
            const container: any = await withTimeout(skills.openBlockUi(agent.bot, furnaceBlock), TOOL_TIMEOUT_MS, null);
            if (container == null) {
              lines.push(step(`打开熔炉超时（${TOOL_TIMEOUT_MS / 1000} 秒没返回），本次没读到内容。`));
              return renderReport(lines);
            }

            lines.push(step('打开看了炉子里面'));

            lines.push('    ' + slotLine(readSlot(container, 'inputItem'), '原料槽'));

            lines.push('    ' + slotLine(readSlot(container, 'fuelItem'), '燃料槽'));

            lines.push('    ' + slotLine(readSlot(container, 'outputItem'), '产物槽'));

            lines.push('    （如果刚投料/取物，槽位读数可能还没同步；以 stats 或重开容器为准）');
            lines.push('    （想清空某一槽就用 useBlock(type=furnace, output="…") 把东西取出来）');

            await container.close?.();

            return renderReport(lines);

          } catch (error: unknown) {

            lines.push(step('打开熔炉失败：' + (error instanceof Error ? error.message : String(error))));

            return renderReport(lines);

          }

        }
        lines.push(step(`直接用了 ${type}（没有 input/output，所以不改变它的内容）`));
        return renderReport(lines);
      }

      if (plan.kind === 'deposit') {
        if (located == null) return renderReport(lines, '定位不到容器。');
        // **整包账目**：存完要能回答"我还剩什么"——真机 19:20 那次把镐、剑、
        // 食物、垫脚方块一起存了，回执只说"存了 X 个"，模型到出门时才发现包是空的。
        const packBefore = world.getInventoryCounts(agent.bot);
        for (const item of parsedIn.items) {
          await settleInventory(agent.bot, 2, 50);
          const beforeCount = countInInventory(agent.bot, item.name);
          const result = await transferWithContainer(agent.bot, located, item.name, item.count, 'deposit');
          await settleInventory(agent.bot, 3, 50);
          const afterCount = countInInventory(agent.bot, item.name);
          lines.push(step(`放入 ${item.name}：请求 ${item.count}${result.ok ? '' : '（操作未完成）'}`));
          lines.push('    ' + formatTransferReceipt(item.name, item.count, 'deposit', result, beforeCount, afterCount));
        }
        const packAfter = world.getInventoryCounts(agent.bot);
        const advice = inventoryLossAdvice({
          before: packBefore,
          after: packAfter,
          isFood: (name) => FOOD_VALUE[name] != null,
          isPlaceable: (name) => agent.bot?.registry?.blocksByName?.[name]?.boundingBox === 'block',
        });
        if (advice.text !== '') lines.push('    ' + advice.text);
        return renderReport(lines);
      }

      if (plan.kind === 'withdraw') {
        if (located == null) return renderReport(lines, '定位不到容器。');
        // **熔炉族走专用取物**：不传数量时"把产物槽里现有的全拿走"（原版界面行为），
        // 传了数量就按数量取并说明剩下多少；**绝不碰原料槽/燃料槽**。
        if (isFurnaceLikeBlock(type)) {
          for (const item of parsedOut.items) {
            lines.push(...(await takeFromFurnace(agent.bot, located, item, type)));
          }
          return renderReport(lines);
        }
        for (const item of parsedOut.items) {
          await settleInventory(agent.bot, 2, 50);
          const beforeCount = countInInventory(agent.bot, item.name);
          const result = await transferWithContainer(agent.bot, located, item.name, item.count, 'withdraw');
          await settleInventory(agent.bot, 3, 50);
          const afterCount = countInInventory(agent.bot, item.name);
          lines.push(step(`取出 ${item.name}：请求 ${item.count}${result.ok ? '' : '（操作未完成）'}`));
          lines.push('    ' + formatTransferReceipt(item.name, item.count, 'withdraw', result, beforeCount, afterCount));
        }
        return renderReport(lines);
      }

      // process：output 是断言。
      const wanted = parsedOut.items[0];
      if (wanted == null) return renderReport(lines, 'useBlock 用不了：加工要给出 output。');
      const resolvedWanted = resolveCraftItemName(wanted.name);
      if (!resolvedWanted.valid) {
        return renderReport(lines, 'useBlock 用不了：' + formatUnknownItemReceipt(wanted.name));
      }
      const aliasNote = resolvedWanted.aliasOf != null ? `（${resolvedWanted.aliasOf} → ${resolvedWanted.name}）` : '';
      wanted.name = resolvedWanted.name;
      if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') {
        // **`smeltItem` 要的是原料，不是产物**——它自己去查"这个能不能烧"。
        // 真机上模型报过 `Cannot smelt iron_ingot`：我当时把 `output` 当输入传了，
        // 等于问"铁锭能不能烧"。所以烧的是 input，output 只当断言用。
        const raw = parsedIn.items[0];
        if (raw == null) {
          return renderReport(
            lines,
            '烧东西要给出 **input（原料）**：useBlock(type=furnace, input="1 raw_iron", output="1 iron_ingot")。' +
              '燃料不用你操心，熔炉会自己从背包里找煤/木炭/木头。',
          );
        }
        // task-9：先按全背包求和把燃料投好，绕开 smeltItem 的单堆燃料判断（14 煤报 need 2）。
        // 先让客户端背包包落地，再按全背包求和投燃料；避免「有 14 煤却说 need 2」。
        await settleInventory(agent.bot, 3, 50);
        const fuelPrep = await ensureAggregateFuel(agent.bot, raw.count, located);
        // **打开熔炉期间武装窗口诊断**：全 0 的读数到底可不可信，要有包级证据。
        try {
          const arm = (agent.bot as { __armContainerPacketDump?: (reason: string, label?: 'container' | 'craft' | 'furnace') => void })
            .__armContainerPacketDump;
          arm?.(`useBlock furnace`, 'furnace');
        } catch {
          // 诊断不是功能，武装失败不影响烧炼。
        }
        lines.push('- ' + fuelPrep.detail);
        if (!fuelPrep.ok) {
          return renderReport(lines, '燃料这一步没过，链路还没启动，熔炉里不会留下半成品；按上面说的补齐再试。');
        }
        const rawBefore = await countInInventoryWithSync(agent.bot, raw.name, raw.count, 800);
        if (rawBefore != null && rawBefore < raw.count) {
          return renderReport(
            lines,
            `背包里 ${raw.name} 只有 ${rawBefore} 个（要烧 ${raw.count}）。` +
              '如果 stats 里其实够，可能是客户端背包同步延迟——先 stats 核对，别急着重挖；如果确实不够，补够再试。',
          );
        }
        if (rawBefore == null) {
          lines.push('- 背包数量读不到，不能确认原料够不够；仍尝试调用，失败以 stats 为准。');
        }
        const outBefore = countInInventory(agent.bot, wanted.name);
        const ok = await runSkill(
          agent.bot,
          lines,
          () => skills.smeltItem(agent.bot, raw.name, raw.count),
          `已烧完 ${raw.name}×${raw.count}`,
          `烧不了 ${raw.name}`,
        );
        // **烧炼三本账 + 续烧**（Lead 2026-10-20）：只印背包会造成"5 进 1 出、4 没影"的假象，
        // 那 4 块很可能还在炉内输入槽。这里每轮重开熔炉读三个槽，再决定继续还是收工。
        const readFurnaceSlots = async (): Promise<{
          input: number | null;
          fuel: number | null;
          output: number | null;
          blockPresent: boolean;
          blockName: string | null;
        }> => {
          try {
            const block = located != null ? agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z)) : null;
            if (block == null) return { input: null, fuel: null, output: null, blockPresent: false, blockName: null };
            const furnaceUi: any = await agent.bot.openFurnace(block);
            const countOf = (item: any): number => Number(item?.count ?? 0);
            const result = {
              input: countOf(furnaceUi?.inputItem?.()),
              fuel: countOf(furnaceUi?.fuelItem?.()),
              output: countOf(furnaceUi?.outputItem?.()),
              blockPresent: true,
              blockName: String(block?.name ?? ''),
            };
            try {
              await agent.bot.closeWindow(furnaceUi);
            } catch {
              // 关不上不影响读数。
            }
            return result;
          } catch {
            return { input: null, fuel: null, output: null, blockPresent: false, blockName: null };
          }
        };
        // **smelt 报失败也要把产物取出来**（真机 2026-10-20：产物槽有 1 个铁锭、背包 +0，
        // 模型以为烧失败而不敢再用熔炉）。每次读炉前若产物槽有东西就先取走。
        const takeFurnaceOutput = async (): Promise<number> => {
          try {
            const block = located != null ? agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z)) : null;
            if (block == null) return 0;
            const ui: any = await agent.bot.openFurnace(block);
            let got = 0;
            for (let guard = 0; guard < 64 && ui?.outputItem?.() != null; guard++) {
              const taken = await ui.takeOutput();
              got += Number(taken?.count ?? 0);
            }
            try { await agent.bot.closeWindow(ui); } catch { /* 关不上不影响已取到的 */ }
            return got;
          } catch {
            return 0;
          }
        };
        // **超时/失败的熔炉不许吞材料**（真机 2026-10-21：smelt 45 秒超时后 chicken 3→2，
        // 回执只能报"真丢 1"——那是恢复路径的 bug，不是命）。可行时先把输入槽/燃料槽取回背包。
        const recoverFurnaceInput = async (): Promise<{ input: number; fuel: number }> => {
          try {
            const block = located != null ? agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z)) : null;
            if (block == null) return { input: 0, fuel: 0 };
            const ui: any = await agent.bot.openFurnace(block);
            let input = 0;
            let fuel = 0;
            try {
              if (ui?.inputItem?.() != null) input = Number((await ui.takeInput())?.count ?? 0);
              if (ui?.fuelItem?.() != null) fuel = Number((await ui.takeFuel())?.count ?? 0);
            } finally {
              try { await agent.bot.closeWindow(ui); } catch { /* 关不上不影响已取回 */ }
            }
            return { input, fuel };
          } catch {
            return { input: 0, fuel: 0 };
          }
        };
        const smeltStartedAt = Date.now();
        let smeltRounds = 1;
        let slots = await readFurnaceSlots();
        let accounting: SmeltAccounting | null = null;
        for (;;) {
          // **失败/超时先把炉里的原料和燃料取回来**：取回后下面的背包账会体现，而不是记成"丢"。
          if (!ok && ((slots.input ?? 0) > 0 || (slots.fuel ?? 0) > 0)) {
            const recovered = await recoverFurnaceInput();
            if (recovered.input > 0 || recovered.fuel > 0) {
              lines.push(
                `- 熔炉这次没烧成：**已把炉内 ${recovered.input} 个原料、${recovered.fuel} 个燃料取回背包**（材料没丢，别重挖）。`,
              );
              slots = await readFurnaceSlots();
            }
          }
          await settleInventory(agent.bot, 4, 60);
          const rawNow = await countInInventoryWithSync(agent.bot, raw.name, raw.count, 800);
          const outNow = await countInInventoryWithSync(agent.bot, wanted.name, 1, 800);
          // **全 0 的读数不能直接当"丢"**：方块还在、窗口也报过内容时，全 0 与
          // "容器正常"矛盾（真机 2026-10-20 A/B 各一例）⇒ 判 uncertain，宁可说"算不出来"。
          const slotsTrust = furnaceSlotsVerdict({
            blockPresent: slots.blockPresent,
            blockName: slots.blockName,
            windowContentsArrived: true,
            slots: { input: slots.input, fuel: slots.fuel, output: slots.output },
          });
          const uncertainAllZero =
            slotsTrust === 'uncertain' && (slots.input === 0 && slots.fuel === 0 && slots.output === 0);
          if (uncertainAllZero) {
            lines.push(
              '- **炉内三项读数是 0，但这个容器还在、窗口也收到过内容**——两件事互相矛盾：' +
                '这次**不结算**"丢了多少"（把读数当 null 处理）。先原样再发一次同样的 useBlock；若仍是全 0，把这条回执原样告诉开发者。',
            );
          }
          accounting = {
            rawName: raw.name,
            productName: wanted.name,
            bagBefore: rawBefore,
            bagAfter: rawNow,
            furnaceInput: uncertainAllZero ? null : slots.input,
            furnaceFuel: uncertainAllZero ? null : slots.fuel,
            furnaceOutput: uncertainAllZero ? null : slots.output,
            productGained: outBefore != null && outNow != null ? outNow - outBefore : null,
            target: raw.count,
          };
          // **能取就先取**：产物在产物槽里等于"还没到模型手上"，取走后再统计。
          if ((accounting.furnaceOutput ?? 0) > 0) {
            const takenNow = await takeFurnaceOutput();
            if (takenNow > 0) {
              slots = await readFurnaceSlots();
              const outNowAgain = await countInInventoryWithSync(agent.bot, wanted.name, 1, 800);
              accounting.productGained = outBefore != null && outNowAgain != null ? outNowAgain - outBefore : accounting.productGained;
              accounting.furnaceOutput = slots.output;
              lines.push(`- 产物槽里已有成品，已取回 ${takenNow} 个 ${wanted.name}（这就是"还在炉里"的那些）。`);
            }
          }
          const produced = Math.max(0, accounting.productGained ?? 0) + (accounting.furnaceOutput ?? 0);
          const next = nextSmeltStep({
            produced,
            target: raw.count,
            furnaceInput: uncertainAllZero ? null : slots.input,
            furnaceFuel: uncertainAllZero ? null : slots.fuel,
            elapsedMs: Date.now() - smeltStartedAt,
            rounds: smeltRounds,
            maxRounds: 3,
            maxMs: 120_000,
          });
          lines.push(...formatSmeltAccounting(accounting, smeltRounds));
          if (next !== 'continue') {
            if (next !== 'done') lines.push('- ' + formatSmeltUnfinished(accounting, next));
            break;
          }
          // **不是失败，是还没烧完**：再开一次同样的调用接着烧（有轮数/时间上限）。
          smeltRounds += 1;
          lines.push('- 还没到目标，继续烧（这是进度，不是失败）。');
          await runSkill(
            agent.bot,
            lines,
            () => skills.smeltItem(agent.bot, raw.name, Math.max(1, raw.count - produced)),
            `续烧 ${raw.name}`,
            `续烧 ${raw.name} 没成功`,
          );
          slots = await readFurnaceSlots();
        }
        if (!ok && (accounting?.productGained ?? 0) <= 0) {
          return renderReport(
            lines,
            '上面几行是熔炉读到的真实账：原料在哪（背包/炉内）、缺什么燃料都写清了；照着下一步做，不要自己重挖补材料。',
          );
        }
        return renderReport(lines);
      }
      await settleInventory(agent.bot, 3, 50);
      await settleInventory(agent.bot, 2, 40);
      const have = countInInventory(agent.bot, wanted.name);
      let crafted = await runSkill(
        agent.bot,
        lines,
        () => craftSmart(agent.bot, wanted.name, wanted.count),
        // 先不写死产出 X×N——真正进包多少，等这一步回来按实际账目写。
        `合成 ${wanted.name}`,
        `做不出 ${wanted.name}`,
      );
      if (!crafted) {
        // 真机：有材料但连续报缺，重启才同步。再给背包一次同步机会后重试一次；
        // 仍然失败才把原因写清，并明确提示以 stats 为准，避免重复挖/丢材料。
        await settleInventory(agent.bot, 5, 80);
        crafted = await runSkill(
          agent.bot,
          lines,
          () => craftSmart(agent.bot, wanted.name, wanted.count),
          `刷新背包后合成 ${wanted.name}`,
          `刷新背包后仍做不出 ${wanted.name}`,
        );
      }
      await settleInventory(agent.bot, 3, 50);
      const now = await countInInventoryWithSync(agent.bot, wanted.name, 1, 800);
      if (crafted) {
        if (have != null && now != null) {
          lines.push(step(`实际进包 ${wanted.name}→ 实测 ${formatItemDelta(have, now)}${aliasNote}`));
          if (now - have <= 0) {
            lines.push(step(craftNoOutputNote(wanted.name, have, now)));
          }
        } else {
          lines.push(step(`合成技能报成功，但背包计数读不到；以 stats 为准。`));
        }
        return renderReport(lines);
      }
      if (have == null) {
        return renderReport(
          lines,
          '背包读不到，不能判断材料够不够；先把 stats 打出来核对，再决定怎么做。',
        );
      }
      return renderReport(
        lines,
        `检查一下 input（现在给的是 ${itemText(parsedIn.items) || '空'}）够不够、配方对不对。` +
          `背包里现有 ${wanted.name}×${have}。` +
          '如果 stats 里其实有材料，说明是客户端背包同步延迟——不要重复挖/丢材料，稍后用 stats 再核对一次；必要时重启 agent 后再试。',
      );
    },
  },
  {
    name: '!useEntity',
    description: td('useEntity'),
    params: {
      entity_id: { type: 'int', description: tp('useEntity', 'entity_id') },
      input: { type: 'string', description: tp('useEntity', 'input'), optional: true },
      output: { type: 'string', description: tp('useEntity', 'output'), optional: true },
    },
    perform: async function (
      agent: any,
      entity_id: number,
      input?: unknown,
      output?: unknown,
    ): Promise<string> {
      const parsedIn = parseItems(input);
      const parsedOut = parseItems(output);
      if (parsedIn.error != null) return `useEntity 参数不对：${parsedIn.error}`;
      if (parsedOut.error != null) return `useEntity 参数不对：${parsedOut.error}`;

      const lines: string[] = [];
      const entity = agent.bot?.entities?.[entity_id];
      if (entity == null) {
        return `找不到实体 #${entity_id}（可能已经消失或走远了）。看一眼 Live State 的实体表。`;
      }
      const kind = String(entity.name ?? entity.username ?? 'unknown');
      // **走之前评估路线**（Lead 2026-10-21：低血穿过三只苦力怕去开箱子矿车，被炸死丢 496 件）。
      try {
        const bot: any = agent.bot;
        const p = bot?.entity?.position;
        const targetPos = entity?.position;
        if (p != null && targetPos != null) {
          const hostiles = (Object.values(bot?.entities ?? {}) as Array<any>)
            .filter((e) => e?.position != null && String(e?.name ?? '') !== '' && mc.isHostile(e))
            .map((e) => ({ name: String(e.name), x: Number(e.position.x), z: Number(e.position.z) }));
          const from = { x: Number(p.x), z: Number(p.z) };
          const to = { x: Number(targetPos.x), z: Number(targetPos.z) };
          const near = threatsNearRoute({ from, to, hostiles });
          const verdict = planRouteThreatResponse({
            health: typeof bot?.health === 'number' ? bot.health : null,
            threats: near,
            from,
            to,
          });
          if (!verdict.proceed) {
            lines.push(step(verdict.message));
            return renderReport(lines);
          }
        }
      } catch {
        // 评估失败不阻挡交互（守卫坏了不许变成墙）。
      }
      lines.push(step(`目标 #${entity_id} 是 ${kind}，走过去`));
      const ok = await skills.goToPosition(
        agent.bot,
        entity.position?.x ?? null,
        entity.position?.y ?? null,
        entity.position?.z ?? null,
        2,
      );
      if (!ok) {
        return renderReport(lines, `走到 #${entity_id} 失败：追不上或路被堵。`);
      }

      if (parsedIn.items.length === 0 && parsedOut.items.length === 0) {
        if (kind === 'villager') {
          const shown = await skills.showVillagerTrades(agent.bot, entity_id);
          lines.push(step(shown ? '列出了它的交易' : '读不到交易列表'));
          return renderReport(lines);
        }
        lines.push(step(`到了 ${kind} 旁边，但没说要干什么（input/output 都是空的）`));
        return renderReport(lines);
      }

      if (parsedOut.items.length > 0 && parsedIn.items.length === 0) {
        const want = parsedOut.items[0] as ItemSpec;
        if (kind === 'villager') {
          const traded = await skills.tradeWithVillager(agent.bot, entity_id, want.name, want.count);
          lines.push(step(traded ? `交易换到 ${want.name}×${want.count}` : `交易失败（它没有这个交易，或你没带够东西）`));
          return renderReport(lines);
        }
        lines.push(step(`想从 ${kind} 身上拿 ${want.name}：拿的方法是 input 给它工具/容器（如 shears / bucket）`));
        return renderReport(lines);
      }

      const give = parsedIn.items[0] as ItemSpec;
      if (kind === 'villager') {
        const traded = await skills.tradeWithVillager(agent.bot, entity_id, give.name, give.count);
        lines.push(step(traded ? `用 ${give.name}×${give.count} 换了东西` : `交易失败（这个交易不对，或数量不够）`));
        return renderReport(lines);
      }
      const fed = await skills.consume(agent.bot, give.name);
      lines.push(step(fed ? `对 ${kind} 用了 ${give.name}×${give.count}` : `对 ${kind} 用 ${give.name} 失败`));
      return renderReport(lines);
    },
  },
  {
    name: '!craft',
    description: td('craft'),
    params: {
      input: { type: 'string', description: tp('craft', 'input') },
      output: { type: 'string', description: tp('craft', 'output') },
    },
    perform: async function (agent: any, input: unknown, output: unknown): Promise<string> {
      const parsedIn = parseItems(input);
      const parsedOut = parseItems(output);
      if (parsedIn.error != null) return `craft 参数不对：${parsedIn.error}`;
      if (parsedOut.error != null) return `craft 参数不对：${parsedOut.error}`;
      const want = parsedOut.items[0];
      if (want == null) return 'craft 参数不对：要给出 output（期望产出什么）。';
      const resolvedWant = resolveCraftItemName(want.name);
      if (!resolvedWant.valid) {
        return `craft 参数不对：没有 ${want.name} 这个物品（配方表里也没有）。金装备的注册名是 golden_*（如 golden_boots）。`;
      }
      const aliasNote = resolvedWant.aliasOf != null ? `（${resolvedWant.aliasOf} → ${resolvedWant.name}）` : '';
      want.name = resolvedWant.name;

      // 合成前先结算客户端背包；有材料却报缺，多半是 window_items 包还在飞。
      await settleInventory(agent.bot, 3, 50);
      await settleInventory(agent.bot, 2, 40);
      const have = countInInventory(agent.bot, want.name);
      let craftResult = await craftSmartDetailed(agent.bot, want.name, want.count);
      if (!craftResult.ok) {
        // 真机：有材料却连续报缺，重启才同步。再给背包一次同步机会后重试一次。
        await settleInventory(agent.bot, 5, 80);
        craftResult = await craftSmartDetailed(agent.bot, want.name, want.count);
      }
      const ok = craftResult.ok;
      await settleInventory(agent.bot, 3, 50);
      // 回执报实际进包多少，不报请求了多少；读不到就说读不到，不猜。
      const now = await countInInventoryWithSync(agent.bot, want.name, 1, 800);
      if (ok) {
        if (have != null && now != null) {
          const lines = [step(`${aliasNote}合成 ${want.name}→ 实测 ${formatItemDelta(have, now)}`)];
          if (now - have <= 0) {
            lines.push(step(craftNoOutputNote(want.name, have, now)));
          }
          return renderReport(lines);
        }
        return '合成技能报成功，但背包计数读不到；以 stats 为准。';
      }
      if (have == null) {
        return '背包读不到，不能判断材料够不够；先把 stats 打出来核对，再决定怎么做。';
      }
      return renderReport(
        [step(`做不出 ${want.name}×${want.count}`), step(craftResult.detail)],
        '同类材料（任何木板/原木/煤炭/羊毛）会按全背包合计、支持混用；上面已写明缺什么、现有多少。' +
          '如果 stats 里其实有材料，可能是客户端背包同步延迟——不要重复挖/丢材料，稍后用 stats 再核对一次。' +
          `想知道这个物品怎么做、缺哪些材料，用 getCraftingPlan(targetItem="…")；只有 3×3 的配方才需要工作台（那时用 useBlock(type=crafting_table, …)）。` +
          `背包里现有 ${want.name}×${have}。`,
      );
    },
  },
];

/** 三个交互工具都统一包上身体通道和超时回执；内部实现保持原样。 */
export const interactList: AgentCommand[] = interactCommands.map(wrapInteractiveCommand);

export default { interactList, planUseBlock, parseItems, runInteractiveAction };
