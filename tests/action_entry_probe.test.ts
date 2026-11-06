/**
 * 回执清理（CLEAN-BRIEF）：入口探针 / 机器格式进度行不再写进模型回执。
 *
 * 早期用 `mine-block-entry{…}` / `dig-down-entry{…}` 定位"工具到底有没有进来"；
 * 现在回执只留事实，这些机器行已从 skills.ts 删除。这个文件改为钉住"不再出现"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('机器格式行已从回执中移除', () => {
  it('mineBlockAt 不写 mine-block-entry{', () => {
    expect(skills()).not.toContain('mine-block-entry{');
  });

  it('digDown 不写 dig-down-entry{', () => {
    expect(skills()).not.toContain('dig-down-entry{');
  });

  it('不再写 mine-progress / dig-progress / collect-progress 机器行', () => {
    const code = skills();
    expect(code).not.toContain('mine-progress{');
    expect(code).not.toContain('dig-progress{');
    expect(code).not.toContain('collect-progress{');
  });

  it('入口的早退仍然写一句事实（空气/读不到方块）', () => {
    const code = skills();
    expect(code).toContain('是空气。');
    expect(code).toContain('读不到方块。');
  });
});
