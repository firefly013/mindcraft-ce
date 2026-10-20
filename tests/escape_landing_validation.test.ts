/**
 * 逃生落点验证接进生产路径（Lead 2026-10-20，两轮欠账）：
 * 「escape 把我从 (28,60,15) '横移到实心落点'，最后跑到 (-65,65,-24)，三轮被
 *  creeper/drowned/spider 打死」——**"实心"不等于"安全"**。
 * 规则：落点必须有实心地面、不是岩浆/水、**附近没有敌对生物**（isHostile）；
 * 掉血且找不到验证过的落点 ⇒ 立刻交还身体，并给可执行的下一步。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

/** 用 Object.create 造最小 body（类字段初始器不会跑，所以按需补）。 */
function bareBody(over: Record<string, any> = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  body.bot = over.bot ?? { entity: { position: { x: 0, y: 64, z: 0 } } };
  body.currentReflexName = 'escape';
  body.reflexAbortRequested = false;
  body.lastDeathAt = 0;
  body.escapeProgressAt = 0;
  body.notifies = [];
  body.notify = (type: string, _kind: unknown, _level: unknown, payload: unknown): void => {
    body.notifies.push({ type, payload });
  };
  body.log = { with: () => ({ info: () => {}, warn: () => {}, error: () => {} }) };
  return body;
}

/** 世界：只有 (0..3, 63, 0) 是石头；可指定哪些位置有敌对生物。 */
function worldBot(opts: { hostiles?: Array<{ x: number; z: number }>; lava?: boolean } = {}): any {
  const hostiles = opts.hostiles ?? [];
  return {
    entity: { position: { x: 0.5, y: 64, z: 0.5 }, height: 1.8 },
    blockAt: (v: any) => {
      const { x, y, z } = v;
      if (y === 63 && x >= 0 && x <= 3 && z === 0) return { name: opts.lava ? 'lava' : 'stone' };
      return { name: 'air' };
    },
    entities: Object.fromEntries(
      hostiles.map((h, i) => [String(i + 1), { id: i + 1, name: 'zombie', type: 'hostile', position: { x: h.x, y: 64, z: h.z } }]),
    ),
    inventory: { items: () => [] },
  };
}

describe('hasVerifiedEscapeDestination：实心 ≠ 安全', () => {
  it('落点附近有敌对生物 ⇒ **不算**验证过的落点（不许把人往怪堆里送）', () => {
    const body = bareBody({ bot: worldBot({ hostiles: [{ x: 2, z: 0 }] }) });
    expect(body.hasVerifiedEscapeDestination()).toBe(false);
  });

  it('落点是岩浆 ⇒ 不算', () => {
    const body = bareBody({ bot: worldBot({ lava: true }) });
    expect(body.hasVerifiedEscapeDestination()).toBe(false);
  });

  it('读不到世界 ⇒ 返回 true（守卫坏了不许变成新的墙）', () => {
    const body = bareBody({ bot: {} });
    expect(body.hasVerifiedEscapeDestination()).toBe(true);
  });
});

describe('escapeYieldVerdict：刚死且身上空 ⇒ 不再重试同一条链', () => {
  it('最近死过 + 背包空 ⇒ yield:empty-after-death（Hard 档再逃就是再掉一次装备）', () => {
    const body = bareBody({ bot: worldBot() });
    body.lastDeathAt = Date.now() - 1000;
    expect(body.escapeYieldVerdict()).toMatchObject({ yield: true, reason: 'empty-after-death' });
  });

  it('最近死过但身上有东西 ⇒ 不交还', () => {
    const body = bareBody({ bot: { ...worldBot(), inventory: { items: () => [{ name: 'stone', count: 3 }] } } });
    body.lastDeathAt = Date.now() - 1000;
    expect(body.escapeYieldVerdict()).toBeNull();
  });

  it('没有死亡记录 ⇒ 不交还', () => {
    expect(bareBody().escapeYieldVerdict()).toBeNull();
  });
});

describe('reportEscapeProgress：放弃时必须给可执行的下一步', () => {
  it('放弃回执带原因 + stop/挖洞/放方块 或 "先别重试" 的下一步', () => {
    const body = bareBody();
    body.reportEscapeProgress({ step: 7, ms: 12_000, health: 6, safeDestination: false, final: 'no-safe-destination-and-losing-health' });
    const line = String(body.notifies.at(-1)?.payload?.detail ?? '');
    expect(line).toContain('放弃并交还身体');
    expect(line).toContain('no-safe-destination-and-losing-health');
    expect(line).toContain('stop()');
    expect(line).toContain('挖洞自封');
  });

  it('进度回执必须报"第 N 步 / 已用 M 秒 / 血 X / 有没有安全落点"', () => {
    const body = bareBody();
    body.reportEscapeProgress({ step: 4, ms: 9_000, health: 11, safeDestination: false, final: null });
    const line = String(body.notifies.at(-1)?.payload?.detail ?? '');
    expect(line).toContain('第 4 步');
    expect(line).toContain('已用 9 秒');
    expect(line).toContain('血 11');
    expect(line).toContain('还没有验证过安全的落点');
  });

  it('接线守卫：rescue 的依赖里三个钩子都在（不许再是悬空 helper）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain('hasSafeDestination: (): boolean => this.hasVerifiedEscapeDestination(),');
    expect(src).toContain('shouldYieldEscape: (): { yield: boolean; reason: string } | null => this.escapeYieldVerdict(),');
    expect(src).toContain('reportProgress: (info): void => this.reportEscapeProgress(info),');
  });
});
