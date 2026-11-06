/**
 * 卡死判定必须看进度（Lead 2026-10-21 真机 A）：垂直下挖每格只降亚方块高度，
 * 旧判据把"位置几乎不变"当卡死 ⇒ 67/81/118 秒三次误报、中止合法下挖。
 * 规则：done 变了 / y 变动 ≥0.1 / 坐标变了 ⇒ 都不报卡死；全都没有才是真停。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateStuck, recordActionProgress } from '../src/body/library/progress.js';

const progress = { label: '向下挖', done: 3, total: 32, fromY: 43, toY: 43.5, at: 1 };

describe('亚方块下降不是卡死', () => {
  it('60 秒里下降 0.6 格、done 也在涨 ⇒ 不报卡死（action 继续），说"在下降但慢"', () => {
    const verdict = evaluateStuck({
      actionRunning: true,
      positionChanged: false,
      yChanged: -0.6,
      progressAdvanced: true,
      seconds: 60,
      progress,
    });
    expect(verdict.kind).not.toBe('stuck');
    expect(verdict.kind).toBe('none');
  });
  it('只有亚方块下降（done 未变）⇒ moving-slow，含实测格数', () => {
    const verdict = evaluateStuck({
      actionRunning: true,
      positionChanged: false,
      yChanged: -0.6,
      progressAdvanced: false,
      seconds: 30,
      progress,
    });
    expect(verdict.kind).toBe('moving-slow');
    expect(verdict.message).toContain('下降了 0.6 格');
  });
});

describe('真停：三个信号都没有才报卡死', () => {
  it('位置/高度/进度都没变 67 秒 ⇒ stuck，报进度未变与坐标未动', () => {
    const verdict = evaluateStuck({
      actionRunning: true,
      positionChanged: false,
      yChanged: 0,
      progressAdvanced: false,
      seconds: 67,
      progress,
    });
    expect(verdict.kind).toBe('stuck');
    expect(verdict.message).toContain('过去 67 秒里，一格都没挖掉，一步也没走，向下挖的进度停在 3 个，一共');
    expect(verdict.message).toContain('过去 67 秒里，一格都没挖掉，一步也没走，向下挖的进度停在 3 个，一共');
    expect(verdict.message).not.toContain('卡住');
  });
  it('进度在涨但坐标不动（原地重挖同一格）⇒ 不报卡死', () => {
    expect(
      evaluateStuck({ actionRunning: true, positionChanged: false, yChanged: 0, progressAdvanced: true, seconds: 90, progress }).kind,
    ).toBe('none');
  });
  it('站着干活（无动作）⇒ 不报卡死', () => {
    expect(
      evaluateStuck({ actionRunning: false, positionChanged: false, yChanged: 0, progressAdvanced: false, seconds: 300, progress }).kind,
    ).toBe('none');
  });
});

describe('接线守卫：身体用进度判据 + skills 在 emit 时记录进度', () => {
  const read = (relative: string): string => readFileSync(join(process.cwd(), 'src', 'body', relative), 'utf8');
  it('pollEdges 用 evaluateStuck，并读 __actionProgress', () => {
    const code = read('mineflayer_body.ts');
    expect(code).toContain('evaluateStuck({');
    expect(code).toContain('__actionProgress');
    expect(code).toContain("'task.progress'");
  });
  it('digDown 的进度行同时写 recordActionProgress（同一证据源）', () => {
    const code = read('library/skills.ts');
    expect(code).toContain("recordActionProgress(bot, { label: '向下挖'");
    expect(code).toContain("recordActionProgress(bot, { label: '挖矿'");
  });
  it('recordActionProgress 写进 bot.__actionProgress，带时间戳', () => {
    const bot: any = {};
    recordActionProgress(bot, { label: '向下挖', done: 2, total: 10, fromY: 40, toY: 41 });
    expect(bot.__actionProgress.done).toBe(2);
    expect(typeof bot.__actionProgress.at).toBe('number');
  });
});
