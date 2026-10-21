/**
 * 低血静止诊断（Lead 2026-10-21）：只写 lifecycle，**不产生模型事件、不是门、不改行为**。
 * 目的：区分"身体被锁" vs "模型没发指令"——B 曾在 2.67 HP 静止 ≥45 秒后死亡。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOW_HEALTH_IDLE_INTERVAL_MS,
  LOW_HEALTH_IDLE_THRESHOLD,
  MineflayerBody,
} from '../src/body/mineflayer_body.js';

function fakeBody(opts: { health?: number; food?: number } = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  const records: any[] = [];
  body.bot = { health: opts.health ?? 3, food: opts.food ?? 16 };
  body.modelActionsInFlight = 0;
  body.reflexRunning = false;
  body.currentReflexName = null;
  body.lastActionName = '';
  body.lastActionAtMs = 0;
  body.lastLowHealthIdleLogAt = 0;
  body.log = { with: () => ({ info: (payload: any) => records.push(payload) }) };
  return { body, records };
}

describe('低血 + 静止 ⇒ 每 30 秒恰好一行（带"谁占着身体"的字段）', () => {
  it('第一次立即写一行；字段齐全（health/food/reflex/inFlight/lastAction）', () => {
    const { body, records } = fakeBody({ health: 3, food: 16 });
    expect(body.maybeLogLowHealthIdle(1_000)).toBe(true);
    expect(records).toHaveLength(1);
    const payload = records[0];
    expect(payload.event).toBe('low-health-idle');
    expect(payload.health).toBe(3);
    expect(payload.food).toBe(16);
    expect(payload.reflexRunning).toBe(false);
    expect(payload.inFlight).toBe(0);
    expect(payload.reflexKind).toBeNull();
    expect(payload.lastAction).toBeNull();
  });
  it('30 秒内不重复；满 30 秒再写一行', () => {
    const { body, records } = fakeBody({ health: 3 });
    body.maybeLogLowHealthIdle(1_000);
    expect(body.maybeLogLowHealthIdle(1_000 + LOW_HEALTH_IDLE_INTERVAL_MS - 1)).toBe(false);
    expect(records).toHaveLength(1);
    expect(body.maybeLogLowHealthIdle(1_000 + LOW_HEALTH_IDLE_INTERVAL_MS)).toBe(true);
    expect(records).toHaveLength(2);
  });
});

describe('不刷屏：血恢复 / 有动作在飞 ⇒ 静默', () => {
  it('血量正常 ⇒ 不写，并重置计时（下一次低血立即写）', () => {
    const { body, records } = fakeBody({ health: 20 });
    expect(body.maybeLogLowHealthIdle(1_000)).toBe(false);
    expect(records).toHaveLength(0);
    body.bot.health = 3;
    expect(body.maybeLogLowHealthIdle(2_000)).toBe(true);
  });
  it('有动作在飞（inFlight>0）⇒ 不写——那是"忙"，不是"静止"', () => {
    const { body, records } = fakeBody({ health: 3 });
    body.modelActionsInFlight = 1;
    expect(body.maybeLogLowHealthIdle(1_000)).toBe(false);
    expect(records).toHaveLength(0);
  });
  it('带反射占有者名（reflexKind/lastAction）时字段如实写出', () => {
    const { body, records } = fakeBody({ health: 2 });
    body.reflexRunning = true;
    body.currentReflexName = 'escape';
    body.lastActionName = 'huntFor';
    body.lastActionAtMs = 123;
    body.maybeLogLowHealthIdle(1_000);
    expect(records[0].reflexRunning).toBe(true);
    expect(records[0].reflexKind).toBe('escape');
    expect(records[0].lastAction).toBe('huntFor');
    expect(records[0].lastActionAtMs).toBe(123);
  });
});

describe('接线守卫：update() 调用、且不走模型事件通道', () => {
  const code = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
  it('update() 里调用 maybeLogLowHealthIdle', () => {
    expect(code()).toContain('this.maybeLogLowHealthIdle();');
  });
  it('诊断只用 log.with(lifecycle)，不调用 notify', () => {
    const body = code();
    const start = body.indexOf('maybeLogLowHealthIdle(now: number = Date.now())');
    const end = body.indexOf('private detectVanishedInventory', start);
    const region = body.slice(start, end);
    expect(region).toContain("this.log.with('lifecycle').info({");
    expect(region).not.toContain('this.notify(');
    expect(LOW_HEALTH_IDLE_THRESHOLD).toBe(6);
  });
});
