/**
 * 存粮规则的契约（用户 2026-10-24 定的原则）：**只警告，不拒绝**。
 *
 * 历史：2026-10-18 晚两个 bot 把 1000 格内能吃的东西全吃光，之后 food 2 / 血 1.68。
 * 2026-10-21 又发现低血时"先留着"反而害人（血 7、food 13、只剩 1 份腐肉，
 * 6 分钟回不了血），于是打了 `lowHealthEmergency` 补丁。
 * **打补丁正是"工具在猜"的症状**：工具在猜模型"现在危不危险、该不该动存粮"。
 * 2026-10-24 把整条拒绝删掉——模型说了吃就吃，风险只在回执里说清。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('consume：存粮规则只警告、不拒绝', () => {
  it('不再有"拒绝吃"的分支（也没有 lowHealthEmergency 补丁）', () => {
    const code = skills();
    expect(code).not.toMatch(/const lowHealthEmergency/);
    // 存粮块里不许再出现 return false
    const start = code.indexOf('const edibleTotal = edibles.reduce');
    const block = code.slice(start, code.indexOf('const failures: string[] = [];', start));
    expect(block).not.toContain('return false');
  });

  it('警告仍然在，而且会被带进回执（吃成功了也要看见）', () => {
    const code = skills();
    expect(code).toContain('edibleTotal <= FOOD_RESERVE_MIN');
    expect(code).toContain('before.food >= FOOD_RESERVE_COMFORT');
    expect(code).toContain('背包里只剩 ${edibleTotal} 份能吃的');
    // 关键：吃完那一下也要把警告打出来，否则模型只看到"吃成了"
    expect(code).toContain("if (reserveWarning !== '') log(bot, reserveWarning);");
  });
});
