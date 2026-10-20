/**
 * 低血时存粮保护必须让位（Lead 2026-10-21 真机 B）：
 * 血 7、food 13、背包只剩 1 份腐肉，`consume` 回「先留着——你现在不饿」⇒ 6 分钟回不了血。
 * 存粮规则的前提是"不在危险里"；health ≤ 10 时回血优先于留粮。health 正常时规则不变。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('consume：低血紧急放行', () => {
  it('代码里有 health ≤ 10 的例外，且它**先于**存粮条件被计算', () => {
    const code = skills();
    const exception = code.indexOf('const lowHealthEmergency = typeof bot?.health');
    const guard = code.indexOf('if (!lowHealthEmergency && edibleTotal > 0', exception);
    expect(exception).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(exception);
  });

  it('例外只放宽"吃最后一份"，没有删掉存粮规则的其它部分', () => {
    const code = skills();
    expect(code).toContain('edibleTotal <= FOOD_RESERVE_MIN');
    expect(code).toContain('before.food >= FOOD_RESERVE_COMFORT');
    expect(code).toContain('先留着');
  });
});
