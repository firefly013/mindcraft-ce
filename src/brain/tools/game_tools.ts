/**
 * 把身体报上来的工具声明装成 pi-durable 注册表。
 *
 * **声明来自握手**（`BodyCapabilities.tools`）：身体是工具的真源，它声明自己
 * 能跑哪些命令、参数长什么样。大脑不 import 身体的任何实现——这正是
 * "身体和大脑分在两个进程"能成立的前提。
 *
 * 工具顺序与旧 `getOpenAITools` 完全一致（查询表在前、动作表在后）——
 * 提示词里在教模型用这些工具，改集合就是改契约。
 *
 * 控制类工具不在这里：`Say` 由 `openBotRuntime` 自动装（它要写 `mc.say` entry），
 * `Stop` / `UpdatePlan` / `Feedback` 在 `control_tools.ts` 里各自成型。
 */
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { ToolDeclaration } from '../../shared/tools.js';
import { paramNames } from './tool_schema.js';
import { commandToRegistration, loopResultText, type ToolOutcome } from './tools.js';
import { withLongRangeNudge } from './long_range_hint.js';

export interface GameToolDeps {
  /**
   * 身体握手报上来的工具声明。**必填**：大脑这边不再有第二份命令表，
   * 空数组就是"这个身体一个游戏工具都不支持"。
   */
  declarations: readonly ToolDeclaration[];
  /**
   * 工具执行。`name` 不带前导 `!`，`args` 是**具名**参数——形状对回
   * 身体侧的 `executeToolCall(agent, name, args)`。
   */
  execute: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
  /**
   * 现拍一张画面（base64 jpeg），给声明了 `withScreenshot` 的命令用。
   * 不传 = 所有命令的回执都是纯文本。
   */
  captureImage?: () => Promise<string | null>;
}

export function buildGameTools(deps: GameToolDeps): ToolRegistration[] {
  return deps.declarations.map((declaration) =>
    commandToRegistration(declaration, (_command, ordered) => {
      // `commandToRegistration` 把具名参数压成了位置参数（因为身体侧
      // `executeToolCall` 内部按 `params` 顺序取值）。这里转回具名，
      // 形状对回实现。`undefined` 不写入，这样 JS 默认参数才会生效
      // （例如 getCraftingPlan.quantity 的默认 1）。
      const names = paramNames(declaration);
      const named: Record<string, unknown> = {};
      names.forEach((name, index) => {
        const value = ordered[index];
        if (value !== undefined) named[name] = value;
      });
      return deps.execute(declaration.name, named);
    }, deps.captureImage),
  );
}

/** 身体通道的最小接口（`ActionRunner` 满足它）。 */
export interface ActionChannel {
  run(name: string, args: unknown): Promise<ToolOutcome>;
}

/**
 * 工具调用 → 身体通道的接线。
 *
 * **单独抽出来是为了可测**：`agent.ts` 的 `invokeTool` 就是调它，所以测试跑
 * 的就是生产路径。如果哪天有人把工具的 `execute` 直连 `executeToolCall`，
 * 「动作类工具真的占用了身体通道」这条断言会红——那是 E1/E3 失效的前兆，
 * 而它们在契约层是测不出来的（见 `runtime_action_boundary.test.ts` 的说明）。
 *
 * `options.hint` 是**大脑侧的回执追加**（例如"这个工具不是干这件事的，去用 travelTo"）：
 * 身体不知道 goal/places，只有大脑知道；而模型**跟回执比跟散文说明可靠得多**。
 * hint 抛错/返回 null 都只是"没有提醒"，绝不影响回执本身。
 */
export function actionChannelInvoker(
  channel: ActionChannel,
  options: {
    hint?: (name: string, args: Record<string, unknown>, text: string) => string | null | Promise<string | null>;
  } = {},
): (name: string, args: Record<string, unknown>) => Promise<string> {
  return async (name, args) => {
    const result = await channel.run(name, args);
    const text = loopResultText(name, args, result);
    if (options.hint == null) return text;
    try {
      const hint = await options.hint(name, args, text);
      if (hint == null || hint === '') return text;
      // **插在「下一步」之前**：回执最后一行必须还是那条能照抄的调用。
      return withLongRangeNudge(text, hint);
    } catch {
      return text;
    }
  };
}
