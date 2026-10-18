/**
 * 空转护栏：模型"只说一句话、不调工具"时，把它按回去接着干活。
 *
 * ## 为什么需要它（实测）
 *
 * 这个运行时是**自然的 ReAct 循环**：`run` 的结束 = "模型不再调工具"。
 * 这条语义本身是对的，但在真机上有一个致命后果——
 *
 * > 模型一旦 yield（只回正文、一个工具都不调），这一轮就结束；而下一轮
 * > **只能靠事件唤醒**。夜里没有事件（周围没怪、没聊天、没被打断），
 * > bot 就这么原地站到天亮。
 *
 * 2026-10-18 实测：整树重启后两个 bot 各发了一次 `content:["thinking","text"]`
 * 的请求（`overnight_a` in=651276、`overnight_b` in=346744），零 `toolCall`，
 * 然后 10 分钟没有任何请求、没有任何动作，`Goal: none Todos: none`。
 * 00:22 那次停摆也是同一个形状（记在 `tmp/overnight/FINDINGS.md` F-7）。
 *
 * ## 兜底的两层
 *
 * | 层 | 触发 | 手段 |
 * |---|---|---|
 * | `onYield` | 模型给出最终回答的那一刻 | 返回 `{ continue }`：pi-durable 会**追加一条 user 消息**并把 run 交给继任 generation，于是模型立刻再想一轮 |
 * | 心跳看门狗 | 连请求都没有（模型没答、事件没来、动作没跑） | 到点主动 `submit` 一条 user 消息唤醒 |
 *
 * 两层都必须**有上限**：模型要是彻底坏了，无限续轮就是无限烧钱。所以
 * `onYield` 连续按回 `maxContinues` 次就放手（期间只要真调过一次工具就清零），
 * 心跳看门狗则退避到最多 30 分钟一次——哪怕最坏情况，bot 也只会"慢慢试"，
 * 不会停死。
 *
 * ## 状态为什么放进程内存
 *
 * 不用 `api.memo`：memo 挂在**各自的 task 实例**上，`GenerationTask` 的 hook
 * 读不到 `ToolTask` 写的 memo（跨 task 不共享）。这份状态只用来决定"这一轮
 * 要不要按回去"，重启后从零开始正是我们想要的（重启后本来就该催一次）。
 */
import {
  GenerationTask,
  ToolTask,
  hook,
  type HookRegistration,
  type UserInput,
} from '@earendil-works/pi-durable';

/**
 * 按回去时追加的 user 消息。
 *
 * 写法要求：**先给判断标准，再给动作，最后堵住"只说话"这条路**。模型不是
 * 不听话，是它以为"汇报完就等于这一轮结束了"——所以要把"结束回合"这件事
 * 本身定义清楚：只有真的在等外部条件（并且用一个明确的动作在等）才算结束。
 */
export const STALL_NUDGE =
  '【继续】上一轮你没有调用任何工具就结束了回合。在 Minecraft 里"只说话"等于原地停摆：'
  + '世界不会因为你汇报了就往前走。现在必须调用工具继续干活——'
  + '有未完成的计划就用 UpdatePlan 勾进度并做下一步；没有计划就先 UpdatePlan 建一个（目标 + 前 3 条 todo），然后立刻调第一个动作工具。'
  + '只有一种情况可以结束回合：你确实在等外部条件（例如等天亮、等队友走过来），'
  + '那就用一个明确的等待动作（如 stay / sleepUnderground）把等待本身做出来，并在正文里写清你在等什么、等多久。';

/**
 * 第 2 次起语气更硬，而且**把选择收窄成一个闭集**。
 *
 * 实测（2026-10-18 12:47，overnight_a）：15 分钟里 38 次请求有 28 次零工具调用，
 * 思考文本退化成「Hmm — hmm. Hmm — hmm.」的复读。原因不是它不听话，而是
 * **选项太多**：45 个工具 + 一个复杂局面（队友求救、自己被困），它就一直权衡。
 * 对它有效的不是"你要动手"这种抽象要求，而是"从这三条里选一条，现在就调"。
 */
export const STALL_NUDGE_ESCALATED =
  '【继续·必须动手】你已经连续多轮只思考、不调用任何工具了。**不要再权衡、不要再复述计划**——'
  + '从下面三条里**选一条，立刻调用**，做完再看结果：\n'
  + '① 不知道周围什么情况 → `stats(type=all)`；\n'
  + '② 知道要去哪 → `goToCoordinates(x, y, z, closeness=3)`；\n'
  + '③ 身边有威胁或被困 → `pillarUp(distance=3)`（垫高躲开地面怪）或 `attack(entity_id)`。\n'
  + '只回正文不调工具 = 这一轮世界什么都没发生。卡片选一个，调它。';

/** 心跳兜底用的文案（连模型都没答，只能从"看状态、写计划"重新起步）。 */
export const STALL_WATCHDOG_NUDGE =
  '【心跳·空转兜底】你已经有一段时间既没有动作也没有回复了。现在立刻：'
  + '1) 调 stats 看身体状态、背包、坐标和维度；'
  + '2) 用 UpdatePlan 把计划重写成"下一步只有一个动作"（如果计划还在，就勾掉已完成项）；'
  + '3) 立刻执行那个动作。不要只回复文字。';

export interface StallGuardOptions {
  /**
   * 连续按回几次后放手。**默认 3**。
   *
   * 只在"一直没调工具"的连续回合里累计；任何一次工具执行都会把它清零，
   * 所以正常干活的 bot 永远不会撞到这个上限。
   */
  maxContinues?: number;
  /** 自定义 onYield 催办文案（attempt 从 1 开始）。 */
  nudge?: (attempt: number) => UserInput;
  /** 观测：每次按回时回调（日志/测试用）。 */
  onContinue?: (attempt: number) => void;
  /**
   * 空闲多久算停摆（毫秒）。**默认 10 分钟**。
   *
   * 真机上一次完整请求（651k 上下文的模型调用）可以跑几分钟，所以不能太短；
   * 10 分钟既能兜住 F-7 那种"彻底不动"，又不会打断长动作。
   */
  idleMs?: number;
  /** 动作已经跑了多久之内不催（毫秒）。**默认 12 分钟**（比动作保险丝长一点）。 */
  toolGraceMs?: number;
  /** 心跳最多退避到多久一次。**默认 30 分钟**。 */
  maxIdleMs?: number;
  /** 观测：心跳催办时回调。 */
  onWatchdog?: (idleMs: number, attempt: number) => void;
  /**
   * 心跳出口：把一条 user 消息真的提交给会话（装配层接到 `runtime.submit`）。
   *
   * 不给就只跑 `onYield` 那一层——**测试和"没有会话"的场景都不该被定时器绑住**。
   */
  wake?: (text: UserInput) => Promise<unknown>;
  /** 定时器注入（测试用）；不给就用全局 `setInterval` + `unref`。 */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** 时钟注入（测试用）。 */
  now?: () => number;
}

export interface StallGuard {
  /** 挂到扩展上的 hook。 */
  hooks: HookRegistration[];
  /** 手动打一次活动卡（任何"模型真的在干活"的证据）。 */
  noteActivity: () => void;
  /** 现在算不算停摆（毫秒；测试/诊断用）。 */
  idleFor: () => number;
  /** 当前连续按回次数。 */
  continuesWithoutTool: () => number;
  /** 停掉心跳定时器。 */
  stop: () => void;
}

/**
 * 造一套护栏。
 *
 * 返回值里的 `hooks` 交给 `defineExtension({ hooks })`；心跳定时器在创建时
 * 就起（`unref` 过，不会拖住进程退出），`stop()` 可显式停掉。
 */
export function createStallGuard(options: StallGuardOptions = {}): StallGuard {
  const maxContinues = Math.max(1, options.maxContinues ?? 3);
  const idleMs = Math.max(1_000, options.idleMs ?? 10 * 60_000);
  const toolGraceMs = Math.max(1_000, options.toolGraceMs ?? 12 * 60_000);
  const maxIdleMs = Math.max(idleMs, options.maxIdleMs ?? 30 * 60_000);
  const now = options.now ?? (() => Date.now());
  const nudge =
    options.nudge ?? ((attempt: number) => (attempt <= 1 ? STALL_NUDGE : STALL_NUDGE_ESCALATED));

  let continuesWithoutTool = 0;
  let lastActivityAt = now();
  let lastToolStartAt = now();
  let runningTools = 0;
  let watchdogAttempt = 0;
  /** 下一次心跳的目标间隔（指数退避，最多 `maxIdleMs`）。 */
  let nextIdleMs = idleMs;

  const noteActivity = (): void => {
    lastActivityAt = now();
    watchdogAttempt = 0;
    nextIdleMs = idleMs;
  };

  const hooks: HookRegistration[] = [
    hook(GenerationTask, {
      // 模型真答了就是活动（哪怕它只回了正文）：这一条让心跳不会在模型
      // 正在思考的时候插嘴。
      afterResponse: () => {
        lastActivityAt = now();
        return undefined;
      },
      // 最终回答：把它按回去继续干活，直到连续多次都没有工具调用。
      onYield: () => {
        if (continuesWithoutTool >= maxContinues) return undefined;
        continuesWithoutTool += 1;
        const attempt = continuesWithoutTool;
        // 催办本身也算活动：心跳从这一刻重新计时。
        lastActivityAt = now();
        options.onContinue?.(attempt);
        return { continue: nudge(attempt) };
      },
    }),
    hook(ToolTask, {
      beforeTool: () => {
        runningTools += 1;
        lastToolStartAt = now();
        lastActivityAt = now();
        return undefined;
      },
      // 工具跑过 = 真的在干活：清零"只会说话"的连击。
      afterTool: () => {
        runningTools = Math.max(0, runningTools - 1);
        continuesWithoutTool = 0;
        lastActivityAt = now();
        return undefined;
      },
    }),
  ];

  const tick = (): void => {
    const t = now();
    if (t - lastActivityAt < nextIdleMs) return;
    // 有动作正在跑，且还没超过宽限期：那是"在干活"，不是停摆。
    // （动作自己还有 10 分钟保险丝，真挂住了照样会被这里接手。）
    if (runningTools > 0 && t - lastToolStartAt < toolGraceMs) return;
    watchdogAttempt += 1;
    // 催了也不动就退避，最多 `maxIdleMs` 一次；**永不放弃**（真机要求"不要停"）。
    nextIdleMs = Math.min(maxIdleMs, Math.round(nextIdleMs * 2));
    lastActivityAt = t;
    options.onWatchdog?.(t - lastActivityAt + nextIdleMs, watchdogAttempt);
    if (options.wake != null) {
      void Promise.resolve(options.wake(STALL_WATCHDOG_NUDGE)).catch(() => {
        /* 唤醒失败不该让定时器崩：下一拍还会再试。 */
      });
    }
  };

  const handle = options.setInterval == null
    ? (setInterval(tick, Math.max(1_000, Math.min(30_000, Math.round(idleMs / 4)))) as unknown as { unref?: () => void })
    : options.setInterval(tick, Math.max(1_000, Math.min(30_000, Math.round(idleMs / 4))));
  // 定时器不该拖住进程退出（Node 的 Timeout 才有 unref）。
  (handle as { unref?: () => void } | null)?.unref?.();

  return {
    hooks,
    noteActivity,
    idleFor: () => now() - lastActivityAt,
    continuesWithoutTool: () => continuesWithoutTool,
    stop: () => {
      if (handle == null) return;
      if (options.clearInterval != null) options.clearInterval(handle);
      else clearInterval(handle as NodeJS.Timeout);
    },
  };
}
