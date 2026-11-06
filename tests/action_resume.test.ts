/**
 * 续做（resume）：反射抢走身体后，把模型原来那条指令**机械**接上。
 *
 * 用户 2026-10-31 定的边界：
 *   - 引擎只做机械延续，不判断"该不该继续"（决策权在模型）；
 *   - 不设次数上限——被打断几次就续几次，不因为次数多就推回模型；
 *   - 自动续做只是把状态恢复到被打断前，模型要改主意照常 Stop。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Submission } from '@earendil-works/pi-durable';
import { ActionRunner, type ResumeNotice } from '../src/brain/action_runner.js';
import { EventIntake, type GameEvent } from '../src/brain/runtime/events.js';
import { Scheduler } from '../src/brain/scheduler.js';
import { createToolCatalog } from '../src/brain/tools/catalog.js';
import type { ToolOutcome } from '../src/brain/tools/tools.js';
import { resumePolicyOf, toolDeclarations } from '../src/body/commands/registry.js';
import { LEVEL } from '../src/shared/events.js';
import type { Kind } from '../src/shared/events.js';
import { parseTunnelDirection, resumeItemForBlock } from '../src/shared/resume.js';

const CATALOG = createToolCatalog(toolDeclarations());
const agentSource = readFileSync(resolve(process.cwd(), 'src/brain/agent.ts'), 'utf8');

interface Call {
  name: string;
  args: Record<string, unknown>;
  resolve: (value: string) => void;
}

function makeHarness(
  counts?: () => Record<string, number> | null,
  position?: () => { x: number; y: number; z: number } | null,
) {
  const scheduler = new Scheduler();
  const calls: Call[] = [];
  const notices: Array<{ call: string; result: ToolOutcome }> = [];
  const resumeNotices: ResumeNotice[] = [];
  const runner = new ActionRunner({
    scheduler,
    catalog: CATALOG,
    record: () => Promise.resolve(),
    speak: () => {},
    execute: (name: string, args: Record<string, unknown>) =>
      new Promise<string>((resolveCall) => {
        calls.push({ name, args, resolve: resolveCall });
      }),
    notify: (payload) => {
      notices.push(payload);
    },
    inventoryCounts: counts ?? (() => ({})),
    // 位置类 checkpoint（digDown/mineTunnel…）的坐标来源；默认站在 (0,64,0)。
    bodyPosition: (): Promise<{ x: number; y: number; z: number } | null> =>
      Promise.resolve(position == null ? { x: 0, y: 64, z: 0 } : position()),
    resumeNotice: (payload) => {
      resumeNotices.push(payload);
    },
  });
  return { runner, scheduler, calls, notices, resumeNotices };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 认领一次动作并让它处于"正在跑"。 */
async function start(h: ReturnType<typeof makeHarness>, name: string, args: Record<string, unknown>): Promise<void> {
  const outcome = await h.runner.run(name, args);
  expect(outcome.status).toBe('accepted');
  expect(h.calls).toHaveLength(1);
}

/** 模拟反射抢身体：作废 → 身体返回空（被中断）→ 等收尾跑完。 */
async function interrupt(h: ReturnType<typeof makeHarness>): Promise<void> {
  const interrupted = h.scheduler.beginEmergency();
  h.runner.captureInterruption(interrupted);
  h.calls[h.calls.length - 1].resolve('');
  await flush();
}

describe('声明表：哪些动作可以续做', () => {
  const byName = new Map(toolDeclarations().map((d) => [d.name, d]));

  it('auto：工具自己会重新找目标/重新算路', () => {
    expect(byName.get('travelTo')?.resume).toBe('auto');
    expect(byName.get('goToCoordinates')?.resume).toBe('auto');
    expect(byName.get('goToPlayer')?.resume).toBe('auto');
    expect(byName.get('exploreFor')?.resume).toBe('auto');
  });

  it('checkpoint：需要按进度折算参数', () => {
    expect(byName.get('collectBlocks')?.resume).toBe('checkpoint');
    // 距离型动作同样按"原始终点"续做（位置从身体读）。
    expect(byName.get('digDown')?.resume).toBe('checkpoint');
    expect(byName.get('stairUp')?.resume).toBe('checkpoint');
    expect(byName.get('pillarUp')?.resume).toBe('checkpoint');
    expect(byName.get('mineTunnel')?.resume).toBe('checkpoint');
  });

  it('没声明的动作一律 manual（fail-safe）', () => {
    expect(byName.get('jump')?.resume).toBeUndefined();
    expect(resumePolicyOf('jump')).toBe('manual');
    expect(resumePolicyOf('craft')).toBe('manual');
    expect(resumePolicyOf('!travelTo')).toBe('auto');
  });

  it('掉落物换算：挖 stone 得 cobblestone，挖铁矿石得 raw_iron', () => {
    expect(resumeItemForBlock('stone')).toBe('cobblestone');
    expect(resumeItemForBlock('iron_ore')).toBe('raw_iron');
    expect(resumeItemForBlock('deepslate_diamond_ore')).toBe('diamond');
    expect(resumeItemForBlock('oak_log')).toBe('oak_log');
    expect(resumeItemForBlock('minecraft:oak_log')).toBe('oak_log');
  });
});

describe('Scheduler：交还被作废的那次调用', () => {
  it('beginEmergency 返回被作废的动作；重复加锁返回 null', () => {
    const s = new Scheduler();
    expect(s.startAction('travelTo', { x: 1, y: 64, z: 2 }).accepted).toBe(true);
    const interrupted = s.beginEmergency();
    expect(interrupted).toMatchObject({ id: 'travelTo', args: { x: 1, y: 64, z: 2 } });
    expect(s.beginEmergency()).toBeNull();
    s.endEmergency();
  });

  it('没有在跑的动作时返回 null', () => {
    const s = new Scheduler();
    expect(s.beginEmergency()).toBeNull();
  });
});

describe('auto：原样重发', () => {
  it('travelTo 被打断 → 反射结束后用同一组参数续做，并写一条 action.resumed', async () => {
    const h = makeHarness();
    await start(h, 'travelTo', { x: 10, y: 64, z: -5 });
    await interrupt(h);

    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].name).toBe('travelTo');
    expect(h.calls[1].args).toEqual({ x: 10, y: 64, z: -5 });
    expect(h.scheduler.currentAction()?.id).toBe('travelTo');
    const notice = h.resumeNotices.find((n) => n.resumed);
    expect(notice).toBeTruthy();
    expect(notice?.detail).toContain('已经替你接着做 travelTo');
    expect(notice?.call_id).toMatch(/^travelTo#/);
  });

  it('被打断两次就续做两次（不设次数上限）', async () => {
    const h = makeHarness();
    await start(h, 'travelTo', { x: 1, y: 64, z: 1 });
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(2);

    // 第二次被打断
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(3);
  });
});

describe('checkpoint：按进度折算参数', () => {
  it('collectBlocks 已砍 3/8 → 续做 num=5', async () => {
    let counts: Record<string, number> = { oak_log: 2 };
    const h = makeHarness(() => counts);
    await start(h, 'collectBlocks', { type: 'oak_log', num: 8 });

    counts = { oak_log: 5 }; // 战斗中又砍了 3 个
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();

    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].args).toEqual({ type: 'oak_log', num: 5 });
    expect(h.resumeNotices.find((n) => n.resumed)?.detail).toContain('num');
  });

  it('目标已经完成（8/8）→ 不再续做，只写一条事实', async () => {
    let counts: Record<string, number> = { oak_log: 0 };
    const h = makeHarness(() => counts);
    await start(h, 'collectBlocks', { type: 'oak_log', num: 8 });

    counts = { oak_log: 8 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();

    expect(h.calls).toHaveLength(1);
    const notice = h.resumeNotices.find((n) => !n.resumed);
    expect(notice?.detail).toContain('目标已经完成');
    expect(notice?.detail).toContain('已经收集了 8 个');
    expect(notice?.detail).toContain('目标是 8 个');
  });

  it('进度读不到（背包还没同步）→ 不猜，不续做', async () => {
    const h = makeHarness(() => null);
    await start(h, 'collectBlocks', { type: 'oak_log', num: 8 });
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();

    expect(h.calls).toHaveLength(1);
    expect(h.resumeNotices.find((n) => !n.resumed)?.detail).toContain('collectBlocks 被打断了，读不到当前进度，所以没有接着做。');
  });

  it('掉落物换算：挖 stone 的进度按 cobblestone 数', async () => {
    let counts: Record<string, number> = { cobblestone: 0 };
    const h = makeHarness(() => counts);
    await start(h, 'collectBlocks', { type: 'stone', num: 10 });
    counts = { cobblestone: 4 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls[1].args).toEqual({ type: 'stone', num: 6 });
  });
});

describe('checkpoint：距离型动作按"原始终点"续做', () => {
  it('digDown 已挖 6/10 → 续做 distance=4', async () => {
    let pos = { x: 0, y: 64, z: 0 };
    const h = makeHarness(undefined, () => pos);
    await start(h, 'digDown', { distance: 10, force: false });
    pos = { x: 0, y: 58, z: 0 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].args).toEqual({ distance: 4, force: false });
  });

  it('digDown 已经到达目标深度 → 不续做', async () => {
    let pos = { x: 0, y: 64, z: 0 };
    const h = makeHarness(undefined, () => pos);
    await start(h, 'digDown', { distance: 10, force: false });
    pos = { x: 0, y: 54.2, z: 0 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(1);
    expect(h.resumeNotices.find((n) => !n.resumed)?.detail).toContain('目标深度');
  });

  it('digDown 被逼回上面 4 格 → 续做的是"到原始终点"，不是"再挖 10 格"', async () => {
    let pos = { x: 0, y: 64, z: 0 };
    const h = makeHarness(undefined, () => pos);
    await start(h, 'digDown', { distance: 10, force: false });
    pos = { x: 0, y: 60, z: 0 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls[1].args).toEqual({ distance: 6, force: false });
  });

  it('stairUp 按向上目标续做', async () => {
    let pos = { x: 0, y: 64, z: 0 };
    const h = makeHarness(undefined, () => pos);
    await start(h, 'stairUp', { distance: 8, force: false });
    pos = { x: 3, y: 69, z: 0 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls[1].args).toEqual({ distance: 3, force: false });
  });

  it('mineTunnel 显式方向：续做剩余长度，方向保留', async () => {
    let pos = { x: 0, y: 64, z: 0 };
    const h = makeHarness(undefined, () => pos);
    await start(h, 'mineTunnel', { length: 32, direction: 'east', force: false, handoff: '' });
    pos = { x: 10, y: 64, z: 0 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls[1].args).toEqual({ length: 22, direction: 'east', force: false, handoff: '' });
  });

  it('mineTunnel 没给方向：用实际位移推断，并写成显式方向', async () => {
    let pos = { x: 0, y: 64, z: 0 };
    const h = makeHarness(undefined, () => pos);
    await start(h, 'mineTunnel', { length: 32, force: false, handoff: '' });
    pos = { x: -8, y: 64, z: 1 };
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls[1].args).toEqual({ length: 24, direction: '-x', force: false, handoff: '' });
  });

  it('mineTunnel 完全没动：按原参数重发（等价 auto）', async () => {
    const h = makeHarness(undefined, () => ({ x: 0, y: 64, z: 0 }));
    await start(h, 'mineTunnel', { length: 32, force: false, handoff: '' });
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls[1].args).toEqual({ length: 32, force: false, handoff: '' });
  });

  it('坐标读不到 → 不猜、不续做', async () => {
    const h = makeHarness(undefined, () => null);
    await start(h, 'digDown', { distance: 10, force: false });
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(1);
    expect(h.resumeNotices.find((n) => !n.resumed)?.detail).toContain('digDown 被打断了，读不到当前进度，所以没有接着做。');
  });

  it('方向词表与身体侧一致（east=+x / north=-z / forward 认不出来）', () => {
    expect(parseTunnelDirection('east')).toEqual({ axis: 'x', sign: 1 });
    expect(parseTunnelDirection('-z')).toEqual({ axis: 'z', sign: -1 });
    expect(parseTunnelDirection('north')).toEqual({ axis: 'z', sign: -1 });
    expect(parseTunnelDirection('forward')).toBeNull();
    expect(parseTunnelDirection('')).toBeNull();
  });
});

describe('不续做的情形', () => {
  it('manual 动作（jump）：不自动续做', async () => {
    const h = makeHarness();
    await start(h, 'jump', {});
    await interrupt(h);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(1);
    // 中断回执只报被中断，不再写"不会自动续做"这类机制说明
    expect(String(h.notices.at(-1)?.result.data ?? '')).toContain('动作被中断了');
    expect(String(h.notices.at(-1)?.result.data ?? '')).toContain('保命反射抢走了身体');
  });

  it('模型按了 Stop → 放弃续做', async () => {
    const h = makeHarness();
    await start(h, 'travelTo', { x: 3, y: 64, z: 3 });
    await interrupt(h);
    h.scheduler.stopAll();
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(1);
  });

  it('身体其实跑完了（有结果）→ 不重复做', async () => {
    const h = makeHarness();
    await start(h, 'travelTo', { x: 3, y: 64, z: 3 });
    const interrupted = h.scheduler.beginEmergency();
    h.runner.captureInterruption(interrupted);
    h.calls[0].resolve('已经到达目的地');
    await flush();
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(1);
  });

  it('通道已经被模型的新动作占了 → 不抢', async () => {
    const h = makeHarness();
    await start(h, 'travelTo', { x: 3, y: 64, z: 3 });
    await interrupt(h);
    h.scheduler.endEmergency();
    expect(h.scheduler.startAction('jump', {}).accepted).toBe(true);
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(1);
    expect(h.resumeNotices.find((n) => !n.resumed)?.detail).toContain('身体通道被占着');
  });

  it('模型中途发了新动作 → 旧的续做意图作废', async () => {
    const h = makeHarness();
    await start(h, 'travelTo', { x: 3, y: 64, z: 3 });
    const interrupted = h.scheduler.beginEmergency();
    h.runner.captureInterruption(interrupted);
    h.scheduler.endEmergency();
    // 反射结束后、续做之前，模型自己发了一个新动作
    const outcome = await h.runner.run('goToPlayer', { player_name: 'x', closeness: 2 });
    expect(outcome.status).toBe('accepted');
    await h.runner.resumeInterrupted();
    // 只多了 goToPlayer 这一次，没有额外的 travelTo 续做
    expect(h.calls.map((c) => c.name)).toEqual(['travelTo', 'goToPlayer']);
  });

  it('captureInterruption(null) 是空操作', async () => {
    const h = makeHarness();
    h.runner.captureInterruption(null);
    h.scheduler.endEmergency();
    await h.runner.resumeInterrupted();
    expect(h.calls).toHaveLength(0);
  });
});

describe('事件链路：L5 反射 → 作废 → 完成 → 续做', () => {
  const fakeSubmission = (): Submission =>
    ({
      id: 1 as Submission['id'],
      status: () => Promise.resolve({} as never),
      wait: () => Promise.resolve({ status: 'done' } as never),
      abort: () => Promise.resolve('aborted' as const),
    }) as unknown as Submission;

  const gameEvent = (type: string, level: number, extra: Partial<GameEvent> = {}): GameEvent => ({
    type,
    kind: 'World' as Kind,
    level: level as GameEvent['level'],
    payload: {},
    text: type,
    ts: 0,
    reflex: null,
    completes: null,
    ...extra,
  });

  it('反射报告 completes 的那一刻续做（不需要模型参与）', async () => {
    const h = makeHarness();
    await start(h, 'travelTo', { x: 4, y: 64, z: 4 });

    // 与 agent.ts 的接线一致：beginEmergency 捕获、endEmergency 续做。
    const intake = new EventIntake({
      submit: () => Promise.resolve(fakeSubmission()),
      write: () => Promise.resolve(),
      abort: () => Promise.resolve(),
      beginEmergency: () => {
        const interrupted = h.scheduler.beginEmergency();
        h.runner.captureInterruption(interrupted);
      },
      endEmergency: () => {
        h.scheduler.endEmergency();
        // 与 agent.ts 一致：续做是 async 的（位置类要采样），不阻塞事件泵。
        void h.runner.resumeInterrupted();
      },
    });

    // 1) 战斗反射 L5 接管：动作通道上锁，正在跑的 travelTo 被作废
    intake.notify(gameEvent('combat.engage', LEVEL.EMERGENCY, { reflex: 'combat' }));
    await intake.settle();
    expect(h.scheduler.locked).toBe(true);

    // 2) 身体被中断，返回空结果
    h.calls[0].resolve('');
    await flush();
    expect(h.calls).toHaveLength(1);

    // 3) 反射完成（completes）→ 解锁 → 自动续做
    intake.notify(gameEvent('reflex.done', LEVEL.STATE, { completes: 'combat' }));
    await intake.settle();
    expect(h.scheduler.locked).toBe(false);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].args).toEqual({ x: 4, y: 64, z: 4 });
  });
});

describe('接线：大脑真的把"作废"和"续做"接上了', () => {
  it('beginEmergency 交出被作废的动作，endEmergency 触发续做', () => {
    expect(agentSource).toContain('captureInterruption(interrupted)');
    expect(agentSource).toContain('resumeInterrupted()');
  });

  it('续做回执是 L2（只记录、不唤醒）', () => {
    expect(agentSource).toContain("'action.resumed', KIND.TOOL, LEVEL.STATE");
  });

  it('Stop 放弃续做', () => {
    expect(agentSource).toContain("clearInterruption('stop')");
  });
});
