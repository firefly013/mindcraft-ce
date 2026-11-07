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
 * 然后 10 分钟没有任何请求、没有任何动作，`Goal: none`。
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
 * 2026-11-06：只报事实（上一轮没有调用工具），不写"必须调用工具/只有一种情况
 * 可以结束回合"这类行为命令。
 */
export const STALL_NUDGE = '上一轮你没有调用任何工具。';

/**
 * 第 2 次起的催办：只补一条事实（上一轮正文），不再命令模型"把话作为工具调用发出来"。
 */
export const STALL_NUDGE_ESCALATED = '上一轮你仍然没有调用任何工具。';

/** 心跳兜底用的文案（只报事实）。 */
export const STALL_WATCHDOG_NUDGE = '已经有一段时间没有动作也没有回复了。';

/**
 * 汇报通道的工具名。
 *
 * `Say` **不能**算作"干过活"：它只把字发出去，不改变世界。把它算进去，
 * 模型靠"正文 → Say → 正文 → Say"就能让护栏的上限永远够不到（见 `afterTool`）。
 * 这里写成常量而不是散落的字面量，是为了让"哪些工具不算干活"只有一处定义。
 */
export const SAY_TOOL_NAME = 'Say';

/** 正文回灌的长度上限：够模型认出自己那句话就行，不要把它整段汇报塞回去。 */
const YIELD_ECHO_LIMIT = 160;

/**
 * 取这条 assistant 消息里的**正文**（thinking 不算）。
 *
 * 真机里最有价值的一句催办不是抽象的"你要动手"，而是把它自己刚写的
 * `东进 100 格：(200,72,0)。` 原样递回去——模型在那句话里已经想清楚了要做
 * 什么，只是把"写下意图"当成了"执行"。把原文递回去，等于替它把最后一步补上。
 * 读不到正文就返回空串（不回灌，退回通用文案）。
 */
export function readYieldText(answer: unknown): string {
  const content = (answer as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p?.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (joined === '') return '';
  return joined.length > YIELD_ECHO_LIMIT ? `${joined.slice(0, YIELD_ECHO_LIMIT)}…` : joined;
}

export interface StallGuardOptions {
  /**
   * 连续按回几次后放手。**默认 3**。
   *
   * 只在"一直没调工具"的连续回合里累计；任何一次工具执行都会把它清零，
   * 所以正常干活的 bot 永远不会撞到这个上限。
   */
  maxContinues?: number;
  /**
   * 自定义 onYield 催办文案（attempt 从 1 开始）。
   *
   * `previousText` 是这个 bot **上一轮正文的原文**（可能为空）。真机上最有用的
   * 一句话就是"你刚写的这句，现在把它作为工具调用发出来"——见 `readYieldText`。
   */
  nudge?: (attempt: number, previousText: string) => UserInput;
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
  /**
   * 来了**新的外部输入**（玩家说话 / 世界事件 / 开发者留言）——把按回次数清零。
   *
   * `maxContinues` 的本意是"**一轮之内**不要无限自动续跑"，而不是"这个 bot 一辈子
   * 只有三次机会"。真机（2026-10-18 16:45，overnight_b）：它附近有蜘蛛，世界事件
   * 每隔几十秒把它唤醒一次，每次都只回正文、`onYield` 因为计数早已到顶而拒绝续跑
   * ——于是**26 分钟零工具调用，而护栏一次都没催**（日志里 `stall-nudges=0`）。
   * 计数只在"工具执行"时复位是不够的：新事件带来的是**新信息、新的一轮**，本来就
   * 该重新给三次机会。心跳（`wake`）不在此列——那是护栏自己的升级手段，不能自我复位。
   */
  noteExternalInput: () => void;
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
    options.nudge ??
    ((attempt: number, previousText: string) => {
      if (attempt <= 1) return STALL_NUDGE;
      // 第 2 次起：把上一轮正文原样附回去（事实），不下"必须发调用"的命令。
      if (previousText !== '') {
        return `${STALL_NUDGE_ESCALATED}\n你上一轮写的正文是，${previousText}`;
      }
      return STALL_NUDGE_ESCALATED;
    });

  let continuesWithoutTool = 0;
  let lastActivityAt = now();
  let lastToolStartAt = now();
  let runningTools = 0;
  let watchdogAttempt = 0;
  /** 下一次心跳的目标间隔（指数退避，最多 `maxIdleMs`）。 */
  let nextIdleMs = idleMs;

  const noteActivity = (): void => {
    lastActivityAt = now();
    resyncWatchdog();
  };

  /**
   * 真的干了活：把心跳退避**复位**。
   *
   * 之前只有 `noteActivity` 会复位 `nextIdleMs`，而生产路径根本没人调用它
   * （hook 直接改 `lastActivityAt`），于是退避一旦涨到上限就**永远停在 30 分钟**：
   * 一个健康跑了三小时的 bot 后来真卡住时，也要等满 30 分钟才有人管它。
   */
  const resyncWatchdog = (): void => {
    watchdogAttempt = 0;
    nextIdleMs = idleMs;
  };

  const hooks: HookRegistration[] = [
    hook(GenerationTask, {
      // 模型真答了就是活动（哪怕它只回了正文）：这一条让心跳不会在模型
      // 正在思考的时候插嘴。**也复位退避**——"答过"就说明链路是活的。
      afterResponse: () => {
        lastActivityAt = now();
        resyncWatchdog();
        return undefined;
      },
      // 最终回答：把它按回去继续干活，直到连续多次都没有工具调用。
      onYield: (answer) => {
        if (continuesWithoutTool >= maxContinues) return undefined;
        continuesWithoutTool += 1;
        const attempt = continuesWithoutTool;
        // 催办本身也算活动：心跳从这一刻重新计时。
        lastActivityAt = now();
        resyncWatchdog();
        options.onContinue?.(attempt);
        return { continue: nudge(attempt, readYieldText(answer)) };
      },
    }),
    hook(ToolTask, {
      beforeTool: () => {
        runningTools += 1;
        lastToolStartAt = now();
        lastActivityAt = now();
        return undefined;
      },
      // 工具跑过 = 真的在干活？**要看是哪个工具**。
      //
      // `Say` 是汇报通道，不改变世界状态。真机（+ 对抗验证 `VERIFY.md` 声明 1）：
      // 一旦把 Say 也算作"干活"，模型只要"正文 → Say → 正文 → Say"就能每轮把
      // 连击清零，`maxContinues` 永远够不到 —— 实测 maxContinues=1 时纯正文 2 次
      // 请求就停，加了 Say 之后 25 次请求 / 12 次催办还在继续。而 `prompts.ts`
      // 又刚要求"报进度走 Say"，等于把护栏从"3 次后放手"升级成无限循环。
      // 所以：只有**改变世界**的工具才算干活。
      afterTool: (call) => {
        runningTools = Math.max(0, runningTools - 1);
        if (call?.name !== SAY_TOOL_NAME) continuesWithoutTool = 0;
        lastActivityAt = now();
        resyncWatchdog();
        return undefined;
      },
    }),
  ];

  const tick = (): void => {
    const t = now();
    // **先算真实空闲时长，再更新时钟**。原来先 `lastActivityAt = t` 再算
    // `t - lastActivityAt + nextIdleMs`，报出去的永远是退避后的间隔而不是"它到底停了多久"，
    // 诊断时最有用的那个数字被抹掉了（真机排查 10 小时停摆时被这个坑了一次）。
    const idleForMs = t - lastActivityAt;
    if (idleForMs < nextIdleMs) return;
    // 有动作正在跑，且还没超过宽限期：那是"在干活"，不是停摆。
    // （动作自己还有 10 分钟保险丝，真挂住了照样会被这里接手。）
    if (runningTools > 0 && t - lastToolStartAt < toolGraceMs) return;
    watchdogAttempt += 1;
    // 催了也不动就退避，最多 `maxIdleMs` 一次；**永不放弃**（真机要求"不要停"）。
    nextIdleMs = Math.min(maxIdleMs, Math.round(nextIdleMs * 2));
    lastActivityAt = t;
    // **重新给 onYield 那层上膛**。
    //
    // 真机（2026-10-18 14:00，overnight_a）：它连续 3 次"只写正文不调工具"把
    // `maxContinues` 用光之后再没复位过，于是 onYield 那层**永久失效**——每 10
    // 分钟被心跳叫醒一次，回一段正文，又睡回去，两小时零动作零移动（用户在游戏里
    // 直接看到"机器人 A 不动弹也不说话"）。心跳是最后一道兜底，它一响就说明
    // "上一轮那三次没起作用"，此时必须重新给三次机会，否则护栏等于自杀。
    // 有界性仍然成立：每 `nextIdleMs`（≥10 分钟）最多 1 + maxContinues 次请求。
    continuesWithoutTool = 0;
    options.onWatchdog?.(idleForMs, watchdogAttempt);
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
    noteExternalInput: () => {
      // 新的一轮：按回次数清零，退避也回到初始间隔（刚有真事发生，别等半小时）。
      continuesWithoutTool = 0;
      watchdogAttempt = 0;
      nextIdleMs = idleMs;
      // **故意不动 `lastActivityAt`**（2026-10-26 修：这是"长时间工作后停滞"的根因）。
      //
      // 外部事件（`inventory.changed` / `item.drop.nearby` / `entity.hostile_far` /
      // `world.light_low` …）**每秒都在来**，而这台机器上它们只是"世界在动"，
      // 不代表"模型在干活"。原来这里把空闲时钟重置成 now()，于是：
      //   心跳 tick 每 2.5 秒检查一次 → 总有事件刚把 lastActivityAt 刷新过 →
      //   `t - lastActivityAt < nextIdleMs` **永远成立** → 心跳永远不触发。
      // 真机证据（2026-10-22 overnight_a/b）：两个 bot 停摆整整 10 小时，
      // 期间 agent 日志一直在写（全是上面这些被动事件），但
      // **工具调用 0 次、反馈 0 条、死亡 0 次**，进程与连接都健康 —— 护栏一次都没响。
      // 正确的判据只能是"模型真的答了 / 世界真的被改了"（afterResponse / afterTool），
      // 不能是"世界在动"。
    },
    stop: () => {
      if (handle == null) return;
      if (options.clearInterval != null) options.clearInterval(handle);
      else clearInterval(handle as NodeJS.Timeout);
    },
  };
}
