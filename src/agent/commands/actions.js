import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { td, tp, MESSAGES } from '../../prompts.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: td('newAction'), 
        params: {
            'prompt': { type: 'string', description: tp('newAction', 'prompt') }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat(MESSAGES.newActionDisabled);
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: td('stop'),
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            return 'Agent stopped.';
        }
    },
    {
        name: '!stfu',
        description: td('stfu'),
        perform: async function (agent) {
            agent.openChat(MESSAGES.shuttingUp);
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: td('restart'),
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: td('clearChat'),
        perform: async function (agent) {
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
        perform: runAsAction(async (agent, player_name, closeness) => {
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
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
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
        perform: runAsAction(async (agent, x, y, z, closeness) => {
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
        perform: runAsAction(async (agent, block_type, range) => {
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
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: td('moveAway'),
        params: {'distance': { type: 'float', description: tp('moveAway', 'distance'), domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: td('rememberHere'),
        params: {'name': { type: 'string', description: tp('rememberHere', 'name') }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: td('goToRememberedPlace'),
        params: {'name': { type: 'string', description: tp('goToRememberedPlace', 'name') }},
        perform: runAsAction(async (agent, name) => {
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
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: td('consume'),
        params: {'item_name': { type: 'ItemName', description: tp('consume', 'item_name') }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: td('equip'),
        params: {'item_name': { type: 'ItemName', description: tp('equip', 'item_name') }},
        perform: runAsAction(async (agent, item_name) => {
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
        perform: runAsAction(async (agent, item_name, num) => {
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
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: td('viewChest'),
        params: { },
        perform: runAsAction(async (agent) => {
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
        perform: runAsAction(async (agent, item_name, num) => {
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
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: td('craftRecipe'),
        params: {
            'recipe_name': { type: 'ItemName', description: tp('craftRecipe', 'recipe_name') },
            'num': { type: 'int', description: tp('craftRecipe', 'num'), domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
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
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: td('clearFurnace'),
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: td('placeHere'),
        params: {'type': { type: 'BlockOrItemName', description: tp('placeHere', 'type') }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: td('attack'),
        params: {'type': { type: 'string', description: tp('attack', 'type')}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: td('attackPlayer'),
        params: {'player_name': { type: 'string', description: tp('attackPlayer', 'player_name')}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
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
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: td('stay'),
        params: {'type': { type: 'int', description: tp('stay', 'type'), domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: td('setMode'),
        params: {
            'mode_name': { type: 'string', description: tp('setMode', 'mode_name') },
            'on': { type: 'boolean', description: tp('setMode', 'on') }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!showVillagerTrades',
        description: td('showVillagerTrades'),
        params: {'id': { type: 'int', description: tp('showVillagerTrades', 'id') }},
        perform: runAsAction(async (agent, id) => {
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
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: td('startConversation'),
        params: {
            'player_name': { type: 'string', description: tp('startConversation', 'player_name') },
            'message': { type: 'string', description: tp('startConversation', 'message') },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', MESSAGES.alreadyInConversation(player_name));
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: td('endConversation'),
        params: {
            'player_name': { type: 'string', description: tp('endConversation', 'player_name') }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
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
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
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
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
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
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: td('goToSurface'),
        params: {},
        perform: runAsAction(async (agent) => {
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
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
