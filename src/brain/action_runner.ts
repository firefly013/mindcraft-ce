/*
 * 动作执行器：占用身体通道的工具调用即时返回，结果以后报。
 *
 * 两类工具，两种时间观：
 *   - 动作类（占身体）：认领通道 → 后台跑 → 立刻回 accepted，带本次调用的
 *     call_id/generation；跑完（或炸了）检查 generation：过期了就只报一条
 *     「被中断、没有结果」（Stop/急停已经让它失效），没过期才记结果、放通道、
 *     以 Tool 事件注入调度唤醒下一轮。两条回执都带同一个 call_id，模型才能
 *     在结果乱序/延迟时认出是哪一次调用交出来的。
 *   - 查询类（只读）：阻塞执行，直接回内容——本来就是瞬间的事，
 *     整成异步事件没有意义。
 *
 * ActionManager 串行是底线（同一时刻最多一个身体动作），
 * generation 失效是保险（Stop/急停之后，在途的完成回调
 * 必须认得自己已经过期）：两个都要，缺一不可。
 */

import { Scheduler } from './scheduler.js';
import { MESSAGES } from '../shared/prompts.js';
import type { ToolCatalog } from './tools/catalog.js';
import { isActionTool, validateToolCall } from './tools/validate.js';
import type { ToolOutcome } from './tools/tools.js';

/**
 * 身体通道上发生的事，供观测（日志 / 测试）。
 *
 * 这些正是 E1–E4 那套契约的**行为证据**：以前全是静默的，模型看不见、
 * 排错时也看不见。
 */
export type ActionTrace =
  | { kind: 'query'; name: string }
  | { kind: 'claim'; name: string; actionId: string; generation: number }
  | { kind: 'busy_same'; name: string; actionId: string }
  | { kind: 'busy_other'; name: string; running: string; runningSeconds: number }
  | { kind: 'done'; name: string; actionId: string }
  | { kind: 'stale_discarded'; name: string };

/**
 * 一次动作完成的回执载荷。
 *
 * `call_id` 是这一次调用的唯一标识，`generation` 是调度器那一代。
 * 两者一起放进事件里，模型才能在回执乱序/延迟时认出「这条结果是哪一次调用交出来的」。
 */
export interface ActionNotice {
  call: string;
  action_id: string;
  call_id: string;
  generation: number;
  result: ToolOutcome;
}

/** 动作跑太久没有任何结果时，主动发一条进度回执的间隔（毫秒）。 */
export const ACTION_PROGRESS_NOTICE_MS = 60_000;

/**
 * 身体侧单个动作的**最长**超时（分钟）。
 *
 * 现在最长的是 `exploreFor` 8 分钟（`body/commands/progression.ts` 的
 * `runProgressionAction('exploreFor', 8, …)`）；`huntFor` 的 `max_ms` 自带
 * 7 分钟上限（progression.ts 注释写明"避免撞上动作通道的 8 分钟超时"）；
 * `collectBlocks` 6 分钟、`goToCoordinates` / `enterNether` 5 分钟、
 * `pillarUp` / `stairUp` 4 分钟，其余默认 2 分钟（`DEFAULT_ACTION_TIMEOUT_MIN`）。
 * **哪个动作的超时调大了，这里必须跟着抬。**
 */
export const BODY_ACTION_TIMEOUT_MAX_MIN = 8;

/**
 * 动作在脑侧的最长挂起时间；到点强制释放动作通道。
 *
 * **推导：必须略长于身体侧最长的一个动作超时。** 目前最长是 `exploreFor` 8 分钟，
 * 所以取 8 分 30 秒。这是"身体彻底没回来"（幽灵锁）的最后保险丝，不是常规收尾
 * 手段——身体侧自己会在超时时带原因回来。
 * ⚠️ **真实事故（2026-10-18 13:12，overnight_b）**：这里曾按 collectBlocks 的
 * 6 分钟取 6.5 分钟，结果 `exploreFor`（文档写最长 8 分钟）在 6.5 分钟被强退，
 * 模型收到"超过 6.5 分钟没有返回，已强制释放"——它以为工具坏了，而且拿不到
 * 阶段性结论。保险丝**低于**身体超时就是在制造幽灵锁：大脑释放通道、身体还在跑。
 * 所以：涨身体超时 → 必须同步涨这里；宁可保险丝长一点，也不要误杀正常动作。
 * 长期修法是让身体在握手声明里带上自己的超时、大脑按动作推导保险丝（接口变更，
 * 记为设计债）。
 */
export const ACTION_MAX_MS = (BODY_ACTION_TIMEOUT_MAX_MIN * 60 + 30) * 1000;

export interface ActionRunnerDeps {
  scheduler: Scheduler;
  /**
   * 工具目录：**只读身体握手里报上来的声明**。参数校验与"这条工具占不占身体
   * 通道"都从它查——大脑手里没有命令表，也不该有。
   */
  catalog: ToolCatalog;
  /** 聊天历史写入（证据回填）。 */
  record: (outcome: string, name: string, args: unknown) => Promise<void>;
  /** 说话/广播。 */
  speak: (text: string) => void;
  /** 工具执行体（查询直调，动作后台跑）。 */
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** 执行完上报：进调度等下一轮。 */
  notify: (payload: ActionNotice) => void;
  /** 可选：通道观测。缺省什么都不做。 */
  trace?: (event: ActionTrace) => void;
}

export class ActionRunner {
  private scheduler: Scheduler;
  private catalog: ToolCatalog;
  private record: (outcome: string, name: string, args: unknown) => Promise<void>;
  private speak: (text: string) => void;
  private execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  private notify: (payload: ActionNotice) => void;
  private trace: (event: ActionTrace) => void;
  /** 只用于生成 `call_id`；不参与调度，也不影响 generation 的失效语义。 */
  private callSeq = 0;
  /** 当前认领通道的那次调用的标识；用于同动作幂等回执。 */
  private activeCallId: string | null = null;
  private activeGeneration = 0;

  constructor(deps: ActionRunnerDeps) {
    this.scheduler = deps.scheduler;
    this.catalog = deps.catalog;
    this.record = deps.record;
    this.speak = deps.speak;
    this.execute = deps.execute;
    this.notify = deps.notify;
    this.trace = deps.trace ?? ((): void => {});
  }

  /** 跑一个工具调用：动作类即时回 accepted，查询类阻塞回内容。 */
  async run(name: string, args: unknown): Promise<ToolOutcome> {
    const checked = validateToolCall(this.catalog, name, args);
    if (!checked.ok) {
      const reason = checked.errors?.join('; ') ?? 'Bad arguments.';
      this.trace({ kind: 'query', name });
      await this.record(`rejected: ${reason}`, name, args);
      return { status: 'rejected', code: checked.code ?? 'BAD_ARGS', reason };
    }
    if (!isActionTool(this.catalog, name)) {
      this.trace({ kind: 'query', name });
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
        this.trace({ kind: 'busy_same', name, actionId: running.id });
        const runningSeconds = Math.max(0, Math.round((Date.now() - running.startedAt) / 1000));
        const reason =
          name + ' 已经在跑了，不用重发，也不用 Stop——它跑完会自己报结果。' +
          '（占用者 ' + running.id + '，generation ' + String(running.generation) + '，已 ' + String(runningSeconds) + ' 秒）';
        await this.record(`already running: ${reason}`, name, args);
        return {
          status: 'accepted',
          data: {
            already_running: true,
            action_id: running.id,
            call_id: this.activeCallId ?? running.id,
            generation: running.generation,
            running_for_seconds: runningSeconds,
            reason,
          },
        };
      }
      // 确实是另一个动作：报清楚谁在跑、跑了多久，并把"要不要打断"
      // 交还给模型，而不是命令它先 Stop。
      this.trace({
        kind: 'busy_other',
        name,
        running: running?.id ?? '(unknown)',
        runningSeconds:
          running == null ? 0 : Math.max(0, Math.round((Date.now() - running.startedAt) / 1000)),
      });
      const runningSeconds = running == null ? 0 : Math.max(0, Math.round((Date.now() - running.startedAt) / 1000));
      const reason =
        running != null
          ? `另一个动作正在跑（${running.id}，generation ${String(running.generation)}，已 ${String(runningSeconds)} 秒）。` +
            `它会自己报结果；只有你确实要改做别的事时，才需要先 Stop。`
          : 'An action is already running. Stop() first, then retry.';
      await this.record(`rejected: ${reason}`, name, args);
      return { status: 'rejected', code: claim.code ?? 'ACTION_BUSY', reason };
    }
    const generation = claim.generation ?? 0;
    const callId = `${name}#${++this.callSeq}`;
    this.activeCallId = callId;
    this.activeGeneration = generation;
    this.trace({ kind: 'claim', name, actionId: claim.actionId ?? name, generation });
    this.speak(MESSAGES.usedMarker(name));
    // 后台跑，不等：这一轮的推理到此结束，结果以后报。
    void this.finish(name, args as Record<string, unknown>, generation, callId);
    return {
      status: 'accepted',
      data: {
        action_id: claim.actionId,
        call_id: callId,
        generation,
        // 明确告诉模型：这不是最终结果，真正的回执会带同一个 call_id 回来。
        note: `动作已开始；结束/失败/被中断时会以 Tool 事件回报，事件里带同一个 call_id=${callId}。`,
      },
    };
  }

  /**
   * 后台动作收尾：先看 generation——过期（被 Stop/急停作废）
   * 就地丢弃，不记账、不放行、不上报；没过期才记结果、
   * 放通道、注入事件。
   */
  private async finish(
    name: string,
    args: Record<string, unknown>,
    generation: number,
    callId: string,
  ): Promise<void> {
    const startedAt = Date.now();
    // 大范围搜索/长距离移动可能几分钟才返回：身体还在跑，但模型此前只能看到
    // accepted 后的一片沉默。大脑侧每 60 秒发一条「还在跑」的进度回执，保证任何
    // 路径至少有一个明确交代；动作真正结束/失败时下面照旧会覆盖报结果。
    const progressTimer = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      this.notify({
        call: name,
        action_id: name,
        call_id: callId,
        generation,
        result: {
          status: 'accepted',
          data:
            `[${callId} · generation ${generation}] ${name} 还在跑（已 ${seconds} 秒，尚未返回结果）。` +
            '如果它在做大范围搜索或长距离移动，可以继续等；如果要改做别的，可以 Stop。',
        },
      });
    }, ACTION_PROGRESS_NOTICE_MS);
    // **最后保险丝**：身体侧长时间不返回时，动作通道不能永久泄漏。
    // 真机出现过 currentAction 卡住、快照却显示 idle 的幽灵锁；到点强制释放，
    // 让模型至少能继续发动作（身体侧自己的 action 超时会负责收手）。
    const watchdog = setTimeout(() => {
      const running = this.scheduler.currentAction();
      if (running == null || running.id !== name) return;
      this.scheduler.stopAll();
      this.notify({
        call: name,
        action_id: name,
        call_id: callId,
        generation,
        result: {
          status: 'completed',
          data:
            `[${callId} · generation ${generation}] ${name} 超过 ${ACTION_MAX_MS / 60000} 分钟没有返回，` +
            '已强制释放动作通道；它可能仍在跑，请先用 Stop 或 stats 核对，不要盲目重发。',
        },
      });
    }, ACTION_MAX_MS);
    let data: string;
    try {
      data = await this.execute(name, args);
    } catch (err: unknown) {
      data = `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearInterval(progressTimer);
      clearTimeout(watchdog);
    }
    // 过期（被 Stop / 急停作废）：就地丢弃，不记账、不放行。
    // **但仍然报一条**：动作没了、通道空了，模型却看不到任何交代，只能反复拍
    // 快照猜——它反馈过这件事（"viewChest / goToSurface 调用后再无音讯，
    // 我不知道它是成功、失败还是被中断"）。报的是"被中断、没有结果"，
    // 不假装成功。
    if (!this.scheduler.isCurrent(generation)) {
      const why = this.scheduler.lastInvalidationReason();
      this.trace({ kind: 'stale_discarded', name });
      this.clearActiveCall(callId);
      // **保命反射不是 Stop**：Feedback #22 里模型从未调 Stop，却读到 Stop 字样。
      // 而且保命反射有时只是在旁边响了，身体其实已经把搜索跑完了——这种情况下
      // 把结果丢掉等于让普通动作被无关急停误伤。保命原因 + 有结果时保留结果并注明。
      if (why === 'emergency' && data.trim() !== '') {
        await this.record(data, name, args);
        this.notify({
          call: name,
          action_id: name,
          call_id: callId,
          generation,
          result: {
            status: 'completed',
            data:
              `[${callId} · generation ${generation}] 动作期间发生了保命反射（不是你调用的 Stop），` +
              `但身体仍返回了结果，供参考：${data}`,
          },
        });
        return;
      }
      const reasonText =
        why === 'emergency'
          ? '保命反射/急停抢走了身体（不是你调用的 Stop）'
          : why === 'stop'
            ? 'Stop 停掉了它'
            : 'generation 失效（可能被 Stop/急停/新动作作废）';
      this.notify({
        call: name,
        action_id: name,
        call_id: callId,
        generation,
        result: {
          status: 'completed',
          data: `动作 ${name}（${callId}）被中断：${reasonText}，没有结果。` +
            '通道已经释放，可以开始下一个动作。',
        },
      });
      return;
    }
    const text = this.completionText(name, callId, generation, data);
    await this.record(text, name, args);
    this.scheduler.releaseAction();
    this.clearActiveCall(callId);
    this.trace({ kind: 'done', name, actionId: name });
    this.notify({
      call: name,
      action_id: name,
      call_id: callId,
      generation,
      result: { status: 'completed', data: text },
    });
  }

  /** 该次调用已经结束，别再把它当成正在跑的那一次。 */
  private clearActiveCall(callId: string): void {
    if (this.activeCallId === callId) {
      this.activeCallId = null;
      this.activeGeneration = 0;
    }
  }

  /**
   * 动作完成回执的统一渲染。
   *
   * 身体返回空串并不等于什么都没发生（成功但没写日志、被中断、被自动拾取
   * 抢走身体都会这样）。这里必须把空结果翻成一句模型能行动的话，不能把
   * (no output) 或空事件丢回去让它继续猜。
   */
  private completionText(name: string, callId: string, generation: number, data: unknown): string {
    const raw = typeof data === 'string' ? data.trim() : data == null ? '' : String(data);
    const header = `[${callId} · generation ${generation}]`;
    if (raw !== '' && raw !== '(no output)') return `${header} ${raw}`;
    const hint =
      name === 'searchForBlock'
        ? 'searchForBlock 没有得到明确结果，不能确认是否找到目标（可能被中断）。' +
          '请用 stats 看当前位置和背包，再决定是否重试。'
        : `${name} 已经结束，但身体没有返回具体结果（可能动作已完成但没写日志，或被 autoPickup / Stop 打断了）。` +
          '请用 stats 核对当前位置与背包后再决定是否重试。';
    return `${header} ${hint}`;
  }
}

export default { ActionRunner };
