/*
 * 身体的工具表：**声明 + 实现**，以及"声明那半份"的导出。
 *
 * 这是工具契约在身体侧的唯一真源：
 *   - `GAME_COMMANDS` 是完整的命令对象（带 `perform`），只有身体用得着；
 *   - `toolDeclarations()` 剥掉实现，产出手握手里要报给大脑的那份声明。
 * 大脑**永远拿不到**这个文件里的任何东西——它只认握手报上去的声明。
 */

import { stripBang, type ToolDeclaration, type ToolKind } from '../../shared/tools.js';
import { actionsList } from './actions.js';
import type { AgentCommand } from './actions.js';
import { queryList } from './queries.js';
import { survivalActionList, survivalQueryList } from './survival.js';
import { endgameActionList, endgameQueryList } from './endgame.js';
import { makeObsidianActionList } from './make_obsidian.js';
import { progressionActionList } from './progression.js';

/** 与旧 `to_openai_tools.ts` 的 `commandList` 同一个来源、同一个顺序。 */
export const GAME_COMMANDS: AgentCommand[] = [
    ...queryList,
    ...survivalQueryList,
    ...endgameQueryList,
    ...actionsList,
    ...survivalActionList,
    ...endgameActionList,
    ...progressionActionList,
    ...makeObsidianActionList,
];

const commandMap: Record<string, AgentCommand> = {};
for (const command of GAME_COMMANDS) {
    commandMap[command.name] = command;
}

/** 按工具名找命令实现（带不带前导 `!` 都认）。查不到返回 undefined。 */
export function findCommand(toolName: string): AgentCommand | undefined {
    return commandMap[toolName.startsWith('!') ? toolName : '!' + toolName];
}

function declarationOf(command: AgentCommand, kind: ToolKind): ToolDeclaration {
    const declaration: ToolDeclaration = {
        name: stripBang(command.name),
        description: command.description,
        kind,
    };
    if (command.params !== undefined) declaration.params = command.params;
    if (command.withScreenshot === true) declaration.withScreenshot = true;
    if (command.perform.longRunning === true) declaration.longRunning = true;
    return declaration;
}

/**
 * 握手报给大脑的工具声明。
 *
 * **kind 由命令住在哪张表决定**：查询表 = 只读（不占身体通道），动作表 = 占用型。
 * 顺序与旧 `GAME_COMMANDS` 一致——提示词里在教模型用这些工具，改集合/改顺序
 * 就是改契约。
 *
 * 这份数据会被 JSON 序列化过协议：`domain` 里的 `Infinity` 会变成 `null`，
 * 两侧的 schema 生成与范围校验本来就只认有限值，所以行为不变。
 */
export function toolDeclarations(): ToolDeclaration[] {
    return [
        ...queryList.map((command) => declarationOf(command, 'query')),
        ...survivalQueryList.map((command) => declarationOf(command, 'query')),
        ...endgameQueryList.map((command) => declarationOf(command, 'query')),
        ...actionsList.map((command) => declarationOf(command, 'action')),
        ...survivalActionList.map((command) => declarationOf(command, 'action')),
        ...endgameActionList.map((command) => declarationOf(command, 'action')),
        ...progressionActionList.map((command) => declarationOf(command, 'action')),
        ...makeObsidianActionList.map((command) => declarationOf(command, 'action')),
    ];
}

/**
 * 命名工具集合（已去 `!`）：身体侧自检"我支持哪些工具"用。
 * 协议的握手字段就是它，见 `MineflayerBody.capabilities()`。
 */
export function toolNames(): string[] {
    return GAME_COMMANDS.map((command) => stripBang(command.name));
}
