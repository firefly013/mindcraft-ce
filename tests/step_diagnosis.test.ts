/**
 * 「为什么走不进去」必须把**工具与方块**连起来说（Lead 2026-10-21，A 两次回执）：
 * 「位置没变」+ 另一行「镐剩 36 次」两条分开摆，模型只能撞墙。
 * 并区分两类失败：有障碍物（挖得动/挖不动）vs **目标格是空的**（瓶颈在天花板/落脚点/身体）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLEAR_DIG_BUDGET_SEC,
  estimateDigSeconds,
  formatNoObstacleDiagnosis,
  planClearStep,
} from '../src/body/safety/step_diagnosis.js';

describe('estimateDigSeconds：工具档位决定量级', () => {
  it('石头(hardness 1.5)：木镐 ~1.1 秒、石镐 ~0.6 秒、铁镐 ~0.4 秒', () => {
    expect(estimateDigSeconds({ hardness: 1.5, toolName: 'wooden_pickaxe' })).toBeCloseTo(1.1);
    expect(estimateDigSeconds({ hardness: 1.5, toolName: 'stone_pickaxe' })).toBeCloseTo(0.6);
    expect(estimateDigSeconds({ hardness: 1.5, toolName: 'iron_pickaxe' })).toBeCloseTo(0.4);
  });
  it('深板岩(hardness 3)：木镐 ~2.3 秒；徒手更久', () => {
    expect(estimateDigSeconds({ hardness: 3, toolName: 'wooden_pickaxe' })).toBeCloseTo(2.3);
    expect(estimateDigSeconds({ hardness: 3, toolName: null })).toBeCloseTo(4.5);
  });
  it('hardness 读不到 ⇒ null（不猜）', () => {
    expect(estimateDigSeconds({ hardness: null, toolName: 'iron_pickaxe' })).toBeNull();
  });
});

describe('planClearStep：预算/耐久要写进回执', () => {
  it('预计超过预算 ⇒ over-budget，且同时出现"这格是什么"和"手里是什么、要几秒"', () => {
    const plan = planClearStep({ blockName: 'obsidian', toolName: 'wooden_pickaxe', toolDurabilityLeft: 50, seconds: 9.5 });
    expect(plan.action).toBe('over-budget');
    expect(String(plan.message)).toContain('obsidian');
    expect(String(plan.message)).toContain('wooden_pickaxe');
    expect(String(plan.message)).toContain('9.5 秒');
    expect(String(plan.message)).toContain('预算');
  });
  it('镐快断（≤10）⇒ tool-nearly-broken，先换镐而不是挖到一半断', () => {
    const plan = planClearStep({ blockName: 'stone', toolName: 'wooden_pickaxe', toolDurabilityLeft: 6, seconds: 1.1 });
    expect(plan.action).toBe('tool-nearly-broken');
    expect(String(plan.message)).toContain('只剩 6 次耐久');
  });
  it('够快、耐久尚可 ⇒ ok', () => {
    expect(planClearStep({ blockName: 'stone', toolName: 'stone_pickaxe', toolDurabilityLeft: 80, seconds: 0.6 }).action).toBe('ok');
  });
  it('预算常量是 4 秒（与 clear 步的时间预算一致）', () => {
    expect(CLEAR_DIG_BUDGET_SEC).toBe(4);
  });
});

describe('formatNoObstacleDiagnosis：目标格是空的时别再说"挖不动"', () => {
  it('点明"目标脚/头那格读起来是空的" + 天花板/悬空事实 + 下一步', () => {
    const text = formatNoObstacleDiagnosis({ target: { x: 14, y: 59, z: -41 }, headSolid: 'stone', floorSolid: 'solid', onGround: true, movedAny: false });
    expect(text).toContain('(14, 59, -41)');
    expect(text).toContain('读起来是空的');
    expect(text).toContain('你头顶那格是 stone');
    expect(text).toContain('位置完全没变');
    expect(text).toContain('mineBlock');
  });
});

describe('接线守卫', () => {
  const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');
  it('cleared 为空时换诊断；挖之前先做工具预算判断', () => {
    const code = skills();
    expect(code).toContain('formatNoObstacleDiagnosis({ target');
    expect(code).toContain('planClearStep({');
    expect(code).toContain("clearPlan.action !== 'ok'");
  });
  it('progression 回执不再出现"。。"（reason 末尾句号不再叠加）', () => {
    const progression = readFileSync(join(process.cwd(), 'src', 'body', 'library', 'progression.ts'), 'utf8');
    expect(progression).toContain("replace(/。+$/, '')");
  });
});
