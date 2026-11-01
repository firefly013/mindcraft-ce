/**
 * **无模型测试台接线**（用户 2026-11-01：续做不经过模型，要像 CLI 那样从外部测）。
 *
 * 这里钉三件事：
 *   1. `createHarnessIntakeDeps`：没有模型也把事件投递跑通（L2 只记录、L5 上锁、
 *      completes 解锁、反射处理照常查表），`submit` 不调模型但也不丢事件；
 *   2. 手动模式接线：agent 真的把 beginEmergency→捕获、endEmergency→续做 接上了，
 *      且 CLI 的 `--via runner` 真的走 `ActionRunner`（不是直连身体）；
 *   3. 外部入口：MindServer 的 `cli-command` 把 `via` 透传、脚本存在。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Submission } from '@earendil-works/pi-durable';
import { ActionRunner } from '../src/brain/action_runner.js';
import { EventIntake, type GameEvent } from '../src/brain/runtime/events.js';
import { createHarnessIntakeDeps } from '../src/brain/runtime/harness.js';
import { Scheduler } from '../src/brain/scheduler.js';
import { createToolCatalog } from '../src/brain/tools/catalog.js';
import type { ToolOutcome } from '../src/brain/tools/tools.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import { LEVEL } from '../src/shared/events.js';
import type { Kind } from '../src/shared/events.js';

const CATALOG = createToolCatalog(toolDeclarations());
const agentSource = readFileSync(resolve(process.cwd(), 'src/brain/agent.ts'), 'utf8');
const proxySource = readFileSync(resolve(process.cwd(), 'src/brain/mindserver_proxy.ts'), 'utf8');
const cliSource = readFileSync(resolve(process.cwd(), 'src/cli.ts'), 'utf8');
const argsSource = readFileSync(resolve(process.cwd(), 'src/cli/args.ts'), 'utf8');

const fakeSubmission = (): Submission =>
  ({
    id: 0,
    status: () => Promise.resolve({}),
    wait: () => Promise.resolve({ status: 'done' }),
    abort: () => Promise.resolve('aborted'),
  }) as unknown as Submission;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function gameEvent(type: string, level: number, extra: Partial<GameEvent> = {}): GameEvent {
  return {
    type,
    kind: 'World' as Kind,
    level: level as GameEvent['level'],
    payload: {},
    text: type,
    ts: 0,
    reflex: null,
    completes: null,
    ...extra,
  };
}

function makeHarness() {
  const scheduler = new Scheduler();
  const calls: Array<{ name: string; args: Record<string, unknown>; resolve: (value: string) => void }> = [];
  const runner = new ActionRunner({
    scheduler,
    catalog: CATALOG,
    record: () => Promise.resolve(),
    speak: () => {},
    execute: (name: string, args: Record<string, unknown>) =>
      new Promise<string>((resolveCall) => {
        calls.push({ name, args, resolve: resolveCall });
      }),
    notify: () => {},
    inventoryCounts: () => ({}),
    bodyPosition: () => Promise.resolve({ x: 0, y: 64, z: 0 }),
  });
  return { scheduler, calls, runner };
}

describe('createHarnessIntakeDeps：没有模型也照常投递', () => {
  it('L2 只记录（written）、L5 上锁（emergency）、completes 解锁；不调模型', async () => {
    const seen: string[] = [];
    const emergencies: string[] = [];
    const intake = new EventIntake(
      createHarnessIntakeDeps({
        onEvent: (event, action) => seen.push(`${event.type}:${action}`),
        beginEmergency: () => emergencies.push('begin'),
        endEmergency: () => emergencies.push('end'),
      }),
    );

    intake.notify(gameEvent('inventory.changed', LEVEL.STATE));
    await intake.settle();
    expect(seen).toContain('inventory.changed:written');
    expect(emergencies).toHaveLength(0);

    intake.notify(gameEvent('combat.engage', LEVEL.EMERGENCY, { reflex: 'combat' }));
    await intake.settle();
    expect(emergencies).toEqual(['begin']);

    intake.notify(gameEvent('reflex.done', LEVEL.STATE, { completes: 'combat' }));
    await intake.settle();
    expect(emergencies).toEqual(['begin', 'end']);
    expect(seen).toContain('reflex.done:written');
  });

  it('反射处理查表照常（测试台只登记安全的大脑反射）', async () => {
    const handled: string[] = [];
    const intake = new EventIntake(
      createHarnessIntakeDeps({
        lookup: (type) =>
          type === 'inventory.changed'
            ? {
                types: ['inventory.changed'],
                executor: 'reflex',
                run: (event) => {
                  handled.push(event.type);
                  return Promise.resolve();
                },
              }
            : undefined,
      }),
    );
    intake.notify(gameEvent('inventory.changed', LEVEL.STATE));
    await intake.settle();
    expect(handled).toEqual(['inventory.changed']);
  });
});

describe('测试台事件链路：L5 → 作废 → completes → 续做（与线上同一条代码）', () => {
  it('手动模式接线后，无模型也能观察到 action.resumed 的完整序列', async () => {
    const h = makeHarness();
    const resumed: string[] = [];
    const runner = new ActionRunner({
      scheduler: h.scheduler,
      catalog: CATALOG,
      record: () => Promise.resolve(),
      speak: () => {},
      execute: (name: string, args: Record<string, unknown>) =>
        new Promise<string>((resolveCall) => {
          h.calls.push({ name, args, resolve: resolveCall });
        }),
      notify: () => {},
      inventoryCounts: () => ({}),
      bodyPosition: () => Promise.resolve({ x: 0, y: 64, z: 0 }),
      resumeNotice: (payload) => resumed.push(payload.detail),
    });
    await runner.run('travelTo', { x: 4, y: 64, z: 4 });
    expect(h.calls).toHaveLength(1);

    // 与 `Agent.attachHarnessRuntime` 完全一致的接线。
    const intake = new EventIntake(
      createHarnessIntakeDeps({
        beginEmergency: () => {
          const interrupted = h.scheduler.beginEmergency();
          runner.captureInterruption(interrupted);
        },
        endEmergency: () => {
          h.scheduler.endEmergency();
          void runner.resumeInterrupted();
        },
      }),
    );

    intake.notify(gameEvent('combat.engage', LEVEL.EMERGENCY, { reflex: 'combat' }));
    await intake.settle();
    expect(h.scheduler.locked).toBe(true);

    h.calls[0].resolve('');
    await flush();

    intake.notify(gameEvent('reflex.done', LEVEL.STATE, { completes: 'combat' }));
    await intake.settle();
    await flush();
    expect(h.scheduler.locked).toBe(false);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].args).toEqual({ x: 4, y: 64, z: 4 });
    expect(resumed.some((line) => line.includes('已替你续做 travelTo'))).toBe(true);
  });
});

describe('接线：手动模式 + CLI 动作通道', () => {
  it('手动模式不再直接 return：接上测试台运行时', () => {
    expect(agentSource).toContain('this.attachHarnessRuntime()');
    expect(agentSource).toContain('createHarnessIntakeDeps');
    // 手动模式分支里必须真的调用（不是定义了没用）。
    const manual = agentSource.slice(agentSource.indexOf("event: 'manual-mode'"), agentSource.indexOf('event: \'manual-mode\'') + 400);
    expect(manual).toContain('attachHarnessRuntime');
  });

  it('测试台的锁/解锁接的是真实 Scheduler/ActionRunner', () => {
    expect(agentSource).toContain('captureInterruption(interrupted)');
    expect(agentSource).toContain('resumeInterrupted()');
    expect(agentSource).toContain('harness-attached');
  });

  it('CLI 的 --via runner 走 ActionRunner（不是直连身体）', () => {
    expect(agentSource).toContain("via === 'runner'");
    expect(agentSource).toContain('this.actionRunner');
    expect(agentSource).toContain('runActionViaChannel');
    expect(agentSource).toContain('tool.action.done');
  });

  it('MindServer 把 via 透传给 startCliJob', () => {
    expect(proxySource).toContain("data?.via === 'runner'");
    expect(proxySource).toContain('startCliJob');
  });

  it('CLI 参数与 payload 都带 via', () => {
    expect(argsSource).toContain('--via runner');
    expect(argsSource).toContain('via:');
    expect(cliSource).toContain('via: opts.via');
  });

  it('外部测试台脚本存在', () => {
    expect(existsSync(resolve(process.cwd(), 'scripts/harness/resume.mjs'))).toBe(true);
  });
});
