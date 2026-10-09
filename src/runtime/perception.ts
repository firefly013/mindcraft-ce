/**
 * 每轮尾巴：**只有世界快照**。
 *
 * ## 为什么没有 `## 事件`
 *
 * 按 L1–L5 的原生映射（见 `events.ts`），事件**本身就是消息**：
 * L1/L2 走 `write` 被动 entry、L3 走 `steer` 输入。已经在上下文里了，
 * 再在尾巴里渲染一遍就是重复喂。
 *
 * ## 为什么没有 `## 记忆摘要`
 *
 * 记忆摘要现在**就是压仓摘要**——它作为对话里的第一条条目随整份历史发出
 * （Pi 的投影：`system + 摘要 + 保留段`）。以前在这里又发一遍，等于把摘要
 * 喂两次。主线（`92309d1`）已经把这一段删掉，这里跟随。
 *
 * 所以尾巴只剩一件事：**把这一刻的世界注入在请求末尾，且不进上下文**。
 * 这正是本项目的核心诉求（`docs/agent-design.md` §4.1）。
 *
 * ## 为什么走 beforeRequest 而不是 section
 *
 * 快照每轮都在变，进 section 就会每轮追加一条 `pi.system`，前缀缓存全废。
 * 这条尾巴只影响本次请求、**不落 transcript**。
 */
import { renderLiveState, sampleLiveState, type SampleContext } from '../agent/live_state.js';

/** 尾巴的唯一内容：`## 当前世界快照` + 现采文本。 */
export function liveTailFromText(liveText: string): string {
  return `## 当前世界快照\n${liveText}`;
}

/** 现采一次并拼成尾巴。 */
export function composeLiveTail(sample: SampleContext): string {
  return liveTailFromText(renderLiveState(sampleLiveState(sample)));
}
