/**
 * `assumed-empty` 只允许出现在**观察到死亡之后的那次 spawn**（Lead 2026-10-21 第二轮）：
 * 真机 B 三次 `via:"assumed-empty-after-death"`（spawn，itemCount 0）里，死亡其实在 12 分钟前——
 * 说明 spawn/reconnect 被当成了死亡。并且 35 秒内重复了 4 次（重复结论）。
 *
 * 新契约：`spawnFollowedDeath` 只在"死亡事件之后、尚未 spawn"时置真；每次 login 只 settle 一次。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

afterEach(() => vi.useRealTimers());
const source = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

function bareBody(items: Array<{ name: string; count: number }>, over: Record<string, any> = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  body.inventorySynced = false;
  body.inventorySyncRecoveryTimer = null;
  body.inventoryPacketSeen = false;
  body.inventorySyncSettledForLogin = false;
  body.spawnFollowedDeath = false;
  body.lastDeathAt = 0;
  body.bot = { inventory: { items: () => items } };
  body.logs = [];
  body.log = { with: () => ({ info: (p: unknown) => body.logs.push(p), warn: () => {}, error: () => {} }) };
  Object.assign(body, over);
  return body;
}
const vias = (body: any): string[] =>
  body.logs.filter((e: any) => e.event === 'inventory-sync-recovery').map((e: any) => e.via);

describe('死亡门槛：只认"死亡事件之后的那次 spawn"', () => {
  it('**12 分钟前死过、但这次只是重连** ⇒ still-unsynced，绝不 assumed-empty-after-death', () => {
    vi.useFakeTimers();
    const body = bareBody([], { lastDeathAt: Date.now() - 12 * 60_000, spawnFollowedDeath: false });
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(35_000);
    expect(body.inventorySynced).toBe(false);
    expect(vias(body)).toContain('still-unsynced-after-reconnect');
    expect(vias(body)).not.toContain('assumed-empty-after-death');
  });

  it('**刚死完这次 spawn** ⇒ 允许 assumed-empty-after-death（仅此一次）', () => {
    vi.useFakeTimers();
    const body = bareBody([], { spawnFollowedDeath: true, lastDeathAt: Date.now() - 2_000 });
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(4_000);
    expect(body.inventorySynced).toBe(true);
    expect(vias(body).filter((v) => v === 'assumed-empty-after-death')).toHaveLength(1);
  });

  it('**同一 login 内重复 arm**：第二次直接不仲裁（不会再来一遍 4 次结论）', () => {
    vi.useFakeTimers();
    const body = bareBody([], { spawnFollowedDeath: true, lastDeathAt: Date.now() - 2_000 });
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(4_000);
    body.armInventorySyncRecovery('spawn');
    vi.advanceTimersByTime(10_000);
    expect(vias(body).filter((v) => v === 'assumed-empty-after-death')).toHaveLength(1);
  });

  it('packet-empty / read-nonempty 仍然照常（没被死亡门槛误伤）', () => {
    vi.useFakeTimers();
    const withPacket = bareBody([]);
    withPacket.armInventorySyncRecovery('login');
    vi.advanceTimersByTime(300);
    withPacket.inventoryPacketSeen = true;
    vi.advanceTimersByTime(300);
    expect(vias(withPacket)).toContain('packet-empty');

    const withItems = bareBody([{ name: 'dirt', count: 3 }]);
    withItems.armInventorySyncRecovery('login');
    vi.advanceTimersByTime(300);
    expect(vias(withItems)).toContain('read-nonempty');
  });
});

describe('接线守卫：spawn 不再冒充死亡；渲染与生命周期同一个 owner', () => {
  it('pendingRespawnDeath 只由死亡事件置真，spawn 消费并清掉', () => {
    const code = source();
    expect(code).toContain('this.pendingRespawnDeath = true;');
    expect(code).toContain('this.spawnFollowedDeath = this.pendingRespawnDeath === true;');
    expect(code).toContain('this.pendingRespawnDeath = false;');
    expect(code).not.toContain('this.lastDeathAt = Date.now();\n            this.armInventorySyncRecovery');
  });
  it('settle 写入 settledForLogin；arm 里对已结算的重连直接返回', () => {
    const code = source();
    expect(code).toContain('this.inventorySyncSettledForLogin = true;');
    expect(code).toContain('if (this.inventorySyncSettledForLogin && this.spawnFollowedDeath !== true) return;');
    expect(code).toContain("event: 'inventory-sync-rearmed'");
  });
  it('旧的时间窗死亡 gate 已删除（lastDeathAt 不再单独决定 assumed-empty）', () => {
    expect(source()).not.toContain('const recentlyDied = this.lastDeathAt > 0 && Date.now() - this.lastDeathAt <= 60_000;');
  });
});
