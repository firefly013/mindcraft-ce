/*
 * Live State 的**共享契约**：数据结构 + 渲染纯函数。
 *
 * 采样在身体侧（`body/live_state.ts`：读 mineflayer bot，产出一份 LiveState），
 * 渲染在大脑侧（把快照拼成给模型看的文本块）。两边只共用这一份类型和渲染器——
 * 文本必须逐字一致，所以渲染器不能各写一份。
 *
 * 本文件不许 import 身体或大脑的任何实现。
 */
import type { PlanTodo } from './plan.js';

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
   * 主手耐久的**原始读数**（已用 NBT damage / 上限），用来诊断也用来显示。
   *
   * 模型报过"耐久剩余 0%"但工具明显没坏（挖了 36 格），而 `prismarine-item` 的
   * `durabilityUsed` 是 getter，读不到 NBT 时会退化成 0 或 max，容易把"读不到"
   * 说成"快报废"。绝对数摆出来（`耐久 37/251`）比百分比更抗歧义：模型不用自己
   * 乘上限就知道还能挖几格；上限读不到时也能一眼看出是读数问题。
   */
  mainHandDurabilityUsed: number | null;
  mainHandDurabilityMax: number | null;
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
  /**
   * 在线玩家名（不含自己）。
   *
   * **不渲染**——`LIVE_SECTION_KEYS` 里没有它，所以它不进提示词、不动 prompt cache。
   * 它的用途是任务布置（`teleportBots` 要把 bot 传送到人类玩家身边）：
   * 那是"问身体要一个事实"，而世界快照本来就是大脑要事实的地方——
   * 不必为此多开一条协议指令。
   */
  players: string[];
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

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function dist3(
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
  // **通关路线上的三个关键方块。** 真机上黑曜石下界门就在 1.9 米外，快照里却
  // 只列铜矿/煤矿，模型据此判断"门不在附近"并去质疑队友坐标（Feedback #28）。
  // 要塞的 nether_bricks、末地传送门框 end_portal_frame 同理：看不见就等于没有。
  'obsidian', 'nether_bricks', 'end_portal_frame',
]);

/**
 * KEY_BLOCKS 的集合视图：热路径上每个有名字的方块都要查一次（每轮约 27 万次
 * 迭代），线性 `Array.includes` 扫 38 个字符串太浪费。对外仍导出数组，契约不变。
 */
export const KEY_BLOCK_SET: ReadonlySet<string> = new Set(KEY_BLOCKS);

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

/**
 * 主手耐久后缀。**绝对读数必须给出来**：只有百分比时，模型要自己乘上限
 * 才知道还能挖几格；上限读不到（`max <= 1`，读到的是 stackSize）时百分比
 * 是 null、整段后缀消失——「铁镐用了几百格无声消失」就是这么来的
 * （Feedback #40）。现在能算就写 `耐久 37/251，还剩 214，85%`；
 * 只有原始读数就写明"上限读不到"，不假装能算。
 */
function heldDurabilitySuffix(h: LiveHeld): string {
  const used = h.mainHandDurabilityUsed;
  const max = h.mainHandDurabilityMax;
  if (used != null && max != null && max > 1) {
    const remain = Math.max(0, max - used);
    const pct = h.mainHandDurability != null ? `，${Math.round(h.mainHandDurability * 100)}%` : '';
    return `（耐久 ${used}/${max}，还剩 ${remain}${pct}）`;
  }
  if (used != null || max != null) {
    return `（耐久读数 used=${used ?? '?'} max=${max ?? '?'}——上限读不到，算不出剩余）`;
  }
  return '';
}

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
      `Held: main ${h.mainHand ?? 'empty'}${heldDurabilitySuffix(h)} ` +
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
