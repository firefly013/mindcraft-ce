/**
 * 反射与保命优先级 —— 真机 2026-10-18 15:56（overnight_a）的回归。
 *
 * 模型的原话：长途赶路时被骷髅/末影人围攻，血从 17.26 掉到 0.045，
 * 期间 consume / move / stay / goToCoordinates **全部**被拒
 * （`An action is already running. Stop() first, then retry.`），
 * 而快照同一时刻写着 `Meta: action idle`，speed 2.0-2.4 —— 身体正被反射拖着走。
 * 拾取反射反复超时（"退避 3 秒后再试（连续失败 1 次）"），每次都占着身体通道。
 *
 * 四条要求，一条一个用例组：
 *   1. 快照不许说谎：谁占着身体就报谁（autoPickup / escape，跑久了带已运行时长）；
 *   2. 连续 2 次超时就放弃，不再 3 秒一次无限重试；
 *   3. Stop 必须真的中断反射与拾取；
 *   4. 保命优先：拾取占着身体时，保命需求立刻抢占；敌人在附近就不重启拾取。
 */
import { describe, expect, it, vi } from 'vitest';
import { MineflayerBody, REFLEX_MAX_MS } from '../src/body/mineflayer_body.js';
import { activityFrom } from '../src/body/library/full_state.js';
import {
  PICKUP_GIVE_UP_ATTEMPTS,
  PICKUP_GIVE_UP_MS,
  PICKUP_SURVIVAL_SUPPRESS_MS,
  PICKUP_THREAT_RADIUS,
  PICKUP_TIMEOUT_MS,
  shouldAttemptPickup,
  shouldGiveUpPickup,
  nextPickupBackoffMs,
} from '../src/shared/auto_pickup.js';

const TARGET = { id: 7, name: 'Item', x: 1, y: 64, z: 0, distance: 1 };

/** 一个"骨架" body：类字段初始化器不会跑（Object.create），所以按需补最小字段。 */
function bareBody(overrides: Record<string, unknown> = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  // 反射/拾取相关的最小状态
  body.pickingUp = false;
  body.pickupAbortRequested = false;
  body.pickupBackoffUntil = 0;
  body.pickupFailures = 0;
  body.pickupCancel = null;
  body.pickupTargetName = null;
  body.pickupTargetId = null;
  body.pickupPreemptReason = null;
  body.pickupSuppressedUntil = 0;
  body.pickupThreatSkippedId = null;
  body.lastPickupAt = 0;
  body.reflexQueue = [];
  body.reflexRunning = false;
  body.reflexAbortRequested = false;
  body.currentReflexName = null;
  body.currentReflexStartedAt = 0;
  body.modelActionRequested = false;
  body.modelActionsInFlight = 0;
  body.actions = { executing: false, currentActionLabel: '', stop: vi.fn(async () => {}), releaseCurrentAction: vi.fn() };
  body.bot = {
    interrupt_code: false,
    output: '',
    entity: { position: { x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 64, z: 0 }) } },
    entities: {},
    pathfinder: { stop: vi.fn() },
    clearControlStates: vi.fn(),
    stopDigging: vi.fn(),
  };
  Object.assign(body, overrides);
  return body;
}

describe('① 快照不许说谎：谁占着身体就报谁', () => {
  it('模型动作 > autoPickup > 保命反射，按实际占用报', () => {
    const body = bareBody();
    expect(body.currentActionName()).toBeNull(); // 什么都没跑：这时才该是 idle

    body.pickingUp = true;
    expect(body.currentActionName()).toBe('autoPickup');

    body.currentReflexName = 'escape';
    body.currentReflexStartedAt = Date.now();
    expect(body.currentActionName()).toBe('escape');

    body.actions.currentActionLabel = 'goToCoordinates';
    expect(body.currentActionName()).toBe('goToCoordinates');
  });

  it('反射跑久了把"已 N 秒"一起报出来（真机那次 escape 跑了 419 秒）', () => {
    const body = bareBody();
    body.currentReflexName = 'escape';
    body.currentReflexStartedAt = Date.now() - 419_000;
    expect(body.currentActionName()).toBe('escape（已 419s）');
    expect(body.reflexStatus()).toMatchObject({ reflex: 'escape' });
    expect(body.reflexStatus()?.ms).toBeGreaterThan(400_000);
  });

  it('**speed > 0 而 Meta 说 idle 的矛盾不再可能出现**：反射占身体时 currentAction 非空', () => {
    const body = bareBody();
    body.currentReflexName = 'escape';
    body.currentReflexStartedAt = Date.now() - 1000;
    // 这正是 live_state 渲染 `action ${meta.currentAction ?? 'idle'}` 的输入。
    expect(body.sampleContext().currentAction).toBe('escape');
    expect(body.reflexStatus()).not.toBeNull();
  });

  it('fullState 的 activity 同一口径：反射在跑就不是 Idle', () => {
    // 反射在跑（isIdle() 仍是 true——它只代表"模型动作没占通道"）。
    expect(activityFrom('escape', true, '')).toEqual({ current: 'escape', kind: 'acting' });
    expect(activityFrom('autoPickup', true, '')).toEqual({ current: 'autoPickup', kind: 'acting' });
    // 模型动作在跑：报它自己的标签。
    expect(activityFrom('goToCoordinates', false, 'goToCoordinates')).toEqual({
      current: 'goToCoordinates',
      kind: 'acting',
    });
    // 真的什么都没跑：这才是 Idle。
    expect(activityFrom(null, true, '')).toEqual({ current: 'Idle', kind: 'idle' });
  });
});

describe('② 连续失败就放弃（不再 3 秒一次无限重试）', () => {
  it('纯判据：2 次封顶，1 次还允许再试', () => {
    expect(PICKUP_GIVE_UP_ATTEMPTS).toBe(2);
    expect(shouldGiveUpPickup(0)).toBe(false);
    expect(shouldGiveUpPickup(1)).toBe(false);
    expect(shouldGiveUpPickup(2)).toBe(true);
    expect(shouldGiveUpPickup(99)).toBe(true);
  });

  it('第一次超时：退避 3 秒、回执说"退避…再试"', async () => {
    const events: any[] = [];
    const body = bareBody({
      lastPickupAt: -Infinity,
      walkToPickup: async (): Promise<boolean> => false,
      notify: (type: string, _kind: unknown, _level: unknown, payload: unknown) => events.push({ type, payload }),
    });
    body.schedulePickup(TARGET);
    await new Promise((r) => setTimeout(r, 0));
    const done = events.find((e) => e.type === 'reflex.done' && e.payload.reflex === 'pickup');
    expect(done.payload.outcome).toBe('failed');
    expect(done.payload.detail).toContain('退避');
    expect(done.payload.backoffMs).toBe(nextPickupBackoffMs(1));
    expect(body.pickupFailures).toBe(1);
  });

  it('第二次超时：**放弃**并进入静默期，不再承诺"再试"', async () => {
    const events: any[] = [];
    const body = bareBody({
      lastPickupAt: -Infinity,
      walkToPickup: async (): Promise<boolean> => false,
      notify: (type: string, _kind: unknown, _level: unknown, payload: unknown) => events.push({ type, payload }),
    });
    // 第一次
    body.schedulePickup(TARGET);
    await new Promise((r) => setTimeout(r, 0));
    // 绕过退避来模拟"第三次边沿又来了"（真机上就是每 3 秒一次的重试）
    body.pickupBackoffUntil = 0;
    body.lastPickupAt = -Infinity;
    body.schedulePickup(TARGET);
    await new Promise((r) => setTimeout(r, 0));

    const last = events.filter((e) => e.type === 'reflex.done' && e.payload.reflex === 'pickup').pop();
    expect(last.payload.gaveUp).toBe(true);
    expect(last.payload.backoffMs).toBe(PICKUP_GIVE_UP_MS);
    expect(last.payload.detail).toContain('放弃这次拾取');
    // 静默期内**不再启动**拾取：这才是"不锁通道"的关键。
    expect(body.pickupSuppressedUntil).toBeGreaterThan(Date.now());
    body.lastPickupAt = -Infinity;
    body.pickupBackoffUntil = 0;
    body.schedulePickup(TARGET);
    expect(body.pickingUp).toBe(false);
  });
});

describe('③ Stop 必须真的中断反射与拾取', () => {
  it('Stop：清反射队列 + 给正在跑的反射打中断 + 拾取收手 + 静默', async () => {
    const cancel = vi.fn();
    const requestInterrupt = vi.fn();
    const body = bareBody({
      pickingUp: true,
      pickupCancel: cancel,
      reflexRunning: true,
      currentReflexName: 'escape',
      currentReflexStartedAt: Date.now(),
      reflexQueue: [{ reflex: 'escape', intent: 'flee' }],
      requestInterrupt,
      notify: vi.fn(),
      actions: {
        executing: true,
        currentActionLabel: 'goToCoordinates',
        stop: vi.fn(async () => {}),
        releaseCurrentAction: vi.fn(),
      },
    });
    const res = await body.handle({ op: 'stop' });
    expect(res).toMatchObject({ ok: true, op: 'stop' });
    expect(cancel).toHaveBeenCalledTimes(1);          // 拾取立刻收手
    expect(body.pickupAbortRequested).toBe(true);
    expect(body.reflexQueue).toHaveLength(0);         // 队列清空
    expect(body.reflexAbortRequested).toBe(true);     // 正在跑的反射收到中断
    expect(requestInterrupt).toHaveBeenCalled();
    expect(body.pickupSuppressedUntil).toBeGreaterThan(Date.now());
    expect(body.modelActionRequested).toBe(false);
    expect(body.actions.releaseCurrentAction).toHaveBeenCalled();
  });
});

describe('④ 保命优先：抢占拾取，且敌人附近不重启拾取', () => {
  it('纯判据：保命反射在跑 / 敌人在附近 → 不启动拾取', () => {
    const base = { busy: false, pickingUp: false, sinceLastAttemptMs: 99999 };
    expect(shouldAttemptPickup(base)).toBe(true);
    expect(shouldAttemptPickup({ ...base, reflexBusy: true })).toBe(false);
    expect(shouldAttemptPickup({ ...base, threatNear: true })).toBe(false);
  });

  it('敌人在威胁半径内：不启动拾取，并如实记一条 skipped 回执', () => {
    const events: any[] = [];
    const body = bareBody({
      lastPickupAt: -Infinity,
      notify: (type: string, _kind: unknown, _level: unknown, payload: unknown) => events.push({ type, payload }),
    });
    // 一只 5 格外的僵尸
    body.bot.entities = {
      5: { id: 5, name: 'zombie', type: 'hostile', position: { x: 5, y: 64, z: 0 }, metadata: [] },
    };
    body.schedulePickup(TARGET);
    expect(body.pickingUp).toBe(false);
    const skip = events.find((e) => e.type === 'reflex.done' && e.payload.outcome === 'skipped');
    expect(skip).toBeDefined();
    expect(skip.payload.detail).toContain('先保命');
    expect(PICKUP_THREAT_RADIUS).toBeGreaterThan(5);
  });

  it('保命事件立刻把拾取从身体上摘下来（并给一段静默期）', async () => {
    const cancel = vi.fn();
    const drain = vi.fn(async () => {});
    const body = bareBody({
      pickingUp: true,
      pickupCancel: cancel,
      drainReflexes: drain,
      notify: vi.fn(),
      log: { with: () => ({ info: () => {}, error: () => {} }) },
      rescue: vi.fn(async () => ({ escaped: true, reason: 'ok' })),
    });
    body.emergency('bot.attacked', { health: 8, by: 'skeleton' }, 'escape', 'flee');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.pickupPreemptReason).toContain('保命优先');
    expect(body.pickupSuppressedUntil).toBeGreaterThan(Date.now() + PICKUP_SURVIVAL_SUPPRESS_MS - 5_000);
    expect(body.reflexQueue).toHaveLength(1);
    expect(body.reflexQueue[0].reflex).toBe('escape');
    // 急停标记不能把**新的**保命需求挡掉。
    expect(body.reflexAbortRequested).toBe(false);
  });

  it('保命反射跑着的时候，拾取不许插进来抢身体', () => {
    const body = bareBody({ lastPickupAt: -Infinity, reflexRunning: true, currentReflexName: 'escape' });
    body.schedulePickup(TARGET);
    expect(body.pickingUp).toBe(false);
  });

  it('拾取超时时间没被顺手改小（真机 8 格要走 12 秒）', () => {
    expect(PICKUP_TIMEOUT_MS).toBe(12_000);
  });

  it('保命处理也有上限：跑满就中断并**交还身体**，不是无限占着（真机那次 escape 419 秒）', async () => {
    vi.useFakeTimers();
    try {
      const events: any[] = [];
      const requestInterrupt = vi.fn();
      const body = bareBody({
        reflexQueue: [{ reflex: 'escape', intent: 'flee' }],
        // 永不作答的保命处理：模拟"跑了 419 秒还没脱险"
        rescue: () => new Promise(() => {}),
        requestInterrupt,
        notify: (type: string, _kind: unknown, _level: unknown, payload: unknown) => events.push({ type, payload }),
      });
      const pending = body.drainReflexes();
      await vi.advanceTimersByTimeAsync(REFLEX_MAX_MS + 100);
      await pending;
      const done = events.find((e) => e.type === 'reflex.done' && e.payload.reflex === 'escape');
      expect(done.payload.outcome).toBe('aborted');
      expect(done.payload.detail).toContain('交还身体');
      expect(requestInterrupt).toHaveBeenCalled();
      // 交还之后身体是空的：模型可以发动作了（currentActionName 不再是 escape）。
      expect(body.currentActionName()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
