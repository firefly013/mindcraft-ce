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
  if (totalBuckets === 0) missing.push('水桶或空桶（至少 1 个）');
  if (diamondPickaxes === 0) missing.push('钻石镐（黑曜石只有钻石镐/下界合金镐能挖）');
  const ok = missing.length === 0;
  return {
    waterBuckets,
    emptyBuckets,
    diamondPickaxes,
    totalBuckets,
    ok,
    missing,
    message:
      '装备检查：水桶 ' + String(waterBuckets) + '、空桶 ' + String(emptyBuckets) +
      '、钻石镐（含下界合金）' + String(diamondPickaxes) + '。' +
      (ok ? '启动条件满足。' : '缺：' + missing.join('、') + '。'),
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
      reason: formatPoint(liquid) + ' 不是' + (expectedName === 'lava' ? '岩浆源' : '水源') + '（读到 ' + String(actual ?? '未知') + '）。',
    };
  }
  const stand = expectedName === 'lava' ? findLavaStandWithinReach(liquid, probe) : findWaterStandWithinReach(liquid, probe);
  if (stand == null) {
    return {
      ok: false,
      reason:
        formatPoint(liquid) + ' 旁边没有高一格的干燥实心岸边：' +
        '需要相邻实心块、站位和头顶都是空气，才能安全倒水/装水。',
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
    return { ok: false, reason: formatPoint(water) + ' 不是水源（读到 ' + String(actual ?? '未知') + '）。' };
  }
  const stand = findWaterStandWithinReach(water, probe);
  if (stand == null) {
    return {
      ok: false,
      reason: formatPoint(water) + ' 4.5 格内没有可直接站立的干燥点；可以尝试用圆石垫一个站位，或挖掉挡视线的方块。',
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
    return '水源 ' + formatPoint(source.liquid) + ' 已经不在了（读到 ' + String(waterBlock?.name ?? '未知') + '）。';
  }
  if (waterBlock.metadata != null && waterBlock.metadata !== 0) {
    return '水源 ' + formatPoint(source.liquid) + ' 是流动水，装不进桶。';
  }
  if (!(await goToStand(bot, source.stand))) {
    return '走到水源岸边 ' + formatPoint(source.stand) + ' 失败。';
  }
  const beforeWater = inventoryCounts(bot)['water_bucket'] ?? 0;
  const filled = await skills.useToolOnBlock(bot, 'bucket', waterBlock);
  if (!filled) {
    return '在 ' + formatPoint(source.liquid) + ' 装水失败（十字准星没对准或岸边够不着）。';
  }
  const ok = await skills.waitFor(bot, () => (inventoryCounts(bot)['water_bucket'] ?? 0) > beforeWater, 2_000);
  if (!ok) {
    return '装水动作成功但背包里没出现 water_bucket，可能同步延迟。';
  }
  return null;
}

const waterBucketCount = (counts: Record<string, number>): number => counts['water_bucket'] ?? 0;
const obsidianCount = (counts: Record<string, number>): number => Math.max(0, Math.floor(counts['obsidian'] ?? 0));

function successReceipt(before: number, produced: number, mined: Point[], kit: ObsidianKitStatus): string {
  return [
    '已获得 ' + String(before + produced) + '/10 黑曜石（原有 ' + String(before) + '，新挖 ' + String(produced) + '）。',
    '装备：水桶 ' + String(kit.waterBuckets) + '、空桶 ' + String(kit.emptyBuckets) + '、钻石镐（含下界合金）' + String(kit.diamondPickaxes) + '。',
    mined.length === 0 ? '没有新挖，原有数量已够。' : '新挖坐标：' + mined.map(formatPoint).join('、') + '。',
  ].join('\n');
}

export function failureReceipt(
  before: number,
  produced: number,
  mined: Point[],
  failures: string[],
  extra: string,
  nextStep?: string,
): string {
  const lines = [
    '没有拿到 10 块黑曜石：当前 ' + String(before + produced) + '/10（原有 ' + String(before) + '，新挖 ' + String(produced) + '）。',
    extra,
  ];
  if (mined.length > 0) lines.push('已挖到的黑曜石坐标：' + mined.map(formatPoint).join('、') + '。');
  if (failures.length > 0) lines.push('失败尝试：\n- ' + failures.slice(0, 8).join('\n- '));
  if (nextStep != null && nextStep !== '') lines.push('下一步：' + nextStep);
  lines.push('现场保留：已生成的 obsidian 没被拆；可以先用 mineBlock/collectBlocks 收走，再补水/换岩浆源重试。');
  return lines.join('\n');
}

async function makeObsidianInner(bot: any): Promise<MakeObsidianResult> {
  try {
    const startCounts = inventoryCounts(bot);
    const before = obsidianCount(startCounts);
    const need = Math.max(0, OBSIDIAN_TARGET - before);
    const kit = assessObsidianKit(startCounts);
    if (need === 0) {
      return { ok: true, produced: 0, message: successReceipt(before, 0, [], kit) };
    }
    if (!kit.ok) {
      return {
        ok: false,
        produced: 0,
        message: failureReceipt(before, 0, [], [], '阶段：检查装备。\n' + kit.message, '先补齐缺件：圆石用 collectBlocks(type=cobblestone, num=1)，水桶/钻石镐按上面缺什么补什么。'),
      };
    }

    const verdict = permits.isAllowed('pour_water', opContextFor(bot), Date.now());
    if (!verdict.allowed) {
      return {
        ok: false,
        produced: 0,
        message: failureReceipt(
          before,
          0,
          [],
          [],
          '阶段：检查点火授权。倒水需要危险操作授权：先调用 allowDangerousOps(ops=pour_water, calls=1)，再调 makeObsidian。',
          'allowDangerousOps(ops=pour_water, calls=1)',
        ),
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
      const nearest = [...allLavaCandidates].sort((a, b) => distanceBetween(a, origin) - distanceBetween(b, origin))[0] as Point;
      const plan = planLavaStand(nearest, probe);
      const suggested = plan.stand ?? plan.floor ?? plan.suggestedStand ?? plan.suggestedFloor;
      const lines = [
        '阶段：选址限制。当前位置水平 6 格、垂直 ±2 格内没有岩浆源；工具不再大范围漫游或向下钻。',
        nearestLavaInfo(allLavaCandidates, origin),
        suggested == null ? '' : '手动建议安全坐标：' + formatPoint(suggested) + '。',
      ].filter((line) => line !== '' );
      const manual = suggested == null
        ? '先 goToCoordinates 到 ' + formatPoint(nearest) + ' 附近干燥处，再用 placeBlock/useOn/searchForBlock/mineBlock 手动走一遍。'
        : '先 goToCoordinates' + formatPoint(suggested) + '，再 placeBlock 垫脚，然后 useOn(water_bucket, lava)，searchForBlock(obsidian, 16)，最后 mineBlock。';
      return {
        ok: false,
        produced: 0,
        message: failureReceipt(before, 0, [], [], lines.join('\n'), manual),
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
        const suggested = plan.stand ?? plan.floor ?? (plan.mines == null ? null : plan.mines[0]) ?? plan.suggestedStand ?? plan.suggestedFloor;
        const lines = [
          '阶段：创造岩浆操作位（岩浆源 ' + formatPoint(first) + '）。',
          plan.reason,
          suggested == null ? '' : '建议坐标：' + formatPoint(suggested) + '。',
          nearestLavaInfo(lavaCandidates, origin),
        ].filter((line) => line !== '');
        return {
          ok: false,
          produced: 0,
          message: failureReceipt(before, 0, [], recoveryReasons, lines.join('\n'), '先按建议坐标处理岩浆操作位（placeBlock 垫脚或 mineBlock 挖遮挡），再重试 makeObsidian。'),
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
            '水桶只够 ' + String(kit.waterBuckets) + ' 次，附近 ' + String(LIQUID_SEARCH_RADIUS) + ' 格内又没找到水源。' + '\n' + nearestLavaInfo(lavaCandidates, origin),
            '先 goToCoordinates 到水边（或带够水桶）再重试 makeObsidian。',
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
          const suggested = plan.stand ?? plan.floor ?? (plan.mines == null ? null : plan.mines[0]);
          const lines = [
            '阶段：准备装水位（水源 ' + formatPoint(first) + '）。',
            plan.reason,
            suggested == null ? '' : '建议坐标：' + formatPoint(suggested) + '。',
            nearestLavaInfo(lavaCandidates, origin),
          ].filter((line) => line !== '');
          return {
            ok: false,
            produced: 0,
            message: failureReceipt(before, 0, [], recoveryReasons, lines.join('\n'), '先按建议坐标处理装水位（placeBlock 垫脚或 mineBlock 挖遮挡），再重试 makeObsidian。'),
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
        failures.push('被 Stop/保命打断：已挖 ' + String(produced) + '/' + String(need) + ' 块，下面返回进度和下一块坐标。');
        break;
      }
      attempts++;
      const counts = inventoryCounts(bot);
      produced = Math.max(produced, Math.max(0, obsidianCount(counts) - before));
      if (produced >= need) break;

      if (waterBucketCount(counts) <= 0) {
        if (waterTargets.length === 0) {
          failures.push('需要重新装水，但附近没有记录到安全水源。');
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
        failures.push('没有更多未利用的安全岩浆源（已尝试 ' + String(usedLava.size) + ' 个）。');
        break;
      }
      usedLava.add(pointKey(target.liquid));

      if (!(await goToStand(bot, target.stand))) {
        failures.push('到不了岩浆岸边 ' + formatPoint(target.stand) + '（目标岩浆 ' + formatPoint(target.liquid) + '）。');
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
        failures.push('寻路越界：目标岩浆 ' + formatPoint(target.liquid) + ' 的安全位在 ' + formatPoint(target.stand) + '，但你被带到 ' + formatPoint(posAfterWalk) + '（超出水平 6/垂直 ±2 限制）。已停手，下一步：goToCoordinates' + formatPoint(target.stand) + ' 后重试 makeObsidian。');
        dangerStop = true;
        break;
      }
      if (!isStandingSafelyAt(bot, target)) {
        failures.push('站位硬校验失败：寻路后没停在安全操作位 ' + formatPoint(target.stand) + '（岩浆 ' + formatPoint(target.liquid) + '）。下一步：goToCoordinates' + formatPoint(target.stand) + ' 后重试 makeObsidian。');
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
        failures.push('拒绝浇筑/挖掘 ' + formatPoint(target.liquid) + '：它在你脚下或承重块下。下一步：换一块岩浆源，或先 placeBlock 垫到安全站位 ' + formatPoint(target.stand) + ' 后重试 makeObsidian。');
        continue;
      }
      const lavaDistanceBeforePour = nearestLavaDistance(probe, feetBeforePour, 3);
      if (lavaDistanceBeforePour < 2) {
        failures.push('拒绝浇筑/挖掘 ' + formatPoint(target.liquid) + '：你离岩浆只有 ' + String(Math.round(lavaDistanceBeforePour * 10) / 10) + ' 格，小于 2。下一步：goToCoordinates' + formatPoint(target.stand) + ' 后重试 makeObsidian。');
        continue;
      }
      lastSafeStand = target.stand;

      const lavaBlock = blockAtPoint(bot, target.liquid);
      if (lavaBlock == null || lavaBlock.name !== 'lava' || (lavaBlock.metadata != null && lavaBlock.metadata !== 0)) {
        failures.push('岩浆源 ' + formatPoint(target.liquid) + ' 已变化（读到 ' + String(lavaBlock?.name ?? '未知') + '），跳过。');
        continue;
      }

      const poured = await skills.useToolOnBlock(bot, 'water_bucket', lavaBlock);
      if (!poured) {
        failures.push('在 ' + formatPoint(target.liquid) + ' 倒水失败（可能准星被挡/岸边够不着）。');
        continue;
      }
      if (!isStandingSafelyAt(bot, target)) {
        failures.push('倒水后站位硬校验失败：偏离安全操作位 ' + formatPoint(target.stand) + '（岩浆 ' + formatPoint(target.liquid) + '）。下一步：先 goToCoordinates' + formatPoint(target.stand) + '，确认脚/头空气、脚下实心，再重试 makeObsidian。');
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
        failures.push('倒水后 10 秒内 searchForBlock(obsidian,16) 没确认目标 ' + formatPoint(target.liquid) + ' 生成（读到 ' + String(blockNameAt(bot, target.liquid) ?? '未知') + '）。' + (nearbyObsidian == null ? '16 格内也没找到 obsidian。' : '附近其他 obsidian：' + formatPoint({ x: Math.floor(nearbyObsidian.position.x), y: Math.floor(nearbyObsidian.position.y), z: Math.floor(nearbyObsidian.position.z) }) + '。') + '已停手，不重复倒水。下一步：goToCoordinates' + formatPoint(target.stand) + ' 后手动 useOn(water_bucket, lava)，再用 searchForBlock(obsidian,16) 和 mineBlock 核对。');
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
        failures.push('拒绝挖掘 ' + formatPoint(target.liquid) + '：黑曜石在脚下或承重块下。下一步：换一块岩浆源，或先 placeBlock 垫到安全站位 ' + formatPoint(target.stand) + ' 后重试 makeObsidian。');
        continue;
      }
      if (!isSafeGroundAt(probe, feetBeforeMine)) {
        const retreat = findRetreatStand(probe, feetBeforeMine, 4);
        if (retreat != null) await goToStand(bot, retreat);
        failures.push('挖前检测到脚下/岩浆危险，已停手' + (retreat == null ? '，但找不到安全撤退点' : '并后撤到 ' + formatPoint(retreat)) + '。下一步：goToCoordinates' + formatPoint(retreat ?? target.stand) + ' 后重试 makeObsidian。');
        dangerStop = true;
        break;
      }
      lastSafeStand = target.stand;

      const beforeMine = obsidianCount(inventoryCounts(bot));
      const equipped = await skills.equip(bot, 'diamond_pickaxe');
      if (!equipped) {
        failures.push('已生成黑曜石 ' + formatPoint(target.liquid) + '，但装备钻石镐失败。');
        continue;
      }
      const minedOk = await skills.mineBlockAt(bot, target.liquid.x, target.liquid.y, target.liquid.z);
      if (!minedOk) {
        failures.push('已生成黑曜石 ' + formatPoint(target.liquid) + '，但挖取失败（可走到旁边再 mineBlock）。');
        continue;
      }
      const picked = await skills.waitFor(bot, () => obsidianCount(inventoryCounts(bot)) > beforeMine, 4_000);
      if (!picked) {
        failures.push('挖掉了 ' + formatPoint(target.liquid) + '，但黑曜石没在 4 秒内进背包（可能在掉落物里，走近可捡）。');
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
        failures.push('挖完 ' + formatPoint(target.liquid) + ' 后检测到脚下/岩浆危险，已立即停手' + (retreat == null ? '，但找不到安全撤退点' : (retreated ? '并后撤到 ' + formatPoint(retreat) : '，后撤到 ' + formatPoint(retreat) + ' 失败')) + '。下一步：goToCoordinates' + formatPoint(retreat ?? target.stand) + ' 后重试 makeObsidian。');
        dangerStop = true;
        break;
      }
      lastSafeStand = target.stand;
    }

    const nextTarget = lavaTargets.find((candidate) => !usedLava.has(pointKey(candidate.liquid))) ?? null;
    const remainingWaterBuckets = inventoryCounts(bot)['water_bucket'] ?? 0;
    if (produced >= need) {
      const message =
        successReceipt(before, produced, mined, kit) +
        (nextTarget == null
          ? '\n不要再走向岩浆边缘；附近没有更多候选岩浆源。'
          : '\n不要再走向岩浆边缘；下一块可挖候选：岩浆 ' + formatPoint(nextTarget.liquid) + '，安全站位 ' + formatPoint(nextTarget.stand) + '。');
      return { ok: true, produced, message, mined, remainingWaterBuckets, nextTarget, dangerStop };
    }
    const nextStep = dangerStop
      ? '已停手/后撤到 ' + (lastSafeStand == null ? '安全干燥点' : formatPoint(lastSafeStand)) + '；先 goToCoordinates 到该安全点，确认离岩浆≥2 再决定是否重试 makeObsidian。'
      : nextTarget == null
        ? '没有更多安全候选；先 goToCoordinates 到干燥安全点，补给后重试 makeObsidian。'
        : '下一块候选：岩浆 ' + formatPoint(nextTarget.liquid) + '，安全站位 ' + formatPoint(nextTarget.stand) + '；先 goToCoordinates' + formatPoint(nextTarget.stand) + ' 再重试 makeObsidian。';
    const progressLine =
      '进度：已生成/已挖 ' + String(produced) + '/' + String(need) + ' 块；剩余水桶 ' + String(remainingWaterBuckets) +
      '；下一块候选：' + (nextTarget == null ? '没有' : ('岩浆 ' + formatPoint(nextTarget.liquid) + '，安全站位 ' + formatPoint(nextTarget.stand)));
    return {
      ok: false,
      produced,
      message: failureReceipt(before, produced, mined, failures, '阶段：浇筑/挖取循环结束，未达到 10 块；下面保留失败坐标和原因。\n' + progressLine, nextStep),
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
      message: 'makeObsidian 异常中止：' + detail + '。已生成的 obsidian 和现场都保留着。',
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

/** 把 makeObsidian 的进度字段渲染成一行可读回执（中断/超时也用）。 */
export function formatMakeObsidianProgress(outcome: MakeObsidianResult | null, headline: string): string {
  if (outcome == null) return headline + '：没有拿到本轮进度。';
  const mined = (outcome.mined ?? []).map(formatPoint).join('、');
  const next =
    outcome.nextTarget == null
      ? '下一块候选：没有'
      : '下一块候选：岩浆 ' + formatPoint(outcome.nextTarget.liquid) + '，安全站位 ' + formatPoint(outcome.nextTarget.stand);
  return (
    headline + '：进度 ' + String(outcome.produced ?? 0) + '/10' +
    (mined === '' ? '' : '；已挖坐标 ' + mined) +
    '；剩余水桶 ' + String(outcome.remainingWaterBuckets ?? 0) +
    '；' + next + '。'
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
      return formatMakeObsidianProgress(finalOutcome, 'makeObsidian 被 Stop/保命打断');
    }
    if (result.timedout) {
      const why = skills.describeStuck?.(agent.bot) ?? '';
      return (
        'makeObsidian：**超时**（' + String(timeoutMinutes) + ' 分钟没做完），已释放身体通道。现场保留。' +
        '\n' + formatMakeObsidianProgress(finalOutcome, '超时进度') +
        (why === '' ? '' : '\n卡住时：' + why)
      );
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
  if (existing != null) return { mode: 'existing', stand: existing, reason: '已有干燥站位。' };
  const scaffold = findScaffoldStand(water, probe);
  if (scaffold != null) {
    return {
      mode: 'scaffold',
      stand: scaffold.stand,
      floor: scaffold.floor,
      reason: '没有现成站位，但可以在 ' + formatPoint(scaffold.floor) + ' 放一块圆石做垫脚。',
    };
  }
  const mine = findMineStand(water, probe);
  if (mine != null) {
    return {
      mode: 'mine',
      stand: mine.stand,
      mines: mine.mines,
      reason: '没有现成站位，但可以挖掉 ' + mine.mines.map(formatPoint).join('、') + ' 后站进去。',
    };
  }
  return { mode: 'none', reason: '水源 ' + formatPoint(water) + ' 周围 4.5 格内没有可站立/可垫/可挖的位置。' };
}

export function nearestLavaInfo(lavas: Point[], origin: Point): string {
  if (lavas.length === 0) return '最近岩浆源：附近未找到。';
  const sorted = [...lavas].sort((a, b) => distanceBetween(a, origin) - distanceBetween(b, origin));
  const nearest = sorted[0] as Point;
  const distance = Math.round(distanceBetween(nearest, origin) * 10) / 10;
  return '最近岩浆源：' + formatPoint(nearest) + '（距离 ' + String(distance) + ' 格）。';
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
      reason: '已有干燥站位。',
      nextStep: '直接重试 makeObsidian。',
    };
  }
  if (plan.mode === 'scaffold' && plan.stand != null && plan.floor != null) {
    const counts = inventoryCounts(bot);
    if ((counts['cobblestone'] ?? 0) <= 0) {
      return {
        reason: '水源 ' + formatPoint(water) + ' 没有现成站位；建议在 ' + formatPoint(plan.floor) + ' 垫一块圆石，但背包里没有 cobblestone。',
        nextStep: '先 collectBlocks(type="cobblestone", num=1)，再 goToCoordinates' + formatPoint(plan.floor) + ' 后 placeBlock(type="cobblestone", x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')，最后重试 makeObsidian。',
      };
    }
    const placed = await skills.placeBlock(bot, 'cobblestone', plan.floor.x, plan.floor.y, plan.floor.z);
    if (!placed) {
      return {
        reason: '尝试在水源 ' + formatPoint(water) + ' 旁垫圆石 ' + formatPoint(plan.floor) + ' 失败。',
        nextStep: '先走到 ' + formatPoint(plan.stand) + ' 附近，再 placeBlock(type="cobblestone", x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')。',
      };
    }
    const after = planWaterStand(water, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: water, stand: after.stand, distance: 0 },
        reason: '已用圆石垫出装水位 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '圆石放下后仍没形成安全装水位（水源 ' + formatPoint(water) + '）。',
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
          reason: '水源 ' + formatPoint(water) + ' 旁有遮挡 ' + formatPoint(target) + '，但你现在够不着（距离 ' + String(Number.isFinite(distance) ? Math.round(distance * 10) / 10 : '未知') + ' 格）。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      const ok = await skills.mineBlockAt(bot, target.x, target.y, target.z);
      if (!ok) {
        return {
          reason: '尝试挖掉水源 ' + formatPoint(water) + ' 旁遮挡 ' + formatPoint(target) + ' 失败。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      mined.push(target);
    }
    const after = planWaterStand(water, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: water, stand: after.stand, distance: 0 },
        reason: '已挖开遮挡，装水位 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '挖掉了 ' + mined.map(formatPoint).join('、') + '，但仍没形成安全装水位（水源 ' + formatPoint(water) + '）。',
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
  if (existing != null) return { mode: 'existing', stand: existing, reason: '已有高一格安全操作位。' };
  const scaffold = findLavaScaffoldStand(lava, probe);
  if (scaffold != null) {
    return {
      mode: 'scaffold',
      stand: scaffold.stand,
      floor: scaffold.floor,
      reason: '没有现成操作位，但可以在 ' + formatPoint(scaffold.floor) + ' 放一块圆石，站到 ' + formatPoint(scaffold.stand) + ' 上倒水。',
    };
  }
  const mine = findLavaMineStand(lava, probe);
  if (mine != null) {
    return {
      mode: 'mine',
      stand: mine.stand,
      mines: mine.mines,
      reason: '没有现成操作位，但可以挖掉 ' + mine.mines.map(formatPoint).join('、') + '，站到 ' + formatPoint(mine.stand) + ' 上倒水。',
    };
  }
  const hint = findLavaScaffoldHint(lava, probe);
  return {
    mode: 'none',
    suggestedStand: hint == null ? undefined : hint.stand,
    suggestedFloor: hint == null ? undefined : hint.floor,
    reason: '岩浆源 ' + formatPoint(lava) + ' 周围 4.5 格内没有可站立/可垫/可挖的高一格操作位。',
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
      reason: '已有安全操作位 ' + formatPoint(plan.stand) + '。',
      nextStep: '直接重试 makeObsidian。',
    };
  }
  if (plan.mode === 'scaffold' && plan.stand != null && plan.floor != null) {
    const counts = inventoryCounts(bot);
    const material = chooseLavaScaffoldMaterial(counts);
    if (material == null) {
      return {
        reason: '岩浆源 ' + formatPoint(lava) + ' 需要先垫操作位：建议在 ' + formatPoint(plan.floor) + ' 放圆石/深板岩，站到 ' + formatPoint(plan.stand) + '，但背包里没有可用垫块。',
        nextStep: '先 collectBlocks(type=cobblestone, num=1)（或 cobbled_deepslate/deepslate），再 placeBlock(type=cobblestone, x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')，最后重试 makeObsidian。',
      };
    }
    const placed = await skills.placeBlock(bot, material, plan.floor.x, plan.floor.y, plan.floor.z);
    if (!placed) {
      return {
        reason: '尝试在岩浆源 ' + formatPoint(lava) + ' 旁垫 ' + material + ' 到 ' + formatPoint(plan.floor) + ' 失败。',
        nextStep: '先 goToCoordinates' + formatPoint(plan.stand) + ' 附近，再 placeBlock(type=' + material + ', x=' + String(plan.floor.x) + ', y=' + String(plan.floor.y) + ', z=' + String(plan.floor.z) + ')。',
      };
    }
    const after = planLavaStand(lava, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: lava, stand: after.stand, distance: 0 },
        reason: '已用 ' + material + ' 垫出岩浆操作位 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '垫块放下后仍没形成岩浆安全操作位（岩浆源 ' + formatPoint(lava) + '）。',
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
          reason: '岩浆源 ' + formatPoint(lava) + ' 旁有遮挡 ' + formatPoint(target) + '，但你现在够不着（距离 ' + String(Number.isFinite(distance) ? Math.round(distance * 10) / 10 : '未知') + ' 格）。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      const ok = await skills.mineBlockAt(bot, target.x, target.y, target.z);
      if (!ok) {
        return {
          reason: '尝试挖掉岩浆源 ' + formatPoint(lava) + ' 旁遮挡 ' + formatPoint(target) + ' 失败。',
          nextStep: 'goToCoordinates' + formatPoint(plan.stand) + ' 后 mineBlock(x=' + String(target.x) + ', y=' + String(target.y) + ', z=' + String(target.z) + ')，再重试 makeObsidian。',
        };
      }
      mined.push(target);
    }
    const after = planLavaStand(lava, probe);
    if (after.mode === 'existing' && after.stand != null) {
      return {
        target: { liquid: lava, stand: after.stand, distance: 0 },
        reason: '已挖开遮挡，岩浆操作位 ' + formatPoint(after.stand) + '。',
        nextStep: '重试 makeObsidian。',
      };
    }
    return {
      reason: '挖掉了 ' + mined.map(formatPoint).join('、') + '，但仍没形成岩浆安全操作位（岩浆源 ' + formatPoint(lava) + '）。',
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
