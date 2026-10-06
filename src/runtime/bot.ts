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
 * EventIntake(...) ─▶ L1–L5 → 原生原语（write / steer / abort+submit / abort+rescue）
 * ```
 */
import type { EntryDraft, Extension, ToolRegistration } from '@earendil-works/pi-durable';
import { defineExtension } from '@earendil-works/pi-durable';
import type { SampleContext } from '../agent/live_state.js';
import { compactionPolicyFromProfile } from './compaction.js';
import { EventIntake, type GameEvent } from './events.js';
import { intakeLifecycleHook } from './log_hooks.js';
import { composeLiveTail } from './perception.js';
import { resolveProvider, type ResolvedProvider } from './provider.js';
import { openBotRuntime, type BotRuntime } from './runtime.js';
import { createStateAccess, type BotStateAccess } from './state_access.js';

export interface BotWiringOptions {
  /** bot 名（profile.name），决定 `bots/<name>/`。 */
  name: string;
  /** profile 原文：供应商、压仓参数都从它读。 */
  profile: unknown;
  /**
   * 已解析的供应商。给了就跳过 `resolveProvider(profile)`——测试注入 faux 用，
   * 与 `PiModelOptions.fetch` 是同一个套路（不联网）。
   */
  provider?: ResolvedProvider;
  /** 静态系统提示词（走 section，应当稳定）。 */
  systemPrompt: () => string;
  /** 感知采样上下文，每轮现采。 */
  sample: () => SampleContext;
  /** 游戏工具。 */
  tools?: readonly ToolRegistration[];
  /** 额外扩展（如请求日志 hook）。 */
  extensions?: readonly Extension[];
  /** Say 通道出口（游戏内聊天 / 前端）。 */
  onSay?: (text: string) => void;
  /** L5 的保命反射，绕过模型。 */
  rescue: () => Promise<void>;
  /**
   * 已有的接入层。给了就把运行时**接**上去，而不是新建。
   *
   * `Agent` 在 `start()` 里先建 intake、注册事件监听，等 SQLite 打开后再
   * `attach`——连接建立到就绪之间的事件因此不会丢（见 `EventIntake.attach`）。
   */
  intake?: EventIntake;
  /** 事件落点观测：每个事件实际走了 write / steer / preempt / emergency。 */
  onEvent?: (event: GameEvent, action: 'write' | 'steer' | 'preempt' | 'emergency') => void;
  /** 落盘根目录，默认 `./bots/<name>`。 */
  baseDir?: string;
  /** 实例区分后缀，避免同名多开撞同一个库。 */
  instanceId?: string;
}

export interface BotWiring {
  runtime: BotRuntime;
  /** L1–L5 事件接入。 */
  intake: EventIntake;
  /** 记忆 / 地点 / 计划的读写门面。 */
  state: BotStateAccess;
  /** 每轮尾巴（只有世界快照）。 */
  liveTail: () => Promise<string>;
  close: () => Promise<void>;
}

/**
 * 把一个事件写成**模型可见**的被动 entry。
 *
 * 必须带 `model`：只有 `data` 的 entry 是给视图/记账用的，模型看不到。
 * 事件用 `user` 角色承载——pi-ai 的 `Message` 联合只有 system/user/assistant/
 * toolResult，没有自定义角色；用 `system` 会被当成提示词更新重放，所以只能用
 * `user`，靠 `data.level` 区分它是个事件。
 */
export function eventEntryDraft(event: GameEvent): EntryDraft {
  return {
    kind: 'mc.event',
    model: [{ role: 'user', content: event.text, timestamp: Date.now() }],
    data: { level: event.level },
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
    liveTail: () => composeLiveTail(options.sample()),
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
  intake.attach({
    submit: (text, whenBusy) => runtime.submit(text, { whenBusy }),
    abort: () => runtime.abort(),
    rescue: options.rescue,
    ...(options.onEvent != null ? { onEvent: options.onEvent } : {}),
  });

  return {
    runtime,
    intake,
    state,
    liveTail: () => Promise.resolve(composeLiveTail(options.sample())),
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
