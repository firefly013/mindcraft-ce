/**
 * P3：把 mindcraft-ce 的回合语义搬到 pi-durable 上。
 *
 * ## 核心映射：`control.terminate` ↔ "一轮一次模型调用"
 *
 * mindcraft-ce 的 ReAct 实际是**一轮一次模型调用**：`handleDecision` →
 * `runRound`（一次模型请求）→ `runCalls`（执行该响应的全部工具调用）→
 * `finishRequest`。下一轮不是由工具结果自动续起的，而是由新事件/新消息触发
 * （`agent.ts:610`、`loop.ts:132/149`）。
 *
 * pi-durable 的 `control.terminate` 恰好是这个语义：**当整轮所有结果都请求
 * terminate 时，run 不再发起下一次模型请求**。所以这里统一给每个工具挂上它，
 * 而不是只挂在 `Finish` 上——只挂 Finish 的话，`[stats, Finish]` 这种常见组合
 * 因为 stats 没请求 terminate，会白白多打一次模型。
 *
 * 保留 `Finish` 工具本身：提示词里到处在教模型"用 Finish 收尾"，删掉会改
 * 提示词契约。它现在退化为一个显式 yield，语义与其它工具一致。
 *
 * ## 动态内容不进 section
 *
 * 静态系统提示词走 `section`（只发一次增量，保 prompt cache）；每轮都变的
 * 事件 / 记忆 / 世界快照走 `beforeRequest`，只影响本次请求、不落 transcript。
 * 否则 section 值一变就追加一条 `pi.system` entry，缓存全废。
 */
import { Type } from '@earendil-works/pi-ai';
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

/**
 * 给工具挂上 `control.terminate`，实现"一轮一次模型调用"。
 *
 * 包在**所有**工具外面（含 Say / Finish），而不是逐个手写：漏一个就会出现
 * "整轮并非全部请求终止" → run 继续 → 多一次模型调用。集中在一处也好审。
 */
export function withTerminate<T extends ToolRegistration>(tool: T): T {
  // 泛型 T 的 `execute` 参数是依赖 TSchema 的元组，直接 `...callArgs` 展开
  // TS 证不出来；这里按"擦除后的形状"调用，再整体断言回 T['execute']。
  const original = tool.execute as unknown as (
    args: unknown,
    api: unknown,
    context: unknown,
  ) => Promise<Record<string, unknown> & { control?: Record<string, unknown> }>;

  const wrapped = async (args: unknown, api: unknown, context: unknown) => {
    const result = await original(args, api, context);
    return { ...result, control: { ...result.control, terminate: true } };
  };

  return { ...tool, execute: wrapped as unknown as T['execute'] } as T;
}

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

/** `Finish` 工具：显式收尾。保留是为了不改提示词契约。 */
export function createFinishTool(): ToolRegistration {
  return defineTool({
    name: 'Finish',
    description: td('Finish'),
    parameters: Type.Object({}, { additionalProperties: false }),
    // 不用 async：没有 await，而 `execute` 契约要求返回 Promise。
    execute: () => Promise.resolve({ content: [{ type: 'text' as const, text: 'Finished.' }] }),
  });
}

/**
 * 每轮请求前把动态尾巴（事件 / 记忆 / 世界快照）追加成**最后一条 user 消息**。
 *
 * 标题由拼装方负责，这里不加壳——否则 "## 事件" 会挂到
 * "## 当前世界快照" 标题底下。
 */
export function liveTailHook(liveTail: () => string): HookRegistration {
  return hook(GenerationTask, {
    beforeRequest: (request) => {
      const tail = liveTail().trim();
      if (tail === '') return undefined;
      return {
        messages: [
          ...request.messages,
          { role: 'user' as const, content: tail, timestamp: Date.now() },
        ],
      };
    },
  });
}

/** 静态系统提示词走 section：`tag: false` 表示原样渲染，不加 `<key>` 包裹。 */
export function systemSection(render: () => string): PromptSection {
  return section('system', render, { tag: false });
}
