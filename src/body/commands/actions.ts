import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import { enterNether } from '../library/nether_portal.js';
import { markDiscarded } from '../auto_pickup.js';
import { permits } from '../safety/permits.js';
import { safeguards } from '../safety/safeguards.js';
import { DANGEROUS_OPS, isAuthorizable } from '../safety/dangerous_ops.js';
import { td, tp, MESSAGES } from '../../shared/prompts.js';
import type { ToolParamDef } from '../../shared/tools.js';
import { interactList } from './interact.js';

// 命令参数定义（domain / optional / default 等原样透传）。
// 形状住在 `shared/tools.ts`：它就是握手时报给大脑的那份声明的一部分。
/** 给工具回执加个空行，读起来不挤在一起（和 queries.ts 同款）。 */
const pad = (str: string): string => '\n' + str + '\n';

export type CommandParamDef = ToolParamDef;

// 单个命令对象：perform 首参 agent 统一 any（避免循环依赖），其余位置参数逐个定类型
export interface AgentCommand {
    name: string;
    description: string;
    params?: Record<string, CommandParamDef>;
    perform: CommandPerform;
    /**
     * 这条命令的回执要**附一张现拍的截图**。默认不给。
     *
     * 只有真正需要"看画面"的命令才开（目前只有 `!stats`）：图片是按 token 计费
     * 的重货，白送一张进上下文，等于每调用一次就烧一笔钱。所以默认纯文本，
     * 让模型**按需**要图 —— 这也正好是 `!stats` 的语义（"我现在要看一眼"）。
     */
    withScreenshot?: boolean;
}

export type AgentActionFn = (agent: any, ...args: any[]) => Promise<unknown>;

/**
 * 命令的执行体。用带调用签名的接口而不是裸函数类型，是为了能挂 `longRunning`
 * 这个**运行时**标记 —— 它比手工维护一份"哪些命令耗时长"的清单可靠：
 * 清单会漏、会过期，而这个标记是 `runAsAction` 自己打上去的，走身体通道就一定有。
 */
export interface CommandPerform {
    (agent: any, ...args: any[]): unknown;
    /**
     * 走身体通道（`actions.runAction`）= **长时间命令**（能跑几分钟）。
     * 由 `runAsAction` 自动打上，别手工设。CLI 据此强制异步。
     */
    longRunning?: boolean;
}


/**
 * 占身体通道的动作**必须有个上限**。
 *
 * 以前默认是 `-1`（没有上限）——于是 `placeHere` / `placeBlock` / `useOn` 这类动作
 * 可以一直挂着：模型在 68 / 88 / 99 / 147 秒时只收到一条 `task.stuck` **事件**，
 * 而工具回执永远不来，它既不知道做没做成、也不知道卡在哪，只能自己 Stop。
 * 同一类现象模型至少报了 5 次（mineBlock 147s、useOn 73s/93s、digDown 88s、
 * collectBlocks 68s、placeHere 99s）。
 *
 * 所以给一个统一上限：动作**要么完成、要么在 2 分钟内带着原因回来**。
 * 真需要更久的（`collectBlocks` 挖一堆矿）由调用方显式放宽，
 * 并且放宽时也要有尽头，不许再写 -1。
 */
export const DEFAULT_ACTION_TIMEOUT_MIN = 2;

function runAsAction (actionFn: AgentActionFn, timeout = DEFAULT_ACTION_TIMEOUT_MIN): CommandPerform {
    let actionLabel: string | null = null;  // Will be set on first use

    const wrappedAction = async function (agent: any, ...args: any[]): Promise<string | null | undefined> {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = (actionObj?.name as string).substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async (): Promise<void> => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout });
        if (code_return.interrupted && !code_return.timedout)
            return;
        // **超时时必须把"卡在哪"说出来。** 光回一句"超时"等于没说：模型不知道
        // 是脚边被水占了、卡在方块里、还是目标根本够不着，只能瞎重试
        // （它自述"装桶重试 6 次""同一件事重发/换招"就是这个原因）。
        // 而身体的日志里往往已经有线索（skills 会 log 失败原因），一并带回。
        if (code_return.timedout) {
            const why = skills.describeStuck?.(agent.bot) ?? '';
            const logs = String(agent.bot?.output ?? '').trim();
            const seen = logs === '' ? '' : `\n已经做了的：${logs.split('\n').slice(0, 6).join(' / ')}`;
            return (
                `${actionLabel}：**超时**（${timeout} 分钟没做完），已释放身体通道。` +
                `注意：**超时 ≠ 没做成**——有些动作已经生效，请先核对状态再决定要不要重试。` +
                `${why === '' ? '' : `\n卡住时：${why}`}${seen}`
            );
        }
        return code_return.message;
    };

    // **它跑在身体通道里**，超时默认见 `DEFAULT_ACTION_TIMEOUT_MIN`（寻路几分钟是
    // 常态，但"几分钟没有回执"对模型来说等于卡死，所以必须有尽头）。
    // 打上这个标记，外部 CLI 就不用猜哪些命令要异步：谁走身体通道谁就是长命令。
    (wrappedAction as CommandPerform).longRunning = true;
    return wrappedAction as CommandPerform;
}

export const actionsList: AgentCommand[] = [
    // 注：停下走循环 Stop 工具（不占通道，忙时也能调）；
    // 旧 !stop 命令已删，避免跟 Stop 重名混淆。
    // 旧 !stfu 也删了：它只是让 agent 不投递事件，模型本来就能不管噪音，
    // 而"静音时直接丢事件"反而会吞掉该看见的东西。
    {
        name: '!restart',
        description: td('restart'),
        // eslint-disable-next-line require-await -- command interface requires a promise result
        perform: async function (agent: any): Promise<void> {
            agent.cleanKill();
        }
    },
    {
        name: '!goToPlayer',
        description: td('goToPlayer'),
        params: {
            'player_name': {type: 'string', description: tp('goToPlayer', 'player_name')},
            'closeness': {type: 'float', description: tp('goToPlayer', 'closeness'), domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent: any, player_name: string, closeness: number) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: td('followPlayer'),
        params: {
            'player_name': {type: 'string', description: tp('followPlayer', 'player_name')},
            'follow_dist': {type: 'float', description: tp('followPlayer', 'follow_dist'), domain: [0, Infinity]}
        },
        // 无限跟随：它一直占着身体通道，直到模型调 Stop 或被事件打断。
        // 以前靠 ActionManager 的 resume 在每次 idle 时偷偷重放，等于
        // 留了一个绕过通道的隐藏决策者；现在由模型自己决定要不要再跟。
        perform: runAsAction(async (agent: any, player_name: string, follow_dist: number) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        })
    },
    {
        name: '!goToCoordinates',
        description: td('goToCoordinates'),
        params: {
            'x': {type: 'float', description: tp('goToCoordinates', 'x'), domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: tp('goToCoordinates', 'y'), domain: [-64, 320]},
            'z': {type: 'float', description: tp('goToCoordinates', 'z'), domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: tp('goToCoordinates', 'closeness'), domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent: any, x: number, y: number, z: number, closeness: number) => {
            const bot = agent.bot;
            const start = bot.entity.position;
            const dy = y - start.y;
            const horizontal = Math.hypot(x - start.x, z - start.z);
            // 高差大且几乎在正上方：寻路器会一直卡壁，先垂直上行再走最后一段。
            if (dy >= 4 && horizontal <= 8) {
                skills.log(bot, 'goToCoordinates：高差 ' + dy.toFixed(1) + ' 格、水平 ' + horizontal.toFixed(1) + ' 格，先用 pillarUp/stairUp 垂直上行。');
                const material = skills.choosePillarMaterial(bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }>);
                const climbed = material != null
                    ? await skills.pillarUp(bot, Math.ceil(dy))
                    : await skills.stairUp(bot, Math.ceil(dy));
                if (bot.interrupt_code) {
                    skills.log(bot, 'goToCoordinates：垂直上行被 Stop/保命打断，本次停止。');
                    return;
                }
                skills.log(bot, climbed
                    ? 'goToCoordinates：垂直上行完成，继续寻路到精确坐标。'
                    : 'goToCoordinates：垂直上行没能完成，继续尝试普通寻路（失败会给出卡住原因）。');
            }
            await skills.goToPosition(bot, x, y, z, closeness);
        }, 5)
    },
    {
        name: '!searchForBlock',
        description: td('searchForBlock'),
        params: {
            'type': { type: 'BlockName', description: tp('searchForBlock', 'type') },
            'search_range': { type: 'float', description: tp('searchForBlock', 'search_range'), domain: [10, 512] }
        },
        perform: runAsAction(async (agent: any, block_type: string, range: number) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: td('searchForEntity'),
        params: {
            'type': { type: 'string', description: tp('searchForEntity', 'type') },
            'search_range': { type: 'float', description: tp('searchForEntity', 'search_range'), domain: [32, 512] }
        },
        perform: runAsAction(async (agent: any, entity_type: string, range: number) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: td('moveAway'),
        params: {'distance': { type: 'float', description: tp('moveAway', 'distance'), domain: [0, Infinity] }},
        perform: runAsAction(async (agent: any, distance: number) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!consume',
        description: td('consume'),
        params: {'item_name': { type: 'ItemName', description: tp('consume', 'item_name') }},
        perform: runAsAction(async (agent: any, item_name: string) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: td('equip'),
        params: {'item_name': { type: 'ItemName', description: tp('equip', 'item_name') }},
        perform: runAsAction(async (agent: any, item_name: string) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!discard',
        description: td('discard'),
        params: {
            'item_name': { type: 'ItemName', description: tp('discard', 'item_name') },
            'num': { type: 'int', description: tp('discard', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent: any, item_name: string, num: number) => {
            // **原地丢，不寻路、不移动**：Feedback #36/#37——移交东西时先走 5 格
            // 会让落点和队友以为的位置对不上。想离开掉落物范围请另外显式 goToCoordinates。
            const bot = agent.bot;
            const drop = bot.entity.position.clone();
            const yaw = Number(bot?.entity?.yaw ?? 0);
            const dx = -Math.sin(yaw);
            const dz = Math.cos(yaw);
            const landing = { x: drop.x + dx * 1.5, z: drop.z + dz * 1.5 };
            const ok = await skills.discard(bot, item_name, num);
            if (ok) {
                markDiscarded(item_name);
                skills.log(
                    bot,
                    '原地扔掉 ' + num + ' 个 ' + item_name + '：起点 @(' +
                        drop.x.toFixed(2) + ',' + drop.y.toFixed(2) + ',' + drop.z.toFixed(2) +
                        ')，面朝方向前方约 1.5 格落点 @(' +
                        landing.x.toFixed(2) + ',' + drop.y.toFixed(2) + ',' + landing.z.toFixed(2) +
                        ')；本次没有移动，3 分钟内自动拾取不会捡它。',
                );
            }
        })
    },
    {
        name: '!collectBlocks',
        description: td('collectBlocks'),
        params: {
            'type': { type: 'BlockName', description: tp('collectBlocks', 'type') },
            'num': { type: 'int', description: tp('collectBlocks', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        // 采集可以慢（要跑好几处矿点），但 10 分钟太久——模型等到 68 秒就已经
        // 判定"卡死"了。收到 6 分钟，并且在超时时带原因回来（见 runAsAction）。
        perform: runAsAction(async (agent: any, type: string, num: number) => {
            // **成功也要有人话回执**：skills.collectBlock 成功时什么都不 log，
            // 而动作回执来自 bot.output——于是成功 = data:""（prober 实测：
            // 挖完砾石回执一个字都没有，它只能靠事件流反推去了哪、挖了几块）。
            // 前后背包对账 + 实际移动距离，让它不用猜。
            const before: number = world.getInventoryCounts(agent.bot)[type] ?? 0;
            const start = agent.bot.entity.position.clone();
            await skills.collectBlock(agent.bot, type, num);
            const after: number = world.getInventoryCounts(agent.bot)[type] ?? 0;
            const moved = Math.round(start.distanceTo(agent.bot.entity.position) * 10) / 10;
            skills.log(
                agent.bot,
                after > before
                    ? `采集完成：${type} 背包 ${before} → ${after}（+${after - before}），移动 ${moved} 格。`
                    : `采集结束：${type} 数量没变（仍是 ${after}）。移动 ${moved} 格——没挖到，可能目标太远或不可及。`,
            );
        }, 6)
    },
        {
        name: '!placeHere',
        description: td('placeHere'),
        params: {'type': { type: 'BlockOrItemName', description: tp('placeHere', 'type') }},
        perform: runAsAction(async (agent: any, type: string) => {
            const pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!placeBlock',
        description: td('placeBlock'),
        params: {
            'type': { type: 'BlockOrItemName', description: tp('placeBlock', 'type') },
            'x': { type: 'float', description: tp('placeBlock', 'x') },
            'y': { type: 'float', description: tp('placeBlock', 'y') },
            'z': { type: 'float', description: tp('placeBlock', 'z') }
        },
        perform: runAsAction(async (agent: any, type: string, x: number, y: number, z: number) => {
            // **往指定坐标放方块**。placeHere 只能放"脚下当前位置"，搭下界门那种
            // 4x5 门框根本摆不出来——模型真机报过这个硬缺口（凑够黑曜石也没用）。
            const ok = await skills.placeBlock(agent.bot, type, x, y, z);
            if (!ok) {
                skills.log(agent.bot, `没能把 ${type} 放到 (${x},${y},${z})：那一格可能不是空气，或者够不着。`);
            }
        })
    },
    {
        name: '!mineBlock',
        description: td('mineBlock'),
        params: {
            'x': { type: 'float', description: tp('mineBlock', 'x') },
            'y': { type: 'float', description: tp('mineBlock', 'y') },
            'z': { type: 'float', description: tp('mineBlock', 'z') }
        },
        perform: runAsAction(async (agent: any, x: number, y: number, z: number) => {
            // **挖指定的那一格**。collectBlocks 是自己找最近的、digDown 只会往下；
            // 模型真机报过硬缺口："我在 100 格深的洞里没有挖掉头顶方块的工具，
            // 所以搭不了落脚点"。和 placeBlock 对称的原语。
            await skills.mineBlockAt(agent.bot, x, y, z);
        })
    },
    {
        name: '!attack',
        description: td('attack'),
        // target 是什么意思由 type 决定，**type 必填**：靠字符串形状隐式猜
        // 等于把"玩家优先"这个人为约定藏起来，而模型既不知道它存在也无法覆盖。
        params: {
            'target': { type: 'string', description: tp('attack', 'target') },
            'type': { type: 'string', description: tp('attack', 'type') }
        },
        perform: runAsAction(async (agent: any, target: string, type: string) => {
            await skills.attackTarget(agent.bot, target, type, true);
        })
    },
    {
        name: '!stay',
        description: td('stay'),
        params: {'type': { type: 'int', description: tp('stay', 'type'), domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent: any, seconds: number) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!lookAtPosition',
        description: td('lookAtPosition'),
        params: {
            'x': { type: 'int', description: tp('lookAtPosition', 'x') },
            'y': { type: 'int', description: tp('lookAtPosition', 'y') },
            'z': { type: 'int', description: tp('lookAtPosition', 'z') }
        },
        perform: async function(agent: any, x: number, y: number, z: number): Promise<string> {
            let result = "";
            const actionFn = async (): Promise<void> => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: td('digDown'),
        params: {'distance': { type: 'int', description: tp('digDown', 'distance'), domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent: any, distance: number) => {
            await skills.digDown(agent.bot, distance);
        })
    },
    {
        name: '!stairUp',
        description: td('stairUp'),
        params: {
            'distance': { type: 'int', description: tp('stairUp', 'distance'), domain: [1, 64] }
        },
        perform: runAsAction(async (agent: any, distance: number) => {
            await skills.stairUp(agent.bot, distance);
        }, 4)
    },
    {
        name: '!pillarUp',
        description: td('pillarUp'),
        params: {
            'distance': { type: 'int', description: tp('pillarUp', 'distance'), domain: [1, 64] }
        },
        perform: runAsAction(async (agent: any, distance: number) => {
            await skills.pillarUp(agent.bot, distance);
        }, 4)
    },
    {
        name: '!goToSurface',
        description: td('goToSurface'),
        params: {},
        perform: runAsAction(async (agent: any) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!enterNether',
        description: td('enterNether'),
        params: {},
        // 规划、放 10 块门框、点火、走门都要时间，但必须有尽头。
        perform: runAsAction(async (agent: any) => {
            const result = await enterNether(agent.bot);
            skills.log(agent.bot, result.message);
        }, 5)
    },
    {
        name: '!useOn',
        description: td('useOn'),
        params: {
            'tool_name': { type: 'string', description: tp('useOn', 'tool_name') },
            'target': { type: 'string', description: tp('useOn', 'target') }
        },
        perform: runAsAction(async (agent: any, tool_name: string, target: string) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    // 交互类：useBlock / useEntity / craft。它们取代了一批把固定流程写死的中层
    // 工具（craftRecipe / smeltItem / putInChest / takeFromChest / viewChest /
    // tradeWithVillager / showVillagerTrades / goToBed / clearFurnace / givePlayer）。
    ...interactList,
    // 危险操作许可。**开关合一**：`revoke=true` 即收回授权。
    // 原来"授予 / 收回"是两个工具，模型要收回得先想起那个名字——而
    // restoreAllSafety 的注释里写的就是这个真实坑：漏掉一个等于没恢复干净。
    // 合并后"收回"就在"授予"的同一个 schema 里，不存在想不起来这回事。
    // minutes / calls 二选一：按时间，或按**工具调用次数**（失败也算，见 invokeTool 的 finally）。
    {
        name: '!allowDangerousOps',
        description: td('allowDangerousOps'),
        params: {
            // **两个都必须是可选的**：描述里写的是"minutes / calls 二选一"，
            // 但以前两个都没标 optional，于是 JSON Schema 把它们都列进 required——
            // 模型想"只按次数授权"（不给 minutes）就被拒，传 minutes=0 也被拒
            // （domain 最小 1）。它最后只能两个都传，等于被迫混进一个时间限制
            // （Feedback #4）。schema 得跟描述说的一致。
            'minutes': { type: 'int', description: tp('allowDangerousOps', 'minutes'), domain: [1, 120], optional: true },
            'calls': { type: 'int', description: tp('allowDangerousOps', 'calls'), domain: [1, 20], optional: true },
            'reason': { type: 'string', description: tp('allowDangerousOps', 'reason') },
            'ops': { type: 'string', description: tp('allowDangerousOps', 'ops') },
            'revoke': { type: 'boolean', description: tp('allowDangerousOps', 'revoke') }
        },
        perform: function (agent: any, minutes: number, calls: number, reason: string, ops: string, revoke?: boolean): string {
            void agent;
            if (revoke === true) {
                permits.revoke();
                return pad(`已收回危险操作授权。${permits.describe(Date.now())}`);
            }
            const wanted: string[] = String(ops ?? '').split(',').map((t) => t.trim()).filter((t) => t !== '');
            const unknown: string[] = wanted.filter((id) => !isAuthorizable(id));
            if (unknown.length > 0) {
                return pad(
                    `没有这些危险操作：${unknown.join('、')}。可用的有：${DANGEROUS_OPS.map((o) => o.id).join('、')}。`,
                );
            }
            const byCalls = typeof calls === 'number' && Number.isFinite(calls) && calls > 0;
            if (byCalls) {
                permits.grantCalls(wanted.length > 0 ? wanted : null, calls, reason, Date.now());
                return pad(`已授权接下来 ${calls} 次工具调用。${permits.describe(Date.now())}`);
            }
            const mins = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
            permits.grant(wanted.length > 0 ? wanted : null, mins, reason, Date.now());
            // describe() 里已经带了"原因"，这里不再重复一遍（真机反馈：原因重复两遍）。
            return pad(`已授权 ${mins} 分钟。${permits.describe(Date.now())}`);
        }
    },
    // 保命程序开关：和上面的危险操作许可**是两件事** —— 那管"拦不拦动作"，
    // 这里管"救不救命"。默认都开着，模型只有在清楚后果时才关。
    // 同样**开关合一**：`restore=true` 即重新打开保命程序。
    {
        name: '!disableSafeguards',
        description: td('disableSafeguards'),
        params: {
            'minutes': { type: 'int', description: tp('disableSafeguards', 'minutes'), domain: [1, 120] },
            'calls': { type: 'int', description: tp('disableSafeguards', 'calls'), domain: [1, 20] },
            'reason': { type: 'string', description: tp('disableSafeguards', 'reason') },
            'restore': { type: 'boolean', description: tp('disableSafeguards', 'restore') }
        },
        perform: function (agent: any, minutes: number, calls: number, reason: string, restore?: boolean): string {
            void agent;
            if (restore === true) {
                safeguards.release();
                return pad(`保命程序已重新打开。${safeguards.describe(Date.now())}`);
            }
            const byCalls = typeof calls === 'number' && Number.isFinite(calls) && calls > 0;
            if (byCalls) {
                safeguards.suppressCalls(calls, reason, Date.now());
                return pad(`保命程序已关闭，接下来 ${calls} 次工具调用内不介入。${safeguards.describe(Date.now())}`);
            }
            const mins = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
            safeguards.suppressFor(mins, reason, Date.now());
            return pad(`保命程序已关闭 ${mins} 分钟。${safeguards.describe(Date.now())}`);
        }
    },
    // 一键恢复**两层**保护：闸门许可 + 保命程序。
    // 分成两个工具有个真实的坑：模型可能只记得住其中一个（比如只记得
    // 单独收回某一层），于是"我刚才乱来了，收干净"这件事做不干净——
    // 授权还挂着，下一轮又被自己放行。紧急情况下要一个不用回忆的刹车。
    {
        name: '!restoreAllSafety',
        description: td('restoreAllSafety'),
        params: {},
        perform: function (): string {
            permits.revokeAll();
            safeguards.release();
            const now = Date.now();
            return pad(
                `已恢复全部保护。危险操作许可：${permits.describe(now)}。保命程序：${safeguards.describe(now)}。`,
            );
        }
    },
    // ── 原子动作 ────────────────────────────────────────────────────────────
    // 比 goToXxx / collectBlocks 低一档的单步动作。存在的理由与两条设计规则
    //（键位随动作释放、不许和寻路器抢身体）写在 `library/skills.ts` 的同一节里。
    {
        name: '!jump',
        description: td('jump'),
        params: {},
        perform: runAsAction(async (agent: any) => {
            await skills.jump(agent.bot);
        })
    },
    {
        name: '!move',
        description: td('move'),
        params: {
            'direction': { type: 'string', description: tp('move', 'direction') },
            'distance': { type: 'int', description: tp('move', 'distance'), domain: [1, 64] },
            'mode': {
                type: 'string',
                description: tp('move', 'mode'),
                optional: true,
                default: 'walk'
            }
        },
        perform: runAsAction(async (agent: any, direction: string, distance: number, mode: string = 'walk') => {
            await skills.moveBy(
                agent.bot,
                direction as skills.MoveDirection,
                distance,
                mode as 'walk' | 'sprint' | 'sneak',
            );
        })
    },
    {
        name: '!posture',
        description: td('posture'),
        params: {
            'state': { type: 'string', description: tp('posture', 'state') }
        },
        // 同步命令：姿态是瞬时状态改变，不占身体通道（占用它反而会让
        // "蹲着的时候想站起来"被自己的通道挡住）。
        perform: function (agent: any, state: string): string {
            return skills.setPosture(agent.bot, state);
        }
    },
    {
        name: '!lookDirection',
        description: td('lookDirection'),
        params: {
            'direction': { type: 'string', description: tp('lookDirection', 'direction') },
            'pitch': {
                type: 'int',
                description: tp('lookDirection', 'pitch'),
                optional: true,
                default: 0,
                domain: [-90, 90]
            }
        },
        perform: runAsAction(async (agent: any, direction: string, pitch: number = 0) => {
            await skills.lookInDirection(agent.bot, direction, pitch);
        })
    },
    {
        name: '!turnView',
        description: td('turnView'),
        params: {
            'yaw': { type: 'int', description: tp('turnView', 'yaw'), domain: [-360, 360] },
            'pitch': {
                type: 'int',
                description: tp('turnView', 'pitch'),
                optional: true,
                default: 0,
                domain: [-90, 90]
            }
        },
        perform: runAsAction(async (agent: any, yaw: number, pitch: number = 0) => {
            await skills.turnView(agent.bot, yaw, pitch);
        })
    },
];
