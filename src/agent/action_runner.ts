/*
 * 动作执行器：占用身体通道的工具调用即时返回，结果以后报。
 *
 * 两类工具，两种时间观：
 *   - 动作类（占身体）：认领通道 → 后台跑 → 立刻回 accepted；
 *     跑完（或炸了）检查 generation：过期了就地丢弃（Stop/急停
 *     已经让它失效），没过期才记结果、放通道、以 Tool 事件
 *     注入调度唤醒下一轮。
 *   - 查询类（只读）：阻塞执行，直接回内容——本来就是瞬间的事，
 *     整成异步事件没有意义。
 *
 * ActionManager 串行是底线（同一时刻最多一个身体动作），
 * generation 失效是保险（Stop/急停之后，在途的完成回调
 * 必须认得自己已经过期）：两个都要，缺一不可。
 */

import { Scheduler } from './scheduler.js';
import { MESSAGES } from '../prompts.js';
import { isActionTool, validateToolCall } from './commands/to_openai_tools.js';
import type { LoopToolResult } from './loop.js';

export interface ActionRunnerDeps {
  scheduler: Scheduler;
  /** 聊天历史写入（证据回填）。 */
  record: (outcome: string, name: string, args: unknown) => Promise<void>;
  /** 说话/广播。 */
  speak: (text: string) => void;
  /** 工具执行体（查询直调，动作后台跑）。 */
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** 执行完上报：进调度等下一轮。 */
  notify: (payload: { call: string; result: LoopToolResult }) => void;
}

export class ActionRunner {
  private scheduler: Scheduler;
  private record: (outcome: string, name: string, args: unknown) => Promise<void>;
  private speak: (text: string) => void;
  private execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  private notify: (payload: { call: string; result: LoopToolResult }) => void;

  constructor(deps: ActionRunnerDeps) {
    this.scheduler = deps.scheduler;
    this.record = deps.record;
    this.speak = deps.speak;
    this.execute = deps.execute;
    this.notify = deps.notify;
  }

  /** 跑一个工具调用：动作类即时回 accepted，查询类阻塞回内容。 */
  async run(name: string, args: unknown): Promise<LoopToolResult> {
    const checked = validateToolCall(name, args);
    if (!checked.ok) {
      const reason = checked.errors?.join('; ') ?? 'Bad arguments.';
      await this.record(`rejected: ${reason}`, name, args);
      return { status: 'rejected', code: checked.code ?? 'BAD_ARGS', reason };
    }
    if (!isActionTool(name)) {
      this.speak(MESSAGES.usedMarker(name));
      const data = await this.execute(name, args as Record<string, unknown>);
      await this.record(data, name, args);
      return { status: 'completed', data };
    }
    const claim = this.scheduler.startAction(name, args);
    if (!claim.accepted) {
      const running = this.scheduler.currentAction();
      // 幂等：被拒的这次**就是**正在跑的那个动作。
      // 模型被事件叫醒后常常把同一个动作再下一次，此时逼它 Stop
      // 就等于让它把自己正在做的事打断重来——正是"反复卡住"的来源。
      // 直接告诉它"已经在做了"，让它等结果。
      if (claim.code === 'ACTION_BUSY' && running != null && running.id === name) {
        const reason = `${name} 已经在跑了，不用重发，也不用 Stop——它跑完会自己报结果。`;
        await this.record(`already running: ${reason}`, name, args);
        return { status: 'accepted', data: { already_running: true, action_id: running.id, reason } };
      }
      // 确实是另一个动作：报清楚谁在跑、跑了多久，并把"要不要打断"
      // 交还给模型，而不是命令它先 Stop。
      const reason =
        running != null
          ? `另一个动作正在跑（${running.id}，已 ${Math.max(0, Math.round((Date.now() - running.startedAt) / 1000))} 秒）。` +
            `它会自己报结果；只有你确实要改做别的事时，才需要先 Stop。`
          : 'An action is already running. Stop() first, then retry.';
      await this.record(`rejected: ${reason}`, name, args);
      return { status: 'rejected', code: claim.code ?? 'ACTION_BUSY', reason };
    }
    const generation = claim.generation ?? 0;
    this.speak(MESSAGES.usedMarker(name));
    // 后台跑，不等：这一轮的推理到此结束，结果以后报。
    void this.finish(name, args as Record<string, unknown>, generation);
    return { status: 'accepted', data: { action_id: claim.actionId, generation } };
  }

  /**
   * 后台动作收尾：先看 generation——过期（被 Stop/急停作废）
   * 就地丢弃，不记账、不放行、不上报；没过期才记结果、
   * 放通道、注入事件。
   */
  private async finish(name: string, args: Record<string, unknown>, generation: number): Promise<void> {
    let data: string;
    try {
      data = await this.execute(name, args);
    } catch (err: unknown) {
      data = `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!this.scheduler.isCurrent(generation)) return;
    await this.record(data, name, args);
    this.scheduler.releaseAction();
    this.notify({ call: name, result: { status: 'completed', data } });
  }
}

export default { ActionRunner };
