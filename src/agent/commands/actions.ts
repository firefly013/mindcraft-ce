import * as skills from '../library/skills.js';
import { td, tp, MESSAGES } from '../../prompts.js';

// 命令参数定义（domain / optional / default 等保留原样透传）
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
    perform: (agent: any, ...args: any[]) => unknown;
}

export type AgentActionFn = (agent: any, ...args: any[]) => Promise<unknown>;


function runAsAction (actionFn: AgentActionFn, timeout = -1): AgentCommand['perform'] {
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

    return wrappedAction;
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
        name: '!clearChat',
        description: td('clearChat'),
        // eslint-disable-next-line require-await -- command interface requires a promise result
        perform: async function (agent: any): Promise<string> {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
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
        name: '!givePlayer',
        description: td('givePlayer'),
        params: {
            'player_name': { type: 'string', description: tp('givePlayer', 'player_name') },
            'item_name': { type: 'ItemName', description: tp('givePlayer', 'item_name') },
            'num': { type: 'int', description: tp('givePlayer', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent: any, player_name: string, item_name: string, num: number) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
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
        name: '!putInChest',
        description: td('putInChest'),
        params: {
            'item_name': { type: 'ItemName', description: tp('putInChest', 'item_name') },
            'num': { type: 'int', description: tp('putInChest', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent: any, item_name: string, num: number) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: td('takeFromChest'),
        params: {
            'item_name': { type: 'ItemName', description: tp('takeFromChest', 'item_name') },
            'num': { type: 'int', description: tp('takeFromChest', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent: any, item_name: string, num: number) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: td('viewChest'),
        params: { },
        perform: runAsAction(async (agent: any) => {
            await skills.viewChest(agent.bot);
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
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
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
        name: '!craftRecipe',
        description: td('craftRecipe'),
        params: {
            'recipe_name': { type: 'ItemName', description: tp('craftRecipe', 'recipe_name') },
            'num': { type: 'int', description: tp('craftRecipe', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent: any, recipe_name: string, num: number) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: td('smeltItem'),
        params: {
            'item_name': { type: 'ItemName', description: tp('smeltItem', 'item_name') },
            'num': { type: 'int', description: tp('smeltItem', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent: any, item_name: string, num: number) => {
            await skills.smeltItem(agent.bot, item_name, num);
        })
    },
    {
        name: '!clearFurnace',
        description: td('clearFurnace'),
        params: { },
        perform: runAsAction(async (agent: any) => {
            await skills.clearNearestFurnace(agent.bot);
        })
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
        name: '!attack',
        description: td('attack'),
        params: {'type': { type: 'string', description: tp('attack', 'type')}},
        perform: runAsAction(async (agent: any, type: string) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: td('attackPlayer'),
        params: {'player_name': { type: 'string', description: tp('attackPlayer', 'player_name')}},
        perform: runAsAction(async (agent: any, player_name: string) => {
            const player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: td('goToBed'),
        perform: runAsAction(async (agent: any) => {
            await skills.goToBed(agent.bot);
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
        name: '!showVillagerTrades',
        description: td('showVillagerTrades'),
        params: {'id': { type: 'int', description: tp('showVillagerTrades', 'id') }},
        perform: runAsAction(async (agent: any, id: number) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: td('tradeWithVillager'),
        params: {
            'id': { type: 'int', description: tp('tradeWithVillager', 'id') },
            'index': { type: 'int', description: tp('tradeWithVillager', 'index'), domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: tp('tradeWithVillager', 'count'), domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent: any, id: number, index: number, count: number) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!lookAtPlayer',
        description: td('lookAtPlayer'),
        params: {
            'player_name': { type: 'string', description: tp('lookAtPlayer', 'player_name') },
            'direction': {
                type: 'string',
                description: tp('lookAtPlayer', 'direction'),
            }
        },
        perform: async function(agent: any, player_name: string, direction: string): Promise<string> {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async (): Promise<void> => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
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
];
