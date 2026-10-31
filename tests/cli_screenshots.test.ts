/**
 * CLI 截图的落盘契约。
 *
 * 这里钉的是两件**生命周期完全不同**的事：
 *  - stats 每次调用**新增**一张（多张累积，能跟上次比）；
 *  - 实时画面每次调用**覆盖**同一张（稳定入口）。
 *
 * 路径/覆盖语义写错时不会报错，只会悄悄变成另一种文件布局——等发现时
 * 临时目录里已经是一堆没人认领的图。所以把它单独拉出来测。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cliScreenshotDir,
  liveScreenshotPath,
  safeAgentFileName,
  saveScreenshot,
  statsScreenshotPath,
} from '../src/brain/cli_screenshots.js';
import { Agent } from '../src/brain/agent.js';
import type { Body } from '../src/shared/body.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-shot-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('临时目录与文件名', () => {
  it('默认目录是系统临时目录下的 mindcraft-cli', () => {
    expect(cliScreenshotDir()).toBe(join(tmpdir(), 'mindcraft-cli'));
  });

  it('agent 名只留安全字符；空名回退 agent', () => {
    expect(safeAgentFileName('pia')).toBe('pia');
    expect(safeAgentFileName('a/b c')).toBe('a_b_c');
    expect(safeAgentFileName('   ')).toBe('agent');
  });

  it('实时画面固定一个名字；stats 每次不同（同一毫秒也不撞）', () => {
    const dir = tempDir();
    expect(liveScreenshotPath('pia', dir)).toBe(join(dir, 'pia-live.jpg'));
    expect(liveScreenshotPath('pia', dir)).toBe(liveScreenshotPath('pia', dir));

    const first = statsScreenshotPath('pia', dir, 1000);
    const second = statsScreenshotPath('pia', dir, 1000);
    expect(first).not.toBe(second);
    expect(first).toContain('pia-stats-1000-');
    expect(first.endsWith('.jpg')).toBe(true);
  });
});

describe('saveScreenshot', () => {
  it('自动建目录，字节原样落盘', () => {
    const dir = join(tempDir(), 'nested', 'cli');
    const file = join(dir, 'x.jpg');
    saveScreenshot(file, Buffer.from('hello-jpeg').toString('base64'));
    expect(readFileSync(file).toString()).toBe('hello-jpeg');
  });

  it('同一路径重复写 = 覆盖（实时画面的语义），且不留临时文件', () => {
    const dir = tempDir();
    const file = liveScreenshotPath('pia', dir);
    saveScreenshot(file, Buffer.from('first').toString('base64'));
    saveScreenshot(file, Buffer.from('second').toString('base64'));
    expect(readFileSync(file).toString()).toBe('second');
    expect(readdirSync(dir).filter((name) => !name.endsWith('.jpg'))).toEqual([]);
  });

  it('stats 的两条路径互不影响（多张累积）', () => {
    const dir = tempDir();
    const first = statsScreenshotPath('pia', dir, 1000);
    const second = statsScreenshotPath('pia', dir, 1000);
    saveScreenshot(first, Buffer.from('one').toString('base64'));
    saveScreenshot(second, Buffer.from('two').toString('base64'));
    expect(readFileSync(first).toString()).toBe('one');
    expect(readFileSync(second).toString()).toBe('two');
  });
});

/** 假身体：只有 `image()`，验证的是 Agent 的落盘行为，不是相机。 */
function fakeAgent(image: () => Promise<string | null>): Agent {
  const agent = new Agent();
  agent.name = 'pia';
  agent.body = { image } as unknown as Body;
  return agent;
}

interface StatsShot {
  b64: string;
  file: string | null;
  saveError: string | null;
}

/** `captureStatsScreenshot` 是私有的（模型工具装配用），测试按运行时形状取。 */
function captureStats(agent: Agent, dir: string): Promise<StatsShot | null> {
  return (agent as unknown as { captureStatsScreenshot(dirArg?: string): Promise<StatsShot | null> }).captureStatsScreenshot(dir);
}

describe('Agent：两类截图落在哪、覆盖不覆盖', () => {
  it('saveLiveScreenshot 每次覆盖同一个文件', async () => {
    const dir = tempDir();
    let frame = 0;
    const agent = fakeAgent(() => Promise.resolve(Buffer.from(`frame-${++frame}`).toString('base64')));
    const first = await agent.saveLiveScreenshot(dir);
    const second = await agent.saveLiveScreenshot(dir);
    expect(first).toBe(join(dir, 'pia-live.jpg'));
    expect(second).toBe(first);
    expect(readFileSync(first as string).toString()).toBe('frame-2');
  });

  it('拍不到时返回 null；写不进去也只返回 null（不让 CLI 命令失败）', async () => {
    const noCamera = fakeAgent(() => Promise.resolve(null));
    expect(await noCamera.saveLiveScreenshot(tempDir())).toBeNull();

    // 把"目录"位置占成文件：建目录必然失败。
    const blocked = join(tempDir(), 'blocked');
    writeFileSync(blocked, '');
    const withCamera = fakeAgent(() => Promise.resolve(Buffer.from('x').toString('base64')));
    expect(await withCamera.saveLiveScreenshot(blocked)).toBeNull();
  });

  it('stats 每次新增一张，同时把 base64 交给模型', async () => {
    const dir = tempDir();
    const agent = fakeAgent(() => Promise.resolve(Buffer.from('snapshot').toString('base64')));
    const first = await captureStats(agent, dir);
    const second = await captureStats(agent, dir);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.file).not.toBe(second?.file);
    expect(first?.b64).toBe(Buffer.from('snapshot').toString('base64'));
    expect(readFileSync(first?.file as string).toString()).toBe('snapshot');
    expect(readFileSync(second?.file as string).toString()).toBe('snapshot');
    expect(readdirSync(dir).filter((name) => name.endsWith('.jpg'))).toHaveLength(2);
  });

  it('stats 写不进去时仍把图交给模型（留档失败不毁回执）', async () => {
    const blocked = join(tempDir(), 'blocked');
    writeFileSync(blocked, '');
    const agent = fakeAgent(() => Promise.resolve(Buffer.from('kept').toString('base64')));
    const shot = await captureStats(agent, blocked);
    expect(shot?.file).toBeNull();
    expect(shot?.b64).toBe(Buffer.from('kept').toString('base64'));
    expect(shot?.saveError).not.toBeNull();
  });
});

/** `attachScreenshotFile` 是 CLI 回执用的私有方法，按运行时形状取。 */
function attachStatsReceipt(agent: Agent, text: string, dir: string): Promise<string> {
  return (
    agent as unknown as {
      attachScreenshotFile(body: string, dirArg?: string): Promise<string>;
    }
  ).attachScreenshotFile(text, dir);
}

describe('CLI 的 stats 回执', () => {
  it('每次指向一张新图，路径真实存在', async () => {
    const dir = tempDir();
    const agent = fakeAgent(() => Promise.resolve(Buffer.from('cli-shot').toString('base64')));
    const first = await attachStatsReceipt(agent, 'SNAPSHOT', dir);
    const second = await attachStatsReceipt(agent, 'SNAPSHOT', dir);
    expect(first).toContain('SNAPSHOT');
    expect(first).toContain('\n\n画面：');

    const pathOf = (text: string): string => text.slice(text.indexOf('画面：') + '画面：'.length).trim();
    const firstPath = pathOf(first);
    const secondPath = pathOf(second);
    expect(firstPath).not.toBe(secondPath);
    expect(readFileSync(firstPath).toString()).toBe('cli-shot');
    expect(readFileSync(secondPath).toString()).toBe('cli-shot');
  });

  it('拍不到时说的是"没拍到"，不编一个不存在的路径', async () => {
    const agent = fakeAgent(() => Promise.resolve(null));
    const text = await attachStatsReceipt(agent, 'SNAPSHOT', tempDir());
    expect(text).toContain('没拍到画面');
    expect(text).not.toContain('\n\n画面：');
  });
});
