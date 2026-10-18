/**
 * P3：bot 的 pi-durable 运行时。
 *
 * 把 P1（pi-ai 供应商）、P2（SQLite 会话）、P3（回合语义）拼成一个可直接
 * 驱动的对象。`agent.ts` 暂时仍走旧路径——双路径迁移，等 P4/P5 把工具与
 * 感知都接过来再切换，这样任何时刻仓库都是可运行的。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  createRegistry,
  defineExtension,
  type CompactionPolicy,
  type Conversation,
  type ConversationWatch,
  type EntryDraft,
  type Extension,
  type Submission,
  type SubmissionDraft,
  type ToolRegistration,
  type UserInput,
} from '@earendil-works/pi-durable';
import { createSayTool, liveTailHook, systemSection } from './loop.js';
import type { ResolvedProvider } from './provider.js';
import { openBotSession, type BotSession } from './session.js';
import { createStallGuard, type StallGuardOptions } from './stall_guard.js';

/** 提交一条输入时的排队策略（对应 pi-durable 的 `whenBusy`）。 */
export interface SubmitOptions {
  /** 忙时：`steer` 插到当前工具轮之后，`followUp` 等本轮答完再开，`reject` 直接抛。 */
  whenBusy?: 'steer' | 'followUp' | 'reject';
  /** 幂等键：重启后用同一个 id 提交不会重复入队。 */
  requestId?: string;
}

export interface BotRuntimeOptions {
  /** bot 名（profile.name）。 */
  name: string;
  /** P1 解析出的供应商与模型（同时提供 `Models` 集合与具体模型）。 */
  provider: ResolvedProvider;
  /** 落盘根目录，默认 `./bots/<name>`。 */
  baseDir?: string;
  /**
   * 上下文压缩策略。用 `compactionPolicyFromProfile(profile)` 解析后传进来。
   * 不给就用 pi-durable 的内置默认（与主线的 profile 默认值一致）。
   */
  compaction?: CompactionPolicy;
  /** 实例区分后缀，避免同名多开撞同一个库。 */
  instanceId?: string;
  /** 静态系统提示词。应当稳定，否则会破坏 prompt cache。 */
  systemPrompt: () => string;
  /** 每轮请求前注入的动态尾巴（事件 / 记忆 / 世界快照）；空串则不加。 */
  /**
   * 每轮尾巴（记忆 + 世界快照）。可以是异步的——记忆存在文档里要读一次；
   * `beforeRequest` 允许返回 Promise。
   */
  liveTail: () => string | Promise<string>;
  /**
   * 每轮现拍一张画面（base64 jpeg），跟尾巴一起注入。**可选**：不给就纯文本。
   * 拍不到返回 null 即可，hook 会安静降级。
   */
  liveImage?: () => Promise<string | null>;
  /** 游戏工具。原样安装，不做任何包装。 */
  tools?: readonly ToolRegistration[];
  /** Say 通道回调（写游戏内聊天 / 推前端）。 */
  onSay?: (text: string) => void;
  /** 额外扩展（状态文档等，后续阶段接）。 */
  extensions?: readonly Extension[];
  /**
   * 空转护栏（模型只说话不调工具 → 按回去继续）。**默认不开**，由装配层决定。
   *
   * 为什么默认关：`run 的结束 = 模型不再调工具` 是 pi-durable 的**回合语义**，
   * 一批单测正是靠"几次请求 = 几次调用"来钉它（`runtime_steer_vs_followup`、
   * `runtime_inbox_semantics` 等）。护栏会在 yield 之后**追加一次请求**，把那
   * 些断言全变成噪声。所以这里保持原语纯净，真机在 `openBotWiring` 里默认打开
   * （见 `bot.ts`）——那里才是"要一个整夜不停的 bot"的策略层。
   *
   * 传 `{}` 打开、传对象覆盖阈值、传 `false` 显式关掉。见 `stall_guard.ts`。
   */
  stallGuard?: StallGuardOptions | false;
}

export interface BotRuntime {
  session: BotSession;
  conversation: Conversation;
  /** 提交用户/系统输入，返回可 `wait()` 的 submission。 */
  submit(content: UserInput, options?: SubmitOptions): Promise<Submission>;
  /**
   * 被动写一条 entry：**不唤醒模型**，但会出现在下一次请求的上下文里。
   *
   * 这是 L2「记录，不唤醒」的落点：事件在发生的那一刻就进了上下文，但不会
   * 拉模型起来——实测确认它不会让 `callCount` 增加
   * （见 `tests/runtime_inbox_semantics.test.ts`）。
   */
  write(entry: EntryDraft): Promise<Submission>;
  /** 中断当前 run（L4/L5 抢占的落点）。 */
  abort(): Promise<void>;
  /** 结构视图，供前端 late-join / 重连。 */
  watch(): Promise<ConversationWatch>;
  close(): Promise<void>;
}

export async function openBotRuntime(options: BotRuntimeOptions): Promise<BotRuntime> {
  // 空转护栏：先造状态、装 hook；`wake` 出口在会话建好之后再接上
  // （装配顺序：extension 必须早于 session，而 submit 只有 session 才有）。
  let wake: ((text: UserInput) => Promise<unknown>) | null = null;
  const guard =
    options.stallGuard == null || options.stallGuard === false
      ? null
      : createStallGuard({
          ...options.stallGuard,
          wake: (text) => (wake == null ? Promise.resolve() : wake(text)),
        });
  const guardExtension =
    guard == null ? null : defineExtension({ name: 'mc.stall-guard', hooks: guard.hooks });

  const core = defineExtension({
    name: 'mc.core',
    // 静态提示词走 section：只发增量，保 prompt cache。
    sections: [systemSection(options.systemPrompt)],
    // 动态尾巴走 beforeRequest：只影响本次请求，不落 transcript。
    hooks: [liveTailHook(options.liveTail, options.liveImage)],
    // 自然的 ReAct 工具循环：不挂 control.terminate，也没有 Finish 工具。
    // run 的结束就是"模型不再调工具"。见 loop.ts 顶部的说明。
    tools: [createSayTool(options.onSay), ...(options.tools ?? [])],
  });

  const registry = createRegistry();
  registry.install(core);
  if (guardExtension != null) registry.install(guardExtension);
  for (const extension of options.extensions ?? []) registry.install(extension);

  const session = await openBotSession({
    name: options.name,
    models: options.provider.models,
    registry,
    model: { provider: options.provider.model.provider, modelId: options.provider.model.id },
    ...(options.compaction != null ? { compaction: options.compaction } : {}),
    baseDir: options.baseDir,
    instanceId: options.instanceId,
  });

  const conversation = session.conversation;

  // 心跳出口：直接提交一条 user 消息。用 `followUp` —— 正在跑就排在本轮之后，
  // 空闲就立刻开一轮，两种情况下都不会把当前工具轮打断。
  wake = (text: UserInput) =>
    conversation.submit({ type: 'input', content: text, whenBusy: 'followUp' }, BACKGROUND_CONTEXT);

  return {
    session,
    conversation,
    submit: (content, submitOptions) => {
      // **外部输入 = 新的一轮**：把"连续只说话"的按回次数清零。
      // 否则事件频繁的 bot 会死在"计数早已到顶 + 每次事件都被拒续跑"的组合上
      // （真机 overnight_b 26 分钟零工具调用，见 stall_guard.ts 的 noteExternalInput）。
      guard?.noteExternalInput();
      const draft: SubmissionDraft = {
        type: 'input',
        content,
        ...(submitOptions?.whenBusy != null ? { whenBusy: submitOptions.whenBusy } : {}),
        ...(submitOptions?.requestId != null ? { requestId: submitOptions.requestId } : {}),
      };
      return conversation.submit(draft, BACKGROUND_CONTEXT);
    },
    abort: () => conversation.abort(BACKGROUND_CONTEXT),
    write: (entry) => conversation.submit({ type: 'write', entry }, BACKGROUND_CONTEXT),
    watch: () => conversation.watch(BACKGROUND_CONTEXT),
    close: async () => {
      guard?.stop();
      await session.close();
    },
  };
}
