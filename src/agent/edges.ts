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

/** 检测器看到的拍平快照（由调用方从 LiveState 等拼出来）。 */
export interface EdgeEntity {
  id: number;
  name: string;
  kind?: string | null;
  distance?: number | null;
  hostile?: boolean | null;
  isPlayer?: boolean | null;
  swelling?: boolean | null;
  primed?: boolean | null;
  heldWeapon?: boolean | null;
  lockedOn?: boolean | null;
}

export interface HeldSlot {
  slot: number | string;
  /** 剩余耐久比例 0~1。 */
  fraction?: number | null;
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

const ALWAYS_HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper',
  'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube',
  'ghast', 'blaze', 'piglin_brute', 'hoglin', 'zoglin', 'phantom',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
  'guardian', 'elder_guardian', 'shulker', 'endermite', 'silverfish',
  'warden', 'breeze',
]);

function isPlayerEntity(e: EdgeEntity): boolean {
  return e.isPlayer === true || String(e.kind ?? '').toLowerCase() === 'player';
}

function isHostileEntity(e: EdgeEntity): boolean {
  if (e.hostile === true) return true;
  if (e.hostile === false) return false;
  return ALWAYS_HOSTILE.has(String(e.name ?? '').toLowerCase());
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
    fire: (s) => lte(s.oxygen, 5) && s.inWater === true,
    clear: (s) => gte(s.oxygen, 15) },
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
    type: 'entity.hostile_nearby', level: 3, kind: 'keyed',
    keyOf: (s) => (s.entities ?? []).filter((e) => isHostileEntity(e) && !isPlayerEntity(e)).map((e) => e.id),
    fire: (s, id) => within(s, id, 32),
    clear: (s, id) => !within(s, id, 40),
  },
  {
    type: 'entity.hostile_far', level: 2, kind: 'keyed',
    keyOf: (s) => (s.entities ?? []).filter((e) => isHostileEntity(e) && !isPlayerEntity(e)).map((e) => e.id),
    fire: (s, id) => { const d = distOf(s, id); return d != null && d > 32 && d <= 64; },
    clear: (s, id) => !within(s, id, 64),
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
    fire: (s) => lte(s.light, 4),
    clear: (s) => gte(s.light, 8) },
  { type: 'world.dimension_change', level: 3, kind: 'change',
    value: (s) => s.dimension ?? null, fireOn: (prev, next) => prev != null && next != null && prev !== next },
  { type: 'world.biome_change', level: 2, kind: 'change',
    value: (s) => s.biome ?? null, fireOn: (prev, next) => prev != null && next != null && prev !== next },
  { type: 'inventory.full', level: 3, kind: 'all',
    fire: (s) => num(s.freeSlots) === 0,
    clear: (s) => gt(s.freeSlots, 0) },
  { type: 'inventory.food_low', level: 3, kind: 'all',
    fire: (s) => lte(s.foodCount, 8),
    clear: (s) => gte(s.foodCount, 12) },
  {
    type: 'tool.durability_low', level: 3, kind: 'keyed',
    keyOf: (s) => (s.heldSlots ?? []).map((h) => h.slot),
    fire: (s, slot) => (s.heldSlots ?? []).some((h) => h.slot === slot && lte(h.fraction, 0.1)),
    clear: (s, slot) => !(s.heldSlots ?? []).some((h) => h.slot === slot && lte(h.fraction, 0.3)),
  },
  { type: 'agent.death', level: 4, kind: 'all',
    fire: (s) => s.alive === false, clear: (s) => s.alive !== false },
  { type: 'agent.respawn', level: 3, kind: 'change',
    value: (s) => s.alive ?? null, fireOn: (prev, next) => prev === false && next === true },
]);

const STOP_WORDS = Object.freeze(['停', '别动', '危险', '救命', 'stop']);

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
    const target = (snapshot.entities ?? []).find((e) => e.id === descriptor.key);
    const dist = num(target?.distance);
    if (dist != null && dist <= 3 && hp != null && hp <= 4) return 5;
    if (target?.lockedOn === true && hp != null && hp <= 6) return 4;
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
  if (detector.type === 'inventory.food_low') delta['foodCount'] = snapshot.foodCount;
  return delta;
}

export default { createEdgeWatcher, resolvePriority, classifyToolFailure, schedulerLevelFor, DETECTORS };
