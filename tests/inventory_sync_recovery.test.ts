/**
 * 复活后背包同步**必须恢复**（真机 2026-10-21，overnight_a）。
 *
 * 溺水重生后连续 3 次 `stats` 都返回「还没同步上来（刚重连，不是空的）…等一两秒再看」，
 * 又过了几十秒还是这句。文案是对的（未知不许渲染成空），但恢复坏了：
 * 复活时把 `inventorySynced=false`，之后只有 `window_items(windowId 0)` /
 * `heldItemChanged` 会置回 true；1.21.11 服务端发的是 `set_content`，空背包时
 * `heldItemChanged` 也不触发 ⇒ **一句"等一两秒"永远不兑现**。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

afterEach(() => {
  vi.useRealTimers();
});

const bodySource = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

function bareBody(items: Array<{ name: string; count: number }>): any {
  const body: any = Object.create(MineflayerBody.prototype);
  body.inventorySynced = false;
  body.inventorySyncRecoveryTimer = null;
  body.bot = { inventory: { items: () => items } };
  body.logs = [];
  body.log = {
    with: () => ({
      info: (payload: unknown) => body.logs.push(payload),
      warn: () => {},
      error: () => {},
    }),
  };
  return body;
}

describe('复活后背包同步：有界恢复', () => {
  it('读到非空背包 ⇒ 立刻标记同步（via: read-nonempty）', () => {
    vi.useFakeTimers();
    const body = bareBody([{ name: 'dirt', count: 11 }]);
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(260);
    expect(body.inventorySynced).toBe(true);
    expect(body.logs.some((e: any) => e.event === 'inventory-sync-recovery' && e.via === 'read-nonempty')).toBe(true);
  });

  it('**一直读到空**：3 秒上限到了也标记同步（via: assumed-empty），而不是永远"未知"', () => {
    vi.useFakeTimers();
    const body = bareBody([]);
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(2000);
    expect(body.inventorySynced).toBe(false);
    vi.advanceTimersByTime(1200);
    expect(body.inventorySynced).toBe(true);
    expect(body.logs.some((e: any) => e.event === 'inventory-sync-recovery' && e.via === 'assumed-empty')).toBe(true);
  });

  it('已经同步时不再起轮询', () => {
    vi.useFakeTimers();
    const body = bareBody([{ name: 'stone', count: 3 }]);
    body.inventorySynced = true;
    body.armInventorySyncRecovery('spawn');
    expect(body.inventorySyncRecoveryTimer).toBeNull();
  });

  it('markInventorySynced 会清掉待恢复的定时器', () => {
    vi.useFakeTimers();
    const body = bareBody([]);
    body.armInventorySyncRecovery('spawn');
    expect(body.inventorySyncRecoveryTimer).not.toBeNull();
    body.markInventorySynced();
    expect(body.inventorySyncRecoveryTimer).toBeNull();
    expect(body.inventorySynced).toBe(true);
  });
});

describe('接线守卫：1.21.11 的 set_content 也要能触发同步', () => {
  it('监听 window_items + set_content + container_set_content（windowId 0）', () => {
    const src = bodySource();
    expect(src).toContain("['window_items', 'set_content', 'container_set_content']");
    expect(src).toContain('if (Number(packet?.windowId) === 0) this.markInventorySynced();');
  });

  it('spawn 处理器会重新武装恢复（不只是把 flag 设成 false）', () => {
    expect(bodySource()).toContain("this.armInventorySyncRecovery('spawn');");
  });
});

describe('死亡掉落清单：完整，不许静默截断', () => {
  it('死亡清单区域不再有 slice 截断，并且带"共 N 种 M 件"', () => {
    const src = bodySource();
    const start = src.indexOf('const deathItems');
    const end = src.indexOf('MESSAGES.death(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    expect(region).not.toContain('.slice(');
    expect(region).toContain('种');
    expect(region).toContain('件');
  });

  it('未同步时清单必须标注"可能不完整"，不许把子集当权威', () => {
    const src = bodySource();
    expect(src).toContain('这份清单读自未同步的背包，可能不完整');
    expect(src).toContain('**不要**');
  });
});
