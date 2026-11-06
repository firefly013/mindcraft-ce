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
import type { CurrentAction } from './scheduler.js';
import type { ToolCatalog } from './tools/catalog.js';
import { isActionTool, validateToolCall } from './tools/validate.js';
import type { ToolOutcome } from './tools/tools.js';
import { describeResumeArgs, parseTunnelDirection, resumeItemForBlock, type ResumePolicy } from '../shared/resume.js';

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
  | { kind: 'stale_discarded'; name: string }
  | { kind: 'resumed'; name: string; callId: string; generation: number }
  | { kind: 'resume_dropped'; name: string; reason: string };

/**
 * 续做基线：认领动作时抓一份进度，被打断后据此折算"还剩多少"。
 *
 * 只有 `checkpoint` 类的动作需要它；`auto` 原样重发即可，`manual` 不续做。
 *
 * 三种"进度"形态：
 *   - `count`  ：按背包计数（collectBlocks 挖的是掉落物）；
 *   - `depth`  ：按**原始终点**的 Y 坐标（digDown 向下 / stairUp / pillarUp 向上）；
 *   - `tunnel` ：按**原始终点**的水平坐标（mineTunnel；方向没给时用实际位移推断）。
 *
 * 位置类基线是**异步抓的**（身体在另一个进程，只能 `bodyPosition()` 采样），
 * 所以这里存的是 Promise，续做时再 await。
 */
export type ResumeBaseline =
  | { kind: 'count'; item: string; target: number; start: number }
  | { kind: 'depth'; sign: 1 | -1; targetY: number }
  | { kind: 'tunnel'; start: { x: number; z: number }; length: number; axis: 'x' | 'z' | null; sign: 1 | -1 | 0 }
  | null;

/** 被反射打断、等着续做的那一次调用。 */
export interface InterruptedAction {
  name: string;
  args: Record<string, unknown>;
  callId: string | null;
  generation: number;
  policy: ResumePolicy;
  /** 进度基线（位置类要等身体采样，所以是 Promise）。 */
  baseline: Promise<ResumeBaseline>;
}

/** 续做事件（`action.resumed`）：只记录、不唤醒，模型下一轮自然会看到。 */
export interface ResumeNotice {
  call: string;
  action_id: string;
  call_id: string | null;
  /** 是否真的重新发起了一次调用。 */
  resumed: boolean;
  /** 续做用的参数（没续做时 null）。 */
  args: Record<string, unknown> | null;
  detail: string;
}

/**
 * 距离型动作 → 续做基线怎么算。
 *
 * `sign = -1` 向下（digDown），`+1` 向上（stairUp / pillarUp）；
 * 目标点 = 认领时的位置 + sign × 原距离，续做时按"还差多少到目标点"折算。
 */
const DEPTH_RESUME_SPECS: Readonly<Record<string, { arg: string; sign: 1 | -1 }>> = Object.freeze({
  digDown: { arg: 'distance', sign: -1 },
  stairUp: { arg: 'distance', sign: 1 },
  pillarUp: { arg: 'distance', sign: 1 },
});

/**
 * **任何工具回执的硬上限。这是最后一道防线，不是装饰。**
 *
 * 真机事故（2026-10-18 19:19，overnight_a）：`huntFor` 内部去调 `attack` 时参数名写错，
 * 每次攻击都当场失败 → 它在循环里疯狂重试（日志里数到 315 万次迭代）→
 * **一条回执堆到 135,750,954 字符**（1.35 亿）。一轮对话的上下文当场被撑爆，
 * 模型再也读不到别的东西，而回执末尾那句"下一步"还是同一个会再爆一次的调用。
 *
 * overnight_b 之前也撞过"6100 万字符回执"，当时被记成"聊太久导致的上下文溢出"
 * ——其实**同一个病**。（这就是 F-21 那条压缩死锁的上游真凶之一。）
 *
 * 纪律：**谁能生成字符串，谁就必须被截断。** 具体动作该有重试上限是它自己的事，
 * 但"回执不许无限长"是这里的事——两者都要有，因为前者总会漏。
 */
export const MAX_ACTION_OUTPUT_CHARS = 20_000;
const TRUNCATE_KEEP_HEAD = 9_000;
const TRUNCATE_KEEP_TAIL = 9_000;

/**
 * 截断策略是**留头留尾**：头部是"发生了什么"，尾部是最后一个可核对的事实，
 * 中间那几百万次重复的失败全部丢掉。截断本身必须**明说**，绝不悄悄吞内容。
 */
export function clampActionOutput(data: string): string {
  if (data.length <= MAX_ACTION_OUTPUT_CHARS) return data;
  const head = data.slice(0, TRUNCATE_KEEP_HEAD);
  const tail = data.slice(-TRUNCATE_KEEP_TAIL);
  const dropped = data.length - head.length - tail.length;
  return (
    `${head}\n\n……内容太长，中间截掉了 ${dropped.toLocaleString('en-US')} 个字符，` +
    `原文一共 ${data.length.toLocaleString('en-US')} 个字符……\n\n${tail}`
  );
}

/**
 * 一次动作完成的回执载荷。
 *
 * `call_id` 是这一次调用的唯一标识，模型据此把结果对回自己那次调用。
 */
export interface ActionNotice {
  call: string;
  action_id: string;
  call_id: string;
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
  /**
   * 可选：读 bot 此刻的坐标（用于「还在跑」进度回执里判断**有没有在动**）。
   *
   * 真机反馈（2026-10-18 15:16，overnight_b）：`goToCoordinates 静默卡死 60 秒：
   * 坐标/speed 全程不变，只在 60 秒时回一句「还在跑」`。只有时间、没有位置的
   * 进度回执等于没有信息——模型分不清"慢慢走"和"卡死"。读不到就返回 null，
   * 回执退回原来的措辞（不编造位置）。
   */
  bodyPosition?: () => Promise<{ x: number; y: number; z: number } | null>;
  /**
   * 可选：读一份背包计数（`{ 物品名: 数量 }`）。**只给 checkpoint 续做算剩余量用**；
   * 读不到返回 null（那就如实说"进度读不到、没有续做"，不猜）。
   */
  inventoryCounts?: () => Record<string, number> | null;
  /** 可选：写一条续做事件（`action.resumed`，只记录、不唤醒）。 */
  resumeNotice?: (payload: ResumeNotice) => void;
}

export class ActionRunner {
  private scheduler: Scheduler;
  private catalog: ToolCatalog;
  private record: (outcome: string, name: string, args: unknown) => Promise<void>;
  private speak: (text: string) => void;
  private execute: (name: string, args: Record<string, unknown>) => Promise<string>;
  private notify: (payload: ActionNotice) => void;
  private trace: (event: ActionTrace) => void;
  private bodyPosition: () => Promise<{ x: number; y: number; z: number } | null>;
  private inventoryCounts: () => Record<string, number> | null;
  private resumeNotice: (payload: ResumeNotice) => void;
  /** 只用于生成 `call_id`；不参与调度，也不影响 generation 的失效语义。 */
  private callSeq = 0;
  /** 当前认领通道的那次调用的标识；用于同动作幂等回执。 */
  private activeCallId: string | null = null;
  private activeGeneration = 0;
  /** 当前动作的续做基线（checkpoint 用；认领时抓，被打断后折算剩余量）。 */
  private activeBaseline: Promise<ResumeBaseline> | null = null;
  /** 被反射打断、等着续做的那一次调用。同一时刻最多一个。 */
  private pendingInterruption: InterruptedAction | null = null;

  constructor(deps: ActionRunnerDeps) {
    this.scheduler = deps.scheduler;
    this.catalog = deps.catalog;
    this.record = deps.record;
    this.speak = deps.speak;
    this.execute = deps.execute;
    this.notify = deps.notify;
    this.trace = deps.trace ?? ((): void => {});
    this.bodyPosition = deps.bodyPosition ?? ((): Promise<null> => Promise.resolve(null));
    this.inventoryCounts = deps.inventoryCounts ?? ((): null => null);
    this.resumeNotice = deps.resumeNotice ?? ((): void => {});
  }

  /** 跑一个工具调用：动作类即时回 accepted，查询类阻塞回内容。 */
  async run(name: string, args: unknown): Promise<ToolOutcome> {
    const checked = validateToolCall(this.catalog, name, args);
    if (!checked.ok) {
      const reason = checked.errors?.join('，') ?? 'Bad arguments.';
      this.trace({ kind: 'query', name });
      await this.record(`rejected: ${reason}`, name, args);
      return { status: 'rejected', code: checked.code ?? 'BAD_ARGS', reason };
    }
    if (!isActionTool(this.catalog, name)) {
      this.trace({ kind: 'query', name });
      // **查询路径同样必须封顶。** 对抗验证的探针（tmp/verify/receipt_caps.probe.test.ts）
      // 发现：动作路径 clamp 了、查询路径没 clamp——`stats` 这类查询返回 10 万字符时
      // 会原样透出，而"回执不许无限长"这条纪律不该分路径。
      const data = clampActionOutput(await this.execute(name, args as Record<string, unknown>));
      await this.record(data, name, args);
      return { status: 'completed', data };
    }
    const claim = this.scheduler.startAction(name, args);
    if (!claim.accepted) {
      const running = this.scheduler.currentAction();
      // 幂等：被拒的这次**就是**正在跑的那个动作。
      // 模型被事件叫醒后常常把同一个动作再下一次，此时逼它 Stop
      // 就等于让它把自己正在做的事打断重来——正是"反复卡住"的来源。
      if (claim.code === 'ACTION_BUSY' && running != null && running.id === name) {
        this.trace({ kind: 'busy_same', name, actionId: running.id });
        const runningSeconds = Math.max(0, Math.round((Date.now() - running.startedAt) / 1000));
        const reason = `${name} 还在跑，已经跑了 ${runningSeconds} 秒。`;
        await this.record(reason, name, args);
        return {
          status: 'accepted',
          data: reason,
        };
      }
      // 确实是另一个动作：报清楚谁在跑、跑了多久。
      this.trace({
        kind: 'busy_other',
        name,
        running: running?.id ?? '(unknown)',
        runningSeconds:
          running == null ? 0 : Math.max(0, Math.round((Date.now() - running.startedAt) / 1000)),
      });
      const runningSeconds = running == null ? 0 : Math.max(0, Math.round((Date.now() - running.startedAt) / 1000));
      const reason = this.scheduler.locked
        ? '保命反射还在跑，身体通道暂时被它占着。'
        : running != null
          ? `${running.id} 还在跑，已经跑了 ${runningSeconds} 秒，身体通道暂时被它占着。`
          : '身体通道暂时被占着。';
      await this.record(`rejected: ${reason}`, name, args);
      return { status: 'rejected', code: claim.code ?? 'ACTION_BUSY', reason };
    }
    const generation = claim.generation ?? 0;
    const callId = `${name}#${++this.callSeq}`;
    this.activeCallId = callId;
    this.activeGeneration = generation;
    // 模型明确发起了新动作：被打断那件事的"续做意图"就此作废（决策权在模型）。
    this.pendingInterruption = null;
    // checkpoint 类动作在这里抓进度基线（被打断后算"还剩多少"用）。
    this.activeBaseline = this.captureBaseline(name, args as Record<string, unknown>);
    this.trace({ kind: 'claim', name, actionId: claim.actionId ?? name, generation });
    // 后台跑，不等：这一轮的推理到此结束，结果以后报。
    void this.finish(name, args as Record<string, unknown>, generation, callId);
    return {
      status: 'accepted',
      data: {
        action_id: claim.actionId,
        call_id: callId,
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
    //
    // **但"还在跑"本身几乎没用**——真机反馈（2026-10-18 15:16，overnight_b
    // 的原话）：`goToCoordinates 静默卡死 60 秒：坐标/speed 全程不变，只在 60 秒时
    // 回一句「还在跑」`。模型据此无法判断"是在慢慢走"还是"彻底卡住了"。
    // 所以这条回执必须带**可比较的状态**：坐标、以及"和上一条比移动了多少格"。
    // **只给数，不判"卡住"**（2026-10-26）：位移小不等于卡住——钓鱼/睡觉/熔炼
    // 本来就不动。判断归模型，见下面 movement 那段。
    let lastPingPosition: { x: number; y: number; z: number } | null = null;
    let lastPingAt: number | null = null;
    const progressTimer = setInterval(() => {
      void (async (): Promise<void> => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      const now = Date.now();
      let pos: { x: number; y: number; z: number } | null;
      try {
        pos = await this.bodyPosition();
      } catch {
        pos = null; // 采样失败就当"读不到坐标"，不编造。
      }
      let data: string;
      if (pos == null) {
        data = `[${callId}] ${name} 还在跑，已经跑了 ${seconds} 秒，读不到当前坐标。`;
      } else {
        const where = `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
        let movement = '';
        if (lastPingPosition != null && lastPingAt != null) {
          const moved = Math.hypot(pos.x - lastPingPosition.x, pos.y - lastPingPosition.y, pos.z - lastPingPosition.z);
          const spanSeconds = Math.max(1, Math.round((now - lastPingAt) / 1000));
          const perSecond = moved / spanSeconds;
          movement = moved < 1
            ? `，这 ${spanSeconds} 秒里只移动了 ${moved.toFixed(1)} 格`
            : `，从上次回执到现在移动了 ${moved.toFixed(1)} 格，大约每秒 ${perSecond.toFixed(1)} 格`;
        }
        data = `[${callId}] ${name} 还在跑，已经跑了 ${seconds} 秒，现在在 ${where}${movement}。`;
      }
      lastPingPosition = pos;
      lastPingAt = now;
      this.notify({
        call: name,
        action_id: name,
        call_id: callId,
        result: { status: 'accepted', data },
      });
      })();
    }, ACTION_PROGRESS_NOTICE_MS);
    // **最后保险丝**：身体侧长时间不返回时，动作通道不能永久泄漏。
    const watchdog = setTimeout(() => {
      const running = this.scheduler.currentAction();
      if (running == null || running.id !== name) return;
      this.scheduler.stopAll();
      this.notify({
        call: name,
        action_id: name,
        call_id: callId,
        result: {
          status: 'completed',
          data: `[${callId}] ${name} 超时了，${ACTION_MAX_MS / 60000} 分钟没有跑完。`,
        },
      });
    }, ACTION_MAX_MS);
    let data: string;
    try {
      data = clampActionOutput(await this.execute(name, args));
    } catch (err: unknown) {
      data = `调用 ${name} 的时候出错了，${err instanceof Error ? err.message : String(err)}`;
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
      // 保命原因 + 有结果时保留结果：身体其实已经把活干完了。
      if (why === 'emergency' && data.trim() !== '') {
        this.cancelPendingFor(callId);
        await this.record(data, name, args);
        this.notify({
          call: name,
          action_id: name,
          call_id: callId,
          result: {
            status: 'completed',
            data: `[${callId}] 保命反射期间身体还是把结果交回来了，${data}`,
          },
        });
        return;
      }
      const reasonText = why === 'emergency'
        ? '保命反射抢走了身体'
        : why === 'stop'
          ? 'Stop 把它打断了'
          : '原因没有记录';
      const policy = this.resumePolicyOf(name);
      const willResume = why === 'emergency' && policy !== 'manual';
      // 兜底捕获（正常路径在 `beginEmergency` 时就抓过了）。**只抓"仍然是当前那次"**：
      // 如果反射结束得比身体返回还快，续做已经发了新调用，这里不能再排一次，
      // 否则同一个动作会被续做两遍。
      if (willResume && this.pendingInterruption == null && this.activeCallId === callId) {
        this.pendingInterruption = {
          name,
          args,
          callId,
          generation,
          policy,
          baseline: this.activeBaseline ?? Promise.resolve(null),
        };
      }
      this.notify({
        call: name,
        action_id: name,
        call_id: callId,
        result: {
          status: 'completed',
          data: `[${callId}] 动作被中断了，${reasonText}。`,
        },
      });
      return;
    }
    const text = this.completionText(name, callId, data);
    await this.record(text, name, args);
    this.scheduler.releaseAction();
    this.cancelPendingFor(callId);
    this.clearActiveCall(callId);
    this.trace({ kind: 'done', name, actionId: name });
    this.notify({
      call: name,
      action_id: name,
      call_id: callId,
      result: { status: 'completed', data: text },
    });
  }

  // ── 续做：反射抢走身体之后，把模型原来那条指令机械接上 ─────────────────────
  //
  // 边界（用户 2026-10-31 定的）：
  //   - 引擎只做**机械延续**：同一条指令、原样或按进度折算参数，不判断"该不该继续"；
  //   - 不设次数上限：被打断几次就续几次，不因为"次数多"把决定权推回模型；
  //   - 续做只是"把身体恢复到被打断前的状态"，不额外限制模型——模型要改主意，
  //     照常 Stop 再发新动作（和它平时打断一个长动作完全一样）。

  /** 反射抢走身体时调用：记下被作废的那次调用，等反射结束再机械续做。 */
  captureInterruption(action: CurrentAction | null): void {
    if (action == null) return;
    const policy = this.resumePolicyOf(action.id);
    if (policy === 'manual') return;
    const args = action.args != null && typeof action.args === 'object'
      ? (action.args as Record<string, unknown>)
      : {};
    this.pendingInterruption = {
      name: action.id,
      args,
      callId: this.activeCallId,
      generation: action.generation,
      policy,
      baseline: this.activeBaseline ?? Promise.resolve(null),
    };
  }

  /**
   * 所有反射结束（紧急锁解除）：按声明机械续做被打断的那一次。
   *
   * 位置类 checkpoint（digDown / stairUp / pillarUp / mineTunnel）要等身体
   * 采样坐标，所以是 async；`auto` 和按背包计数的 checkpoint 在同一拍完成。
   */
  async resumeInterrupted(): Promise<void> {
    const pending = this.pendingInterruption;
    this.pendingInterruption = null;
    if (pending == null) return;
    // Stop 是模型明确要回身体：它已经决定不做了，不续。
    if (this.scheduler.lastInvalidationReason() === 'stop') {
      this.trace({ kind: 'resume_dropped', name: pending.name, reason: 'stop' });
      return;
    }
    if (this.scheduler.locked) {
      // 还有反射没结束（正常不会发生：解锁后才调这里）。留到下次。
      this.pendingInterruption = pending;
      return;
    }
    let args = pending.args;
    if (pending.policy === 'checkpoint') {
      const adjusted = await this.adjustCheckpointArgs(pending);
      // 采样期间世界可能变了：模型按了 Stop → 不续（决策权在模型）。
      if (this.scheduler.lastInvalidationReason() === 'stop') {
        this.trace({ kind: 'resume_dropped', name: pending.name, reason: 'stop-after-sample' });
        return;
      }
      if (adjusted == null) {
        this.emitResumeNotice({
          call: pending.name,
          action_id: pending.name,
          call_id: null,
          resumed: false,
          args: null,
          detail: `${pending.name} 被打断了，读不到当前进度，所以没有接着做。`,
        });
        return;
      }
      if (adjusted.done) {
        this.emitResumeNotice({
          call: pending.name,
          action_id: pending.name,
          call_id: null,
          resumed: false,
          args: null,
          detail: `${pending.name} 被打断了，但${adjusted.note}，所以不再接着做。`,
        });
        return;
      }
      args = adjusted.args;
    }
    this.dispatchResumed(pending, args);
  }

  /** Stop / 模型要回身体：放弃这次续做。 */
  clearInterruption(reason: string): void {
    const pending = this.pendingInterruption;
    if (pending == null) return;
    this.pendingInterruption = null;
    this.trace({ kind: 'resume_dropped', name: pending.name, reason });
  }

  private dispatchResumed(pending: InterruptedAction, args: Record<string, unknown>): void {
    const claim = this.scheduler.startAction(pending.name, args);
    if (!claim.accepted) {
      // 模型已经抢先发了别的动作：不抢，如实记录（决策权在模型手上）。
      this.trace({ kind: 'resume_dropped', name: pending.name, reason: claim.code ?? 'busy' });
      this.emitResumeNotice({
        call: pending.name,
        action_id: pending.name,
        call_id: null,
        resumed: false,
        args: null,
        detail:
          `${pending.name} 被打断之后本来要接着做，但身体通道被占着，错误码是 ${claim.code ?? 'busy'}，所以没有接着做。`,
      });
      return;
    }
    const generation = claim.generation ?? 0;
    const callId = `${pending.name}#${++this.callSeq}`;
    this.activeCallId = callId;
    this.activeGeneration = generation;
    this.activeBaseline = this.captureBaseline(pending.name, args);
    this.trace({ kind: 'resumed', name: pending.name, callId, generation });
    this.emitResumeNotice({
      call: pending.name,
      action_id: pending.name,
      call_id: callId,
      resumed: true,
      args,
      detail: `已经替你接着做 ${pending.name} 了，参数是 ${describeResumeArgs(args)}。`,
    });
    void this.finish(pending.name, args, generation, callId);
  }

  /**
   * checkpoint：把"已经做完多少"从参数里扣掉。读不到进度返回 null（不猜）。
   *
   * 语义统一成**"原始终点没变"**：
   *   - count：收满 `num` 为止（按掉落物数）；
   *   - depth：挖到/垫到原来的目标 Y 为止；
   *   - tunnel：挖到原来的目标水平坐标为止。
   * 这样被打断期间即使被怪推走/逃开，续做也是"接着走到原始终点"，不是"再走一遍"。
   */
  private async adjustCheckpointArgs(
    pending: InterruptedAction,
  ): Promise<{ args: Record<string, unknown>; done: boolean; note: string } | null> {
    let baseline: ResumeBaseline;
    try {
      baseline = await pending.baseline;
    } catch {
      return null;
    }
    if (baseline == null) return null;

    if (baseline.kind === 'count') {
      const counts = this.inventoryCounts();
      if (counts == null) return null;
      const doneCount = Math.max(0, (counts[baseline.item] ?? 0) - baseline.start);
      const remaining = baseline.target - doneCount;
      if (remaining <= 0) {
        return { args: pending.args, done: true, note: `目标已经完成，已经收集了 ${doneCount} 个，目标是 ${baseline.target} 个` };
      }
      return { args: { ...pending.args, num: remaining }, done: false, note: '' };
    }

    const pos = await this.readPosition();
    if (pos == null) return null;

    if (baseline.kind === 'depth') {
      const remaining = baseline.sign === -1 ? pos.y - baseline.targetY : baseline.targetY - pos.y;
      if (remaining <= 0.5) return { args: pending.args, done: true, note: '已经到达目标深度' };
      const argName = 'distance';
      return {
        args: { ...pending.args, [argName]: this.clampToParam(pending.name, argName, Math.ceil(remaining)) },
        done: false,
        note: '',
      };
    }

    // tunnel：方向没给（按朝向/forward）时，用实际位移推断它当初往哪挖。
    let axis = baseline.axis;
    let sign: 1 | -1 = baseline.sign === 0 ? 1 : baseline.sign;
    if (axis == null) {
      const dx = pos.x - baseline.start.x;
      const dz = pos.z - baseline.start.z;
      if (Math.max(Math.abs(dx), Math.abs(dz)) < 1) {
        // 完全没动、方向又是"按朝向"给的：按原参数重发（等价 auto）。
        return { args: pending.args, done: false, note: '' };
      }
      axis = Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
      sign = ((axis === 'x' ? dx : dz) >= 0 ? 1 : -1) as 1 | -1;
    }
    const startAxis = axis === 'x' ? baseline.start.x : baseline.start.z;
    const currentAxis = axis === 'x' ? pos.x : pos.z;
    const targetAxis = startAxis + sign * baseline.length;
    const remaining = sign * (targetAxis - currentAxis);
    if (remaining <= 0.5) return { args: pending.args, done: true, note: '已经挖到目标位置' };
    const args: Record<string, unknown> = {
      ...pending.args,
      length: this.clampToParam(pending.name, 'length', Math.ceil(remaining)),
    };
    // 方向是推断出来的：写成显式方向，免得身体按"当前朝向"重新解析、挖反。
    if (baseline.axis == null) args['direction'] = `${sign > 0 ? '+' : '-'}${axis}`;
    return { args, done: false, note: '' };
  }

  /**
   * 认领动作时抓进度基线（只有 checkpoint 需要）。
   *
   * 位置类基线是异步的（身体在另一个进程），Promise 在这里存下来，
   * 被打断后由 `adjustCheckpointArgs` await。
   */
  private captureBaseline(name: string, args: Record<string, unknown>): Promise<ResumeBaseline> {
    if (this.resumePolicyOf(name) !== 'checkpoint') return Promise.resolve(null);

    if (name === 'collectBlocks') {
      const counts = this.inventoryCounts();
      if (counts == null) return Promise.resolve(null);
      const item = resumeItemForBlock(args['type']);
      const target = Number(args['num']);
      if (item === '' || !Number.isFinite(target) || target <= 0) return Promise.resolve(null);
      return Promise.resolve({ kind: 'count', item, target, start: counts[item] ?? 0 });
    }

    const depthSpec = DEPTH_RESUME_SPECS[name];
    if (depthSpec != null) {
      const distance = Number(args[depthSpec.arg]);
      if (!Number.isFinite(distance) || distance <= 0) return Promise.resolve(null);
      return this.readPosition().then((pos) =>
        pos == null
          ? null
          : { kind: 'depth' as const, sign: depthSpec.sign, targetY: pos.y + depthSpec.sign * distance },
      );
    }

    if (name === 'mineTunnel') {
      const rawLength = Number(args['length'] ?? this.paramDefault(name, 'length') ?? Number.NaN);
      if (!Number.isFinite(rawLength) || rawLength <= 0) return Promise.resolve(null);
      const direction = parseTunnelDirection(args['direction']);
      return this.readPosition().then((pos) =>
        pos == null
          ? null
          : {
              kind: 'tunnel' as const,
              start: { x: pos.x, z: pos.z },
              length: rawLength,
              axis: direction?.axis ?? null,
              sign: direction?.sign ?? 0,
            },
      );
    }

    return Promise.resolve(null);
  }

  /** 读一次身体坐标；读不到/抛错都返回 null（不猜）。 */
  private async readPosition(): Promise<{ x: number; y: number; z: number } | null> {
    try {
      return await this.bodyPosition();
    } catch {
      return null;
    }
  }

  /** 工具声明里某个参数的默认值（mineTunnel 的 length 有默认值）。 */
  private paramDefault(name: string, param: string): number | null {
    const value = this.catalog.get(name)?.params?.[param]?.default;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** 把续做参数夹回声明的 domain 里（不同工具的最大距离不一样）。 */
  private clampToParam(name: string, param: string, value: number): number {
    const domain = this.catalog.get(name)?.params?.[param]?.domain;
    let min = 1;
    let max = Number.POSITIVE_INFINITY;
    if (Array.isArray(domain)) {
      const lo = Number(domain[0]);
      const hi = Number(domain[1]);
      if (Number.isFinite(lo)) min = lo;
      if (Number.isFinite(hi)) max = hi;
    }
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  /** 续做策略来自**身体握手报上来的声明**；没声明 = manual（不自动重放）。 */
  private resumePolicyOf(name: string): ResumePolicy {
    return this.catalog.get(name)?.resume ?? 'manual';
  }

  private cancelPendingFor(callId: string | null): void {
    if (this.pendingInterruption != null && this.pendingInterruption.callId === callId) {
      this.pendingInterruption = null;
    }
  }

  private emitResumeNotice(payload: ResumeNotice): void {
    try {
      this.resumeNotice(payload);
    } catch {
      // 回执写不进去不能影响动作本身。
    }
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
   * 抢走身体都会这样）。空结果要如实说"没有返回结果"，不替模型猜原因。
   */
  private completionText(name: string, callId: string, data: unknown): string {
    const raw = typeof data === 'string' ? data.trim() : data == null ? '' : String(data);
    const header = `[${callId}]`;
    if (raw !== '' && raw !== '(no output)') return `${header} ${raw}`;
    return `${header} ${name} 已经结束了，但身体没有返回结果。`;
  }
}

export default { ActionRunner };
