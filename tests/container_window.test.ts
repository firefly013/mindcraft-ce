/**
 * 重启后箱子打不开 —— 真机 2026-10-18 18:18（overnight_a）的回归。
 *
 * 模型原话：`进程重启后箱子打不开：Event windowOpen did not fire within timeout of 20000ms`
 * 日志实证（agent-20261018.log，10:18:20）：
 * ```
 * - 取出 stone_pickaxe：请求 9（操作未完成）
 *     打不开容器：Event windowOpen did not fire within timeout of 20000ms
 * 10:18:20.878  {"mod":"lifecycle","event":"screen-closed","why":"leaked-open-window"}
 * ```
 * 也就是说：**等了整整 20 秒，然后身体才在空闲时清掉那个残留界面**——顺序反了。
 * 我们要钉住的行为：
 *   1. 每次开界面**之前**先清残留窗口（进程重启/上一次动作留下的）；
 *   2. 等待有上限（6 秒）+ **重试一次**，不是干等 mineflayer 的 20 秒；
 *   3. 失败回执说人话（原因 + 下一步 + 原始错误），不是一句英文超时；
 *   4. 熔炉/箱子依旧分路（残留窗口同样会卡住熔炉与合成）。
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTAINER_OPEN_RETRIES,
  CONTAINER_OPEN_TIMEOUT_MS,
  closeStaleWindow,
  craftWithStaleWindowGuard,
  openBlockUi,
} from '../src/body/library/skills.js';

function fakeBot(overrides: Record<string, unknown> = {}): any {
  const order: string[] = [];
  const bot: any = {
    output: '',
    order,
    currentWindow: null,
    closeWindow: vi.fn((win: unknown) => {
      order.push('closeWindow');
      void win;
    }),
    openContainer: vi.fn(async () => {
      order.push('openContainer');
      return { kind: 'container', close: () => {} };
    }),
    openFurnace: vi.fn(async () => {
      order.push('openFurnace');
      return { kind: 'furnace' };
    }),
    ...overrides,
  };
  return bot;
}

const chest = { name: 'chest', position: { x: 1, y: 64, z: 1 } };
const furnace = { name: 'furnace', position: { x: 2, y: 64, z: 1 } };

describe('closeStaleWindow：清掉"客户端以为还开着"的界面', () => {
  it('没有界面时什么都不做', () => {
    const bot = fakeBot();
    expect(closeStaleWindow(bot)).toBe(false);
    expect(bot.closeWindow).not.toHaveBeenCalled();
  });

  it('有界面：发 close_window 并把引用清成 null', () => {
    const win = { id: 3 };
    const bot = fakeBot({ currentWindow: win });
    expect(closeStaleWindow(bot)).toBe(true);
    expect(bot.closeWindow).toHaveBeenCalledWith(win);
    expect(bot.currentWindow).toBeNull();
  });

  it('closeWindow 抛错（窗口早就无效）也要把引用清掉', () => {
    const bot = fakeBot({
      currentWindow: { id: 9 },
      closeWindow: () => {
        throw new Error('window already gone');
      },
    });
    expect(closeStaleWindow(bot)).toBe(true);
    expect(bot.currentWindow).toBeNull();
  });
});

describe('openBlockUi：先清残留、再开、失败重试一次', () => {
  it('正常开箱子：**先**清残留界面，再 openContainer', async () => {
    const bot = fakeBot({ currentWindow: { id: 1 } });
    const win = await openBlockUi(bot, chest);
    expect(win).toMatchObject({ kind: 'container' });
    expect(bot.order).toEqual(['closeWindow', 'openContainer']); // 顺序就是重点
    expect(bot.openContainer).toHaveBeenCalledTimes(1);
    expect(bot.output).toContain('残留的界面');
  });

  it('第一次超时/失败 → 清一次 + **重试**，第二次成功（不再干等 20 秒）', async () => {
    let call = 0;
    const bot = fakeBot({
      openContainer: vi.fn(async () => {
        call += 1;
        bot.order.push(`openContainer#${call}`);
        if (call === 1) throw new Error('Event windowOpen did not fire within timeout of 20000ms');
        return { kind: 'container' };
      }),
    });
    const win = await openBlockUi(bot, chest, { timeoutMs: 50 });
    expect(win).toMatchObject({ kind: 'container' });
    expect(bot.openContainer).toHaveBeenCalledTimes(2);      // 重试了一次
    expect(bot.output).toContain('重试一次');
    expect(bot.output).toContain('重试成功');
  });

  it('两次都不成：抛**说人话**的回执（原因 + 下一步 + 原始错误），不是英文超时', async () => {
    const bot = fakeBot({
      openContainer: vi.fn(() => new Promise(() => {})),   // 永远等不到窗口事件
    });
    await expect(openBlockUi(bot, chest, { timeoutMs: 30 })).rejects.toThrow(/打开 chest 失败/);
    await expect(openBlockUi(bot, chest, { timeoutMs: 30 })).rejects.toThrow(/服务端没回窗口事件/);
    await expect(openBlockUi(bot, chest, { timeoutMs: 30 })).rejects.toThrow(/上一次重启留下的窗口/);
    const err = await openBlockUi(bot, chest, { timeoutMs: 30 }).catch((e: Error) => e.message);
    expect(String(err)).toContain('下一步');
    expect(String(err)).toContain('Event windowOpen did not fire');   // 原始错误如实附上
    expect(String(err)).not.toBe('Event windowOpen did not fire within timeout of 20000ms');
    expect(bot.openContainer).toHaveBeenCalledTimes(2 * 4);           // 每次调用最多 attempts+1
  });

  it('等待有上限：默认 6 秒（不是 mineflayer 的 20 秒），重试 1 次', () => {
    expect(CONTAINER_OPEN_TIMEOUT_MS).toBe(6_000);
    expect(CONTAINER_OPEN_RETRIES).toBe(1);
    expect(CONTAINER_OPEN_TIMEOUT_MS).toBeLessThan(20_000);
  });

  it('熔炉走 openFurnace，箱子走 openContainer（残留窗口一样会卡住熔炉）', async () => {
    const bot = fakeBot({ currentWindow: { id: 2 } });
    await openBlockUi(bot, furnace);
    expect(bot.openFurnace).toHaveBeenCalledTimes(1);
    expect(bot.openContainer).not.toHaveBeenCalled();
    expect(bot.order).toEqual(['closeWindow', 'openFurnace']);

    const bot2 = fakeBot();
    await openBlockUi(bot2, chest);
    expect(bot2.openContainer).toHaveBeenCalledTimes(1);
    expect(bot2.openFurnace).not.toHaveBeenCalled();
  });

  it('开不了的方块（工作台）依旧如实报错，不去调任何 opener', async () => {
    const bot = fakeBot();
    await expect(openBlockUi(bot, { name: 'crafting_table' })).rejects.toThrow(/没有"打开界面"这个操作/);
    expect(bot.openContainer).not.toHaveBeenCalled();
    expect(bot.openFurnace).not.toHaveBeenCalled();
  });

  it('自定义超时/重试次数生效（调用方可以更保守）', async () => {
    const bot = fakeBot({ openContainer: vi.fn(() => new Promise(() => {})) });
    await expect(openBlockUi(bot, chest, { timeoutMs: 20, retries: 0 })).rejects.toThrow(/打开 chest 失败/);
    expect(bot.openContainer).toHaveBeenCalledTimes(1);   // retries=0 → 只试一次
  });
});

describe('craftWithStaleWindowGuard：合成也吃同一套守卫', () => {
  it('合成前清残留窗口；成功就返回', async () => {
    const order: string[] = [];
    const bot: any = {
      output: '',
      currentWindow: { id: 5 },
      closeWindow: () => order.push('closeWindow'),
      craft: vi.fn(async () => {
        order.push('craft');
      }),
    };
    await craftWithStaleWindowGuard(bot, { id: 'recipe' }, 1, { name: 'crafting_table' });
    expect(order).toEqual(['closeWindow', 'craft']);
    expect(bot.craft).toHaveBeenCalledTimes(1);
  });

  it('工作台窗口不来（20 秒硬等的那个病）：有界 + 重试一次 + 说人话', async () => {
    const bot: any = {
      output: '',
      currentWindow: null,
      closeWindow: vi.fn(),
      craft: vi.fn(() => new Promise(() => {})),
    };
    const err = await craftWithStaleWindowGuard(bot, { id: 'recipe' }, 1, null, { timeoutMs: 100 })
      .then(() => null)
      .catch((e: Error) => e.message);
    expect(String(err)).toContain('合成失败');
    expect(String(err)).toContain('工作台窗口事件');
    expect(String(err)).toContain('下一步');
    expect(String(err)).toContain('Event windowOpen did not fire');
    expect(bot.craft).toHaveBeenCalledTimes(2);   // 重试了一次
  });

  it('craft 自己抛错也如实带上原始错误（不吞）', async () => {
    const bot: any = {
      output: '',
      currentWindow: null,
      closeWindow: vi.fn(),
      craft: vi.fn(async () => {
        throw new Error('Recipe requires craftingTable, but one was not supplied');
      }),
    };
    await expect(craftWithStaleWindowGuard(bot, { id: 'r' }, 1, null)).rejects.toThrow(/requires craftingTable/);
    // 而且**只试一次**：这不是窗口问题，重试没有意义。
    expect(bot.craft).toHaveBeenCalledTimes(1);
  });
});

describe('重连/复活时清界面状态：身体侧接线不许被删掉（架构守卫）', () => {
  it('login 与 spawn 两个入口都调了 closeStaleWindow', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain("this.bot.on('login'");
    expect(src).toContain("this.bot.on('spawn'");
    const calls = src.match(/closeStaleWindow\(this\.bot\)/g) ?? [];
    expect(calls.length, 'login 和 spawn 都该清一次残留界面').toBeGreaterThanOrEqual(2);
    expect(src).toContain('container-window-reset');
  });
});
