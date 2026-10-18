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
            '系统性探索：按方形螺旋一条腿一条腿走（默认每腿 32 格），**每个落点都重扫一次目标方块**，找到就停并报坐标。' +
            '专治"searchForBlock 一次性扫描搜不到"——它只扫已加载区块，扫不到不等于没有，得走起来才有新区块。' +
            '回执会写清：每步扫多大半径、实际走了多少格、走了几步、最后在哪，以及明确的 `found <方块> at (x,y,z)` 或 `not found after N steps`。' +
            '**长腿会自动切段**（每步 ≤ 0.75×扫描半径 ≈ 48 格），相邻两次扫描的球因此是重叠的——**走过的路径上任意一点都被扫过**，不会出现"从要塞旁边走过去却没看见"。' +
            '（`max_steps` 是原始螺旋腿数，回执里的"步"是切段后实际走的步数，两者不同。）' +
            '**找下界要塞就用它**：exploreFor(block="nether_bricks", max_steps=12, step=32)。' +
            '它只负责"找到并报坐标"，不会替你走过去；停下后用 goToCoordinates 过去。危险（岩浆/火）会立刻停手并如实报告。' +
            '**它自己在约 4.5 分钟就收手**（时间预算是内部的，不是你给的参数）：到点照常给完整结论——走了几步、扫了多大范围、从哪到哪、有没有找到、下一步调什么；' +
            '所以"跑了一半没结论"不会再发生。看到 `时间到…主动收手` 就照最后那行再调一次接着跑。',
        params: {
            block: '要找的方块 id（英文），例如 nether_bricks（下界要塞）、obsidian、end_portal_frame。也认中文俗称（下界砖/黑曜石）。',
            max_steps: '最多走几条螺旋腿（默认 12，1~64）。12 腿实际走到出发点外单轴 96 格、最远对角约 136 格（扫描半径再向外 64 格）；长腿会切段以便每步都扫描，预算不够会提前收手。',
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
            max_ms: '时间预算毫秒（默认 300000 = 5 分钟，10000~300000）。到点**自己收手并给完整回执**（拿到几个、打了几次、下一步调什么），可以再调一次接着刷。',
        },
    },
};

const DESCRIPTION = (name: keyof typeof PROGRESSION_TOOL_TEXT): string => PROGRESSION_TOOL_TEXT[name].description;

// ───────────────────── 超时与预算：两者必须一起看 ─────────────────────
//
// 这条不变式是真机换来的（2026-10-18 13:13）：`exploreFor#3` 跑过 6.5 分钟被脑侧
// 保险丝强退，模型只拿到"已强制释放动作通道"——没有腿数、没有覆盖范围、没有坐标、
// 没有下一步，于是它开始反复拍快照空转。**凡是"可能跑很久"的工具，都必须由它自己
// 先收手并交出结论**，不能指望超时/保险丝替它总结。
//
// 所以链条是：内部预算 < 命令超时 < 脑侧保险丝（8.5 分钟，见 action_runner.ts）。
// 三条都在 tests/progression.test.ts 里钉住——删掉预算或把超时调大，测试就会红。

/** `exploreFor` 的命令超时（分钟）。**必须 > `DEFAULT_EXPLORE_BUDGET_MS`**，否则超时回执会把结论吃掉。 */
export const EXPLORE_TIMEOUT_MIN = 6;
/** `huntFor` 的命令超时（分钟）。**必须 > `HUNT_MAX_MS_LIMIT` + 最后一次攻击/捡拾的余量**。 */
export const HUNT_TIMEOUT_MIN = 8;
/** `huntFor` 的时间预算上限（毫秒）：压到 5 分钟，保证"预算 + 最后一击"仍在超时之内。 */
export const HUNT_MAX_MS_LIMIT = 5 * 60 * 1000;

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

/** 归一 `huntFor` 的参数。`max_ms` 上限压在 `HUNT_MAX_MS_LIMIT`（5 分钟），
 *  保证"时间预算 + 最后一次攻击/捡拾"仍在命令超时之内。 */
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
        maxMs: clampInt(rawMaxMs, progression.DEFAULT_HUNT_MAX_MS, 10_000, HUNT_MAX_MS_LIMIT),
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
            const next = label === 'exploreFor' ? 'stats(type="body")' : 'stats(type="inventory")';
            return (
                `${label}：**超时**（${timeoutMinutes} 分钟没做完），已释放身体通道。` +
                `注意：${label} 自己有更短的时间预算，正常会先收手并给出完整回执——走到这里说明某一腿/某一次攻击卡住了。` +
                `下一步（照做即可）：${next}。${why === '' ? '' : `\n卡住时：${why}`}`
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
        perform: runProgressionAction('exploreFor', EXPLORE_TIMEOUT_MIN, (agent, rawBlock?: unknown, rawMaxSteps?: unknown, rawStep?: unknown) => {
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
                domain: [10_000, HUNT_MAX_MS_LIMIT],
            },
        },
        perform: runProgressionAction(
            'huntFor',
            HUNT_TIMEOUT_MIN,
            (agent, rawEntity?: unknown, rawWant?: unknown, rawRadius?: unknown, rawMaxMs?: unknown) => {
                const args = parseHuntArgs(rawEntity, rawWant, rawRadius, rawMaxMs);
                if (args.error != null) return Promise.resolve(`huntFor 参数不对：${args.error}`);
                return progression.huntForSkill(agent.bot, args.entity, args.want, args.radius, args.maxMs);
            },
        ),
    },
];
