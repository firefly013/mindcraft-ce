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
            '**击杀也认真实证据**：只有"实体真的从世界里消失 / 血量归零"才算击杀；同一个实体 id 又出现就是**瞬移**（末影人被打就瞬移），' +
            '**不算击杀、当场把击杀数撤回**，回执会写明"它瞬移了"。同一只连续打不死会熔断，并给换打法建议（末影人：用船困住/用弓，别拼近战）。' +
            '第一个用法：huntFor(entity="blaze", want=7) 刷烈焰棒；huntFor(entity="enderman", want=12) 刷末影珍珠。' +
            '血量掉到 6 以下、脚下有岩浆/火、被 Stop/保命打断，都会立刻收手并说清原因；在下界刷烈焰人时若没有抗火 Buff，回执会明确提醒先 prepareBlaze。',
        params: {
            entity: '要刷的实体 id（英文），例如 blaze（烈焰人）、enderman（末影人）、cow/pig/chicken（食物）。也认中文俗称（烈焰人/末影人/牛/猪/鸡）。',
            want: '要几个掉落物（默认 4，1~64）。烈焰棒推荐 7（合成烈焰粉 + 酿造），末影珍珠推荐 12（12 颗眼填满传送门）。',
            radius: '搜索半径（默认 48，8~128）。找不到就先用 exploreFor 换个地方，而不是把半径拉大。',
            max_ms: '时间预算毫秒（默认 300000 = 5 分钟，10000~300000）。到点**自己收手并给完整回执**（拿到几个、打了几次、下一步调什么），可以再调一次接着刷。',
        },
    },
    mineTunnel: {
        description:
            '**沿一条直线挖隧道**（下界岩体里赶路用它，比 goToCoordinates 可控）：每一步「读格子 → 判危险 → 挖 → 验证真的变成空气 → 走进去」，' +
            '每 16 格报一次进度，挖了 32 格就停并给一条能照抄的续挖调用。' +
            '**安全门（都在挖之前判，触发就停手并点名格子）**：① 前方脚/头或前方脚下是岩浆/水 → 停（挖进岩浆口袋是死法之一）；' +
            '② 前方脚下是**空洞** → **先垫一块桥过去**（横向的 pillarUp：垫一块、验证真的变实心、再走过去；用背包里的垫脚方块，和 pillarUp 同一套材料偏好）；' +
            '**一次垫不上会自己换依附面、换材料再试**（最多几种），全试过才停手并写清"试了哪些"；' +
            '桥下就是岩浆时**不搭**；背包里没有能垫的方块才停，并给"先弄 1 个方块"的下一步（不再给 pillarUp——那也要方块，会死循环）；' +
            '③ 镐快用完（还剩 ≤20 次或 <15%）→ 停并给换镐提示；④ 没镐且方块徒手挖不动 → 停（**镐在背包里、只是没握在手上时会自己换上**，绝不误报"没有镐"）；' +
            '⑤ 掉血/血量 ≤6/被 Stop → 停，并说清挖了多少、现在在哪。**每一步都验证**：挖完还是原方块就停手报"挖不动"，绝不假装挖通了。' +
            '**进度按证据报**：标题的"净前进 N 格"必须来自**实测位移**（人真的站进新格子，3D 判定），挖掉的方块数单独报；' +
            '证据不一致会**当场写出矛盾**（例如"挖了方块但位移 0"——那种"已挖 64 格"的回执是假的）。' +
            '连着几步既没挖到东西、人也没挪动会**熔断**，下一步换成 stats(type="body")，不会把同一个空转调用丢回去；' +
            '中途工具被换手/镐断了也会点名（"中途工具变了"）。' +
            '用法：mineTunnel(length=32, direction="-x")；不给 direction 就按当前朝向推（回执会写明推定出来的 ±x/±z，下一次照抄即可）。',
        params: {
            length: '这次往前挖多少格（默认 32，1~256）。挖满就自己停并给"接着挖"的下一步；长距离就反复调用它。',
            height: '隧道高度（默认 2 = 能站着走，1~3）。2 格高才走得顺；1 格高会卡头。',
            direction: '方向：`+x`/`-x`/`+z`/`-z`（也认 east/west/north/south、东/南/西/北）。留空 = 按当前朝向推。回执里会写明实际用的方向，续挖照抄它。',
        },
    },
    travelTo: {
        description:
            '**一次调用往目的地推进一大截**（长距离赶路用它，别自己拆成八条隧道）：路线它自己挑——' +
            '有高差就先挖**斜上/斜下台阶**到目标高度（不用垫脚料；纯竖直才用 stairUp/digDown）；同层就挖直隧道；' +
            '斜向就**一次只走一条轴、长的先走**，走完自动换轴。' +
            '**你只需要给一次坐标**，剩下的腿和顺序不用你算（那正是会丢的东西）。' +
            '每推进 32 格报一次进度，到点/触门就停，并给「这一趟推进了 N 格、还剩 M 格（方向 ±x/±z）」+' +
            '**一条续跑调用**（坐标就是同一个目标，人会从停下那一点继续走，不会回头也不会跳格）。' +
            '**推进量只按实测位移算**（起点 → 现在），挖掉的方块数另算；两者不一致（挖了却位移 0）会当场写出矛盾，' +
            '位移 0 时下一步换成 stats(type="body")，不会重复同一条调用。' +
            '安全门和 mineTunnel **一模一样、一格都不放宽**：岩浆/水、镐快用完、掉血/血 ≤6、被 Stop、读不到方块 → 立刻停并点名那一格；' +
            '挖完必须验证明明变成空气才走进去；**前方脚下是空洞时它会自己垫一块桥过去**（横向的 pillarUp：验证变实心再走），' +
            '桥下是岩浆就不搭，背包里没有方块才停并给"先弄方块"的下一步。' +
            '**在下界做水平长途时它会默认爬到 y=116 修隧道**（真机实测 y=112~120 有 97% 实心下界岩、几乎没岩浆，而 y=68~80 只有 ~35% 实心=到处是洞），' +
            '也可以自己用 `layer` 指定层高。没有镐/目标在别的维度/坐标读不出来 → **不出发**，直接说清要先用什么；' +
            '**镐在背包里、只是没握在手上时会自己换上**（不会误报"没有镐"把你叫回去做一把已经有的工具）。' +
            '用法：travelTo(x=-332, z=88)（要塞/末地门这种几百格的路，一条调用一段，回执给下一次的调用）。',
        params: {
            x: '目的地 x 坐标（整数）。',
            y: '目的地 y 坐标（可选）。给了就按它爬/下到那一层；不给就用当前高度（下界长途则用推荐层）。',
            z: '目的地 z 坐标（整数）。',
            max_ms: '这一趟的时间预算（毫秒，默认 300000 = 5 分钟，10000~360000）。到点停手并给续跑调用——**不要**为了"一次走完"把它调很大。',
            layer: '走哪一层（可选）。下界长途推荐 116（y=112~120 实心、少岩浆）；给了就按它先爬到那一层再横向挖。',
            dimension: '目标所在维度（可选，只用于**拒绝**）：overworld / the_nether / the_end（也认 下界/主世界/末地）。和当前维度不一致就不出发，并告诉你先 enterNether() 之类。',
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
/** `mineTunnel` 的命令超时（分钟）。**必须 > `DEFAULT_TUNNEL_BUDGET_MS`**（它自己会先收手）。 */
export const TUNNEL_TIMEOUT_MIN = 6;
/**
 * `travelTo` 的命令超时（分钟）：内部预算最大 6 分钟 → 命令 7 分钟 → 脑侧保险丝 8.5 分钟。
 * 和 getFood 同一条链：**内部必须最短**，否则超时回执会把"这一趟推进了多少"吃掉。
 */
export const TRAVEL_TIMEOUT_MIN = 7;

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
    {
        name: '!mineTunnel',
        description: DESCRIPTION('mineTunnel'),
        params: {
            length: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.mineTunnel.params.length,
                optional: true,
                default: progression.DEFAULT_TUNNEL_LENGTH,
                domain: [1, progression.MAX_TUNNEL_LENGTH],
            },
            height: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.mineTunnel.params.height,
                optional: true,
                default: progression.DEFAULT_TUNNEL_HEIGHT,
                domain: [1, progression.MAX_TUNNEL_HEIGHT],
            },
            direction: {
                type: 'string',
                description: PROGRESSION_TOOL_TEXT.mineTunnel.params.direction,
                optional: true,
            },
        },
        perform: runProgressionAction(
            'mineTunnel',
            TUNNEL_TIMEOUT_MIN,
            (agent, rawLength?: unknown, rawHeight?: unknown, rawDirection?: unknown) =>
                progression.mineTunnelSkill(agent.bot, rawLength, rawHeight, rawDirection),
        ),
    },
    {
        name: '!travelTo',
        description: DESCRIPTION('travelTo'),
        params: {
            x: {
                type: 'float',
                description: PROGRESSION_TOOL_TEXT.travelTo.params.x,
            },
            y: {
                type: 'float',
                description: PROGRESSION_TOOL_TEXT.travelTo.params.y,
                optional: true,
            },
            z: {
                type: 'float',
                description: PROGRESSION_TOOL_TEXT.travelTo.params.z,
            },
            max_ms: {
                type: 'float',
                description: PROGRESSION_TOOL_TEXT.travelTo.params.max_ms,
                optional: true,
                default: progression.DEFAULT_TRAVEL_MAX_MS,
                domain: [10_000, progression.TRAVEL_MAX_MS_LIMIT],
            },
            layer: {
                type: 'int',
                description: PROGRESSION_TOOL_TEXT.travelTo.params.layer,
                optional: true,
                domain: [-60, 320],
            },
            dimension: {
                type: 'string',
                description: PROGRESSION_TOOL_TEXT.travelTo.params.dimension,
                optional: true,
            },
        },
        perform: runProgressionAction(
            'travelTo',
            TRAVEL_TIMEOUT_MIN,
            (
                agent,
                rawX?: unknown,
                rawY?: unknown,
                rawZ?: unknown,
                rawMaxMs?: unknown,
                rawLayer?: unknown,
                rawDimension?: unknown,
            ) => progression.travelToSkill(agent.bot, rawX, rawY, rawZ, rawMaxMs, rawLayer, rawDimension),
        ),
    },
];
