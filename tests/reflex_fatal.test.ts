/**
 * 验证者反证的两条修复的回归（tmp/verify/emergency_lock.probe.test.ts 的同构测试）。
 *
 * ① `consume` 曾经能穿透紧急锁、并在身体侧打断正在救命的 `surface` 反射 +
 *    静音 25 秒——哪怕这口饭根本没吃成。
 * ② 25 秒保命冷却**不看危险种类**：溺水/岩浆/虚空/致命坠落都被一起静音，而且
 *    这些早退路径连事件都不推给大脑；岩浆/虚空/坠落还是 `kind:'flag'` 的
 *    一次性边沿，丢一次就永久没有接管路径；同名去重还把 `escape/lava` 吞给
 *    `escape/flee`。
 *
 * 这里钉的是"修完之后必须一直成立"的性质。
 */
import { describe, expect, it, vi } from 'vitest';

const toolState = vi.hoisted(() => ({ text: 'ok', throws: false }));

vi.mock('../src/body/commands/execute.js', () => ({
  executeToolCall: async (): Promise<string> => {
    if (toolState.throws) throw new Error('测试：执行器故意抛错');
    return toolState.text;
  },
}));

import {
  FATAL_DANGER_PREFIXES,
  FATAL_DANGER_TYPES,
  isFatalDanger,
  l5DangerClass,
  MineflayerBody,
  NON_FATAL_L5_TYPES,
  SURVIVAL_COOLDOWN_MS,
  toolResultLooksFailed,
} from '../src/body/mineflayer_body.js';
import { DETECTORS } from '../src/body/edges.js';

function bareBody(overrides: Record<string, unknown> = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  Object.assign(body, {
    pickingUp: false,
    pickupAbortRequested: false,
    pickupBackoffUntil: 0,
    pickupFailures: 0,
    pickupCancel: null,
    pickupTargetName: null,
    pickupTargetId: null,
    pickupPreemptReason: null,
    pickupSuppressedUntil: 0,
    pickupThreatSkippedId: null,
    lastPickupAt: 0,
    reflexQueue: [],
    reflexRunning: false,
    reflexAbortRequested: false,
    currentReflexName: null,
    currentReflexIntent: null,
    currentReflexStartedAt: 0,
    reflexCompletionSent: false,
    survivalBusySince: null,
    survivalLastReflexAt: 0,
    survivalCooldownUntil: 0,
    survivalYieldNotifiedAt: 0,
    modelActionRequested: false,
    modelActionsInFlight: 0,
    actions: {
      executing: false,
      currentActionLabel: '',
      stop: vi.fn(async () => {}),
      releaseCurrentAction: vi.fn(),
    },
    log: { with: () => ({ info: () => {}, error: () => {} }) },
    bot: {
      interrupt_code: false,
      output: '',
      entity: { position: { x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 64, z: 0 }) } },
      entities: {},
      pathfinder: { stop: vi.fn() },
      clearControlStates: vi.fn(),
      stopDigging: vi.fn(),
    },
  });
  Object.assign(body, overrides);
  return body;
}

function withEvents(overrides: Record<string, unknown> = {}): { body: any; events: any[] } {
  const events: any[] = [];
  const body = bareBody({
    notify: (type: string, _k: unknown, _l: unknown, payload: unknown) => events.push({ type, payload }),
    drainReflexes: vi.fn(async () => {}),
    ...overrides,
  });
  return { body, events };
}

describe('② 致命危险不吃保命冷却（25 秒足够死一次）', () => {
  it('冷却期内的溺水 L5 仍会接管，并把事件推给大脑', () => {
    const { body, events } = withEvents({ survivalCooldownUntil: Date.now() + SURVIVAL_COOLDOWN_MS });
    body.emergency('world.water.drowning', { oxygen: 2 }, 'surface', 'surface');
    expect(body.reflexQueue).toHaveLength(1);
    expect(body.reflexQueue[0]).toMatchObject({ reflex: 'surface', intent: 'surface' });
    expect(events.some((e) => e.type === 'world.water.drowning')).toBe(true);
  });

  it('冷却期内的岩浆 L5 仍会接管（一次性边沿不能丢）', () => {
    const { body, events } = withEvents({ survivalCooldownUntil: Date.now() + SURVIVAL_COOLDOWN_MS });
    body.emergency('world.lava.contact', { inLava: true }, 'escape', 'lava');
    expect(body.reflexQueue).toHaveLength(1);
    expect(body.reflexQueue[0]).toMatchObject({ intent: 'lava' });
    expect(events.some((e) => e.type === 'world.lava.contact')).toBe(true);
  });

  it('冷却期内的虚空/致命坠落同样接管', () => {
    for (const [type, payload] of [
      ['world.void.falling', { y: -70 }],
      ['world.fall.lethal', { drop: 30 }],
    ] as const) {
      const { body, events } = withEvents({ survivalCooldownUntil: Date.now() + SURVIVAL_COOLDOWN_MS });
      body.emergency(type, payload, 'escape', 'flee');
      expect(body.reflexQueue, `${type} 被冷却吞了`).toHaveLength(1);
      expect(events.some((e) => e.type === type), `${type} 事件没推给大脑`).toBe(true);
    }
  });

  it('非致命危险（被怪打）在冷却期仍然让位（这层逻辑没被顺手拆掉）', () => {
    const { body, events } = withEvents({ survivalCooldownUntil: Date.now() + SURVIVAL_COOLDOWN_MS });
    body.emergency('bot.attacked', { health: 12 }, 'escape', 'flee');
    expect(body.reflexQueue).toHaveLength(0);
    expect(body.survivalCooldownUntil).toBeGreaterThan(0);
    // 但至少要**告诉**大脑这次遇到了什么（以前连推都不推）。
    expect(events.some((e) => e.type === 'bot.attacked')).toBe(true);
  });
});

describe('③④ 去重键是 reflex + intent，不是只认名字', () => {
  it('flee 意图的 escape 不会吞掉 lava 意图的 escape', () => {
    const { body, events } = withEvents({
      reflexRunning: true,
      currentReflexName: 'escape',
      currentReflexIntent: 'flee',
      currentReflexStartedAt: Date.now() - 1_000,
    });
    body.emergency('world.lava.contact', { inLava: true }, 'escape', 'lava');
    expect(events.some((e) => e.type === 'world.lava.contact')).toBe(true);
    expect(body.reflexQueue.some((q: any) => q.intent === 'lava')).toBe(true);
  });

  it('同 reflex + 同 intent 仍然去重（abort 循环的解药没丢）', () => {
    const { body, events } = withEvents({
      reflexRunning: true,
      currentReflexName: 'surface',
      currentReflexIntent: 'surface',
      currentReflexStartedAt: Date.now() - 5_000,
    });
    body.emergency('world.water.drowning', { oxygen: 2 }, 'surface', 'surface');
    expect(body.reflexQueue).toHaveLength(0);                    // 不重复排队
    expect(body.bot.clearControlStates).not.toHaveBeenCalled();  // 也不急停它
    expect(events.some((e) => e.payload?.outcome === 'in_progress')).toBe(true);
  });
});

describe('① consume 不再能拿掉保命（哪怕它自己失败也一样）', () => {
  it('surface 在跑时调 consume：不打断反射、不给 25 秒静音窗口', async () => {
    toolState.throws = true;
    const { body } = withEvents({
      reflexRunning: true,
      currentReflexName: 'surface',
      currentReflexIntent: 'surface',
      currentReflexStartedAt: Date.now() - 3_000,
      reflexQueue: [{ reflex: 'surface', intent: 'surface' }],
    });
    const res = await body.handle({ op: 'action', request: { name: 'consume', args: {} } });
    expect(res.ok).toBe(true);
    expect(body.reflexAbortRequested, 'consume 把正在跑的溺水反射打断了').toBe(false);
    expect(body.survivalCooldownUntil, 'consume 拿到了 25 秒"保命不介入"窗口').toBe(0);
    toolState.throws = false;
  });
});

describe('① 模型自救（escapeWater）：失败不静音，成功才给窗口', () => {
  it('escapeWater 失败 → 反射让位但**不给**冷却（下一条 L5 立刻重新接管）', async () => {
    toolState.throws = true;
    const { body, events } = withEvents({
      reflexRunning: true,
      currentReflexName: 'surface',
      currentReflexIntent: 'surface',
      currentReflexStartedAt: Date.now() - 2_000,
    });
    await body.handle({ op: 'action', request: { name: 'escapeWater', args: {} } });
    expect(body.survivalCooldownUntil).toBe(0);
    expect(body.reflexAbortRequested).toBe(true);   // 让位仍然发生（否则两边抢身体）
    const note = events.filter((e) => e.payload?.outcome === 'preempted').pop();
    expect(String(note.payload.detail)).toContain('没成功');
    toolState.throws = false;
  });

  it('escapeWater 成功 → 给 25 秒窗口（模型真的在自救）', async () => {
    toolState.text = 'escapeWater：已经上岸。';
    const { body, events } = withEvents({
      reflexRunning: true,
      currentReflexName: 'surface',
      currentReflexIntent: 'surface',
      currentReflexStartedAt: Date.now() - 2_000,
    });
    await body.handle({ op: 'action', request: { name: 'escapeWater', args: {} } });
    expect(body.survivalCooldownUntil).toBeGreaterThan(Date.now() + SURVIVAL_COOLDOWN_MS - 5_000);
    const note = events.filter((e) => e.payload?.outcome === 'preempted').pop();
    expect(String(note.payload.detail)).toContain('不会抢回去');
    toolState.text = 'ok';
  });
});

describe('③ 被吞的 flag 边沿：窗口结束后补一枪（pendingDanger）', () => {
  it('记下 pending 之后，到期会重新触发一次 emergency', () => {
    vi.useFakeTimers();
    try {
      const { body } = withEvents({});
      const emergencySpy = vi.spyOn(body, 'emergency');
      const dueAt = Date.now() + 1_000;
      body.recordPendingDanger('world.lava.contact', { inLava: true }, 'escape', 'lava', dueAt);
      vi.advanceTimersByTime(500);
      expect(emergencySpy).not.toHaveBeenCalled();          // 还没到点
      vi.advanceTimersByTime(700);
      expect(emergencySpy).toHaveBeenCalledTimes(1);        // 补上了
      expect(emergencySpy.mock.calls[0]).toMatchObject(['world.lava.contact', { inLava: true }, 'escape', 'lava']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('非 flag 边沿不排补枪（kind:all 下一条就会再来，不重复推）', () => {
    vi.useFakeTimers();
    try {
      const { body } = withEvents({});
      const emergencySpy = vi.spyOn(body, 'emergency');
      body.recordPendingDanger('bot.attacked', { health: 12 }, 'escape', 'flee', Date.now() + 100);
      vi.advanceTimersByTime(300);
      expect(emergencySpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('接管的致命危险会清掉 pending（不会在安全之后再补一枪）', () => {
    const { body } = withEvents({});
    (body as any).pendingDanger = { type: 'world.lava.contact', payload: {}, reflex: 'escape', intent: 'lava', dueAt: Date.now() + 10_000 };
    body.emergency('world.lava.contact', { inLava: true }, 'escape', 'lava');
    expect((body as any).pendingDanger).toBeNull();
  });
});

describe('致命清单必须完整（防"规则只在一个方向成立"）', () => {
  const level5 = DETECTORS.filter((detector) => detector.level === 5);

  it('每一个 L5 危险都必须**显式分类**：要么致命，要么在 NON_FATAL_L5_TYPES 里写明理由', () => {
    const unclassified = level5
      .map((detector) => detector.type)
      .filter((type) => l5DangerClass(type) === 'unclassified');
    expect(
      unclassified,
      '新增了 L5 危险但没分类：致命就加进 FATAL_DANGER_TYPES/FATAL_DANGER_PREFIXES，' +
        '非致命就加进 NON_FATAL_L5_TYPES 并写清为什么。',
    ).toEqual([]);
  });

  it('守卫本身是可信的：一个假想的"新 L5"会被判成 unclassified（不是永远绿）', () => {
    expect(l5DangerClass('world.future.new_fatal_thing')).toBe('unclassified');
    expect(l5DangerClass('world.water.drowning')).toBe('fatal');
    expect(l5DangerClass('world.creeper.swelling')).toBe('non-fatal');
  });

  it('**一次性边沿（kind:flag）的 L5 必须全部是致命的**（被吞一次就再没有机会）', () => {
    const flagL5 = level5.filter((detector) => detector.kind === 'flag').map((detector) => detector.type);
    expect(flagL5.length).toBeGreaterThan(0); // 前提：项目里确实有 flag 边沿
    const notFatal = flagL5.filter((type) => !isFatalDanger(type));
    expect(notFatal, '一次性边沿不是致命危险：被冷却吞掉就永久失去接管路径').toEqual([]);
  });

  it('NON_FATAL_L5_TYPES 里没有过期条目（写着的必须真的还是 L5）', () => {
    const live = new Set(level5.map((detector) => detector.type));
    for (const type of NON_FATAL_L5_TYPES) {
      expect(live.has(type), `${type} 已经不是 L5 了，从名单里删掉`).toBe(true);
    }
  });

  it('致命清单就是那四类（岩浆前缀 + 溺水/虚空/坠落）——改它必须先改这条测试', () => {
    expect([...FATAL_DANGER_PREFIXES]).toEqual(['world.lava.']);
    expect([...FATAL_DANGER_TYPES].sort()).toEqual([
      'world.fall.lethal',
      'world.void.falling',
      'world.water.drowning',
    ]);
    for (const type of ['world.lava.contact', 'world.lava.about_to_enter']) {
      expect(isFatalDanger(type), `${type} 应该致命`).toBe(true);
    }
    for (const type of NON_FATAL_L5_TYPES) {
      expect(isFatalDanger(type), `${type} 不该致命`).toBe(false);
    }
  });
});

describe('toolResultLooksFailed：判失败偏保守', () => {
  it('识别执行器的失败回执，但不把正常回执当失败', () => {
    expect(toolResultLooksFailed('Tool escapeWater failed: boom')).toBe(true);
    expect(toolResultLooksFailed('Unknown tool: escapeWater.')).toBe(true);
    expect(toolResultLooksFailed('escapeWater：已经上岸。')).toBe(false);
    expect(toolResultLooksFailed('')).toBe(false);
    expect(toolResultLooksFailed(undefined)).toBe(false);
  });
});
