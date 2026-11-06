/**
 * !makeObsidian：水桶 -> 倒岩浆 -> 钻石镐挖取 的黑曜石链路。
 *
 * 这是独立命令文件，避免和 actions / interact / survival 的接入冲突。
 *
 * 安全策略：
 * - 只选岩浆旁边、比岩浆高一格的干燥岸边站位，站上去之后岩浆流不上来；
 * - 倒水继续走 skills.useToolOnBlock 的 pour_water 危险操作闸门；
 * - 挖取用现有 skills.equip / skills.mineBlockAt，不新开一套 mineflayer 原语；
 * - 失败保留已生成的黑曜石和现场，回执写清岩浆/水源坐标与卡住原因。
 */
import Vec3 from 'vec3';
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import { opContextFor, permits } from '../safety/permits.js';
import { td } from '../../shared/prompts.js';
import type { AgentCommand, CommandPerform } from './actions.js';

export const OBSIDIAN_TARGET = 10;
export const LIQUID_SEARCH_RADIUS = 64;

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface ObsidianKitStatus {
  waterBuckets: number;
  emptyBuckets: number;
  diamondPickaxes: number;
  totalBuckets: number;
  ok: boolean;
  missing: string[];
  message: string;
}

export interface SafeLiquidTarget {
  liquid: Point;
  stand: Point;
  distance: number;
}

export interface MakeObsidianResult {
  ok: boolean;
  produced: number;
  message: string;
  /** 已挖到的黑曜石坐标（进度）。 */
  mined?: Point[];
  /** 还能倒几次水。 */
  remainingWaterBuckets?: number;
  /** 下一块候选岩浆/安全站位；没有就是 null。 */
  nextTarget?: { liquid: Point; stand: Point } | null;
  /** 是否因为检测到真实危险而停手。 */
  dangerStop?: boolean;
}

const AIR = new Set(['air', 'cave_air', 'void_air']);
const UNSAFE_FLOOR = new Set([
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


export function isAirName(name: string | null | undefined): boolean {
  return name != null && AIR.has(name);
}

export function isLiquidName(name: string | null | undefined): boolean {
  return name === 'water' || name === 'flowing_water' || name === 'lava' || name === 'flowing_lava';
}

export function isSafeFloorName(name: string | null | undefined): boolean {
  return name != null && !AIR.has(name) && !UNSAFE_FLOOR.has(name);
}

export function pointKey(p: Point): string {
  return String(Math.floor(p.x)) + ',' + String(Math.floor(p.y)) + ',' + String(Math.floor(p.z));
}

export function formatPoint(p: Point): string {
  return '(' + String(Math.floor(p.x)) + ',' + String(Math.floor(p.y)) + ',' + String(Math.floor(p.z)) + ')';
}

function countOf(counts: Record<string, number | undefined> | null | undefined, name: string): number {
  const raw = Number(counts?.[name] ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function assessObsidianKit(
  counts: Record<string, number | undefined> | null | undefined,
): ObsidianKitStatus {
  const waterBuckets = countOf(counts, 'water_bucket');
  const emptyBuckets = countOf(counts, 'bucket');
  const diamondPickaxes = countOf(counts, 'diamond_pickaxe') + countOf(counts, 'netherite_pickaxe');
  const totalBuckets = waterBuckets + emptyBuckets;
  const missing: string[] = [];
  if (totalBuckets === 0) missing.push('一个水桶或者空桶');
  if (diamondPickaxes === 0) missing.push('一把钻石镐或者下界合金镐');
  const ok = missing.length === 0;
  return {
    waterBuckets,
    emptyBuckets,
    diamondPickaxes,
    totalBuckets,
    ok,
    missing,
    message:
      '检查了装备，水桶有 ' + String(waterBuckets) + ' 个，空桶有 ' + String(emptyBuckets) +
      ' 个，能挖黑曜石的镐有 ' + String(diamondPickaxes) + ' 把。' +
      (ok ? '' : '现在还缺' + missing.join('、') + '。'),
  };
}

export type BlockProbe = (x: number, y: number, z: number) => string | null;

function probeName(probe: BlockProbe, p: Point): string | null {
  try {
    return probe(p.x, p.y, p.z);
  } catch {
    return null;
  }
}

export function findLavaStandWithinReach(
  lava: Point,
  probe: BlockProbe,
  maxDistance: number = 4.5,
): Point | null {
  const reach = Number.isFinite(maxDistance) ? Math.max(1, maxDistance) : 4.5;
  const candidates: Array<{ stand: Point; distance: number }> = [];
  for (let dx = 4; dx >= -4; dx--) {
    for (let dz = 4; dz >= -4; dz--) {
      if (dx === 0 && dz === 0) continue;
      const distance = Math.hypot(dx, 1, dz);
      if (distance > reach || distance < 2) continue;
      const stand: Point = { x: lava.x + dx, y: lava.y + 1, z: lava.z + dz };
      const floor: Point = { x: stand.x, y: lava.y, z: stand.z };
      const head: Point = { x: stand.x, y: stand.y + 1, z: stand.z };
      if (!isAirName(probeName(probe, stand))) continue;
      if (!isAirName(probeName(probe, head))) continue;
      if (!isSafeFloorName(probeName(probe, floor))) continue;
      candidates.push({ stand, distance });
    }
  }
  candidates.sort((a, b) => Math.abs(a.distance - 2.5) - Math.abs(b.distance - 2.5));
  return candidates.length > 0 ? candidates[0].stand : null;
}

function evaluateLiquidPerch(
  liquid: Point,
  probe: BlockProbe,
  expectedName: 'lava' | 'water',
): { ok: boolean; stand?: Point; reason: string } {
  const actual = probeName(probe, liquid);
  if (actual !== expectedName) {
    return {
      ok: false,
      reason: formatPoint(liquid) + ' 这里不是' + (expectedName === 'lava' ? '岩浆源' : '水源') + '，读到的是 ' + String(actual ?? '未知') + '。',
    };
  }
  const stand = expectedName === 'lava' ? findLavaStandWithinReach(liquid, probe) : findWaterStandWithinReach(liquid, probe);
  if (stand == null) {
    return {
      ok: false,
      reason:
        formatPoint(liquid) + ' 旁边没有一块高出一格、干燥又能站稳的实心方块。',
    };
  }
  return { ok: true, stand, reason: 'ok' };
}

export function evaluateLavaTarget(lava: Point, probe: BlockProbe): { ok: boolean; stand?: Point; reason: string } {
  return evaluateLiquidPerch(lava, probe, 'lava');
}

export function evaluateWaterSource(water: Point, probe: BlockProbe): { ok: boolean; stand?: Point; reason: string } {
  const actual = probeName(probe, water);
  if (actual !== 'water') {
    return { ok: false, reason: formatPoint(water) + ' 这里不是水源，读到的是 ' + String(actual ?? '未知') + '。' };
  }
  const stand = findWaterStandWithinReach(water, probe);
  if (stand == null) {
    return {
      ok: false,
      reason: formatPoint(water) + ' 周围 4.5 格以内没有干燥又能直接站住的位置。',
    };
  }
  return { ok: true, stand, reason: 'ok' };
}

function distanceBetween(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function chooseSafeLavaTargets(lavas: Point[], origin: Point, probe: BlockProbe): SafeLiquidTarget[] {
  const sorted = [...lavas].sort((a, b) => distanceBetween(a, origin) - distanceBetween(b, origin));
  const seen = new Set<string>();
  const out: SafeLiquidTarget[] = [];
  for (const lava of sorted) {
    const key = pointKey(lava);
    if (seen.has(key)) continue;
    seen.add(key);
    const evaluation = evaluateLavaTarget(lava, probe);
    if (!evaluation.ok || evaluation.stand == null) continue;
    out.push({ liquid: lava, stand: evaluation.stand, distance: distanceBetween(lava, origin) });
  }
  return out;
}

export function chooseSafeWaterSources(waterSources: Point[], origin: Point, probe: BlockProbe): SafeLiquidTarget[] {
  const sorted = [...waterSources].sort((a, b) => distanceBetween(a, origin) - distanceBetween(b, origin));
  const seen = new Set<string>();
  const out: SafeLiquidTarget[] = [];
  for (const water of sorted) {
    const key = pointKey(water);
    if (seen.has(key)) continue;
    seen.add(key);
    const evaluation = evaluateWaterSource(water, probe);
    if (!evaluation.ok || evaluation.stand == null) continue;
    out.push({ liquid: water, stand: evaluation.stand, distance: distanceBetween(water, origin) });
  }
  return out;
}

function blockAtPoint(bot: any, p: Point): any {
  try {
    return bot?.blockAt?.(new Vec3(p.x, p.y, p.z)) ?? null;
  } catch {
    return null;
  }
}

function blockNameAt(bot: any, p: Point): string | null {
  const block = blockAtPoint(bot, p);
  return typeof block?.name === 'string' ? block.name : null;
}

function inventoryCounts(bot: any): Record<string, number> {
  try {
    return (world.getInventoryCounts(bot) as Record<string, number>) ?? {};
  } catch {
    return {};
  }
}

function findLiquidSources(bot: any, name: 'lava' | 'water'): Point[] {
  try {
    const blocks: any[] = world.getNearestBlocksWhere(
      bot,
      (block: any) => block?.name === name && (block.metadata == null || block.metadata === 0),
      LIQUID_SEARCH_RADIUS,
      256,
    );
    const out: Point[] = [];
    for (const block of blocks) {
      if (block?.position == null) continue;
      out.push({ x: Math.floor(block.position.x), y: Math.floor(block.position.y), z: Math.floor(block.position.z) });
    }
    return out;
  } catch {
    return [];
  }
}

function makeProbe(bot: any): BlockProbe {
  return (x, y, z) => blockNameAt(bot, { x, y, z });
}


async function goToStand(bot: any, stand: Point): Promise<boolean> {
  try {
    return await skills.goToPosition(bot, stand.x, stand.y, stand.z, 1);
  } catch {
    return false;
  }
}

async function ensureWaterBucket(bot: any, source: SafeLiquidTarget): Promise<string | null> {
  const waterBlock = blockAtPoint(bot, source.liquid);
  if (waterBlock == null || waterBlock.name !== 'water') {
    return '水源 ' + formatPoint(source.liquid) + ' 已经不在了，那里现在是 ' + String(waterBlock?.name ?? '未知') + '。';
  }
  if (waterBlock.metadata != null && waterBlock.metadata !== 0) {
    return '水源 ' + formatPoint(source.liquid) + ' 是流动的水，装不进桶。';
  }
  if (!(await goToStand(bot, source.stand))) {
    return '没能走到水源岸边的 ' + formatPoint(source.stand) + '。';
  }
  const beforeWater = inventoryCounts(bot)['water_bucket'] ?? 0;
  const filled = await skills.useToolOnBlock(bot, 'bucket', waterBlock);
  if (!filled) {
    return '在 ' + formatPoint(source.liquid) + ' 装水没有成功。';
  }
  const ok = await skills.waitFor(bot, () => (inventoryCounts(bot)['water_bucket'] ?? 0) > beforeWater, 2_000);
  if (!ok) {
    return '装完水之后背包里没有出现 water_bucket。';
  }
  return null;
}

const waterBucketCount = (counts: Record<string, number>): number => counts['water_bucket'] ?? 0;
const obsidianCount = (counts: Record<string, number>): number => Math.max(0, Math.floor(counts['obsidian'] ?? 0));

function successReceipt(before: number, produced: number): string {
  return '现在有 ' + String(before + produced) + ' 块黑曜石，目标是 10 块，原本有 ' + String(before) + ' 块，这次新挖了 ' + String(produced) + ' 块。';
}

export function failureReceipt(
  before: number,
  produced: number,
  mined: Point[],
  failures: string[],
  extra: string,
): string {
  const lines = [
    '没能拿到 10 块黑曜石，现在有 ' + String(before + produced) + ' 块，原本有 ' + String(before) + ' 块，这次新挖了 ' + String(produced) + ' 块。',
  ];
  if (extra !== '') lines.push(extra);
  if (mined.length > 0) lines.push('已经挖到的黑曜石在 ' + mined.map(formatPoint).join('、') + '。');
  if (failures.length > 0) lines.push('中间失败过的地方有\n- ' + failures.slice(0, 8).join('\n- '));
  return lines.join('\n');
}

async function makeObsidianInner(bot: any): Promise<MakeObsidianResult> {
  try {
    const startCounts = inventoryCounts(bot);
    const before = obsidianCount(startCounts);
    const need = Math.max(0, OBSIDIAN_TARGET - before);
    const kit = assessObsidianKit(startCounts);
    if (need === 0) {
      return { ok: true, produced: 0, message: successReceipt(before, 0) };
    }
    if (!kit.ok) {
      return {
        ok: false,
        produced: 0,
        message: failureReceipt(before, 0, [], [], kit.message),
      };
    }

    const verdict = permits.isAllowed('pour_water', opContextFor(bot), Date.now());
    if (!verdict.allowed) {
      return {
        ok: false,
        produced: 0,
        message: '现在不能倒水，这一步需要 pour_water 授权，但是还没有授权。',
      };
    }

    const origin = (() => {
      try {
        const p: any = world.getPosition(bot);
        return { x: Number(p?.x ?? 0), y: Number(p?.y ?? 64), z: Number(p?.z ?? 0) };
      } catch {
        return { x: 0, y: 64, z: 0 };
      }
    })();
    const probe = makeProbe(bot);

    const allLavaCandidates = findLiquidSources(bot, 'lava');
    const nearbyLavaCandidates = selectNearbyLavaCandidates(allLavaCandidates, origin, 6, 2);
    if (nearbyLavaCandidates.length === 0) {
      const lines = [
        '我现在站的地方，水平 6 格以内、垂直上下 2 格以内都没有岩浆源。',
        nearestLavaInfo(allLavaCandidates, origin),
      ];
      return {
        ok: false,
        produced: 0,
        message: failureReceipt(before, 0, [], [], lines.join('\n')),
      };
    }
    const lavaCandidates = nearbyLavaCandidates;
    const lavaTargets = chooseSafeLavaTargets(lavaCandidates, origin, probe);
    if (lavaTargets.length === 0) {
      const recoveryReasons: string[] = [];
      for (const lava of lavaCandidates.slice(0, 3)) {
        const attempt = await tryRecoverLavaStand(bot, lava, probe);
        recoveryReasons.push(attempt.reason);
        if (attempt.target != null) {
          lavaTargets.push(attempt.target);
          break;
        }
      }
      if (lavaTargets.length === 0) {
        const first = lavaCandidates[0] as Point;
        const plan = planLavaStand(first, probe);
        const lines = [
          plan.reason,
          nearestLavaInfo(lavaCandidates, origin),
        ].filter((line) => line !== '');
        return {
          ok: false,
          produced: 0,
          message: failureReceipt(before, 0, [], recoveryReasons, lines.join('\n')),
        };
      }
    }

    const needWaterRefill = kit.waterBuckets < need;
    let waterTargets: SafeLiquidTarget[] = [];
    if (needWaterRefill) {
      const waterCandidates = findLiquidSources(bot, 'water');
      if (waterCandidates.length === 0) {
        return {
          ok: false,
          produced: 0,
          message: failureReceipt(
            before,
            0,
            [],
            [],
            '背包里的水桶只够用 ' + String(kit.waterBuckets) + ' 次，附近 ' + String(LIQUID_SEARCH_RADIUS) + ' 格以内没有找到水源。\n' + nearestLavaInfo(lavaCandidates, origin),
          ),
        };
      }
      waterTargets = chooseSafeWaterSources(waterCandidates, origin, probe);
      if (waterTargets.length === 0) {
        const recoveryReasons: string[] = [];
        for (const water of waterCandidates.slice(0, 3)) {
          const attempt = await tryRecoverWaterStand(bot, water, probe);
          recoveryReasons.push(attempt.reason);
          if (attempt.target != null) {
            waterTargets.push(attempt.target);
            break;
          }
        }
        if (waterTargets.length === 0) {
          const first = waterCandidates[0] as Point;
          const plan = planWaterStand(first, probe);
          const lines = [
            '能用的水源在 ' + formatPoint(first) + '。',
            plan.reason,
            nearestLavaInfo(lavaCandidates, origin),
          ].filter((line) => line !== '');
          return {
            ok: false,
            produced: 0,
            message: failureReceipt(before, 0, [], recoveryReasons, lines.join('\n')),
          };
        }
      }
    }

    const usedLava = new Set<string>();
    const mined: Point[] = [];
    const failures: string[] = [];
    let produced = 0;
    let attempts = 0;
    const maxAttempts = need * 4 + 12;
    let waterIndex = 0;
    let dangerStop = false;
    let lastSafeStand: Point | null = null;

    while (!dangerStop && produced < need && attempts < maxAttempts) {
      // 被 Stop / 保命反射打断：controlledLavaOperation 不阻止真实危险中断；
      // 这里立刻收手并把已完成进度带回去，而不是继续硬跑。
      if ((bot as { interrupt_code?: unknown }).interrupt_code === true) {
        failures.push('被 Stop 或者保命反射打断了，已经挖到 ' + String(produced) + ' 块，一共需要 ' + String(need) + ' 块。');
        break;
      }
      attempts++;
      const counts = inventoryCounts(bot);
      produced = Math.max(produced, Math.max(0, obsidianCount(counts) - before));
      if (produced >= need) break;

      if (waterBucketCount(counts) <= 0) {
        if (waterTargets.length === 0) {
          failures.push('需要重新装水，可是附近没有安全的水源。');
          break;
        }
        const source = waterTargets[waterIndex % waterTargets.length] as SafeLiquidTarget;
        waterIndex++;
        const refillError = await ensureWaterBucket(bot, source);
        if (refillError != null) {
          failures.push(refillError);
          continue;
        }
      }

      const target = lavaTargets.find((candidate) => !usedLava.has(pointKey(candidate.liquid)));
      if (target == null) {
        failures.push('没有别的安全岩浆源可以用了，已经试过 ' + String(usedLava.size) + ' 个。');
        break;
      }
      usedLava.add(pointKey(target.liquid));

      if (!(await goToStand(bot, target.stand))) {
        failures.push('没能走到岩浆岸边的 ' + formatPoint(target.stand) + '，目标岩浆在 ' + formatPoint(target.liquid) + '。');
        continue;
      }
      const posAfterWalk = (() => {
        try {
          const p: any = world.getPosition(bot);
          return { x: Number(p?.x ?? origin.x), y: Number(p?.y ?? origin.y), z: Number(p?.z ?? origin.z) };
        } catch {
          return origin;
        }
      })();
      if (!isWithinOperationBox(posAfterWalk, origin, 6, 2)) {
        failures.push('寻路的时候走出范围了，目标岩浆在 ' + formatPoint(target.liquid) + '，安全位置在 ' + formatPoint(target.stand) + '，实际把我带到了 ' + formatPoint(posAfterWalk) + '，超出了水平 6 格、垂直上下 2 格的限制。');
        dangerStop = true;
        break;
      }
      if (!isStandingSafelyAt(bot, target)) {
        failures.push('寻路结束以后我没有停在安全操作位 ' + formatPoint(target.stand) + '，目标岩浆在 ' + formatPoint(target.liquid) + '。');
        continue;
      }

      const feetBeforePour = (() => {
        try {
          const p: any = world.getPosition(bot);
          return { x: Number(p?.x ?? target.stand.x), y: Number(p?.y ?? target.stand.y), z: Number(p?.z ?? target.stand.z) };
        } catch {
          return target.stand;
        }
      })();
      if (isUnderfootOrSupport(target.liquid, feetBeforePour)) {
        failures.push('没有往 ' + formatPoint(target.liquid) + ' 浇筑，也没有把它挖掉，因为它在我的脚下或者有承重作用。');
        continue;
      }
      const lavaDistanceBeforePour = nearestLavaDistance(probe, feetBeforePour, 3);
      if (lavaDistanceBeforePour < 2) {
        failures.push('没有往 ' + formatPoint(target.liquid) + ' 浇筑，也没有把它挖掉，因为我离它只有 ' + String(Math.round(lavaDistanceBeforePour * 10) / 10) + ' 格，小于 2 格的下限。');
        continue;
      }
      lastSafeStand = target.stand;

      const lavaBlock = blockAtPoint(bot, target.liquid);
      if (lavaBlock == null || lavaBlock.name !== 'lava' || (lavaBlock.metadata != null && lavaBlock.metadata !== 0)) {
        failures.push('岩浆源 ' + formatPoint(target.liquid) + ' 已经不是岩浆了，那里现在是 ' + String(lavaBlock?.name ?? '未知') + '，这一处跳过。');
        continue;
      }

      const poured = await skills.useToolOnBlock(bot, 'water_bucket', lavaBlock);
      if (!poured) {
        failures.push('在 ' + formatPoint(target.liquid) + ' 倒水没有成功。');
        continue;
      }
      if (!isStandingSafelyAt(bot, target)) {
        failures.push('倒完水之后我偏离了安全操作位 ' + formatPoint(target.stand) + '，目标岩浆在 ' + formatPoint(target.liquid) + '。');
        continue;
      }
      const becameObsidian = await skills.waitFor(
        bot,
        () => blockNameAt(bot, target.liquid) === 'obsidian',
        10_000,
      );
      if (!becameObsidian) {
        let nearbyObsidian: any = null;
        try {
          nearbyObsidian = world.getNearestBlock(bot, 'obsidian', 16);
        } catch {
          nearbyObsidian = null;
        }
        failures.push('倒完水等了 10 秒，' + formatPoint(target.liquid) + ' 还是没有变成 obsidian，那里读到的是 ' + String(blockNameAt(bot, target.liquid) ?? '未知') + '。' + (nearbyObsidian == null ? '16 格以内也没有找到别的 obsidian。' : '附近其他的 obsidian 在 ' + formatPoint({ x: Math.floor(nearbyObsidian.position.x), y: Math.floor(nearbyObsidian.position.y), z: Math.floor(nearbyObsidian.position.z) }) + '。'));
        dangerStop = true;
        break;
      }
      const feetBeforeMine = (() => {
        try {
          const p: any = world.getPosition(bot);
          return { x: Number(p?.x ?? target.stand.x), y: Number(p?.y ?? target.stand.y), z: Number(p?.z ?? target.stand.z) };
        } catch {
          return target.stand;
        }
      })();
      if (isUnderfootOrSupport(target.liquid, feetBeforeMine)) {
        failures.push('没有挖 ' + formatPoint(target.liquid) + ' 这块黑曜石，因为它在我的脚下或者有承重作用。');
        continue;
      }
      if (!isSafeGroundAt(probe, feetBeforeMine)) {
        const retreat = findRetreatStand(probe, feetBeforeMine, 4);
        if (retreat != null) await goToStand(bot, retreat);
        failures.push('挖之前发现脚下或者岩浆有危险，就停手了' + (retreat == null ? '，也没有找到安全的后退位置' : '，并且后退到了 ' + formatPoint(retreat)) + '。');
        dangerStop = true;
        break;
      }
      lastSafeStand = target.stand;

      const beforeMine = obsidianCount(inventoryCounts(bot));
      const equipped = await skills.equip(bot, 'diamond_pickaxe');
      if (!equipped) {
        failures.push('已经在 ' + formatPoint(target.liquid) + ' 生成了黑曜石，但是没能把钻石镐装备上。');
        continue;
      }
      const minedOk = await skills.mineBlockAt(bot, target.liquid.x, target.liquid.y, target.liquid.z);
      if (!minedOk) {
        failures.push('已经在 ' + formatPoint(target.liquid) + ' 生成了黑曜石，但是没能把它挖下来。');
        continue;
      }
      const picked = await skills.waitFor(bot, () => obsidianCount(inventoryCounts(bot)) > beforeMine, 4_000);
      if (!picked) {
        failures.push('挖掉了 ' + formatPoint(target.liquid) + ' 的黑曜石，但是 4 秒以内它没有进到背包里。');
        continue;
      }
      mined.push(target.liquid);
      produced = Math.max(produced, obsidianCount(inventoryCounts(bot)) - before);

      const feetAfterMine = (() => {
        try {
          const p: any = world.getPosition(bot);
          return { x: Number(p?.x ?? target.stand.x), y: Number(p?.y ?? target.stand.y), z: Number(p?.z ?? target.stand.z) };
        } catch {
          return target.stand;
        }
      })();
      if (!isSafeGroundAt(probe, feetAfterMine)) {
        const retreat = findRetreatStand(probe, feetAfterMine, 4);
        const retreated = retreat == null ? false : await goToStand(bot, retreat);
        failures.push('挖完 ' + formatPoint(target.liquid) + ' 之后发现脚下或者岩浆有危险，立刻停手了' + (retreat == null ? '，也没有找到安全的后退位置' : (retreated ? '，并且后退到了 ' + formatPoint(retreat) : '，想后退到 ' + formatPoint(retreat) + ' 却没有成功')) + '。');
        dangerStop = true;
        break;
      }
      lastSafeStand = target.stand;
    }

    const nextTarget = lavaTargets.find((candidate) => !usedLava.has(pointKey(candidate.liquid))) ?? null;
    const remainingWaterBuckets = inventoryCounts(bot)['water_bucket'] ?? 0;
    if (produced >= need) {
      return { ok: true, produced, message: successReceipt(before, produced), mined, remainingWaterBuckets, nextTarget, dangerStop };
    }
    const progressLine =
      '现在已经挖到 ' + String(produced) + ' 块，一共需要 ' + String(need) + ' 块，背包里还剩 ' + String(remainingWaterBuckets) + ' 个水桶。';
    return {
      ok: false,
      produced,
      message: failureReceipt(before, produced, mined, failures, progressLine),
      mined,
      remainingWaterBuckets,
      nextTarget,
      dangerStop,
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      produced: 0,
      message: '执行的时候出错中止了，错误是' + detail + '。',
      mined: [],
      remainingWaterBuckets: inventoryCounts(bot)['water_bucket'] ?? 0,
      nextTarget: null,
      dangerStop: false,
    };
  }
}

/**
 * makeObsidian 期间置 controlledLavaOperation：安全站位上的 lava.nearby 不抢断动作。
 * 真实入岩浆/水、流血、无支撑仍会走 L5 强制中断；结束后恢复原值。
 */
export async function makeObsidian(bot: any): Promise<MakeObsidianResult> {
  const flagged = bot as { controlledLavaOperation?: boolean };
  const previous = flagged.controlledLavaOperation === true;
  flagged.controlledLavaOperation = true;
  try {
    return await makeObsidianInner(bot);
  } finally {
    flagged.controlledLavaOperation = previous;
  }
}

/** 中断/超时用的进度事实：已挖数量、坐标、剩余水桶。 */
export function formatMakeObsidianProgress(outcome: MakeObsidianResult | null): string {
  if (outcome == null) return '读不到这一轮的进度。';
  const mined = (outcome.mined ?? []).map(formatPoint).join('、');
  return (
    '现在已经挖到 ' + String(outcome.produced ?? 0) + ' 块，目标是 10 块' +
    (mined === '' ? '' : '，已经挖到的位置在 ' + mined) +
    '，背包里还剩 ' + String(outcome.remainingWaterBuckets ?? 0) + ' 个水桶。'
  );
}

function runMakeObsidianAction(timeoutMinutes: number): CommandPerform {
  const wrapped = async function (agent: any): Promise<string | null | undefined> {
    let outcome: MakeObsidianResult | null = null;
    const result = await agent.actions.runAction(
      'action:makeObsidian',
      async () => {
        outcome = await makeObsidian(agent.bot);
        skills.log(agent.bot, outcome.message);
      },
      { timeout: timeoutMinutes },
    );
    const finalOutcome = outcome as MakeObsidianResult | null;
    if (result.interrupted && !result.timedout) {
      return '这次动作被中断了，打断它的是 Stop 或者保命反射。' + formatMakeObsidianProgress(finalOutcome);
    }
    if (result.timedout) {
      return '这次动作超时了，' + String(timeoutMinutes) + ' 分钟没有跑完。' + formatMakeObsidianProgress(finalOutcome);
    }
    return finalOutcome?.message ?? result.message ?? '';
  };
  (wrapped as CommandPerform).longRunning = true;
  return wrapped as CommandPerform;
}

export const makeObsidianActionList: AgentCommand[] = [
  {
    name: '!makeObsidian',
    description: td('makeObsidian'),
    params: {},
    perform: runMakeObsidianAction(15),
  },
];

export function findWaterStandWithinReach(
  water: Point,
  probe: BlockProbe,
  maxDistance: number = 4.5,
): Point | null {
  const reach = Number.isFinite(maxDistance) ? Math.max(1, maxDistance) : 4.5;
  const candidates: Array<{ stand: Point; distance: number; above: boolean }> = [];
  for (const dy of [1, 0]) {
    for (let dx = 4; dx >= -4; dx--) {
      for (let dz = 4; dz >= -4; dz--) {
        if (dx === 0 && dz === 0) continue;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > reach) continue;
        const stand: Point = { x: water.x + dx, y: water.y + dy, z: water.z + dz };
        const floor: Point = { x: stand.x, y: stand.y - 1, z: stand.z };
        const head: Point = { x: stand.x, y: stand.y + 1, z: stand.z };
        if (!isAirName(probeName(probe, stand))) continue;
        if (!isAirName(probeName(probe, head))) continue;
        if (!isSafeFloorName(probeName(probe, floor))) continue;
        candidates.push({ stand, distance, above: dy === 1 });
      }
    }
  }
  candidates.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.above !== b.above) return a.above ? -1 : 1;
    if (a.stand.x !== b.stand.x) return a.stand.x - b.stand.x;
    return a.stand.z - b.stand.z;
  });
  return candidates.length > 0 ? candidates[0].stand : null;
}

function hasAdjacentSupport(probe: BlockProbe, target: Point): boolean {
  const neighbors = [
    { x: target.x + 1, y: target.y, z: target.z },
    { x: target.x - 1, y: target.y, z: target.z },
    { x: target.x, y: target.y + 1, z: target.z },
    { x: target.x, y: target.y - 1, z: target.z },
    { x: target.x, y: target.y, z: target.z + 1 },
    { x: target.x, y: target.y, z: target.z - 1 },
  ];
  return neighbors.some((p) => isSafeFloorName(probeName(probe, p)));
}

export interface ScaffoldStandPlan {
  stand: Point;
  floor: Point;
  distance: number;
}

export function findScaffoldStand(
  water: Point,
  probe: BlockProbe,
  maxDistance: number = 4.5,
): ScaffoldStandPlan | null {
  const reach = Number.isFinite(maxDistance) ? Math.max(1, maxDistance) : 4.5;
  const candidates: ScaffoldStandPlan[] = [];
  for (const dy of [1, 0]) {
    for (let dx = 4; dx >= -4; dx--) {
      for (let dz = 4; dz >= -4; dz--) {
        if (dx === 0 && dz === 0) continue;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > reach) continue;
        const stand: Point = { x: water.x + dx, y: water.y + dy, z: water.z + dz };
        const floor: Point = { x: stand.x, y: stand.y - 1, z: stand.z };
        const head: Point = { x: stand.x, y: stand.y + 1, z: stand.z };
        if (!isAirName(probeName(probe, stand))) continue;
        if (!isAirName(probeName(probe, head))) continue;
        if (!isAirName(probeName(probe, floor))) continue;
        if (!hasAdjacentSupport(probe, floor)) continue;
        candidates.push({ stand, floor, distance });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.length > 0 ? candidates[0] : null;
}

const SAFE_TO_MINE = new Set([
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern',
  'snow',
  'dirt',
  'grass_block',
  'sand',
  'gravel',
  'stone',
  'cobblestone',
  'deepslate',
  'cobbled_deepslate',
  'oak_leaves',
  'spruce_leaves',
  'birch_leaves',
]);

export interface MineStandPlan {
  stand: Point;
  mines: Point[];
  distance: number;
}

export function findMineStand(
  water: Point,
  probe: BlockProbe,
  maxDistance: number = 4.5,
): MineStandPlan | null {
  const reach = Number.isFinite(maxDistance) ? Math.max(1, maxDistance) : 4.5;
  const candidates: MineStandPlan[] = [];
  for (const dy of [1, 0]) {
    for (let dx = 4; dx >= -4; dx--) {
      for (let dz = 4; dz >= -4; dz--) {
        if (dx === 0 && dz === 0) continue;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > reach) continue;
        const stand: Point = { x: water.x + dx, y: water.y + dy, z: water.z + dz };
        const floor: Point = { x: stand.x, y: stand.y - 1, z: stand.z };
        const head: Point = { x: stand.x, y: stand.y + 1, z: stand.z };
        if (!isSafeFloorName(probeName(probe, floor))) continue;
        const feetName = probeName(probe, stand);
        const headName = probeName(probe, head);
        const mines: Point[] = [];
        if (!isAirName(feetName) && feetName != null && SAFE_TO_MINE.has(feetName)) mines.push(stand);
        if (!isAirName(headName) && headName != null && SAFE_TO_MINE.has(headName)) mines.push(head);
        if (mines.length === 0) continue;
        candidates.push({ stand, mines, distance });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.length > 0 ? candidates[0] : null;
}

export interface WaterStandRecovery {
  mode: 'existing' | 'scaffold' | 'mine' | 'none';
  stand?: Point;
  floor?: Point;
  mines?: Point[];
  reason: string;
}

export function planWaterStand(water: Point, probe: BlockProbe): WaterStandRecovery {
  const existing = findWaterStandWithinReach(water, probe);
  if (existing != null) return { mode: 'existing', stand: existing, reason: '已经有干燥的站位了。' };
  const scaffold = findScaffoldStand(water, probe);
  if (scaffold != null) {
    return {
      mode: 'scaffold',
      stand: scaffold.stand,
      floor: scaffold.floor,
      reason: '没有现成的站位，需要先在 ' + formatPoint(scaffold.floor) + ' 垫一块圆石。',
    };
  }
  const mine = findMineStand(water, probe);
  if (mine != null) {
    return {
      mode: 'mine',
      stand: mine.stand,
      mines: mine.mines,
      reason: '没有现成的站位，需要先挖掉 ' + mine.mines.map(formatPoint).join('、') + '。',
    };
  }
  return { mode: 'none', reason: '水源 ' + formatPoint(water) + ' 周围 4.5 格以内，没有可以站住、可以垫块或者可以挖开的空位。' };
}

export function nearestLavaInfo(lavas: Point[], origin: Point): string {
  if (lavas.length === 0) return '附近没有找到岩浆源。';
  const sorted = [...lavas].sort((a, b) => distanceBetween(a, origin) - distanceBetween(b, origin));
  const nearest = sorted[0] as Point;
  const distance = Math.round(distanceBetween(nearest, origin) * 10) / 10;
  return '离我最近的岩浆源在 ' + formatPoint(nearest) + '，距离 ' + String(distance) + ' 格。';
}

interface WaterRecoveryAttempt {
  target?: SafeLiquidTarget;
  reason: string;
  nextStep: string;
}

async function tryRecoverWaterStand(
  bot: any,
  water: Point,
  probe: BlockProbe,
): Promise<WaterRecoveryAttempt> {
  const plan = planWaterStand(water, probe);
  if (plan.mode === 'existing' && plan.stand != null) {
    return {
      target: { liquid: water, stand: plan.stand, distance: 0 },
      reason: '已经有干燥的站位了。',
      nextStep: '直接重试 makeObsidian。',
    };
  }
  if (plan.mode === 'scaffold' && plan.stand != null && plan.floor != null) {
    const counts = inventoryCounts(bot);
    if ((counts['cobblestone'] ?? 0) <= 0) {
      return {
        reason: '水源 ' + formatPoint(water) + ' 旁边没有现成的站位，需要先在 ' + formatPoint(plan.floor) + ' 垫一块圆石，可是背包里没有 cobblestone。',
        nextStep: '先 collectBlocks(type="cobblestone", num=1)，再 goToCoordinates' + formatPoint(plan.floor) + ' 后 placeBlock(type="cobblestone", x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')，最后重试 makeObsidian。',
      };
    }
    const placed = await skills.placeBlock(bot, 'cobblestone', plan.floor.x, plan.floor.y, plan.floor.z);
    if (!placed) {
      return {
        reason: '试着在水源 ' + formatPoint(water) + ' 旁边垫一块圆石到 ' + formatPoint(plan.floor) + '，没有成功。',
        nextStep: '先走到 ' + formatPoint(plan.stand) + ' 附近，再 placeBlock(type="cobblestone", x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')。',
      };
    }
    const after = planWaterStand(water, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: water, stand: after.stand, distance: 0 },
        reason: '已经用圆石垫出了装水的位置 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '圆石放下以后仍然没有形成安全的装水位置，水源在 ' + formatPoint(water) + '。',
      nextStep: '先 goToCoordinates' + formatPoint(plan.stand) + ' 看看现场，再决定 placeBlock 或 mineBlock。',
    };
  }
  if (plan.mode === 'mine' && plan.stand != null && plan.mines != null && plan.mines.length > 0) {
    const mined: Point[] = [];
    for (const target of plan.mines) {
      const block = blockAtPoint(bot, target);
      if (block == null) continue;
      let distance: number;
      try {
        distance = bot.entity.position.distanceTo(block.position);
      } catch {
        distance = Number.POSITIVE_INFINITY;
      }
      if (!Number.isFinite(distance) || distance > 4.5) {
        return {
          reason: '水源 ' + formatPoint(water) + ' 旁边有遮挡 ' + formatPoint(target) + '，可是我现在够不着它，距离 ' + String(Number.isFinite(distance) ? Math.round(distance * 10) / 10 : '未知') + ' 格。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      const ok = await skills.mineBlockAt(bot, target.x, target.y, target.z);
      if (!ok) {
        return {
          reason: '试着挖掉水源 ' + formatPoint(water) + ' 旁边的遮挡 ' + formatPoint(target) + '，没有成功。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      mined.push(target);
    }
    const after = planWaterStand(water, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: water, stand: after.stand, distance: 0 },
        reason: '已经挖开了遮挡，装水的位置在 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '挖掉了 ' + mined.map(formatPoint).join('、') + '，但是仍然没有形成安全的装水位置，水源在 ' + formatPoint(water) + '。',
      nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后检查头顶/脚下，再 placeBlock 或 mineBlock。',
    };
  }
  return {
    reason: plan.reason,
    nextStep: 'goToCoordinates' + formatPoint(water) + ' 后 placeBlock 垫脚或 mineBlock 挖遮挡，再重试 makeObsidian。',
  };
}

export interface LavaScaffoldStandPlan {
  stand: Point;
  floor: Point;
  distance: number;
}

export function findLavaScaffoldStand(
  lava: Point,
  probe: BlockProbe,
  maxDistance: number = 4.5,
): LavaScaffoldStandPlan | null {
  const reach = Number.isFinite(maxDistance) ? Math.max(1, maxDistance) : 4.5;
  const candidates: LavaScaffoldStandPlan[] = [];
  for (let dx = 4; dx >= -4; dx--) {
    for (let dz = 4; dz >= -4; dz--) {
      if (dx === 0 && dz === 0) continue;
      const distance = Math.hypot(dx, 1, dz);
      if (distance > reach || distance < 2) continue;
      const stand: Point = { x: lava.x + dx, y: lava.y + 1, z: lava.z + dz };
      const floor: Point = { x: stand.x, y: lava.y, z: stand.z };
      const head: Point = { x: stand.x, y: stand.y + 1, z: stand.z };
      if (!isAirName(probeName(probe, stand))) continue;
      if (!isAirName(probeName(probe, head))) continue;
      if (!isAirName(probeName(probe, floor))) continue;
      if (!hasAdjacentSupport(probe, floor)) continue;
      candidates.push({ stand, floor, distance });
    }
  }
  candidates.sort((a, b) => Math.abs(a.distance - 2.5) - Math.abs(b.distance - 2.5));
  return candidates.length > 0 ? candidates[0] : null;
}

export function findLavaMineStand(
  lava: Point,
  probe: BlockProbe,
  maxDistance: number = 4.5,
): MineStandPlan | null {
  const reach = Number.isFinite(maxDistance) ? Math.max(1, maxDistance) : 4.5;
  const candidates: MineStandPlan[] = [];
  for (let dx = 4; dx >= -4; dx--) {
    for (let dz = 4; dz >= -4; dz--) {
      if (dx === 0 && dz === 0) continue;
      const distance = Math.hypot(dx, 1, dz);
      if (distance > reach || distance < 2) continue;
      const stand: Point = { x: lava.x + dx, y: lava.y + 1, z: lava.z + dz };
      const floor: Point = { x: stand.x, y: lava.y, z: stand.z };
      const head: Point = { x: stand.x, y: stand.y + 1, z: stand.z };
      if (!isSafeFloorName(probeName(probe, floor))) continue;
      const feetName = probeName(probe, stand);
      const headName = probeName(probe, head);
      const mines: Point[] = [];
      if (!isAirName(feetName) && feetName != null && SAFE_TO_MINE.has(feetName)) mines.push(stand);
      if (!isAirName(headName) && headName != null && SAFE_TO_MINE.has(headName)) mines.push(head);
      if (mines.length === 0) continue;
      candidates.push({ stand, mines, distance });
    }
  }
  candidates.sort((a, b) => Math.abs(a.distance - 2.5) - Math.abs(b.distance - 2.5));
  return candidates.length > 0 ? candidates[0] : null;
}

function findLavaScaffoldHint(lava: Point, probe: BlockProbe): LavaScaffoldStandPlan | null {
  const candidates: LavaScaffoldStandPlan[] = [];
  for (let dx = 4; dx >= -4; dx--) {
    for (let dz = 4; dz >= -4; dz--) {
      if (dx === 0 && dz === 0) continue;
      const distance = Math.hypot(dx, 1, dz);
      if (distance > 4.5 || distance < 2) continue;
      const stand: Point = { x: lava.x + dx, y: lava.y + 1, z: lava.z + dz };
      const floor: Point = { x: stand.x, y: lava.y, z: stand.z };
      const head: Point = { x: stand.x, y: stand.y + 1, z: stand.z };
      if (!isAirName(probeName(probe, stand))) continue;
      if (!isAirName(probeName(probe, head))) continue;
      if (!isAirName(probeName(probe, floor))) continue;
      candidates.push({ stand, floor, distance });
    }
  }
  candidates.sort((a, b) => Math.abs(a.distance - 2.5) - Math.abs(b.distance - 2.5));
  return candidates.length > 0 ? candidates[0] : null;
}

export interface LavaStandRecovery {
  mode: 'existing' | 'scaffold' | 'mine' | 'none';
  stand?: Point;
  floor?: Point;
  mines?: Point[];
  suggestedStand?: Point;
  suggestedFloor?: Point;
  reason: string;
}

export function planLavaStand(lava: Point, probe: BlockProbe): LavaStandRecovery {
  const existing = findLavaStandWithinReach(lava, probe);
  if (existing != null) return { mode: 'existing', stand: existing, reason: '已经有一处高出一格的安全操作位了。' };
  const scaffold = findLavaScaffoldStand(lava, probe);
  if (scaffold != null) {
    return {
      mode: 'scaffold',
      stand: scaffold.stand,
      floor: scaffold.floor,
      reason: '没有现成的操作位，需要先垫一块圆石到 ' + formatPoint(scaffold.floor) + '，然后站到 ' + formatPoint(scaffold.stand) + ' 上。',
    };
  }
  const mine = findLavaMineStand(lava, probe);
  if (mine != null) {
    return {
      mode: 'mine',
      stand: mine.stand,
      mines: mine.mines,
      reason: '没有现成的操作位，需要先挖掉 ' + mine.mines.map(formatPoint).join('、') + '，然后站到 ' + formatPoint(mine.stand) + ' 上。',
    };
  }
  const hint = findLavaScaffoldHint(lava, probe);
  return {
    mode: 'none',
    suggestedStand: hint == null ? undefined : hint.stand,
    suggestedFloor: hint == null ? undefined : hint.floor,
    reason: '岩浆源 ' + formatPoint(lava) + ' 周围 4.5 格以内，没有可以用作高位操作位的地方。',
  };
}

interface LavaRecoveryAttempt {
  target?: SafeLiquidTarget;
  reason: string;
  nextStep: string;
}

export function isStandingSafelyAt(bot: any, target: SafeLiquidTarget): boolean {
  try {
    const pos: any = world.getPosition(bot);
    if (pos == null) return false;
    const dx = pos.x - target.stand.x;
    const dy = pos.y - target.stand.y;
    const dz = pos.z - target.stand.z;
    if (Math.abs(dy) > 0.6 || Math.hypot(dx, dz) > 1.2) return false;
    if (Math.abs(target.stand.y - target.liquid.y - 1) > 0.6) return false;
    const horizontalFromLava = Math.hypot(target.stand.x - target.liquid.x, target.stand.z - target.liquid.z);
    if (horizontalFromLava < 2) return false;
    const feet = blockNameAt(bot, { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
    const head = blockNameAt(bot, { x: Math.floor(pos.x), y: Math.floor(pos.y) + 1, z: Math.floor(pos.z) });
    const floor = blockNameAt(bot, { x: target.stand.x, y: target.stand.y - 1, z: target.stand.z });
    return isAirName(feet) && isAirName(head) && isSafeFloorName(floor);
  } catch {
    return false;
  }
}

async function tryRecoverLavaStand(
  bot: any,
  lava: Point,
  probe: BlockProbe,
): Promise<LavaRecoveryAttempt> {
  const plan = planLavaStand(lava, probe);
  if (plan.mode === 'existing' && plan.stand != null) {
    return {
      target: { liquid: lava, stand: plan.stand, distance: 0 },
      reason: '已经有安全的操作位 ' + formatPoint(plan.stand) + ' 了。',
      nextStep: '直接重试 makeObsidian。',
    };
  }
  if (plan.mode === 'scaffold' && plan.stand != null && plan.floor != null) {
    const counts = inventoryCounts(bot);
    const material = chooseLavaScaffoldMaterial(counts);
    if (material == null) {
      return {
        reason: '岩浆源 ' + formatPoint(lava) + ' 旁边没有现成的操作位，需要先垫一块方块到 ' + formatPoint(plan.floor) + '，再站到 ' + formatPoint(plan.stand) + ' 上，可是背包里没有能用的垫块。',
        nextStep: '先 collectBlocks(type=cobblestone, num=1)（或 cobbled_deepslate/deepslate），再 placeBlock(type=cobblestone, x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')，最后重试 makeObsidian。',
      };
    }
    const placed = await skills.placeBlock(bot, material, plan.floor.x, plan.floor.y, plan.floor.z);
    if (!placed) {
      return {
        reason: '试着在岩浆源 ' + formatPoint(lava) + ' 旁边把 ' + material + ' 垫到 ' + formatPoint(plan.floor) + '，没有成功。',
        nextStep: '先 goToCoordinates' + formatPoint(plan.stand) + ' 附近，再 placeBlock(type=' + material + ', x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')。',
      };
    }
    const after = planLavaStand(lava, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: lava, stand: after.stand, distance: 0 },
        reason: '已经用 ' + material + ' 垫出了岩浆操作位 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '垫块放下以后仍然没有形成安全的岩浆操作位，岩浆源在 ' + formatPoint(lava) + '。',
      nextStep: '先 goToCoordinates' + formatPoint(plan.stand) + ' 检查现场，再 placeBlock 或 mineBlock。',
    };
  }
  if (plan.mode === 'mine' && plan.stand != null && plan.mines != null && plan.mines.length > 0) {
    const mined: Point[] = [];
    for (const target of plan.mines) {
      const block = blockAtPoint(bot, target);
      if (block == null) continue;
      let distance: number;
      try {
        distance = bot.entity.position.distanceTo(block.position);
      } catch {
        distance = Number.POSITIVE_INFINITY;
      }
      if (!Number.isFinite(distance) || distance > 4.5) {
        return {
          reason: '岩浆源 ' + formatPoint(lava) + ' 旁边有遮挡 ' + formatPoint(target) + '，可是我现在够不着它，距离 ' + String(Number.isFinite(distance) ? Math.round(distance * 10) / 10 : '未知') + ' 格。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      const ok = await skills.mineBlockAt(bot, target.x, target.y, target.z);
      if (!ok) {
        return {
          reason: '试着挖掉岩浆源 ' + formatPoint(lava) + ' 旁边的遮挡 ' + formatPoint(target) + '，没有成功。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      mined.push(target);
    }
    const after = planLavaStand(lava, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: lava, stand: after.stand, distance: 0 },
        reason: '已经挖开了遮挡，岩浆操作位在 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '挖掉了 ' + mined.map(formatPoint).join('、') + '，但是仍然没有形成安全的岩浆操作位，岩浆源在 ' + formatPoint(lava) + '。',
      nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后检查现场，再 placeBlock 或 mineBlock。',
    };
  }
  const suggested = plan.suggestedStand ?? plan.suggestedFloor;
  return {
    reason: plan.reason,
    nextStep:
      suggested == null
        ? 'goToCoordinates' + formatPoint(lava) + ' 后用 placeBlock 在岩浆旁垫出高一格站位，再重试 makeObsidian。'
        : '建议操作位 ' + formatPoint(suggested) + '：先 goToCoordinates' + formatPoint(suggested) + '，再用 placeBlock 垫脚或 mineBlock 清位，最后重试 makeObsidian。',
  };
}

export function chooseLavaScaffoldMaterial(
  counts: Record<string, number | undefined> | null | undefined,
): string | null {
  for (const material of ['cobblestone', 'cobbled_deepslate', 'deepslate', 'stone']) {
    const raw = Number(counts?.[material] ?? 0);
    if (Number.isFinite(raw) && Math.floor(raw) >= 1) return material;
  }
  return null;
}

export function isUnderfootOrSupport(target: Point, feet: Point): boolean {
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y);
  const fz = Math.floor(feet.z);
  const tx = Math.floor(target.x);
  const ty = Math.floor(target.y);
  const tz = Math.floor(target.z);
  return (tx === fx && ty === fy && tz === fz) || (tx === fx && ty === fy - 1 && tz === fz);
}

export function nearestLavaDistance(probe: BlockProbe, center: Point, radius: number = 3): number {
  const r = Number.isFinite(radius) ? Math.max(1, Math.floor(radius)) : 3;
  let best = Number.POSITIVE_INFINITY;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        const p = { x: center.x + dx, y: center.y + dy, z: center.z + dz };
        const name = probeName(probe, p);
        if (name !== 'lava' && name !== 'flowing_lava') continue;
        const distance = Math.hypot(dx, dy, dz);
        if (distance < best) best = distance;
      }
    }
  }
  return best;
}

export function isSafeGroundAt(probe: BlockProbe, feet: Point): boolean {
  const floor: Point = { x: feet.x, y: feet.y - 1, z: feet.z };
  const head: Point = { x: feet.x, y: feet.y + 1, z: feet.z };
  if (!isAirName(probeName(probe, feet))) return false;
  if (!isAirName(probeName(probe, head))) return false;
  if (!isSafeFloorName(probeName(probe, floor))) return false;
  return nearestLavaDistance(probe, feet, 3) >= 2;
}

export function findRetreatStand(probe: BlockProbe, origin: Point, radius: number = 4): Point | null {
  const r = Number.isFinite(radius) ? Math.max(1, Math.floor(radius)) : 4;
  const candidates: Array<{ stand: Point; distance: number }> = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (const dy of [0, 1, -1]) {
        if (dx === 0 && dz === 0 && dy === 0) continue;
        const stand: Point = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
        if (!isSafeGroundAt(probe, stand)) continue;
        candidates.push({ stand, distance: Math.hypot(dx, dy, dz) });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.length > 0 ? candidates[0].stand : null;
}

export function isWithinOperationBox(
  point: Point,
  origin: Point,
  maxHorizontal: number = 6,
  maxVertical: number = 2,
): boolean {
  const horizontal = Math.hypot(point.x - origin.x, point.z - origin.z);
  const vertical = Math.abs(point.y - origin.y);
  return horizontal <= maxHorizontal && vertical <= maxVertical;
}

export function selectNearbyLavaCandidates(
  lavas: Point[],
  origin: Point,
  maxHorizontal: number = 6,
  maxVertical: number = 2,
): Point[] {
  return lavas.filter((lava) => isWithinOperationBox(lava, origin, maxHorizontal, maxVertical));
}

