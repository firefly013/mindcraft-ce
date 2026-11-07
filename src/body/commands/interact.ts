/**
 * 交互类工具：方块交易、`useEntity`、`craft`。
 *
 * ## 从 `useBlock` 拆成单动词工具
 *
 * 之前的 `useBlock(type, coords?, input?, output?)` 靠 `input`/`output` 是否为空
 * 决定存款、取款、合成、烧炼还是直接使用。语义本身没错（我放进去什么，机制随便，
 * 最后给我什么），但一个参数在不同分支含义不同，最后长成了小型 DSL。
 *
 * 现在拆成十个工具，每个只表达一种动作：
 *
 * - `smelt`，熔炉族投料烧炼
 * - `combineAtAnvil`，铁砧两件合成
 * - `putInContainer` / `takeFromContainer`，容器存取
 * - `inspectContainer`，只读查看，不拿东西
 * - `lootContainer`，把奖励箱全部拿走
 * - `takeFurnaceOutput`，只取熔炉产物槽
 * - `sleep`，睡觉
 * - `interactBlock`，通用右键门/按钮/拉杆
 *
 * 真正执行仍走同一个内部函数 `performBlockTransaction`，定位、分支和分段回执
 * 不重复实现；模型看不到 `input`/`output` 的空值语义。
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
import { describeDyedShortfall } from '../library/item_names.js';
import { describeCraftShortfallForBot } from '../library/craft_shortfall.js';
import { corridorThreatVerdict, threatsNearCorridor } from '../safety/path_threat.js';
import Vec3 from 'vec3';
import { td, tp } from '../../shared/prompts.js';
import { isAnvilBlockName, itemDisplayName } from '../library/item_variants.js';
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
        return { items: [], error: '每项缺少 name。' };
      }
      const rawCount = obj['count'] ?? obj['num'] ?? 1;
      const count = typeof rawCount === 'number' ? rawCount : Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) {
        return { items: [], error: `"${name}" 的数量必须是正整数。` };
      }
      items.push({ name, count, countGiven: true });
      continue;
    }
    return { items: [], error: 'input/output 类型不支持。' };
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
      return { ok: false, detail: '附近 16 格没有熔炉，背包里也没有熔炉。' };
    }
    const free = world.getNearestFreeSpace(bot, 1, 16);
    if (free == null) return { ok: false, detail: '附近没有放熔炉的空地。' };
    await skills.placeBlock(bot, 'furnace', free.x, free.y, free.z);
    furnaceBlock = world.getNearestBlock(bot, 'furnace', 16);
    if (furnaceBlock == null) return { ok: false, detail: '放了熔炉但读不回来。' };
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
        return { ok: true, detail: `熔炉的燃料槽里已经有 ${Number(existing.count ?? 0)} 个 ${existing.name}。` };
      }
      const have = countInInventory(bot, existing.name) ?? 0;
      if (have > 0 && capacity + fuelCapacity(existing.name, have) >= smeltCount) {
        const more = Math.max(1, Math.ceil((smeltCount - capacity) / mc.getFuelSmeltOutput(existing.name)));
        await furnace.putFuel(mc.getItemId(existing.name), null, more);
        return {
          ok: true,
          detail: `熔炉的燃料槽里已经有 ${Number(existing.count ?? 0)} 个 ${existing.name}，又从背包里补投了 ${more} 个。`,
        };
      }
      const plan2 = planAggregateFuel(bot, smeltCount);
      return {
        ok: false,
        detail:
          `熔炉里的燃料只有 ${Number(existing.count ?? 0)} 个 ${existing.name}，不够烧 ${smeltCount} 个，` +
          (plan2 != null ? `背包里还有 ${plan2.available} 个 ${plan2.name}。` : '背包里也没有别的燃料了。'),
      };
    }
    // **所有燃料求和**（Lead 2026-10-21：只认 oak_planks 会判「有 stick×4 却燃料不够」）；
    // 够了就按单位从大到小投，不够就打印燃料账本，让模型自己判断。
    const totals = planFuelTotals(bot, smeltCount);
    if (totals == null) {
      return { ok: false, detail: '背包里没有能烧的燃料。' };
    }
    const ledger = totals.entries
      .map((entry) => `${entry.count} 个 ${entry.name}`)
      .join('、');
    if (!totals.ok) {
      return {
        ok: false,
        detail:
          `燃料不够，现在能用的有 ${ledger}，一共只够烧 ${Math.round(totals.capacity * 10) / 10} 个。`,
      };
    }
    // **只投一种燃料**（真机 2026-10-23：先投 3 根原木，再想补 1 块木板时，
    // mineflayer 的 putFuel 撞上"燃料槽里已经是别的东西"直接抛 destination full，
    // 整条熔炼链路当场判失败——明明只需要再多烧 1.5 个）。燃料槽只有一个，
    // 混投本来就不成立：挑**单独就能烧够**的那种，挑不到就如实报缺口。
    const single = totals.entries.find((entry) => entry.capacity >= smeltCount) ?? null;
    if (single == null) {
      return {
        ok: false,
        detail:
          `燃料不够，${ledger} 里每一种单独拿出来都不够烧 ${smeltCount} 个。`,
      };
    }
    const itemsToPut = Math.min(single.count, Math.max(1, Math.ceil(smeltCount / single.unit)));
    // **燃料槽可能被别的东西占着**（真机 2026-10-23：一把石镐躺在槽 1 里，
    // 于是 putFuel 每次都抛 `destination full`——那个错误只表示"目标区间没有空槽、
    // 也没有同类物品"）。先把它搬回背包空格：`withdraw` 对工具槽不一定生效，
    // 这里用玩家级操作（`moveSlotItem`，失败再 `clickWindow`）。
    const slotList: any[] = Array.isArray((furnace as any).slots) ? (furnace as any).slots : [];
    const occupant = slotList[1] as { name?: unknown; type?: unknown; count?: unknown } | null | undefined;
    if (occupant != null && String(occupant.name ?? '') !== single.name) {
      const invStart = Number((furnace as any).inventoryStart ?? 3);
      let dest = -1;
      for (let i = invStart; i < slotList.length; i++) {
        if (slotList[i] == null) {
          dest = i;
          break;
        }
      }
      try {
        if (dest >= 0) {
          await (bot as any).moveSlotItem(1, dest);
        } else {
          await (bot as any).clickWindow(1, 0, 0);
          const firstEmpty = (() => {
            for (let i = invStart; i < slotList.length; i++) if (slotList[i] == null) return i;
            return -1;
          })();
          if (firstEmpty >= 0) await (bot as any).clickWindow(firstEmpty, 0, 0);
        }
      } catch {
        // 燃料槽里的东西挪不走时，后面 putFuel 会失败，失败回执里会带上现场读数。
      }
    }
    try {
      await furnace.putFuel(mc.getItemId(single.name), null, itemsToPut);
    } catch (error: unknown) {
      // **`putFuel` 会抛 destination full，即使燃料槽是空的**（真机 2026-10-23：
      // 全新熔炉、燃料槽空、背包有空位，照样失败）。它内部按 `fuelSlot` 算目标槽，
      // 某些版本拿到的索引不对。这里退一步：**自己按窗口槽位搬**——
      // 原版熔炉 GUI 的燃料槽恒为 1，玩家背包从 `inventoryStart` 开始。
      const manual = await (async (): Promise<string> => {
        try {
          const anyBot: any = bot as any;
          const win = anyBot?.currentWindow;
          const winText = win == null ? '读不到' : `${String(win.type ?? '?')}，${Array.isArray(win.slots) ? win.slots.length : '?'} 个槽`;
          const invStart = Number((furnace as any).inventoryStart ?? 3);
          const slots: any[] = Array.isArray((furnace as any).slots) ? (furnace as any).slots : [];
          const names = slots
            .map((slot, index) => (slot == null ? null : `第 ${index + 1} 格是 ${Number(slot.count ?? 0)} 个 ${String(slot.name ?? '?')}`))
            .filter((entry): entry is string => entry != null)
            .slice(0, 6)
            .join('，');
          let remaining = itemsToPut;
          let moved = 0;
          for (let i = invStart; i < slots.length && remaining > 0; i++) {
            const slot = slots[i];
            if (slot == null || String(slot.name ?? '') !== single.name) continue;
            await anyBot.moveSlotItem(i, 1);
            const take = Math.min(remaining, Number(slot.count ?? 0));
            remaining -= take;
            moved += take;
          }
          if (moved > 0) return `putFuel 失败之后手动搬了 ${moved} 个 ${single.name} 进燃料槽`;
          return `manual-empty，当前窗口是 ${winText}，背包从第 ${invStart} 个槽开始，窗口一共 ${slots.length} 个槽，有东西的槽是 ${names || '无'}`;
        } catch (manualError: unknown) {
          return `manual-error，${manualError instanceof Error ? manualError.message : String(manualError)}`;
        }
      })();
      if (!manual.startsWith('putFuel') || manual.startsWith('manual')) {
        return { ok: false, detail: `投燃料失败了，${manual}` };
      }
      return { ok: true, detail: `${manual}。` };
    }
    return {
      ok: true,
      detail: `往燃料槽里投了 ${itemsToPut} 个 ${single.name}。`,
    };
  } catch (error: unknown) {
    // **诊断要在现场**（2026-10-23）：`destination full` 只有一个含义——目标区间既没有
    // 同类物品也没有空槽。燃料槽是空的却报这个，说明 `bot.currentWindow` 根本不是熔炉窗口。
    const anyBot = bot as any;
    const win = anyBot?.currentWindow;
    const winText = win == null ? '读不到' : `${String(win.type ?? '?')}，${Array.isArray(win.slots) ? win.slots.length : '?'} 个槽`;
    const diag = [
      `报错是 ${error instanceof Error ? error.message : String(error)}`,
      `当前窗口是 ${winText}`,
      `熔炉窗口是 ${String((furnace as any)?.id ?? (furnace as any)?.windowId ?? '?')}`,
      `窗口一共有 ${Array.isArray((furnace as any)?.slots) ? (furnace as any).slots.length : -1} 个槽`,
      `背包从第 ${String((furnace as any)?.inventoryStart ?? '?')} 个槽开始`,
    ].join('，');
    return { ok: false, detail: `投燃料失败了，${diag}。` };
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

/**
 * 取物/存物回执：一行事实（方向 + 物品 × 实测数量 + 容器读数 + 背包前后值）。
 *
 * 只报测到的数。容器读不到就说读不到，不解释同步、不给核对建议。
 */
export function formatTransferReceipt(
  name: string,
  requested: number,
  direction: 'deposit' | 'withdraw',
  result: TransferDetail,
  backpackBefore: number | null,
  backpackAfter: number | null,
): string {
  if (!result.ok) {
    const action = direction === 'deposit' ? '往里存' : '取出来';
    return `没能${action} ${requested} 个 ${name}，${result.detail}`;
  }
  const moved = result.containerDelta != null ? Math.abs(result.containerDelta) : (result.localMoved ?? requested);
  const container =
    result.containerDelta == null
      ? '容器数量读不到'
      : `箱子里的 ${name} 从 ${result.containerBefore ?? '读不到'} 个变成了 ${result.containerAfter ?? '读不到'} 个`;
  const bag = backpackBefore == null || backpackAfter == null
    ? '背包数量读不到'
    : `背包里从 ${backpackBefore} 个变成了 ${backpackAfter} 个`;
  const verb = direction === 'deposit' ? '存入' : '取出';
  return `${verb}了 ${moved} 个 ${name}，${container}，${bag}。`;
}

/** 熔炉族：blasting/smoking 和普通熔炉一样有 input/fuel/output 三个槽。 */
export function isFurnaceLikeBlock(name: unknown): boolean {
  return name === 'furnace' || name === 'blast_furnace' || name === 'smoker';
}

/**
 * 从**原料槽/燃料槽**里把误投的东西取回来。
 *
 * 为什么需要：`useBlock(type=furnace, output=…)` 只认产物槽，而误投进燃料槽的工具
 * 根本取不回来（真机 2026-10-23：一把石镐卡在燃料槽，炉子直接报废）。这不是"帮你
 * 做决定"，是**把身体能做的事补齐**——玩家右键就能把这格拿起来。
 *
 * 只在产物槽取不到时调用；找到了就取，取不到就如实说。
 */
export async function recoverFromContainerSlots(
  bot: any,
  furnace: any,
  item: ItemSpec,
  type: string,
): Promise<string | null> {
  const slots: any[] = Array.isArray(furnace?.slots) ? furnace.slots : [];
  const invStart = Number(furnace?.inventoryStart ?? 3);
  const limit = Math.min(invStart, slots.length);
  const labels = ['原料槽', '燃料槽', '产物槽'];
  for (let i = 0; i < limit; i++) {
    const slot = slots[i];
    if (slot == null || String(slot.name ?? '') !== item.name) continue;
    const count = Number(slot.count ?? 1);
    const before = countInInventory(bot, item.name);
    try {
      await furnace.withdraw(slot.type, null, count);
    } catch (error: unknown) {
      return `没能从 ${type} 的${labels[i] ?? `第 ${i} 个槽`}里取出 ${count} 个 ${item.name}，${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    await settleInventory(bot, 3, 50);
    const after = countInInventory(bot, item.name);
    const delta = before != null && after != null ? after - before : null;
    const bagText = delta != null ? `背包里从 ${before} 个变成了 ${after} 个` : '背包数量读不到';
    return `从 ${type} 的${labels[i] ?? `第 ${i} 个槽`}里取回了 ${count} 个 ${item.name}，${bagText}。`;
  }
  return null;
}

/**
 * 从熔炉**产物槽**取物。
 *
 * 没给数量 ⇒ 取走产物槽现有全部；给了数量 ⇒ 按数量取。取到多少以背包
 * 实际增量为准（操作前后 countInInventory 的差）。不碰原料槽/燃料槽。
 */
export async function takeFromFurnace(
  bot: any,
  located: { x: number; y: number; z: number },
  item: ItemSpec,
  type: string,
): Promise<string[]> {
  const block = bot?.blockAt?.(new Vec3(located.x, located.y, located.z));
  if (block == null || !isFurnaceLikeBlock(block.name)) {
    return [`没能读到 (${located.x}, ${located.y}, ${located.z}) 那里的 ${type}。`];
  }
  const before = countInInventory(bot, item.name);
  let furnace: any = null;
  try {
    furnace = await skills.openBlockUi(bot, block);
  } catch (error: unknown) {
    return [`没能从 ${type} 里取东西，${error instanceof Error ? error.message : String(error)}`];
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
      // **产物槽空 ≠ 里面没东西**（真机 2026-10-23 用 CLI 通关时踩到）：
      // 一把石镐被误投进燃料槽，产物槽是空的、`output=` 又只认产物槽 ⇒
      // 那件东西再也取不回来，整个炉子连带里面的工具一起废掉。
      // 这里补一条：请求的物品如果在原料/燃料槽里，就把它取回来，并点名从哪个槽取的。
      const recovered = await recoverFromContainerSlots(bot, furnace, item, type);
      if (recovered != null) return [recovered];
      return [`${type} 的产物槽是空的。`];
    }
    if (slotName !== item.name) {
      return [`产物槽里放着 ${slotCount} 个 ${slotName}，不是 ${item.name}，所以没有取。`];
    }
    // takeOutput 只能整叠取：显式数量小于整叠时不取，直接报事实。
    if (item.countGiven === true && item.count < slotCount) {
      return [`产物槽里放着 ${slotCount} 个 ${slotName}，一次只能整叠取走，所以没有取。`];
    }
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
    if (before == null || after == null) {
      return [`从 ${type} 的产物槽里取了 ${item.name}，背包数量读不到。`];
    }
    const delta = after - before;
    const left = item.countGiven === true ? `，产物槽里还剩 ${Math.max(0, remaining)} 个` : '';
    return [`从 ${type} 的产物槽里取出了 ${delta} 个 ${item.name}，背包里从 ${before} 个变成了 ${after} 个${left}。`];
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
    if (!ok) return { ok: false, detail: '走不到容器旁边。' };
    // `openContainer` 要的是 **Block 对象**，不是 `{x,y,z}`——传裸坐标它会报
    // `containerToOpen is neither a block nor an entity`（模型真机报回来的）。
    // 而 `blockAt` 要的是 **Vec3**（内部会调 `.floored()`），传裸对象会报
    // `pos.floored is not a function`（模型紧接着报回来的第二条）。
    const block = bot.blockAt?.(new Vec3(chestBlock.x, chestBlock.y, chestBlock.z));
    if (block == null) return { ok: false, detail: `(${chestBlock.x}, ${chestBlock.y}, ${chestBlock.z}) 那里没有方块。` };
    // **按方块类型分路**：熔炉族走 `bot.openFurnace`，箱子族才走 `openContainer`。
    // `openContainer` 的白名单里没有 furnace，所以传熔炉进去**必然**抛
    // `containerToOpen is neither a block nor an entity`——见 `skills.openBlockUi`。
    container = await skills.openBlockUi(bot, block);
  } catch (error: unknown) {
    return { ok: false, detail: `打不开容器，${error instanceof Error ? error.message : String(error)}` };
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
        .map((slot, i) => (slot?.name != null ? `第 ${i + 1} 格里是 ${slot.count ?? 1} 个 ${slot.name}` : null))
        .filter((slot) => slot != null)
        .slice(0, 24)
        .join('，');
      if (slots.length === 0) {
        return {
          ok: false,
          detail: '容器的槽位表读不到。',
        };
      }
      return {
        ok: false,
        detail:
          `容器里没有 ${name}，` +
          (slotList === '' ? '容器里有什么也读不到。' : `里面有 ${slotList}。`),
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
            const boxSlots = (container.slots ?? []).slice(0, Math.min(boxEnd, (container.slots ?? []).length));
            const empty = boxSlots.filter((it: { name?: string } | null | undefined) => it?.name == null).length;
            return {
                ok: false,
                detail:
                    `箱子满了，${boxSlots.length} 格全都有东西，没有能并入 ${name} 的堆` +
                    (empty > 0 ? `，另外还有 ${empty} 格空位读不到落点` : '') +
                    '。',
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
    // 搬完关掉箱子重开一次，用服务端返回的新窗口内容做判定。
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
    const boxAfter = countInBox(freshSlots);
    const containerDelta = freshReadable
      ? (direction === 'deposit' ? boxAfter - boxBefore : boxBefore - boxAfter)
      : null;
    if (containerDelta == null) {
      return {
        ok: false,
        detail: '容器数量读不到。',
        containerReadable: false,
        containerBefore: boxBefore,
        containerAfter: null,
        containerDelta: null,
        localMoved: moved,
      };
    }
    if (containerDelta <= 0) {
      const boxSlots = freshSlots.slice(0, Math.min(boxEnd, freshSlots.length));
      const empty = boxSlots.filter((it: { name?: string } | null | undefined) => it?.name == null).length;
      const full = direction === 'deposit' && empty === 0 ? '，而且箱子满了' : '';
      return {
        ok: false,
        detail:
          containerDelta === 0
            ? `容器里的 ${name} 没有变化，本地账记着挪了 ${moved} 个${full}。`
            : `容器里的 ${name} 反而少了 ${Math.abs(containerDelta)} 个，和这次操作的方向相反。`,
        containerReadable: true,
        containerBefore: boxBefore,
        containerAfter: boxAfter,
        containerDelta,
        localMoved: moved,
      };
    }
    return {
      ok: true,
      detail: '',
      containerReadable: true,
      containerBefore: boxBefore,
      containerAfter: boxAfter,
      containerDelta,
      localMoved: moved,
    };
  } catch (error: unknown) {
    return { ok: false, detail: `挪物品时出错了，错误是 ${error instanceof Error ? error.message : String(error)}。` };
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

/** 等游戏 tick（后台等服务器把窗口状态推下来）。 */
async function waitGameTicks(bot: any, ticks: number): Promise<void> {
  if (typeof bot?.waitForTicks === 'function') {
    try {
      await bot.waitForTicks(ticks);
      return;
    } catch {
      // 等 tick 失败就退回定时等待。
    }
  }
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, ticks) * 50));
}

/**
 * 铁砧：把一件物品**只放 1 个**进窗口槽。
 *
 * 右击（button=1）在空槽上只放一个；整叠书/多个同类物品不会被一次塞进去。
 * 窗口槽号 = 背包槽号 + 窗口的背包起点偏移（mineflayer 的 copyInventory 用同一个换算）。
 */
async function moveOneItemIntoAnvilSlot(bot: any, window: any, item: any, destSlot: number): Promise<boolean> {
  const slot = Number(item?.slot);
  if (!Number.isFinite(slot) || slot < 0) return false;
  const offset = Number(window?.inventoryStart ?? 0) - Number(bot?.inventory?.inventoryStart ?? 0);
  const source = slot + offset;
  if (!Number.isFinite(source) || source < 0) return false;
  if (typeof bot?.clickWindow !== 'function') return false;
  try {
    await bot.clickWindow(source, 0, 0);
    await bot.clickWindow(destSlot, 1, 0);
    // 右击只放下一个；整叠还剩在鼠标上就放回原格。
    if (window?.selectedItem != null) await bot.clickWindow(source, 0, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 铁砧合成：两件输入 → 服务器算产物 → 取回收进背包。
 *
 * 不在这里算经验/附魔规则（那是游戏自己的事）：放进去、等服务端给产物、取走；
 * 没产物/等级不够/组合不成立都由服务端结果说话，再如实写进回执。
 */
async function combineAtAnvil(
  agent: any,
  located: { x: number; y: number; z: number },
  first: any,
  second: any,
  outputSpec: ItemSpec | null,
  lines: string[],
): Promise<string> {
  const bot = agent.bot;
  if (first == null || second == null) {
    return renderReport(lines, '没做到铁砧合成：两格输入里有一格是空的。');
  }
  const block = bot.blockAt?.(new Vec3(located.x, located.y, located.z));
  if (block == null) return renderReport(lines, '没做到铁砧合成：读不到铁砧那一格。');
  if (typeof bot.openAnvil !== 'function') return renderReport(lines, '没做到铁砧合成：客户端没有 openAnvil。');

  const window: any = await withTimeout<any>(bot.openAnvil(block), TOOL_TIMEOUT_MS, null);
  if (window == null) return renderReport(lines, `超时：${Math.round(TOOL_TIMEOUT_MS / 1000)} 秒。`);

  const before = world.getInventoryCounts(bot);
  try {
    const movedFirst = await moveOneItemIntoAnvilSlot(bot, window, first, 0);
    const movedSecond = await moveOneItemIntoAnvilSlot(bot, window, second, 1);
    if (!movedFirst || !movedSecond) {
      lines.push('有一件物品没有放进铁砧。');
    }
    let product: { name?: unknown; count?: unknown } | null = null;
    for (let i = 0; i < 10 && product == null; i++) {
      await waitGameTicks(bot, 1);
      product = window?.slots?.[2] ?? null;
    }
    if (product == null) {
      lines.push('铁砧合成没有做成，因为铁砧里没有产出任何东西。');
      return renderReport(lines);
    }
    lines.push(`铁砧产出了 ${String(product.name ?? 'unknown')}，一共 ${Number(product.count ?? 1)} 个。`);
    await bot.putAway(2);
  } catch (error) {
    lines.push('铁砧合成没有做成，错误是 ' + (error instanceof Error ? error.message : String(error)) + '。');
  } finally {
    try {
      await window?.close?.();
    } catch {
      // 关不上不影响已拿到的东西。
    }
  }

  await settleInventory(bot, 3, 50);
  const after = world.getInventoryCounts(bot);
  const changed: string[] = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = Number(before[name] ?? 0);
    const now = Number(after[name] ?? 0);
    if (was !== now) changed.push(`${name} 从 ${was} 个变成 ${now} 个`);
  }
  if (changed.length > 0) lines.push('背包的变化是 ' + changed.join('，') + '。');
  if (outputSpec != null) {
    const now = countInInventory(bot, outputSpec.name);
    lines.push(now == null ? `读不到背包里 ${outputSpec.name} 的数量。` : `背包里的 ${outputSpec.name} 有 ${now} 个。`);
  }
  return renderReport(lines);
}

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
  if (slot === SLOT_UNREADABLE) return `${label}读不到，不代表这一槽是空的。`;
  const s2 = slot as { name?: unknown; count?: unknown } | null | undefined;
  const name = typeof s2?.name === 'string' ? s2.name : null;
  if (name == null) return `${label}是空的。`;
  return `${label}里有 ${String(s2?.count ?? 1)} 个 ${name}。`;
}

/** 回执行；不再加列表前缀。 */
function step(text: string): string {
  return text;
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
  return `从 ${have} 个变成了 ${now} 个`;
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
  return `合成 ${name} 没有产出，背包里从 ${have} 个变成了 ${now} 个。`;
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
  const timedOut = Symbol('timeout');
  const ok = await withTimeout<boolean | typeof timedOut>(
    fn(),
    TOOL_TIMEOUT_MS,
    timedOut,
  );
  const after = read();
  const delta = (after.startsWith(before) ? after.slice(before.length) : after).trim();
  const reason = delta
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('，');
  if (ok === timedOut) {
    lines.push(`这次调用超时了，${Math.round(TOOL_TIMEOUT_MS / 1000)} 秒没有返回。`);
    return false;
  }
  if (ok) {
    if (okText !== '') lines.push(step(okText));
    return true;
  }
  lines.push(step(reason === '' ? failText : `${failText}，${reason}`));
  return false;
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

/** 加工类方块（有 input 也有 output 时走这条）。 */
const PROCESSING_BLOCKS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil', 'chipped_anvil', 'damaged_anvil']);
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
 * 烧炼结果：只报实测账（产出、背包前后、炉内剩余、对不上账的原料数）。
 */
export function formatSmeltAccounting(accounting: SmeltAccounting, _rounds: number): string[] {
    const fmt = (value: number | null): string => (value == null ? '读不到' : String(value));
    const lines: string[] = [];
    lines.push(
        `烧出 ${accounting.productName}：背包 +${fmt(accounting.productGained)}；` +
            `背包 ${accounting.rawName} ${fmt(accounting.bagBefore)} → ${fmt(accounting.bagAfter)}。`,
    );
    lines.push(
        `炉内：输入 ${fmt(accounting.furnaceInput)}、燃料 ${fmt(accounting.furnaceFuel)}、` +
            `产物 ${fmt(accounting.furnaceOutput)}。`,
    );
    const lost = unaccountedInput(accounting);
    if (lost != null && lost > 0) {
        lines.push(`账目对不上，少了 ${lost} 个 ${accounting.rawName}。`);
    }
    return lines;
}

/** 批次没烧完：只报进度和炉内剩余。 */
export function formatSmeltUnfinished(accounting: SmeltAccounting, next: SmeltNext): string {
    const remaining = accounting.furnaceInput;
    const head = `烧到 ${Math.max(0, accounting.productGained ?? 0)}/${accounting.target}`;
    if (remaining == null) return `${head}，炉内读数不可用。`;
    const why = next === 'stop-fuel' ? '缺燃料' : next === 'stop-input' ? '原料不足' : '到时间上限';
    return `${head}，炉内剩 ${remaining} 个 ${accounting.rawName}（${why}）。`;
}

/** 容器类方块（只存或只取）。彩色潜影盒用 `isContainerBlockType` 的 `endsWith` 兜住。 */
const CONTAINER_BLOCKS: readonly string[] = ['chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box'];

/** 开箱拿东西用（含 shulker 变体，`isContainerBlockType` 统一判定）。 */
const CONTAINER_TYPES = CONTAINER_BLOCKS;

const FURNACE_TYPES: readonly string[] = ['furnace', 'blast_furnace', 'smoker'];
const ANVIL_TYPES: readonly string[] = ['anvil', 'chipped_anvil', 'damaged_anvil'];

/** 箱子类容器，包含所有颜色的潜影盒。 */
export function isContainerBlockType(name: unknown): boolean {
  const text = String(name ?? '').trim();
  return CONTAINER_BLOCKS.includes(text) || text.endsWith('_shulker_box');
}

/** 当前版本注册表里所有容器名，用于“不给 type 时找最近一个容器”。 */
export function containerTypeNames(bot: any): string[] {
  const names = [...CONTAINER_BLOCKS];
  try {
    for (const name of Object.keys(bot?.registry?.blocksByName ?? {})) {
      if (name.endsWith('_shulker_box') && !names.includes(name)) names.push(name);
    }
  } catch {
    // 读不到注册表就用基础名单。
  }
  return names;
}

/** 多个类型里够得着的最近一个。 */
function nearestReachableOfTypes(
  bot: any,
  types: readonly string[],
  maxDistance = 4,
): { name: string; x: number; y: number; z: number } | null {
  let best: { name: string; x: number; y: number; z: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const name of types) {
    const pos = nearestReachableBlock(bot, name, maxDistance);
    if (pos == null) continue;
    const d = distanceToBlock(bot, pos.x, pos.y, pos.z);
    if (d != null && d < bestD) {
      bestD = d;
      best = { name, ...pos };
    }
  }
  return best;
}

/**
 * 给拆分后的工具解析目标方块。
 *
 * - `type` 给了就按它找，并校验属于该工具允许的类型
 * - 没给 `type` 但给了 `coords`，就读那一格的实际方块名
 * - 两样都没给，就在允许类型里找够得着的最近一个
 *
 * 成功返回 `{ type, coords }`，失败返回一句可以直接回给模型的话。
 */
export function resolveBlockType(
  agent: any,
  rawType: unknown,
  coords: unknown,
  allowed: readonly string[],
  label: string,
): { type: string; coords?: unknown } | string {
  const given = typeof rawType === 'string' ? rawType.trim() : '';
  if (given !== '') {
    if (!allowed.includes(given)) {
      return `${label} 不支持 ${given}，可以用的类型有 ${allowed.join('、')}。`;
    }
    return { type: given, coords };
  }
  if (typeof coords === 'string' && coords.trim() !== '') {
    const parts = coords.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      return `coords 要写成 "x,y,z"，这次收到的是 "${coords}"。`;
    }
    const [x, y, z] = parts as [number, number, number];
    const actual = blockNameAt(agent.bot, x, y, z);
    if (actual == null) return `读不到 (${x},${y},${z}) 那一格。`;
    if (!allowed.includes(actual)) {
      return `(${x},${y},${z}) 那一格是 ${actual}，不是 ${label}。`;
    }
    return { type: actual, coords };
  }
  const found = nearestReachableOfTypes(agent.bot, allowed);
  if (found == null) return `身边 4 格内没有够得着的${label}。`;
  return { type: found.name, coords: `${found.x},${found.y},${found.z}` };
}

/**
 * 方块的落点分派（内部用，不再暴露成工具参数）。
 *
 * 拆成十个单动词工具之后，这个函数只负责把“这个方块 + 有没有输入/输出”映射到
 * 具体动作，不再让模型面对 `input`/`output` 同时代表存款、取款、合成和烧炼。
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
      reason: `${type} 不支持同时给 input 和 output。`,
    };
  }
  if (hasInput) {
    if (isContainerBlockType(type)) return { kind: 'deposit' };
    // 铁砧：两件输入就能合成，output 只是断言，可以不给。
    if (isAnvilBlockName(type)) return { kind: 'process' };
    if (PROCESSING_BLOCKS.has(type)) {
      return {
        kind: 'unsupported',
        reason: `${type} 加工需要 input 和 output（只收到 input）。`,
      };
    }
    return { kind: 'unsupported', reason: `${type} 不能只给 input。` };
  }
  if (hasOutput) {
    if (isContainerBlockType(type)) return { kind: 'withdraw' };
    // 熔炉取成品：output 单独给就是"把烤好的拿出来"。
    if (FURNACE_BLOCKS.has(type)) return { kind: 'withdraw' };
    if (PROCESSING_BLOCKS.has(type)) {
      return {
        kind: 'unsupported',
        reason: `${type} 加工需要 input 和 output（只收到 output）。`,
      };
    }
    return { kind: 'unsupported', reason: `${type} 不能只给 output。` };
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
    return `${label} 执行出错了，错误是 ${error instanceof Error ? error.message : String(error)}。`;
  }
  if (outcome?.interrupted === true && outcome.timedout !== true) {
    const who = String((agent?.bot as any)?.__interruptReason ?? '').trim();
    return `被中断了，原因是 ${who === '' ? '没有记录' : who}。`;
  }
  if (outcome?.timedout === true || result === ACTION_TIMEOUT) {
    return `这次调用超时了，${Math.round(TOOL_TIMEOUT_MS / 1000)} 秒没有返回。`;
  }
  const text = String(result).trim();
  if (text === '') {
    return `${label} 没有返回结果。`;
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
      return `${g.tag} 还缺 ${g.missing}，需要 ${g.required}，现在有 ${have}，合计 ${g.available}，同类混用也还差 ${g.missing}。`;
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
    return {
      ok: false,
      detail:
        `没做到合成 ${itemName}：需要 3×3 工作台` +
        (plan.ok ? '（材料够）。' : `；缺 ${plan.missingText}。`),
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
        detail: `没做到合成 ${itemName}，错误是 ${error instanceof Error ? error.message : String(error)}。`,
        mixed: assigned.mixed,
      };
    }
    return {
      ok: true,
      detail: `${assigned.mixed ? '混用同类材料合成' : '合成'} ${itemName}×${runs * perCraft}（${formatUsedItems(assigned.used)}）。`,
      mixed: assigned.mixed,
    };
  }
  return {
    ok: false,
    detail:
      `没做到合成 ${itemName}：材料不够` +
      (plan.missingText !== '' ? `（缺 ${plan.missingText}）` : '') +
      '。',
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
    return { ok: false, detail: `没做到合成 ${itemName}，物品名不合法。` };
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
    if (shortfall != null) {
      return { ok: false, detail: shortfall.replaceAll('**', '').split('——')[0] ?? shortfall };
    }
  } catch {
    // 读不到背包就照常尝试合成（不让守卫变成墙）。
  }
  try {
    if (await skills.craftRecipe(bot, targetName, num)) {
      return { ok: true, detail: `${aliasNote}合成 ${targetName} 成功。` };
    }
  } catch (error: unknown) {
    skills.log(bot, `craftRecipe 出错了，错误是 ${error instanceof Error ? error.message : String(error)}。`);
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

/**
 * 单次方块交易的内部实现。
 *
 * 十个单动词工具只负责把参数整理成 `type + input + output`，真正的定位、
 * 工作台/熔炉/铁砧/箱子分支和分段回执都留在这里。**它不再是工具**，模型看不到，
 * `input`/`output` 靠空值决定动作的那套歧义只存在于内部。
 */
/** 定位到某一格方块；返回坐标或一句可以直接回给模型的话。 */
async function locateBlockForAction(
  agent: any,
  type: string,
  coords: unknown,
): Promise<{ x: number; y: number; z: number } | string> {
  if (typeof coords === 'string' && coords.trim() !== '') {
    const parts = coords.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      return `coords 要写成 "x,y,z"，这次收到的是 "${coords}"。`;
    }
    const [x, y, z] = parts as [number, number, number];
    const actual = blockNameAt(agent.bot, x, y, z);
    if (actual != null && actual !== type) {
      return `(${x},${y},${z}) 那一格是 ${actual}，不是 ${type}。`;
    }
    const startDistance = distanceToBlock(agent.bot, x, y, z);
    if (startDistance == null || startDistance > 4.5) {
      let ok = await skills.goToPosition(agent.bot, x, y, z, 2);
      if (!ok) {
        // 目标方块本身不可站立：改试相邻可站立格。
        const spots = findAdjacentStandable(agent.bot, x, y, z);
        for (const spot of spots.slice(0, 4)) {
          const reached = await skills.goToPosition(agent.bot, spot.x, spot.y, spot.z, 0);
          if (reached) {
            ok = true;
            break;
          }
        }
      }
      if (!ok) {
        const nowDistance = distanceToBlock(agent.bot, x, y, z);
        return `走不到 (${x},${y},${z})，离目标 ${
          nowDistance == null ? '读不到' : nowDistance.toFixed(1)
        } 格）。`;
      }
    }
    return { x, y, z };
  }
  const nearby = nearestReachableBlock(agent.bot, type);
  if (nearby == null) return `身边 4 格内没有 ${type}。`;
  return nearby;
}

/** 方块交易的内部实现。 */
async function performBlockTransaction(
  agent: any,
  type: string,
  coords?: unknown,
  input?: unknown,
  output?: unknown,
): Promise<string> {
      const lines: string[] = [];
      const parsedIn = parseItems(input);
      const parsedOut = parseItems(output);
      if (parsedIn.error != null) return `参数不对，${parsedIn.error}`;
      if (parsedOut.error != null) return `参数不对，${parsedOut.error}`;

      const plan = planUseBlock(type, parsedIn.items.length > 0, parsedOut.items.length > 0);
      if (plan.kind === 'unsupported') return `这次操作不支持，${plan.reason}`;

      const locatedOrError = await locateBlockForAction(agent, type, coords);
      if (typeof locatedOrError === 'string') return locatedOrError;
      const located = locatedOrError;

      // 分派到已有技能。每一步都写进 lines，失败也写清楚。
      if (plan.kind === 'interact') {
        // **开箱 = 拿东西**（用户要求「世界里有奖励箱，他们得拿」）。
        // 容器全拿能力放在这个内部 interact 分支里
        // （`takeFromChest`/`viewChest` 从来不是工具，模型根本调不到——那些文案今晚一并删掉）。
        if (isContainerBlockType(type)) {
          if (located == null) return '没做到开箱：定位不到容器。';
          const containerBlock = agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z));
          if (containerBlock == null) {
            return `读不到 (${located.x},${located.y},${located.z}) 那一格。`;
          }
          try {
            const outcome = await skills.lootContainer(agent.bot, containerBlock);
            const fmt = (list: Array<{ name: string; count: number }>): string =>
              list.length === 0 ? '无' : list.map((entry) => `${entry.name}×${entry.count}`).join('、');
            if (!outcome.readable) {
              lines.push('开箱失败了，因为读不到槽位表。');
            } else {
              lines.push(`箱子里有 ${fmt(outcome.contents)}。`);
              if (outcome.taken.length > 0) lines.push(`拿走了 ${fmt(outcome.taken)}。`);
              if (outcome.left.length > 0) lines.push(`留在箱子里的是 ${fmt(outcome.left)}。`);
              if (outcome.contents.length > 0 && outcome.taken.length === 0) lines.push('没有拿走东西。');
            }
          } catch (error: unknown) {
            lines.push(`开箱失败了，错误是 ${error instanceof Error ? error.message : String(error)}。`);
          }
          return renderReport(lines);
        }
        if (type === 'bed') {
          await runSkill(agent.bot, lines, () => skills.goToBed(agent.bot), '已睡下并醒来。', '没做到睡觉');
          return renderReport(lines);
        }

        if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') {
          if (located == null) return '没做到查看熔炉：定位不到熔炉。';

          try {
            const furnaceBlock = agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z));
            if (furnaceBlock == null) {
              return `读不到 (${located.x},${located.y},${located.z}) 那一格。`;
            }
            const container: any = await withTimeout(skills.openBlockUi(agent.bot, furnaceBlock), TOOL_TIMEOUT_MS, null);
            if (container == null) {
              return `这次调用超时了，${Math.round(TOOL_TIMEOUT_MS / 1000)} 秒没有返回。`;
            }
            lines.push(slotLine(readSlot(container, 'inputItem'), '原料槽'));
            lines.push(slotLine(readSlot(container, 'fuelItem'), '燃料槽'));
            lines.push(slotLine(readSlot(container, 'outputItem'), '产物槽'));
            await container.close?.();
            return renderReport(lines);
          } catch (error: unknown) {
            return `读取熔炉失败了，错误是 ${error instanceof Error ? error.message : String(error)}。`;
          }
        }
        lines.push(`用了 ${type}。`);
        return renderReport(lines);
      }

      if (plan.kind === 'deposit') {
        if (located == null) return '没做到存入：定位不到容器。';
        for (const item of parsedIn.items) {
          await settleInventory(agent.bot, 2, 50);
          const beforeCount = countInInventory(agent.bot, item.name);
          const result = await transferWithContainer(agent.bot, located, item.name, item.count, 'deposit');
          await settleInventory(agent.bot, 3, 50);
          const afterCount = countInInventory(agent.bot, item.name);
          lines.push(formatTransferReceipt(item.name, item.count, 'deposit', result, beforeCount, afterCount));
        }
        return renderReport(lines);
      }

      if (plan.kind === 'withdraw') {
        if (located == null) return '没做到取出：定位不到容器。';
        // 熔炉族走专用取物：不传数量时把产物槽现有全拿走，传了数量按数量取。
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
          lines.push(formatTransferReceipt(item.name, item.count, 'withdraw', result, beforeCount, afterCount));
        }
        return renderReport(lines);
      }

      // process：output 是断言。
      const wanted = parsedOut.items[0];
      if (wanted == null) return '这次操作做不到：加工缺少 output。';
      const resolvedWanted = resolveCraftItemName(wanted.name);
      if (!resolvedWanted.valid) {
        return `这次操作做不到，${wanted.name} 不是有效的物品名。`;
      }
      const aliasNote = resolvedWanted.aliasOf != null ? `（${resolvedWanted.aliasOf} → ${resolvedWanted.name}）` : '';
      wanted.name = resolvedWanted.name;
      if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') {
        // smeltItem 要的是原料；output 只当断言用。
        const raw = parsedIn.items[0];
        if (raw == null) {
          return `没做到烧炼，因为没有给 input。`;
        }
        await settleInventory(agent.bot, 3, 50);
        const fuelPrep = await ensureAggregateFuel(agent.bot, raw.count, located);
        try {
          const arm = (agent.bot as { __armContainerPacketDump?: (reason: string, label?: 'container' | 'craft' | 'furnace') => void })
            .__armContainerPacketDump;
          arm?.(`smelt furnace`, 'furnace');
        } catch {
          // 诊断不是功能，武装失败不影响烧炼。
        }
        if (!fuelPrep.ok) {
          return `没做到烧炼 ${raw.name}，一共要 ${raw.count} 个，${fuelPrep.detail}`;
        }
        const rawBefore = await countInInventoryWithSync(agent.bot, raw.name, raw.count, 800);
        if (rawBefore != null && rawBefore < raw.count) {
          return `没做到烧炼 ${raw.name}，一共要 ${raw.count} 个，背包里只有 ${rawBefore} 个。`;
        }
        const outBefore = countInInventory(agent.bot, wanted.name);
        const ok = await runSkill(
          agent.bot,
          lines,
          () => skills.smeltItem(agent.bot, raw.name, raw.count),
          '',
          `没做到烧炼 ${raw.name}`,
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
        let accounting: SmeltAccounting | null;
        for (;;) {
          // **失败/超时先把炉里的原料和燃料取回来**：取回后下面的背包账会体现，而不是记成"丢"。
          if (!ok && ((slots.input ?? 0) > 0 || (slots.fuel ?? 0) > 0)) {
            const recovered = await recoverFurnaceInput();
            if (recovered.input > 0 || recovered.fuel > 0) {
              lines.push(`已从炉内取回原料 ${recovered.input} 个、燃料 ${recovered.fuel} 个。`);
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
            lines.push('炉内三项读数全 0，容器仍在（读数存疑）。');
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
              lines.push(`从产物槽取回 ${takenNow} 个 ${wanted.name}。`);
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
          if (next !== 'continue') {
            if (next !== 'done') lines.push(formatSmeltUnfinished(accounting, next));
            break;
          }
          smeltRounds += 1;
          await runSkill(
            agent.bot,
            lines,
            () => skills.smeltItem(agent.bot, raw.name, Math.max(1, raw.count - produced)),
            '',
            `没做到续烧 ${raw.name}`,
          );
          slots = await readFurnaceSlots();
        }
        if (accounting != null) lines.push(...formatSmeltAccounting(accounting, smeltRounds));
        return renderReport(lines);
      }
      await settleInventory(agent.bot, 3, 50);
      await settleInventory(agent.bot, 2, 40);
      const have = countInInventory(agent.bot, wanted.name);
      let crafted = await runSkill(
        agent.bot,
        lines,
        () => craftSmart(agent.bot, wanted.name, wanted.count),
        '',
        `没做到合成 ${wanted.name}`,
      );
      if (!crafted) {
        await settleInventory(agent.bot, 5, 80);
        crafted = await runSkill(
          agent.bot,
          lines,
          () => craftSmart(agent.bot, wanted.name, wanted.count),
          '',
          `没做到合成 ${wanted.name}`,
        );
      }
      await settleInventory(agent.bot, 3, 50);
      const now = await countInInventoryWithSync(agent.bot, wanted.name, 1, 800);
      if (crafted) {
        if (have != null && now != null) {
          lines.push(`合成了 ${wanted.name}，背包里从 ${have} 个变成 ${now} 个。${aliasNote}`);
          if (now - have <= 0) {
            lines.push(craftNoOutputNote(wanted.name, have, now));
          }
        } else {
          lines.push(`合成了 ${wanted.name}，但是背包读数不可用。`);
        }
      } else if (have == null && lines.length === 0) {
        lines.push(`没做到合成 ${wanted.name}，因为背包读数不可用。`);
      }
      return renderReport(lines);
}

/** 只读查看容器或熔炉，不移动任何东西。 */
async function inspectBlockContents(agent: any, type: string, coords: unknown): Promise<string> {
  const located = await locateBlockForAction(agent, type, coords);
  if (typeof located === 'string') return located;
  const block = agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z));
  if (block == null) return `读不到 (${located.x},${located.y},${located.z}) 那一格。`;
  const container: any = await withTimeout(skills.openBlockUi(agent.bot, block), TOOL_TIMEOUT_MS, null);
  if (container == null) return `这次调用超时了，${Math.round(TOOL_TIMEOUT_MS / 1000)} 秒没有返回。`;
  try {
    if (isFurnaceLikeBlock(type)) {
      const lines = [
        slotLine(readSlot(container, 'inputItem'), '原料槽'),
        slotLine(readSlot(container, 'fuelItem'), '燃料槽'),
        slotLine(readSlot(container, 'outputItem'), '产物槽'),
      ];
      return renderReport([`${type} (${located.x},${located.y},${located.z})：`, ...lines]);
    }
    const slots: any[] = Array.isArray(container.slots) ? container.slots : [];
    const invStart = Number(container.inventoryStart ?? 9);
    const end = Math.min(invStart, slots.length);
    const occupied: string[] = [];
    for (let i = 0; i < end; i++) {
      const slot = slots[i];
      const name = String(slot?.name ?? '');
      if (name === '') continue;
      const label = itemDisplayName(slot, name, agent.bot?.registry ?? null);
      occupied.push(`第 ${i + 1} 格 ${label}×${Number(slot?.count ?? 1)}`);
    }
    let free = 0;
    for (let i = 0; i < end; i++) if (slots[i] == null) free++;
    const head = `${type} (${located.x},${located.y},${located.z}) 里有 ${
      occupied.length > 0 ? occupied.join('、') : '没有东西'
    }。`;
    return renderReport([head, `容器里还剩 ${free} 个空格。`]);
  } finally {
    try {
      await container.close?.();
    } catch {
      // 关不上不影响已读到的内容。
    }
  }
}

/** 把熔炉产物槽里已经烧好的东西全部取出来，不投料。 */
async function takeFurnaceOutputAction(agent: any, type: string, coords: unknown): Promise<string> {
  const located = await locateBlockForAction(agent, type, coords);
  if (typeof located === 'string') return located;
  const bot = agent.bot;
  const block = bot.blockAt?.(new Vec3(located.x, located.y, located.z));
  if (block == null) return `读不到 (${located.x},${located.y},${located.z}) 那一格。`;
  if (typeof bot.openFurnace !== 'function') return '客户端没有 openFurnace，取不了产物。';
  const ui: any = await withTimeout(bot.openFurnace(block), TOOL_TIMEOUT_MS, null);
  if (ui == null) return `这次调用超时了，${Math.round(TOOL_TIMEOUT_MS / 1000)} 秒没有返回。`;
  const before = world.getInventoryCounts(bot);
  const taken: Array<{ name: string; count: number }> = [];
  try {
    for (let guard = 0; guard < 64; guard++) {
      const item = ui?.outputItem?.();
      if (item == null) break;
      const got: any = await ui.takeOutput();
      const count = Number(got?.count ?? 0);
      if (count <= 0) break;
      taken.push({ name: String(got?.name ?? item?.name ?? 'unknown'), count });
    }
  } finally {
    try {
      await bot.closeWindow(ui);
    } catch {
      // 关不上不影响已取到的产物。
    }
  }
  await settleInventory(bot, 3, 50);
  const after = world.getInventoryCounts(bot);
  const lines: string[] = [];
  if (taken.length === 0) {
    lines.push('产物槽是空的，没有可拿的东西。');
  } else {
    lines.push(`从产物槽拿了 ${taken.map((entry) => `${entry.name}×${entry.count}`).join('、')}。`);
    const changed: string[] = [];
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const was = Number(before[name] ?? 0);
      const now = Number(after[name] ?? 0);
      if (was !== now) changed.push(`${name} 从 ${was} 个变成 ${now} 个`);
    }
    if (changed.length > 0) lines.push(`背包的变化是 ${changed.join('，')}。`);
  }
  return renderReport(lines);
}

/** 通用右键一个方块实例。 */
async function interactWithBlockAction(agent: any, coords: unknown, rawType: unknown): Promise<string> {
  if (typeof coords !== 'string' || coords.trim() === '') {
    return 'interactBlock 需要 coords，写成 "x,y,z"，告诉我要右键哪一格。';
  }
  const parts = coords.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return `coords 要写成 "x,y,z"，这次收到的是 "${coords}"。`;
  }
  const [x, y, z] = parts as [number, number, number];
  const actual = blockNameAt(agent.bot, x, y, z);
  if (actual == null) return `读不到 (${x},${y},${z}) 那一格。`;
  const given = typeof rawType === 'string' ? rawType.trim() : '';
  if (given !== '' && given !== actual) {
    return `(${x},${y},${z}) 那一格是 ${actual}，不是 ${given}。`;
  }
  const located = await locateBlockForAction(agent, actual, coords);
  if (typeof located === 'string') return located;
  const block = agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z));
  if (block == null) return `读不到 (${located.x},${located.y},${located.z}) 那一格。`;
  const lines: string[] = [`走到了 ${actual} (${located.x},${located.y},${located.z}) 旁边。`];
  try {
    if (agent.bot?.heldItem != null) await agent.bot.unequip('hand');
  } catch {
    // 换空手失败就照常试右键，失败会在下面报出来。
  }
  try {
    await agent.bot.activateBlock(block);
  } catch (error: unknown) {
    return renderReport(lines, `右键 ${actual} 失败了，错误是 ${error instanceof Error ? error.message : String(error)}。`);
  }
  await skills.wait(agent.bot, 300);
  const window: any = agent.bot?.currentWindow;
  if (window != null) {
    lines.push(`右键打开了 ${String(window.type ?? '窗口')}。`);
    try {
      await agent.bot.closeWindow(window);
      lines.push('已经关掉窗口，这个工具不支持继续操作窗口内容。');
    } catch {
      lines.push('窗口没能关掉。');
    }
  } else {
    lines.push('右键动作发出去了，没有可观察的界面变化。');
  }
  return renderReport(lines);
}

/** 睡床。 */
async function sleepOnBedAction(agent: any, coords: unknown): Promise<string> {
  const hasCoords = typeof coords === 'string' && coords.trim() !== '';
  let located: { x: number; y: number; z: number } | null = null;
  if (hasCoords) {
    const target = await locateBlockForAction(agent, 'bed', coords);
    if (typeof target === 'string') return target;
    located = target;
  }
  const ok = await skills.goToBed(agent.bot);
  if (ok) {
    return located == null
      ? '睡下并醒来了。'
      : `在 (${located.x},${located.y},${located.z}) 的床上睡下并醒来。`;
  }
  return located == null
    ? '没做到睡觉，附近没有睡成的床。'
    : `没做到睡觉，床在 (${located.x},${located.y},${located.z})。`;
}

const interactCommands: AgentCommand[] = [
  {
    name: '!smelt',
    description: td('smelt'),
    params: {
      input: { type: 'string', description: tp('smelt', 'input') },
      output: { type: 'string', description: tp('smelt', 'output') },
      type: { type: 'BlockOrItemName', description: tp('smelt', 'type'), optional: true },
      coords: { type: 'string', description: tp('smelt', 'coords'), optional: true },
    },
    perform: async function (
      agent: any,
      input: unknown,
      output: unknown,
      type?: unknown,
      coords?: unknown,
    ): Promise<string> {
      const resolved = resolveBlockType(agent, type, coords, FURNACE_TYPES, '熔炉');
      if (typeof resolved === 'string') return resolved;
      return await performBlockTransaction(agent, resolved.type, resolved.coords, input, output);
    },
  },
  {
    name: '!combineAtAnvil',
    description: td('combineAtAnvil'),
    params: {
      slot1: { type: 'int', description: tp('combineAtAnvil', 'slot1'), domain: [5, 45] },
      slot2: { type: 'int', description: tp('combineAtAnvil', 'slot2'), domain: [5, 45] },
      output: { type: 'string', description: tp('combineAtAnvil', 'output'), optional: true },
      type: { type: 'BlockOrItemName', description: tp('combineAtAnvil', 'type'), optional: true },
      coords: { type: 'string', description: tp('combineAtAnvil', 'coords'), optional: true },
    },
    perform: async function (
      agent: any,
      slot1: number,
      slot2: number,
      output?: unknown,
      type?: unknown,
      coords?: unknown,
    ): Promise<string> {
      const first = skills.itemAtSlot(agent.bot, slot1);
      if (first == null) return `第 ${slot1} 格没有东西，铁砧合成需要两件输入。`;
      const second = skills.itemAtSlot(agent.bot, slot2);
      if (second == null) return `第 ${slot2} 格没有东西，铁砧合成需要两件输入。`;
      const parsedOut = parseItems(output);
      if (parsedOut.error != null) return `output 参数不对，${parsedOut.error}`;
      const resolved = resolveBlockType(agent, type, coords, ANVIL_TYPES, '铁砧');
      if (typeof resolved === 'string') return resolved;
      const located = await locateBlockForAction(agent, resolved.type, resolved.coords);
      if (typeof located === 'string') return located;
      return await combineAtAnvil(agent, located, first, second, parsedOut.items[0] ?? null, []);
    },
  },
  {
    name: '!putInContainer',
    description: td('putInContainer'),
    params: {
      items: { type: 'string', description: tp('putInContainer', 'items') },
      type: { type: 'BlockOrItemName', description: tp('putInContainer', 'type'), optional: true },
      coords: { type: 'string', description: tp('putInContainer', 'coords'), optional: true },
    },
    perform: async function (
      agent: any,
      items: unknown,
      type?: unknown,
      coords?: unknown,
    ): Promise<string> {
      const resolved = resolveBlockType(agent, type, coords, containerTypeNames(agent.bot), '容器');
      if (typeof resolved === 'string') return resolved;
      return await performBlockTransaction(agent, resolved.type, resolved.coords, items, undefined);
    },
  },
  {
    name: '!takeFromContainer',
    description: td('takeFromContainer'),
    params: {
      items: { type: 'string', description: tp('takeFromContainer', 'items') },
      type: { type: 'BlockOrItemName', description: tp('takeFromContainer', 'type'), optional: true },
      coords: { type: 'string', description: tp('takeFromContainer', 'coords'), optional: true },
    },
    perform: async function (
      agent: any,
      items: unknown,
      type?: unknown,
      coords?: unknown,
    ): Promise<string> {
      const resolved = resolveBlockType(agent, type, coords, containerTypeNames(agent.bot), '容器');
      if (typeof resolved === 'string') return resolved;
      return await performBlockTransaction(agent, resolved.type, resolved.coords, undefined, items);
    },
  },
  {
    name: '!inspectContainer',
    description: td('inspectContainer'),
    params: {
      type: { type: 'BlockOrItemName', description: tp('inspectContainer', 'type'), optional: true },
      coords: { type: 'string', description: tp('inspectContainer', 'coords'), optional: true },
    },
    perform: async function (agent: any, type?: unknown, coords?: unknown): Promise<string> {
      const allowed = [...containerTypeNames(agent.bot), ...FURNACE_TYPES];
      const resolved = resolveBlockType(agent, type, coords, allowed, '容器或熔炉');
      if (typeof resolved === 'string') return resolved;
      return await inspectBlockContents(agent, resolved.type, resolved.coords);
    },
  },
  {
    name: '!lootContainer',
    description: td('lootContainer'),
    params: {
      type: { type: 'BlockOrItemName', description: tp('lootContainer', 'type'), optional: true },
      coords: { type: 'string', description: tp('lootContainer', 'coords'), optional: true },
    },
    perform: async function (agent: any, type?: unknown, coords?: unknown): Promise<string> {
      const resolved = resolveBlockType(agent, type, coords, containerTypeNames(agent.bot), '容器');
      if (typeof resolved === 'string') return resolved;
      return await performBlockTransaction(agent, resolved.type, resolved.coords);
    },
  },
  {
    name: '!takeFurnaceOutput',
    description: td('takeFurnaceOutput'),
    params: {
      type: { type: 'BlockOrItemName', description: tp('takeFurnaceOutput', 'type'), optional: true },
      coords: { type: 'string', description: tp('takeFurnaceOutput', 'coords'), optional: true },
    },
    perform: async function (agent: any, type?: unknown, coords?: unknown): Promise<string> {
      const resolved = resolveBlockType(agent, type, coords, FURNACE_TYPES, '熔炉');
      if (typeof resolved === 'string') return resolved;
      return await takeFurnaceOutputAction(agent, resolved.type, resolved.coords);
    },
  },
  {
    name: '!sleep',
    description: td('sleep'),
    params: {
      coords: { type: 'string', description: tp('sleep', 'coords'), optional: true },
    },
    perform: async function (agent: any, coords?: unknown): Promise<string> {
      return await sleepOnBedAction(agent, coords);
    },
  },
  {
    name: '!interactBlock',
    description: td('interactBlock'),
    params: {
      coords: { type: 'string', description: tp('interactBlock', 'coords') },
      type: { type: 'BlockOrItemName', description: tp('interactBlock', 'type'), optional: true },
    },
    perform: async function (agent: any, coords: unknown, type?: unknown): Promise<string> {
      return await interactWithBlockAction(agent, coords, type);
    },
  },
  {
    name: '!useEntity',
    description: td('useEntity'),
    params: {
      entity_id: { type: 'int', description: tp('useEntity', 'entity_id') },
      input_slot: { type: 'int', description: tp('useEntity', 'input_slot'), optional: true, domain: [5, 45] },
      output: { type: 'string', description: tp('useEntity', 'output'), optional: true },
    },
    perform: async function (
      agent: any,
      entity_id: number,
      input_slot?: unknown,
      output?: unknown,
    ): Promise<string> {
      const parsedOut = parseItems(output);
      if (parsedOut.error != null) return `useEntity 的参数不对，${parsedOut.error}`;
      const inputItem =
        input_slot == null
          ? null
          : skills.itemAtSlot(agent.bot, input_slot);
      if (input_slot != null && inputItem == null) {
        return `第 ${Number(input_slot)} 格没有东西，没法给这个实体。`;
      }
      const give =
        inputItem == null
          ? null
          : { name: String(inputItem.name ?? ''), count: Math.max(1, Number(inputItem.count ?? 1)) };

      const lines: string[] = [];
      const entity = agent.bot?.entities?.[entity_id];
      if (entity == null) {
        return `找不到实体 #${entity_id}。`;
      }
      const kind = String(entity.name ?? entity.username ?? 'unknown');
      // 走之前评估路线：只报直线上的苦力怕事实。
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
          const near = threatsNearCorridor({ from, to, hostiles });
          const verdict = corridorThreatVerdict({
            health: typeof bot?.health === 'number' ? bot.health : null,
            threats: near,
            from,
            to,
          });
          if (verdict.creepersNear > 0) {
            const health = typeof bot?.health === 'number' ? bot.health : null;
            const nearest = near.find((threat) => threat.name.toLowerCase().includes('creeper'));
            const fact =
              `血 ${health ?? '读不到'}，直线 6 格内有 ${verdict.creepersNear} 只苦力怕` +
              (nearest != null ? `（最近 ${nearest.offLine.toFixed(1)} 格）` : '') +
              '。';
            if (!verdict.proceed) return fact;
            lines.push(fact);
          }
        }
      } catch {
        // 评估失败不阻挡交互。
      }
      const ok = await skills.goToPosition(
        agent.bot,
        entity.position?.x ?? null,
        entity.position?.y ?? null,
        entity.position?.z ?? null,
        2,
      );
      if (!ok) {
        return `没做到接近 #${entity_id}，因为走不到。`;
      }

      if (give == null && parsedOut.items.length === 0) {
        if (kind === 'villager') {
          const shown = await skills.showVillagerTrades(agent.bot, entity_id);
          lines.push(shown ? '已打开交易列表。' : '读不到交易列表。');
          return renderReport(lines);
        }
        lines.push(`没做到交互 #${entity_id}，因为没有给 input 或 output。`);
        return renderReport(lines);
      }

      if (parsedOut.items.length > 0 && give == null) {
        const want = parsedOut.items[0] as ItemSpec;
        if (kind === 'villager') {
          const traded = await skills.tradeWithVillager(agent.bot, entity_id, want.name, want.count);
          lines.push(`交易 ${want.name}×${want.count} ${traded ? '成功了' : '没有成功'}。`);
          return renderReport(lines);
        }
        lines.push(`没做到从 ${kind} 拿 ${want.name}，因为这个实体没有 output 交互。`);
        return renderReport(lines);
      }

      if (give == null) return `没做到交互 #${entity_id}，因为没有给 input_slot 或 output。`;
      if (kind === 'villager') {
        const traded = await skills.tradeWithVillager(agent.bot, entity_id, give.name, give.count);
        lines.push(`交易 ${give.name}×${give.count} ${traded ? '成功了' : '没有成功'}。`);
        return renderReport(lines);
      }
      const fed = await skills.consume(agent.bot, give.name);
      lines.push(fed ? `对 ${kind} 用了 ${give.name}×1。` : `没做到对 ${kind} 使用 ${give.name}。`);
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
      if (parsedIn.error != null) return `craft 的参数不对，${parsedIn.error}`;
      if (parsedOut.error != null) return `craft 的参数不对，${parsedOut.error}`;
      const want = parsedOut.items[0];
      if (want == null) return 'craft 参数不对：缺少 output。';
      const resolvedWant = resolveCraftItemName(want.name);
      if (!resolvedWant.valid) {
        return `craft 用不了，${want.name} 不是有效的物品名。`;
      }
      const aliasNote = resolvedWant.aliasOf != null ? `（${resolvedWant.aliasOf} → ${resolvedWant.name}）` : '';
      want.name = resolvedWant.name;

      await settleInventory(agent.bot, 3, 50);
      await settleInventory(agent.bot, 2, 40);
      const have = countInInventory(agent.bot, want.name);
      let craftResult = await craftSmartDetailed(agent.bot, want.name, want.count);
      if (!craftResult.ok) {
        await settleInventory(agent.bot, 5, 80);
        craftResult = await craftSmartDetailed(agent.bot, want.name, want.count);
      }
      await settleInventory(agent.bot, 3, 50);
      // 回执报实际进包多少，不报请求了多少；读不到就说读不到。
      const now = await countInInventoryWithSync(agent.bot, want.name, 1, 800);
      if (craftResult.ok) {
        const lines: string[] = [];
        if (have != null && now != null) {
          lines.push(`合成了 ${want.name}，背包里从 ${have} 个变成 ${now} 个。${aliasNote}`);
          if (now - have <= 0) {
            lines.push(craftNoOutputNote(want.name, have, now));
          }
        } else {
          lines.push(`合成了 ${want.name}，但是背包读数不可用。`);
        }
        return renderReport(lines);
      }
      return craftResult.detail;
    },
  },
];

/** 三个交互工具都统一包上身体通道和超时回执；内部实现保持原样。 */
export const interactList: AgentCommand[] = interactCommands.map(wrapInteractiveCommand);

export default { interactList, planUseBlock, parseItems, runInteractiveAction };
