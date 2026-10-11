/**
 * 接线层回归 + §10 的 C3 / E4。
 *
 * `runtime_action_boundary.test.ts` 钉的是**契约**（ActionRunner/Scheduler 的
 * 行为），但它在契约层**测不出**"工具的 execute 有没有真的走身体通道"。
 * 这个文件补上那个缺口：它跑的是 `agent.ts::invokeTool` 用的**同一个函数**
 * （`actionChannelInvoker`），所以直连 `executeToolCall` 的回归会在这里红。
 */
import { describe, expect, it } from 'vitest';
import { ActionRunner } from '../src/agent/action_runner.js';
import { Scheduler } from '../src/agent/scheduler.js';
import { renderLiveState, sampleLiveState } from '../src/agent/live_state.js';
import { actionChannelInvoker, buildGameTools } from '../src/runtime/game_tools.js';
import { composeLiveTail } from '../src/runtime/perception.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Rig {
  scheduler: Scheduler;
  tools: ReturnType<typeof buildGameTools>;
  release: () => void;
}

function makeRig(): Rig {
  const scheduler = new Scheduler();
  const gate = deferred();
  const runner = new ActionRunner({
    scheduler,
    record: () => Promise.resolve(),
    speak: () => {},
    execute: (name) =>
      name === 'followPlayer'
        ? gate.promise.then(() => '跟随中')
        : Promise.resolve(`${name} 完成`),
    notify: () => {},
  });
  // 与 agent.ts::invokeTool 完全同一条路径
  const tools = buildGameTools({ execute: actionChannelInvoker(runner) });
  return { scheduler, tools, release: gate.resolve };
}

function tool(rig: Rig, name: string): NonNullable<ReturnType<typeof buildGameTools>[number]> {
  const found = rig.tools.find((candidate) => candidate.name === name);
  if (found == null) throw new Error(`工具 ${name} 不在装配结果里`);
  return found;
}

async function call(rig: Rig, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await tool(rig, name).execute(args, {} as never, {} as never)) as {
    content: Array<{ text: string }>;
  };
  return result.content[0]?.text ?? '';
}

describe('接线：动作类工具真的占用了身体通道', () => {
  it('followPlayer 走通道后，Scheduler 认领了动作', async () => {
    const rig = makeRig();
    const text = await call(rig, 'followPlayer', { player_name: 'bobo', follow_dist: 3 });

    // 这一条是"接线没被绕过"的证据：直连 executeToolCall 的话通道是空的
    expect(rig.scheduler.currentAction()?.id).toBe('followPlayer');
    // 回执文本与旧 runTool 逐字一致（工具 X {args} → 认领信息）
    expect(text).toContain('工具 followPlayer');
    expect(text).toContain('action_id');
    rig.release();
  });

  it('查询类工具不占通道，直接回内容', async () => {
    const rig = makeRig();
    const text = await call(rig, 'getCraftingPlan', { targetItem: 'oak_planks' });
    expect(rig.scheduler.currentAction()).toBeNull();
    expect(text).toContain('getCraftingPlan 完成');
  });

  it('忙时同动作：走通道后仍是幂等回执，不催 Stop', async () => {
    const rig = makeRig();
    await call(rig, 'followPlayer', { player_name: 'bobo', follow_dist: 3 });
    const again = await call(rig, 'followPlayer', { player_name: 'bobo', follow_dist: 3 });
    expect(again).toContain('already_running');
    expect(again).not.toContain('Stop() first');
    expect(rig.scheduler.currentAction()?.id).toBe('followPlayer');
    rig.release();
  });
});

describe('E4：Stop 说真话（本来没在跑时）', () => {
  it('没动作时如实回报 had_action=false', () => {
    const rig = makeRig();
    expect(rig.scheduler.stopAll()).toMatchObject({ hadAction: false, actionId: null });
  });

  it('有动作时回报 had_action=true 并给出动作名', async () => {
    const rig = makeRig();
    await call(rig, 'followPlayer', { player_name: 'bobo', follow_dist: 3 });
    expect(rig.scheduler.stopAll()).toMatchObject({ hadAction: true, actionId: 'followPlayer' });
    expect(rig.scheduler.currentAction()).toBeNull();
    rig.release();
  });
});

describe('C3：stats 与每轮尾巴同源', () => {
  const sample = {
    bot: {
      entity: { position: { x: 1.5, y: 64, z: -2.5 }, yaw: 0, pitch: 0 },
      health: 20,
      food: 18,
    },
    goal: '造房子',
    todos: [{ text: '砍树', done: true }],
  };

  it('同一份采样：尾巴里**逐字包含** stats 的正文', () => {
    // stats 工具把 liveStateText() 作为 Tool 回执留在上下文里（永久留存），
    // 尾巴每轮现采——两者必须是同一份采样，否则模型会看到两份互相矛盾的状态。
    const statsText = renderLiveState(sampleLiveState(sample));
    const tail = composeLiveTail(sample);
    expect(tail).toContain(statsText);
  });

  it('尾巴仍然带自己的标题（stats 回执不带）', () => {
    const tail = composeLiveTail(sample);
    expect(tail.startsWith('## 当前世界快照\n')).toBe(true);
    expect(renderLiveState(sampleLiveState(sample))).not.toContain('## 当前世界快照');
  });
});
