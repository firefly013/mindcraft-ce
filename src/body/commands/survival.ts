/*
 * 生存安全命令：查询 `!survivalCheck` + 动作 `!seekShelter` / `!sleepUnderground` / `!prepareBlaze`。
 *
 * **本文件是自包含的**：描述文本走下面 `SURVIVAL_TOOL_TEXT`，动作包装走本文件里的
 * `runSurvivalAction`，不依赖对 `actions.ts` / `registry.ts` / `prompts.ts` 的改动。
 * （项目原有的 `td()/tp()` 从 prompts.ts 读描述；为了不动共享入口，这里先自带一份，
 *  lead 接入时可原样合并进 `TOOL_TEXT`。）
 *
 * 接入方式（两行，见交付报告）：
 *   Q = queryList.concat(survivalQueryList)
 *   A = actionsList.concat(survivalActionList)
 * 并让 `toolDeclarations()` 按同样顺序把两个列表分别映成 query / action。
 */
import * as skills from '../library/skills.js';
import * as survival from '../library/survival.js';
import type { AgentCommand, CommandPerform } from './actions.js';

/** 工具描述与参数描述。键为去 `!` 的工具名，形状与 `TOOL_TEXT` 一致。 */
export const SURVIVAL_TOOL_TEXT: Record<string, { description: string; params: Record<string, string> }> = {
    survivalCheck: {
        description:
            '生存状态检查：一次给全「天黑还有多久 / 头顶有没有顶、算不算地下掩体 / 周围有没有敌对生物 / 有没有床和食物 / 抗火 Buff 还剩多久」，并直接给出建议。' +
            '**进夜晚、下矿、打烈焰人之前先调它**，不要靠心算时间或翻背包。只读，不占身体通道。',
        params: {},
    },
    seekShelter: {
        description:
            '找或挖一个地下庇护所。顺序：已经在有顶掩体里 → 附近找现成的有顶空间 → 往下挖 → 朝旁边掏一个 2 格高的窝。' +
            '碰到水/岩浆/落差会停下并如实说明。**天黑前调它**把落脚点安顿好；挖好后把床和重要物资带下去。',
        params: {},
    },
    sleepUnderground: {
        description:
            '夜晚在地下求稳：先确保有地下庇护；有床就睡到天亮，没床就在地下等到天亮，**不要在地表跟怪物打**。' +
            '白天调它会告诉你不用睡。会占着身体通道，可能持续整夜。',
        params: {},
    },
    escapeWater: {
        description:
            '水中脱困：脚泡在水里、placeBlock 没有相邻支撑、placeHere 报 NoPath、digDown 又被水挡住时用它。' +
            '先找 48 格内最近的干燥可站立点（脚/头是空气、脚下实心）并尝试寻路过去；寻路失败就朝那个方向手动游/跳（forward + jump）；' +
            '没有干岸时朝最近实心方块游/跳，水底有实心会尝试垫台阶，最后向上挖/上浮。' +
            '全部失败会明确报「浅水坑困死」，附坐标、水位变化和下一步建议。',
        params: {},
    },
    findFluidSource: {
        description:
            '只读：在半径内找最近的**流体源方块**（水/岩浆的 level 0，能装进桶），报种类/坐标/距离。' +
            '**流动水/岩浆不算源**：范围内只有流动的时会明确回报「没有源头，只有流动水」并指出最近流动水在哪，让模型去更远找源头。' +
            '不走路、不占身体通道；要装桶用 fillBucketFromSource。',
        params: {
            type: '流体种类：water / lava / any（默认 water）。',
            radius: '搜索半径（格，默认 32，1~128）。',
        },
    },
    fillBucketFromSource: {
        description:
            '走到半径内最近的**源**方块旁边，用空桶装满 water_bucket / lava_bucket，并核对手上是否真的出现桶。' +
            '**只认源方块（level 0）**：只有流动水/岩浆时会明确回报「没有源头，只有流动水」并让你去更远找，不会白装。' +
            '失败会区分：没空桶 / 没找到源 / 只有流动 / 够不到 / 准星没对准。',
        params: {
            type: '流体种类：water / lava（默认 water）。',
            radius: '搜索半径（格，默认 32，1~128）。',
        },
    },
    prepareBlaze: {
        description:
            '打烈焰人前的准备与续 Buff：检查并喝下抗火药水、吃饱，回报「够不够、还缺什么」。' +
            '**Buff 快没了（剩不到 45 秒）就再调一次保持不断**；没有药水会告诉你需要「烈焰粉 + 岩浆膏 + 酿造台」自制。',
        params: {},
    },
};

export { SURVIVAL_POLICY } from '../../shared/survival_policy.js';

const DESCRIPTION = (name: keyof typeof SURVIVAL_TOOL_TEXT): string => SURVIVAL_TOOL_TEXT[name].description;

/** 归一 `findFluidSource` / `fillBucketFromSource` 的 type + radius。 */
export function parseFluidArgs(
    rawType: unknown,
    rawRadius: unknown,
): { kind: survival.FluidKind | 'any'; radius: number; error?: string } {
    const raw = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
    const kind = raw === '' ? 'water' : raw;
    if (kind !== 'water' && kind !== 'lava' && kind !== 'any') {
        return { kind: 'water', radius: 32, error: `type 只认 water / lava / any（收到 "${String(rawType)}"）。` };
    }
    const n = typeof rawRadius === 'number' ? rawRadius : Number(rawRadius);
    const radius = Number.isFinite(n) ? Math.max(1, Math.min(128, Math.round(n))) : 32;
    return { kind, radius };
}

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
            const why = typeof skills.describeStuck === 'function' ? skills.describeStuck(agent.bot) : '';
            return (
                `${label}：**超时**（${timeoutMinutes} 分钟没做完），已释放身体通道。` +
                `超时 ≠ 没做成，先核对状态再决定要不要重试。${why === '' ? '' : `\n卡住时：${why}`}`
            );
        }
        return result.message;
    };
    (wrapped as CommandPerform).longRunning = true;
    return wrapped as CommandPerform;
}

/** 只读查询：生存检查（不占身体通道）。 */
export const survivalQueryList: AgentCommand[] = [
    {
        name: '!findFluidSource',
        description: DESCRIPTION('findFluidSource'),
        params: {
            type: { type: 'string', description: SURVIVAL_TOOL_TEXT.findFluidSource.params.type, optional: true, default: 'water' },
            radius: { type: 'int', description: SURVIVAL_TOOL_TEXT.findFluidSource.params.radius, optional: true, default: 32, domain: [1, 128] },
        },
        perform: function (agent: any, type?: unknown, radius?: unknown): string {
            const args = parseFluidArgs(type, radius);
            if (args.error != null) return `findFluidSource 参数不对：${args.error}`;
            return survival.fluidSourceReport(agent.bot, args.kind, args.radius);
        },
    },
    {
        name: '!survivalCheck',
        description: DESCRIPTION('survivalCheck'),
        params: {},
        perform: function (agent: any): string {
            return survival.survivalCheckReport(agent.bot);
        },
    },
];

/** 占用身体通道的动作。 */
export const survivalActionList: AgentCommand[] = [
    {
        name: '!seekShelter',
        description: DESCRIPTION('seekShelter'),
        params: {},
        perform: runSurvivalAction('seekShelter', 4, (agent) => survival.seekShelterSkill(agent.bot)),
    },
    {
        name: '!sleepUnderground',
        description: DESCRIPTION('sleepUnderground'),
        params: {},
        // 整夜等待/睡觉可能超过默认 2 分钟，给 12 分钟。
        perform: runSurvivalAction('sleepUnderground', 12, (agent) => survival.sleepUndergroundSkill(agent.bot)),
    },
    {
        name: '!prepareBlaze',
        description: DESCRIPTION('prepareBlaze'),
        params: {},
        perform: runSurvivalAction('prepareBlaze', 2, (agent) => survival.prepareBlazeSkill(agent.bot)),
    },
    {
        name: '!escapeWater',
        description: DESCRIPTION('escapeWater'),
        params: {},
        perform: runSurvivalAction('escapeWater', 2, (agent) => survival.escapeWaterSkill(agent.bot)),
    },
    {
        name: '!fillBucketFromSource',
        description: DESCRIPTION('fillBucketFromSource'),
        params: {
            type: { type: 'string', description: SURVIVAL_TOOL_TEXT.fillBucketFromSource.params.type, optional: true, default: 'water' },
            radius: { type: 'int', description: SURVIVAL_TOOL_TEXT.fillBucketFromSource.params.radius, optional: true, default: 32, domain: [1, 128] },
        },
        perform: runSurvivalAction('fillBucketFromSource', 3, (agent, type?: unknown, radius?: unknown) => {
            const args = parseFluidArgs(type, radius);
            if (args.error != null) {
                skills.log(agent.bot, args.error);
                return Promise.resolve(args.error);
            }
            return survival.fillBucketFromSourceSkill(agent.bot, args.kind, args.radius);
        }),
    },
];
