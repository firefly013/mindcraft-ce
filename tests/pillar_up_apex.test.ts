/**
 * pillarUp 必须在**跳跃最高点**把方块放到"原站立格"（Lead 2026-10-21 真机：
 * 1×1 竖井里 100% 失败——旧代码等 `y>startY+0.4` 就放，身体 AABB 还在那格里，
 * 安全守卫必然拒绝）。守卫保留；但失败原因要可执行（"跳起来但没升"≠"会窒息"）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pillarApexVerdict } from '../src/body/library/skills.js';

const target = { x: 72, y: 11, z: 106 };

describe('pillarApexVerdict：apex 才算放行', () => {
  it('**跳到最高点、身体已清空该格** ⇒ 允许放置（正常竖井的常规路径）', () => {
    const verdict = pillarApexVerdict({ apexReached: true, intersectsAtApex: false, target, bodyY: 12.2 });
    expect(verdict.canPlace).toBe(true);
    expect(verdict.message).toBeNull();
  });

  it('**跳了但没升** ⇒ 不放，且给可执行原因（mine 头顶一格），不是"会窒息"', () => {
    const verdict = pillarApexVerdict({ apexReached: false, intersectsAtApex: true, target, bodyY: 11.05 });
    expect(verdict.canPlace).toBe(false);
    expect(String(verdict.message)).toContain('跳起来但位置没升');
    expect(String(verdict.message)).toContain('mineBlock 挖开头顶');
    expect(String(verdict.message)).not.toContain('窒息');
  });

  it('守卫保留：apex 到了但放置瞬间仍相交 ⇒ 拒绝，并**同时打印目标格和身体 y**（可诊断）', () => {
    const verdict = pillarApexVerdict({ apexReached: true, intersectsAtApex: true, target, bodyY: 11.4 });
    expect(verdict.canPlace).toBe(false);
    expect(String(verdict.message)).toContain('72,11,106');
    expect(String(verdict.message)).toContain('身体在 y=11.4');
  });
});

describe('接线守卫', () => {
  const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');
  it('先等"身体清空原站立格或跳够高"，再按判据决定放/不放；不再用 y>+0.4 直接放', () => {
    const code = skills();
    expect(code).toContain('const standingCell = { x: startX, y: Math.floor(startY), z: startZ };');
    expect(code).toContain('const apexReached = await waitFor(');
    expect(code).toContain('cellIntersectsBody(bot?.entity?.position, standingCell) === false');
    expect(code).not.toContain('const rose = await waitFor(bot, () => Number(bot?.entity?.position?.y ?? 0) > startY + 0.4');
  });
  it('放置仍在原站立格（不是 floor(y)-1），并且放后仍做身体相交自检', () => {
    const code = skills();
    expect(code).toContain("placeBlock(bot, material, standingCell.x, standingCell.y, standingCell.z, 'bottom', true)");
    expect(code).toContain('const placedCell = standingCell;');
    expect(code).toContain('pillarUp 紧急自救');
  });
});
