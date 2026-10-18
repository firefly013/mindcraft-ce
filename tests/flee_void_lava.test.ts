/**
 * 逃生反射（fleeTo）的虚空/岩浆回归 —— 真机 2026-10-19 的 4 次同类死亡。
 *
 * 事实（已查证，这里不再重新论证）：
 *   - **末地小岛**（四周虚空）：enderman 一击 ⇒ `escape` 接管身体 ⇒ 身体朝"远离威胁"
 *     的方向**水平平移出岛**，x/z 冻在 88.5/-1.40、y 39 → -170 → -201.51，
 *     死因 `fell out of the world`。四次同因（此前 y -120/-139、-160.08、-108/-125），
 *     带甲不带甲都一样：这不是装备问题，是**落点选错**。
 *   - **下界**：躲 Hoglin 的 `escape` 最后 `tried to swim in lava`。
 *
 * 这里测的是**真实代码路径**，不是复制一份决策逻辑：
 *   `MineflayerBody.rescue('flee')` → `runEmergency` 的逃跑循环 → `fleeTo` 闭包
 *   （先刹车 / 没有安全落点就原地不动 / `GoalNear` 带上已验证的 y）
 *   → 真 pathfinder 的 `goals.GoalNear`、`Movements`。
 *
 * 假 bot 的规矩（这个仓库已经为"松假体"付过两次生产事故的学费）：
 *   - 方法名与参数形状照真 API：`blockAt` 只收 `Vec3`、`setGoal` 只收真 `Goal`、
 *     `setMovements` 只收真 `Movements` 实例、`setControlState` 只认真控制键；
 *   - **没实现的属性直接抛**，不静默返回 undefined —— `?.` 不该掩盖假体的缺口；
 *   - 断言"发生了什么"（真正发出去的 goal / 按键 / 回执），不是"打算做什么"。
 *     落点是否站得住，用**独立判据**复算（不复用 `assessStandingSpot`，免得自己批改
 *     自己的作业）。
 *
 * 时间：全部用假时钟推进，`advanceUntilSettled` 是**有界**的（到点没结束就返回
 * false，由断言明确报错，而不是让整个用例挂在 vitest 超时上）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import minecraftData from 'minecraft-data';
import pf from 'mineflayer-pathfinder';
// ⚠️ 必须用**具名**导出：`vec3` 的默认导出是工厂函数（`new` 它也能拿到 Vec3，
// 因为工厂返回 `new Vec3(...)`），但 `instanceof` 只认具名的那个类。
import { Vec3 } from 'vec3';
import { MineflayerBody, REFLEX_STOP_GRACE_MS } from '../src/body/mineflayer_body.js';

const REGISTRY: any = minecraftData('1.20.4');

// ── 地形与独立判据 ─────────────────────────────────────────────────────────

type Cells = Map<string, string>;

const cellKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const nameIn = (cells: Cells, x: number, y: number, z: number): string => cells.get(cellKey(x, y, z)) ?? 'air';

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air', '']);
/** 会杀死人的方块：`flee.ts` 的 HAZARD_NAMES 是同一份语义，这里独立列一遍。 */
const HAZARD_NAMES = new Set([
  'lava',
  'flowing_lava',
  'water',
  'flowing_water',
  'fire',
  'soul_fire',
  'magma_block',
  'cactus',
  'powder_snow',
]);

/**
 * 独立判据：这一格能不能**站住**（脚/头是空气、脚下是实心且不是危险方块）。
 *
 * 故意不调用生产的 `assessStandingSpot`：那是被测代码的判据，用它复算等于自证。
 */
function standsOnSolidGround(cells: Cells, x: number, y: number, z: number): boolean {
  const feet = nameIn(cells, x, y, z);
  const head = nameIn(cells, x, y + 1, z);
  const support = nameIn(cells, x, y - 1, z);
  return AIR_NAMES.has(feet) && AIR_NAMES.has(head) && !AIR_NAMES.has(support) && !HAZARD_NAMES.has(support);
}

/** 末地小岛：side×side 的石头平台（顶面 y=64），四周与下方都是虚空（air）。 */
function islandCells(side: number): Cells {
  const cells: Cells = new Map();
  const half = Math.floor(side / 2);
  for (let x = -half; x <= half; x++) {
    for (let z = -half; z <= half; z++) cells.set(cellKey(x, 64, z), 'stone');
  }
  return cells;
}

/** 下界岩浆岸：z ≥ 5 的地面是岩浆，其余是下界岩。 */
function netherShoreCells(): Cells {
  const cells: Cells = new Map();
  for (let x = -10; x <= 10; x++) {
    for (let z = -10; z <= 10; z++) cells.set(cellKey(x, 64, z), z >= 5 ? 'lava' : 'netherrack');
  }
  return cells;
}

/** 虚空：脚下什么都没有（末地岛外那一段）。 */
function voidCells(): Cells {
  return new Map();
}

/** 1×1 石柱：只有脚下一格实心，四周一步都站不住。 */
function pillarCells(): Cells {
  const cells: Cells = new Map();
  cells.set(cellKey(0, 64, 0), 'stone');
  return cells;
}

/** 脚已经踩进岩浆：脚格与脚下都是岩浆。 */
function lavaAtFeetCells(): Cells {
  const cells: Cells = new Map();
  cells.set(cellKey(0, 64, 0), 'lava');
  cells.set(cellKey(0, 65, 0), 'lava');
  return cells;
}

/** 开阔地：足够大，任何方向的落点都站得住。 */
function openFieldCells(): Cells {
  const cells: Cells = new Map();
  for (let x = -40; x <= 40; x++) {
    for (let z = -40; z <= 40; z++) cells.set(cellKey(x, 64, z), 'grass_block');
  }
  return cells;
}

// ── 假 bot：真 API 形状 + 未知即抛 ────────────────────────────────────────

const CONTROL_KEYS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']);
const MOVEMENT_KEYS = ['forward', 'back', 'left', 'right'];

type RecordedCall =
  | { op: 'setGoal'; goal: any }
  | { op: 'setMovements'; movements: any }
  | { op: 'goto' }
  | { op: 'pathfinder.stop' }
  | { op: 'control'; key: string; state: boolean }
  | { op: 'clearControlStates' }
  | { op: 'stopDigging' }
  | { op: 'cancelTask' };

/** mineflayer 实体形状（`type` 决定 `isHostile` 认不认它）。 */
function hostileEntity(name: string, at: { x: number; y: number; z: number }, id = 7): Record<string, unknown> {
  return {
    id,
    name,
    displayName: name,
    type: 'hostile',
    position: new Vec3(at.x, at.y, at.z),
    velocity: new Vec3(0, 0, 0),
    metadata: [],
  };
}

function makeFakeBot(opts: {
  cells: Cells;
  at: { x: number; y: number; z: number };
  /** 垂直速度：<-0.5 就是"正在下坠"（真机那四次死亡里 y 一直在掉）。 */
  velocityY?: number;
  dimension?: string;
  /** 世界里的敌对生物，**每次读都是现场**（真 bot 的 entities 也是活的）。 */
  threats?: () => Array<Record<string, unknown>>;
}): { bot: any; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const position = new Vec3(opts.at.x, opts.at.y, opts.at.z);
  const threats = opts.threats ?? ((): Array<Record<string, unknown>> => []);

  let currentGoal: any = null;
  let currentMovements: any = null;
  const pathfinderRaw: any = {
    movements: null,
    goal: null,
    isMoving: false,
    stop: (): void => {
      calls.push({ op: 'pathfinder.stop' });
    },
    setGoal: (goal: any): void => {
      // 真 pathfinder 每 tick 都会调 goal.isEnd / goal.hasChanged；形状不对就是假的。
      if (goal == null || typeof goal.isEnd !== 'function' || typeof goal.hasChanged !== 'function') {
        throw new Error(`setGoal 收到不是真 Goal 的东西：${String(goal)}`);
      }
      currentGoal = goal;
      pathfinderRaw.goal = goal;
      calls.push({ op: 'setGoal', goal });
    },
    setMovements: (movements: any): void => {
      if (!(movements instanceof (pf as any).Movements)) {
        throw new Error('setMovements 收到不是 Movements 实例的东西');
      }
      currentMovements = movements;
      pathfinderRaw.movements = movements;
      calls.push({ op: 'setMovements', movements });
    },
    goto: (): void => {
      // `goto` 不认 interrupt_code（Feedback #22 被 10 秒 cleanKill 的根因），
      // 逃生这条路上不该出现它——出现就是回归。
      throw new Error('fleeTo 不许调 pathfinder.goto');
    },
    isMining: false,
    isBuilding: false,
  };
  const pathfinder = new Proxy(pathfinderRaw, {
    get(target: any, prop: string | symbol): any {
      if (typeof prop === 'string' && !(prop in target)) {
        throw new Error(`假 pathfinder 没有实现 ${prop}：这一段碰了没被建模的真 API`);
      }
      return target[prop];
    },
  });

  const botRaw: any = {
    version: '1.20.4',
    registry: REGISTRY,
    game: { dimension: opts.dimension ?? 'minecraft:the_end' },
    entity: {
      position,
      velocity: new Vec3(0, opts.velocityY ?? 0, 0),
      yaw: 0,
      pitch: 0,
      onGround: (opts.velocityY ?? 0) === 0,
      metadata: [],
    },
    health: 20,
    inventory: { items: (): unknown[] => [], slots: [] },
    interrupt_code: false,
    pathfinder,
    collectBlock: {
      cancelTask: (): void => {
        calls.push({ op: 'cancelTask' });
      },
    },
    stopDigging: (): void => {
      calls.push({ op: 'stopDigging' });
    },
    clearControlStates: (): void => {
      calls.push({ op: 'clearControlStates' });
    },
    setControlState: (key: string, state: boolean): void => {
      if (typeof key !== 'string' || !CONTROL_KEYS.has(key)) {
        throw new Error(`setControlState 收到未知控制键 ${String(key)}`);
      }
      if (typeof state !== 'boolean') throw new Error('setControlState 的第二个参数必须是 boolean');
      calls.push({ op: 'control', key, state });
    },
    blockAt: (p: unknown): any => {
      if (!(p instanceof Vec3)) throw new Error('bot.blockAt 只接受 Vec3（真 API 就是这样）');
      const pos = p as { x: number; y: number; z: number };
      const x = Math.floor(pos.x);
      const y = Math.floor(pos.y);
      const z = Math.floor(pos.z);
      const name = nameIn(opts.cells, x, y, z);
      const def = REGISTRY.blocksByName[name];
      if (def == null) throw new Error(`地形表里出现了不存在的方块名：${name}`);
      // 真 bot.blockAt 返回 prismarine-block：至少要有 name / type / position。
      return { name, type: def.id, position: p, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
    },
    // 这两个插件真 bot 上可能没装：写成 undefined 才是**真实形状**（不是"松"）。
    swordpvp: undefined,
    bowpvp: undefined,
    // 上浮（surface 反射）会 `void bot.look(...)`：真 API 是异步的。
    look: (): Promise<void> => Promise.resolve(),
    // 真 mineflayer bot 上没有这个字段（本仓库的可选扩展）：缺席才是真实形状。
    safeguardsOff: undefined,
  };
  // entities 是活的世界：每次读都反映此刻附近的生物。
  Object.defineProperty(botRaw, 'entities', {
    enumerable: true,
    get: (): Record<string, unknown> =>
      Object.fromEntries(threats().map((e, i) => [String((e as { id?: number }).id ?? i), e])),
  });

  const bot = new Proxy(botRaw, {
    get(target: any, prop: string | symbol): any {
      if (typeof prop === 'string' && !(prop in target)) {
        throw new Error(`假 bot 没有实现 ${prop}：这一段碰了没被建模的真 API`);
      }
      return target[prop];
    },
    set(target: any, prop: string | symbol, value: unknown): boolean {
      if (typeof prop === 'string' && !(prop in target)) {
        throw new Error(`假 bot 不接受没建模的属性 ${prop}`);
      }
      target[prop] = value;
      return true;
    },
  });

  return { bot, calls };
}

// ── 假 body：只补最小状态，方法走真实现 ────────────────────────────────────

/** 骨架 body：`Object.create` 不跑类字段初始化器，所以按需补最小字段（同 reflex_preemption）。 */
function makeBody(opts: { bot: any; events: any[] }): any {
  const body: any = Object.create(MineflayerBody.prototype);
  body.bot = opts.bot;
  body.actions = {
    executing: false,
    currentActionLabel: '',
    stop: vi.fn(async () => {}),
    releaseCurrentAction: vi.fn(),
  };
  body.notify = (type: string, _kind: unknown, _level: unknown, payload: unknown): void => {
    opts.events.push({ type, payload });
  };
  body.log = { with: () => ({ info: () => {}, warn: () => {}, error: () => {} }) };
  // 反射状态
  body.reflexQueue = [];
  body.reflexRunning = false;
  body.reflexAbortRequested = false;
  // 直接调 rescue 时，等价于 drainReflexes 已经把这一棒记在名下（回执要用到）。
  body.currentReflexName = 'escape';
  body.currentReflexIntent = 'flee';
  body.currentReflexStartedAt = Date.now();
  body.reflexCompletionSent = false;
  body.survivalBusySince = null;
  body.survivalBusyClass = null;
  body.survivalLastReflexAt = 0;
  body.survivalCooldownUntil = 0;
  body.survivalYieldNotifiedAt = 0;
  body.modelActionRequested = false;
  body.modelActionsInFlight = 0;
  // 自动拾取（Stop 路径会碰）
  body.pickingUp = false;
  body.pickupAbortRequested = false;
  body.pickupBackoffUntil = 0;
  body.pickupFailures = 0;
  body.pickupCancel = null;
  body.pickupTargetName = null;
  body.pickupTargetId = null;
  body.pickupPreemptReason = null;
  body.pickupSuppressedUntil = 0;
  body.pickupThreatSkippedId = null;
  body.lastPickupAt = 0;
  body.currentRescueRun = null;
  return body;
}

const receipts = (events: any[], reflex = 'escape'): any[] =>
  events.filter((e) => e.type === 'reflex.done' && e.payload?.reflex === reflex);

const goalsOf = (calls: RecordedCall[]): any[] => calls.filter((c) => c.op === 'setGoal').map((c: any) => c.goal);

/** 任何"让身体动起来"的命令（含松开按键之外的一切控制）。 */
const movementCalls = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter(
    (c) =>
      c.op === 'setGoal' ||
      c.op === 'setMovements' ||
      c.op === 'goto' ||
      (c.op === 'control' && c.state === true),
  );

/**
 * 推进假时钟直到 `pending` 收工，**有界**：到点还没结束就返回 false。
 *
 * 不用"无限推 + await"的写法：那样一旦循环不收工，用例只会挂在 vitest 超时上，
 * 看不出是哪一步坏的。
 */
async function advanceUntilSettled(
  pending: Promise<unknown>,
  budgetMs: number,
  stepMs = 1_000,
): Promise<boolean> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let waited = 0;
  while (!settled && waited < budgetMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    waited += stepMs;
    await Promise.resolve();
  }
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── (a) 末地小岛 ───────────────────────────────────────────────────────────

describe('(a) 末地小岛：逃生不许朝虚空迈步', () => {
  it('(a1) 5×5 岛 + 贴脸威胁：附近没有任何能站住的落点 ⇒ 一步都没迈，回执说明原地不动', async () => {
    const cells = islandCells(5);
    let threatReads = 0;
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      threats: () => (threatReads++ === 0 ? [hostileEntity('enderman', { x: 2.5, y: 65, z: 0.5 })] : []),
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });

    const pending = body.rescue('flee');
    expect(await advanceUntilSettled(pending, 15_000), 'rescue 没有在 15 秒假时钟内收工').toBe(true);
    await pending;

    // 5×5 岛上"最远 8 格"的候选全在虚空里：正确的动作是**一步都不迈**。
    expect(goalsOf(calls)).toEqual([]);
    expect(movementCalls(calls)).toEqual([]);
    const stay = receipts(events).filter((e) => String(e.payload.detail).includes('原地不动'));
    expect(stay).toHaveLength(1);
    expect(stay[0].payload.outcome).toBe('in_progress');
    expect(String(stay[0].payload.detail)).toContain('找不到能站住的落点');
  });

  it('(a2) 岛够大（21×21）：选出的落点必须站在实心上，并且**带着已验证的 y**', async () => {
    const cells = islandCells(21);
    let threatReads = 0;
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      dimension: 'minecraft:the_end',
      threats: () => (threatReads++ === 0 ? [hostileEntity('enderman', { x: 2.5, y: 65, z: 0.5 })] : []),
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });

    const pending = body.rescue('flee');
    expect(await advanceUntilSettled(pending, 15_000), 'rescue 没有在 15 秒假时钟内收工').toBe(true);
    const result = await pending;

    const goals = goalsOf(calls);
    expect(goals.length).toBeGreaterThan(0);
    const GoalNear = (pf as any).goals.GoalNear;
    for (const goal of goals) {
      // ① 目标必须是等着**真 y** 的 GoalNear（GoalXZ 只看 x/z，是这次死亡的机制）。
      expect(goal).toBeInstanceOf(GoalNear);
      expect(goal.rangeSq).toBe(1);
      // ② 落点必须真的站得住（独立判据复算），而且还在岛上。
      expect(standsOnSolidGround(cells, goal.x, goal.y, goal.z), `(${goal.x},${goal.y},${goal.z})`).toBe(true);
      expect(Math.abs(goal.x)).toBeLessThanOrEqual(10);
      expect(Math.abs(goal.z)).toBeLessThanOrEqual(10);
      expect(goal.y).toBe(65);
      // ③ **死亡机制本身**：GoalXZ 会认为"同一 x/z、y 差 200 格"已经到达
      //    （`GoalXZ.isEnd` 根本不看 y），于是路径可以沿岛边/虚空上方绕过去。
      //    带 y 的 GoalNear 必须拒绝它。
      expect(goal.isEnd(new Vec3(goal.x, goal.y - 200, goal.z))).toBe(false);
    }
    expect(result.escaped).toBe(true);
  });
});

// ── (b) 下界岩浆岸 ─────────────────────────────────────────────────────────

describe('(b) 下界岩浆岸：逃生不许踏进岩浆', () => {
  it('逃跑方向正对岩浆时，落点换到岸上实心格，并且不越岩浆线', async () => {
    const cells = netherShoreCells();
    let threatReads = 0;
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      dimension: 'minecraft:the_nether',
      // 威胁在北面（z<0），"远离它"正好是南面 —— 岩浆岸那边。
      threats: () => (threatReads++ === 0 ? [hostileEntity('hoglin', { x: 0.5, y: 65, z: -2 })] : []),
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });

    const pending = body.rescue('flee');
    expect(await advanceUntilSettled(pending, 15_000), 'rescue 没有在 15 秒假时钟内收工').toBe(true);
    await pending;

    const goals = goalsOf(calls);
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) {
      expect(goal).toBeInstanceOf((pf as any).goals.GoalNear);
      // 脚/头空气 + 脚下实心 + 脚下不是岩浆/水 —— 独立复算。
      expect(standsOnSolidGround(cells, goal.x, goal.y, goal.z), `(${goal.x},${goal.y},${goal.z})`).toBe(true);
      expect(nameIn(cells, goal.x, goal.y - 1, goal.z)).not.toBe('lava');
      expect(goal.y).toBe(65);
    }
    // 岩浆线在 z ≥ 5：一个落点都不许落在上面。
    expect(goals.every((g) => g.z < 5)).toBe(true);
  });
});

// ── (c) 已经在下坠 + 脚下没有实心 ⇒ 只刹车 ─────────────────────────────────

describe('(c) 已经在往下掉、脚下没有实心：只刹车，零横向平移', () => {
  it('这一条本该救回那四条命：零移动命令、真停寻路、松开方向键、回执说清为什么', async () => {
    const cells = voidCells();
    let threatReads = 0;
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 40, z: 0.5 },
      velocityY: -8, // 正在下坠（真机 y 39 → -170 的第一段）
      dimension: 'minecraft:the_end',
      threats: () => (threatReads++ === 0 ? [hostileEntity('enderman', { x: 2, y: 40, z: 0.5 })] : []),
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });

    const pending = body.rescue('flee');
    expect(await advanceUntilSettled(pending, 15_000), 'rescue 没有在 15 秒假时钟内收工').toBe(true);
    await pending;

    // ① 零横向平移：没有 goal、没有 movements 替换、没有 goto、没有按下任何移动键。
    expect(movementCalls(calls)).toEqual([]);

    // ② 刹车**真的做了事**（不是"什么都没发生"）：停寻路 + 松开每个方向键。
    expect(calls.some((c) => c.op === 'pathfinder.stop')).toBe(true);
    const controls = calls.filter((c): c is { op: 'control'; key: string; state: boolean } => c.op === 'control');
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((c) => c.state === false)).toBe(true);
    for (const key of MOVEMENT_KEYS) expect(controls.map((c) => c.key)).toContain(key);

    // ③ 回执必须解释"为什么这一棒什么都不做"，不许让它看起来像逃成功了。
    const brake = receipts(events).filter((e) => String(e.payload.detail).includes('刹车'));
    expect(brake).toHaveLength(1);
    expect(brake[0].payload.outcome).toBe('in_progress');
    expect(String(brake[0].payload.detail)).toContain('下坠');
    expect(String(brake[0].payload.detail)).toContain('横向');
    expect(String(brake[0].payload.detail)).not.toContain('脱离');
  });

  it('(c2) 脚已经踩进岩浆：同样只刹车，不许再横向平移', async () => {
    const cells = lavaAtFeetCells();
    let threatReads = 0;
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      dimension: 'minecraft:the_nether',
      threats: () => (threatReads++ === 0 ? [hostileEntity('hoglin', { x: 2.5, y: 65, z: 0.5 })] : []),
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });

    const pending = body.rescue('flee');
    expect(await advanceUntilSettled(pending, 15_000), 'rescue 没有在 15 秒假时钟内收工').toBe(true);
    await pending;

    expect(movementCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.op === 'pathfinder.stop')).toBe(true);
    const brake = receipts(events).filter((e) => String(e.payload.detail).includes('刹车'));
    expect(brake).toHaveLength(1);
  });
});

// ── (d) 没有安全落点 ⇒ 原地不动 + 如实回执 ────────────────────────────────

describe('(d) 找不到能站住的落点：原地不动，并且**说清楚**（不是静默 return）', () => {
  it('1×1 石柱四周虚空：不发 goal、不改 movements、回执写明原因', async () => {
    const cells = pillarCells();
    let threatReads = 0;
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      threats: () => (threatReads++ === 0 ? [hostileEntity('zombie', { x: 1.5, y: 65, z: 0.5 })] : []),
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });

    const pending = body.rescue('flee');
    expect(await advanceUntilSettled(pending, 15_000), 'rescue 没有在 15 秒假时钟内收工').toBe(true);
    await pending;

    expect(calls.some((c) => c.op === 'setGoal')).toBe(false);
    expect(calls.some((c) => c.op === 'setMovements')).toBe(false);
    expect(calls.some((c) => c.op === 'pathfinder.stop')).toBe(true);

    const stay = receipts(events).filter((e) => String(e.payload.detail).includes('原地不动'));
    expect(stay).toHaveLength(1);
    expect(stay[0].payload.outcome).toBe('in_progress');
    expect(String(stay[0].payload.detail)).toContain('找不到能站住的落点');
    expect(String(stay[0].payload.detail)).toContain('虚空');
  });
});

// ── (e) Stop 必须让逃生真的收手 ────────────────────────────────────────────

describe('(e) Stop 期间逃生必须收手（真机原话：「Stop 之后仍不停手」）', () => {
  it('Stop 之后：不再发 goal、寻路真的被停、宽限期内交还通道、回执说"中断"', async () => {
    const cells = openFieldCells();
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      // 威胁一直不走：没有 Stop 的话这条逃生会一直跑下去（真机那次跑了 419 秒）。
      threats: () => [hostileEntity('zombie', { x: 3.5, y: 65, z: 0.5 })],
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });
    body.reflexQueue = [{ reflex: 'escape', intent: 'flee' }];

    const running = body.drainReflexes();
    // 先让它真的跑起来：至少发出过一条逃跑 goal。
    await vi.advanceTimersByTimeAsync(1_100);
    expect(goalsOf(calls).length).toBeGreaterThan(0);
    expect(goalsOf(calls).every((g: any) => standsOnSolidGround(cells, g.x, g.y, g.z))).toBe(true);

    const stopAt = calls.length;
    const res = await body.handle({ op: 'stop' });
    expect(res).toMatchObject({ ok: true, op: 'stop' });
    expect(events.some((e) => e.type === 'reflex.done' && e.payload.reflex === 'stop')).toBe(true);

    // 宽限期**还没到**：循环自己就必须收手，而不是靠别人抢通道。
    await vi.advanceTimersByTimeAsync(1_500);
    const afterStop = calls.slice(stopAt);
    expect(afterStop.some((c) => c.op === 'setGoal')).toBe(false);
    expect(afterStop.some((c) => c.op === 'setMovements')).toBe(false);
    expect(movementCalls(afterStop)).toEqual([]);
    // Stop 那一刻寻路是**真的被停掉**了（不是"没人再动它"）。
    expect(afterStop.some((c) => c.op === 'pathfinder.stop')).toBe(true);

    // 宽限期到点：通道交还，"快照"和回执一致。
    await vi.advanceTimersByTimeAsync(REFLEX_STOP_GRACE_MS + 100);
    expect(body.currentActionName()).toBeNull();
    expect(body.reflexRunning).toBe(false);

    // 被丢弃的那条循环继续哑火收尾：不许再碰身体（一个调用都不许有）。
    const afterGrace = calls.length;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(calls.length).toBe(afterGrace);
    await running;

    const done = receipts(events);
    expect(done).toHaveLength(1);
    expect(done[0].payload.outcome).toBe('aborted');
    expect(String(done[0].payload.detail)).toContain('中断');
    expect(String(done[0].payload.detail)).not.toContain('脱离威胁');
  });

  it('(e2) 溺水自救（surface）同样认 Stop：不再按 jump 上浮，通道照样交还', async () => {
    const cells: Cells = new Map();
    cells.set(cellKey(0, 65, 0), 'water');
    cells.set(cellKey(0, 66, 0), 'water');
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      dimension: 'minecraft:overworld',
      threats: () => [],
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });
    body.reflexQueue = [{ reflex: 'surface', intent: 'surface' }];

    const running = body.drainReflexes();
    await vi.advanceTimersByTimeAsync(1_100);
    // 头在水里：它确实在按 jump 上浮。
    expect(calls.some((c) => c.op === 'control' && c.key === 'jump' && c.state === true)).toBe(true);

    const stopAt = calls.length;
    await body.handle({ op: 'stop' });
    await vi.advanceTimersByTimeAsync(1_500);
    const afterStop = calls.slice(stopAt);
    // Stop 之后不许再有任何按键（含 jump）——同一个 bug 的另一半。
    expect(afterStop.some((c) => c.op === 'control')).toBe(false);
    expect(afterStop.some((c) => c.op === 'pathfinder.stop')).toBe(true);

    await vi.advanceTimersByTimeAsync(REFLEX_STOP_GRACE_MS + 100);
    expect(body.currentActionName()).toBeNull();
    await running;

    const done = receipts(events, 'surface');
    expect(done).toHaveLength(1);
    expect(done[0].payload.outcome).toBe('aborted');
  });

  it('(e3) 岩浆脱困（lava）同样认 Stop：不再上浮/发 goal', async () => {
    const cells: Cells = new Map();
    cells.set(cellKey(0, 64, 0), 'lava');
    cells.set(cellKey(0, 65, 0), 'lava');
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      dimension: 'minecraft:the_nether',
      threats: () => [],
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });
    body.reflexQueue = [{ reflex: 'escape', intent: 'lava' }];

    const running = body.drainReflexes();
    await vi.advanceTimersByTimeAsync(1_100);
    // 脚在岩浆里：它确实在往上跳。
    expect(calls.some((c) => c.op === 'control' && c.key === 'jump' && c.state === true)).toBe(true);

    const stopAt = calls.length;
    await body.handle({ op: 'stop' });
    await vi.advanceTimersByTimeAsync(1_500);
    const afterStop = calls.slice(stopAt);
    expect(afterStop.some((c) => c.op === 'control')).toBe(false);
    expect(afterStop.some((c) => c.op === 'setGoal')).toBe(false);
    expect(afterStop.some((c) => c.op === 'pathfinder.stop')).toBe(true);

    await vi.advanceTimersByTimeAsync(REFLEX_STOP_GRACE_MS + 100);
    expect(body.currentActionName()).toBeNull();
    await running;

    // 注意：脚在岩浆里时每个 tick 都会推一条"刹车"（in_progress）回执——所以这里
    // 只数**收尾**那一条，不数全过程（那条刷屏问题另记，不在本次改动里动它）。
    const aborted = receipts(events).filter((e) => e.payload.outcome === 'aborted');
    expect(aborted).toHaveLength(1);
    expect(String(aborted[0].payload.detail)).toContain('中断');
  });
});

// ── (f) 回归：开阔地上的逃生照旧管用 ──────────────────────────────────────

describe('(f) 回归：开阔地上有威胁，逃生照旧工作（修过头比原 bug 更糟）', () => {
  it('脚下实心 + 有威胁：照常选落点、下 goal、跑完报 escaped', async () => {
    const cells = openFieldCells();
    let threatReads = 0;
    const { bot, calls } = makeFakeBot({
      cells,
      at: { x: 0.5, y: 65, z: 0.5 },
      threats: () => (threatReads++ === 0 ? [hostileEntity('zombie', { x: 3.5, y: 65, z: 0.5 })] : []),
    });
    const events: any[] = [];
    const body = makeBody({ bot, events });

    const pending = body.rescue('flee');
    expect(await advanceUntilSettled(pending, 15_000), 'rescue 没有在 15 秒假时钟内收工').toBe(true);
    const result = await pending;

    const goals = goalsOf(calls);
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) {
      expect(goal).toBeInstanceOf((pf as any).goals.GoalNear);
      expect(standsOnSolidGround(cells, goal.x, goal.y, goal.z), `(${goal.x},${goal.y},${goal.z})`).toBe(true);
      expect(goal.y).toBe(65);
    }
    // movements 真的被换成安全基线那一套（逃生没绕过 movementsFor）。
    expect(calls.some((c) => c.op === 'setMovements')).toBe(true);
    expect(result.escaped).toBe(true);
    expect(result.reason).toBe('safe');

    // 既没刹车也没"原地不动"：有实心地面时不许把逃跑关掉。
    const allDetails = events.map((e) => String(e.payload?.detail ?? ''));
    expect(allDetails.some((d) => d.includes('刹车'))).toBe(false);
    expect(allDetails.some((d) => d.includes('原地不动'))).toBe(false);
  });
});
