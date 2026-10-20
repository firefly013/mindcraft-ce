/**
 * **"关掉了残留界面"必须有包级证据**（Lead 2026-10-21）：
 * `bot.currentWindow != null` 只是代理——服务端没发 close_window 时 mineflayer 会留下过期引用，
 * 于是回执宣称"我关掉了界面"，而界面根本没对模型开着。证据是：见过 open_window/open_screen、
 * 没见到 close_window。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeStaleWindow } from '../src/body/library/skills.js';

function fakeBot(over: Record<string, any> = {}): any {
  const bot: any = {
    currentWindow: { id: 3 },
    closed: 0,
    closeWindow() {
      bot.closed += 1;
    },
    ...over,
  };
  return bot;
}

describe('closeStaleWindow：包级判据优先于 currentWindow', () => {
  it('**有窗口引用但没有 open 包证据** ⇒ 不关闭、不宣称（返回 false）', () => {
    const bot = fakeBot({ __residualScreenOpen: () => false });
    expect(closeStaleWindow(bot)).toBe(false);
    expect(bot.closed).toBe(0);
    expect(bot.currentWindow).not.toBeNull();
  });

  it('见过 open 未见 close（provider 返回 true）+ 窗口引用 ⇒ 关闭并返回 true（恰好一次）', () => {
    const bot = fakeBot({ __residualScreenOpen: () => true });
    expect(closeStaleWindow(bot)).toBe(true);
    expect(bot.closed).toBe(1);
    expect(bot.currentWindow).toBeNull();
  });

  it('provider 抛错 ⇒ 当作"读不到证据"，不宣称', () => {
    const bot = fakeBot({ __residualScreenOpen: () => { throw new Error('x'); } });
    expect(closeStaleWindow(bot)).toBe(false);
    expect(bot.closed).toBe(0);
  });

  it('没有 provider（老调用方/纯测试）⇒ 回退旧行为，保持兼容', () => {
    const bot = fakeBot();
    expect(closeStaleWindow(bot)).toBe(true);
  });
});

describe('接线守卫：身体用包计数装 provider（只读判据，不碰 openBlockUi 重试）', () => {
  const body = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
  it('open_window/open_screen/close_window 计数 + __residualScreenOpen provider', () => {
    const code = body();
    expect(code).toContain("client.on?.('open_window'");
    expect(code).toContain("client.on?.('open_screen'");
    expect(code).toContain("client.on?.('close_window'");
    expect(code).toContain('this.screenOpenPackets > this.screenClosePackets');
    expect(code).toContain('__residualScreenOpen');
    expect(code).toContain('this.installResidualScreenVerdict();');
  });
  it('skills 里那句话只在判据为真时才可能走到（两个调用点都在 closeStaleWindow 为真分支内）', () => {
    const skills = readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');
    expect(skills).toContain('const hadStale = closeStaleWindow(bot);');
    expect(skills).toContain('if (hadStale) {');
    expect(skills).toContain('if (closeStaleWindow(bot)) {');
  });
});
