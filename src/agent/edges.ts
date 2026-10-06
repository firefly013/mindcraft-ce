/*
 * 边沿触发事件检测：条件从 false 变 true 的那一刻发一次，
 * 直到复位条件成立才能再发。不是传统节流（N 秒最多一次），
 * 而是一次性脉冲——持续满足条件期间不再重复。
 *
 * 为什么是边沿而不是电平：Live State 每请求都带当前值，
 * 事件只负责"刚刚变了什么、当时在做什么"。每 tick 都在
 * 算条件，只在跳变时产生事件，事件系统就不会被洪水淹没。
 *
 * 滞回（双阈值）防边界抖动：比如 32 格进入、40 格才复位，
 * 中间 8 格是缓冲区。按 key 独立 armed（每个实体/玩家/
 * 物品槽各记各的），key 消失（实体死了）就静默解 armed，
 * 下次再出现重新算。
 *
 * 离散事件（聊天、伤害、工具返回）天然就是脉冲，用消息 ID
 * 去重即可，不需要 armed。
 */

import { LEVEL } from './scheduler.js';
import type { Level } from './scheduler.js';
import { ALWAYS_HOSTILE } from './emergency.js';
import { durabilityFraction } from './live_state.js';
import { Vec3 } from 'vec3';

/** 检测器看到的拍平快照（由调用方从 LiveState 等拼出来）。 */
export interface EdgeEntity {
  id: number;
  name: string;
  kind?: string | null;
  distance?: number | null;
  hostile?: boolean | null;
  isPlayer?: boolean | null;
  health?: number | null;
  swelling?: boolean | null;
  primed?: boolean | null;
  heldWeapon?: boolean | null;
  lockedOn?: boolean | null;
}

export interface HeldSlot {
  slot: number | string;
  /** 剩余耐久比例 0~1。 */
  fraction?: number | null;
  /** 手上这件东西的名字（`durability_low` 要告诉模型是哪件快坏了）。 */
  item?: string;
}

export interface EdgeSnapshot {
  health?: number | null;
  food?: number | null;
  oxygen?: number | null;
  light?: number | null;
  freeSlots?: number | null;
  foodCount?: number | null;
  entities?: EdgeEntity[];
  heldSlots?: HeldSlot[];
  isNight?: boolean | null;
  isThunder?: boolean | null;
  isRain?: boolean | null;
  dimension?: string | null;
  biome?: string | null;
  alive?: boolean | null;
  inLava?: boolean | null;
  belowVoid?: boolean | null;
  inWater?: boolean | null;
  /** 头也在水里（真正淹没）——不依赖坏掉的 oxygenLevel。 */
  submerged?: boolean | null;
  onFire?: boolean | null;
  fallLethal?: boolean | null;
  trapped?: boolean | null;
  nextIsLava?: boolean | null;
  moving?: boolean | null;
  currentAction?: string | null;
  goal?: string | null;
  position?: string | null;
}

export interface EdgeEvent {
  type: string;
  /** 边沿等级 1~5（经 schedulerLevelFor 换算成调度等级）。 */
  level: number;
  key: string | number | null;
  delta: Record<string, unknown>;
  actionContext: {
    currentAction: string | null;
    goal: string | null;
    position: string | null;
    dimension: string | null;
  } | null;
}

type DetectorKind = 'flag' | 'all' | 'keyed' | 'change';

export interface Detector {
  type: string;
  level: number;
  kind: DetectorKind;
  flag?: string;
  fire?: (s: EdgeSnapshot, key?: string | number | null) => boolean;
  clear?: (s: EdgeSnapshot, key?: string | number | null) => boolean;
  keyOf?: (s: EdgeSnapshot) => Array<string | number>;
  value?: (s: EdgeSnapshot) => unknown;
  fireOn?: (prev: unknown, next: unknown) => boolean;
}

/** 边沿等级换算成调度等级。 */
export function schedulerLevelFor(edgeLevel: number): Level {
  if (edgeLevel >= 5) return LEVEL.EMERGENCY;
  if (edgeLevel === 4) return LEVEL.PREEMPT;
  if (edgeLevel === 3) return LEVEL.WAKE;
  return LEVEL.STATE;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 有值且 <= 阈值（缺值不触发——没读数不算数）。 */
function lte(value: unknown, t: number): boolean {
  const n = num(value);
  return n != null && n <= t;
}

/** 有值且 >= 阈值。 */
function gte(value: unknown, t: number): boolean {
  const n = num(value);
  return n != null && n >= t;
}

/** 有值且 < 阈值。 */
function lt(value: unknown, t: number): boolean {
  const n = num(value);
  return n != null && n < t;
}

/** 有值且 > 阈值。 */
function gt(value: unknown, t: number): boolean {
  const n = num(value);
  return n != null && n > t;
}

/** 指定 id 的实体在快照里且距离有值，返回距离，否则 null。 */
function distOf(snapshot: EdgeSnapshot, id: string | number | null | undefined): number | null {
  const target = (snapshot.entities ?? []).find((e) => e.id === id);
  return num(target?.distance);
}

/** 实体 id 还在快照里且距离 <= r。 */
function within(snapshot: EdgeSnapshot, id: string | number | null | undefined, r: number): boolean {
  const d = distOf(snapshot, id);
  return d != null && d <= r;
}

function isPlayerEntity(e: EdgeEntity): boolean {
  return e.isPlayer === true || String(e.kind ?? '').toLowerCase() === 'player';
}

function isHostileEntity(e: EdgeEntity): boolean {
  if (e.hostile === true) return true;
  if (e.hostile === false) return false;
  return ALWAYS_HOSTILE.has(String(e.name ?? '').toLowerCase());
}

/** 快照里的敌对生物（玩家不算）。 */
function hostiles(snapshot: EdgeSnapshot): EdgeEntity[] {
  return (snapshot.entities ?? []).filter((e) => isHostileEntity(e) && !isPlayerEntity(e));
}

/**
 * 某种敌对生物在快照里的距离列表。
 *
 * 用于**按类型**做边缘的检测器（`entity.hostile_far`）：同一种怪无论有几只、
 * 走到哪个距离，都算同一个 key。这样"远处有僵尸"只报一次，而不是每只僵尸
 * 各报一次。
 */
function hostilesIn(snapshot: EdgeSnapshot, name: string | number | null | undefined): number[] {
  const target = String(name ?? '');
  const out: number[] = [];
  for (const e of hostiles(snapshot)) {
    if (String(e.name ?? 'unknown') !== target) continue;
    const d = num(e.distance);
    if (d != null) out.push(d);
  }
  return out;
}

/** 敌对生物的类型集合，作为按类型边缘的 key 列表。 */
function hostileTypeKeys(snapshot: EdgeSnapshot): string[] {
  return [...new Set(hostiles(snapshot).map((e) => String(e.name ?? 'unknown')))];
}

/** 苦力怕起爆方向在实体元数据里的下标（minecraft-data: creeper.metadataKeys[16] = swell_dir）。 */
export const CREEPER_SWELL_DIR_INDEX = 16;

/** 实体朝向与"指向 bot"的方向差在这个弧度内，就算盯着 bot（30°）。 */
export const LOCK_ON_RADIANS = (30 * Math.PI) / 180;

const TWO_PI = Math.PI * 2;

/**
 * 从 from 看向 to 时的 **mineflayer 朝向（弧度）**。
 *
 * mineflayer 的 `entity.yaw` 是弧度，内部约定 0=北(-Z)、π=南(+Z)：
 * `conversions.fromNotchianYaw(y) = euclideanMod(PI - toRadians(y), 2π)`。
 * 这里直接把"从实体指向 bot"的方向换算成同一套弧度——不要和 notchian
 * 的角度（0=南、90=西）混用，那是另一套坐标系，混用会让判定与朝向无关。
 */
export function lockOnYaw(fromX: number, fromZ: number, toX: number, toZ: number): number {
  const rad = Math.PI + Math.atan2(toX - fromX, toZ - fromZ);
  return ((rad % TWO_PI) + TWO_PI) % TWO_PI;
}

/** 两个弧度角之间的最小夹角（0~π），处理绕圈。 */
export function facingDelta(a: number, b: number): number {
  return Math.abs(((((a - b) % TWO_PI) + 3 * Math.PI) % TWO_PI) - Math.PI);
}

/**
 * 手里的东西算不算武器：剑、斧（不含镐）、三叉戟、弓、弩、重锤。
 * 比 skills.ts 挑近战武器时用的判据更宽（那边只认剑/斧）——这里是
 * "对方是否持有威胁性武器"，远程也算。
 */
export function isWeaponItem(name: unknown): boolean {
  const n = typeof name === 'string' ? name.toLowerCase() : '';
  if (n === '') return false;
  if (n.includes('sword')) return true;
  if (n.includes('axe') && !n.includes('pickaxe')) return true;
  return n === 'trident' || n === 'bow' || n === 'crossbow' || n === 'mace';
}

/** 读实体元数据第 index 项（mineflayer 既可能是裸数字也可能是 {value}）。 */
function metadataValue(entity: unknown, index: number): number | null {
  const meta = (entity as { metadata?: unknown } | null | undefined)?.metadata;
  if (!Array.isArray(meta)) return null;
  const raw = meta[index] as { value?: unknown } | number | undefined;
  const value = typeof raw === 'number' ? raw : (raw as { value?: unknown } | undefined)?.value;
  return num(value);
}

/**
 * 检测器表。level 是默认值（resolvePriority 会按快照动态升降），
 * attention 说明模型为什么要在意——跟事件走，不进 Live State。
 */
export const DETECTORS: readonly Detector[] = Object.freeze([
  // L5 保命（host 侧读布尔旗，边沿+分级在这里）。
  { type: 'world.lava.contact', level: 5, kind: 'flag', flag: 'inLava' },
  {
    type: 'world.lava.about_to_enter', level: 5, kind: 'all',
    fire: (s) => s.nextIsLava === true && s.moving === true,
    clear: (s) => s.nextIsLava !== true || s.moving !== true,
  },
  { type: 'world.void.falling', level: 5, kind: 'flag', flag: 'belowVoid' },
  { type: 'world.water.drowning', level: 5, kind: 'all',
    // **不看 oxygen**：那个字段在 1.20.6 上恒为 20（mineflayer 取不到 air_supply），
    // 用它做条件等于永不触发。改用"头+脚都在水里"这个可靠信号。
    fire: (s) => s.submerged === true,
    clear: (s) => s.submerged !== true },
  { type: 'world.fire.burning_low_hp', level: 5, kind: 'all',
    fire: (s) => s.onFire === true && lt(s.health, 6),
    clear: (s) => s.onFire !== true },
  { type: 'world.fall.lethal', level: 5, kind: 'flag', flag: 'fallLethal' },
  { type: 'world.trapped.low_hp', level: 5, kind: 'all',
    fire: (s) => s.trapped === true && lt(s.health, 4),
    clear: (s) => s.trapped !== true },
  {
    type: 'world.tnt.primed_nearby', level: 5, kind: 'keyed',
    keyOf: (s) => (s.entities ?? []).filter((e) => e.primed === true).map((e) => e.id),
    fire: (s, id) => within(s, id, 3),
    clear: (s, id) => !within(s, id, 6) || !(s.entities ?? []).some((e) => e.id === id && e.primed === true),
  },
  {
    type: 'world.creeper.swelling', level: 5, kind: 'keyed',
    keyOf: (s) => (s.entities ?? []).filter((e) => e.swelling === true).map((e) => e.id),
    fire: (s, id) => within(s, id, 3),
    clear: (s, id) => !(s.entities ?? []).some((e) => e.id === id && e.swelling === true),
  },
  // L3/L2 阈值。
  { type: 'bot.health_low', level: 3, kind: 'all',
    fire: (s) => lte(s.health, 6),
    clear: (s) => gte(s.health, 12) },
  { type: 'bot.health_danger', level: 3, kind: 'all',
    fire: (s) => lte(s.health, 3),
    clear: (s) => gte(s.health, 6) },
  { type: 'bot.hunger_low', level: 3, kind: 'all',
    fire: (s) => lte(s.food, 6),
    clear: (s) => gte(s.food, 12) },
  { type: 'bot.oxygen_low', level: 3, kind: 'all',
    fire: (s) => lte(s.oxygen, 5),
    clear: (s) => gte(s.oxygen, 15) },
  {
    // 「身边有敌对生物」是**一类事实**，不是"第 14500 号僵尸"。
    // 和 `hostile_far` 同样的毛病：按实体 id 做边缘，一晚上能报十几条，
    // 每只走到 32 格内的怪各报一次（真机日志里就是这样刷屏的）。
    // 按**类型**做边缘：这种怪进了 32 格报一次，全部离开 40 格才解除。
    type: 'entity.hostile_nearby', level: 3, kind: 'keyed',
    keyOf: (s) => hostileTypeKeys(s),
    fire: (s, name) => hostilesIn(s, name).some((d) => d <= 32),
    clear: (s, name) => !hostilesIn(s, name).some((d) => d <= 40),
  },
  {
    // 「远处有敌对生物」是**一类事实**，不是"第 1401 号僵尸"。
    // 按实体 id 做边缘的话，站在夜里一分钟能报十几条——每只走到 32~64 格的
    // 怪都各报一次，日志里就是这样刷屏的。模型要看具体的谁，Live State 里
    // 本来就有带 id 和距离的实体表。
    //
    // 所以按**类型**做边缘：这种怪进了 32~64 报一次；它（们）全部离开 64
    // 才解除 arm；之后再进来才会再报。
    type: 'entity.hostile_far', level: 2, kind: 'keyed',
    keyOf: (s) => hostileTypeKeys(s),
    fire: (s, name) => hostilesIn(s, name).some((d) => d > 32 && d <= 64),
    clear: (s, name) => !hostilesIn(s, name).some((d) => d <= 64),
  },
  {
    type: 'player.nearby', level: 3, kind: 'keyed',
    keyOf: (s) => (s.entities ?? []).filter((e) => isPlayerEntity(e)).map((e) => e.id),
    fire: (s, id) => within(s, id, 5),
    clear: (s, id) => !within(s, id, 8),
  },
  { type: 'world.night_start', level: 3, kind: 'all',
    fire: (s) => s.isNight === true, clear: (s) => s.isNight !== true },
  { type: 'world.day_start', level: 2, kind: 'all',
    fire: (s) => s.isNight === false, clear: (s) => s.isNight !== false },
  { type: 'world.thunder_start', level: 3, kind: 'all',
    fire: (s) => s.isThunder === true, clear: (s) => s.isThunder !== true },
  { type: 'world.rain_start', level: 2, kind: 'all',
    fire: (s) => s.isRain === true, clear: (s) => s.isRain !== true },
  { type: 'world.light_low', level: 3, kind: 'all',
    // 迟滞带放宽：原来是 4/8，在洞里走动时光照在 4~8 之间来回跳，边缘反复
    // re-arm——真机日志里每 2 秒报一次。放宽到 3/12 让"进洞"只报一次。
    fire: (s) => lte(s.light, 3),
    clear: (s) => gte(s.light, 12) },
  { type: 'world.dimension_change', level: 3, kind: 'change',
    value: (s) => s.dimension ?? null, fireOn: (prev, next) => prev != null && next != null && prev !== next },
  { type: 'world.biome_change', level: 2, kind: 'change',
    value: (s) => s.biome ?? null, fireOn: (prev, next) => prev != null && next != null && prev !== next },
  { type: 'inventory.full', level: 3, kind: 'all',
    fire: (s) => num(s.freeSlots) === 0,
    clear: (s) => gt(s.freeSlots, 0) },
  // 「背包里没吃的了」——**不是**饥饿值低。模型反馈过这条：事件名
  // `inventory.food_low` 配 `{foodCount: 0}` 读起来像"快饿死了"，而同一轮
  // 快照显示 `food 20`（饥饿值是满的），于是它误判。
  // 改名说清数的是**物品数量**，并把饥饿值一并带上，两者不会再混。
  { type: 'inventory.food_items_low', level: 3, kind: 'all',
    fire: (s) => lte(s.foodCount, 8),
    clear: (s) => gte(s.foodCount, 12) },
  {
    type: 'tool.durability_low', level: 3, kind: 'keyed',
    // key 固定是 `hand`，**不能**用 `heldSlots` 推导：手上一换成没有耐久的东西
    // （空手、方块、食物），key 就从快照里消失、armed 被静默解除，再换回那把
    // 旧镐子就又报一次。砍树/合成时反复切工具，90 秒能报 5 次——而它是 L3，
    // 每次都拉起一次完整请求。
    // 边缘应该跟着"耐久恢复"走：`clear` 才是解除条件。
    keyOf: () => ['hand'],
    fire: (s) => (s.heldSlots ?? []).some((h) => h.slot === 'hand' && lte(h.fraction, 0.1)),
    // 解除条件必须是"手上真的拿着一件**健康**的耐用品"（>30%）。
    // 写成 `!low` 是不行的：空手/方块/食物会让它立刻为真，切一次工具就解除一次，
    // 于是每换回那把旧镐子又报一遍。
    clear: (s) => (s.heldSlots ?? []).some((h) => h.slot === 'hand' && !lte(h.fraction, 0.3)),
  },
  { type: 'agent.death', level: 4, kind: 'all',
    fire: (s) => s.alive === false, clear: (s) => s.alive !== false },
  { type: 'agent.respawn', level: 3, kind: 'change',
    value: (s) => s.alive ?? null, fireOn: (prev, next) => prev === false && next === true },
]);

/** 聊天里的急停词：提到它们视为 L4 抢占（与 resolvePriority 同表）。 */
export const STOP_WORDS: readonly string[] = Object.freeze(['停', '别动', '危险', '救命', 'stop']);

export interface PriorityDescriptor {
  type: string;
  level: number;
  key?: string | number | null;
  text?: string;
  tool?: string | null;
  sideEffect?: boolean;
  retryable?: boolean;
}

/**
 * 默认等级只是起点，快照决定最终等级。
 */
export function resolvePriority(descriptor: PriorityDescriptor, snapshot: EdgeSnapshot = {}): number {
  const { type } = descriptor;
  const hp = num(snapshot.health);
  if (type === 'entity.hostile_nearby') {
    // key 是**类型**（和边缘一致），所以按类型找最近的那只——不能再拿它当实体 id 用。
    const name = String(descriptor.key ?? '');
    const dists = hostilesIn(snapshot, name);
    const dist = dists.length === 0 ? null : Math.min(...dists);
    if (dist != null && dist <= 3 && hp != null && hp <= 4) return 5;
    const lockedOn = (snapshot.entities ?? []).some(
      (e) =>
        isHostileEntity(e) &&
        !isPlayerEntity(e) &&
        String(e.name ?? 'unknown') === name &&
        e.lockedOn === true,
    );
    if (lockedOn && hp != null && hp <= 6) return 4;
    return descriptor.level;
  }
  if (type === 'player.chat.mention' || type === 'player.chat.private') {
    const text = String(descriptor.text ?? '');
    if (STOP_WORDS.some((w) => text.toLowerCase().includes(w.toLowerCase()))) return 4;
    return descriptor.level;
  }
  if (type === 'player.nearby') {
    const target = (snapshot.entities ?? []).find((e) => e.id === descriptor.key);
    if (target?.heldWeapon === true && hp != null && hp <= 6) return 4;
    return descriptor.level;
  }
  if (type === 'tool.action.failed') {
    // 无副作用的寻路失败降一级：丢路只是 L3 级新闻。
    if (descriptor.tool === 'navigate' && descriptor.sideEffect !== true) return 3;
    return descriptor.level;
  }
  if (type === 'task.failed') {
    if (descriptor.retryable === false) return 4;
    return descriptor.level;
  }
  return descriptor.level;
}

/** 工具失败归到中断等级（默认 L4）。 */
export function classifyToolFailure({ tool = null, sideEffect = false }: { tool?: string | null; sideEffect?: boolean } = {}): number {
  return resolvePriority({ type: 'tool.action.failed', level: 4, tool, sideEffect }, {});
}

export interface DiscreteEvent {
  type: string;
  level: number;
  key: string | number;
  delta: Record<string, unknown>;
  actionContext: null;
}

/**
 * 一个 watcher 的边沿状态。poll(snapshot) 返回新鲜事件描述；
 * discrete(type, id, extra) 按 id 去重离散推送。
 */
export function createEdgeWatcher({ detectors = DETECTORS }: { detectors?: readonly Detector[] } = {}): {
  poll: (snapshot?: EdgeSnapshot) => EdgeEvent[];
  discrete: (type: string, id: string | number, level?: number, extra?: Record<string, unknown>) => DiscreteEvent | null;
  armed: Map<string, boolean>;
} {
  const armed = new Map<string, boolean>();
  const last = new Map<string, unknown>();
  const seenDiscrete = new Set<string>();

  function describe(detector: Detector, key: string | number | null, snapshot: EdgeSnapshot): EdgeEvent {
    return {
      type: detector.type,
      level: detector.level,
      key,
      delta: deltaFor(detector, key, snapshot),
      actionContext: {
        currentAction: snapshot.currentAction ?? null,
        goal: snapshot.goal ?? null,
        position: snapshot.position ?? null,
        dimension: snapshot.dimension ?? null,
      },
    };
  }

  function poll(snapshot: EdgeSnapshot = {}): EdgeEvent[] {
    const out: EdgeEvent[] = [];
    for (const detector of detectors) {
      if (detector.kind === 'flag') {
        const on = (snapshot as Record<string, unknown>)[detector.flag ?? ''] === true;
        const was = armed.get(detector.type) ?? false;
        if (!was && on) {
          armed.set(detector.type, true);
          out.push(describe(detector, null, snapshot));
        } else if (was && !on) {
          armed.set(detector.type, false);
        }
      } else if (detector.kind === 'change') {
        const value = detector.value?.(snapshot);
        if (!last.has(detector.type)) {
          last.set(detector.type, value);
        } else {
          const prev = last.get(detector.type);
          last.set(detector.type, value);
          if (detector.fireOn?.(prev, value) === true) {
            out.push(describe(detector, null, snapshot));
          }
        }
      } else {
        // 'all' 与 'keyed'：全局单例或按 key 滞回。
        let keys: Array<string | number | null>;
        try {
          keys = detector.kind === 'keyed' ? (detector.keyOf?.(snapshot) ?? []) : [null];
        } catch {
          keys = [];
        }
        const seen = new Set<string>();
        for (const key of keys) {
          const record = `${detector.type}:${String(key)}`;
          seen.add(record);
          const was = armed.get(record) ?? false;
          let fires: boolean;
          try {
            fires = detector.fire?.(snapshot, key) === true;
          } catch {
            fires = false;
          }
          if (!was && fires) {
            armed.set(record, true);
            out.push(describe(detector, key, snapshot));
          } else if (was) {
            let clear: boolean;
            try {
              clear = detector.clear?.(snapshot, key) === true;
            } catch {
              clear = false;
            }
            if (clear) armed.set(record, false);
          }
        }
        // 消失的 key（死了的实体、换掉的工具）静默解 armed。
        for (const record of [...armed.keys()]) {
          if (record.startsWith(`${detector.type}:`) && !seen.has(record)) {
            armed.delete(record);
          }
        }
      }
    }
    return out;
  }

  function discrete(
    type: string,
    id: string | number,
    level = 3,
    extra: Record<string, unknown> = {},
  ): DiscreteEvent | null {
    const record = `${type}:${String(id)}`;
    if (seenDiscrete.has(record)) return null;
    seenDiscrete.add(record);
    return { type, level, key: id, delta: { ...extra }, actionContext: null };
  }

  return { poll, discrete, armed };
}

function deltaFor(detector: Detector, key: string | number | null, snapshot: EdgeSnapshot): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (key != null) delta['key'] = key;
  if (detector.type.startsWith('bot.health')) delta['health'] = snapshot.health;
  if (detector.type.startsWith('bot.hunger')) delta['food'] = snapshot.food;
  if (detector.type.startsWith('bot.oxygen')) delta['oxygen'] = snapshot.oxygen;
  if (detector.type === 'world.light_low') delta['light'] = snapshot.light;
  if (detector.type === 'inventory.full') delta['freeSlots'] = snapshot.freeSlots;
  // 手上那件工具快坏了——**说清是哪件、还剩多少**。模型反馈过这条事件不说是
  // 哪个物品，它只能猜是哪把镐（key 固定是 'hand'，换手也不会变）。
  if (detector.type === 'tool.durability_low') {
    const held = (snapshot.heldSlots ?? []).find((h) => h.slot === 'hand');
    delta['item'] = held?.item ?? null;
    delta['remaining'] = held?.fraction ?? null;
  }
  // 背包食物数 + 当前饥饿值一起给：前者是"还有没有存货"，后者是"现在饿不饿"。
  // 只给前者会让模型以为 `food_low` 是在说饥饿值（它反馈过这件事）。
  if (detector.type === 'inventory.food_items_low') {
    delta['foodItems'] = snapshot.foodCount;
    delta['food'] = snapshot.food;
    // 光报"没食物了"没有用——模型反馈过："系统只发了事件但**没有可执行的建议**，
    // 现在全靠我自己想"。把下一步直接写进事件里。
    delta['hint'] =
      '没有食物了：searchForEntity 找 pig/cow/chicken/sheep → attack 杀掉 → useBlock(type=furnace, input=生肉, output=熟肉) 烤熟 → consume 吃掉；' +
      '旁边有小麦/胡萝卜/土豆就直接 collectBlocks 收。饿到 6 以下会掉血。';
  }
  return delta;
}

export interface SnapshotExtra {
  currentAction?: string | null;
  goal?: string | null;
  foodNames?: string[];
}

/**
 * 从 mineflayer bot 现拼边沿快照。全部防御性读取；读不到的
 * 保持 undefined（检测器把缺值当"没触发"，不瞎报）。
 *
 * 诚实缺口（host 还没接传感）：trapped（被围困要结合移动史，
 * 轮询层以后再做）——对应 L5 检测器平时静默，等补上传感再亮。
 * belowVoid/fallLethal/nextIsLava/onFire 已从位置/朝向/元数据算出来。
 */
export function snapshotFromBot(bot: unknown, extra: SnapshotExtra = {}): EdgeSnapshot {
  const snap: EdgeSnapshot = {};
  if (bot == null || typeof bot !== 'object') return snap;
  const b = bot as Record<string, unknown>;
  try {
    snap.health = num(b['health']);
    snap.food = num(b['food']);
    snap.oxygen = num((b as { oxygenLevel?: unknown }).oxygenLevel);

    const entity = (b['entity'] ?? {}) as Record<string, unknown>;
    const pos = (entity['position'] ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
    const feet = { x: num(pos.x) ?? 0, y: num(pos.y) ?? 0, z: num(pos.z) ?? 0 };
    const vel = (entity['velocity'] ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
    snap.moving =
      num(vel.x) != null && (Math.abs(num(vel.x) as number) + Math.abs(num(vel.y) as number) + Math.abs(num(vel.z) as number) > 0.1);
    snap.alive = snap.health != null ? snap.health > 0 : undefined;

    const slots = ((b['inventory'] as { slots?: unknown } | undefined)?.slots ?? []) as Array<{
      name?: unknown;
      count?: unknown;
    }>;
    if (Array.isArray((b['inventory'] as { slots?: unknown } | undefined)?.slots)) {
      let free = 0;
      for (let i = 9; i <= 35; i++) {
        if (slots[i] == null) free++;
      }
      snap.freeSlots = free;
    }
    try {
      const items = ((b['inventory'] as { items?: () => unknown }).items?.() ?? []) as Array<{
        name?: unknown;
        count?: unknown;
      }>;
      const foods = new Set(extra.foodNames ?? []);
      let foodCount = 0;
      for (const item of items) {
        const n = typeof item?.name === 'string' ? item.name : '';
        if (foods.has(n)) foodCount += typeof item?.count === 'number' ? item.count : 1;
      }
      if (foods.size > 0 || foodCount > 0) snap.foodCount = foodCount;
    } catch {
      // 背包读不到就不报食物数。
    }

    const held = (b['heldItem'] ?? null) as {
      name?: unknown;
      durabilityUsed?: unknown;
      maxDurability?: unknown;
    } | null;
    // 与 Live State 共用同一个钳制过的算法：负的 fraction 会让
    // `tool.durability_low` 永远处于触发态（模型反馈过 -300%/-900%）。
    const fraction = durabilityFraction(held?.durabilityUsed, held?.maxDurability);
    if (fraction != null) {
      // **带上物品名**：模型反馈过"durability_low 不说是哪个物品"，它只能猜是哪把
      // 镐快坏了。手上一换东西 key 仍是 'hand'，所以名字必须在 delta 里。
      snap.heldSlots = [
        { slot: 'hand', fraction, ...(typeof held?.name === 'string' ? { item: held.name } : {}) },
      ];
    }

    const time = num((b['time'] as { timeOfDay?: unknown } | undefined)?.timeOfDay);
    snap.isNight = time != null ? time >= 12542 && time < 23460 : undefined;
    // mineflayer 的 thunderState/rainState 是**数字**等级（rain.js 初值 0，
    // 由 game_state_change 的 gameMode 赋值），不是布尔；`isRaining` 由
    // start_raining/stop_raining 直接维护，和 rainState 一起看更稳。
    const thunder = b['thunderState'] as unknown;
    snap.isThunder = thunder === true || (num(thunder) ?? 0) > 0 ? true : undefined;
    const rain = b['rainState'] as unknown;
    snap.isRain =
      b['isRaining'] === true || rain === true || (num(rain) ?? 0) > 0 ? true : undefined;
    snap.dimension = strOf((b['game'] as { dimension?: unknown } | undefined)?.dimension);

    try {
      const blockAt = b['blockAt'] as ((p: unknown) => unknown) | undefined;
      if (typeof blockAt === 'function') {
        const at = (p: { x: number; y: number; z: number }): Record<string, unknown> => {
          try {
            // 必须传 Vec3：mineflayer 的 blockAt 把参数原样交给 prismarine-world，
            // 而后者在**区块已加载**时会执行 `pos.floored()` —— plain 对象会抛
            // TypeError，被这里吞掉后 light/inLava/nextIsLava 全部静默变 undefined。
            return (blockAt.call(b, new Vec3(p.x, p.y, p.z)) ?? {}) as Record<string, unknown>;
          } catch {
            return {};
          }
        };
        const feetBlock = at(feet);
        // prismarine-chunk 里 `light` 是**方块光**（火把/岩浆/发光方块），`skyLight` 是
        // **天光**，两者独立且都可以是 0——露天白天就是 `light 0 / skyLight 15`，
        // 所以 `light ?? skyLight` 永远拿不到天光（0 不是 nullish）。
        // 另外 chunk 里的 skyLight **不随时辰变化**（半夜也是 15），所以"这里暗不暗"
        // 必须结合白天/黑夜：夜里天光不照亮。
        const blockLight = num(feetBlock['light']);
        const skyLight = num(feetBlock['skyLight']);
        if (blockLight != null || skyLight != null) {
          const sky = snap.isNight === true ? 0 : (skyLight ?? 0);
          snap.light = Math.max(blockLight ?? 0, sky);
        }
        const feetName = feetBlock['name'];
        snap.inLava = feetName === 'lava' ? true : undefined;
        snap.inWater = feetName === 'water' ? true : undefined;

        // **真正淹没**：头也在水里。这是**可靠**信号——mineflayer 的

        // `oxygenLevel = Math.round(metas.air_supply / 15)` 在 1.20.6 上取不到 air_supply，

        // 会一直停在默认值 20。模型真机上就是这么溺死的：氧气显示 20，world.water.drowning

        // （L5 紧急）永远不触发。

        // 头那一格：mock 出来的 bot 可能没有 blockAt / entity.position.offset，

        // 所以先看有没有，别让快照整个炸掉（测试就是这么抓到第一版的）。

        const anyBot = bot as {

          blockAt?: (pos: unknown) => { name?: unknown } | null;

          entity?: { position?: { offset?: (x: number, y: number, z: number) => unknown } };

        };

        const headPos = anyBot.entity?.position?.offset?.(0, 1.6, 0);

        const headBlock = headPos == null ? null : anyBot.blockAt?.(headPos);

        snap.submerged =

          feetName === 'water' && headBlock?.['name'] === 'water' ? true : undefined;
        const biome = feetBlock['biome'] as { name?: unknown } | string | null | undefined;
        snap.biome = typeof biome === 'string' ? biome : strOf(biome?.name);

        // 着火：实体元数据第 0 项是 flags 字节，bit0=着火
        // （各版本协议稳定项；读不懂就空着，不瞎报）。
        try {
          const meta = (entity as { metadata?: unknown }).metadata;
          const first = Array.isArray(meta) ? (meta[0] as { value?: unknown } | number | undefined) : undefined;
          const flags = typeof first === 'number' ? first : typeof first?.value === 'number' ? first.value : null;
          if (flags != null) snap.onFire = (flags & 1) === 1 ? true : undefined;
        } catch {
          // 元数据形状不对就不报。
        }

        // 虚空：主世界/末地掉到 -60 以下就是往虚空里掉（下界没虚空，到不了）。
        const feetY = num(pos.y);
        snap.belowVoid = feetY != null && feetY < -60 ? true : undefined;

        // 高坠：mineflayer **不暴露** fallDistance（mineflayer / prismarine-entity /
        // prismarine-physics 里零命中），所以用"离地 + 下落速度"做代理。
        // 带阻力的真实递推是 v=(v-0.08)*0.98：恰好落下 8 格时 v≈-1.08，
        // v<=-1.1 要到第 17 刻、已掉 9.67 格，所以阈值取 -1.08 才对得上"8 格"。
        // 注意这是**近似**且受 300ms 轮询相位影响：8~9 格窗口很窄可能整段错过，
        // 10~19 格概率性触发，≥20 格窗口超过轮询周期必中。保守方向，不会误报。
        const vy = num(vel.y);
        const onGround = (entity as { onGround?: unknown }).onGround;
        snap.fallLethal = onGround === false && vy != null && vy <= -1.08 ? true : undefined;

        // 前方岩浆：朝向方向上两格内脚下是岩浆。
        // mineflayer 的 yaw 是弧度且 0=北，此时水平朝向向量是 (-sin, -cos)。
        // 先取脚下方块再叠加**取整**的偏移：直接 floor(世界坐标 + 2*dir)
        // 会被 sin(π)=1.2e-16 这类浮点噪声推到 -1 号方块，正南方向就查不到。
        const yaw = num((entity as { yaw?: unknown }).yaw);
        if (yaw != null && snap.moving === true) {
          const ahead = at({
            x: Math.floor(feet.x) + Math.round(-Math.sin(yaw) * 2),
            y: feet.y,
            z: Math.floor(feet.z) + Math.round(-Math.cos(yaw) * 2),
          });
          snap.nextIsLava = ahead['name'] === 'lava' ? true : undefined;
        }
      }
    } catch {
      // 环境读不到就空着。
    }

    const rawEntities = (b['entities'] ?? {}) as Record<string, unknown>;
    const list: EdgeSnapshot['entities'] = [];
    try {
      const selfId = (entity as { id?: unknown }).id;
      for (const raw of Object.values(rawEntities)) {
        const e = raw as {
          id?: unknown;
          name?: unknown;
          displayName?: unknown;
          username?: unknown;
          type?: unknown;
          kind?: unknown;
          position?: unknown;
          health?: unknown;
          yaw?: unknown;
          heldItem?: unknown;
        };
        if (e == null || e.id === selfId) continue;
        const ep = (e.position ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
        const ex = num(ep.x);
        const ey = num(ep.y);
        const ez = num(ep.z);
        if (ex == null || ey == null || ez == null) continue;
        const d = Math.hypot(ex - feet.x, ey - feet.y, ez - feet.z);
        const type = typeof e.type === 'string' ? e.type : typeof e.kind === 'string' ? e.kind : '';
        const category = typeof e.kind === 'string' ? e.kind : '';
        // 玩家实体的 `name` 是**类型名** `'player'`（mineflayer addNewPlayer 里写死），
        // 身份在 `username` 上，且它不设 displayName —— 不先取 username 的话
        // 快照里所有玩家都会显示成匿名的 `player#N`。
        const rawName =
          (typeof e.username === 'string' && e.username !== '' ? e.username : null) ??
          (typeof e.name === 'string' ? e.name : null) ??
          (typeof e.displayName === 'string' ? e.displayName : null) ??
          'unknown';
        const name = rawName.toLowerCase();
        const isPlayer = type.toLowerCase() === 'player';

        // 下面两个判据必须带 `!isPlayer`：`name` 现在优先取 username，而
        // 用户名恰好叫 `creeper` / `tnt` 的玩家是很常见的——不加守卫就会把
        // 玩家当成点燃的 TNT / 起爆的苦力怕，直接触发 L5 EMERGENCY
        // （停掉所有动作 + 进 emergency）。玩家实体的 metadata[16] 是 `score`，
        // 不是 `swell_dir`，读数本身也没有意义。
        // 已点燃的 TNT 在协议里就是一个名为 tnt 的实体（displayName: Primed TNT）。
        const primed = !isPlayer && name === 'tnt';
        // 苦力怕引信：metadata[16] = swell_dir，-1 未起爆；点燃瞬间会先置 0，
        // 所以判据是"不是 -1"，否则会漏掉第一个 tick。
        const swellDir =
          !isPlayer && name === 'creeper' ? metadataValue(e, CREEPER_SWELL_DIR_INDEX) : null;
        const swelling = swellDir != null && swellDir !== -1;
        // mcData 的类别能覆盖敌对名单之外的新生物。
        const hostile = !isPlayer && (ALWAYS_HOSTILE.has(name) || category === 'Hostile mobs');
        const held = (e.heldItem ?? null) as { name?: unknown } | null;
        const heldWeapon = isPlayer && isWeaponItem(held?.name);
        // 朝向：实体 yaw（弧度）与"从它指向 bot"的方向差在阈值内 = 盯着我。
        const eyaw = num(e.yaw);
        const lockedOn =
          eyaw != null && facingDelta(eyaw, lockOnYaw(ex, ez, feet.x, feet.z)) <= LOCK_ON_RADIANS;

        list.push({
          id: typeof e.id === 'number' ? e.id : -1,
          name: rawName,
          kind: type !== '' ? type : undefined,
          distance: Math.round(d * 10) / 10,
          isPlayer,
          // mineflayer 不给实体填 `health`（entities.js 里零命中），所以这里
          // 目前恒为 undefined；读它只是留个口子，别以为快照里有怪物血量。
          health: num(e.health) ?? undefined,
          hostile: hostile || undefined,
          primed: primed || undefined,
          swelling: swelling || undefined,
          heldWeapon: heldWeapon || undefined,
          lockedOn: lockedOn || undefined,
        });
      }
    } catch {
      // 实体表读不到就当没看见。
    }
    if (list.length > 0) snap.entities = list;

    snap.currentAction = extra.currentAction ?? null;
    snap.goal = extra.goal ?? null;
    snap.position = `${feet.x},${feet.y},${feet.z}`;
    snap.dimension = snap.dimension ?? strOf((b['game'] as { dimension?: unknown } | undefined)?.dimension) ?? null;
  } catch {
    // 拼快照永不抛错：半截也比没有强。
  }
  return snap;
}

function strOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 受伤防抖：着火/中毒是持续掉血，1.5 秒内只报一次。 */
export const HURT_DEBOUNCE_MS = 1500;

/**
 * 掉血即发（带伤害量），防抖内免发。阈值越线是另一组检测器的事，
 * 这里只管"挨打了"这个事实——20→18 也要让模型知道。
 */
export function shouldEmitHurt(
  prevHealth: number | null | undefined,
  health: number | null | undefined,
  lastEmitAt: number,
  now: number,
): { fire: boolean; damage: number } {
  if (prevHealth == null || health == null) return { fire: false, damage: 0 };
  const damage = prevHealth - health;
  if (!(damage > 0)) return { fire: false, damage: 0 };
  if (now - lastEmitAt < HURT_DEBOUNCE_MS) return { fire: false, damage };
  return { fire: true, damage: Math.round(damage * 100) / 100 };
}

/** 卡住判定：有动作在跑，但位置超过阈值没动。 */
export const STUCK_MS = 60000;

export function isStuck(
  lastPos: string | null | undefined,
  pos: string | null | undefined,
  since: number,
  now: number,
  actionRunning: boolean,
  thresholdMs: number = STUCK_MS,
): boolean {
  if (!actionRunning) return false;
  if (lastPos == null || pos == null || lastPos !== pos) return false;
  return now - since >= thresholdMs;
}

/** 心跳：空闲超过间隔就醒一次做反思，防睡死。 */
export const HEARTBEAT_MS = 5 * 60 * 1000;

export function isHeartbeatDue(lastAt: number, now: number, intervalMs: number = HEARTBEAT_MS): boolean {
  return now - lastAt >= intervalMs;
}

export default { createEdgeWatcher, resolvePriority, classifyToolFailure, schedulerLevelFor, snapshotFromBot, DETECTORS };
