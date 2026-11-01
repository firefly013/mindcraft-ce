/*
 * 身体的工具表：**声明 + 实现**，以及"声明那半份"的导出。
 *
 * 这是工具契约在身体侧的唯一真源：
 *   - `GAME_COMMANDS` 是完整的命令对象（带 `perform`），只有身体用得着；
 *   - `toolDeclarations()` 剥掉实现，产出手握手里要报给大脑的那份声明。
 * 大脑**永远拿不到**这个文件里的任何东西——它只认握手报上去的声明。
 */

import { stripBang, type ToolDeclaration, type ToolKind } from '../../shared/tools.js';
import type { ResumePolicy } from '../../shared/resume.js';
import { actionsList } from './actions.js';
import type { AgentCommand } from './actions.js';
import { queryList } from './queries.js';
import { survivalActionList, survivalQueryList } from './survival.js';
import { endgameActionList, endgameQueryList } from './endgame.js';
import { makeObsidianActionList } from './make_obsidian.js';
import { progressionActionList } from './progression.js';
import { throwingActionList } from './throwing.js';

/** 与旧 `to_openai_tools.ts` 的 `commandList` 同一个来源、同一个顺序。 */
export const GAME_COMMANDS: AgentCommand[] = [
    ...queryList,
    ...survivalQueryList,
    ...endgameQueryList,
    ...actionsList,
    ...survivalActionList,
    ...endgameActionList,
    ...progressionActionList,
    ...throwingActionList,
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

/**
 * **续做策略表**：被反射打断后，哪些动作可以机械续做。
 *
 * 只列 `auto` / `checkpoint`；**没列的一律 `manual`**（fail-safe：有副作用、
 * 需要窗口/序列状态、或者该由模型重新决定的，都不自动重放）。
 *
 * 判定标准只有一条：**原样（或按进度折算）重发一次，是不是就等于"接着做完"？**
 *   - `auto`：工具自己会重新找目标/重新算路，重发即可（travelTo / goToCoordinates …）；
 *   - `checkpoint`：重发前要扣掉已经完成的部分，否则会重复做。两种进度形态：
 *       · 计数型：collectBlocks 按背包里的掉落物数；
 *       · 距离型：digDown/stairUp/pillarUp/mineTunnel 按**原始终点**折算
 *         （位置由大脑采样身体坐标，被打断期间被推走也能接着走到原始终点）；
 *   - `manual`：craft/smelt/placeBlock/useOn/attack/enterNether/末地系列……
 *     窗口状态没了、材料可能已经消耗、方块可能已经放下一半——不能盲目重放。
 *
 * 这张表是身体侧"声明"的一部分，经握手报给大脑；大脑只按它机械执行。
 */
const RESUME_POLICY: Readonly<Record<string, ResumePolicy>> = Object.freeze({
    travelTo: 'auto',
    goToCoordinates: 'auto',
    goToPlayer: 'auto',
    moveAway: 'auto',
    exploreFor: 'auto',
    goToSurface: 'auto',
    seekShelter: 'auto',
    sleepUnderground: 'auto',
    searchForBlock: 'auto',
    searchForEntity: 'auto',
    // 按进度折算参数：距离型动作按"原始终点"续做（位置从身体读，见 ActionRunner）。
    collectBlocks: 'checkpoint',
    digDown: 'checkpoint',
    stairUp: 'checkpoint',
    pillarUp: 'checkpoint',
    mineTunnel: 'checkpoint',
});

/** 一条命令的续做策略；没列 = manual。 */
export function resumePolicyOf(toolName: string): ResumePolicy {
    return RESUME_POLICY[stripBang(toolName)] ?? 'manual';
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
    const resume = RESUME_POLICY[stripBang(command.name)];
    if (resume != null) declaration.resume = resume;
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
        ...throwingActionList.map((command) => declarationOf(command, 'action')),
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
