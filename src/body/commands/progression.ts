/*
 * 中段推进命令：动作 `!exploreFor`（系统性探索找结构）与 `!huntFor`（刷怪掉落）。
 *
 * **本文件是自包含的**（和 `commands/survival.ts`、`commands/endgame.ts` 同一套路）：
 * 描述文本住在下面 `PROGRESSION_TOOL_TEXT`，动作包装住在 `runProgressionAction`。
 * 唯一需要动的共享文件是 `registry.ts` 的两处接线 —— 而且那两处本来就是"新命令
 * 该住的地方"。
 *
 * 为什么要这两个工具（不是"再加一个 searchForBlock"）：
 *   - `searchForBlock` 是**一次性**扫描，且回执不说明"只扫了已加载区块"，模型把
 *     "256 格搜不到"读成"附近真没有"（Feedback 里它自己就怀疑了这一点）；
 *   - 找要塞/堡垒要的是**系统性**推进：走一段、重扫、再走一段，并且回执必须诚实
 *     说明覆盖范围、走了多远、下一腿往哪；
 *   - 刷烈焰棒/珍珠要的是"**刷够 N 个**"，按背包真实增量收口，而不是让模型自己
 *     一只一只打、自己数背包。
 */
import * as skills from '../library/skills.js';
import * as progression from '../library/progression.js';
import type { AgentCommand, CommandPerform } from './actions.js';

/** 工具描述与参数描述。键为去 `!` 的工具名，形状与 `TOOL_TEXT` 一致。 */
export const PROGRESSION_TOOL_TEXT: Record<string, { description: string; params: Record<string, string> }> = {
    exploreFor: {
        description:
            '系统性探索：按方形螺旋一腿一腿走（默认每腿 32 格），**每腿落地后重扫一次目标方块**，找到就停并报坐标。' +
            '专治"searchForBlock 一次性扫描搜不到"——它只扫已加载区块，扫不到不等于没有，得走起来才有新区块。' +
            '回执会写清：每腿扫多大半径、实际走了多少格、走了几腿、最后在哪，以及明确的 `found <方块> at (x,y,z)` 或 `not found after N steps`。' +
            '**找下界要塞就用它**：exploreFor(block="nether_bricks", max_steps=12, step=32)。' +
            '它只负责"找到并报坐标"，不会替你走过去；停下后用 goToCoordinates 过去。危险（岩浆/火）会立刻停手并如实报告。',
        params: {
            block: '要找的方块 id（英文），例如 nether_bricks（下界要塞）、obsidian、end_portal_frame。也认中文俗称（下界砖/黑曜石）。',
            max_steps: '最多走几腿（默认 12，1~64）。一腿 = 螺旋上的一段；12 腿约覆盖出发点外 192 格。',
            step: '每腿走多少格（默认 32，4~128）。地形破碎就调小（16），平原/灵魂沙峡谷可以调大（48）。',
        },
    },
    huntFor: {
        description:
            '刷怪刷到够数：循环「找最近的这类怪 → 走过去打 → **自己走过去把掉落物踩掉** → 用背包真实增量核对」，' +
            '够了（want）或时间到（max_ms）就停，并逐次报进度（第几次攻击、这次有没有涨、现在几个）。' +
            '**只认真实增量**：掉落物没进背包就不算数（自动拾取在模型动作期间是停的，所以本工具会自己走过去捡）。' +
            '第一个用法：huntFor(entity="blaze", want=7) 刷烈焰棒；huntFor(entity="enderman", want=12) 刷末影珍珠。' +
            '血量掉到 6 以下、脚下有岩浆/火、被 Stop/保命打断，都会立刻收手并说清原因；在下界刷烈焰人时若没有抗火 Buff，回执会明确提醒先 prepareBlaze。',
        params: {
            entity: '要刷的实体 id（英文），例如 blaze（烈焰人）、enderman（末影人）、cow/pig/chicken（食物）。也认中文俗称（烈焰人/末影人/牛/猪/鸡）。',
            want: '要几个掉落物（默认 4，1~64）。烈焰棒推荐 7（合成烈焰粉 + 酿造），末影珍珠推荐 12（12 颗眼填满传送门）。',
            radius: '搜索半径（默认 48，8~128）。找不到就先用 exploreFor 换个地方，而不是把半径拉大。',
            max_ms: '时间预算毫秒（默认 300000 = 5 分钟，10000~420000）。到点就带着已有进度收手，可以再调一次接着刷。',
        },
    },
};

const DESCRIPTION = (name: keyof typeof PROGRESSION_TOOL_TEXT): string => PROGRESSION_TOOL_TEXT[name].description;

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

export interface ExploreArgs {
    block: string;
    maxSteps: number;
    step: number;
    error?: string;
}

/** 归一 `exploreFor` 的参数。纯函数，便于单测（照 `survival.parseFluidArgs` 的写法）。 */
export function parseExploreArgs(rawBlock: unknown, rawMaxSteps?: unknown, rawStep?: unknown): ExploreArgs {
    const block = progression.resolveBlockName(rawBlock);
    if (block === '') {
        return { block: '', maxSteps: progression.DEFAULT_EXPLORE_MAX_STEPS, step: progression.DEFAULT_EXPLORE_STEP, error: 'block 必填：要给英文方块 id，例如 nether_bricks。' };
    }
    return {
        block,
        maxSteps: clampInt(rawMaxSteps, progression.DEFAULT_EXPLORE_MAX_STEPS, 1, 64),
        step: clampInt(rawStep, progression.DEFAULT_EXPLORE_STEP, 4, 128),
    };
}

export interface HuntArgs {
    entity: string;
    want: number;
    radius: number;
    maxMs: number;
    error?: string;
}

/** 归一 `huntFor` 的参数。`max_ms` 上限压在 7 分钟，避免撞上动作通道的 8 分钟超时。 */
export function parseHuntArgs(rawEntity: unknown, rawWant?: unknown, rawRadius?: unknown, rawMaxMs?: unknown): HuntArgs {
    const entity = progression.resolveEntityName(rawEntity);
    if (entity === '') {
        return {
            entity: '',
            want: progression.DEFAULT_HUNT_WANT,
            radius: progression.DEFAULT_HUNT_RADIUS,
            maxMs: progression.DEFAULT_HUNT_MAX_MS,
            error: 'entity 必填：要给英文实体 id，例如 blaze / enderman。',
        };
    }
    return {
        entity,
        want: clampInt(rawWant, progression.DEFAULT_HUNT_WANT, 1, 64),
        radius: clampInt(rawRadius, progression.DEFAULT_HUNT_RADIUS, 8, 128),
        maxMs: clampInt(rawMaxMs, progression.DEFAULT_HUNT_MAX_MS, 10_000, 7 * 60 * 1000),
    };
}

/**
 * 动作包装：走身体通道 + 超时兜底，并把实现返回的回执写进 `bot.output`
 * （模型的工具回执就是从那里来，见 ActionManager 的 getBotOutputSummary）。
 *
 * 显式传 label，所以命令不必住进 `actionsList`——这条和 `survival.ts` / `endgame.ts` 一致。
 */
function runProgressionAction(
    label: string,
    timeoutMinutes: number,
    actionFn: (agent: any, ...args: any[]) => Promise<string>,
): CommandPerform {
    const wrapped = async function (agent: any, ...args: any[]): Promise<string | null | undefined> {
        const result = await agent.actions.runAction(
            `action:${label}`,
            async () => {
                skills.log(agent.bot, await actionFn(agent, ...args));
            },
            { timeout: timeoutMinutes },
        );
        if (result.interrupted && !result.timedout) return;
        if (result.timedout) {
            const why = typeof skills.describeStuck === 'function' ? skills.describeStuck(agent.bot) : '';
            return (
                `${label}：**超时**（${timeoutMinutes} 分钟没做完），已释放身体通道。` +
                `超时 ≠ 没做成：先看回执里已经走到哪一步，再用 stats/exploreFor 接着来。${why === '' ? '' : `\n卡住时：${why}`}`
            );
        }
        return result.message;
    };
    (wrapped as CommandPerform).longRunning = true;
    return wrapped as CommandPerform;
}

/** 占用身体通道的动作：探索要几分钟（走 12 腿），刷怪按预算最多 5 分钟。 */
export const progressionActionList: AgentCommand[] = [
    {
        name: '!exploreFor',
        description: DESCRIPTION('exploreFor'),
        params: {
            block: { type: 'BlockName', description: PROGRESSION_TOOL_TEXT.exploreFor.params.block },
            max_steps: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.exploreFor.params.max_steps,
                optional: true,
                default: progression.DEFAULT_EXPLORE_MAX_STEPS,
                domain: [1, 64],
            },
            step: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.exploreFor.params.step,
                optional: true,
                default: progression.DEFAULT_EXPLORE_STEP,
                domain: [4, 128],
            },
        },
        perform: runProgressionAction('exploreFor', 8, (agent, rawBlock?: unknown, rawMaxSteps?: unknown, rawStep?: unknown) => {
            const args = parseExploreArgs(rawBlock, rawMaxSteps, rawStep);
            if (args.error != null) return Promise.resolve(`exploreFor 参数不对：${args.error}`);
            return progression.exploreForSkill(agent.bot, args.block, args.maxSteps, args.step);
        }),
    },
    {
        name: '!huntFor',
        description: DESCRIPTION('huntFor'),
        params: {
            entity: { type: 'string', description: PROGRESSION_TOOL_TEXT.huntFor.params.entity },
            want: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.huntFor.params.want,
                optional: true,
                default: progression.DEFAULT_HUNT_WANT,
                domain: [1, 64],
            },
            radius: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.huntFor.params.radius,
                optional: true,
                default: progression.DEFAULT_HUNT_RADIUS,
                domain: [8, 128],
            },
            max_ms: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.huntFor.params.max_ms,
                optional: true,
                default: progression.DEFAULT_HUNT_MAX_MS,
                domain: [10_000, 7 * 60 * 1000],
            },
        },
        perform: runProgressionAction(
            'huntFor',
            8,
            (agent, rawEntity?: unknown, rawWant?: unknown, rawRadius?: unknown, rawMaxMs?: unknown) => {
                const args = parseHuntArgs(rawEntity, rawWant, rawRadius, rawMaxMs);
                if (args.error != null) return Promise.resolve(`huntFor 参数不对：${args.error}`);
                return progression.huntForSkill(agent.bot, args.entity, args.want, args.radius, args.maxMs);
            },
        ),
    },
];
