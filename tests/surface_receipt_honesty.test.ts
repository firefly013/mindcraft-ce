/**
 * 「保命声称成功、身体还在死」这一类假回执（真机 overnight_b）：
 *
 * > 「surface 反射反复报「已经把头露出水面」，我却一路窒息掉血淹死」
 *
 * 规则：**回执只能报它测到的东西**。`swimToSurface` 的 `'surfaced'` 是实测
 * （`headInWater === false`），可以报"头已露出水面"；但 `'slow'` 的语义是
 * "30 秒上限到了、头**还在水里**"，它**不是**出水面，绝不能配"已露出水面"这句话。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('surface 的回执必须报测量结果，不报意图', () => {
  it("'surfaced' 才是实测成功：它来自 headInWater() === false", () => {
    const src = skills();
    expect(src).toContain("if (!headInWater(bot)) return 'surfaced';");
    expect(src).toContain("if (result === 'surfaced')");
    expect(src).toContain("log(bot, '头已露出水面。');");
  });

  it("'slow' 分支不许说成成功（真机溺水假回执的根源）", () => {
    const src = skills();
    expect(src).not.toContain("if (second === 'slow') return true;");
    expect(src).toContain('头**还在水里**');
    expect(src).toContain('不是出水面');
  });

  it("'slow' 的定义本身写着头还没出水（语义与回执对齐）", () => {
    const src = skills();
    expect(src).toContain("return 'slow'; // 30 秒兜底到了：头还没出水");
  });
});
