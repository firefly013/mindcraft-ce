/**
 * `assumed-empty` 只能在**死亡/复活**后成立（Lead 2026-10-21，自己的设计错误）：
 * 进程重连时物品还在世界里，把它报成"空"会让模型重采一切（真机已误报 38 次）。
 * 四个出口必须可区分：read-nonempty / packet-empty / assumed-empty-after-death /
 * still-unsynced-after-reconnect。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

afterEach(() => vi.useRealTimers());

const bodySource = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

function bareBody(items: Array<{ name: string; count: number }>, over: Record<string, any> = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  body.inventorySynced = false;
  body.inventorySyncRecoveryTimer = null;
  body.inventoryPacketSeen = false;
  body.lastDeathAt = 0;
  body.bot = { inventory: { items: () => items } };
  body.logs = [];
  body.log = { with: () => ({ info: (p: unknown) => body.logs.push(p), warn: () => {}, error: () => {} }) };
  Object.assign(body, over);
  return body;
}

const vias = (body: any): string[] => body.logs.filter((e: any) => e.event === 'inventory-sync-recovery').map((e: any) => e.via);

describe('四个出口', () => {
  it('**重连（没死过）且读不到内容包** ⇒ 30 秒上限后仍是"未知"，绝不 assumed-empty', () => {
    vi.useFakeTimers();
    const body = bareBody([]); // 本地视图为空，但从没收到 packet，也没死过
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(35_000);
    expect(body.inventorySynced).toBe(false);
    expect(vias(body)).toContain('still-unsynced-after-reconnect');
    expect(vias(body)).not.toContain('assumed-empty-after-death');
  });

  it('复活（最近确实死过）且一直空 ⇒ 允许 assumed-empty-after-death', () => {
    vi.useFakeTimers();
    const body = bareBody([], { lastDeathAt: Date.now() - 2_000 });
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(4_000);
    expect(body.inventorySynced).toBe(true);
    expect(vias(body)).toContain('assumed-empty-after-death');
  });

  it('**收到过 windowId 0 的包（哪怕 0 格）** ⇒ packet-empty（这是测量，不是假设）', () => {
    vi.useFakeTimers();
    const body = bareBody([]);
    body.armInventorySyncRecovery('login');
    vi.advanceTimersByTime(300);
    // 包在这一刻到达（空包也是测量）
    body.inventoryPacketSeen = true;
    vi.advanceTimersByTime(300);
    body.armInventorySyncRecovery('login');
    vi.advanceTimersByTime(300);
    expect(body.inventorySynced).toBe(true);
    expect(vias(body)).toContain('packet-empty');
  });

  it('读到非空 ⇒ read-nonempty', () => {
    vi.useFakeTimers();
    const body = bareBody([{ name: 'dirt', count: 11 }]);
    body.armInventorySyncRecovery('login');
    vi.advanceTimersByTime(300);
    expect(vias(body)).toContain('read-nonempty');
  });

  it('重连时**不允许** fallback 把 inventorySynced 置真（这是本 bug 的核心）', () => {
    vi.useFakeTimers();
    const body = bareBody([]);
    body.armInventorySyncRecovery('login');
    vi.advanceTimersByTime(3_500);
    expect(body.inventorySynced).toBe(false);
  });
});

describe('接线守卫', () => {
  it('三个监听器都把 inventoryPacketSeen 置真，恢复逻辑据此区分 packet-empty', () => {
    const code = bodySource();
    expect(code).toContain('this.inventoryPacketSeen = true;');
    expect(code).toContain("settle('packet-empty')");
    expect(code).toContain("settle('assumed-empty-after-death')");
    expect(code).toContain("via: 'still-unsynced-after-reconnect'");
    expect(code).toContain("event: 'inventory-sync-stuck'");
  });
  it('不再有旧的 assumed-empty 出口', () => {
    expect(bodySource()).not.toContain("settle('assumed-empty')");
  });
});
