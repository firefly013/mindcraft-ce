/**
 * 垂直工具的"完成"必须由**实测高度**门控（Lead 2026-10-21 真机 A）：
 * 进度里 y 一直没变，最后却写「完成 / 上升 10 格」——工具测的是计划，不是事实。
 * 清理回执后：成功只留一行实测升幅；失败只留"没有升上去 + 实测 y"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('stairUp：完成 vs 没有升上去 由实测门控', () => {
  it('有 startY 基线、实测 climbed，成功文案写"上升 N 格"', () => {
    const code = skills();
    expect(code).toContain('const stairStartY = Number(bot?.entity?.position?.y ?? 0);');
    expect(code).toContain('const stairEndY = Number(bot?.entity?.position?.y ?? stairStartY);');
    expect(code).toContain('stairUp 完成了，上升了 ${measuredClimb} 格');
  });
  it('没升上去 ⇒ 明说"没有升上去"+ 实测 y', () => {
    const code = skills();
    expect(code).toContain('stairUp 没有升上去，y 仍然是');
  });
});

describe('pillarUp：同样由实测高度门控', () => {
  it('有 pillarStartY 基线；成功文案写"上升 N 格"', () => {
    const code = skills();
    expect(code).toContain('const pillarStartY = Number(bot?.entity?.position?.y ?? 0);');
    expect(code).toContain('pillarUp 完成了，上升了 ${pillarClimb} 格');
  });
  it('垫了但 y 没升 ⇒ "没有升上去"（不是完成）', () => {
    const code = skills();
    expect(code).toContain('pillarUp 没有升上去：垫了');
  });
  it('旧文案（完成/没有升上去里的建议句、加粗）已不存在', () => {
    const code = skills();
    expect(code).not.toContain('再 pillarUp；窄井里也可以改用 stairUp');
    expect(code).not.toContain('先 mineBlock 头顶那一格');
    expect(code).not.toContain('pillarUp **没有升上去**');
  });
});
