/**
 * 把 Agent 的全部游戏工具装成 pi-durable 注册表。
 *
 * 这是切换 `agent.ts` 时缺的那块：P4 造好了 `commandToRegistration`（单条适配），
 * 但没有"把全部工具装起来"的装配函数。这里补上。
 *
 * **适配而非重写**：每条命令的实现仍然是旧的 `executeToolCall(agent, name, args)`，
 * 一个字都没动。工具来源与顺序也与旧 `getOpenAITools` 完全一致——提示词里在教
 * 模型用这些工具，改集合就是改契约。
 *
 * 控制类工具不在这里：`Say` 由 `openBotRuntime` 自动装（它要写 `mc.say` entry），
 * `Stop` / `UpdatePlan` / `Feedback` 在 `control_tools.ts` 里各自成型。
 */
import type { ToolRegistration } from '@earendil-works/pi-durable';
import { actionsList, type AgentCommand } from '../../body/commands/actions.js';
import { queryList } from '../../body/commands/queries.js';
import { stripBang } from '../../body/commands/to_openai_tools.js';
import { paramNames } from './tool_schema.js';
import { commandToRegistration, loopResultText, type ToolOutcome } from './tools.js';

/** 与旧 `to_openai_tools.ts` 的 `commandList` 同一个来源、同一个顺序。 */
export const GAME_COMMANDS: AgentCommand[] = queryList.concat(actionsList);

export interface GameToolDeps {
  /**
   * 工具执行。`name` 已 strip 掉前导 `!`，`args` 是**具名**参数——
   * 直接就是 `executeToolCall(agent, name, args)` 的形状。
   */
  execute: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
  /**
   * 身体声明它能执行哪些命令（`BodyCapabilities.commands`，已去掉前导 `!`）。
   *
   * **这是"能力协商"落地的地方**：身体不支持的命令**不进 schema**，否则模型会调
   * 一个必然失败的工具。Mineflayer 身体声明全部命令（`skills.ts` 就在它里面），
   * 而将来的 Java 身体声明得少——这正是那个机制存在的理由。
   *
   * 不传 = 全部命令。给测试和"还没有身体"的场景留的默认值；**大脑必须显式传**，
   * 否则这一层就是装饰。
   */
  commands?: readonly string[];
  /**
   * 现拍一张画面（base64 jpeg），给声明了 `withScreenshot` 的命令用。
   * 不传 = 所有命令的回执都是纯文本。
   */
  captureImage?: () => Promise<string | null>;
}

/**
 * 把完整命令表按身体声明的能力过滤。
 *
 * 抽成独立函数是因为**两个地方**要用同一套过滤（工具装配、请求日志头、CLI 的
 * `tools`），各写一遍迟早漂移。
 */
export function commandsForBody(bodyCommands?: readonly string[]): AgentCommand[] {
  if (bodyCommands == null) return GAME_COMMANDS;
  // 前导 `!` 宽容处理：协议上说好了不带，但能力表是手写的（将来 Java 那边更是），
  // 多一个 `!` 的代价是**这个身体静默失去全部工具**——而这种失败不会报错。
  // 宽容一点，让"多打一个感叹号"不至于变成一次事故。
  const allowed = new Set(bodyCommands.map(stripBang));
  return GAME_COMMANDS.filter((command) => allowed.has(stripBang(command.name)));
}

export function buildGameTools(deps: GameToolDeps): ToolRegistration[] {
  return commandsForBody(deps.commands).map((command) =>
    commandToRegistration(command, (_command, ordered) => {
      // `commandToRegistration` 把具名参数压成了位置参数（因为旧
      // `executeToolCall` 内部按 `params` 顺序取值）。这里转回具名，
      // 形状对回旧实现。`undefined` 不写入，这样 JS 默认参数才会生效
      // （例如 getCraftingPlan.quantity 的默认 1）。
      const names = paramNames(command);
      const named: Record<string, unknown> = {};
      names.forEach((name, index) => {
        const value = ordered[index];
        if (value !== undefined) named[name] = value;
      });
      return deps.execute(stripBang(command.name), named);
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
 */
export function actionChannelInvoker(
  channel: ActionChannel,
): (name: string, args: Record<string, unknown>) => Promise<string> {
  return async (name, args) => {
    const result = await channel.run(name, args);
    return loopResultText(name, args, result);
  };
}
