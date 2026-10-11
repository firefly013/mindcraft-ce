/*
 * Live State：每次模型请求前现采现渲的当前世界快照。
 *
 * 回答"现在是什么样"，不回答"刚刚发生了什么"（那是 History 的事）。
 * 设计上对齐 VLM 思想，但按本项目现状表达：
 *   - 执行器是 mineflayer + pathfinder，没有 Baritone 的 runningTasks，
 *     当前动作取自 ActionManager 的 currentActionLabel；
 *   - 感知列表按数量与半径截断并注明省略数（有界，不淹没上下文）；
 *   - 截图槽位：引用 vision 工具链最近一次拍摄（文件名+拍摄时间），
 *     而不是每请求现拍——渲染一帧很贵，快照必须轻。没有就如实写
 *     原因（vision 关闭 / 还没拍过），绝不编造。
 *
 * 快照函数永不抛错：缺字段就写 null/unknown，一个请求不能因为
 * 快照失败而发不出去。
 */

import { estimateTokens } from '../utils/tokens.js';
import { permits } from './permits.js';
import { safeguards } from './safeguards.js';
import { getVillagerProfession } from './library/world.js';
import type { PlanTodo } from './plan.js';
import { Vec3 } from 'vec3';

/**
 * `bot.blockAt` 只接受 Vec3：mineflayer 把参数原样交给 prismarine-world，
 * 而后者在区块已加载时会执行 `pos.floored()`——传 plain `{x,y,z}` 会抛
 * TypeError，被外层的 try/catch 吞掉后所有方块感知静默变成 null/unknown。
 */
const Vec3Of = (p: { x: number; y: number; z: number }): unknown => new Vec3(p.x, p.y, p.z);

export interface ScreenshotRef {
  file: string;
  takenAt: number;
}

export interface LiveBody {
  health: number | null;
  food: number | null;
  saturation: number | null;
  oxygen: number | null;
  xpLevel: number | null;
  xpProgress: number | null;
  pose: string | null;
  onGround: boolean | null;
  /** 药水效果，形如 `strength II 45s`；空数组=身上没有任何效果。 */
  effects: string[];
}

export interface LiveHeld {
  mainHand: string | null;
  offHand: string | null;
  armor: string[];
  /** 主手剩余耐久比例 0~1；空手或无耐久物品为 null。 */
  mainHandDurability: number | null;
  /**
   * 主手耐久的**原始读数**（used / max），用来诊断。
   *
   * 模型报过"耐久剩余 0%"但工具明显没坏（挖了 36 格），而 `prismarine-item` 的
   * `durabilityUsed` 是 getter，读不到 NBT 时会退化成 0 或 max，容易把"读不到"
   * 说成"快报废"。把两个原始数摊开，一眼能分清是读数错了还是真坏了。
   */
  mainHandDurabilityRaw: string | null;
}

export interface LiveBackpack {
  freeSlots: number | null;
  items: string[];
}

export interface LivePosition {
  x: number | null;
  y: number | null;
  z: number | null;
  yaw: number | null;
  pitch: number | null;
  dimension: string | null;
  biome: string | null;
  /** 水平速度（格/秒，粗估）；站着不动是 0。 */
  speed: number | null;
}

export interface LiveEnvironment {
  timeOfDay: number | null;
  weather: 'Clear' | 'Rain' | 'Thunderstorm' | 'Unknown';
  light: number | null;
  /** 客户端光照读数是快照，可能过期——可信度必须诚实标注。 */
  lightConfidence: 'high' | 'unknown';
  /** 游戏内第几天（time.day）。 */
  day: number | null;
}

export interface LiveEntity {
  id: number;
  name: string;
  kind: string | null;
  distance: number;
  x: number;
  y: number;
  z: number;
  health: number | null;
  /**
   * 实体的一句话附加信息（村民职业 `Farmer L2`、婴儿 `baby`）。
   *
   * 原来是 `!entities` 工具独有的，模型非调那个工具不可——而它就在
   * 快照里却不说自己是干什么的。搬过来后那个工具再无独有价值。
   * 用**可选**字段且非村民一律 `undefined`：快照的结构断言（toEqual）
   * 会忽略 undefined，加了字段也不破坏既有测试。
   */
  tag?: string;
}

export interface LiveBlock {
  name: string;
  distance: number;
  x: number;
  y: number;
  z: number;
}

export interface LiveScreenshot {
  ref: ScreenshotRef | null;
  /** 为 null 表示没有可用截图，这里写原因。 */
  unavailableReason: string | null;
}

export interface LiveMeta {
  gamemode: string | null;
  openScreen: string | null;
  currentAction: string | null;
  /** 潜行/疾跑等控制状态；null 表示普通站立。 */
  posture: string | null;
}

export interface LiveState {
  body: LiveBody;
  held: LiveHeld;
  backpack: LiveBackpack;
  position: LivePosition;
  environment: LiveEnvironment;
  entities: LiveEntity[];
  entitiesTruncated: number;
  /** 超明细上限的部分按"名字×数量 方位"聚合，远端语义不丢。 */
  entitiesSummary: string[];
  blocks: LiveBlock[];
  blocksTruncated: number;
  blocksSummary: string[];
  screenshot: LiveScreenshot;
  goal: string | null;
  todos: PlanTodo[];
  /**
   * 危险操作许可的现状（还有没有授权、授权哪几项、还剩多少秒）。
   * **必须让模型看得见** —— 否则它不知道自己现在能不能倒水/点火，
   * 只能靠"试一下被拒"来发现，那是最贵的一种发现方式。
   */
  dangerousOps: string;
  /** 保命程序开关现状（正常 / 已关闭 + 剩多少）。和危险操作许可是**两件事**。 */
  safeguards: string;
  meta: LiveMeta;
}

/** 感知半径（格），与截断上限一起保证快照有界。 */
export const PERCEPTION_RADIUS = 32;
/** 实体/方块各自最多列几条明细，超了走聚合摘要。 */
export const PERCEPTION_LIMIT = 16;
/**
 * 明细列表的 token 预算（对齐 VLM 的每列表 1024）：条数与 token
 * 谁先到谁封顶。名字很长的实体/方块多起来时，先保近处。
 * 口径说明：预算只算明细行本身，表头与下方的聚合摘要（最多
 * SUMMARY_LINES 行）不计入，所以整段实际占用会略超这个数。
 */
export const PERCEPTION_BUDGET_TOKENS = 1024;
/** 聚合摘要最多出几行，避免"远合并"自己又变成一坨。 */
export const SUMMARY_LINES = 6;

/**
 * 主手耐久比例：1 = 全新，0 = 报废；读不到就 null。
 *
 * **必须钳到 [0,1]**。mineflayer 的 `durabilityUsed`（NBT Damage）可能大于
 * mcData 给的 `maxDurability`，直接算 `1 - used/max` 会得到负数——模型侧
 * 看到的就是 `Held: stone_pickaxe (durability -300%)` 这种鬼话（它还据此
 * 反馈过 bug）；更糟的是负值会让 `tool.durability_low` 永远处于触发态。
 *
 * `edges.ts` 也用它——两处必须是同一个算法，否则快照和边缘检测会各说各话。
 */
export function durabilityFraction(used: unknown, max: unknown): number | null {
  const u = num(used);
  const m = num(max);
  if (u == null || m == null || m <= 0) return null;
  // **`max <= 1` 说明读到的不是耐久上限**。模型真机把这条根因挖出来了：
  // "耐久原始读数 used=35 max=1（明显错）"——1 是**堆叠上限 stackSize**。
  // 于是 `1 - 35/1` 被钳成 0，快照显示"耐久剩余 0%"、`tool.durability_low`
  // 反复误报（白白唤醒请求）。读不到就说读不到，不要瞎报。
  if (m <= 1) return null;
  return Math.min(1, Math.max(0, 1 - u / m));
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function dist3(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/** 罗盘八向：-Z 北、+Z 南、-X 西、+X 东（与 Minecraft 一致）。 */
export function compassOf(dx: number, dz: number): string {
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const idx = Math.round((((angle % 360) + 360) % 360) / 45) % 8;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][idx] as string;
}

/**
 * 条数与 token 双上限，谁先到谁封顶。永远至少留第一条——
 * 否则"预算很小"会退化成什么都不给，比不知道还糟。
 */
export function budgetedList<T>(
  items: readonly T[],
  limit: number,
  budgetTokens: number,
  cost: (item: T) => number,
): T[] {
  const kept: T[] = [];
  let tokens = 0;
  for (const item of items) {
    if (kept.length >= limit) break;
    const c = cost(item);
    if (kept.length > 0 && tokens + c > budgetTokens) break;
    kept.push(item);
    tokens += c;
  }
  return kept;
}

/**
 * 被明细上限挡在外面的部分，按"名字@方位"聚合成摘要行：
 * 远处的信息不该只剩一个 "+N more"。按数量降序。
 */
export function summarizeOmitted(
  items: ReadonlyArray<{ name: string; x: number; z: number }>,
  feet: { x: number; z: number },
  top = SUMMARY_LINES,
): string[] {
  const groups = new Map<string, { name: string; dir: string; count: number }>();
  for (const item of items) {
    const dir = compassOf(item.x - feet.x, item.z - feet.z);
    const key = `${item.name}@${dir}`;
    const found = groups.get(key);
    if (found) found.count++;
    else groups.set(key, { name: item.name, dir, count: 1 });
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir),
  );
  const lines = sorted.slice(0, top).map((g) => `${g.name}×${g.count} ${g.dir}`);
  // 被 top 挡掉的组要留个记号：远端信息可以粗，但不能悄悄消失。
  if (sorted.length > lines.length) lines.push(`+${sorted.length - lines.length} more groups`);
  return lines;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V'] as const;

/**
 * 药水效果。mineflayer 只给 `{id, amplifier, duration}` —— **没有名字**，
 * 名字要从 mcData 的 `bot.registry.effects`（按 id 索引的对象表）查。
 * duration 是游戏刻，折算成秒。
 */
function effectsOf(bot: Record<string, unknown>, entity: Record<string, unknown>): string[] {
  const raw = entity['effects'];
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw != null && typeof raw === 'object'
      ? Object.values(raw as Record<string, unknown>)
      : [];
  const registry = (bot['registry'] ?? {}) as { effects?: Record<string, unknown> };
  const out: string[] = [];
  for (const item of list) {
    const e = item as { id?: unknown; name?: unknown; amplifier?: unknown; duration?: unknown } | null;
    if (e == null) continue;
    const id = num(e.id);
    // 优先用实体自带的 name（本版本/未来版本可能有），否则查 mcData 注册表。
    // 注册表按 id 索引，但每个条目自己也带 id——对不上就线性找一遍，
    // 免得因为 id 基准（0 基 vs 1 基）不一致而默默报错名字。
    let entry = id != null ? (registry.effects?.[String(id)] as { id?: unknown; displayName?: unknown; name?: unknown } | undefined) : undefined;
    if (entry != null && typeof entry.id === 'number' && entry.id !== id) {
      entry = Object.values(registry.effects ?? {}).find(
        (value) => (value as { id?: unknown } | null)?.id === id,
      ) as typeof entry;
    }
    const name =
      str(e.name) ?? str(entry?.displayName) ?? str(entry?.name) ?? (id != null ? `effect#${id}` : null);
    if (name == null) continue;
    const amplifier = num(e.amplifier);
    // 协议里 amplifier 0 = I 级，所以罗马数字下标就是 amplifier 本身。
    const level =
      amplifier != null && amplifier >= 0 ? ` ${ROMAN[Math.min(amplifier, ROMAN.length - 1)]}` : '';
    const ticks = num(e.duration);
    out.push(`${name}${level}${ticks != null ? ` ${Math.round(ticks / 20)}s` : ''}`);
  }
  return out;
}

/** 控制状态（潜行/疾跑），不是 pose 动画。读不到就不报。 */
function postureOf(bot: Record<string, unknown>): string | null {
  const get = bot['getControlState'] as ((control: string) => boolean) | undefined;
  if (typeof get !== 'function') return null;
  const parts: string[] = [];
  try {
    if (get.call(bot, 'sneak')) parts.push('sneaking');
  } catch {
    // 控制状态读不到就当他没潜行。
  }
  try {
    if (get.call(bot, 'sprint')) parts.push('sprinting');
  } catch {
    // 同上。
  }
  return parts.length > 0 ? parts.join('+') : null;
}

/**
 * 水平速度（格/秒）。mineflayer 的 `entity.velocity` 单位是**格/游戏刻**
 * （protocol 的 1/8000 是"每刻多少格"），所以要 ×20 才是 /秒。
 */
function speedOf(entity: Record<string, unknown>): number | null {
  const vel = (entity['velocity'] ?? {}) as { x?: unknown; z?: unknown };
  const vx = num(vel.x);
  const vz = num(vel.z);
  if (vx == null || vz == null) return null;
  return Math.round(Math.hypot(vx, vz) * 20 * 100) / 100;
}

/** 明细行的 token 粗估，用于预算封顶（口径与 compaction 一致）。 */
function entityCost(e: LiveEntity): number {
  return estimateTokens(`- ${e.name}#${e.id} ${e.distance}m (${e.x},${e.y},${e.z}) hp ${e.health ?? ''}`);
}

function blockCost(b: LiveBlock): number {
  return estimateTokens(`- ${b.name} ${b.distance}m (${b.x},${b.y},${b.z})`);
}

export interface SampleContext {
  /** mineflayer bot 无类型，采样时全部防御性读取 */
  bot: any;
  vision?: any;
  goal?: string | null;
  todos?: PlanTodo[];
  currentAction?: string | null;
  now?: () => number;
}

/**
 * 采一次快照。bot 是 mineflayer bot（字段全部防御性读取），
 * vision 是 VisionInterpreter（读 lastScreenshot，可空）。
 */
export function sampleLiveState(ctx: SampleContext): LiveState {
  const now = ctx.now ?? Date.now;
  const bot = ctx.bot ?? {};
  const empty: LiveState = {
    body: {
      health: null,
      food: null,
      saturation: null,
      oxygen: null,
      xpLevel: null,
      xpProgress: null,
      pose: null,
      onGround: null,
      effects: [],
    },
    held: { mainHand: null, offHand: null, armor: [], mainHandDurability: null, mainHandDurabilityRaw: null },
    backpack: { freeSlots: null, items: [] },
    position: { x: null, y: null, z: null, yaw: null, pitch: null, dimension: null, biome: null, speed: null },
    environment: { timeOfDay: null, weather: 'Unknown', light: null, lightConfidence: 'unknown', day: null },
    entities: [],
    entitiesTruncated: 0,
    entitiesSummary: [],
    blocks: [],
    blocksTruncated: 0,
    blocksSummary: [],
    screenshot: { ref: null, unavailableReason: 'no vision data yet' },
    goal: ctx.goal ?? null,
    todos: ctx.todos ?? [],
    dangerousOps: '（还没采样）',
    safeguards: '（还没采样）',
    meta: { gamemode: null, openScreen: null, currentAction: ctx.currentAction ?? null, posture: null },
  };

  try {
    const entity = bot.entity ?? {};
    const pos = entity.position ?? {};
    const feet = { x: Math.floor(num(pos.x) ?? 0), y: Math.floor(num(pos.y) ?? 0), z: Math.floor(num(pos.z) ?? 0) };

    empty.body = {
      health: num(bot.health),
      food: num(bot.food),
      saturation: num(bot.foodSaturation),
      oxygen: num(bot.oxygenLevel),
      xpLevel: num(bot.experience?.level),
      xpProgress: num(bot.experience?.progress),
      pose: poseOf(entity as Record<string, unknown>),
      onGround: typeof entity.onGround === 'boolean' ? entity.onGround : null,
      effects: effectsOf(bot, entity as Record<string, unknown>),
    };

    const slots: unknown[] = Array.isArray(bot.inventory?.slots) ? bot.inventory.slots : [];
    const slotName = (i: number): string | null => {
      const s = slots[i] as { name?: unknown; count?: unknown } | undefined;
      const n = str(s?.name);
      if (n == null) return null;
      const c = num(s?.count) ?? 1;
      return `${n}x${c}`;
    };
    const heldItem = bot.heldItem as
      | { name?: unknown; count?: unknown; durabilityUsed?: unknown; maxDurability?: unknown }
      | undefined;
    const usedDurability = num(heldItem?.durabilityUsed);
    const maxDurability = num(heldItem?.maxDurability);
    empty.held = {
      mainHand: heldItem ? `${str(heldItem.name) ?? 'unknown'}x${num(heldItem.count) ?? 1}` : null,
      offHand: slotName(45),
      armor: [slotName(8), slotName(7), slotName(6), slotName(5)].filter(
        (s): s is string => s != null && s !== 'null',
      ),
      mainHandDurability: durabilityFraction(usedDurability, maxDurability),
      mainHandDurabilityRaw:
        usedDurability != null || maxDurability != null
          ? `used=${usedDurability ?? '?'} max=${maxDurability ?? '?'}`
          : null,
    };

    const packItems: string[] = [];
    let free = 0;
    // **快捷栏（36-44）也要列出来**。原来只扫 9~35，模型看不见快捷栏里的东西，
    // 于是"背包里明明有火把/镐"却报"没有"——两个模型各自做了对照实验钉死这条：
    // 同一份 input，材料在主背包就成功、在快捷栏就失败（`torch×2` 在快捷栏却报
    // `Don't have any torch to place`；`coal, stick` 在主背包直接产出 `torch×4`）。
    // 当前手持那格前面标 `*`，免得模型再靠猜。
    const heldSlot = Number((bot as { quickBarSlot?: unknown }).quickBarSlot);
    const heldIndex = Number.isFinite(heldSlot) ? 36 + heldSlot : -1;
    for (let i = 9; i <= 44; i++) {
      const n = slotName(i);
      if (n == null) free++;
      else packItems.push(`${i === heldIndex ? '*' : ''}[${i}]${n}`);
    }
    empty.backpack = {
      freeSlots: Array.isArray(bot.inventory?.slots) ? free : null,
      items: packItems,
    };

    empty.position = {
      x: num(pos.x),
      y: num(pos.y),
      z: num(pos.z),
      yaw: num(entity.yaw),
      pitch: num(entity.pitch),
      dimension: str(bot.game?.dimension),
      biome: biomeOf(bot, feet),
      speed: speedOf(entity as Record<string, unknown>),
    };

    empty.environment = {
      timeOfDay: num(bot.time?.timeOfDay),
      weather: weatherOf(bot),
      ...lightOf(bot, feet),
      day: num(bot.time?.day),
    };

    const seen = sampleEntities(bot, feet);
    empty.entities = budgetedList(seen, PERCEPTION_LIMIT, PERCEPTION_BUDGET_TOKENS, entityCost);
    empty.entitiesTruncated = Math.max(0, seen.length - empty.entities.length);
    empty.entitiesSummary = summarizeOmitted(seen.slice(empty.entities.length), feet);

    const found = sampleBlocks(bot, feet);
    empty.blocks = budgetedList(found, PERCEPTION_LIMIT, PERCEPTION_BUDGET_TOKENS, blockCost);
    empty.blocksTruncated = Math.max(0, found.length - empty.blocks.length);
    empty.blocksSummary = summarizeOmitted(found.slice(empty.blocks.length), feet);

    empty.screenshot = screenshotOf(ctx.vision);

    // 危险操作许可：库里的单例是唯一真相，快照只负责转述。
    empty.dangerousOps = permits.describe(Date.now());
    empty.safeguards = safeguards.describe(Date.now());
    empty.meta = {
      gamemode: str(bot.game?.gameMode),
      openScreen: bot.currentWindow != null ? (str(bot.currentWindow?.title) ?? 'open') : null,
      currentAction: ctx.currentAction ?? null,
      posture: postureOf(bot),
    };
  } catch {
    // 半截快照也照常返回：调用方看到的是 null/unknown，而不是一次异常。
  }
  return empty;
}

/** pose 在实体元数据里的下标（mcData: player/zombie/armor_stand 的 metadataKeys[6] === 'pose'）。 */
const POSE_METADATA_INDEX = 6;
/**
 * 协议里的 pose 枚举（1.20.5+），按协议顺序书写。越界就退化成编号，
 * 不假装知道——本地 mcData 里 `pose` 只是 varint，没有可核对的枚举名，
 * 所以这里只影响可读性，不影响任何检测器。
 */
const POSE_NAMES = [
  'standing',
  'fall_flying',
  'sleeping',
  'swimming',
  'spin_attack',
  'sneaking',
  'long_jumping',
  'dying',
  'croaking',
  'using_tongue',
  'sitting',
  'roaring',
  'sniffing',
  'emerging',
  'digging',
] as const;

/**
 * 姿势名。mineflayer **不往实体上写 `pose` 字段**，真值在**元数据第 6 项**
 * （实体是 prismarine-entity 实例，`metadata` 初始化为数组，mineflayer 用数字
 * 下标往里写，所以 `Array.isArray` 成立）。
 */
function poseOf(entity: Record<string, unknown>): string | null {
  const meta = entity['metadata'];
  if (!Array.isArray(meta)) return null;
  const raw = meta[POSE_METADATA_INDEX] as { value?: unknown } | number | undefined;
  const value = typeof raw === 'number' ? raw : (raw as { value?: unknown } | undefined)?.value;
  const idx = num(value);
  if (idx == null) return null;
  return POSE_NAMES[idx] ?? `pose#${idx}`;
}

function weatherOf(bot: Record<string, unknown>): LiveEnvironment['weather'] {
  try {
    // mineflayer 的 thunderState/rainState 是**数字**等级（rain.js 初值 0，
    // 由 game_state_change 的 gameMode 赋值），不是布尔。
    const w = bot as { thunderState?: unknown; rainState?: unknown; isRaining?: unknown };
    if ((num(w.thunderState) ?? 0) > 0) return 'Thunderstorm';
    // rainState 只有在服务端继续下发 rain_level_change 时才回落，而 isRaining
    // 由 start_raining/stop_raining 直接维护——两个一起看才不会卡在"一直下雨"。
    const rain = w.rainState;
    if (w.isRaining === true || (num(rain) ?? 0) > 0) return 'Rain';
    if (w.isRaining === false || num(rain) === 0) return 'Clear';
    return 'Unknown';
  } catch {
    return 'Unknown';
  }
}

function lightOf(
  bot: Record<string, unknown>,
  feet: { x: number; y: number; z: number },
): Pick<LiveEnvironment, 'light' | 'lightConfidence'> {
  try {
    const blockAt = (bot as { blockAt?: (p: unknown) => unknown }).blockAt;
    if (typeof blockAt !== 'function') return { light: null, lightConfidence: 'unknown' };
    const block = blockAt.call(bot, Vec3Of(feet)) as { light?: unknown; skyLight?: unknown } | null;
    // prismarine-chunk 里 `light` 是**方块光**（火把/岩浆），`skyLight` 是**天光**，
    // 两者独立且都能是 0——露天白天就是 `light 0 / skyLight 15`，所以
    // `light ?? skyLight` 永远拿不到天光。而 chunk 里的 skyLight 不随时辰变化
    // （半夜也是 15），判断"这里暗不暗"还得看白天黑夜：夜里天光不照亮。
    const blockLight = num(block?.light);
    const skyLight = num(block?.skyLight);
    if (blockLight == null && skyLight == null) return { light: null, lightConfidence: 'unknown' };
    const sky = isNightNow(bot) ? 0 : (skyLight ?? 0);
    const light = Math.max(blockLight ?? 0, sky);
    const exposed = skyExposed(bot, feet);
    return { light, lightConfidence: exposed == null ? 'unknown' : 'high' };
  } catch {
    return { light: null, lightConfidence: 'unknown' };
  }
}

/** 是否夜里（与 edges 的 isNight 同一套阈值）。 */
function isNightNow(bot: Record<string, unknown>): boolean {
  const timeOfDay = num((bot['time'] as { timeOfDay?: unknown } | undefined)?.timeOfDay);
  return timeOfDay != null && timeOfDay >= 12542 && timeOfDay < 23460;
}

/**
 * 头顶是否露天。**读不到任何柱状数据时返回 null**（无法判断），
 * 不要像以前那样把"没数据"当成露天——那会把置信度抬到 high。
 */
function skyExposed(bot: Record<string, unknown>, feet: { x: number; y: number; z: number }): boolean | null {
  try {
    const blockAt = (bot as { blockAt?: (p: unknown) => unknown }).blockAt;
    if (typeof blockAt !== 'function') return null;
    let sawData = false;
    for (let y = 1; y <= 10; y++) {
      const above = blockAt.call(bot, Vec3Of({ x: feet.x, y: feet.y + y, z: feet.z })) as {
        name?: unknown;
        transparent?: unknown;
      } | null;
      if (above == null) continue;
      sawData = true;
      if (above.name === 'air' || above.name === 'cave_air') continue;
      if (above.transparent === true) continue;
      return false;
    }
    return sawData ? true : null;
  } catch {
    return null;
  }
}

function biomeOf(bot: Record<string, unknown>, feet: { x: number; y: number; z: number }): string | null {
  try {
    const blockAt = (bot as { blockAt?: (p: unknown) => unknown }).blockAt;
    const block = (typeof blockAt === 'function' ? blockAt.call(bot, Vec3Of(feet)) : null) as {
      biome?: { name?: unknown } | string | null;
    } | null;
    const biome = block?.biome;
    if (typeof biome === 'string') return biome;
    return str(biome?.name);
  } catch {
    return null;
  }
}

/**
 * 实体的一句话附加标注。
 *
 * **玩家标`player`**：实体的 `name` 字段对玩家存的是 username 而不是类型名
 * （见下面 sampleEntities 的注释），所以一个叫 Notch 的玩家在快照里长这样：
 * `- Notch#12 8m (...)` —— 跟`- zombie#7 3m (...)` 结构上一模一样，模型
 * 分不出这是人还是怪物。而它要决定"打不打得起"，就必须先知道那是谁。
 *
 * 村民标职业/婴儿（婴儿不能交易，没标模型会白跑一趟换交易）。
 */
function entityTag(e: Record<string, unknown>): string | undefined {
  try {
    // 玩家：`name` 恒为 'player'，身份在 `username`。自己已在上面 continue 掉了。
    if (str(e.name) === 'player') return 'player';
    if (str(e.name) !== 'villager') return undefined;
    // 判定与旧 `!entities` 逐字一致：metadata[16] === 1 是婴儿。
    const meta = e.metadata as unknown[] | null | undefined;
    if (Array.isArray(meta) && meta[16] === 1) return 'baby';
    const prof = getVillagerProfession(e);
    return typeof prof === 'string' && prof !== '' && prof !== 'Unknown' ? prof : undefined;
  } catch {
    return undefined;
  }
}

function sampleEntities(
  bot: Record<string, unknown>,
  feet: { x: number; y: number; z: number },
): LiveEntity[] {
  const out: LiveEntity[] = [];
  try {
    const entities = (bot as { entities?: Record<string, unknown> }).entities ?? {};
    const selfId = (bot as { entity?: { id?: unknown } }).entity?.id;
    for (const raw of Object.values(entities)) {
      const e = raw as {
        id?: unknown;
        name?: unknown;
        displayName?: unknown;
        kind?: unknown;
        type?: unknown;
        username?: unknown;
        position?: { x: number; y: number; z: number } | null;
        health?: unknown;
      };
      if (e == null || e.position == null || e.id === selfId) continue;
      const d = dist3(e.position.x, e.position.y, e.position.z, feet.x, feet.y, feet.z);
      if (d > PERCEPTION_RADIUS) continue;
      out.push({
        id: Number(e.id),
        // 玩家的 `name` 是类型名 'player'，身份在 `username`（mineflayer addNewPlayer）。
        // 掉落物的 `name` 是类型名 'item'，**真正的物品名在 displayName 里**。
        // 原来优先取 name，于是列表里全是 'item#85889'——模型看不出那是什么东西，pia
        // 反复问"脚边那两个吸不动的掉落物到底是什么物品"就是这个原因。
        name:
          str(e.username) ??
          (str(e.name) === 'item' ? str(e.displayName) : (str(e.name) ?? str(e.displayName))) ??
          'unknown',
        kind: str(e.kind ?? e.type),
        distance: Math.round(d * 10) / 10,
        x: e.position.x,
        y: e.position.y,
        z: e.position.z,
        // mineflayer 不给实体填 `health`（entities.js 里零命中）→ 恒为 null，
        // 渲染时会省略 `hp`。留字段是为了将来有来源时不必改结构。
        health: num(e.health),
        tag: entityTag(e as Record<string, unknown>),
      });
    }
  } catch {
    // 感知失败不影响快照其余部分。
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

/** 值得点名的方块：任务常围绕它们规划（矿物/容器/工作站/床/刷怪笼）。 */
export const KEY_BLOCKS: readonly string[] = Object.freeze([
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore',
  'copper_ore', 'deepslate_copper_ore', 'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
  'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
  'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris',
  'chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest',
  'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'enchanting_table',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'brewing_stand', 'beacon',
  'bedrock', 'spawner', 'trial_spawner', 'bed',
]);

/**
 * KEY_BLOCKS 的集合视图：热路径上每个有名字的方块都要查一次（每轮约 27 万次
 * 迭代），线性 `Array.includes` 扫 38 个字符串太浪费。对外仍导出数组，契约不变。
 */
const KEY_BLOCK_SET: ReadonlySet<string> = new Set(KEY_BLOCKS);

function sampleBlocks(
  bot: Record<string, unknown>,
  feet: { x: number; y: number; z: number },
): LiveBlock[] {
  const out: LiveBlock[] = [];
  try {
    const blockAt = (bot as { blockAt?: (p: unknown) => unknown }).blockAt;
    if (typeof blockAt !== 'function') return out;
    const r = Math.ceil(PERCEPTION_RADIUS);
    const r2 = PERCEPTION_RADIUS * PERCEPTION_RADIUS;
    // 剪枝（只跳过"必然会被最后那行 `d <= PERCEPTION_RADIUS` 丢掉"的迭代）：
    // 判据用 `r2 + MARGIN` 的余量，把浮点误差也考虑进去，所以 out 的内容与
    // 顺序逐位不变——模型看到的东西完全一样，只是少查了球外的 blockAt。
    const MARGIN = 1;
    for (let x = feet.x - r; x <= feet.x + r; x++) {
      const dx = x - feet.x;
      for (let z = feet.z - r; z <= feet.z + r; z++) {
        const dz = z - feet.z;
        const rem = r2 - dx * dx - dz * dz;
        // 这一列的所有 y 都在球外（连余量都补不回来）。
        if (rem < -MARGIN) continue;
        for (let y = feet.y - r; y <= feet.y + r; y++) {
          const dy = y - feet.y;
          // 这个 y 也在球外。
          if (dy * dy > rem + MARGIN) continue;
          let block: { name?: unknown } | null = null;
          try {
            block = blockAt.call(bot, Vec3Of({ x, y, z })) as { name?: unknown } | null;
          } catch {
            block = null;
          }
          const name = str(block?.name);
          if (name == null || !KEY_BLOCK_SET.has(name)) continue;
          const d = dist3(x, y, z, feet.x, feet.y, feet.z);
          if (d <= PERCEPTION_RADIUS) out.push({ name, distance: Math.round(d * 10) / 10, x, y, z });
        }
      }
    }
  } catch {
    // 同上，失败不牵连。
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

function screenshotOf(vision: unknown): LiveScreenshot {
  try {
    const v = vision as { lastScreenshot?: unknown } | null | undefined;
    const last = v?.lastScreenshot as { file?: unknown; takenAt?: unknown } | null | undefined;
    if (last != null && typeof last.file === 'string' && typeof last.takenAt === 'number') {
      return { ref: { file: last.file, takenAt: last.takenAt }, unavailableReason: null };
    }
    if (v == null) return { ref: null, unavailableReason: 'vision disabled' };
    return { ref: null, unavailableReason: 'no screenshot taken yet' };
  } catch {
    return { ref: null, unavailableReason: 'vision unreadable' };
  }
}

const UNKNOWN = 'unknown';

/**
 * 把逐格清单聚成"我总共有几个"：`[12]oak_logx16` + `[9]oak_logx4` → `oak_logx20`。
 *
 * 旧 `!inventory` 给的正是这个聚合（模型问"我有几个木头"时，让它把 36 格
 * 心算一遍是找错）。搬进快照后那个工具再无独有价值。
 * 名字里出现 `x数字` 只在末尾认一次（mc 物品名不会以 x+数字结尾）。
 */
export function aggregateTotals(items: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const raw of items) {
    const m = /^(?:\*)?\[\d+\](.+?)x(\d+)$/.exec(raw);
    if (m == null) continue;
    const name = m[1];
    const count = Number(m[2]);
    if (typeof name !== 'string' || !Number.isFinite(count)) continue;
    counts.set(name, (counts.get(name) ?? 0) + count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name}x${count}`);
}

/**
 * 快照的段落名。`stats(type=…)` 就是按它挑"要看哪一方面"——
 * 段落是**同一份采样**的不同切面，不存在第二套数据。
 */
export const LIVE_SECTION_KEYS = [
  'body', 'ops', 'held', 'backpack', 'position', 'environment',
  'entities', 'blocks', 'screenshot', 'goal', 'meta',
] as const;

export type LiveSectionKey = (typeof LIVE_SECTION_KEYS)[number];

/** 每段渲成若干行：有的段有附带行（backpack 的 totals、entities 的 farther merged）。 */
const SECTION_RENDERERS: Record<LiveSectionKey, (s: LiveState) => string[]> = {
  body: (s) => {
    const b = s.body;
    // oxygen 故意不显示：mineflayer 的 oxygenLevel 在 1.20.6 上取不到 air_supply，
    // 会出现 -1、"干燥洞窟里 0"这种不可能的读数（模型真机报过），摆出来只会误导判断。
    // 水下安全改用 submerged（头+脚都是水）那条独立信号。
    return [
      `Body: health ${b.health ?? UNKNOWN} food ${b.food ?? UNKNOWN} saturation ${b.saturation ?? UNKNOWN} ` +
        `xp ${b.xpLevel ?? UNKNOWN} pose ${b.pose ?? UNKNOWN} ` +
        `onGround ${b.onGround ?? UNKNOWN} effects ${b.effects.length > 0 ? b.effects.join(', ') : 'none'}`,
    ];
  },
  // 危险操作许可：默认全禁，要用得先授权。**必须让模型看得见**——否则
  // 它不知道自己现在能不能倒水/点火，只能靠"试一下被拒"来发现，那是最贵的发现方式。
  ops: (s) => [`DangerousOps: ${s.dangerousOps}`, `Safeguards: ${s.safeguards}`],
  held: (s) => {
    const h = s.held;
    return [
      `Held: main ${h.mainHand ?? 'empty'}${h.mainHandDurability != null ? ` (耐久剩余 ${Math.round(h.mainHandDurability * 100)}%${h.mainHandDurabilityRaw != null ? `，原始 ${h.mainHandDurabilityRaw}` : ''})` : ''} ` +
        `off ${h.offHand ?? 'empty'} armor ${h.armor.length > 0 ? h.armor.join('/') : 'none'}`,
    ];
  },
  backpack: (s) => {
    const lines = [
      `Backpack (free ${s.backpack.freeSlots ?? UNKNOWN}): ${s.backpack.items.length > 0 ? s.backpack.items.join(', ') : 'empty'}`,
    ];
    const totals = aggregateTotals(s.backpack.items);
    if (totals.length > 0) lines.push(`- totals: ${totals.join(', ')}`);
    return lines;
  },
  position: (s) => {
    const p = s.position;
    return [
      `Position (此刻): ${p.x ?? UNKNOWN},${p.y ?? UNKNOWN},${p.z ?? UNKNOWN} facing yaw ${p.yaw ?? UNKNOWN} pitch ${p.pitch ?? UNKNOWN} ` +
        `speed ${p.speed ?? UNKNOWN} dimension ${p.dimension ?? UNKNOWN} biome ${p.biome ?? UNKNOWN}`,
    ];
  },
  environment: (s) => {
    const e = s.environment;
    return [
      `Environment: day ${e.day ?? UNKNOWN} time ${e.timeOfDay ?? UNKNOWN} weather ${e.weather} light ${e.light ?? UNKNOWN} (confidence ${e.lightConfidence})`,
    ];
  },
  entities: (s) => {
    const head = `Nearby entities (within ${PERCEPTION_RADIUS}: ${s.entities.length}${s.entitiesTruncated > 0 ? `+${s.entitiesTruncated} more` : ''})`;
    const lines = [
      `${head}:\n${s.entities.map((x) => `- ${x.name}#${x.id} ${x.distance}m (${x.x},${x.y},${x.z})${x.health != null ? ` hp ${x.health}` : ''}${x.tag != null ? ` (${x.tag})` : ''}`).join('\n') || 'none'}`,
    ];
    if (s.entitiesSummary.length > 0) {
      lines.push(`- farther (merged): ${s.entitiesSummary.join(', ')}`);
    }
    return lines;
  },
  blocks: (s) => {
    const head = `Nearby key blocks (within ${PERCEPTION_RADIUS}: ${s.blocks.length}${s.blocksTruncated > 0 ? `+${s.blocksTruncated} more` : ''})`;
    const lines = [
      `${head}:\n${s.blocks.map((x) => `- ${x.name} ${x.distance}m (${x.x},${x.y},${x.z})`).join('\n') || 'none'}`,
    ];
    if (s.blocksSummary.length > 0) {
      lines.push(`- farther (merged): ${s.blocksSummary.join(', ')}`);
    }
    return lines;
  },
  screenshot: (s) => {
    if (s.screenshot.ref != null) {
      const age = Date.now() - s.screenshot.ref.takenAt;
      return [`Screenshot: ${s.screenshot.ref.file} (taken ${Math.max(0, Math.round(age / 1000))}s ago)`];
    }
    return [`Screenshot: none (${s.screenshot.unavailableReason ?? UNKNOWN})`];
  },
  goal: (s) => [
    `Goal: ${s.goal ?? 'none'} Todos: ${
      s.todos.length > 0 ? s.todos.map((t) => `${t.done ? '✓' : '○'}${t.text}`).join('; ') : 'none'
    }`,
  ],
  meta: (s) => [
    `Meta: gamemode ${s.meta.gamemode ?? UNKNOWN} screen ${s.meta.openScreen ?? 'none'} ` +
      `action ${s.meta.currentAction ?? 'idle'} posture ${s.meta.posture ?? 'standing'}`,
  ],
};

/** 只渲指定段落（`stats(type=…)` 用）。顺序以 `keys` 为准。 */
export function renderSections(s: LiveState, keys: readonly LiveSectionKey[]): string {
  const lines: string[] = [];
  for (const key of keys) lines.push(...SECTION_RENDERERS[key](s));
  return lines.join('\n');
}

/** 把快照渲成追加在请求末尾的文本块（放最后，不破坏前缀缓存）。 */
export function renderLiveState(s: LiveState): string {
  return renderSections(s, LIVE_SECTION_KEYS);
}

export default {
  sampleLiveState,
  renderLiveState,
  renderSections,
  aggregateTotals,
  compassOf,
  budgetedList,
  summarizeOmitted,
  PERCEPTION_RADIUS,
  PERCEPTION_LIMIT,
  PERCEPTION_BUDGET_TOKENS,
  SUMMARY_LINES,
  KEY_BLOCKS,
};
