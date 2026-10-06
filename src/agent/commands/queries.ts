import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';
import { td, tp } from '../../prompts.js';
import type { AgentCommand } from './actions.js';

const pad = (str: string): string => {
    return '\n' + str + '\n';
};

// queries are commands that just return strings and don't affect anything in the world
export const queryList: AgentCommand[] = [
    {
        name: "!stats",
        description: td('stats'),
        perform: function (agent: any): string {
            const bot = agent.bot;
            let res = 'STATS';
            const pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `- Current Action: ${action}`;


            const players = world.getNearbyPlayerNames(bot);

            res += '\n- Nearby Players: ' + (players.length > 0 ? players.join(', ') : 'None.');

            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: td('inventory'),
        perform: function (agent: any): string {
            const bot = agent.bot;
            const inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            const helmet = bot.inventory.slots[5];
            const chestplate = bot.inventory.slots[6];
            const leggings = bot.inventory.slots[7];
            const boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: td('nearbyBlocks'),
        perform: function (agent: any): string {
            const bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            const blocks = world.getNearestBlocks(bot);
            const block_details = new Set<string>();

            for (const block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (const details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            }
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: td('craftable'),
        perform: function (agent: any): string {
            const craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: td('entities'),
        perform: function (agent: any): string {
            const bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            const players = world.getNearbyPlayerNames(bot);

            for (const player of players) {
                res += `\n- player: ${player}`;
            }

            const nearbyEntities = world.getNearbyEntities(bot);
            const entityCounts: Record<string, number> = {};
            const villagerIds: number[] = [];
            const babyVillagerIds: number[] = [];
            const villagerDetails: { id: number; profession: unknown }[] = []; // Store detailed villager info including profession

            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;

                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                (entityCounts[entity.name] as number)++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }

            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }

            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: '!savedPlaces',
        description: td('savedPlaces'),
        // eslint-disable-next-line require-await -- command interface requires a promise result
        perform: async function (agent: any): Promise<string> {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    },
    {
        name: '!checkBlueprintLevel',
        description: td('checkBlueprintLevel'),
        params: {
            'levelNum': { type: 'int', description: tp('checkBlueprintLevel', 'levelNum'), domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent: any, levelNum: number): string {
            const res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!checkBlueprint',
        description: td('checkBlueprint'),
        perform: function (agent: any): string {
            const res = checkBlueprint(agent);
            return pad(res);
        }
    },
    {
        name: '!getBlueprint',
        description: td('getBlueprint'),
        perform: function (agent: any): string {
            const res = agent.task.blueprint.explain();
            return pad(res);
        }
    },
    {
        name: '!getBlueprintLevel',
        description: td('getBlueprintLevel'),
        params: {
            'levelNum': { type: 'int', description: tp('getBlueprintLevel', 'levelNum'), domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent: any, levelNum: number): string {
            const res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: td('getCraftingPlan'),
        params: {
            targetItem: {
                type: 'string',
                description: tp('getCraftingPlan', 'targetItem')
            },
            quantity: {
                type: 'int',
                description: tp('getCraftingPlan', 'quantity'),
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent: any, targetItem: string, quantity = 1): string {
            const bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot);
            const target_item = targetItem;
            const existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error: unknown) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error instanceof Error ? error.message : String(error)}`;
            }


        },
    },
    {
        name: '!searchWiki',
        description: td('searchWiki'),
        params: {
            'query': { type: 'string', description: tp('searchWiki', 'query') }
        },
        perform: async function (agent: any, query: string): Promise<string> {
            // 宿主注入的语料优先（对齐 VLM 的注入式 SearchWiki）：单测与
            // 离线部署可以把检索换成自己的知识源，不必打网络。
            const injected = agent?.wikiSearch;
            if (typeof injected === 'function') {
                try {
                    const found: unknown = await injected(query);
                    if (typeof found === 'string' && found.trim() !== '') return found;
                    return `No wiki entry found for "${query}".`;
                } catch (error: unknown) {
                    console.error('Injected wiki search failed:', error);
                    return `Wiki lookup for "${query}" failed. Treat this as no information, not as an answer.`;
                }
            }
            const url = `https://minecraft.wiki/w/${query}`;
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                if (!response.ok) {
                  // 非 404 的失败（403/429/5xx）不能接着解析错误页：
                  // 那个页面上的文字会被当成知识回给模型，等于把故障当事实。
                  return `Wiki lookup for "${query}" failed (HTTP ${response.status}). Treat this as no information, not as an answer.`;
                }
                const html = await response.text();
                const $ = load(html);

                const parserOutput = $("div.mw-parser-output");

                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
                const text = divContent.trim();
                if (text === '') {
                  return `The Minecraft Wiki page for "${query}" had no readable content. Treat this as no information.`;
                }
                return text;
              } catch (error: unknown) {
                console.error("Error fetching or parsing HTML:", error);
                // 抓取失败必须如实报"没有信息"：以前把异常文本直接当
                // 知识回给模型，等于教它把故障当事实。
                return `Wiki lookup for "${query}" failed (network or parse error). Treat this as no information, not as an answer.`;
              }
        }
    },
    {
        name: '!help',
        description: td('help'),
        perform: async function (agent: any): Promise<string> {
            const { getToolDocs } = await import('./to_openai_tools.js');
            return getToolDocs(agent);
        }
    },
];
