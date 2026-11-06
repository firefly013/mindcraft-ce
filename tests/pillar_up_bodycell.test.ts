/**
 * pillarUp 不能把方块放进自己身体所在格，也不能"挖了还是实心"就原地重挖（Lead 2026-10-21 真机 A：
 * y=-12 垫 5 格去够钻石矿 (39,-7,24)，回执反复只有 dig 行、看起来像往自己脚下放方块，然后循环）。
 * 清理回执后：重叠/仍实心都只报一句事实；成功/失败由实测高度门控。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pillarApexVerdict } from '../src/body/library/skills.js';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('放置目标和身体重叠 ⇒ 一次说清、不重试', () => {
  it('回执点名目标格和身体重叠', () => {
    const verdict = pillarApexVerdict({
      apexReached: true,
      intersectsAtApex: true,
      target: { x: 46, y: -12, z: 24 },
      bodyY: -11.4,
    });
    expect(verdict.canPlace).toBe(false);
    expect(String(verdict.message)).toContain('和身体重叠');
    expect(String(verdict.message)).toContain('46,-12,24');
    expect(String(verdict.message)).not.toContain('完成');
  });
});

describe('"挖了但还是实心"不允许原地循环重挖', () => {
  it('mine 分支挖完会回读方块；仍实心 ⇒ 停止并说明', () => {
    const code = skills();
    expect(code).toContain('const stillThere = verticalName(blockAt(');
    expect(code).toContain('仍然实心');
    // 该检查必须在 `return false;` 之前（否则又会回去重算同一个 mine 目标）
    const idx = code.indexOf('仍然实心');
    expect(code.slice(idx, idx + 300)).toContain('return false;');
  });
  it('柱子上行成功/失败仍由实测高度门控', () => {
    const code = skills();
    expect(code).toContain('pillarUp 完成了，上升了 ${pillarClimb} 格');
    expect(code).toContain('pillarUp 没有升上去：垫了');
  });
});
