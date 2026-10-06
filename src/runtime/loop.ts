/**
 * 运行时原语：工具、尾巴注入、系统提示词 section。
 *
 * ## 回合语义：自然的 ReAct 工具循环（**没有**强制工具、**没有** Finish）
 *
 * 这里曾经给每个工具挂 `control.terminate`，把语义钉成"一轮一次模型调用"——
 * 那是从旧 mindcraft-ce（`tool_choice: 'required'` + `Finish`）继承来的枷锁。
 *
 * 现在的目标是**一个普通的 Agent**（Pi / OpenCode / DSH 那种）：模型调工具 →
 * 拿结果 → 再调 → …… 直到它自己不再调工具、给出最终回答。run 的结束就是
 * "模型不调工具了"，不需要 `Finish` 这个工具，也不需要强制调用。
 *
 * 这么做还带来一个实际好处：`steer`（引导）**才活过来**。挂着 terminate 时
 * run 在工具轮后立刻结束，steer 没有"正在进行的工作"可以加入，只能退化成
 * `followUp`（多一次往返）——实测见 `tests/runtime_steer_vs_followup.test.ts`。
 *
 * ## 如果模型"只说一句话、不调工具"怎么办
 *
 * 这正是当初加 Finish 的原因。比强制工具干净的替代是 pi-durable 的
 * `GenerationHooks.onYield`：模型给出最终回答时，hook 可以返回
 * `{ continue: "还没做完，继续" }` 把它按回去接着干。需要时再挂，不必现在就上。
 *
 * ## 动态内容不进 section
 *
 * 静态系统提示词走 `section`（只发一次增量，保 prompt cache）；每轮都变的
 * 事件 / 记忆 / 世界快照走 `beforeRequest`，只影响本次请求、不落 transcript。
 * 否则 section 值一变就追加一条 `pi.system` entry，缓存全废。
 */
import { Type } from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';
import {
  GenerationTask,
  defineTool,
  hook,
  section,
  type HookRegistration,
  type PromptSection,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { td, tp } from '../prompts.js';
import { SayEntry } from './entries.js';

/** 单条 Say 的字符上限（沿用现有 `SAY_LINE_LIMIT`）。 */
export const SAY_LINE_LIMIT = 240;

/** `Say` 工具：说话走独立 entry，不污染工具结果文本。 */
export function createSayTool(onSay: (text: string) => void = () => {}): ToolRegistration {
  return defineTool({
    name: 'Say',
    // 描述取自 `prompts.ts` 的 `td('Say')`，与旧 `getOpenAITools` 广告出去
    // 的逐字一致——提示词里在教模型用这些工具，改文案就是改契约。
    description: td('Say'),
    parameters: Type.Object(
      { text: Type.String({ description: tp('Say', 'text') }) },
      { additionalProperties: false },
    ),
    execute: async (args, api, context) => {
      const text = args.text.trim();
      // 空话拒绝：与现有行为一致，且不写 entry。
      if (text === '') {
        return { content: [{ type: 'text' as const, text: 'Say 需要非空文本。' }], isError: true };
      }
      const line = text.length > SAY_LINE_LIMIT ? text.slice(0, SAY_LINE_LIMIT) : text;
      await api.commit(async (tx) => {
        await tx.appendEntry(SayEntry, api.conversationId, { data: { text: line } });
      }, context);
      onSay(line);
      return { content: [{ type: 'text' as const, text: line }] };
    },
  });
}

/**
 * 每轮请求前把动态尾巴（记忆 / 世界快照）追加成**最后一条 user 消息**。
 *
 * 尾巴可以是异步的：记忆存在文档里，要读一次。但**同步生产器仍走同步路径**——
 * 尾巴为空时直接返回 `undefined`（不追加消息），契约与旧实现逐字一致；
 * 只有生产器真返回 Promise 时才变成异步 hook。
 *
 * 标题由拼装方负责，这里不加壳——否则 "## 记忆摘要" 会挂到
 * "## 当前世界快照" 标题底下。
 */
export function liveTailHook(liveTail: () => string | Promise<string>): HookRegistration {
  const append = (
    request: { readonly messages: readonly Message[] },
    raw: string,
  ): { readonly messages: readonly Message[] } | undefined => {
    const tail = raw.trim();
    if (tail === '') return undefined;
    return {
      messages: [
        ...request.messages,
        { role: 'user' as const, content: tail, timestamp: Date.now() },
      ],
    };
  };

  return hook(GenerationTask, {
    beforeRequest: (request) => {
      const tail = liveTail();
      return typeof tail === 'string'
        ? append(request, tail)
        : tail.then((value) => append(request, value));
    },
  });
}

/** 静态系统提示词走 section：`tag: false` 表示原样渲染，不加 `<key>` 包裹。 */
export function systemSection(render: () => string): PromptSection {
  return section('system', render, { tag: false });
}
