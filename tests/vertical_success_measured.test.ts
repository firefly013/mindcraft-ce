/**
 * 垂直工具的"完成"必须由**实测高度**门控（Lead 2026-10-21 真机 A）：
 * 进度里 y 一直没变，最后却写「stairUp 完成 / 上升 10 格」——工具测的是计划，不是事实。
 * stairUp 与 pillarUp 都要：实测升幅 > 0.4 才许说完成；否则「没有升上去」+ 实测 y。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('stairUp：完成 vs 没有升上去 由实测门控', () => {
  it('有 startY 基线、实测 climbed、成功文案写"实际上升"', () => {
    const code = skills();
    expect(code).toContain('const stairStartY = Number(bot?.entity?.position?.y ?? 0);');
    expect(code).toContain('const stairEndY = Number(bot?.entity?.position?.y ?? stairStartY);');
    expect(code).toContain("'stairUp 完成：实际上升 '");
  });
  it('没升上去 ⇒ 明说"没有升上去"+ 实测 y，且不许出现"stairUp 完成"', () => {
    const code = skills();
    expect(code).toContain("'stairUp **没有升上去**：y 仍是 '");
    expect(code).toContain("用 mineBlock 挖开那一格，或改用 pillarUp");
  });
});

describe('pillarUp：同样由实测高度门控', () => {
  it('有 pillarStartY 基线；成功文案写"实际上升"', () => {
    const code = skills();
    expect(code).toContain('const pillarStartY = Number(bot?.entity?.position?.y ?? 0);');
    expect(code).toContain("'pillarUp 完成：实际上升 '");
  });
  it('垫了但 y 没升 ⇒ "没有升上去"（不是完成），并给可执行下一步', () => {
    const code = skills();
    expect(code).toContain('pillarUp **没有升上去**：垫了');
    expect(code).toContain('先 mineBlock 头顶那一格');
  });
  it('旧的"完成：上升 done 格"（未实测）已不存在', () => {
    const code = skills();
    expect(code).not.toContain("'stairUp 完成：上升 ' + done");
    expect(code).not.toContain("'pillarUp 完成：上升 ' + done");
  });
});
