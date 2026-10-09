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

  it('溺水时上浮：swimUp 被调用（这一支以前压根不存在）', async () => {
    let t = 0;
    let submerged = true;
    const swamUp: number[] = [];
    const bot = stubBot({
      threats: () => [],
      submerged: () => submerged,
      swimUp: () => {
        swamUp.push(t);
        submerged = false; // 一浮就露出水面
      },
    });
    const res = await runEmergency(bot, {
      tickMs: 100,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    });
    expect(swamUp.length).toBeGreaterThan(0);
    expect(res.escaped).toBe(true);
  });

  it('溺水优先于逃跑：还在水里就一本正经地跑，等于白跑', async () => {
    let t = 0;
    let health = 5;
    // 头顶被封死，浮不出去 → 一路掉血到 0。
    const bot = stubBot({
      threats: () => [{ id: 1, name: 'zombie', position: { x: 5, y: 64, z: 0 } }],
      submerged: () => true,
      swimUp: () => {},
    });
    // 每 tick 掉一点血，几轮就到底。
    Object.defineProperty(bot, 'health', { get: () => health });
    const res = await runEmergency(bot, {
      tickMs: 100,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        health = Math.max(0, health - 1);
        return Promise.resolve();
      },
    });
    expect(res.reason).toBe('died');
    // 整个溺水期间一次都没逃跑、也没吃东西——这两件在溺水面前都是纯浪费。
    expect(bot.fled).toEqual([]);
    expect(bot.eaten).toEqual([]);
  });

  it('浮出水面后恢复正常流程（威胁还在就接着逃）', async () => {
    let t = 0;
    let submerged = true;
    const bot = stubBot({
      threats: () => (t < 1000 ? [{ id: 1, name: 'zombie', position: { x: 5, y: 64, z: 0 } }] : []),
      submerged: () => submerged,
      swimUp: () => {
        submerged = false;
      },
    });
    const res = await runEmergency(bot, {
      tickMs: 100,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    });
    // 头一露出水面，下一轮就该回头处理威胁了。
    expect(bot.fled.length).toBeGreaterThan(0);
    expect(res.escaped).toBe(true);
  });

  it('保命被关掉后：溺水也不上浮（模型签了生死状，字面意思）', async () => {
    let t = 0;
    let health = 5;
    const swamUp: number[] = [];
    const bot = stubBot({
      threats: () => [],
      submerged: () => true,
      safeguardsOff: () => true,
      swimUp: () => {
        swamUp.push(t);
      },
    });
    Object.defineProperty(bot, 'health', { get: () => health });
    await runEmergency(bot, {
      tickMs: 100,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        health = Math.max(0, health - 1);
        return Promise.resolve();
      },
    });
    // 一次都没上浮 —— 关掉的就是这条反射。
    expect(swamUp).toEqual([]);
  });

  it('关掉保命只关上浮，fleeTo / 吃东西照旧（关的是反射，不是整个 emergency）', async () => {
    let t = 0;
    let submerged = true;
    const bot = stubBot({
      threats: () => (t < 1000 ? [{ id: 1, name: 'zombie', position: { x: 5, y: 64, z: 0 } }] : []),
      submerged: () => submerged,
      safeguardsOff: () => true,
      swimUp: () => {},
    });
    await runEmergency(bot, {
      tickMs: 100,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        submerged = false; // 下一轮就浮出去了，这里只验证"关保命时别上浮"
        return Promise.resolve();
      },
    });
    expect(bot.fled.length).toBeGreaterThan(0);
  });

  it('bot 没实现 submerged / swimUp 时当没溺水，不炸', async () => {
    let t = 0;
    const bot = stubBot({ threats: () => (t < 1000 ? [{ id: 1, name: 'zombie', position: { x: 5, y: 64, z: 0 } }] : []) });
    const res = await runEmergency(bot, {
      tickMs: 1000,
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    });
    expect(res.escaped).toBe(true);
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
