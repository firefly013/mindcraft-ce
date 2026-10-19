/**
 * `goToSurface` 把"人工高楼"当地表 —— 真机 2026-10-19。
 *
 * 现场：overnight_a 在 (-1.5, 62, -9.5) 调 `goToSurface`；20 秒后站在
 * **(-1.5, 320, -9.5)**（overworld 建造上限上的 1×1 柱子），比原地高 258 格。
 * 原因：旧实现取"这一列最上面的非空气方块"当地表 —— 而 y=319 那格是人工方块。
 * 一个承诺"回到地表"的工具，把 bot 送上了天，垫的每一块还都来自它自己的背包。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_VERTICAL_CLIMB_PER_CALL,
  SURFACE_MAX_CLIMB,
  chooseSurfaceCandidate,
} from '../src/body/library/skills.js';

/** 用一张 `y -> name` 表造 blockAt；未列出 = air。 */
const column = (table: Record<number, string>) => (x: number, y: number, z: number) => {
  void x;
  void z;
  return { name: table[y] ?? 'air' };
};

describe('chooseSurfaceCandidate：够得着 + 看着像地面', () => {
  it('y=319 悬空孤块 + y=70 真地形 ⇒ 选 y=70，绝不选 320（真机现场）', () => {
    const choice = chooseSurfaceCandidate(column({ 319: 'dirt', 70: 'stone', 69: 'stone', 68: 'stone' }), {
      x: -1.5,
      y: 62,
      z: -9.5,
    });
    expect(choice.chosen).not.toBeNull();
    expect(choice.chosen?.standY).toBe(71);
    expect(choice.chosen?.name).toBe('stone');
    expect(choice.chosen?.standY).toBeLessThan(100);
    // 高那块必须被**解释**，不能默默跳过
    expect(choice.rejected[0]?.y).toBe(320);
    expect(choice.rejected[0]?.why).toContain('超过上限');
    expect(choice.reason).toContain('地表在 y=71');
  });

  it('bot 在 y=62、地形在 y=70 ⇒ 行为和以前一样（+8 格）', () => {
    const choice = chooseSurfaceCandidate(column({ 70: 'grass_block', 69: 'dirt', 68: 'stone' }), {
      x: 0,
      y: 62,
      z: 0,
    });
    expect(choice.chosen?.standY).toBe(71);
    expect(choice.reason).toContain('+9'); // 71 - 62
  });

  it('候选在 100 格高、且下面有实心柱 ⇒ 仍然被上限挡住，继续往下找', () => {
    const table: Record<number, string> = {};
    for (let y = 62; y <= 63; y++) table[y] = 'stone'; // 真正的地面
    for (let y = 100; y <= 162; y++) table[y] = 'stone'; // 100 格高的人工塔（有支撑）
    const choice = chooseSurfaceCandidate(column(table), { x: 0, y: 62, z: 0 });
    expect(choice.chosen?.standY).toBe(64);
    expect(choice.rejected.some((r) => r.why.includes('超过上限'))).toBe(true);
  });

  it('上方的方块**有支撑**但太高 ⇒ 依然不当成地表（上限优先于支撑）', () => {
    const table: Record<number, string> = { 62: 'stone', 63: 'stone', 318: 'stone', 319: 'stone' };
    const choice = chooseSurfaceCandidate(column(table), { x: 0, y: 62, z: 0 });
    expect(choice.chosen?.standY).toBe(64);
    expect(choice.chosen?.standY).toBeLessThan(SURFACE_MAX_CLIMB + 63);
  });

  it('悬空孤块即使够得着也不算地表（列进 rejected）', () => {
    const choice = chooseSurfaceCandidate(column({ 80: 'oak_planks', 63: 'stone', 62: 'stone' }), { x: 0, y: 62, z: 0 });
    expect(choice.chosen?.standY).toBe(64);
    expect(choice.chosen?.name).toBe('stone');
    expect(choice.rejected.some((r) => r.why.includes('悬空'))).toBe(true);
  });

  it('上限内没有任何合格候选 ⇒ chosen=null + 如实说明（不做攀爬）', () => {
    const choice = chooseSurfaceCandidate(column({ 319: 'dirt' }), { x: 0, y: 62, z: 0 });
    expect(choice.chosen).toBeNull();
    expect(choice.reason).toContain('认不出地表');
    expect(choice.reason).toContain('超过上限');
  });

  it('整列读不到方块 ⇒ chosen=null + "区块可能没加载"', () => {
    const choice = chooseSurfaceCandidate(column({}), { x: 0, y: 62, z: 0 });
    expect(choice.chosen).toBeNull();
    expect(choice.reason).toContain('区块可能没加载');
  });

  it('**不变量**：任何被选中的目标都不会超过上限高度', () => {
    for (const topY of [63, 64, 70, 126, 200, 320]) {
      const table: Record<number, string> = { 63: 'stone', 62: 'stone' };
      table[topY] = 'dirt';
      const choice = chooseSurfaceCandidate(column(table), { x: 0, y: 62, z: 0 });
      if (choice.chosen != null) {
        expect(choice.chosen.standY - 62).toBeLessThanOrEqual(SURFACE_MAX_CLIMB);
      }
    }
  });

  it('单次垂直攀爬上限定在 64（258 格那种请求不再可能）', () => {
    expect(MAX_VERTICAL_CLIMB_PER_CALL).toBe(64);
    expect(SURFACE_MAX_CLIMB).toBe(64);
  });
});
