/**
 * 静态系统提示词。
 *
 * 为什么必须**静态**：它走 pi-durable 的 `section`——section 的值一变就会追加
 * 一条 `pi.system` 条目，前缀缓存全废。所以任何每轮都变的东西都不能进来。
 *
 * 与旧的 `Prompter.replaceStrings` 的分工：
 *
 * | 占位符 | 旧的去处 | 现在的去处 |
 * |---|---|---|
 * | `$NAME` | 系统提示词 | **系统提示词**（唯一保留的） |
 * | `$STATS` / `$INVENTORY` / `$ACTION` | 系统提示词 | 每轮尾巴（Live State） |
 * | `$MEMORY` | 系统提示词 | 每轮尾巴（记忆摘要） |
 * | `$CONVO` | 系统提示词 | 对话历史本身 |
 * | `$TO_SUMMARIZE` / `$LAST_GOALS` | 摘要 / 目标设定提示词 | 不由本函数处理 |
 *
 * 换句话说：系统提示词里**只剩 `$NAME`**。剩下的占位符如果还出现，说明
 * profile 覆盖的提示词集是旧的，这里会明确警告而不是静默留下 `$FOO`。
 */
import { resolvePromptSet } from '../prompts.js';
import type { AgentProfile } from '../types/common.js';

/**
 * 把提示词模板渲染成静态系统提示词。
 *
 * 未替换的占位符会警告——静默留一个 `$STATS` 在系统提示词里，模型会当成
 * 字面文本读，比报错更难查。
 */
/**
 * 把提示词模板渲染成静态系统提示词。
 *
 * 未替换的占位符会警告——静默留一个 `$STATS` 在系统提示词里，模型会当成
 * 字面文本读，比报错更难查。
 *
 * 模板缺省（profile 把提示词集覆盖坏了）时返回空串：宁可没有系统提示词，
 * 也不要发一个字面 `undefined` 出去。
 */
export function staticSystemPrompt(conversing: string | undefined, name: string): string {
  if (conversing == null) return '';
  const text = conversing.replaceAll('$NAME', name);
  const remaining = text.match(/\$[A-Z_]+/g);
  if (remaining != null) {
    console.warn('系统提示词里还有未替换的占位符:', remaining.join(', '));
  }
  return text;
}

/**
 * 从 profile 解析提示词集并渲染。
 *
 * `profile` 收 `unknown` 是因为调用方（`settings.profile`）本来就是无类型的；
 * 未知的 `prompt_set` 由 `resolvePromptSet` 回退到默认集。
 */
export function systemPromptFromProfile(profile: unknown, name: string): string {
  const prompts = resolvePromptSet(profile as AgentProfile | undefined) as Record<string, string>;
  return staticSystemPrompt(prompts['conversing'], name);
}
