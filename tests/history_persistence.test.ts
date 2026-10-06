/**
 * 跨会话持久化契约：memory + turns 之外，MemoryBank 的地点与
 * 模型自己写的计划也必须活过重启。
 *
 * 回归点：以前 memory.json 只有 memory/turns/taskStart，
 * rememberHere 存的地点和 UpdatePlan 的计划一关服就没了。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History } from '../src/agent/history.js';
import { MemoryBank } from '../src/agent/memory_bank.js';
import { PlanStore } from '../src/agent/plan.js';
import type { ChatMessage } from '../src/types/common.js';

function makeAgent(historyDir: string): {
  name: string;
  historyDir: string;
  prompter: { profile: Record<string, unknown>; promptMemSaving: (turns: ChatMessage[]) => Promise<string> };
  memory_bank: MemoryBank;
  plan: PlanStore;
  task: { taskStartTime: number };
} {
  return {
    name: 'persisttest',
    historyDir,
    prompter: { profile: {}, promptMemSaving: () => Promise.resolve('SUM') },
    memory_bank: new MemoryBank(),
    plan: new PlanStore(),
    task: { taskStartTime: 4242 },
  };
}

/** 临时落盘目录：测试不再往仓库的 ./bots 里写 memory.json。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mindcraft-persist-'));
}

describe('History persistence', () => {
  it('round-trips memory, turns, remembered places and the plan', async () => {
    const dir = tempDir();
    const agent = makeAgent(dir);
    const h = new History(agent);
    h.max_messages = 1000;
    h.memory = 'remembered';
    await h.add('system', 'hello');
    agent.memory_bank.rememberPlace('home', 10, 64, -20);
    agent.plan.update('build a house', [
      { text: 'gather wood', done: true },
      { text: 'craft planks', done: false },
    ]);
    await h.save();

    // 全新对象、同一个落盘目录，模拟重启。
    const restarted = makeAgent(dir);
    const h2 = new History(restarted);
    const data = h2.load();

    expect(data?.taskStart).toBe(4242);
    expect(h2.memory).toBe('remembered');
    expect(h2.turns.map((t) => t.content)).toEqual(['hello']);
    expect(restarted.memory_bank.recallPlace('home')).toEqual([10, 64, -20]);
    expect(restarted.plan.snapshot()).toEqual({
      goal: 'build a house',
      todos: [
        { text: 'gather wood', done: true },
        { text: 'craft planks', done: false },
      ],
    });
  });

  it('loads a legacy save that has no places/plan keys', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'memory.json'),
      JSON.stringify({ memory: 'legacy memory', turns: [{ role: 'system', content: 'legacy' }], taskStart: 7 }),
      'utf8',
    );
    const restarted = makeAgent(dir);
    const h2 = new History(restarted);
    const data = h2.load();

    expect(data?.taskStart).toBe(7);
    expect(h2.memory).toBe('legacy memory');
    expect(h2.turns.map((t) => t.content)).toEqual(['legacy']);
    // 老存档没有这两段：安静跳过，不能抛错、也不能清空成 null。
    expect(restarted.memory_bank.getKeys()).toBe('');
    expect(restarted.plan.snapshot()).toEqual({ goal: null, todos: [] });
  });
});
