/**
 * 垂直动作也必须"边做边说"（Lead 2026-10-21 真机：digDown 88 秒、y 没动、日志无信息）。
 * 复用 progress.ts 的**同一格式**：模型只该学一种进度格式。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatProgressLine, formatTimeoutSummary, PROGRESS_INTERVAL_MS } from '../src/body/library/progress.js';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('digDown / mineBlock 接上统一进度', () => {
  it('digDown：每轮 emit dig-progress{fromY,toY,done,total,elapsedMs} + 硬上限', () => {
    const code = skills();
    expect(code).toContain('dig-progress{');
    expect(code).toContain('fromY: Math.round(digStartY * 10) / 10');
    expect(code).toContain('toY: Math.round(nowY * 10) / 10');
    expect(code).toContain('const digStartedAt = Date.now();');
    expect(code).toContain('formatTimeoutSummary({ label: \'向下挖\'');
  });

  it('mineBlock：emit mine-progress{block,x,y,z,elapsedMs} + 硬上限', () => {
    const code = skills();
    expect(code).toContain('mine-progress{');
    expect(code).toContain('block: target.name');
    expect(code).toContain('formatTimeoutSummary({ label: \'挖方块\'');
  });

  it('两个动作都用同一个 helper（不是四套文案）', () => {
    const code = skills();
    const progressUses = code.split('formatProgressLine(').length - 1;
    expect(progressUses).toBeGreaterThanOrEqual(3); // collectBlock + digDown + mineBlock
    expect(code).toContain('shouldEmitProgress(digLastProgressAt');
    expect(code).toContain('shouldEmitProgress(mineLastProgressAt');
  });

  it('文案里不出现 卡住/stuck（到上限说的是"到时间上限"）', () => {
    const summary = formatTimeoutSummary({ label: '向下挖', done: 3, total: 10, elapsedMs: 150_000, remaining: 7 });
    expect(summary).not.toMatch(/卡住|stuck/i);
    expect(summary).toContain('已完成 3/10');
    expect(summary).toContain('还剩 7');
    expect(PROGRESS_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });

  it('进度行内容有界：第 N/M、已用 T 秒（digDown 的 fromY→toY 在机器行里）', () => {
    const line = formatProgressLine({ label: '向下挖', done: 2, total: 10, elapsedMs: 17_000 });
    expect(line).toContain('向下挖第 2/10 个');
    expect(line).toContain('已用 17 秒');
  });
});
