import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/prompts.js';
import { Task, type TaskData } from '../src/agent/tasks/tasks.js';

const PROGRESS = './hells_kitchen_progress.json';
afterEach(() => rmSync(PROGRESS, { force: true }));

const data = (over: Record<string, unknown> = {}): TaskData =>
  ({
    task_id: 't1',
    type: 'cooking',
    goal: 'cook',
    timeout: 300,
    human_count: 0,
    usernames: [],
    agent_count: 1,
    ...over,
  }) as unknown as TaskData;

const agent = (over: Record<string, unknown> = {}) => ({
  name: 'botty',
  count_id: 0,
  bot: { inventory: { slots: [] } },
  handleMessage: vi.fn(),
  ...over,
});

describe('Task construction', () => {
  it('handles missing task data', () => {
    const t = new Task(agent(), null);
    expect(t.data).toBeNull();
    expect(t.validator).toBeNull();
    expect(t.blocked_actions).toEqual([]);
    expect(t.name).toBe('botty');
  });

  it('builds construction goals with the blueprint explanation', () => {
    const t = new Task(
      agent(),
      data({
        type: 'construction',
        goal: 'build it',
        blueprint: { levels: [{ level: 0, coordinates: [1, 2, 3], placement: [['stone']] }] },
      }),
    );
    expect(t.task_type).toBe('construction');
    expect(t.goal).toContain('build it');
    expect(t.goal).toContain('Level 0: Start at coordinates X: 1, Y: 2, Z: 3');
    expect(t.goal).toContain('lower levels');
    expect(t.validator).not.toBeNull();
  });

  it('picks validators by type', () => {
    expect(new Task(agent(), data({ type: 'cooking' })).validator).not.toBeNull();
    expect(new Task(agent(), data({ type: 'techtree' })).validator).not.toBeNull();
    expect(new Task(agent(), data({ type: 'unknown-xyz' })).validator).toBeNull();
  });

  it('resolves per-agent blocked actions', () => {
    const t = new Task(
      agent({ count_id: 1 }),
      data({ blocked_actions: { '0': ['!a'], '1': ['!b'] } }),
    );
    expect(t.blocked_actions).toEqual(['!b']);
  });

  it('defaults blocked actions when absent', () => {
    expect(new Task(agent(), data()).blocked_actions).toEqual([]);
  });

  it('records restrict_to_inventory', () => {
    expect(new Task(agent(), data({ restrict_to_inventory: true })).restrict_to_inventory).toBe(
      true,
    );
  });
});

describe('getAgentGoal', () => {
  it('returns null without data or goal', () => {
    expect(new Task(agent(), null).getAgentGoal()).toBeNull();
    expect(new Task(agent(), data({ goal: '' })).getAgentGoal()).toBeNull();
  });

  it('shares string goals with every agent', () => {
    expect(new Task(agent(), data({ goal: 'cook' })).getAgentGoal()).toBe(
      'cook\nIn the end, all the food items should be given to one single bot.',
    );
  });

  it('adds the single-bot serving note for plain cooking tasks', () => {
    expect(new Task(agent(), data({ goal: 'cook' })).getAgentGoal()).toContain(
      'given to one single bot',
    );
  });

  it('skips the serving note for hells_kitchen tasks', () => {
    const t = new Task(agent(), data({ task_id: 'x_hells_kitchen', goal: 'cook' }));
    expect(t.getAgentGoal()).toBe('cook');
  });

  it('selects the goal by count_id for object goals', () => {
    const t = new Task(agent({ count_id: 1 }), data({ goal: { '0': 'a', '1': 'b' } }));
    expect(t.getAgentGoal()).toContain('b');
  });

  it('returns empty-augmented string for missing count_id entries', () => {
    const t = new Task(agent({ count_id: 9 }), data({ goal: { '0': 'a' } }));
    expect(t.getAgentGoal()).toContain('one single bot');
  });
});

describe('setAgentGoal', () => {
  it('delivers the goal as a system message', async () => {
    const a = agent();
    await new Task(a, data({ goal: 'cook' })).setAgentGoal();
    expect(a.handleMessage).toHaveBeenCalledWith('system', MESSAGES.taskGoal('cook\nIn the end, all the food items should be given to one single bot.'));
  });

  it('stays silent without a goal', async () => {
    const a = agent();
    await new Task(a, null).setAgentGoal();
    expect(a.handleMessage).not.toHaveBeenCalled();
  });
});

describe('cooking validation through isDone', () => {
  const cookingTask = (slots: Array<{ name: string; count: number }>, over = {}) =>
    new Task(agent({ bot: { inventory: { slots } } }), data({ target: 'stone', ...over }));

  it('succeeds with score 1 when items are present', () => {
    expect(cookingTask([{ name: 'Stone', count: 2 }]).isDone()).toEqual({
      message: 'Task successful',
      score: 1,
    });
  });

  it('keeps waiting when items are missing', () => {
    // far-future start + long timeout => still running
    expect(cookingTask([], { timeout: 3600 }).isDone()).toBe(false);
  });

  it('times out with the partial score', () => {
    const t = cookingTask([], { timeout: 300 });
    t.taskStartTime = Date.now() - 400_000;
    expect(t.isDone()).toEqual({ message: 'Task timeout reached', score: 0 });
  });

  it('times out without a validator at score 0', () => {
    const t = new Task(agent(), data({ type: 'unknown-xyz', timeout: 1 }));
    t.taskStartTime = Date.now() - 5_000;
    expect(t.isDone()).toEqual({ message: 'Task timeout reached', score: 0 });
  });

  it('matches case-insensitively and counts quantities', () => {
    const t = cookingTask([{ name: 'STONE', count: 1 }], {
      target: { stone: 2 },
    });
    expect(t.isDone()).toBe(false);
  });
});

describe('hells_kitchen progress', () => {
  const hk = (count_id: number, slots: Array<{ name: string; count: number }>) =>
    new Task(agent({ count_id, bot: { inventory: { slots } } }), data({
      task_id: 'x_hells_kitchen',
      target: ['apple', 'bread'],
    }));

  it('succeeds only when both agents finished', () => {
    // NOTE: constructing a Task resets the shared progress file, mirroring
    // production where each agent process builds its own Task at startup.
    // Both Tasks must exist before either one validates.
    const t0 = hk(0, [{ name: 'apple', count: 1 }]);
    const t1 = hk(1, [{ name: 'bread', count: 1 }]);
    expect(t0.isDone()).toBe(false);
    expect(t1.isDone()).toEqual({
      message: 'Task successful',
      score: 1,
    });
  });
});
