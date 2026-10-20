/*
 * Live State 采样：读 mineflayer bot，产出一份 `LiveState`（纯数据）。
 *
 * 数据结构与渲染器在 `shared/live_state.ts`——**渲染留在大脑侧**，
 * 而身体只负责把"此刻的世界"如实采出来。快照函数永不抛错：
 * 缺字段就写 null/unknown，一个请求不能因为快照失败而发不出去。
 */
import { Vec3 } from 'vec3';
import { getItemMaxDurability } from './data/mcdata.js';
import { estimateTokens } from '../shared/utils/tokens.js';
import {
  KEY_BLOCK_SET,
  PERCEPTION_BUDGET_TOKENS,
  PERCEPTION_LIMIT,
  PERCEPTION_RADIUS,
  SUMMARY_LINES,
  budgetedList,
  dist3,
  durabilityFraction,
  num,
  str,
  summarizeOmitted,
  renderLiveState,
  type LiveBackpack,
  type LiveBlock,
  type LiveBody,
  type LiveEntity,
  type LiveEnvironment,
  type LiveHeld,
  type LiveMeta,
  type LivePosition,
  type LiveScreenshot,
  type LiveState,
} from '../shared/live_state.js';
import type { PlanTodo } from '../shared/plan.js';
import { permits } from './safety/permits.js';
import { safeguards } from './safety/safeguards.js';
import { getVillagerProfession } from './library/world.js';

/**
 * `bot.blockAt` 只接受 Vec3：mineflayer 把参数原样交给 prismarine-world，
 * 而后者在区块已加载时会执行 `pos.floored()`——传 plain `{x,y,z}` 会抛
 * TypeError，被外层的 try/catch 吞掉后所有方块感知静默变成 null/unknown。
 */
const Vec3Of = (p: { x: number; y: number; z: number }): unknown => new Vec3(p.x, p.y, p.z);

/**
 * 解析主手物品的耐久上限：mineflayer 读数 → bot 自己的注册表 → mcData 静态表。
 *
 * `<=1` 的读数一律视为"这不是耐久上限"（真机 `stone_pickaxe` 拿到 `max=1`；
 * 石头镐应为 131），继续往下退；三级都拿不到才返回 null，由渲染层如实说
 * "上限读不到——算不出剩余"。**绝不把一个假上限当真值用**。
 */
function resolveMaxDurability(
  bot: Record<string, unknown>,
  heldItem: { name?: unknown; maxDurability?: unknown } | null | undefined,
): number | null {
  const raw = num(heldItem?.maxDurability);
  if (raw != null && raw > 1) return raw;
  const name = str(heldItem?.name);
  if (name == null) return null;
  try {
    const registry = (bot['registry'] ?? {}) as { itemsByName?: Record<string, { maxDurability?: unknown }> };
    const fromRegistry = num(registry.itemsByName?.[name]?.maxDurability);
    if (fromRegistry != null && fromRegistry > 1) return fromRegistry;
  } catch {
    // 注册表读不到就继续退到静态表。
  }
  return getItemMaxDurability(name);
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
  /**
   * 背包数据是否已经同步过（**默认 true**，兼容老调用方）。
   *
   * 真机 2026-10-18：进程重启后第一份快照读成 `Backpack: empty` / `Held: main empty`，
   * 而玩家数据里 dirt×11 好端端躺着——模型据此以为自己丢了全部家当、从零重采。
   * 这个字段为 false 时，渲染层必须写"还没同步上来（**不是空的**）"。
   */
  inventorySynced?: boolean;
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
    held: {
      mainHand: null,
      offHand: null,
      armor: [],
      mainHandDurability: null,
      mainHandDurabilityUsed: null,
      mainHandDurabilityMax: null,
    },
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
    players: [],
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
    // **上限要能自证。** 真机（overnight_b 2026-10-18 13:00）报 `used=95 max=1`：
    // mineflayer 在 Fabric/模组注册表下给出的 `maxDurability` 可能不是耐久上限
    // （石头镐应为 131）。<=1 一律当"读不到"，先回退 bot 自己的注册表，
    // 再回退 mcData 静态表；都拿不到就写 null，由渲染层如实说"算不出剩余"。
    const rawMax = num(heldItem?.maxDurability);
    const maxDurability = resolveMaxDurability(bot, heldItem);
    const inventorySynced = ctx.inventorySynced !== false;
    empty.held = {
      synced: inventorySynced,
      mainHand: heldItem ? `${str(heldItem.name) ?? 'unknown'}x${num(heldItem.count) ?? 1}` : null,
      offHand: slotName(45),
      armor: [slotName(8), slotName(7), slotName(6), slotName(5)].filter(
        (s): s is string => s != null && s !== 'null',
      ),
      mainHandDurability: durabilityFraction(usedDurability, maxDurability),
      mainHandDurabilityUsed: usedDurability,
      mainHandDurabilityMax: maxDurability,
      mainHandDurabilityMaxInvalid: rawMax != null && rawMax <= 1,
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
      synced: inventorySynced,
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

    // 在线玩家（不含自己）。**只是数据，不渲染**——见 `LiveState.players`。
    const selfName = str(bot.username);
    empty.players = Object.keys((bot.players ?? {}) as Record<string, unknown>).filter(
      (name) => name !== selfName,
    );

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
    const v = vision as
      | { lastScreenshot?: unknown; lastFrameTrust?: unknown; lastFrameView?: unknown }
      | null
      | undefined;
    const last = v?.lastScreenshot as { file?: unknown; takenAt?: unknown } | null | undefined;
    if (last != null && typeof last.file === 'string' && typeof last.takenAt === 'number') {
      // **图照发，但坏帧要带上怀疑**：渲染器认不出这个版本的方块时，
      // 画面里的「?」和蓝色空白会被模型读成"掉进虚空"（真机 overnight_a）。
      const trust = v?.lastFrameTrust as
        | { trusted?: unknown; line?: unknown; reason?: unknown }
        | null
        | undefined;
      const trustInfo =
        trust != null && typeof trust === 'object'
          ? {
              trusted: trust.trusted === true,
              line: typeof trust.line === 'string' ? trust.line : '',
              reason: typeof trust.reason === 'string' ? trust.reason : '',
            }
          : null;
      // **这一帧自己的朝向**（拍摄时记录的）—— 不给"当前朝向"。
      const view = v?.lastFrameView as { yaw?: unknown; pitch?: unknown } | null | undefined;
      const viewInfo =
        view != null && typeof view === 'object'
          ? {
              yaw: typeof view.yaw === 'number' && Number.isFinite(view.yaw) ? view.yaw : null,
              pitch: typeof view.pitch === 'number' && Number.isFinite(view.pitch) ? view.pitch : null,
            }
          : null;
      return {
        ref: { file: last.file, takenAt: last.takenAt },
        unavailableReason: null,
        trust: trustInfo,
        view: viewInfo,
      };
    }
    if (v == null) return { ref: null, unavailableReason: 'vision disabled' };
    return { ref: null, unavailableReason: 'no screenshot taken yet' };
  } catch {
    return { ref: null, unavailableReason: 'vision unreadable' };
  }
}

/**
 * 每轮请求的尾巴文本：`## 当前世界快照` + 现采现渲的快照。
 *
 * 采样必须在身体侧（要读 mineflayer bot），所以这个拼装函数也在这里；
 * 渲染器用的是**共享**的那一份，大脑侧只负责加标题。
 */
export function composeLiveTail(sample: SampleContext): string {
  return `## 当前世界快照\n${renderLiveState(sampleLiveState(sample))}`;
}
