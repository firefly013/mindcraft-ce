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

/** 始终敌对的名字（小写注册名）。edges 的边沿检测复用这一份，不再各抄一份。 */
export const ALWAYS_HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper',
  'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube',
  'ghast', 'blaze', 'piglin_brute', 'hoglin', 'zoglin', 'phantom',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
  'guardian', 'elder_guardian', 'shulker', 'endermite', 'silverfish',
  'warden', 'breeze',
]);

/** 饱食度/饱和度（原版数值；表里没有的食物排最后）。 */
export const FOOD_VALUE: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
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
    const value = FOOD_VALUE[name] ?? [0, 0];
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

function isHostile(name: string, flag?: boolean | null): boolean {
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
}

export interface EmergencyResult {
  escaped: boolean;
  reason: 'safe' | 'died' | 'no-bot';
  position?: { x: number; y: number; z: number } | null;
  health?: number | null;
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
  } = {},
): Promise<EmergencyResult> {
  if (bot == null) return { escaped: false, reason: 'no-bot' };
  const tickMs = opts.tickMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  bot.stopAll();

  const startHealth = bot.health;
  let lastHealth: number | null = startHealth;
  let lastHurtAt = now();
  let ate = false;

  for (;;) {
    const health = bot.health;
    if (health <= 0) return { escaped: false, reason: 'died' };
    if (lastHealth != null && health < lastHealth) lastHurtAt = now();
    lastHealth = health;

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
