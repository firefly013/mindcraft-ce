/**
 * Baritone 工具契约：查询直返、控制拦截、动作占通道后台盯、
 * 过期 generation 就地丢弃。baritone 全 stub，不碰真包
 * （真包加载另测）。
 */
import { describe, expect, it } from 'vitest';
import {
  baritoneCommandNameOf,
  BARITONE_BLOCKED_COMMANDS,
  BARITONE_QUERY_COMMANDS,
  createBaritoneTool,
} from '../src/agent/baritone_tool.js';
import type { BaritoneHandle } from '../src/agent/baritone_tool.js';
import type { LoopToolResult } from '../src/agent/loop.js';
import { Scheduler } from '../src/agent/scheduler.js';

interface Harness {
  tool: (args: unknown) => Promise<LoopToolResult>;
  scheduler: Scheduler;
  notices: Array<{ call: string; result: LoopToolResult }>;
  tasks: string[];
  executed: string[];
  fire: (fn: () => void) => void;
  timers: Array<() => void>;
}

function makeHarness(tasks: string[] = []): Harness {
  const scheduler = new Scheduler();
  const notices: Array<{ call: string; result: LoopToolResult }> = [];
  const executed: string[] = [];
  const timers: Array<() => void> = [];
  const taskList = [...tasks];
  const fake: BaritoneHandle = {
    log: () => {},
    getCommandManager: () => ({
      execute: (line: string) => {
        executed.push(line);
        if (line.startsWith('goto')) taskList.push(`travel:${line}`);
      },
      getCommand: (name: string) => ({ name }),
    }),
    runningTasks: () => [...taskList],
  };
  const tool = createBaritoneTool({
    getBaritone: () => fake,
    scheduler,
    notify: (payload) => {
      notices.push(payload);
    },
    pollMs: 1,
    setTimer: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  return {
    tool,
    scheduler,
    notices,
    tasks: taskList,
    executed,
    timers,
    fire: (fn: () => void) => fn(),
  };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('baritoneCommandNameOf', () => {
  it('strips # and takes the first word, lowercased', () => {
    expect(baritoneCommandNameOf('#goto 1 2 3')).toBe('goto');
    expect(baritoneCommandNameOf('  SCAN blocks  ')).toBe('scan');
    expect(baritoneCommandNameOf('')).toBeNull();
    expect(baritoneCommandNameOf(null)).toBeNull();
  });
});

describe('createBaritoneTool', () => {
  it('rejects missing baritone, empty lines and blocked controls', async () => {
    const scheduler = new Scheduler();
    const tool = createBaritoneTool({
      getBaritone: () => null,
      scheduler,
      notify: () => {},
    });
    expect((await tool({ command: 'goto 1 2 3' })).code).toBe('NO_BARITONE');

    const h = makeHarness();
    expect((await h.tool({ command: '' })).code).toBe('BAD_COMMAND');
    for (const name of ['stop', 'cancel', 'pause', 'forcecancel']) {
      const r = await h.tool({ command: name });
      expect(r.status).toBe('rejected');
      expect(r.code).toBe('CONTROL_BLOCKED');
    }
    expect(BARITONE_BLOCKED_COMMANDS).toContain('forcecancel');
    expect(BARITONE_QUERY_COMMANDS).toContain('scan');
  });

  it('rejects unknown commands without touching the channel', async () => {
    const h = makeHarness();
    const tool = createBaritoneTool({
      getBaritone: () => ({
        getCommandManager: () => ({
          execute: () => {},
          getCommand: () => null,
        }),
      }),
      scheduler: h.scheduler,
      notify: () => {},
    });
    const r = await tool({ command: 'frobnicate' });
    expect(r.code).toBe('UNKNOWN_COMMAND');
    expect(h.scheduler.describe().actionId).toBeNull();
  });

  it('query commands answer at once with captured output', async () => {
    const h = makeHarness();
    const tool = createBaritoneTool({
      getBaritone: () => ({
        log: () => {},
        getCommandManager: () => ({
          execute: (line: string) => {
            void line;
          },
          getCommand: () => ({}),
        }),
      }),
      scheduler: h.scheduler,
      notify: () => {},
    });
    const r = await tool({ command: 'scan blocks' });
    expect(r.status).toBe('completed');
    expect(h.scheduler.describe().actionId).toBeNull();
  });

  it('action commands claim the channel and report on drain', async () => {
    const h = makeHarness();
    const r = await h.tool({ command: 'goto 100 64 200' });
    expect(r.status).toBe('accepted');
    expect(h.scheduler.describe().actionId).not.toBeNull();
    expect(h.notices).toEqual([]);

    // 任务排空：下一轮 tick 上报并放行。
    h.tasks.length = 0;
    for (const t of h.timers) t();
    await tick();
    expect(h.scheduler.describe().actionId).toBeNull();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.call).toBe('Baritone');
  });

  it('a stale drain is dropped, never reported', async () => {
    const h = makeHarness();
    await h.tool({ command: 'goto 100 64 200' });
    h.scheduler.stopAll();
    h.tasks.length = 0;
    for (const t of h.timers) t();
    await tick();
    expect(h.notices).toEqual([]);
  });

  it('a second action while one runs is refused', async () => {
    const h = makeHarness();
    await h.tool({ command: 'goto 1 2 3' });
    const busy = await h.tool({ command: 'goto 4 5 6' });
    expect(busy.status).toBe('rejected');
    expect(busy.code).toBe('ACTION_BUSY');
  });

  it('commands starting no task complete at once', async () => {
    const h = makeHarness();
    // look 系在 QUERY 表里：同步回结果。
    const r = await h.tool({ command: 'look rotation 0 0' });
    expect(r.status).toBe('completed');
    expect(h.scheduler.describe().actionId).toBeNull();
  });

  it('handler factory requires getBaritone', () => {
    expect(() => createBaritoneTool({ getBaritone: null as never, scheduler: new Scheduler(), notify: () => {} })).toThrow();
  });
});
