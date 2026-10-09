import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { load } from 'cheerio';
import { td, tp } from '../../prompts.js';
import { renderSections, sampleLiveState, type LiveSectionKey } from '../live_state.js';
import type { AgentCommand } from './actions.js';

const pad = (str: string): string => {
    return '\n' + str + '\n';
};

/**
 * `stats(type=…)` 的取值。
 *
 * 这五个查询工具（entities / inventory / nearbyBlocks / craftable / savedPlaces）
 * 已被它取代：三者本来就是 Live State 的子集（还更差——`entities` 半径 16 < 快照
 * 的 32 且不给坐标），另两个是快照里没有的小清单。留五个入口等于让模型先猜
 * "我要的信息叫哪个名字"，猜错就是一轮空转。
 *
 * **没有 craftable**：能合成什么是一张几十项的清单，模型真正要问的永远是
 * "这个东西怎么做、缺哪些材料"，那个 `getCraftingPlan(targetItem)` 答得更准。
 */
export const STATS_TYPES = ['all', 'body', 'inventory', 'entities', 'blocks', 'places'] as const;
export type StatsType = (typeof STATS_TYPES)[number];

/** 每个 type 对应的快照段落；`null` = 这段不在快照里，有自带实现。 */
const STATS_SECTIONS: Record<StatsType, readonly LiveSectionKey[] | null> = {
    // all 直接走 liveStateText()：整份快照，顺序与 Live State 注入的逐字一致。
    all: null,
    body: ['body', 'ops', 'held', 'position', 'environment', 'meta'],
    inventory: ['held', 'backpack'],
    entities: ['entities'],
    blocks: ['blocks'],
    places: null,
};

/** 旧 `!nearbyBlocks` 里快照**没有**的三样：全类型清单、身周三格、头顶实心块。 */
function blocksExtras(bot: any): string {
    const lines: string[] = [];
    try {
        // 默认 8 格、全部非空气方块（快照只报 38 种关键方块，但带坐标、半径 32）。
        const names = new Set<string>();
        for (const block of world.getNearestBlocks(bot) as Array<{ name?: string }>) {
            if (block?.name != null) names.add(block.name);
        }
        lines.push(`ALL_TYPES (8 格内，不区分坐标): ${[...names].join(', ') || 'none'}`);
        lines.push(...world.getSurroundingBlocks(bot).map((s: string) => `- ${s}`));
        lines.push(`- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`);
    } catch (error: unknown) {
        lines.push(`方块采样失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return lines.join('\n');
}

/** 拍一张状态照片。type 选要看哪一方面；不给就是整份（等同 Live State 那份）。 */
function runStats(agent: any, rawType: unknown): string {
    const given = typeof rawType === 'string' && rawType.trim() !== '' ? rawType.trim().toLowerCase() : 'all';
    const type = (STATS_TYPES as readonly string[]).includes(given) ? (given as StatsType) : null;
    if (type == null) {
        return pad(`stats 的 type 只认这些：${STATS_TYPES.join(' / ')}（收到 "${String(rawType)}"）。不给就是 all。`);
    }
    if (type === 'all') {
        return pad(`SNAPSHOT (留在上下文里，可和上一次对比)\n${agent.liveStateText()}`);
    }
    const snapshot = sampleLiveState(agent.sampleContext());
    const sections = STATS_SECTIONS[type];
    if (sections != null) {
        let out = renderSections(snapshot, sections);
        if (type === 'blocks') out += `\n${blocksExtras(agent.bot)}`;
        // 创造模式这句劝告是行为指引，不进快照（快照只陈述事实 gamemode）。
        if (type === 'inventory' && agent.bot?.game?.gameMode === 'creative') {
            out += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
        }
        return pad(out);
    }
    return pad(`Saved place names: ${agent.memory_bank.getKeys()}`);
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList: AgentCommand[] = [
    {
        name: "!stats",
        description: td('stats'),
        params: {
            'type': { type: 'string', description: tp('stats', 'type'), optional: true, default: 'all' }
        },
        // 回执附一张现拍画面：**只有这条命令要图**。
        // 理由是"状态快照"天然配一张现场照——模型问 stats 就是在问"我现在什么样"，
        // 而方块列表再详细也说不清"洞口在哪一侧"。别处一律纯文本：图片贵，
        // 每调一次工具就烧一笔 token 不值得。
        withScreenshot: true,
        // stats = 模型**主动拍的一张状态照片**：内容与每轮注入的 Live State
        // 同源（同一份采样，见 Agent.liveStateText），区别在于它是 Tool 回执，
        // 会永久留在上下文里——所以模型可以拿它和上一次对比："我多了什么"。
        // Live State 是感知（每轮现采、不入历史），stats 是记录（留存、可比对）。
        perform: function (agent: any, type?: unknown): string {
            return runStats(agent, type ?? 'all');
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
];
