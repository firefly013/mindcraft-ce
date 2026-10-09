import * as skills from '../library/skills.js';
import { markDiscarded } from '../auto_pickup.js';
import { permits } from '../permits.js';
import { safeguards } from '../safeguards.js';
import { DANGEROUS_OPS, isAuthorizable } from '../dangerous_ops.js';
import { td, tp, MESSAGES } from '../../prompts.js';
import { interactList } from './interact.js';

// 命令参数定义（domain / optional / default 等保留原样透传）
/** 给工具回执加个空行，读起来不挤在一起（和 queries.ts 同款）。 */
const pad = (str: string): string => '\n' + str + '\n';

export interface CommandParamDef {
    type: string;
    description?: string;
    domain?: unknown;
    optional?: boolean;
    default?: unknown;
    [key: string]: unknown;
}

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


function runAsAction (actionFn: AgentActionFn, timeout = -1): CommandPerform {
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
        return code_return.message;
    };

    // **它跑在身体通道里，而且 `timeout` 默认 -1（没有上限）** —— 寻路几分钟是常态。
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
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
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
        name: '!rememberHere',
        description: td('rememberHere'),
        params: {'name': { type: 'string', description: tp('rememberHere', 'name') }},
        // eslint-disable-next-line require-await -- command interface requires a promise result
        perform: async function (agent: any, name: string): Promise<string> {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: td('goToRememberedPlace'),
        params: {'name': { type: 'string', description: tp('goToRememberedPlace', 'name') }},
        perform: runAsAction(async (agent: any, name: string) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
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
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);

            // **不要再走回原地**：原来扔完就 goToPosition 回 start_loc，而自动拾取的半径是

            // 8 格——走回去正好把刚扔的东西又捡回来（模型报过"discard 自己走回来捡回"）。

            // 同时登记一下，30 秒内自动拾取会跳过这个物品名。

            markDiscarded(item_name);

            skills.log(agent.bot, `扔掉了 ${num} 个 ${item_name}（30 秒内自动拾取会跳过它）。`);
        })
    },
    {
        name: '!collectBlocks',
        description: td('collectBlocks'),
        params: {
            'type': { type: 'BlockName', description: tp('collectBlocks', 'type') },
            'num': { type: 'int', description: tp('collectBlocks', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent: any, type: string, num: number) => {
            await skills.collectBlock(agent.bot, type, num);
        }, 10) // 10 分钟超时
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
        name: '!goToSurface',
        description: td('goToSurface'),
        params: {},
        perform: runAsAction(async (agent: any) => {
            await skills.goToSurface(agent.bot);
        })
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
            'minutes': { type: 'int', description: tp('allowDangerousOps', 'minutes'), domain: [1, 120] },
            'calls': { type: 'int', description: tp('allowDangerousOps', 'calls'), domain: [1, 20] },
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
];
