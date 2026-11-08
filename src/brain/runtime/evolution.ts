/**
 * 自进化模式的装配：四个工具（read / write / edit / shell）和它们执行时的环境。
 *
 * 工具直接用 pi-durable 的 `/tools`，不在这里重写一套文件与进程工具。理由：
 * 那些工具已经按 durable 工具任务的语义实现好了（结果提交、输出窗口、截断、
 * spill 文件、同一文件上 write/edit 的串行化），再包一层只会多出一份会漂移的
 * 回执格式。这里只负责把环境的工作目录钉在仓库根，并决定 Windows 上用哪个 shell。
 *
 * `NodeExecutionEnv` 不限制绝对路径，这不是沙箱。给模型的是一双手，能改哪里
 * 由提示词和开关决定，不由工具层假装成"校验"。
 */
import {
  defineExtension,
  section,
  type Extension,
  type HarnessOptions,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import {
  createBashTool,
  createEditTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { EVOLUTION_PROMPT } from '../../shared/prompts.js';

/** 工具执行环境；形状与 `HarnessOptions.env` 一致，上层只依赖这个类型。 */
export type EvolutionEnv = NonNullable<HarnessOptions['env']>;

/** `bash` 和 `powershell` 二选一，取决于宿主平台。 */
export type EvolutionShell = 'bash' | 'powershell';

/** 自进化模式要装进运行时的两样东西。 */
export interface EvolutionRuntime {
  /** pi-durable 扩展：四个工具，加一段只在自进化模式出现的系统提示词。 */
  extension: Extension;
  /** 传给 `Harness.open` 的环境工厂。 */
  env: EvolutionEnv;
}

/**
 * Windows 用 PowerShell，其他平台用 bash。
 *
 * `NodeExecutionEnv` 在 Windows 上只会去找 Git Bash 或 PATH 里的 bash。这个
 * 仓库跑在 Windows 上时那条路要么不存在、要么落到 WSL 的 bash 上（Linux 路径、
 * 另一套工具链），对"改本仓库代码"是错的环境。PowerShell 工具用 argv 直接起
 * `pwsh`/`powershell`，不经过 shell 解析，在 Windows 上是稳的那条。
 */
export function evolutionShell(platform: NodeJS.Platform = process.platform): EvolutionShell {
  return platform === 'win32' ? 'powershell' : 'bash';
}

/**
 * 装配自进化模式。
 *
 * `workspace` 同时是工具的工作目录和系统提示词里写的仓库路径。两处必须由同一次
 * 调用决定，否则模型按提示词里的绝对路径去读，读到的会是另一个地方。
 */
export function openEvolution(
  workspace: string,
  platform: NodeJS.Platform = process.platform,
): EvolutionRuntime {
  const shell = evolutionShell(platform);
  const shellTool: ToolRegistration = shell === 'bash' ? createBashTool() : createPowerShellTool();
  const extension = defineExtension({
    name: 'mc.evolution',
    sections: [section('evolution', () => EVOLUTION_PROMPT(workspace, shell), { tag: false })],
    tools: [createReadTool(), createWriteTool(), createEditTool(), shellTool],
  });
  // 每次工具调用现建一个环境：这是 pi-durable 推荐的用法，write/edit 会按
  // 环境的 id 和路径把同一文件的改动串起来，不会因为环境是新的就失去串行化。
  const env: EvolutionEnv = ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace });
  return { extension, env };
}
