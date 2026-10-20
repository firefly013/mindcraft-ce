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
  /** **背包数据是否已经同步过**：false = 刚重连、还没收到背包包，空/空手都不可信。 */
  synced?: boolean;
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
  /**
   * 读到过一个**无效**的耐久上限（真机 `stone_pickaxe max=1`）。
   *
   * 只用于诚实标注：渲染时绝不把那个假数字印出来（模型会把 `max=1` 当成
   * "总耐久 1 次"），但也不能假装什么都没读到——所以要能说
   * "上限读不到（读到的值无效，已忽略）——算不出剩余"。
   */
  mainHandDurabilityMaxInvalid?: boolean;
}

export interface LiveBackpack {
  /** 同 `LiveHeld.synced`：false = 还没同步，禁止把 items=[] 读成"背包空了"。 */
  synced?: boolean;
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
  /**
   * 这张图**能不能当"世界的样子"用**（渲染器版本落后时方块会画成「?」，模型会读成"虚空"）。
   *
   * `line` 非空时**必须**跟着图一起给模型看 —— 这是"不许把坏帧当可信视图"的落点；
   * 可信时 `line` 为空（零噪音）。
   *
   * `usable` / `verdict` 是**裁决**：`usable === false` 时把 `verdict` 直接拼进
   * `Screenshot:` 那一行 —— 模型不必每帧自己推断"这图能不能认方块"
   * （overnight_b：把恶地岩壁当树冠、把锻造台当传送门框架，花了多轮在猜）。
   */
  trust?: { trusted: boolean; line: string; reason: string; usable?: boolean; verdict?: string } | null;
  /**
   * **这一帧自己的朝向**（拍摄那一刻记录的，弧度）。
   *
   * 必须是"这一帧"的，不能是"现在身体朝哪"——真机事故：快照文字说"朝天空（pitch −88°）"、
   * 图里却是水平隧道 ⇒ bot 正确地不信图、把一张好画面丢掉。`null`/缺失 ⇒ 回执**什么都不说**，
   * 绝不拿当前朝向顶替。
   */
  view?: { yaw: number | null; pitch: number | null } | null;
  /**
   * **这一帧有没有颜色**（渲染后量的平均彩度 `|R−G|+|G−B|`，0~510）。
   *
   * 真机 overnight_b：同一会话里颜色时有时无（画面清晰可读却全灰）。这是一个**独立事实**，
   * 不能混进"可不可信"：丢颜色的图**认方块可以**，只是**别靠颜色认材质**。
   * `null`/缺失 ⇒ 没测 ⇒ 回执不提名。
   */
  color?: { chromaMean: number; grayscale: boolean } | null;
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
 * **仰角/俯角超过它就"画面里基本没有地面"**。
 *
 * 量化依据：MC 默认垂直视场角 ≈ 70°（半角 35°）⇒ 视线抬高超过半角，地平线就出画面、
 * 整张图只剩天空。真机那次 pitch ≈ −87°~−90° 正是这一类（画面本来就该是纯天空）。
 */
export const SKY_PITCH_DEG = -35;
/** 低于这个角度就是"几乎垂直向下"：只能看到脚下几格，判断远处地形不可靠。 */
export const DOWN_PITCH_DEG = 70;

/**
 * **这张截图到底在拍什么**（纯函数）。
 *
 * 只回答"视线方向"这一个问题：pitch 度数 + 俯仰措辞 + 朝向罗盘。
 *
 * **三种"没有这一行"必须能区分开**（Lead 2026-10-20 裁定）：
 *   - 平视 ⇒ 返回 `null`（**真的平静**，零噪音）；
 *   - 仰视/俯视到看不清地面 ⇒ 给一行（上面两种分支）；
 *   - **读不到 pitch/yaw ⇒ 必须给一行"读不到"** —— 不许让"测不出来"冒充"平视"。
 *     同一份请求里另一条沉默（渲染行）也有同样的规矩：可信只能是"可验证的全 exact"，
 *     绝不能因为"没测出来"。两条沉默**理由不同、必须可分辨**，否则将来"都没说话但画面是错的"
 *     就查不出是哪一边。
 *
 * 单位：mineflayer 的 `entity.pitch` / `entity.yaw` 是**弧度**；pitch 负 = 抬头（向上为 -90°）。
 */
export function describeViewDirection(pitch: unknown, yaw: unknown): string | null {
  // **`null` 不是 0**：`Number(null) === 0` ⇒ 直转会把"没读到"读成"平视"（就是今晚那条
  // fail-open 的同款坑）。先判类型，再谈数值。
  if (pitch == null || yaw == null) {
    return `视线：**读不到**（pitch/yaw 读数不可用）⇒ **不要假设现在是平视**；判断地形前先看 Position 行，或先 \`stats(type="body")\`。`;
  }
  const p = Number(pitch);
  const y = Number(yaw);
  if (!Number.isFinite(p) || !Number.isFinite(y)) {
    // **读不到 ≠ 平视**：说清"读不到"，否则这一行永远说不出自己是不是被跳过了。
    return `视线：**读不到**（pitch/yaw 读数不可用）⇒ **不要假设现在是平视**；判断地形前先看 Position 行，或先 \`stats(type="body")\`。`;
  }
  const pitchDeg = (p * 180) / Math.PI;
  // MC yaw：0 = +z = 南；朝向向量 = (-sin yaw, cos yaw)。
  const compass = compassOf(-Math.sin(y), Math.cos(y));
  if (pitchDeg <= SKY_PITCH_DEG) {
    return (
      `视线：**朝天空**（pitch ${pitchDeg.toFixed(0)}°，仰视，朝 ${compass}）——` +
      '画面里基本没有地面，**这时的截图不能用来判断地形/挖向**（纯天空色是正常的），看 near key blocks。'
    );
  }
  if (pitchDeg >= DOWN_PITCH_DEG) {
    return (
      `视线：**几乎垂直向下**（pitch +${pitchDeg.toFixed(0)}°，俯视，朝 ${compass}）——` +
      '只能看到脚下几格，判断远处地形/走位不可靠。'
    );
  }
  return null; // 平视：**这一种**沉默才是一个字都不加
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
 * 才知道还能挖几格；上限读不到（`max <= 1`，真机拿到过 `stone_pickaxe max=1`）
 * 时百分比是 null、整段后缀消失——「铁镐用了几百格无声消失」就是这么来的
 * （Feedback #40）。现在能算就写 `耐久 37/251，还剩 214，85%`；
 * **上限无效时绝不把那个假数字印出来**（模型会把 `max=1` 当成"总耐久 1 次"），
 * 只如实说"上限读不到——算不出剩余"。
 */
function heldDurabilitySuffix(h: LiveHeld): string {
  const used = h.mainHandDurabilityUsed;
  const max = h.mainHandDurabilityMax;
  if (used != null && max != null && max > 1) {
    const remain = Math.max(0, max - used);
    const pct = h.mainHandDurability != null ? `，${Math.round(h.mainHandDurability * 100)}%` : '';
    return `（耐久 ${used}/${max}，还剩 ${remain}${pct}）`;
  }
  if (used != null) {
    const bogus = h.mainHandDurabilityMaxInvalid === true ? '（读到的上限是无效值，已忽略）' : '';
    return `（耐久读数 used=${used}，上限读不到${bogus}——算不出剩余次数）`;
  }
  if (max != null) {
    return `（耐久上限 ${max}，但已用读数读不到——算不出剩余次数）`;
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
    // **"不知道"不许写成"空"**（真机 2026-10-18：进程重启后第一份快照读成
    // `Held: main empty` / `Backpack: empty`，而物品其实一直在——玩家数据里
    // dirt×11 好端端躺着，模型据此以为自己丢了全部家当，从零开始重新采集）。
    if (h.synced === false) {
      return [
        'Held: main 还没同步上来（刚重连，**不是空的**，别据此判断手上没东西） ' +
          'off 还没同步 armor 还没同步',
      ];
    }
    return [
      `Held: main ${h.mainHand ?? 'empty'}${heldDurabilitySuffix(h)} ` +
        `off ${h.offHand ?? 'empty'} armor ${h.armor.length > 0 ? h.armor.join('/') : 'none'}`,
    ];
  },
  backpack: (s) => {
    if (s.backpack.synced === false) {
      return [
        'Backpack: **还没同步上来（刚重连，不是空的）**——物品还在，别据此重采/重做/判定丢东西；' +
          '等一两秒再看 stats。',
      ];
    }
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
  /**
   * **视线方向**：判断"这张图现在到底在拍什么"。
   *
   * 真机（overnight_a）：pitch ≈ −87°~−90°（几乎垂直朝上）时两张截图整片是天空色，
   * bot 以为"渲染坏了/掉进虚空"，其实**画面是对的** —— 它缺的是"我现在朝上"这条元数据。
   * 所以：只有视线**不寻常**时才加这一行（俯仰超出临界角），平视时一个字都不加。
   * 这一行放在截图块里（下面 `screenshot` 段），因为它描述的是"这张图在拍什么"。
   */
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
      const head = `Screenshot: ${s.screenshot.ref.file} (taken ${Math.max(0, Math.round(age / 1000))}s ago)`;
      // **裁决写进第一行**（overnight_b：多轮靠猜"这图能不能信"，把恶地岩壁当树冠、
      // 把锻造台当传送门框架）。可靠性必须**被告知**，不能让模型每帧自己推断；
      // 数字也在这一行里，所以这个说法是可核对的。
      const trust = s.screenshot.trust;
      const verdict = trust != null && trust.usable === false ? (trust.verdict ?? '') : '';
      const lines = [`${head}${verdict === '' ? '' : ` ${verdict}`}`];
      // **先说"这张图在拍什么"（上下文），再说"这张图可不可信"（怀疑）** —— 顺序是有意的：
      // 上下文明明可以把一张"全天空"的图解释清楚，先给怀疑会让模型把正常画面也当成坏的。
      //
      // **朝向只认这一帧自己的**（`screenshot.view`，拍摄时记录的）：绝不拿 `position.pitch`
      // 顶替 —— 那是"现在身体朝哪"，和图可能差好几秒（真机：文字说朝天空、图里是水平隧道）。
      // 没有这一帧的朝向 ⇒ **什么都不说**（宁可不说，也不说一个可能是假的朝向）。
      const view =
        s.screenshot.view != null
          ? describeViewDirection(s.screenshot.view.pitch, s.screenshot.view.yaw)
          : null;
      if (view != null) lines.push(view);
      // **颜色是独立事实，不并进"可不可信"**：丢颜色的图画质可读（认方块可以），
      // 只是不能靠颜色认材质（真机 overnight_b：同会话里全灰帧时有时无）。
      const color = s.screenshot.color;
      if (color != null && color.grayscale === true) {
        lines.push(
          `颜色：**这张图丢了颜色**（已测：无彩度，平均 |R−G|+|G−B| = ${color.chromaMean}）——` +
            '**认方块可以，但别靠颜色认材质/判断"这是不是同一种方块"**。',
        );
      }
      // 裁决为空串时（老数据/异常）回落到详细说明，**绝不静默**；
      // 但**可用**的帧一个字都不加（不误报 —— 否则视觉通道会被"每帧都警告"淹掉）。
      const line = trust?.line ?? '';
      if (trust != null && trust.usable === false && verdict === '' && line !== '') lines.push(line);
      return lines;
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
