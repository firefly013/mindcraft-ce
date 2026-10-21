/*
 * L5 保命执行：scheduler 锁住动作通道之后，真正去逃命的那段代码。
 *
 * 分两层，泾渭分明：
 *   - 纯决策（shouldTrigger/pickBestFood/nearestThreat/fleeDestination）：
 *     不碰 bot，随便单测；
 *   - 执行循环（runEmergency）：只用 bot 的最小动作面
 *    （停火、定逃跑目标、吃东西），时钟与等待都可注入，
 *     单测用 stub bot + 假时钟。
 *
 * 逃跑策略：停下一切，朝远离最近威胁的方向定一个逃跑点，
 * 吃一口手头回饱和最高的食物，然后每 tick 看一次——32 格内
 * 无威胁且连续 10 秒没掉血才算逃出来。提前收工会把控制权
 * 交还到危险里，所以这里故意没有超时：要么安全，要么死了。
 * （common-sense 插件负责着火/摔落这类瞬间反射，本模块负责
 *  带状态机的持续逃亡与进食：判断安全、选路、选食。）
 */

export const TRIGGER_FRACTION = 0.3;
export const DEFAULT_MAX_HEALTH = 20;
export const THREAT_RADIUS = 32;
export const FLEE_DISTANCE = 24;
export const SAFE_SECONDS = 10;

/** **逃跑反射的硬上限**（真机 2026-10-20：escape 空转 30+ 秒，bot 一边掉血
 * 一边被"横移到实心落点"，最后跑出 90 格远、连死三次）。
 * 一个不肯放弃的助手比没有助手更危险：到上限必须交还身体，并说清下一步。 */
export const FLEE_MAX_MS = 20_000;
export const FLEE_MAX_STEPS = 20;
/** 连续掉血这么多 tick 且找不到验证过的落点 ⇒ 交还身体。 */
export const FLEE_HEALTH_DROP_TICKS = 3;

/** 始终敌对的名字（小写注册名）。edges 的边沿检测复用这一份，不再各抄一份。 */
export const ALWAYS_HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper',
  'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube',
  'ghast', 'blaze', 'piglin_brute', 'hoglin', 'zoglin', 'phantom',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
  'guardian', 'elder_guardian', 'shulker', 'endermite', 'silverfish',
  'warden', 'breeze',
]);

/** 饱食度/饱和度（原版数值；表里没有的食物排最后）。**规范名写一份**，别名由下面展开。 */
const FOOD_VALUES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  hay_block: [20, 20],
  rabbit_stew: [10, 12],
  cooked_beef: [8, 12.8],
  cooked_porkchop: [8, 12.8],
  golden_carrot: [6, 14.4],
  cooked_chicken: [6, 7.2],
  cooked_mutton: [6, 9.6],
  cooked_salmon: [6, 9.6],
  beetroot_soup: [6, 7.2],
  mushroom_stew: [6, 7.2],
  suspicious_stew: [6, 7.2],
  honey_bottle: [6, 1.2],
  cooked_rabbit: [5, 6],
  cooked_cod: [5, 6],
  bread: [5, 6],
  baked_potato: [5, 6],
  golden_apple: [4, 9.6],
  enchanted_golden_apple: [4, 9.6],
  chorus_fruit: [4, 2.4],
  apple: [4, 2.4],
  carrot: [3, 3.6],
  raw_beef: [3, 1.8],
  raw_porkchop: [3, 1.8],
  raw_rabbit: [3, 1.8],
  spider_eye: [2, 3.2],
  raw_chicken: [2, 1.2],
  raw_mutton: [2, 1.8],
  melon_slice: [2, 1.2],
  poisonous_potato: [2, 1.2],
  cookie: [2, 0.4],
  sweet_berries: [2, 0.4],
  glow_berries: [2, 0.4],
  raw_cod: [2, 0.4],
  raw_salmon: [2, 0.4],
  dried_kelp: [1, 0.6],
  potato: [1, 0.6],
  beetroot: [1, 1.2],
  rotten_flesh: [4, 0.8],
  tropical_fish: [1, 0.2],
  pufferfish: [1, 0.2],
});

/**
 * 同一件东西的两个名字：**1.13 去掉了 `raw_` 前缀，1.21.2 又加回来**。
 *
 * 真机事故（overnight_b 15:58）：`consume(mutton)` 吃的就是羊肉，而这张表里只有
 * `raw_mutton`——于是 `countFood` 数不到手上的 mutton、`pickBestFood` 给它 0 分，
 * `prepareBlaze` 会**一边拿着食物一边报"背包没有食物"**。这类"静默算错生存数值"
 * 是最贵的 bug：模型据此判断没吃的了，然后饿着肚子去打架。
 *
 * 别名在下面**展开进 `FOOD_VALUE`**（值引用同一份元组，永不漂移），所以旧调用点
 * （`FOOD_VALUE[name]`、`Object.keys(FOOD_VALUE)`）自动变正确；需要判断"能不能吃"
 * 的新代码一律走 `foodValueOf()`。
 */
export const FOOD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // 1.13–1.21.1 的短名 → 表里的规范名（熟食两代同名，本来就在表里，不需要别名）
  mutton: 'raw_mutton',
  beef: 'raw_beef',
  porkchop: 'raw_porkchop',
  chicken: 'raw_chicken',
  cod: 'raw_cod',
  salmon: 'raw_salmon',
  rabbit: 'raw_rabbit',
});

function expandAliases(): Record<string, readonly [number, number]> {
  const out: Record<string, readonly [number, number]> = {};
  for (const [alias, canonical] of Object.entries(FOOD_ALIASES)) {
    const value = FOOD_VALUES[canonical];
    if (value != null) out[alias] = value; // 同一个元组引用：两代名字不可能漂移
  }
  return out;
}

/** 饱食度/饱和度（原版数值；**别名已展开**：`mutton` 与 `raw_mutton` 都在表里）。 */
export const FOOD_VALUE: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  ...FOOD_VALUES,
  ...expandAliases(),
});

/** 物品名归一化：去命名空间、去空白、转小写（`minecraft:Raw_Mutton ` → `raw_mutton`）。 */
export function normalizeFoodName(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase().replace(/^minecraft:/, '') : '';
}

/**
 * 这个物品能不能吃（返回 `[饥饿值, 饱和度]`）；不能吃返回 null。
 *
 * **唯一的查表入口**：别名已经展开进 `FOOD_VALUE`，所以这里就是一次查表——
 * 各处（生存评估、紧急进食、consume 回执）都别再自己维护"什么算食物"的第二张表。
 */
export function foodValueOf(name: unknown): readonly [number, number] | null {
  const key = normalizeFoodName(name);
  if (key === '') return null;
  return FOOD_VALUE[key] ?? null;
}

/**
 * 生食 → 熟食（同一个"生肉只有一半价值"的真源，别再各处抄）。
 *
 * 用途：生存报告与 consume 回执要推"先烤再吃"（生牛排 3 点 vs 熟牛排 8 点），
 * 而判断"这是不是生的"必须和食物表同源——两代名字（`mutton` / `raw_mutton`）都认。
 */
export const COOKED_COUNTERPART: Readonly<Record<string, string>> = Object.freeze({
  raw_beef: 'cooked_beef',
  beef: 'cooked_beef',
  raw_porkchop: 'cooked_porkchop',
  porkchop: 'cooked_porkchop',
  raw_chicken: 'cooked_chicken',
  chicken: 'cooked_chicken',
  raw_mutton: 'cooked_mutton',
  mutton: 'cooked_mutton',
  raw_rabbit: 'cooked_rabbit',
  rabbit: 'cooked_rabbit',
  raw_cod: 'cooked_cod',
  cod: 'cooked_cod',
  raw_salmon: 'cooked_salmon',
  salmon: 'cooked_salmon',
  raw_fish: 'cooked_cod',
});

/** 生的（需要烤）→ 返回熟食名；本来就是熟食/不是肉 → null。 */
export function cookedCounterpartOf(name: unknown): string | null {
  const key = normalizeFoodName(name);
  if (key === '') return null;
  return COOKED_COUNTERPART[key] ?? null;
}

/** 是不是"生的"（能烤出更高价值的那种）。 */
export function isRawFood(name: unknown): boolean {
  return cookedCounterpartOf(name) != null;
}

/** 从 bot 读世界难度（0 和平 / 1 简单 / 2 普通 / 3 困难）；读不到 null。 */
export function difficultyOf(bot: any): number | null {
  const raw = bot?.game?.difficulty;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * "这个难度下会不会饿死"的一句话（给低血/低粮报告与 consume 的存粮提醒用）。
 *
 * 为什么值得写清楚：饿到食物 <18 就不能回血、血少时一次挨打就没了，模型会因此**恐慌性清空存粮**
 * ——而 Easy/Normal 下饿本身并不会把人饿死（Easy 停在 5 点血、Normal 停在半颗心），
 * 真正致命的是"不能回血 + 挨打"。两件事分开说，它才不会在做决定时用力过猛。
 * 读不到难度就**什么都不说**（不猜）。
 */
export function starvationNote(difficulty: number | null | undefined): string {
  if (difficulty == null || !Number.isFinite(difficulty)) return '';
  switch (Math.round(difficulty)) {
    case 0:
      return '和平难度不会饿：饱食度根本不掉。';
    case 1:
      return '另外：**Easy 难度饿不死人**（饿到 5 点血就不再掉），但饿着不能回血、也扛不住任何一击——别慌着把存粮一次吃光。';
    case 2:
      return '另外：Normal 难度饿不死人（饿到半颗心就停），但那点血挨一下就没了——别慌着清空存粮。';
    case 3:
      return '另外：**Hard 难度会真的饿死**（掉到 0），别拖。';
    default:
      return '';
  }
}

/** 血量掉到 max*0.3 以下就触发。死了（0）不逃：上报，不跑。 */
export function shouldTriggerEmergency(
  health: unknown,
  maxHealth: number = DEFAULT_MAX_HEALTH,
): boolean {
  if (typeof health !== 'number' || !Number.isFinite(health)) return false;
  return health > 0 && health < maxHealth * TRIGGER_FRACTION;
}

/** 按饱和度（再按饥饿）挑身上的食物；表外食物排零分。 */
export function pickBestFood(names: string[]): string | null {
  let best: { name: string; score: number } | null = null;
  for (const name of names) {
    // 走 foodValueOf：两代物品名（mutton / raw_mutton）都认，熟食自然排在生食前面。
    const value = foodValueOf(name) ?? [0, 0];
    const score = value[1] * 100 + value[0];
    if (best == null || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

export interface ThreatEntity {
  id: number;
  name: string;
  hostile?: boolean | null;
  position: { x: number; y: number; z: number } | null;
}

export function isHostile(name: string, flag?: boolean | null): boolean {
  if (flag === true) return true;
  if (flag === false) return false;
  return ALWAYS_HOSTILE.has(name.toLowerCase());
}

/** 威胁半径内最近的敌对实体（最近优先）。 */
export function nearestThreat(
  entities: ThreatEntity[],
  feet: { x: number; y: number; z: number },
  radius: number = THREAT_RADIUS,
): { entity: ThreatEntity; distance: number } | null {
  let best: { entity: ThreatEntity; distance: number } | null = null;
  for (const entity of entities) {
    if (entity?.position == null) continue;
    if (!isHostile(entity.name ?? '', entity.hostile)) continue;
    const distance = Math.hypot(
      entity.position.x - feet.x,
      entity.position.y - feet.y,
      entity.position.z - feet.z,
    );
    if (distance <= radius && (best == null || distance < best.distance)) {
      best = { entity, distance };
    }
  }
  return best;
}

/** 脚下沿远离威胁方向 FLEE_DISTANCE 格的逃跑点（XZ）。 */
export function fleeDestination(
  feet: { x: number; z: number },
  threat: { x: number; z: number },
  distance: number = FLEE_DISTANCE,
): { x: number; z: number } {
  let dx = feet.x - threat.x;
  let dz = feet.z - threat.z;
  if (dx === 0 && dz === 0) {
    dx = 1;
    dz = 0;
  }
  const norm = Math.hypot(dx, dz);
  return {
    x: Math.floor(feet.x + (dx / norm) * distance),
    z: Math.floor(feet.z + (dz / norm) * distance),
  };
}

export interface EmergencyBot {
  health: number;
  inventoryNames(): string[];
  feet(): { x: number; y: number; z: number } | null;
  threats(): ThreatEntity[];
  stopAll(): void;
  fleeTo(x: number, z: number): void;
  eat(food: string): Promise<void>;
  /**
   * 头是不是泡在水里（真正淹没）。**可选**：不实现就当没溺水这回事。
   *
   * 为什么要单独一条：模型真机被淹死 5 次，每次都收到 L5 溺水事件，但
   * runEmergency 只处理"威胁"和"吃"——**根本没有溺水分支**，事件响了没人管。
   */
  submerged?(): boolean;
  /** 往上浮（在水里连跳 + 抬头）。可选，配合 submerged 用。 */
  swimUp?(): void;
  /**
   * 朝某个**水平**坐标游/走一步（水里就是朝岸上游）。可选。
   *
   * 为什么必须有它：2026-10-21 全量日志统计——两个 bot 各 78% 的死亡是 drowned，
   * 其中 88% 发生在水面高度、71% 死亡瞬间**没有任何正在执行的动作**。
   * 旧 `runSurface` 只会 `swimUp`（按 jump 浮起来）：**浮着不动 ≠ 上岸**，
   * 反射一结束就交还身体，模型不动，于是又沉下去。
   * 有了这条，反射才能真的把人往最近的干地上带。
   */
  moveToward?(x: number, z: number): void;
  /** 附近最近的"能站人的干地"（水面同高、实体方块、上方是空气）。可选。 */
  nearestDryLand?(radius: number): { x: number; z: number } | null;
  /** 脚下方块名（lava 反射用）。 */
  feetBlockName?(): string | null;
  /** 头所在方块名（lava 反射用）。 */
  headBlockName?(): string | null;
  /** 最近岩浆的水平坐标（lava 反射用来选逃跑方向）。 */
  lavaNear?(): { x: number; z: number } | null;
  /**
   * 保命是不是被模型关掉了（`!disableSafeguards`）。**可选**：不实现 = 没关。
   *
   * 关掉之后连溺水都不再上浮 —— 用户要的就是这个字面意思："角色会一直在水里
   * 泡着"。模型自己签了生死状，我们不替它反悔。
   */
  safeguardsOff?(): boolean;
  /** **验证过的**逃跑落点存在吗？没有时"横移"就是往虚空/怪堆里送。可选。 */
  hasSafeDestination?(): boolean;
  /** 该立刻交还身体吗（例如：刚死过且身上没东西，再逃也只是再死一次）。可选。 */
  shouldYieldEscape?(): { yield: boolean; reason: string } | null;
  /** 进度/放弃时的回执（身体负责写渠道；循环只提供事实）。可选。 */
  reportProgress?(info: { step: number; ms: number; health: number; safeDestination: boolean; final: string | null }): void;
}

export interface EmergencyResult {
  escaped: boolean;
  /** 新增的三种是**引擎主动交还身体**的原因（带 next steps 回执）。 */
  reason:
    | 'safe'
    | 'died'
    | 'no-bot'
    | 'no-safe-destination-and-losing-health'
    | 'step-cap'
    | 'time-cap'
    | `yield:${string}`;
  position?: { x: number; y: number; z: number } | null;
  health?: number | null;
}

/**
 * 这次保命**要处理的具体处境**。
 *
 * 为什么必须由调用方给：处理属于**事件类型**，不属于"等级 5"。旧实现把所有
 * L5 事件都丢进同一个循环，让循环进去以后再自己看一遍世界猜"我该浮还是该跑"
 * ——那样事件类型的信息在到达处理的那一刻就丢了，也没法给某一类事件换处理。
 *
 *   - `surface`：头在水里 → 只上浮，浮出来就结束。
 *   - `flee`：有威胁/危险 → 逃开、顺手吃一口，安全了结束。
 */
export type EmergencyIntent = 'surface' | 'flee' | 'lava';

/** 溺水：只要头还在水里就往上浮，浮出来就算处理完了。 */
/** 水面反射最多占身体多久：够它浮上来并在水面往岸边试，又不至于把模型锁死。 */
const SURFACE_MAX_MS = 12_000;

/**
 * 第几次"溺水自救"被触发。**只用来轮换游动方位**：扫不到岸时，
 * 第一次朝 +x、第二次 +z、第三次 −x、第四次 −z——重试几次就会覆盖不同方向，
 * 而不是永远朝同一片海游（固定方向的优点是可预期、可测试，缺点是一开始可能选错方向）。
 */
let surfaceAttemptCount = 0;

async function runSurface(
  bot: EmergencyBot,
  io: { tickMs: number; sleep: (ms: number) => Promise<void> },
): Promise<EmergencyResult> {
  bot.stopAll();
  // **保命被关掉就不碰身体**：模型明确表示这几步自己负责，别抢方向盘。
  if (bot.safeguardsOff?.() === true) {
    return { escaped: false, reason: 'safe', position: bot.feet(), health: bot.health };
  }
  const surfaceStartedAt = Date.now();
  // **游向岸要"记住一个方向"**（2026-10-21 第二轮实测：第一版每 tick 都扫一次
  // `nearestDryLand(12)`——开阔水域里 12 格全是水，返回 null，于是退化成原地 swimUp，
  // 12 秒超时、交还身体、再沉下去，人照样淹死）。
  // 现在两条一起改：① 每 SURFACE_SCAN_EVERY_TICKS 才扫一次，半径放大到 24（节流防拖 TPS）；
  // ② 扫不到岸就按一个**固定方位**持续游（不再每 tick 重算导致原地摆动）——
  //    方位按"第几次触发"轮换，这样重试几次就会覆盖不同方向，而不是永远朝同一片水游。
  const SURFACE_SCAN_EVERY_TICKS = 5;
  const SURFACE_SCAN_RADIUS = 24;
  const headings = [
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 },
  ];
  const heading = headings[surfaceAttemptCount++ % headings.length];
  let shore: { x: number; z: number } | null = null;
  let tick = 0;
  for (;;) {
    tick += 1;
    if (bot.health <= 0) return { escaped: false, reason: 'died' };
    // **"头露出水面"不等于脱险**（2026-10-21 数据修正）。
    // 全量日志统计：overnight_a 78% 的死亡、overnight_b 78% 的死亡是 drowned，
    // 其中 238/269 有坐标的溺亡发生在 y>=55（水面高度），**192/269 死亡瞬间
    // currentAction 为空**——不是死在赶路，是漂在水里慢慢淹死。
    // 旧判据只要 `submerged !== true` 就 return escaped:true：在汪洋中间浮着也算"安全"，
    // 反射立刻结束、身体交还模型、模型没有动作、于是再沉下去——这就是那 192 条的来历。
    // 新判据：**头不淹 且 脚下不是水** 才算真的到了岸上/干地。
    const headClear = bot.submerged?.() !== true;
    const feetName = bot.feetBlockName?.() ?? null;
    const standingInWater = feetName === 'water' || feetName === 'flowing_water'
      || feetName === 'bubble_column';
    if (headClear && !standingInWater) {
      bot.stopAll?.();
      return { escaped: true, reason: 'safe', position: bot.feet(), health: bot.health };
    }
    // 还在水里（浮着或泡着）就继续上浮/往岸边探；但有**时间上限**，
    // 不许为了"一定上岸"把身体无限占住（2026-10-18 的反射↔模型抢身体就是这么死的）。
    if (Date.now() - surfaceStartedAt > SURFACE_MAX_MS) {
      bot.stopAll?.();
      return {
        escaped: false,
        reason: 'time-cap',
        position: bot.feet(),
        health: bot.health,
      };
    }
    // **先找岸再浮**（节流：每 5 tick 才扫一次，扫到就记住不再重扫）。
    if (!shore && tick % SURFACE_SCAN_EVERY_TICKS === 0) {
      shore = bot.nearestDryLand?.(SURFACE_SCAN_RADIUS) ?? null;
    }
    if (bot.moveToward) {
      const target = shore ?? (() => {
        // 没有岸：按固定方位持续游，靠移动本身走出水域。
        const feet = bot.feet();
        if (!feet) return null;
        const reach = SURFACE_SCAN_RADIUS;
        return { x: feet.x + heading.x * reach, z: feet.z + heading.z * reach };
      })();
      if (target) bot.moveToward(target.x, target.z);
      else bot.swimUp?.();
    } else {
      bot.swimUp?.();
    }
    await io.sleep(io.tickMs);
  }
}

/**
 * 岩浆脱困：立刻 stopAll（模型动作被 forceStopBody 打断），
 * 然后往上跳/往远离最近岩浆的方向逃，直到脚/头不再是岩浆。
 */
async function runLavaEscape(
  bot: EmergencyBot,
  io: { tickMs: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<EmergencyResult> {
  bot.stopAll();
  if (bot.safeguardsOff?.() === true) {
    return { escaped: false, reason: 'safe', position: bot.feet(), health: bot.health };
  }
  const started = io.now();
  for (;;) {
    const feetName = bot.feetBlockName?.() ?? null;
    const headName = bot.headBlockName?.() ?? null;
    if (feetName !== 'lava' && headName !== 'lava') {
      return { escaped: true, reason: 'safe', position: bot.feet(), health: bot.health };
    }
    // 先往上：浅岩浆池跳出来就安全了。
    bot.swimUp?.();
    // 再往远离最近岩浆的方向逃一段。
    const near = bot.lavaNear?.();
    const feet = bot.feet();
    if (feet != null) {
      if (near != null) {
        const dx = feet.x - near.x;
        const dz = feet.z - near.z;
        const len = Math.hypot(dx, dz) || 1;
        bot.fleeTo(feet.x + (dx / len) * 4, feet.z + (dz / len) * 4);
      } else {
        bot.fleeTo(feet.x + 4, feet.z + 4);
      }
    }
    if (io.now() - started > 8000) {
      return { escaped: false, reason: 'safe', position: bot.feet(), health: bot.health };
    }
    await io.sleep(io.tickMs);
  }
}

/**
 * 跑一次逃亡到安全为止。时间与等待可注入，单测用假时钟。
 * 吃东西只吃一口（escape 期间就一次），吃是顺手，人跑路是正事。
 */
export async function runEmergency(
  bot: EmergencyBot | null,
  opts: {
    tickMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** 要处理的处境。不给 = 旧行为（先看溺水再看威胁），只为兼容旧调用点。 */
    intent?: EmergencyIntent;
  } = {},
): Promise<EmergencyResult> {
  if (bot == null) return { escaped: false, reason: 'no-bot' };
  const tickMs = opts.tickMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  // 处理是**按事件类型**选定的：溺水归溺水，威胁归威胁，不互相代劳。
  if (opts.intent === 'surface') return runSurface(bot, { tickMs, sleep });
  if (opts.intent === 'lava') return runLavaEscape(bot, { tickMs, sleep, now });

  bot.stopAll();

  const startHealth = bot.health;
  const startedAt = now();
  let step = 0;
  let dropStreak = 0;
  let lastHealth: number | null = startHealth;
  let lastHurtAt = now();
  let ate = false;

  for (;;) {
    const health = bot.health;
    if (health <= 0) return { escaped: false, reason: 'died' };
    if (lastHealth != null && health < lastHealth) lastHurtAt = now();
    // **有界 + 可让位**（真机 2026-10-20）：掉血且没有验证过的落点 ⇒ 立刻交还身体。
    dropStreak = lastHealth != null && health < lastHealth ? dropStreak + 1 : 0;
    step += 1;
    const elapsed = now() - startedAt;
    const safeDestination = bot.hasSafeDestination?.() !== false;
    const yieldNow = bot.shouldYieldEscape?.() ?? null;
    // 只有调用方提供了"落点验证/交还判定"才启用这套有界逻辑（老调用方保持原语义）。
    const bounded = typeof bot.hasSafeDestination === 'function' || typeof bot.shouldYieldEscape === 'function';
    const giveUpReason = ((): EmergencyResult['reason'] | null => {
      if (!bounded) return null;
      if (yieldNow != null && yieldNow.yield) return `yield:${yieldNow.reason}` as EmergencyResult['reason'];
      if (!safeDestination && dropStreak >= FLEE_HEALTH_DROP_TICKS) return "no-safe-destination-and-losing-health";
      if (step >= FLEE_MAX_STEPS) return "step-cap";
      if (elapsed >= FLEE_MAX_MS) return "time-cap";
      return null;
    })();
    if (giveUpReason != null) {
      bot.reportProgress?.({ step, ms: elapsed, health, safeDestination, final: giveUpReason });
      return { escaped: false, reason: giveUpReason };
    }
    if (bounded && step % 3 === 1) bot.reportProgress?.({ step, ms: elapsed, health, safeDestination, final: null });
    lastHealth = health;

    // **溺水：先把头露出水面，别的统统排后面。**
    //
    // 这一支以前完全没有——`EmergencyBot` 里声明了 `submerged()` / `swimUp()`
    // 却从来没被调用过，于是真机被淹死 5 次：L5 事件响了，循环只问"有没有怪"
    // 和"饿不饿"，人在水里照样往下掉血。
    //
    // 为什么要把后面的逃跑和吃东西一并跳过（`continue`）：水平逃跑在溺水面前
    // 没有意义，人还在水里，氧气照样掉；吃东西同理。浮起来这几秒里做任何别的
    // 事，都是在给自己增加氧气的债。
    //
    // 顺带这也保证了不会误判成"安全"——跳过 `escaped` 那道判断，必须真的把头
    // 露出来才会回到正常流程。
    // **只有"没指定处境"时才在这里兜溺水**：溺水有自己的事件类型和
    // 自己的处理（`intent: 'surface'`），不该由逃跑循环顺手代劳。
    if (opts.intent !== 'flee' && bot.submerged?.() === true) {
      // **保命被关掉就不碰身体** —— 模型明确表示这几步自己负责，别抢方向盘。
      // 放在这里而不是外面，是为了保住"关了保命也照样跑别的保命（ fleeTo / 吃）"
      // 这种语义：关掉的只是**这条**上浮反射，不是整个 emergency。
      if (bot.safeguardsOff?.() !== true) {
        bot.swimUp?.();
        await sleep(tickMs);
        continue;
      }
    }

    const feet = bot.feet();
    const threat = feet != null ? nearestThreat(bot.threats(), feet) : null;
    if (feet != null) {
      if (threat != null) {
        const dest = fleeDestination(feet, threat.entity.position as { x: number; z: number });
        bot.fleeTo(dest.x, dest.z);
      }
      if (!ate) {
        ate = true;
        const food = pickBestFood(bot.inventoryNames());
        if (food != null) {
          try {
            await bot.eat(food);
          } catch {
            // 吃是顺手，噎着也不影响逃跑。
          }
        }
      }
    }

    if (threat == null && now() - lastHurtAt >= SAFE_SECONDS * 1000) {
      return { escaped: true, reason: 'safe', position: bot.feet(), health };
    }
    await sleep(tickMs);
  }
}

export default {
  runEmergency,
  shouldTriggerEmergency,
  pickBestFood,
  nearestThreat,
  fleeDestination,
  TRIGGER_FRACTION,
  DEFAULT_MAX_HEALTH,
  THREAT_RADIUS,
  FLEE_DISTANCE,
  SAFE_SECONDS,
};
