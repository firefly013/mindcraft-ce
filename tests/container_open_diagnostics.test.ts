/**
 * 容器通道诊断 —— 真机 2026-10-19（overnight_a 的对照实验）：
 * `crafting_table` 的 useBlock 完全正常，而 **chest / furnace 100% windowOpen 超时**，
 * 换方块/换位置/纯打开/取出/存入/重启全试过。它自己定位到"带槽位容器方块的
 * OpenScreen 包"这条路径，并抱怨回执**重复给同一套无效建议**（18 次）。
 *
 * 这里钉住的是可测的那部分契约：开之前松开 sneak、诊断说清"有没有窗口包到达"、
 * 连续失败后回执**换形状**（不再劝它重发同一个调用）、成功路径/延迟到达都要成功。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTAINER_OPEN_RETRIES,
  CONTAINER_OPEN_TIMEOUT_MS,
  openBlockUi,
  resetContainerOpenFailures,
} from '../src/body/library/skills.js';

const chest = { name: 'chest', position: { x: 9, y: 62, z: 0 } };

function fakeBot(overrides: Record<string, unknown> = {}): any {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    output: '',
    currentWindow: null,
    setControlState: vi.fn(),
    deactivateItem: vi.fn(),
    on: (event: string, cb: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    },
    removeListener: vi.fn(),
    closeWindow: vi.fn(),
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
    openContainer: vi.fn(() => new Promise(() => {})), // 永远不返回：模拟服务端不回窗口包
    ...overrides,
  };
}

beforeEach(() => {
  resetContainerOpenFailures();
});

describe('开容器前的现场清理（sneak 卡住会只打断容器这条路）', () => {
  it('开之前松开 sneak 并收起手上的东西（潜行+用方块 = 放置，不是打开）', async () => {
    const bot = fakeBot({ openContainer: async () => ({ kind: 'container' }) });
    await openBlockUi(bot, chest);
    expect(bot.setControlState).toHaveBeenCalledWith('sneak', false);
    expect(bot.deactivateItem).toHaveBeenCalled();
  });

  it('控制键 API 不存在也不许崩（老 fixture / 精简 bot）', async () => {
    const bot: any = { output: '', currentWindow: null, openContainer: async () => ({ kind: 'container' }) };
    await expect(openBlockUi(bot, chest)).resolves.toMatchObject({ kind: 'container' });
  });
});

describe('失败诊断：说清"锅在谁身上"，并且不再重复无效建议', () => {
  it('一个窗口包都没到达 ⇒ 明确说这是路径问题（不是站位问题），并带上坐标', async () => {
    const bot = fakeBot();
    const err = await openBlockUi(bot, chest, { timeoutMs: 100 }).catch((e: Error) => e.message);
    expect(String(err)).toContain('一个窗口包都没发');
    expect(String(err)).toContain('不是站位或角度问题');
    expect(String(err)).toContain('(9,62,0)');
    expect(String(err)).toContain('没有界面开着');
    expect(String(err)).toContain('换**另一个**容器');
  });

  it('连续第二次失败 ⇒ 回执**换形状**：别再重发同一个调用，改走非容器路径', async () => {
    const bot = fakeBot();
    await openBlockUi(bot, chest, { timeoutMs: 100 }).catch(() => undefined);
    const second = await openBlockUi(bot, chest, { timeoutMs: 100 }).catch((e: Error) => e.message);
    expect(String(second)).toContain('连续第 2 次');
    expect(String(second)).toContain('别再重发同一个 useBlock');
    expect(String(second)).toContain('代码级故障');
    expect(String(second)).not.toContain('换**另一个**容器');
  });

  it('窗口包到过但没接住 ⇒ 如实说"到过 N 次"（不是服务端没响应）', async () => {
    const bot = fakeBot({
      openContainer: vi.fn(async () => {
        bot._emit('windowOpen', { id: 1 }); // 包到了
        return new Promise(() => {}); // 但我们这边没接住
      }),
    });
    const err = await openBlockUi(bot, chest, { timeoutMs: 100, retries: 0 }).catch((e: Error) => e.message);
    expect(String(err)).toContain('到过 1 次');
    expect(String(err)).toContain('不是服务端没响应');
  });
});

describe('成功路径不许被诊断代码破坏', () => {
  it('立刻返回窗口 ⇒ 成功，且连续失败计数被清掉', async () => {
    const bot = fakeBot({ openContainer: async () => ({ kind: 'container', id: 3 }) });
    await expect(openBlockUi(bot, chest)).resolves.toMatchObject({ kind: 'container', id: 3 });
    // 一次失败之后成功，计数应清零（否则下次失败就误报"连续第 2 次"）
    const bot2 = fakeBot({ openContainer: async () => ({ kind: 'container' }) });
    await openBlockUi(bot2, chest, { timeoutMs: 100 }).catch(() => undefined);
    await openBlockUi(bot2, chest);
    const after = await openBlockUi(fakeBot(), chest, { timeoutMs: 100 }).catch((e: Error) => e.message);
    expect(String(after)).toContain('换**另一个**容器');
  });

  it('熔炉族仍走 openFurnace（回归：分路不许坏）', async () => {
    const bot = fakeBot({ openFurnace: vi.fn(async () => ({ kind: 'furnace' })) });
    await expect(openBlockUi(bot, { name: 'furnace', position: { x: 1, y: 2, z: 3 } })).resolves.toMatchObject({
      kind: 'furnace',
    });
    expect(bot.openContainer).not.toHaveBeenCalled();
  });

  it('常量仍是"有界 + 重试一次"（不许靠拉长超时掩盖）', () => {
    expect(CONTAINER_OPEN_TIMEOUT_MS).toBe(6_000);
    expect(CONTAINER_OPEN_RETRIES).toBe(1);
  });
});

describe('跨维度不串用"容器打不开"的结论（Lead 2026-10-19 ②）', () => {
  const src = () => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('结论记录**得出时的维度**，比较后才生效', () => {
    const code = src();
    expect(code).toContain('this.slottedContainerBlockedDim');
    expect(code).toContain('this.slottedContainerBlockedDim !== here');
    expect(code).toContain('return { blocked: false, reason: null, msLeft: 0 };');
  });

  it('窗口真的到达（window-arrived）时连维度一起清掉（结论可过期）', () => {
    expect(src()).toContain('this.slottedContainerBlockedDim = null;');
  });
});

describe('结论只属于失败的那一种方块（B 自我纠正：熔炉可用、21 块玻璃）', () => {
  const src = () => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
  const skills = () => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

  it('按方块类型记录结论，不同类型不互相短路', () => {
    const code = src();
    expect(code).toContain('this.slottedContainerBlockedFor');
    expect(code).toContain('askingFor !== this.slottedContainerBlockedFor');
    expect(code).toContain('slottedContainerStatus(askingFor?: string | null)');
    // 调用方把方块名传进去
    expect(skills()).toContain('read(name)');
  });

  it('回执不再下"容器全坏"的全局结论，而是 attempt-scoped + 指出换一种类型', () => {
    const text = skills();
    expect(text).not.toContain('**别再开任何箱子/熔炉/柜子**');
    expect(text).toContain('换另一种容器类型再试');
    expect(text).toContain('21 块玻璃');
  });
});
