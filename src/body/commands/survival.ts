/*
 * 生存命令：只保留 `!escapeWater`。
 *
 * 其余生存类工具（findFluidSource / survivalCheck / seekShelter /
 * sleepUnderground / prepareBlaze / fish / getFood / fillBucketFromSource）
 * 已按用户要求删除。本文件仍是自包含的：描述文本在下面，动作包装在
 * `runSurvivalAction`，不依赖 actions.ts / registry.ts / prompts.ts 的改动。
 */
import * as survival from '../library/survival.js';
import type { AgentCommand, CommandPerform } from './actions.js';

/** 工具描述与参数描述。键为去 `!` 的工具名，形状与 `TOOL_TEXT` 一致。 */
export const SURVIVAL_TOOL_TEXT: Record<string, { description: string; params: Record<string, string> }> = {
    escapeWater: {
        description:
            '水中脱困：脚泡在水里、placeBlock 没有相邻支撑、placeHere 报 NoPath、digDown 又被水挡住时用它。' +
            '先找 48 格内最近的干燥可站立点（脚/头是空气、脚下实心）并尝试寻路过去；寻路失败就朝那个方向手动游/跳（forward + jump）；' +
            '没有干岸时朝最近实心方块游/跳，水底有实心会尝试垫台阶，最后向上挖/上浮。' +
            '全部失败会明确报「浅水坑困死」，附坐标、水位变化和下一步建议。',
        params: {},
    },
};

const DESCRIPTION = (name: keyof typeof SURVIVAL_TOOL_TEXT): string => SURVIVAL_TOOL_TEXT[name].description;

/**
 * 动作包装：走身体通道 + 超时兜底。和 `actions.ts` 的 `runAsAction` 同款语义，
 * 但**显式传 label**，不需要命令住在 `actionsList` 里（避免为接入去改共享文件）。
 */
function runSurvivalAction(
    label: string,
    timeoutMinutes: number,
    actionFn: (agent: any, ...args: any[]) => Promise<unknown>,
): CommandPerform {
    const wrapped = async function (agent: any, ...args: any[]): Promise<string | null | undefined> {
        const result = await agent.actions.runAction(
            `action:${label}`,
            async () => {
                await actionFn(agent, ...args);
            },
            { timeout: timeoutMinutes },
        );
        if (result.interrupted && !result.timedout) return;
        if (result.timedout) {
            return `这次动作超时了，${timeoutMinutes} 分钟没有跑完。`;
        }
        return result.message;
    };
    (wrapped as CommandPerform).longRunning = true;
    return wrapped as CommandPerform;
}

/** 生存查询：用户要求删除全部 8 个非 escapeWater 工具后，这里没有查询工具。 */
export const survivalQueryList: AgentCommand[] = [];

/** 占用身体通道的生存动作：只剩 escapeWater。 */
export const survivalActionList: AgentCommand[] = [
    {
        name: '!escapeWater',
        description: DESCRIPTION('escapeWater'),
        params: {},
        perform: runSurvivalAction('escapeWater', 2, (agent) => survival.escapeWaterSkill(agent.bot)),
    },
];
