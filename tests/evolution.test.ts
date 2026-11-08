/**
 * 自进化模式的两层：装配（工具 + 环境 + 提示词）和重启工具。
 *
 * 这些测试只碰纯逻辑：`openEvolution` 不启动进程，`restartApp` 也不真的退出。
 * 真正的“退出码 75 → 主进程收摊 → 守护进程拉起”在
 * `agent_process.test.ts` 与 `evolve_supervisor.test.ts` 里各自验证一段。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Agent } from '../src/brain/agent.js';
import { evolutionShell, openEvolution } from '../src/brain/runtime/evolution.js';
import {
  RESTART_ALREADY_TEXT,
  RESTART_SCHEDULED_TEXT,
  createRestartAppTool,
} from '../src/brain/tools/evolution_tools.js';
import {
  EVOLVE_MODE_ENV,
  EVOLVE_RESTART_DELAY_MS,
  EVOLVE_RESTART_EXIT_CODE,
  isEvolutionMode,
} from '../src/shared/evolution.js';
import { EVOLUTION_PROMPT } from '../src/shared/prompts.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('isEvolutionMode', () => {
  it('只认守护进程设置的 MINDCRAFT_EVOLVE=1', () => {
    expect(isEvolutionMode({})).toBe(false);
    expect(isEvolutionMode({ [EVOLVE_MODE_ENV]: '0' })).toBe(false);
    expect(isEvolutionMode({ [EVOLVE_MODE_ENV]: '1' })).toBe(true);
    const previous = process.env[EVOLVE_MODE_ENV];
    process.env[EVOLVE_MODE_ENV] = '1';
    try {
      expect(isEvolutionMode()).toBe(true);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, EVOLVE_MODE_ENV);
      else process.env[EVOLVE_MODE_ENV] = previous;
    }
  });
});

describe('evolutionShell', () => {
  it('Windows 用 powershell，其他平台用 bash', () => {
    expect(evolutionShell('win32')).toBe('powershell');
    expect(evolutionShell('linux')).toBe('bash');
    expect(evolutionShell('darwin')).toBe('bash');
  });
});

describe('openEvolution', () => {
  const workspace = 'C:\\work\\repo';

  it('扩展名固定，工具集合按平台换 shell', () => {
    const windows = openEvolution(workspace, 'win32');
    expect(windows.extension.name).toBe('mc.evolution');
    expect((windows.extension.tools ?? []).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'powershell',
    ]);

    const linux = openEvolution(workspace, 'linux');
    expect((linux.extension.tools ?? []).map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
    ]);
  });

  it('系统提示词说明工作区、shell 工具名与重启工具', () => {
    const section = openEvolution(workspace, 'win32').extension.sections?.[0];
    expect(section?.key).toBe('evolution');
    // 追加到主提示词后面，不加 <evolution> 标签：它是同一段自我介绍的一部分。
    expect(section?.tag).toBe(false);
    const text = section?.render({} as never, {} as never) as string;
    expect(text).toContain(workspace);
    expect(text).toContain('powershell');
    expect(text).toContain('restartApp');
  });

  it('环境以仓库根为工作目录；会话另有 cwd 时听会话的', async () => {
    const runtime = openEvolution(workspace, 'linux');
    const base = (await runtime.env(
      { conversationId: 'c1', cwd: undefined, read: {} } as never,
      {} as never,
    )) as NodeExecutionEnv;
    expect(base.cwd).toBe(workspace);

    const other = (await runtime.env(
      { conversationId: 'c1', cwd: '/tmp/other', read: {} } as never,
      {} as never,
    )) as NodeExecutionEnv;
    expect(other.cwd).toBe('/tmp/other');
  });
});

describe('restartApp 工具', () => {
  type Rendering = {
    content: Array<{ type: string; text?: string }>;
    control?: { terminate?: boolean };
  };
  const call = (schedule: () => boolean): Promise<Rendering> => {
    const tool = createRestartAppTool({ schedule });
    const execute = (tool as unknown as {
      execute: (args: unknown, api: never, context: never) => Promise<Rendering>;
    }).execute;
    return execute({}, {} as never, {} as never);
  };

  it('排上重启后回执说明会发生什么，并结束当前回合', async () => {
    const result = await call(() => true);
    expect(result.content[0]?.text).toBe(RESTART_SCHEDULED_TEXT);
    expect(result.control?.terminate).toBe(true);
  });

  it('已经排过就只回一句事实，不重复结束回合', async () => {
    const result = await call(() => false);
    expect(result.content[0]?.text).toBe(RESTART_ALREADY_TEXT);
    expect(result.control).toBeUndefined();
  });
});

describe('EVOLUTION_PROMPT', () => {
  it('说明工作区、shell 工具名和重启工具，且只描述自进化模式', () => {
    const text = EVOLUTION_PROMPT('/repo', 'bash');
    expect(text).toContain('【自进化模式】');
    expect(text).toContain('/repo');
    expect(text).toContain('bash');
    expect(text).toContain('restartApp');
    expect(text).toContain('npm run typecheck');
  });
});

describe('Agent.scheduleAppRestart', () => {
  it('只排一次，等回执落盘的时间过去后带重启退出码退出', () => {
    vi.useFakeTimers();
    const exits: Array<number | undefined> = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code);
    }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const agent = new Agent();
    expect(agent.scheduleAppRestart()).toBe(true);
    // 重复调用不把退出时间往后推，也不会真的再排一个定时器。
    expect(agent.scheduleAppRestart()).toBe(false);
    expect(exits).toEqual([]);

    vi.advanceTimersByTime(EVOLVE_RESTART_DELAY_MS);
    expect(exits).toEqual([EVOLVE_RESTART_EXIT_CODE]);
  });
});
