/**
 * CLI 参数解析的契约。
 *
 * 这层没什么花活，但**踩错就整条命令跑歪**：把 `--agent pia` 当成命令名、
 * 把 `--limit 40` 当成字符串送给只收 int 的工具、位置参数错位。都是默不作声
 * 的失败——命令照样发出去，只是发错了。
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli/args.js';
import { GAME_COMMANDS } from '../src/runtime/game_tools.js';
import { stripBang } from '../src/agent/commands/to_openai_tools.js';

/**
 * "哪些命令是长时间命令"**不靠手工清单** —— 清单会漏、会过期。
 * 判据是 `runAsAction` 打在 perform 上的 `longRunning` 标记（走身体通道就有）。
 * 这组测试钉的是：那个标记机制真的生效了，而不是字段加了却没人打。
 */
describe('长时间命令的判定', () => {
  const longNames = GAME_COMMANDS.filter((c) => c.perform?.longRunning === true).map((c) => stripBang(c.name));

  it('机制生效：确实有一批命令被标成了长时间', () => {
    expect(longNames.length).toBeGreaterThan(0);
  });

  it('走身体通道的是长时间命令', () => {
    for (const name of ['goToCoordinates', 'mineBlock', 'followPlayer', 'searchForBlock']) {
      expect(longNames, name).toContain(name);
    }
  });

  it('查询类和瞬时动作不是', () => {
    for (const name of ['stats', 'getCraftingPlan', 'tools', 'history']) {
      expect(longNames, name).not.toContain(name);
    }
  });

  it('不在名单里的命令一律按短命令处理（保守）', () => {
    expect(longNames).not.toContain('一个不存在的命令');
  });
});

describe('parseCliArgs', () => {
  it('命令名是第一个裸词，--agent 不会抢走它', () => {
    const o = parseCliArgs(['--agent', 'pia', 'stats']);
    expect(o.agent).toBe('pia');
    expect(o.command).toBe('stats');
  });

  it('命令写在最前面也认', () => {
    const o = parseCliArgs(['stats', '--agent', 'pia']);
    expect(o.command).toBe('stats');
    expect(o.agent).toBe('pia');
  });

  it('具名参数按工具声明的形状给出去（数字就是数字）', () => {
    const o = parseCliArgs(['--agent', 'pia', 'goToCoordinates', '--x', '100', '--y', '64', '--z', '-5']);
    expect(o.args).toMatchObject({ x: 100, y: 64, z: -5 });
  });

  it('非数字保持字符串', () => {
    const o = parseCliArgs(['--agent', 'pia', 'stats', '--type', 'inventory']);
    expect(o.args['type']).toBe('inventory');
  });

  it('--agent / --port / --timeout 是 CLI 自己的选项，不进工具参数', () => {
    const o = parseCliArgs(['--agent', 'pib', '--port', '8100', '--timeout', '3000', 'stats']);
    expect(o.agent).toBe('pib');
    expect(o.port).toBe(8100);
    expect(o.timeoutMs).toBe(3000);
    expect(o.args).toEqual({});
  });

  it('位置参数按 0/1/2 铺开，给按 params 顺序取值的工具用', () => {
    const o = parseCliArgs(['--agent', 'pia', 'stats', 'inventory']);
    expect(o.args['0']).toBe('inventory');
  });

  it('开关型 flag（后面没值）当 true', () => {
    const o = parseCliArgs(['--agent', 'pia', '--force', 'stats']);
    expect(o.force).toBe(true);
    expect(o.command).toBe('stats');
  });

  it('--all 与 --force 各自独立', () => {
    const o = parseCliArgs(['--all', '--agent', 'pia', 'events']);
    expect(o.all).toBe(true);
    expect(o.force).toBe(false);
  });

  it('默认值：端口 8099、超时 120 秒', () => {
    const o = parseCliArgs(['--agent', 'pia', 'stats']);
    expect(o.port).toBe(8099);
    expect(o.timeoutMs).toBe(120_000);
  });

  it('-h / --help 要用法文本', () => {
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['--help']).usage).toContain('history');
  });

  it('什么都没给 → 没有命令，要打用法', () => {
    const o = parseCliArgs([]);
    expect(o.command).toBeNull();
    expect(o.usage).toContain('用法');
  });

  it('端口给垃圾就退回默认，不炸', () => {
    expect(parseCliArgs(['--agent', 'pia', '--port', 'abc', 'stats']).port).toBe(8099);
  });
});

describe('任务控制子命令', () => {
  it('裸命令默认是提交任务（run）', () => {
    const o = parseCliArgs(['--agent', 'pia', 'stats']);
    expect(o.op).toBe('run');
    expect(o.jobId).toBeNull();
  });

  it('wait <id>：任务号从紧跟的裸词取', () => {
    const o = parseCliArgs(['--agent', 'pia', 'wait', '3']);
    expect(o.op).toBe('wait');
    expect(o.jobId).toBe('3');
  });

  it('status / cancel 同 wait', () => {
    expect(parseCliArgs(['--agent', 'pia', 'status', '7'])).toMatchObject({ op: 'status', jobId: '7' });
    expect(parseCliArgs(['--agent', 'pia', 'cancel', '7'])).toMatchObject({ op: 'cancel', jobId: '7' });
  });

  it('jobs 是列表，不需要任务号', () => {
    const o = parseCliArgs(['--agent', 'pia', 'jobs']);
    expect(o.op).toBe('list');
    expect(o.jobId).toBeNull();
  });

  it('--timeout 对 wait 是"等多久"，不是命令超时', () => {
    const o = parseCliArgs(['--agent', 'pia', 'wait', '3', '--timeout', '300000']);
    expect(o.timeoutMs).toBe(300_000);
    expect(o.op).toBe('wait');
  });

  it('--async：只提交不等', () => {
    const o = parseCliArgs(['--async', '--agent', 'pia', 'goToCoordinates', '--x', '1']);
    expect(o.async).toBe(true);
    expect(o.op).toBe('run');
  });

  it('wait 却没给任务号 → jobId 是 null（由上层报清楚）', () => {
    expect(parseCliArgs(['--agent', 'pia', 'wait']).jobId).toBeNull();
  });

  it('名字像但不在名单里的命令，仍是普通提交', () => {
    const o = parseCliArgs(['--agent', 'pia', 'waitForIt', '3']);
    expect(o.op).toBe('run');
    expect(o.command).toBe('waitForIt');
  });
});
