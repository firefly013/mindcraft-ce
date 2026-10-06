/**
 * 每轮尾巴：**只在末尾注入 live state**（+ 记忆摘要）。
 *
 * ## 为什么这里没有 `## 事件` 块
 *
 * 旧设计把事件渲染进尾巴，是因为事件当时**不在**模型的上下文里——它们只进
 * 了循环的审计缓冲。现在按 L1–L5 的原生映射（见 `events.ts`）：
 *
 *   L1/L2 → `write` 被动 entry
 *   L3    → `steer` 输入（就是一条 user 消息）
 *
 * 事件**本身就是消息**，已经在上下文里了。再在尾巴里渲染一遍 `## 事件` 就是
 * 重复喂——所以这一段退役（`event_stream.ts` 的 `renderEvents` 留给前端/日志）。
 *
 * ## 为什么走 beforeRequest 而不是 section
 *
 * 记忆与快照每轮都在变，进 section 就会每轮追加一条 `pi.system`，前缀缓存全废。
 * 这条尾巴只影响本次请求、**不落 transcript**——这正是核心诉求：
 * "Live State 每次调用的最后注入，且不进上下文"。
 *
 * 拼装顺序与措辞与 `Agent.assembleContext`（`agent.ts:462-488`）保持一致：
 * `renderLiveState` 的文本是 token 与 prompt-cache 敏感契约，措辞不能顺手改。
 */
import { composeTail } from '../agent/event_stream.js';
import { renderLiveState, sampleLiveState, type SampleContext } from '../agent/live_state.js';

export interface TailInputs {
  /** 自然语言记忆；空串/纯空白则整段省略。 */
  memory: string;
  /** 感知采样上下文（bot / vision / goal / todos / currentAction）。 */
  sample: SampleContext;
}

/**
 * 记忆 + 世界快照 → 尾巴。**纯函数**，顺序与省略规则都收在这里：
 * 记忆摘要 → 世界快照，空段由 `composeTail` 丢掉。
 */
export function liveTailFromTexts(memory: string, liveText: string): string {
  const trimmed = memory.trim();
  const memoryText = trimmed === '' ? '' : `## 记忆摘要\n${trimmed}`;
  return composeTail(memoryText, `## 当前世界快照\n${liveText}`);
}

/** 现采一次并拼成尾巴。 */
export function composeLiveTail(inputs: TailInputs): string {
  return liveTailFromTexts(inputs.memory, renderLiveState(sampleLiveState(inputs.sample)));
}
