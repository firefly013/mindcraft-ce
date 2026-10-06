/**
 * P5：把**冻结的感知层**接成 pi-durable 的每轮尾巴。
 *
 * 拼装顺序、分段标题与措辞与 `Agent.assembleContext`（`agent.ts:462-488`）
 * 逐字一致——`renderLiveState` 的文本是 token 与 prompt-cache 敏感契约，
 * 措辞不能顺手改。
 *
 * 这条尾巴走 `beforeRequest`（见 `loop.ts` 的 `liveTailHook`）而**不是**
 * section：事件 / 记忆 / 快照每轮都在变，进 section 就会每轮追加一条
 * `pi.system`，前缀缓存全废。
 */
import { composeTail, renderEvents, type EventEntry } from '../agent/event_stream.js';
import { renderLiveState, sampleLiveState, type SampleContext } from '../agent/live_state.js';

export interface TailInputs {
  /** 这一轮未见的事件——它是"我为什么被叫醒"的唯一解释。 */
  events: readonly EventEntry[] | null | undefined;
  /** 自然语言记忆；空串/纯空白则整段省略。 */
  memory: string;
  /** 感知采样上下文（bot / vision / goal / todos / currentAction）。 */
  sample: SampleContext;
}

/**
 * 已渲染的三段 → 尾巴。**纯函数**，顺序与省略规则都收在这里：
 * 事件 → 记忆摘要 → 世界快照，空段由 `composeTail` 丢掉。
 */
export function liveTailFromTexts(eventsText: string, memory: string, liveText: string): string {
  const trimmed = memory.trim();
  const memoryText = trimmed === '' ? '' : `## 记忆摘要\n${trimmed}`;
  return composeTail(eventsText, memoryText, `## 当前世界快照\n${liveText}`);
}

/** 现采一次并拼成尾巴。 */
export function composeLiveTail(inputs: TailInputs): string {
  return liveTailFromTexts(
    renderEvents(inputs.events),
    inputs.memory,
    renderLiveState(sampleLiveState(inputs.sample)),
  );
}
