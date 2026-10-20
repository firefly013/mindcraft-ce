/**
 * 入口探针（Lead 2026-10-21）：`eb29ade` 之后 `mine-progress`/`dig-progress` 全仓为 0。
 * 先把问题变成可测的两问：①工具到底有没有进来（entry 行）②27 秒是"工具在跑"还是
 * "模型两轮之间的间隔"（entry 每调用一行、dig/progress 只在真正进入挖掘时出现）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('入口探针无条件写', () => {
  it('mineBlockAt 在**任何 early-return 之前**写 mine-block-entry{x,y,z}', () => {
    const code = skills();
    const entry = code.indexOf("mine-block-entry{");
    const firstReturn = code.indexOf('return false;', code.indexOf('export async function mineBlockAt'));
    expect(entry).toBeGreaterThan(-1);
    expect(entry).toBeLessThan(firstReturn);
  });

  it('digDown 入口写 dig-down-entry{distance}', () => {
    expect(skills()).toContain("dig-down-entry{");
  });

  it('真正的挖掘进度行仍然存在（只是没被调用到）', () => {
    const code = skills();
    expect(code).toContain('mine-progress{');
    expect(code).toContain('dig-progress{');
  });
});
