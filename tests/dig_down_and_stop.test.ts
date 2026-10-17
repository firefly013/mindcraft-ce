/**
 * digDown 提前停止 + ActionManager 硬中断。
 *
 * 真机故障：digDown 撞水后 requestInterrupt 停不下来，ActionManager.stop
 * 等 10 秒就 cleanKill 杀 body，整晚反复回出生点。这里把两条防线钉住：
 *   - digDown 自己先看水/岩浆/落差，不把身体交给 10 秒保险丝；
 *   - stop 先硬中断，只有确实停不下来才杀，并且报出卡住的动作名。
 */
import { describe, expect, it, vi } from 'vitest';
import { ActionManager, STOP_WAIT_MS } from '../src/body/action_manager.js';
import { classifyDigDownStep, digDown, MAX_DIG_FALL_BLOCKS } from '../src/body/library/skills.js';

type Block = { name: string };
const key = (x: number, y: number, z: number): string => x + ',' + y + ',' + z;

function accessor(blocks: Record<string, Block>): (x: number, y: number, z: number) => Block | null {
  return (x, y, z) => blocks[key(x, y, z)] ?? null;
}

describe('classifyDigDownStep', () => {
  it('当前所在方块是水：立刻停，不挖', () => {
    const verdict = classifyDigDownStep(accessor({ [key(0, 64, 0)]: { name: 'water' } }), { x: 0, y: 64, z: 0 }, 1);
    expect(verdict.kind).toBe('stop');
    if (verdict.kind !== 'stop') return;
    expect(verdict.reason).toContain('water');
  });

  it('目标格下方是岩浆：立刻停，不挖穿', () => {
    const verdict = classifyDigDownStep(
      accessor({
        [key(0, 63, 0)]: { name: 'stone' },
        [key(0, 62, 0)]: { name: 'lava' },
      }),
      { x: 0, y: 64, z: 0 },
      1,
    );
    expect(verdict.kind).toBe('stop');
    if (verdict.kind !== 'stop') return;
    expect(verdict.reason).toContain('lava');
  });

  it('目标格本身是水：不挖入水中', () => {
    const verdict = classifyDigDownStep(
      accessor({ [key(0, 63, 0)]: { name: 'water' } }),
      { x: 0, y: 64, z: 0 },
      1,
    );
    expect(verdict.kind).toBe('stop');
    if (verdict.kind !== 'stop') return;
    expect(verdict.reason).toContain('water');
  });

  it('落差达到 4 格：提前停', () => {
    const blocks: Record<string, Block> = { [key(0, 63, 0)]: { name: 'stone' } };
    for (let y = 62; y >= 62 - (MAX_DIG_FALL_BLOCKS - 1); y--) blocks[key(0, y, 0)] = { name: 'air' };
    const verdict = classifyDigDownStep(accessor(blocks), { x: 0, y: 64, z: 0 }, 1);
    expect(verdict.kind).toBe('stop');
    if (verdict.kind !== 'stop') return;
    expect(verdict.reason).toContain('drop');
  });

  it('普通实心柱：可以挖', () => {
    const verdict = classifyDigDownStep(
      accessor({
        [key(0, 63, 0)]: { name: 'stone' },
        [key(0, 62, 0)]: { name: 'stone' },
      }),
      { x: 0, y: 64, z: 0 },
      1,
    );
    expect(verdict).toEqual({ kind: 'dig', target: { x: 0, y: 63, z: 0 } });
  });

  it('目标格是空气：跳过，不算落差', () => {
    const verdict = classifyDigDownStep(
      accessor({
        [key(0, 63, 0)]: { name: 'air' },
        [key(0, 62, 0)]: { name: 'stone' },
      }),
      { x: 0, y: 64, z: 0 },
      1,
    );
    expect(verdict.kind).toBe('skip_air');
  });
});

function fakeBot(blocks: Record<string, Block>, interrupt = false): any {
  const map: Record<string, Block> = { [key(0, 64, 0)]: { name: 'stone' }, ...blocks };
  return {
    output: '',
    interrupt_code: interrupt,
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: (p: { x: number; y: number; z: number }) => map[key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))] ?? { name: 'air' },
  };
}

describe('digDown 自身提前停', () => {
  it('脚下是水：返回 false，回执写清停在哪、为什么', async () => {
    const bot = fakeBot({ [key(0, 64, 0)]: { name: 'water' } });
    const ok = await digDown(bot, 5);
    expect(ok).toBe(false);
    expect(bot.output).toContain('water');
    expect(bot.output).toContain('stopped');
  });

  it('下方落差 >=4：返回 false，不继续挖', async () => {
    const blocks: Record<string, Block> = { [key(0, 63, 0)]: { name: 'stone' } };
    for (let y = 62; y >= 62 - (MAX_DIG_FALL_BLOCKS - 1); y--) blocks[key(0, y, 0)] = { name: 'air' };
    const bot = fakeBot(blocks);
    const ok = await digDown(bot, 5);
    expect(ok).toBe(false);
    expect(bot.output).toContain('drop');
  });

  it('bot.interrupt_code 已置位：先于下一铲停住', async () => {
    const bot = fakeBot({}, true);
    const ok = await digDown(bot, 5);
    expect(ok).toBe(false);
    expect(bot.output).toContain('Stop was requested');
  });
});

describe('ActionManager 硬中断', () => {
  function makeAgent(): { agent: any; manager: ActionManager } {
    const agent = {
      bot: {
        interrupt_code: false,
        clearControlStates: vi.fn(),
        pathfinder: { stop: vi.fn() },
        stopDigging: vi.fn(),
      },
      requestInterrupt: vi.fn(),
      cleanKill: vi.fn(),
      history: { add: vi.fn() },
    };
    return { agent, manager: new ActionManager(agent) };
  }

  it('hardInterrupt 一次取消寻路、清控制状态、停挖、置 interrupt 标志', () => {
    const { agent, manager } = makeAgent();
    manager.hardInterrupt();
    expect(agent.requestInterrupt).toHaveBeenCalledTimes(1);
    expect(agent.bot.clearControlStates).toHaveBeenCalledTimes(1);
    expect(agent.bot.pathfinder.stop).toHaveBeenCalledTimes(1);
    expect(agent.bot.stopDigging).toHaveBeenCalledTimes(1);
    expect(agent.bot.interrupt_code).toBe(true);
  });

  it('stop 先硬中断；动作收手后不杀进程', async () => {
    const { agent, manager } = makeAgent();
    manager.executing = true;
    manager.currentActionLabel = 'digDown';
    agent.requestInterrupt.mockImplementation(() => {
      manager.executing = false;
    });
    await manager.stop();
    expect(agent.requestInterrupt).toHaveBeenCalled();
    expect(agent.cleanKill).not.toHaveBeenCalled();
  });

  it('硬中断后仍停不下来：才在 STOP_WAIT_MS 后杀，并报出卡住的动作名', async () => {
    vi.useFakeTimers();
    try {
      const { agent, manager } = makeAgent();
      manager.executing = true;
      manager.currentActionLabel = 'digDown';
      agent.cleanKill.mockImplementation(() => {
        manager.executing = false;
      });
      const promise = manager.stop();
      await vi.advanceTimersByTimeAsync(STOP_WAIT_MS + 1000);
      await promise;
      expect(agent.cleanKill).toHaveBeenCalledTimes(1);
      expect(String(agent.cleanKill.mock.calls[0]?.[0])).toContain('digDown');
      expect(String(agent.cleanKill.mock.calls[0]?.[0])).toContain('hard interrupts');
    } finally {
      vi.useRealTimers();
    }
  });

  it('没在跑动作时 stop 是空操作，不打扰身体', async () => {
    const { agent, manager } = makeAgent();
    await manager.stop();
    expect(agent.requestInterrupt).not.toHaveBeenCalled();
    expect(agent.cleanKill).not.toHaveBeenCalled();
  });
});
