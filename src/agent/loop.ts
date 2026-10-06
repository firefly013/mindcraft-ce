/*
 * Agent 循环：一轮 API 请求 -> 若干工具调用 -> Finish，再下一轮。
 *
 * 一次 handleDecision 处理一个调度 verdict。一轮是：拿走本请求还没
 * 见过的事件，组装上下文（历史尾巴 + 新鲜 Live State），问模型，
 * 按顺序跑它的 calls，结果回填，再问——直到模型调 `Finish()` 或
 * 者一个 call 都不调。然后 finishRequest 决定 idle 还是再来一轮。
 *
 * 循环自己干不了的事全是注入的：model（调模型）、assemble（组
 * 上下文兼采 Live State）、runner（跑 tool）、stopExecutor
 * （`Stop()` 停什么）、emergencyHandler（L5 硬逻辑）。于是整个
 * 循环可以用剧本模型测，不用起服。
 *
 * 顺序规则在这里收口，因为只有这里按序看到每一个 call：
 * 同一响应里 `Finish()` 后面的 calls 一律拒绝执行（`Finish` 终结
 * 本轮，后面的东西属于一个永远不会存在的轮次）；请求被抢占后
 * 才回来的响应整体作废、一个 call 都不跑（重启已经带走了事件，
 * 跑两遍就是 double-act）。
 */

import { Scheduler } from './scheduler.js';
import type { Level } from './scheduler.js';

export interface LoopModelCall {
  name: string;
  args: any;
}

export interface LoopModelResponse {
  text: string | null;
  calls: LoopModelCall[];
}

export interface LoopToolResult {
  status: 'accepted' | 'completed' | 'rejected';
  data?: any;
  code?: string;
  reason?: string;
}

export interface LoopRunner {
  call(name: string, args: unknown): Promise<LoopToolResult>;
  register(name: string, handler: (args: unknown) => Promise<LoopToolResult>): void;
}

export interface LoopHistory {
  append(kind: string, level: number, payload: unknown): void;
}

export interface LoopAssembled {
  text: string;
  tools: any;
  /** 本轮现拍示意图（base64 JPEG），没有就 null，调用方直接跳过。 */
  image?: string | null;
}

export interface AgentLoopDeps {
  scheduler: Scheduler;
  runner: LoopRunner;
  history: LoopHistory;
  assemble: (events: unknown[]) => LoopAssembled | Promise<LoopAssembled>;
  /**
   * `tool_choice` 不在这里传：prompter 固定用 `required`（模型每轮至少调一个
   * 工具、以 Finish 收尾，空响应卡不住循环）。以前这里有个 `toolChoice`
   * 形参，但没有任何生产者、下游也是 `void` 掉，纯死路径。
   */
  model: (text: string, tools: unknown, image?: string | null) => Promise<LoopModelResponse>;
  stopExecutor?: (() => Promise<void>) | null;
  emergencyHandler?: (() => Promise<void>) | null;
}

export class AgentLoop {
  private scheduler: Scheduler;
  private runner: LoopRunner;
  private history: LoopHistory;
  private assemble: (events: unknown[]) => LoopAssembled | Promise<LoopAssembled>;
  private model: (text: string, tools: unknown, image?: string | null) => Promise<LoopModelResponse>;
  private stopExecutor: (() => Promise<void>) | null;
  private emergencyHandler: (() => Promise<void>) | null;
  rounds = 0;

  constructor(deps: AgentLoopDeps) {
    this.scheduler = deps.scheduler;
    this.runner = deps.runner;
    this.history = deps.history;
    this.assemble = deps.assemble;
    this.model = deps.model;
    this.stopExecutor = deps.stopExecutor ?? null;
    this.emergencyHandler = deps.emergencyHandler ?? null;

    this.runner.register('Stop', async () => {
      // 先失效 generation：在途的完成回调看到过期会就地丢弃，
      // 再去停身体——顺序反了就会漏一条过期结果进下一轮。
      const stopped = this.scheduler.stopAll();
      await this.stopExecutor?.();
      this.history.append('Model', 2, { stopped: true, generation: stopped.generation });
      return { status: 'completed', data: { stopped: true, generation: stopped.generation } };
    });
    this.runner.register('Finish', () => Promise.resolve({ status: 'completed', data: { finish: true } }));
  }

  /** 外部事件入库并分发，返回调度 verdict。 */
  notify(event: { kind: 'User' | 'World' | 'Tool' | 'Model'; level: Level; payload: unknown }): {
    decision: string;
    seq: number;
  } {
    this.history.append(event.kind, event.level, event.payload);
    return this.scheduler.pushEvent(event);
  }

  /** 执行器异步消息：一律按 level-3 Tool 事件重进循环。 */
  notifyAction(payload: unknown): { decision: string; seq: number } {
    return this.notify({ kind: 'Tool', level: 3, payload });
  }

  /** 按一个调度 verdict 行动。 */
  async handleDecision(decision: string): Promise<void> {
    if (decision === 'start' || decision === 'preempt') {
      await this.runRound();
      return;
    }
    if (decision === 'emergency') {
      await this.emergencyHandler?.();
      const next = this.scheduler.endEmergency();
      if (next.decision === 'start') await this.runRound();
      return;
    }
    // 'stored'、'queued'、'idle'、'stale'：等新东西来再说。
  }

  /** 一轮或多轮模型回合直到收敛，再跟调度器结算。 */
  async runRound(): Promise<void> {
    for (;;) {
      const begun = this.scheduler.beginRequest();
      if (begun.reused) return;
      this.rounds++;
      const context = await this.assemble(begun.events);
      // tool_choice 由 prompter 固定为 required：模型必须至少调一个工具
      // （以 Finish 收尾），空响应永远卡不住循环。thinking 类开关保持关闭
      // ——有些网关对 required+thinking 直接回 400。
      const response = await this.model(context.text, context.tools, context.image ?? null);
      if (this.scheduler.describe().currentRequestId !== begun.requestId) {
        // 模型思考期间被抢占：事件归重启了，这个响应整体作废。
        return;
      }
      if (response?.text) this.history.append('Model', 2, { text: response.text });
      const calls = response?.calls ?? [];
      await this.runCalls(calls);
      const settled = this.scheduler.finishRequest(begun.requestId);
      if (settled.decision !== 'start') return;
      // 本轮中途来了新事件、调度器要再来一轮：循环，新请求只带还没见过的。
    }
  }

  /**
   * 按序跑一个响应的 calls，返回是否遇到过 `Finish()`。
   * `Finish()` 后面的东西当场拒绝：轮次已经结束，跑它们等于
   * 给不存在的轮次打工。
   */
  async runCalls(calls: LoopModelCall[]): Promise<boolean> {
    let finishRequested = false;
    for (const call of calls) {
      if (finishRequested) {
        this.history.append('Model', 2, {
          rejected: call.name,
          code: 'AFTER_FINISH',
          reason: 'The round ended at Finish().',
        });
        continue;
      }
      this.history.append('Model', 2, { call: call.name, args: call.args });
      const result = await this.runner.call(call.name, call.args);
      this.history.append('Tool', 2, { call: call.name, result });
      if (call.name === 'Finish' && result.status === 'completed') finishRequested = true;
    }
    return finishRequested;
  }
}

export default AgentLoop;
