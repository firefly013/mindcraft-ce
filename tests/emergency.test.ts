/**
 * L5 保命契约：纯决策全覆盖，执行循环用 stub bot + 假时钟。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_HEALTH,
  fleeDestination,
  nearestThreat,
  pickBestFood,
  runEmergency,
  SAFE_SECONDS,
  shouldTriggerEmergency,
  THREAT_RADIUS,
} from '../src/agent/emergency.js';
import type { EmergencyBot } from '../src/agent/emergency.js';

describe('shouldTriggerEmergency', () => {
  it('fires strictly below max*0.3, never for the dead or the unreadable', () => {
    expect(shouldTriggerEmergency(5.9)).toBe(true);
    expect(shouldTriggerEmergency(6)).toBe(false);
    expect(shouldTriggerEmergency(0)).toBe(false);
    expect(shouldTriggerEmergency(-1)).toBe(false);
    expect(shouldTriggerEmergency(Number.NaN)).toBe(false);
    expect(shouldTriggerEmergency('low')).toBe(false);
    expect(shouldTriggerEmergency(29, 100)).toBe(true);
    expect(shouldTriggerEmergency(DEFAULT_MAX_HEALTH * 0.3)).toBe(false);
  });
});

describe('pickBestFood', () => {
  it('ranks by saturation first, then hunger; unknown foods last', () => {
    expect(pickBestFood(['bread', 'golden_carrot', 'apple'])).toBe('golden_carrot');
    expect(pickBestFood(['rotten_flesh', 'dried_kelp'])).toBe('rotten_flesh');
    expect(pickBestFood(['mystery_meat'])).toBe('mystery_meat');
    expect(pickBestFood([])).toBeNull();
  });
});

describe('nearestThreat', () => {
  const feet = { x: 0, y: 64, z: 0 };
  const at = (id: number, name: string, x: number, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    position: { x, y: 64, z: 0 },
    ...extra,
  });

  it('returns the nearest hostile inside the radius, nearest-first', () => {
    const t = nearestThreat([at(1, 'zombie', 20), at(2, 'skeleton', 5)], feet);
    expect(t?.entity.id).toBe(2);
    expect(t?.distance).toBeCloseTo(5);
  });

  it('ignores friendlies, the far away and the positionless', () => {
    const t = nearestThreat(
      [
        at(1, 'cow', 2),
        at(2, 'zombie', THREAT_RADIUS + 1),
        { id: 3, name: 'zombie', position: null },
        { id: 4, name: 'zombie', position: { x: 3, y: 64, z: 0 }, hostile: false },
      ],
      feet,
    );
    expect(t).toBeNull();
  });

  it('explicit hostile flag wins over the registry', () => {
    const t = nearestThreat([at(1, 'cow', 2, { hostile: true })], feet);
    expect(t?.entity.id).toBe(1);
  });
});

describe('fleeDestination', () => {
  it('lands FLEE_DISTANCE past the feet, away from the threat', () => {
    const dest = fleeDestination({ x: 0, z: 0 }, { x: 3, z: 4 }, 24);
    // 方向 (-3,-4)/5 * 24 = (-14.4, -19.2)，向下取整。
    expect(dest).toEqual({ x: -15, z: -20 });
  });

  it('threat standing on the feet still yields a direction', () => {
    expect(fleeDestination({ x: 0, z: 0 }, { x: 0, z: 0 }, 24)).toEqual({ x: 24, z: 0 });
  });
});

describe('runEmergency', () => {
  function stubBot(over: Partial<EmergencyBot> = {}): EmergencyBot & {
    fled: Array<{ x: number; z: number }>;
    eaten: string[];
    stopped: number;
  } {
    const bot: EmergencyBot & { fled: Array<{ x: number; z: number }>; eaten: string[]; stopped: number } = {
      health: 5,
      fled: [],
      eaten: [],
      stopped: 0,
      inventoryNames: () => ['bread', 'apple'],
      feet: () => ({ x: 0, y: 64, z: 0 }),
      threats: () => [{ id: 1, name: 'zombie', position: { x: 5, y: 64, z: 0 } }],
      stopAll: () => {
        bot.stopped++;
      },
      fleeTo: (x: number, z: number) => {
        bot.fled.push({ x, z });
      },
      eat: (food: string) => {
        bot.eaten.push(food);
        return Promise.resolve();
      },
      ...over,
    };
    return bot;
  }

  it('returns no-bot without a bot', async () => {
    expect(await runEmergency(null)).toEqual({ escaped: false, reason: 'no-bot' });
  });

  it('flees, eats once, and reports safe after quiet seconds', async () => {
    let t = 0;
    const bot = stubBot({
      threats: () => (t < 3000 ? [{ id: 1, name: 'zombie', position: { x: 5, y: 64, z: 0 } }] : []),
    });
    const res = await runEmergency(bot, {
      tickMs: 1000,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    });
    expect(res.escaped).toBe(true);
    expect(res.reason).toBe('safe');
    expect(bot.stopped).toBe(1);
    // 逃跑点在威胁反方向（x 为负）。
    expect(bot.fled.length).toBeGreaterThan(0);
    expect(bot.fled.every((f) => f.x < 0)).toBe(true);
    // 吃只吃一口，挑饱和高的面包。
    expect(bot.eaten).toEqual(['bread']);
    expect(res.health).toBe(5);
  });

  it('reports died when health hits zero mid-flight', async () => {
    const bot = stubBot({ health: 0 });
    const res = await runEmergency(bot, { tickMs: 1, sleep: () => Promise.resolve() });
    expect(res).toEqual({ escaped: false, reason: 'died' });
  });

  it('a mid-flight hit resets the quiet clock', async () => {
    let t = 0;
    let hp = 5;
    const bot = stubBot({ threats: () => [] });
    Object.defineProperty(bot, 'health', { get: () => hp });
    const res = await runEmergency(bot, {
      tickMs: 1000,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        if (t === 2000) hp = 4; // 第 2 秒挨一下，静默时钟从此刻重算。
        return Promise.resolve();
      },
    });
    expect(res.escaped).toBe(true);
    // 2000 受伤 + 10 秒静默 = 至少 12000。
    expect(t).toBeGreaterThanOrEqual(2000 + SAFE_SECONDS * 1000);
  });
});
