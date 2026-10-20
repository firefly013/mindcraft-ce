/**
 * escape 反射必须有界、可让位、不把 bot 送进怪堆（真机 2026-10-20，overnight_b）：
 * 「连续 30+ 秒报 in_progress…期间一直在掉血（19→14→9→2→0），还把我从 (28,60,15)
 *  '横移到实心落点'，最后跑到 (-65,65,-24)。三轮里被 creeper/drowned/spider 打死。」
 * 原则：**一个不肯放弃的助手比没有助手更危险。**
 */
import { describe, expect, it } from 'vitest';
import {
  FLEE_MAX_MS,
  FLEE_MAX_STEPS,
  FLEE_HEALTH_DROP_TICKS,
  runEmergency,
} from '../src/body/safety/emergency.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBot(over: Record<string, any> = {}) {
  let health = over.health ?? 18;
  const state = {
    threats: [] as any[],
    reports: [] as any[],
    flees: 0,
    /** 每次 tick 掉多少血（0 = 不掉）。 */
    dropPerTick: 0,
  };
  const bot: any = {
    // 每次读健康值就掉一点：模拟"一直在掉血"（真机 19→14→9→2→0）。
    get health() { const value = health; health -= state.dropPerTick; return value; },
    inventoryNames: () => [],
    feet: () => ({ x: 0, y: 64, z: 0 }),
    threats: () => state.threats,
    stopAll: () => {},
    fleeTo: () => { state.flees += 1; },
    eat: async () => {},
    hasSafeDestination: () => over.safeDestination ?? false,
    shouldYieldEscape: () => over.yieldNow ?? null,
    reportProgress: (info: any) => state.reports.push(info),
  };
  const tick = async () => { health -= state.dropPerTick; await sleep(0); };
  return { bot, state, tick, setHealth: (v: number) => { health = v; } };
}

describe('escape 有界 + 可让位', () => {
  it('找不到验证过的落点、血还在掉 ⇒ 掉血 streak 一到就交还身体（不让它空转）', async () => {
    const { bot, state } = fakeBot({ safeDestination: false });
    state.dropPerTick = 1;
    state.threats = [{ entity: { position: { x: 50, z: 0 } } }];
    const result: any = await runEmergency(bot, { tickMs: 1, sleep: (async (ms: number) => { await sleep(ms); }) as (ms: number) => Promise<void>, intent: 'flee' });
    expect(result.escaped).toBe(false);
    expect(result.reason).toBe('no-safe-destination-and-losing-health');
    expect(state.flees).toBeLessThan(5); // 掉血 3 tick 内就放弃，不会横移很多次
    expect(state.reports.some((r: any) => r.final === 'no-safe-destination-and-losing-health')).toBe(true);
  });

  it('**步数上限**：威胁一直在、落点一直"有"也不许无限跑', async () => {
    const { bot, state } = fakeBot({ safeDestination: true });
    state.threats = [{ entity: { position: { x: 50, z: 0 } } }];
    const result: any = await runEmergency(bot, { tickMs: 1, sleep: (async (ms: number) => { await sleep(ms); }) as (ms: number) => Promise<void>, intent: 'flee' });
    expect(result.reason).toBe('step-cap');
    expect(state.flees).toBeLessThanOrEqual(FLEE_MAX_STEPS);
  });

  it('刚死过且身上空 ⇒ 立刻交还，不再重试同一条逃生链', async () => {
    const { bot, state } = fakeBot({ yieldNow: { yield: true, reason: 'empty-after-death' } });
    state.threats = [{ entity: { position: { x: 50, z: 0 } } }];
    const result: any = await runEmergency(bot, { tickMs: 1, sleep: (async (ms: number) => { await sleep(ms); }) as (ms: number) => Promise<void>, intent: 'flee' });
    expect(result.escaped).toBe(false);
    expect(result.reason).toContain('yield:empty-after-death');
  });

  it('进度必须以"第 N 步 / 已用 M 秒 / 血 X"的形态上报（不能只给一句 in_progress）', async () => {
    const { bot, state } = fakeBot({ safeDestination: true });
    state.threats = [{ entity: { position: { x: 50, z: 0 } } }];
    await runEmergency(bot, { tickMs: 1, sleep: (async (ms: number) => { await sleep(ms); }) as (ms: number) => Promise<void>, intent: 'flee' });
    const progress = state.reports.filter((r: any) => r.final == null);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]).toHaveProperty('step');
    expect(progress[0]).toHaveProperty('ms');
    expect(progress[0]).toHaveProperty('health');
    expect(progress[0]).toHaveProperty('safeDestination');
  });

  it('上限常量是硬上限（20 秒 / 20 步 / 掉血 3 tick）', () => {
    expect(FLEE_MAX_MS).toBeLessThanOrEqual(20_000);
    expect(FLEE_MAX_STEPS).toBeLessThanOrEqual(20);
    expect(FLEE_HEALTH_DROP_TICKS).toBeLessThanOrEqual(3);
  });
});
