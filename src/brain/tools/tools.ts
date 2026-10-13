/**
 * 工具**声明** → pi-durable 工具注册项，以及 `blocked_actions` 的真正强制点。
 *
 * 这里**不重写**任何 `perform` 实现——那些都在身体进程里，一次协议调用之外
 * 与大脑无关。大脑只拿到声明（名字/描述/参数），据此生成 schema 并把调用
 * 转给身体通道（`execute` 由装配方注入）。
 */
import {
  ToolTask,
  defineTool,
  hook,
  type HookRegistration,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { MESSAGES } from '../../shared/prompts.js';
import type { ToolDeclaration } from '../../shared/tools.js';
import { commandParameters, paramNames } from './tool_schema.js';

/**
 * 工具执行结果的形状。
 *
 * 与旧 `LoopToolResult` **结构兼容**，但在这里独立声明：那个类型住在
 * `agent/loop.ts` 里，而翻转后那个文件会消失——回执的渲染逻辑不该跟着陪葬。
 */
export interface ToolOutcome {
  status: 'completed' | 'accepted' | 'rejected';
  data?: unknown;
  code?: string;
  reason?: string;
}

/**
 * 工具执行结果 → 模型看到的回执文本。
 *
 * 与旧 `Agent.runTool` **逐字一致**（`MESSAGES.toolOutcome` + `outcomeText`）：
 * 回执措辞是模型学过的契约，改一个字都是改契约。
 *
 * 注意 `accepted` 也走"完成"分支——动作类工具即时回 accepted，正文就是它
 * 认领通道时给的那点信息（`{action_id, generation}` 或 `{already_running:true}`）；
 * 真正的结果以后以 L3 事件回来。
 */
export function loopResultText(name: string, args: unknown, result: ToolOutcome): string {
  const outcome =
    result.status === 'rejected'
      ? `rejected: ${result.reason ?? result.code ?? 'unknown'}`
      : outcomeText(result.data);
  return MESSAGES.toolOutcome(name, args, outcome);
}

/** 回执正文：与 `Agent.outcomeText` 逐字一致（对象 JSON 化，null/空串 → '(no output)'）。 */
export function outcomeText(data: unknown): string {
  if (data == null) return '(no output)';
  if (typeof data === 'string') return data === '' ? '(no output)' : data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    // 循环引用之类。**不能**退回 `String(data)`——那是 `[object Object]`，
    // 看起来像一条真的回执，比没有信息更糟（项目本来就要求不出现它）。
    return '[unserializable]';
  }
}

/** 执行一个命令；`orderedArgs` 已按 `params` 的 key 顺序排好。 */
export type CommandInvoke = (
  command: ToolDeclaration,
  orderedArgs: unknown[],
) => unknown | Promise<unknown>;

/**
 * 工具声明 → 工具注册项。
 *
 * `invoke` 是注入的：转换器本身可单测，装配方传入"闭包住 Agent / 身体通道"的
 * 实现即可，转换逻辑不用改。
 */
export function commandToRegistration(
  command: ToolDeclaration,
  invoke: CommandInvoke,
  /** 现拍一张截图，返回 base64；相机没开/拍失败返回 null。只有命令声明要图时才调。 */
  captureImage?: () => Promise<string | null>,
): ToolRegistration {
  return defineTool({
    name: command.name,
    description: command.description || command.name,
    parameters: commandParameters(command),
    execute: async (args) => {
      // 位置参数按 params 的 key 顺序取；`null` 归一为 `undefined`，这样 JS
      // 默认参数才会生效（例如 getCraftingPlan.quantity 的默认 1）。
      // 与旧 executeToolCall 的 `args[k] ?? undefined` 一致。
      const source = (args ?? {}) as Record<string, unknown>;
      const ordered = paramNames(command).map((name) => source[name] ?? undefined);
      const raw = await invoke(command, ordered);

      // **回执可以带图**（pi-ai 的 toolResult.content 是
      // (TextContent | ImageContent)[]）。文本照旧逐字不变——措辞是模型学过的契约，
      // 图片只是**追加**在后面，不修改任何既有回执。
      const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: outcomeText(raw) },
      ];
      if (command.withScreenshot === true && captureImage != null) {
        let image: string | null;
        try {
          image = await captureImage();
        } catch {
          image = null; // 拍不到就只给文本，绝不因为视觉失败毁掉整条回执。
        }
        if (image != null) parts.push({ type: 'image', data: image, mimeType: 'image/jpeg' });
      }
      return { content: parts };
    },
  });
}

/**
 * `blocked_actions` 的**真正**强制点。
 *
 * 旧实现只在 `getOpenAITools` 里过滤**广告**：被隐藏的工具
 * 只要模型按名字直接调用就**照样执行**（`validateToolCall` 与
 * `executeToolCall` 都不查黑名单）。迁到 pi-durable 后，`beforeTool` 才是
 * 拦得住的地方——这是这次迁移顺带修掉的一个安全问题。
 *
 * 名单里存的是带 `!` 的命令名（如 `!checkBlueprint`），而工具名已 strip 过，
 * 所以两种写法都要比对。
 */
export function blockedActionsHook(blocked: () => readonly string[]): HookRegistration {
  return hook(ToolTask, {
    beforeTool: (call) => {
      const names = blocked();
      if (names.includes(call.name) || names.includes(`!${call.name}`)) {
        return { block: `工具 ${call.name} 已被 blocked_actions 禁用。` };
      }
      return undefined;
    },
  });
}
