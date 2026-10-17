/*
 * 逃跑落点安全判据：避开 lava/水/落差，优先有实心支撑的方向。
 *
 * Feedback #60：疣猪把 bot 打到 3.6 血后 moveAway(30) 逃进岩浆死亡。
 * 原来的 GoalInvert(GoalNear) 只管远离当前位置，完全没看路上有没有岩浆。
 * 这里只做纯决策，方便单测；执行由 skills / 保命反射负责。
 */

export type FleeBlock = { name?: unknown } | null;
export type FleeBlockAt = (x: number, y: number, z: number) => FleeBlock;

export interface FleeSpot {
  x: number;
  y: number;
  z: number;
}

export interface FleeAssessment {
  ok: boolean;
  reason: string;
}

export interface SafeFleeTarget {
  ok: true;
  target: FleeSpot;
  reason: string;
}

export interface NoSafeFleeTarget {
  ok: false;
  reason: string;
}

export type FleeTargetResult = SafeFleeTarget | NoSafeFleeTarget;

const HAZARD_NAMES = new Set([
  'lava', 'flowing_lava', 'water', 'flowing_water',
  'fire', 'soul_fire', 'magma_block', 'cactus', 'powder_snow',
]);
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

function nameOf(block: FleeBlock): string {
  return typeof block?.name === 'string' ? block.name : '';
}

export function isHazardName(name: string): boolean {
  return HAZARD_NAMES.has(name);
}

function isAirName(name: string): boolean {
  return AIR_NAMES.has(name);
}

function isSolidSupportName(name: string): boolean {
  return name !== '' && !isAirName(name) && !isHazardName(name);
}

/** 目标格能否安全站立：脚/头空气、脚下实心支撑，且没有 lava/水/岩浆块。 */
export function assessStandingSpot(blockAt: FleeBlockAt, x: number, y: number, z: number): FleeAssessment {
  const feet = nameOf(blockAt(x, y, z));
  const head = nameOf(blockAt(x, y + 1, z));
  const support = nameOf(blockAt(x, y - 1, z));
  if (isHazardName(feet)) return { ok: false, reason: '脚下方块是 ' + feet };
  if (isHazardName(head)) return { ok: false, reason: '头所在是 ' + head };
  if (!isSolidSupportName(support)) return { ok: false, reason: '脚下没有实心支撑（读到 ' + (support || '空/读不到') + '）' };
  if (feet !== '' && !isAirName(feet)) return { ok: false, reason: '脚所在不是空气（' + feet + '）' };
  if (head !== '' && !isAirName(head)) return { ok: false, reason: '头所在不是空气（' + head + '）' };
  return { ok: true, reason: 'ok' };
}

/**
 * 选一个安全逃跑落点。
 *
 * awayFrom 给威胁坐标时，优先选远离它的方向；没给就按八个方向扫。
 * 每个方向尝试多个距离/高度，返回评分最高的安全落点。
 */
export function chooseSafeFleeTarget(
  blockAt: FleeBlockAt,
  from: FleeSpot,
  awayFrom: FleeSpot | null,
  distance: number,
): FleeTargetResult {
  const baseAngle =
    awayFrom == null
      ? 0
      : Math.atan2(from.z - awayFrom.z, from.x - awayFrom.x);
  const angleOffsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, (-3 * Math.PI) / 4, Math.PI];
  const distances = [distance, Math.max(1, distance * 0.6), Math.max(1, distance * 0.35)];
  const yOffsets = [0, 1, -1, -2, 2];
  let bestResult: { target: FleeSpot; score: number; reason: string } | null = null;
  for (const offset of angleOffsets) {
    const angle = baseAngle + offset;
    for (const d of distances) {
      const tx = Math.floor(from.x + Math.cos(angle) * d);
      const tz = Math.floor(from.z + Math.sin(angle) * d);
      for (const dy of yOffsets) {
        const ty = Math.floor(from.y) + dy;
        const assessment = assessStandingSpot(blockAt, tx, ty, tz);
        if (!assessment.ok) continue;
        const threatDistance =
          awayFrom == null ? 0 : Math.hypot(tx - awayFrom.x, tz - awayFrom.z);
        const score = threatDistance * 10 - Math.abs(offset) - Math.abs(dy) * 0.5;
        if (bestResult == null || score > bestResult.score) {
          bestResult = {
            target: { x: tx, y: ty, z: tz },
            score,
            reason: 'off ' + String(Math.round((offset * 180) / Math.PI)) + '°, ' + String(Math.round(d)) + ' 格',
          };
        }
      }
    }
  }
  if (bestResult == null) {
    return { ok: false, reason: '附近没有同时满足脚/头空气 + 脚下实心 + 不碰 lava/水 的落点' };
  }
  return { ok: true, target: bestResult.target, reason: bestResult.reason };
}

export default { assessStandingSpot, chooseSafeFleeTarget, isHazardName };
