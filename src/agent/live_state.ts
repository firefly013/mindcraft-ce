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
}

export interface LiveHeld {
  mainHand: string | null;
  offHand: string | null;
  armor: string[];
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
}

export interface LiveEnvironment {
  timeOfDay: number | null;
  weather: 'Clear' | 'Rain' | 'Thunderstorm' | 'Unknown';
  light: number | null;
  /** 客户端光照读数是快照，可能过期——可信度必须诚实标注。 */
  lightConfidence: 'high' | 'medium' | 'low' | 'unknown';
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
}

export interface LiveState {
  body: LiveBody;
  held: LiveHeld;
  backpack: LiveBackpack;
  position: LivePosition;
  environment: LiveEnvironment;
  entities: LiveEntity[];
  entitiesTruncated: number;
  blocks: LiveBlock[];
  blocksTruncated: number;
  screenshot: LiveScreenshot;
  goal: string | null;
  todos: string[];
  meta: LiveMeta;
}

/** 感知半径（格），与截断上限一起保证快照有界。 */
export const PERCEPTION_RADIUS = 32;
/** 实体/方块各自最多列几条，超了只报总数。 */
export const PERCEPTION_LIMIT = 16;

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

export interface SampleContext {
  /** mineflayer bot 无类型，采样时全部防御性读取 */
  bot: any;
  vision?: any;
  goal?: string | null;
  todos?: string[];
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
    },
    held: { mainHand: null, offHand: null, armor: [] },
    backpack: { freeSlots: null, items: [] },
    position: { x: null, y: null, z: null, yaw: null, pitch: null, dimension: null, biome: null },
    environment: { timeOfDay: null, weather: 'Unknown', light: null, lightConfidence: 'unknown' },
    entities: [],
    entitiesTruncated: 0,
    blocks: [],
    blocksTruncated: 0,
    screenshot: { ref: null, unavailableReason: 'no vision data yet' },
    goal: ctx.goal ?? null,
    todos: ctx.todos ?? [],
    meta: { gamemode: null, openScreen: null, currentAction: ctx.currentAction ?? null },
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
      pose: str(entity.pose),
      onGround: typeof entity.onGround === 'boolean' ? entity.onGround : null,
    };

    const slots: unknown[] = Array.isArray(bot.inventory?.slots) ? bot.inventory.slots : [];
    const slotName = (i: number): string | null => {
      const s = slots[i] as { name?: unknown; count?: unknown } | undefined;
      const n = str(s?.name);
      if (n == null) return null;
      const c = num(s?.count) ?? 1;
      return `${n}x${c}`;
    };
    const heldItem = bot.heldItem as { name?: unknown; count?: unknown } | undefined;
    empty.held = {
      mainHand: heldItem ? `${str(heldItem.name) ?? 'unknown'}x${num(heldItem.count) ?? 1}` : null,
      offHand: slotName(45),
      armor: [slotName(8), slotName(7), slotName(6), slotName(5)].filter(
        (s): s is string => s != null && s !== 'null',
      ),
    };

    const packItems: string[] = [];
    let free = 0;
    for (let i = 9; i <= 35; i++) {
      const n = slotName(i);
      if (n == null) free++;
      else packItems.push(`[${i}]${n}`);
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
    };

    empty.environment = {
      timeOfDay: num(bot.time?.timeOfDay),
      weather: weatherOf(bot),
      ...lightOf(bot, feet),
    };

    const seen = sampleEntities(bot, feet);
    empty.entities = seen.slice(0, PERCEPTION_LIMIT);
    empty.entitiesTruncated = Math.max(0, seen.length - empty.entities.length);

    const found = sampleBlocks(bot, feet);
    empty.blocks = found.slice(0, PERCEPTION_LIMIT);
    empty.blocksTruncated = Math.max(0, found.length - empty.blocks.length);

    empty.screenshot = screenshotOf(ctx.vision);

    empty.meta = {
      gamemode: str(bot.game?.gameMode),
      openScreen: bot.currentWindow != null ? (str(bot.currentWindow?.title) ?? 'open') : null,
      currentAction: ctx.currentAction ?? null,
    };
  } catch {
    // 半截快照也照常返回：调用方看到的是 null/unknown，而不是一次异常。
  }
  return empty;
}

function weatherOf(bot: Record<string, unknown>): LiveEnvironment['weather'] {
  try {
    if ((bot as { thunderState?: unknown }).thunderState === true) return 'Thunderstorm';
    const rain = (bot as { rainState?: unknown }).rainState;
    if (rain === true || rain === 1) return 'Rain';
    if (rain === false || rain === 0) return 'Clear';
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
    const block = blockAt.call(bot, feet) as { light?: unknown; skyLight?: unknown } | null;
    const light = num(block?.light ?? block?.skyLight);
    if (light == null) return { light: null, lightConfidence: 'unknown' };
    return { light, lightConfidence: skyExposed(bot, feet) ? 'high' : 'medium' };
  } catch {
    return { light: null, lightConfidence: 'unknown' };
  }
}

function skyExposed(bot: Record<string, unknown>, feet: { x: number; y: number; z: number }): boolean {
  try {
    const blockAt = (bot as { blockAt?: (p: unknown) => unknown }).blockAt;
    if (typeof blockAt !== 'function') return false;
    for (let y = 1; y <= 10; y++) {
      const above = blockAt.call(bot, { x: feet.x, y: feet.y + y, z: feet.z }) as {
        name?: unknown;
        transparent?: unknown;
      } | null;
      if (above == null || above.name === 'air' || above.name === 'cave_air') continue;
      if (above.transparent === true) continue;
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function biomeOf(bot: Record<string, unknown>, feet: { x: number; y: number; z: number }): string | null {
  try {
    const blockAt = (bot as { blockAt?: (p: unknown) => unknown }).blockAt;
    const block = (typeof blockAt === 'function' ? blockAt.call(bot, feet) : null) as {
      biome?: { name?: unknown } | string | null;
    } | null;
    const biome = block?.biome;
    if (typeof biome === 'string') return biome;
    return str(biome?.name);
  } catch {
    return null;
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
        position?: { x: number; y: number; z: number } | null;
        health?: unknown;
      };
      if (e == null || e.position == null || e.id === selfId) continue;
      const d = dist3(e.position.x, e.position.y, e.position.z, feet.x, feet.y, feet.z);
      if (d > PERCEPTION_RADIUS) continue;
      out.push({
        id: Number(e.id),
        name: str(e.name ?? e.displayName) ?? 'unknown',
        kind: str(e.kind ?? e.type),
        distance: Math.round(d * 10) / 10,
        x: e.position.x,
        y: e.position.y,
        z: e.position.z,
        health: num(e.health),
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

function sampleBlocks(
  bot: Record<string, unknown>,
  feet: { x: number; y: number; z: number },
): LiveBlock[] {
  const out: LiveBlock[] = [];
  try {
    const blockAt = (bot as { blockAt?: (p: unknown) => unknown }).blockAt;
    if (typeof blockAt !== 'function') return out;
    const r = Math.ceil(PERCEPTION_RADIUS);
    for (let x = feet.x - r; x <= feet.x + r; x++) {
      for (let y = feet.y - r; y <= feet.y + r; y++) {
        for (let z = feet.z - r; z <= feet.z + r; z++) {
          let block: { name?: unknown } | null = null;
          try {
            block = blockAt.call(bot, { x, y, z }) as { name?: unknown } | null;
          } catch {
            block = null;
          }
          const name = str(block?.name);
          if (name == null || !KEY_BLOCKS.includes(name)) continue;
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

/** 把快照渲成追加在请求末尾的文本块（放最后，不破坏前缀缓存）。 */
export function renderLiveState(s: LiveState): string {
  const lines: string[] = [];
  const b = s.body;
  lines.push(
    `Body: health ${b.health ?? UNKNOWN} food ${b.food ?? UNKNOWN} saturation ${b.saturation ?? UNKNOWN} ` +
      `oxygen ${b.oxygen ?? UNKNOWN} xp ${b.xpLevel ?? UNKNOWN} pose ${b.pose ?? UNKNOWN} ` +
      `onGround ${b.onGround ?? UNKNOWN}`,
  );
  const h = s.held;
  lines.push(
    `Held: main ${h.mainHand ?? 'empty'} off ${h.offHand ?? 'empty'} armor ${h.armor.length > 0 ? h.armor.join('/') : 'none'}`,
  );
  lines.push(
    `Backpack (free ${s.backpack.freeSlots ?? UNKNOWN}): ${s.backpack.items.length > 0 ? s.backpack.items.join(', ') : 'empty'}`,
  );
  const p = s.position;
  lines.push(
    `Position: ${p.x ?? UNKNOWN},${p.y ?? UNKNOWN},${p.z ?? UNKNOWN} facing yaw ${p.yaw ?? UNKNOWN} pitch ${p.pitch ?? UNKNOWN} ` +
      `dimension ${p.dimension ?? UNKNOWN} biome ${p.biome ?? UNKNOWN}`,
  );
  const e = s.environment;
  lines.push(
    `Environment: time ${e.timeOfDay ?? UNKNOWN} weather ${e.weather} light ${e.light ?? UNKNOWN} (confidence ${e.lightConfidence})`,
  );
  const entHead = `Nearby entities (within ${PERCEPTION_RADIUS}: ${s.entities.length}${s.entitiesTruncated > 0 ? `+${s.entitiesTruncated} more` : ''})`;
  lines.push(
    `${entHead}:\n${s.entities.map((x) => `- ${x.name}#${x.id} ${x.distance}m (${x.x},${x.y},${x.z})${x.health != null ? ` hp ${x.health}` : ''}`).join('\n') || 'none'}`,
  );
  const blkHead = `Nearby key blocks (within ${PERCEPTION_RADIUS}: ${s.blocks.length}${s.blocksTruncated > 0 ? `+${s.blocksTruncated} more` : ''})`;
  lines.push(
    `${blkHead}:\n${s.blocks.map((x) => `- ${x.name} ${x.distance}m (${x.x},${x.y},${x.z})`).join('\n') || 'none'}`,
  );
  if (s.screenshot.ref != null) {
    const age = Date.now() - s.screenshot.ref.takenAt;
    lines.push(`Screenshot: ${s.screenshot.ref.file} (taken ${Math.max(0, Math.round(age / 1000))}s ago)`);
  } else {
    lines.push(`Screenshot: none (${s.screenshot.unavailableReason ?? UNKNOWN})`);
  }
  lines.push(`Goal: ${s.goal ?? 'none'} Todos: ${s.todos.length > 0 ? s.todos.join('; ') : 'none'}`);
  lines.push(
    `Meta: gamemode ${s.meta.gamemode ?? UNKNOWN} screen ${s.meta.openScreen ?? 'none'} action ${s.meta.currentAction ?? 'idle'}`,
  );
  return lines.join('\n');
}

export default { sampleLiveState, renderLiveState, PERCEPTION_RADIUS, PERCEPTION_LIMIT, KEY_BLOCKS };
