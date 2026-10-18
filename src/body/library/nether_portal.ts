/**
 * 下界传送门：**决策逻辑（纯函数）+ 身体执行流程**。
 *
 * 这里刻意把"门框几何、材料判断、选址判据"和 mineflayer 动作分开：
 * 前者只吃坐标/方块名，单元测试不用起 MC 服务端；后者才复用
 * `skills.ts` 的放方块、寻路、activateBlock 能力。
 *
 * 安全边界：
 * - 只往 **空气** 里放黑曜石，预检不通过就一个方块都不动；
 * - 不调用 mineBlock，不清理现场；中途失败时已放的方块保留并如实报告；
 * - 点火继续走 `skills.useToolOnBlock` 的危险操作闸门，不绕过 `ignite` 许可。
 */
import Vec3 from 'vec3';
import * as skills from './skills.js';
import * as world from './world.js';
import { normalizeDimension } from '../safety/dangerous_ops.js';
import { opContextFor, permits } from '../safety/permits.js';

/** 标准最小下界门框（4×5 外框、2×3 内部，四个角不需要）。 */
export const NETHER_PORTAL_OBSIDIAN_COST = 10;
export const NETHER_PORTAL_INTERIOR_WIDTH = 2;
export const NETHER_PORTAL_INTERIOR_HEIGHT = 3;

export type PortalAxis = 'x' | 'z';

export interface PortalPoint {
  x: number;
  y: number;
  z: number;
}

export interface PortalApproach {
  /** -1 / 1：沿门的法线方向，门框坐标 z-1 / z+1（axis=x）或 x-1 / x+1（axis=z）。 */
  side: -1 | 1;
  /** 两个并排的落脚格（y 与门框底边同层）。 */
  standBlocks: PortalPoint[];
  /** 落脚格上方一格，必须能站下 1.8 格高的身体。 */
  headBlocks: PortalPoint[];
}

export interface PortalPlan {
  base: PortalPoint;
  axis: PortalAxis;
  /** 10 格门框，按施工顺序排列：底 → 两侧自下而上 → 顶。 */
  frameBlocks: PortalPoint[];
  /** 2×3 的传送门内部（点燃后应出现 nether_portal）。 */
  interiorBlocks: PortalPoint[];
  /** 点火用的底边黑曜石。 */
  ignitionBlock: PortalPoint;
  /** 走进去时瞄准的内部中心（浮点坐标）。 */
  entryTarget: PortalPoint;
  /** 门的两侧入口；选址时至少有一侧完整可达。 */
  approaches: PortalApproach[];
  /**
   * 四个「角」坐标：底边两角和顶边两角。
   *
   * 4×5 门框的四个角按 Minecraft 规则可以不放黑曜石，但施工时侧柱底块和
   * 顶边中块需要这些东西做临时支撑。选址预检会把仍是空气的角列为
   * `scaffoldBlocks`，用背包里的普通方块临时垫一下；已有实心块则直接复用。
   * 这些角**不是门框的一部分**，也不消耗黑曜石。
   */
  supportCorners: PortalPoint[];
}

export interface PortalMaterialStatus {
  obsidian: number;
  flintAndSteel: number;
  requiredObsidian: number;
  missingObsidian: number;
  missingFlintAndSteel: number;
  enoughObsidian: boolean;
  enoughFlintAndSteel: boolean;
  ok: boolean;
  message: string;
}

export interface PortalSiteEvaluation {
  ok: boolean;
  reason?: string;
  existingObsidian: number;
  existingPortal: boolean;
  /** 第一条满足条件的入口。 */
  approach?: PortalApproach;
  /** 第一条导致失败的关键坐标。 */
  blockedAt?: PortalPoint;
  /** 需要临时垫一下的角；空数组表示四个角都已有现成支撑。 */
  scaffoldBlocks?: PortalPoint[];
}

export interface ScaffoldChoice {
  material: string;
  count: number;
}

export interface PortalSelectionResult {
  plan: PortalPlan | null;
  evaluation?: PortalSiteEvaluation;
  reason: string;
}

export type BlockNameProbe = (x: number, y: number, z: number) => string | null;

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const UNSAFE_FLOOR_BLOCKS = new Set([
  'water',
  'flowing_water',
  'lava',
  'flowing_lava',
  'fire',
  'soul_fire',
  'magma_block',
  'powder_snow',
  'cactus',
  'sweet_berry_bush',
  'campfire',
  'soul_campfire',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'snow',
  'torch',
  'wall_torch',
  'vine',
  'ladder',
  'rail',
  'powered_rail',
  'detector_rail',
  'activator_rail',
]);

/** 临时垫块优先级：便宜、常见、不会误用贵重资源。 */
const SCAFFOLD_MATERIALS = [
  'dirt',
  'cobblestone',
  'stone',
  'cobbled_deepslate',
  'deepslate',
  'netherrack',
  'sand',
  'gravel',
  'andesite',
  'diorite',
  'granite',
  'blackstone',
  'oak_planks',
  'oak_log',
  'birch_log',
  'spruce_log',
] as const;

/**
 * 从背包里挑一种临时垫块。只认常见建材白名单，避免为了垫四格把钻石块
 * 之类贵重物品用掉。`needed=0` 时返回 null（不需要垫）。
 */
export function chooseScaffoldMaterial(
  counts: Record<string, number | undefined> | null | undefined,
  needed: number,
): ScaffoldChoice | null {
  const want = Number.isFinite(needed) ? Math.max(0, Math.floor(needed)) : 0;
  if (want === 0) return null;
  for (const material of SCAFFOLD_MATERIALS) {
    const raw = Number(counts?.[material] ?? 0);
    if (Number.isFinite(raw) && Math.floor(raw) >= want) return { material, count: want };
  }
  return null;
}

export function isAirBlock(name: string | null | undefined): boolean {
  return name != null && AIR_BLOCKS.has(name);
}

export function isPortalBlock(name: string | null | undefined): boolean {
  return name === 'nether_portal';
}

export function isSafeFloorBlock(name: string | null | undefined): boolean {
  if (name == null || isAirBlock(name)) return false;
  return !UNSAFE_FLOOR_BLOCKS.has(name);
}

export function pointKey(p: PortalPoint): string {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

export function formatPoint(p: PortalPoint): string {
  return `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`;
}

function intPoint(x: number, y: number, z: number): PortalPoint {
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

function offset(base: PortalPoint, dx: number, dy: number, dz: number): PortalPoint {
  return { x: base.x + dx, y: base.y + dy, z: base.z + dz };
}

/**
 * 材料门槛。
 *
 * `requiredObsidian` 允许小于 10：重复调用时如果现场已经有几块黑曜石，
 * 只要求补齐剩余部分；打火石始终至少 1 个。读不到背包时按 0 处理，宁可
 * 明确说"不够"，也不猜。
 */
export function assessPortalMaterials(
  counts: Record<string, number | undefined> | null | undefined,
  requiredObsidian: number = NETHER_PORTAL_OBSIDIAN_COST,
): PortalMaterialStatus {
  const rawObsidian = Number(counts?.['obsidian'] ?? 0);
  const rawFlint = Number(counts?.['flint_and_steel'] ?? 0);
  const obsidian = Number.isFinite(rawObsidian) && rawObsidian > 0 ? Math.floor(rawObsidian) : 0;
  const flintAndSteel = Number.isFinite(rawFlint) && rawFlint > 0 ? Math.floor(rawFlint) : 0;
  const required = Number.isFinite(requiredObsidian)
    ? Math.max(0, Math.floor(requiredObsidian))
    : NETHER_PORTAL_OBSIDIAN_COST;
  const missingObsidian = Math.max(0, required - obsidian);
  const missingFlintAndSteel = flintAndSteel >= 1 ? 0 : 1;
  const enoughObsidian = missingObsidian === 0;
  const enoughFlintAndSteel = missingFlintAndSteel === 0;
  const ok = enoughObsidian && enoughFlintAndSteel;
  const parts: string[] = [];
  parts.push(`黑曜石 ${obsidian}/${required}`);
  if (!enoughObsidian) parts.push(`还缺 ${missingObsidian}`);
  parts.push(`打火石 ${flintAndSteel}/1`);
  if (!enoughFlintAndSteel) parts.push('还缺 1');
  return {
    obsidian,
    flintAndSteel,
    requiredObsidian: required,
    missingObsidian,
    missingFlintAndSteel,
    enoughObsidian,
    enoughFlintAndSteel,
    ok,
    message: `材料${ok ? '足够' : '不足'}：${parts.join('，')}。`,
  };
}

/**
 * 计算一个门框计划。`base` 是底边最左/最下那块门框的坐标；
 * `axis='x'` 表示门面沿 x 轴展开，`axis='z'` 表示沿 z 轴展开。
 */
export function planPortal(baseInput: PortalPoint, axis: PortalAxis): PortalPlan {
  const base = intPoint(baseInput.x, baseInput.y, baseInput.z);
  const frameBlocks: PortalPoint[] = [];
  const interiorBlocks: PortalPoint[] = [];
  const approaches: PortalApproach[] = [];
  let supportCorners: PortalPoint[];

  if (axis === 'x') {
    // 底边（2 块）、左柱 3 块、右柱 3 块、顶边 2 块。
    frameBlocks.push(offset(base, 1, 0, 0), offset(base, 2, 0, 0));
    frameBlocks.push(offset(base, 0, 1, 0), offset(base, 0, 2, 0), offset(base, 0, 3, 0));
    frameBlocks.push(offset(base, 3, 1, 0), offset(base, 3, 2, 0), offset(base, 3, 3, 0));
    frameBlocks.push(offset(base, 1, 4, 0), offset(base, 2, 4, 0));
    for (let dy = 1; dy <= NETHER_PORTAL_INTERIOR_HEIGHT; dy++) {
      for (let dx = 1; dx <= NETHER_PORTAL_INTERIOR_WIDTH; dx++) {
        interiorBlocks.push(offset(base, dx, dy, 0));
      }
    }
    supportCorners = [offset(base, 0, 0, 0), offset(base, 3, 0, 0), offset(base, 0, 4, 0), offset(base, 3, 4, 0)];
    for (const side of [-1, 1] as const) {
      const standBlocks = [offset(base, 1, 0, side), offset(base, 2, 0, side)];
      approaches.push({
        side,
        standBlocks,
        headBlocks: standBlocks.map((p) => offset(p, 0, 1, 0)),
      });
    }
  } else {
    frameBlocks.push(offset(base, 0, 0, 1), offset(base, 0, 0, 2));
    frameBlocks.push(offset(base, 0, 1, 0), offset(base, 0, 2, 0), offset(base, 0, 3, 0));
    frameBlocks.push(offset(base, 0, 1, 3), offset(base, 0, 2, 3), offset(base, 0, 3, 3));
    frameBlocks.push(offset(base, 0, 4, 1), offset(base, 0, 4, 2));
    for (let dy = 1; dy <= NETHER_PORTAL_INTERIOR_HEIGHT; dy++) {
      for (let dz = 1; dz <= NETHER_PORTAL_INTERIOR_WIDTH; dz++) {
        interiorBlocks.push(offset(base, 0, dy, dz));
      }
    }
    supportCorners = [offset(base, 0, 0, 0), offset(base, 0, 0, 3), offset(base, 0, 4, 0), offset(base, 0, 4, 3)];
    for (const side of [-1, 1] as const) {
      const standBlocks = [offset(base, side, 0, 1), offset(base, side, 0, 2)];
      approaches.push({
        side,
        standBlocks,
        headBlocks: standBlocks.map((p) => offset(p, 0, 1, 0)),
      });
    }
  }

  const ignitionBlock = frameBlocks[0] as PortalPoint;
  const entryTarget: PortalPoint =
    axis === 'x'
      ? { x: base.x + 1.5, y: base.y + 1, z: base.z + 0.5 }
      : { x: base.x + 0.5, y: base.y + 1, z: base.z + 1.5 };

  return { base, axis, frameBlocks, interiorBlocks, ignitionBlock, entryTarget, approaches, supportCorners };
}

function safeProbe(probe: BlockNameProbe, p: PortalPoint): string | null {
  try {
    return probe(p.x, p.y, p.z);
  } catch {
    return null;
  }
}

/**
 * 预检一个候选门框，**不产生任何动作**。
 *
 * 允许门框位置已经是 obsidian（重复调用/半成品），但绝不允许其他方块：
 * `skills.placeBlock` 遇到挡路方块会先挖掉，而本工具的第一原则是失败不破坏现场。
 */
export function evaluatePortalSite(plan: PortalPlan, probe: BlockNameProbe): PortalSiteEvaluation {
  let existingObsidian = 0;
  for (const p of plan.frameBlocks) {
    const name = safeProbe(probe, p);
    if (name == null) {
      return { ok: false, reason: `无法读取 ${formatPoint(p)} 的方块状态。`, existingObsidian, existingPortal: false, blockedAt: p };
    }
    if (name === 'obsidian') {
      existingObsidian++;
      continue;
    }
    if (!isAirBlock(name)) {
      return {
        ok: false,
        reason: `${formatPoint(p)} 是 ${name}，不是空气；为避免挖掉现场，取消施工。`,
        existingObsidian,
        existingPortal: false,
        blockedAt: p,
      };
    }
  }

  let existingPortal = false;
  for (const p of plan.interiorBlocks) {
    const name = safeProbe(probe, p);
    if (name == null) {
      return { ok: false, reason: `无法读取门内 ${formatPoint(p)} 的方块状态。`, existingObsidian, existingPortal, blockedAt: p };
    }
    if (isPortalBlock(name)) {
      existingPortal = true;
      continue;
    }
    if (!isAirBlock(name)) {
      return {
        ok: false,
        reason: `门内 ${formatPoint(p)} 是 ${name}，不是空气；为避免挖掉现场，取消施工。`,
        existingObsidian,
        existingPortal,
        blockedAt: p,
      };
    }
  }

  // 底边必须坐在地面上，且地板不能是水/岩浆/火/岩浆块这类会伤人的方块。
  for (const p of plan.frameBlocks.slice(0, 2)) {
    const floor = intPoint(p.x, p.y - 1, p.z);
    const floorName = safeProbe(probe, floor);
    if (!isSafeFloorBlock(floorName)) {
      return {
        ok: false,
        reason: `门框底边 ${formatPoint(p)} 下方不是安全地面（读到 ${floorName ?? '未知'}）。`,
        existingObsidian,
        existingPortal,
        blockedAt: floor,
      };
    }
  }

  // 4×5 门的四个角虽然不参与点火判定，但施工时需要它们支撑侧柱底块和顶边中块。
  // 已是实心块的角直接复用；仍是空气的角列进 scaffoldBlocks，用普通方块临时垫。
  const scaffoldBlocks: PortalPoint[] = [];
  for (const p of plan.supportCorners) {
    const name = safeProbe(probe, p);
    if (name == null) {
      return { ok: false, reason: `无法读取门角 ${formatPoint(p)} 的方块状态。`, existingObsidian, existingPortal, blockedAt: p };
    }
    if (isAirBlock(name)) {
      scaffoldBlocks.push(p);
      continue;
    }
    if (!isSafeFloorBlock(name)) {
      return {
        ok: false,
        reason: `门角 ${formatPoint(p)} 是 ${name}，不能作为临时支撑；为避免破坏现场，取消施工。`,
        existingObsidian,
        existingPortal,
        blockedAt: p,
      };
    }
  }

  let firstApproachProblem = '';
  let firstApproachBlockedAt: PortalPoint | undefined;
  for (const approach of plan.approaches) {
    let ok = true;
    for (const p of [...approach.standBlocks, ...approach.headBlocks]) {
      const name = safeProbe(probe, p);
      if (!isAirBlock(name)) {
        ok = false;
        if (firstApproachProblem === '') {
          firstApproachProblem = `入口 ${formatPoint(p)} 被 ${name ?? '未知'} 占着`;
          firstApproachBlockedAt = p;
        }
        break;
      }
    }
    if (!ok) continue;
    for (const p of approach.standBlocks) {
      const floor = intPoint(p.x, p.y - 1, p.z);
      const floorName = safeProbe(probe, floor);
      if (!isSafeFloorBlock(floorName)) {
        ok = false;
        if (firstApproachProblem === '') {
          firstApproachProblem = `入口 ${formatPoint(p)} 下方不是安全地面（读到 ${floorName ?? '未知'}）`;
          firstApproachBlockedAt = floor;
        }
        break;
      }
    }
    if (ok) return { ok: true, existingObsidian, existingPortal, approach, scaffoldBlocks };
  }

  return {
    ok: false,
    reason: `门框两侧都没有可站立的入口${firstApproachProblem === '' ? '' : `（${firstApproachProblem}）`}。`,
    existingObsidian,
    existingPortal,
    ...(firstApproachBlockedAt == null ? {} : { blockedAt: firstApproachBlockedAt }),
  };
}

function planTouchesPoint(plan: PortalPlan, p: PortalPoint): boolean {
  const key = pointKey(p);
  return [...plan.frameBlocks, ...plan.interiorBlocks, ...plan.supportCorners].some((q) => pointKey(q) === key);
}

/**
 * 在 bot 附近按距离枚举/筛选候选门框。纯函数，不读全局状态。
 * `forbiddenBlocks` 通常放 bot 的脚、头所在格，避免把门盖在自己身上。
 */
export function selectPortalPlan(
  feet: PortalPoint,
  probe: BlockNameProbe,
  options: { radius?: number; forbiddenBlocks?: PortalPoint[] } = {},
): PortalSelectionResult {
  const radius = Number.isFinite(options.radius) ? Math.max(0, Math.floor(options.radius as number)) : 8;
  const forbidden = options.forbiddenBlocks ?? [];
  const baseX = Math.floor(feet.x);
  const baseY = Math.floor(feet.y);
  const baseZ = Math.floor(feet.z);
  const candidates: PortalPlan[] = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (const axis of ['x', 'z'] as const) {
        candidates.push(planPortal({ x: baseX + dx, y: baseY, z: baseZ + dz }, axis));
      }
    }
  }

  candidates.sort((a, b) => {
    const da = Math.hypot(a.entryTarget.x - feet.x, a.entryTarget.y - feet.y, a.entryTarget.z - feet.z);
    const db = Math.hypot(b.entryTarget.x - feet.x, b.entryTarget.y - feet.y, b.entryTarget.z - feet.z);
    if (da !== db) return da - db;
    if (a.axis !== b.axis) return a.axis === 'x' ? -1 : 1;
    if (a.base.x !== b.base.x) return a.base.x - b.base.x;
    return a.base.z - b.base.z;
  });

  let firstFailure: PortalSiteEvaluation | undefined;
  for (const plan of candidates) {
    if (forbidden.some((p) => planTouchesPoint(plan, p))) continue;
    const evaluation = evaluatePortalSite(plan, probe);
    if (evaluation.ok) return { plan, evaluation, reason: '找到可用门址。' };
    if (firstFailure == null) firstFailure = evaluation;
  }
  return {
    plan: null,
    ...(firstFailure == null ? {} : { evaluation: firstFailure }),
    reason:
      `附近 ${radius} 格内没有找到能放下 4×5 门框、且两侧有安全站立空间的位置。` +
      (firstFailure?.reason == null ? '' : `最近候选失败原因：${firstFailure.reason}`),
  };
}

/** 规范化 bot 当前维度；读不到返回 null。 */
export function dimensionOf(bot: unknown): string | null {
  const b = bot as { game?: { dimension?: unknown } } | null | undefined;
  return normalizeDimension(b?.game?.dimension);
}

export function isNetherDimension(raw: unknown): boolean {
  return normalizeDimension(raw) === 'the_nether';
}

export function dimensionChanged(before: string | null, after: string | null): boolean {
  return before != null && after != null && before !== after;
}

export interface PortalRoutineResult {
  ok: boolean;
  step: string;
  message: string;
}

export function portalReceipt(headline: string, details: string[]): string {
  return [headline, ...details.filter((line) => line !== '')].join('\n');
}

/** 读一个方块名；读不到给 null。 */
function blockNameAt(bot: any, p: PortalPoint): string | null {
  try {
    const block = bot?.blockAt?.(new Vec3(p.x, p.y, p.z));
    return typeof block?.name === 'string' ? block.name : null;
  } catch {
    return null;
  }
}

/**
 * 找现成的下界传送门（**先找再用，找不到才建**）。
 *
 * 半径从 16 放宽到 64：16 格只够"门就在旁边"的情况，而真机上 bot 常常在门外
 * 十几二十格的地方绕（还会被地形挡住视线），于是它宁可重新凑 10 块黑曜石也不
 * 去用现成的门——用户的诉求是"先在附近一定范围内找门，有就走进去，没有再搭建"。
 *
 * `findBlock` 只能扫**已加载区块**，所以 64 格是"看得见的那一圈"，不是保证；
 * 回执里会把实际搜索半径写出来，避免模型把它读成"这一带绝对没有门"。
 */
export const PORTAL_SEARCH_RADIUS = 64;

function findNearbyPortal(bot: any, radius = PORTAL_SEARCH_RADIUS): PortalPoint | null {
  try {
    const block = world.getNearestBlock(bot, 'nether_portal', radius);
    if (block?.position == null) return null;
    return intPoint(block.position.x, block.position.y, block.position.z);
  } catch {
    return null;
  }
}

/**
 * 带着"走到传送门里并等维度切换"的收尾动作。
 *
 * 不直接连续按前进键：入口可能和 bot 不在同一高度，交给已有寻路处理；
 * 同时把目标点做一次小重试，避免第一次寻路停在门框外。
 */
async function walkIntoPortal(
  bot: any,
  target: PortalPoint,
  beforeDimension: string | null,
  timeoutMs = 12_000,
): Promise<boolean> {
  const reachedDimension = (): boolean =>
    dimensionChanged(beforeDimension, dimensionOf(bot)) || isNetherDimension(dimensionOf(bot));

  try {
    await skills.goToPosition(bot, target.x, target.y, target.z, 0.6);
  } catch {
    // 传送发生时寻路经常会被 GoalChanged 打断，这是预期路径；下面看维度。
  }
  if (await skills.waitFor(bot, reachedDimension, Math.min(2_000, timeoutMs))) return true;

  try {
    await skills.goToPosition(bot, target.x, target.y, target.z, 0.6);
  } catch {
    // 同上。
  }
  return await skills.waitFor(bot, reachedDimension, Math.max(1_000, timeoutMs - 2_000));
}

/**
 * 身体侧完整流程：检查维度 → 复用现成门/检查材料 → 预检选址 → 放框 →
 * 点火 → 走进门 → 等维度切换。
 *
 * **失败不清理现场。** 已放的黑曜石是资产，不是垃圾；回执会说明失败在哪一步、
 * 现场保留了什么、下一步该怎么做。
 */
export async function enterNether(bot: any): Promise<PortalRoutineResult> {
  const initialDimension = dimensionOf(bot);
  if (isNetherDimension(initialDimension)) {
    return { ok: true, step: '检查维度', message: portalReceipt('已经在下界，不需要再建传送门。', [`当前维度：${initialDimension}`]) };
  }

  let step = '检查附近传送门';
  try {
    const existingPortal = findNearbyPortal(bot);
    if (existingPortal != null) {
      step = '进入已有传送门';
      const entered = await walkIntoPortal(bot, existingPortal, initialDimension);
      if (entered) {
        return {
          ok: true,
          step,
          message: portalReceipt('已进入下界。', [
            `先在附近 ${PORTAL_SEARCH_RADIUS} 格内找现成的门，找到了就直接用：${formatPoint(existingPortal)}`,
            '没有另建，也没有改动任何方块。',
            `维度：${initialDimension ?? '未知'} → ${dimensionOf(bot) ?? '未知'}`,
          ]),
        };
      }
      return {
        ok: false,
        step,
        message: portalReceipt('找到了现成传送门，但没能走进去。', [
          `传送门位置：${formatPoint(existingPortal)}`,
          `当前维度仍是：${dimensionOf(bot) ?? '未知'}`,
          '现场没有改动任何方块。可以再调一次；若反复失败，先检查门内是否被堵住或寻路是否卡住。',
        ]),
      };
    }

    step = '检查材料';
    const initialCounts = world.getInventoryCounts(bot) as Record<string, number>;
    const initialMaterials = assessPortalMaterials(initialCounts);
    if (!initialMaterials.ok) {
      return {
        ok: false,
        step,
        message: portalReceipt('材料不足，没有开始搭建，现场未改动。', [
          initialMaterials.message,
          '先补够 10 块黑曜石和 1 个打火石，再调 enterNether。',
        ]),
      };
    }

    step = '检查点火授权';
    const verdict = permits.isAllowed('ignite', opContextFor(bot), Date.now());
    if (!verdict.allowed) {
      return {
        ok: false,
        step,
        message: portalReceipt('材料够，但点火未授权，因此没有开始搭建。', [
          '点火受危险操作闸门保护。请先调用 allowDangerousOps（ops="ignite"、calls 建议 1，或 minutes 建议 1），再调 enterNether。',
          '现场未改动。',
        ]),
      };
    }

    step = '选址与预检';
    const feet = world.getPosition(bot) as PortalPoint;
    const probe: BlockNameProbe = (x, y, z) => blockNameAt(bot, { x, y, z });
    const selected = selectPortalPlan(feet, probe, {
      radius: 8,
      forbiddenBlocks: [
        intPoint(feet.x, feet.y, feet.z),
        intPoint(feet.x, feet.y + 1, feet.z),
      ],
    });
    if (selected.plan == null || selected.evaluation == null) {
      return {
        ok: false,
        step,
        message: portalReceipt('没有找到安全的建门位置，现场未改动。', [
          selected.reason,
          '可以走到更平坦、旁边有 2 格空位的地方再调一次。',
        ]),
      };
    }

    const plan = selected.plan;
    const existingObsidian = selected.evaluation.existingObsidian;
    const requiredObsidian = Math.max(0, NETHER_PORTAL_OBSIDIAN_COST - existingObsidian);
    const materials = assessPortalMaterials(initialCounts, requiredObsidian);
    if (!materials.ok) {
      return {
        ok: false,
        step,
        message: portalReceipt('材料不足以补完这个门框，现场未改动。', [
          `已找到门址 ${formatPoint(plan.base)}，其中已有 ${existingObsidian} 块黑曜石。`,
          materials.message,
        ]),
      };
    }

    if (selected.evaluation.existingPortal) {
      step = '进入半成品中的已点燃传送门';
      const entered = await walkIntoPortal(bot, plan.entryTarget, initialDimension);
      if (entered) {
        return {
          ok: true,
          step,
          message: portalReceipt('已进入下界。', [
            `使用了已有传送门 ${formatPoint(plan.base)}`,
            `维度：${initialDimension ?? '未知'} → ${dimensionOf(bot) ?? '未知'}`,
          ]),
        };
      }
      return {
        ok: false,
        step,
        message: portalReceipt('已有传送门点燃着，但没能走进去。', [
          `传送门位置：${formatPoint(plan.base)}`,
          `当前维度仍是：${dimensionOf(bot) ?? '未知'}`,
          '现场没有改动任何方块。',
        ]),
      };
    }

    const scaffoldBlocks = selected.evaluation.scaffoldBlocks ?? [];
    const scaffoldChoice = chooseScaffoldMaterial(initialCounts, scaffoldBlocks.length);
    if (scaffoldBlocks.length > 0 && scaffoldChoice == null) {
      return {
        ok: false,
        step,
        message: portalReceipt('门框需要临时垫角，但背包里没有合适的垫块，现场未改动。', [
          `这个 4×5 门框有 ${scaffoldBlocks.length} 个角还是空气；放侧柱和顶边前需要普通方块垫一下。`,
          '准备 4 个 dirt / cobblestone / stone / netherrack 之类常见方块后再调一次。',
        ]),
      };
    }

    step = '搭建门框';
    const placed: PortalPoint[] = [];
    const placedScaffolds: PortalPoint[] = [];
    const placeOne = async (
      p: PortalPoint,
      material: string,
      label: string,
    ): Promise<PortalRoutineResult | null> => {
      const name = blockNameAt(bot, p);
      if (material === 'obsidian' && name === 'obsidian') return null;
      if (!isAirBlock(name)) {
        return {
          ok: false,
          step,
          message: portalReceipt('施工途中发现目标格被占用，已停止，没有挖任何方块。', [
            `${label} ${formatPoint(p)} 现在是 ${name ?? '未知'}，不是空气。`,
            `已放黑曜石 ${placed.length} 块，临时垫块 ${placedScaffolds.length} 个。`,
            '现场保留原样，可以换一处再试。',
          ]),
        };
      }
      const placedOk = await skills.placeBlock(bot, material, p.x, p.y, p.z);
      if (!placedOk) {
        return {
          ok: false,
          step,
          message: portalReceipt('搭建失败，已停止，没有拆任何方块。', [
            `卡在${label} ${formatPoint(p)}；这次成功放下 ${placed.length} 块新黑曜石、${placedScaffolds.length} 个临时垫块。`,
            placed.length === 0 && placedScaffolds.length === 0
              ? '现场没有新增方块。'
              : `已放：${[...placedScaffolds, ...placed].map(formatPoint).join('、')}`,
            '可以走到更开阔的位置重试；如果重试，工具会优先复用附近已经放好的门框。',
          ]),
        };
      }
      if (material === 'obsidian') placed.push(p);
      else placedScaffolds.push(p);
      return null;
    };

    // 先垫底角，再放底边和两根侧柱；侧柱到顶后才垫顶角，最后放顶边中块。
    // 这个顺序保证每一格都有相邻面可依附，不需要拆现场任何方块。
    for (const p of scaffoldBlocks.filter((q) => q.y === plan.base.y)) {
      const failure = await placeOne(p, scaffoldChoice?.material ?? 'dirt', '底角垫块');
      if (failure != null) return failure;
    }
    for (const p of plan.frameBlocks.slice(0, 8)) {
      const failure = await placeOne(p, 'obsidian', '黑曜石');
      if (failure != null) return failure;
    }
    for (const p of scaffoldBlocks.filter((q) => q.y === plan.base.y + 4)) {
      const failure = await placeOne(p, scaffoldChoice?.material ?? 'dirt', '顶角垫块');
      if (failure != null) return failure;
    }
    for (const p of plan.frameBlocks.slice(8)) {
      const failure = await placeOne(p, 'obsidian', '黑曜石');
      if (failure != null) return failure;
    }

    const missingFrame = plan.frameBlocks.filter((p) => blockNameAt(bot, p) !== 'obsidian');
    if (missingFrame.length > 0) {
      return {
        ok: false,
        step: '验证门框',
        message: portalReceipt('门框没有完整落下，未点火。', [
          `还缺 ${missingFrame.length} 格：${missingFrame.map(formatPoint).join('、')}`,
          `这次新放 ${placed.length} 块黑曜石、${placedScaffolds.length} 个垫角块；现场保留，不拆任何方块。`,
        ]),
      };
    }

    step = '点燃传送门';
    const ignitionName = blockNameAt(bot, plan.ignitionBlock);
    if (ignitionName !== 'obsidian') {
      return {
        ok: false,
        step,
        message: portalReceipt('点火前检查失败：点火位置不是黑曜石，现场保留。', [
          `点火位置 ${formatPoint(plan.ignitionBlock)} 现在是 ${ignitionName ?? '未知'}。`,
        ]),
      };
    }
    let ignitionBlock: any = null;
    try {
      ignitionBlock = bot.blockAt?.(new Vec3(plan.ignitionBlock.x, plan.ignitionBlock.y, plan.ignitionBlock.z));
    } catch {
      ignitionBlock = null;
    }
    if (ignitionBlock == null) {
      return {
        ok: false,
        step,
        message: portalReceipt('点火前读不到门框方块，现场保留。', [
          `点火位置：${formatPoint(plan.ignitionBlock)}`,
        ]),
      };
    }
    const lit = await skills.useToolOnBlock(bot, 'flint_and_steel', ignitionBlock);
    if (!lit) {
      return {
        ok: false,
        step,
        message: portalReceipt('门框已搭好，但点火失败；现场保留，不拆任何方块。', [
          '点火走的是危险操作闸门。如果刚才的日志说没有 ignite 许可，先 allowDangerousOps(ops="ignite", calls=1) 再调 enterNether。',
          '如果日志说准星/方块挡住，走到门框正面再调一次。',
        ]),
      };
    }

    const portalAppeared = await skills.waitFor(
      bot,
      () => plan.interiorBlocks.some((p) => isPortalBlock(blockNameAt(bot, p))),
      5_000,
    );
    if (!portalAppeared) {
      return {
        ok: false,
        step: '确认传送门出现',
        message: portalReceipt('已经点火，但 5 秒内没看到传送门方块，未进去。', [
          '门框保留着，没有拆任何方块。可能是点火没有落在门内，或服务端还没同步。',
          '先看附近是否出现紫色传送门；没有就走到门框正面再调一次。',
        ]),
      };
    }

    step = '走进传送门';
    const entered = await walkIntoPortal(bot, plan.entryTarget, initialDimension);
    if (entered) {
      return {
        ok: true,
        step,
        message: portalReceipt('已进入下界。', [
          `先在附近 ${PORTAL_SEARCH_RADIUS} 格内找过现成的门，没有找到（只扫描已加载区块），因此新建。`,
          `传送门位置：${formatPoint(plan.base)}（门面沿 ${plan.axis} 轴）`,
          `这次新放 ${placed.length} 块黑曜石，打火石点火成功。`,
          placedScaffolds.length === 0
            ? '门角都有现成支撑，没有用临时垫块。'
            : `用了 ${placedScaffolds.length} 个 ${scaffoldChoice?.material ?? '普通'} 垫角块（留在原地，不挡门）。`,
          `维度：${initialDimension ?? '未知'} → ${dimensionOf(bot) ?? '未知'}`,
        ]),
      };
    }

    return {
      ok: false,
      step,
      message: portalReceipt('传送门已经点燃，但没能走进下界。', [
        `传送门位置：${formatPoint(plan.base)}，入口目标 ${formatPoint(plan.entryTarget)}。`,
        `当前维度仍是：${dimensionOf(bot) ?? '未知'}`,
        '门框和传送门都保留着，没有拆任何方块。再调一次 enterNether；靠近门框后它会尝试走进去。',
      ]),
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      step,
      message: portalReceipt('下界传送门流程异常中止，现场没有主动拆方块。', [
        `出错步骤：${step}`,
        `错误：${detail}`,
        '如果已放了部分黑曜石或门已点燃，它们都保留着；先看快照，再决定是否重试。',
      ]),
    };
  }
}
