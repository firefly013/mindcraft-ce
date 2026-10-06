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
  type Conversation,
  type ConversationWatch,
  type Extension,
  type Submission,
  type SubmissionDraft,
  type ToolRegistration,
  type UserInput,
} from '@earendil-works/pi-durable';
import { createFinishTool, createSayTool, liveTailHook, systemSection, withTerminate } from './loop.js';
import type { ResolvedProvider } from './provider.js';
import { openBotSession, type BotSession } from './session.js';

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
  /** 实例区分后缀，避免同名多开撞同一个库。 */
  instanceId?: string;
  /** 静态系统提示词。应当稳定，否则会破坏 prompt cache。 */
  systemPrompt: () => string;
  /** 每轮请求前注入的动态尾巴（事件 / 记忆 / 世界快照）；空串则不加。 */
  liveTail: () => string;
  /** 游戏工具；会自动挂上 `control.terminate`。 */
  tools?: readonly ToolRegistration[];
  /** Say 通道回调（写游戏内聊天 / 推前端）。 */
  onSay?: (text: string) => void;
  /** 额外扩展（状态文档等，后续阶段接）。 */
  extensions?: readonly Extension[];
}

export interface BotRuntime {
  session: BotSession;
  conversation: Conversation;
  /** 提交用户/系统输入，返回可 `wait()` 的 submission。 */
  submit(content: UserInput, options?: SubmitOptions): Promise<Submission>;
  /** 中断当前 run（L4/L5 抢占的落点）。 */
  abort(): Promise<void>;
  /** 结构视图，供前端 late-join / 重连。 */
  watch(): Promise<ConversationWatch>;
  close(): Promise<void>;
}

export async function openBotRuntime(options: BotRuntimeOptions): Promise<BotRuntime> {
  const core = defineExtension({
    name: 'mc.core',
    // 静态提示词走 section：只发增量，保 prompt cache。
    sections: [systemSection(options.systemPrompt)],
    // 动态尾巴走 beforeRequest：只影响本次请求，不落 transcript。
    hooks: [liveTailHook(options.liveTail)],
    tools: [
      withTerminate(createSayTool(options.onSay)),
      withTerminate(createFinishTool()),
      ...(options.tools ?? []).map((tool) => withTerminate(tool)),
    ],
  });

  const registry = createRegistry();
  registry.install(core);
  for (const extension of options.extensions ?? []) registry.install(extension);

  const session = await openBotSession({
    name: options.name,
    models: options.provider.models,
    registry,
    model: { provider: options.provider.model.provider, modelId: options.provider.model.id },
    baseDir: options.baseDir,
    instanceId: options.instanceId,
  });

  const conversation = session.conversation;

  return {
    session,
    conversation,
    submit: (content, submitOptions) => {
      const draft: SubmissionDraft = {
        type: 'input',
        content,
        ...(submitOptions?.whenBusy != null ? { whenBusy: submitOptions.whenBusy } : {}),
        ...(submitOptions?.requestId != null ? { requestId: submitOptions.requestId } : {}),
      };
      return conversation.submit(draft, BACKGROUND_CONTEXT);
    },
    abort: () => conversation.abort(BACKGROUND_CONTEXT),
    watch: () => conversation.watch(BACKGROUND_CONTEXT),
    close: () => session.close(),
  };
}
