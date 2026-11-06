/**
 * 回执清理（CLEAN-BRIEF）：垂直/采集动作不再往回执里写"每轮进度播报"。
 * 进度仍记录在 `recordActionProgress`（喂卡死判定），只是不写进模型看到的文本。
 * 纯函数 `formatProgressLine` / `formatTimeoutSummary` 仍被其它工具使用，行为不变。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatProgressLine, formatTimeoutSummary, PROGRESS_INTERVAL_MS } from '../src/body/library/progress.js';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('digDown / mineBlock 不再输出逐格进度播报', () => {
  it('digDown 不写 dig-progress 机器行、不再调用 formatTimeoutSummary', () => {
    const code = skills();
    expect(code).not.toContain('dig-progress{');
    expect(code).not.toContain("formatTimeoutSummary({ label: '向下挖'");
  });

  it('mineBlock 不写 mine-progress 机器行', () => {
    const code = skills();
    expect(code).not.toContain('mine-progress{');
  });

  it('进度仍然记给卡死判定（recordActionProgress 还在）', () => {
    const code = skills();
    expect(code).toContain('recordActionProgress(bot, { label: \'向下挖\'');
    expect(code).toContain('recordActionProgress(bot, { label: \'挖方块\'');
    expect(code).toContain('recordActionProgress(bot, { label: \'挖矿\'');
  });

  it('超时只说事实（已完成 X/Y），不再套用长文案', () => {
    const code = skills();
    expect(code).not.toContain('采集超时：已完成');
    expect(code).toContain('向下挖超时了');
  });

  it('formatTimeoutSummary 纯函数行为不变（其它工具仍在用）', () => {
    const summary = formatTimeoutSummary({ label: '向下挖', done: 3, total: 10, elapsedMs: 150_000, remaining: 7 });
    expect(summary).not.toMatch(/卡住|stuck/i);
    expect(summary).toContain('向下挖这次到了 150 秒的时间上限，已经完成 3 个，一共 10 个，还');
    expect(summary).toContain('还剩 7');
    expect(PROGRESS_INTERVAL_MS).toBeLessThanOrEqual(10_000);
    const line = formatProgressLine({ label: '向下挖', done: 2, total: 10, elapsedMs: 17_000 });
    expect(line).toContain('向下挖已经完成 2 个，一共 10 个，已经用了 17 秒。');
    expect(line).toContain('向下挖已经完成 2 个，一共 10 个，已经用了 17 秒。');
  });
});
