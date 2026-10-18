/**
 * 装配层：把 P1–P7 的零件拼成一个可直接驱动的 bot。
 *
 * `agent.ts` 的切换点就是"调这个，而不是旧的 `History` / `AgentLoop` / `Prompter`"。
 * 这里**只做装配**，不放业务逻辑——所以它能被完整集成测试覆盖。
 *
 * ```
 * profile ──resolveProvider──▶ ResolvedProvider（pi-ai 供应商）
 *         └─compactionPolicyFromProfile──▶ CompactionPolicy
 * openBotRuntime(...) ─▶ BotRuntime（SQLite + 工具 + 尾巴注入）
 * createStateAccess(...) ─▶ 记忆 / 地点 / 计划文档
 * EventIntake(...) ─▶ 事件 → 处理（write / steer / abort+submit / 锁通道 + 反射）
 * ```
 */
import type { EntryDraft, Extension, ToolRegistration } from '@earendil-works/pi-durable';
import { defineExtension } from '@earendil-works/pi-durable';
import { compactionPolicyFromProfile } from './compaction.js';
import { EventIntake, type EventAction, type GameEvent } from './events.js';
import { createHandlerLookup, type EventHandler } from './handlers.js';
import { intakeLifecycleHook } from './log_hooks.js';
import { resolveProvider, type ResolvedProvider } from './provider.js';
import { openBotRuntime, type BotRuntime } from './runtime.js';
import type { StallGuardOptions } from './stall_guard.js';
import { createStateAccess, type BotStateAccess } from './state_access.js';

export interface BotWiringOptions {
  /** bot 名（profile.name），决定 `bots/<name>/`。 */
  name: string;
  /** profile 原文：供应商、上下文压缩参数都从它读。 */
  profile: unknown;
  /**
   * 已解析的供应商。给了就跳过 `resolveProvider(profile)`——测试注入 faux 用，
   * 与 `PiModelOptions.fetch` 是同一个套路（不联网）。
   */
  provider?: ResolvedProvider;
  /** 静态系统提示词（走 section，应当稳定）。 */
  systemPrompt: () => string;
  /**
   * 每轮尾巴的**成品文本**（不含 `## 当前世界快照` 标题，那是 `liveTailFromText` 的事）。
   *
   * 曾经这里收的是 `SampleContext`（活的 bot 对象），由这里自己采样渲染。
   * 分层之后世界快照在**身体进程**采、渲染在大脑做，中间隔着一趟协议，
   * 所以这里改成收成品文本——形状与 `composeLiveTail` 的输出逐字一致。
   */
  liveTail: () => string | Promise<string>;
  /** 游戏工具。 */
  tools?: readonly ToolRegistration[];
  /** 额外扩展（如请求日志 hook）。 */
  extensions?: readonly Extension[];
  /** Say 通道出口（游戏内聊天 / 前端）。 */
  onSay?: (text: string) => void;
  /**
   * 事件类型 → 处理（`brain-reflex`）。
   *
   * **只有大脑侧的反射登记在这里**：身体侧的反射由身体在事件里自己声明
   * （`event.reflex`），模型的处理是默认（查不到就是交给模型）。
   */
  handlers?: readonly EventHandler[];
  /**
   * 动作通道锁：L5 事件的反射开始时锁上，最后一个反射报告完成时解开。
   * 不接就是"没有锁"（单测常用）。
   */
  beginEmergency?: () => void;
  endEmergency?: () => void;
  /**
   * 已有的接入层。给了就把运行时**接**上去，而不是新建。
   *
   * `Agent` 在 `start()` 里先建 intake、注册事件监听，等 SQLite 打开后再
   * `attach`——连接建立到就绪之间的事件因此不会丢（见 `EventIntake.attach`）。
   */
  intake?: EventIntake;
  /** 事件落点观测：每个事件实际走了 write / steer / preempt / emergency / reflex。 */
  onEvent?: (event: GameEvent, action: EventAction) => void;
  /** 落盘根目录，默认 `./bots/<name>`。 */
  baseDir?: string;
  /** 实例区分后缀，避免同名多开撞同一个库。 */
  instanceId?: string;
  /**
   * 每轮现拍一张画面（base64 jpeg），跟世界快照一起进请求。**可选**：
   * 不给就纯文本。拍不到返回 null 即可，hook 会安静降级。
   */
  liveImage?: () => Promise<string | null>;
  /**
   * 空转护栏。**这里是默认打开的地方**（`openBotRuntime` 的原语默认关，
   * 免得把"几次请求 = 几次调用"的单测语义搅乱）。
   *
   * 真机必须开：2026-10-18 实测两个 bot 各发一次纯正文请求后就原地停了
   * 10 分钟（`FINDINGS.md` F-7），根因就是"yield 之后只能靠事件唤醒"。
   * 传 `false` 可关（想精确数调用次数的集成测试用），传对象覆盖阈值。
   */
  stallGuard?: StallGuardOptions | false;
}

export interface BotWiring {
  runtime: BotRuntime;
  /** 事件接入：**事件 → 处理**的唯一入口。 */
  intake: EventIntake;
  /** 记忆 / 地点 / 计划的读写门面。 */
  state: BotStateAccess;
  /** 每轮尾巴（只有世界快照）。 */
  liveTail: () => Promise<string>;
  /** 每轮现拍画面（同 `liveImage` 选项）。 */
  liveImage?: () => Promise<string | null>;
  close: () => Promise<void>;
}

/**
 * 把一批事件写成**模型可见**的被动 entry。
 *
 * 必须带 `model`：只有 `data` 的 entry 是给视图/记账用的，模型看不到。
 * 事件用 `user` 角色承载——pi-ai 的 `Message` 联合只有 system/user/assistant/
 * toolResult，没有自定义角色；用 `system` 会被当成提示词更新重放，所以只能用
 * `user`，靠 `data` 区分它是个事件。
 *
 * 一批写成**一条** entry（同一拍里攒下的事件合并）：事件在发生的那一刻就进
 * 上下文，但不必为此把 transcript 撑成一行一条。
 */
export function eventEntryDraft(events: readonly GameEvent[]): EntryDraft {
  return {
    kind: 'mc.event',
    model: events.map((event) => ({ role: 'user' as const, content: event.text, timestamp: event.ts })),
    data: {
      events: events.map((event) => ({
        type: event.type,
        level: event.level,
        ts: event.ts,
        ...(event.reflex != null ? { reflex: event.reflex } : {}),
      })),
    },
  };
}

export async function openBotWiring(options: BotWiringOptions): Promise<BotWiring> {
  const provider = options.provider ?? resolveProvider(options.profile);
  const compaction = compactionPolicyFromProfile(options.profile);

  // 事件接入：**先建**（或接上调用方给的），这样下面那个请求生命周期的 hook
  // 能闭包住它——L3 整流的闸门就挂在那里。
  const intake = options.intake ?? new EventIntake();

  const runtime = await openBotRuntime({
    name: options.name,
    provider,
    compaction,
    ...(options.baseDir != null ? { baseDir: options.baseDir } : {}),
    ...(options.instanceId != null ? { instanceId: options.instanceId } : {}),
    systemPrompt: options.systemPrompt,
    liveTail: options.liveTail,
    ...(options.liveImage != null ? { liveImage: options.liveImage } : {}),
    // 真机默认开空转护栏；装配层是唯一决定这件事的地方。
    stallGuard: options.stallGuard ?? {},
    tools: options.tools ?? [],
    extensions: [
      ...(options.extensions ?? []),
      defineExtension({
        name: 'intake-lifecycle',
        hooks: [intakeLifecycleHook(intake)],
      }),
    ],
    ...(options.onSay != null ? { onSay: options.onSay } : {}),
  });

  const state = createStateAccess(runtime.session.harness, runtime.conversation.id);

  // 接入层可以接一个**早就建好的** intake（Agent 就是这么用的——运行时还没
  // 就绪时收到的事件会被暂存，attach 时按顺序补投）。
  const lookup = createHandlerLookup(options.handlers ?? []);
  intake.attach({
    submit: (text, whenBusy) => runtime.submit(text, { whenBusy }),
    // 只记录、不唤醒：落成 durable entry。**这就是"事件在发生那一刻进上下文"**，
    // 旧实现把它们放在内存缓冲区里等顺风车，没有下一次唤醒就永远进不去。
    write: async (events) => {
      await runtime.write(eventEntryDraft(events));
    },
    abort: () => runtime.abort(),
    lookup,
    ...(options.beginEmergency != null ? { beginEmergency: options.beginEmergency } : {}),
    ...(options.endEmergency != null ? { endEmergency: options.endEmergency } : {}),
    ...(options.onEvent != null ? { onEvent: options.onEvent } : {}),
  });

  return {
    runtime,
    intake,
    state,
    liveTail: () => Promise.resolve(options.liveTail()),
    liveImage: options.liveImage,
    close: () => runtime.close(),
  };
}

/** 供测试/诊断：当前供应商解析结果（不含会话）。 */
export function describeProvider(profile: unknown): { providerId: string; modelId: string; contextWindow: number } {
  const provider = resolveProvider(profile);
  return {
    providerId: provider.providerId,
    modelId: provider.model.id,
    contextWindow: provider.contextWindow,
  };
}
