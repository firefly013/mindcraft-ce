import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../data/mcdata.js';
import { load } from 'cheerio';
import { td, tp } from '../../shared/prompts.js';
import { renderSections, type LiveSectionKey } from '../../shared/live_state.js';
import { matchWikiName, renderLocalWikiAnswer } from '../../shared/wiki_local.js';
import { sampleLiveState } from '../live_state.js';
import type { AgentCommand } from './actions.js';

/** wiki 请求的超时（毫秒）。站点被墙时会一直挂着，不能让它拖住整个动作。 */
const WIKI_FETCH_TIMEOUT_MS = 8_000;

/** 带超时的 wiki 抓取：超时/网络错误都算"这条路没通"，交给本地兜底。 */
async function fetchWikiPage(query: string): Promise<Response> {
    const url = `https://minecraft.wiki/w/${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WIKI_FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, {
            signal: controller.signal,
            // 正常的浏览器头也一起带上：真机 403 不是 UA 的问题，但带上更体面。
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mindcraft-ce/1.0)', Accept: 'text/html' },
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 本地兜底：把 query 对上 minecraft-data 里的物品/方块，渲染成可行动的答案。
 *
 * 对不上（或数据没加载）返回 null——**不许猜、不许编**。
 */
function localWikiLookup(query: string, why: string | null): string | null {
    const data = mc.getRecipeData();
    if (data == null) return null;
    const items = (data.itemsByName ?? {}) as Record<string, any>;
    const blocks = (data.blocksByName ?? {}) as Record<string, any>;
    const name = matchWikiName(query, [...Object.keys(items), ...Object.keys(blocks)]);
    if (name == null) return null;
    const item = items[name] ?? null;
    const block = blocks[name] ?? null;
    if (item == null && block == null) return null;
    let recipes: Array<[Record<string, number>, { craftedCount: number }]> | null = null;
    try {
        recipes = mc.normalizeRecipes(data, name);
    } catch {
        recipes = null; // 配方表读不到就只报"这是什么"，别把整条兜底也弄丢。
    }
    return renderLocalWikiAnswer({
        query,
        name,
        item,
        block,
        recipes,
        displayName: (n: string) => items[n]?.displayName ?? n,
        why,
    });
}

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
export const STATS_TYPES = ['all', 'body', 'inventory', 'entities', 'blocks'] as const;
export type StatsType = (typeof STATS_TYPES)[number];

/** 每个 type 对应的快照段落；`null` = 这段不在快照里，有自带实现。 */
const STATS_SECTIONS: Record<StatsType, readonly LiveSectionKey[] | null> = {
    // all 直接走 liveStateText()：整份快照，顺序与 Live State 注入的逐字一致。
    all: null,
    body: ['body', 'ops', 'held', 'position', 'environment', 'meta'],
    inventory: ['held', 'backpack'],
    entities: ['entities'],
    blocks: ['blocks'],
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

/**
 * `stats` 的"这一段和上次一模一样"收尾提示。
 *
 * 真机：overnight_b 15 分钟里调了 **26 次** `stats`、overnight_a 15 次——模型在
 * 轮询而不是行动，每一次都烧掉一整轮请求。这里只在**渲染后的整段文本逐字相同**
 * 时追加一句"没变化，去做个动作"，其余情况（含任何异常、读不到）一律照旧发全量：
 * **失败开放**，绝不因为"以为没变"而扣掉状态。
 */
const STATS_REPEAT_HINT =
    '（这一段和上次调用完全相同：坐标/血量/背包都没有变化。）' +
    '如果你这一轮没有新的信息要拿，就把它用来做一个动作：move / goToCoordinates / mineBlock / collectBlocks / exploreFor / huntFor / craft —— 只查不做等于原地停摆；' +
    '如果快照的 Meta 里已经有动作在跑，就等它的回执，别重复发同一个动作。';

/**
 * 每个 agent、每种 `type` 上一次发出的段落文本。
 *
 * 用 `WeakMap` 挂在 agent 上、且只活在身体进程里：**bot 重启即清空**，
 * 不会拿上一个进程的快照来判"没变化"。
 */
const lastStatsText = new WeakMap<object, Map<string, string>>();

function withRepeatHint(agent: any, key: string, text: string): string {
    try {
        let perAgent = lastStatsText.get(agent);
        if (perAgent == null) {
            perAgent = new Map<string, string>();
            lastStatsText.set(agent, perAgent);
        }
        const previous = perAgent.get(key);
        perAgent.set(key, text);
        return previous != null && previous === text ? `${text}\n${STATS_REPEAT_HINT}` : text;
    } catch {
        // 缓存出任何问题都照旧把状态给出去（失败开放）。
        return text;
    }
}

/** 拍一张状态照片。type 选要看哪一方面；不给就是整份（等同 Live State 那份）。 */
function runStats(agent: any, rawType: unknown): string {
    const given = typeof rawType === 'string' && rawType.trim() !== '' ? rawType.trim().toLowerCase() : 'all';
    const type = (STATS_TYPES as readonly string[]).includes(given) ? (given as StatsType) : null;
    if (type == null) {
        return pad(`stats 的 type 只认这些：${STATS_TYPES.join(' / ')}（收到 "${String(rawType)}"）。不给就是 all。`);
    }
    if (type === 'all') {
        const text = `SNAPSHOT (留在上下文里，可和上一次对比)\n${agent.liveStateText()}`;
        return pad(withRepeatHint(agent, 'all', text));
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
        return pad(withRepeatHint(agent, type, out));
    }
    // `places` 的真源在**大脑侧会话**里（身体这份只装死亡位置那类瞬时信息），
    // 所以这里读不到——如实指过去，别返回一个永远是空的清单（那是 Feedback #6
    // "存了却列不出来"的老毛病换个地方复发）。
    return pad('列地名请用 getPlaces：记住的地方存在会话里，身体这边看不到。');
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
            // ── 网络这条路（真机上**基本注定失败**）─────────────────────
            // 这台机器访问 `https://minecraft.wiki/w/Bow` 是 **HTTP 403**（带正常
            // 浏览器 UA/Accept 也一样），example.com 却是 200——站点把我们挡了。
            // 所以 403/超时/空正文都不是"没有这个条目"，必须换本地资料回答。
            let why: string | null = null;
            try {
                const response = await fetchWikiPage(query);
                if (response.status === 404) {
                    why = 'wiki 上没有这个页面（HTTP 404）';
                } else if (!response.ok) {
                    // 非 404 的失败（403/429/5xx）**绝不能**接着解析错误页：
                    // 那个页面上的文字会被当成知识回给模型，等于把故障当事实。
                    why = `wiki 拒绝了这次查询（HTTP ${response.status}${response.status === 403 ? '，这台机器被挡了' : ''}）`;
                } else {
                    const html = await response.text();
                    const $ = load(html);
                    const parserOutput = $('div.mw-parser-output');
                    parserOutput.find('table.navbox').remove();
                    const text = parserOutput.text().trim();
                    if (text === '') why = 'wiki 页面没有可读正文';
                    else return text; // 真拿到了：原样返回（不是兜底）
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                why = `wiki 查询失败（网络/超时/解析：${message}）`;
                console.error('Error fetching or parsing HTML:', error);
            }

            // ── 本地兜底：用 minecraft-data 回答"这是什么/怎么做"──────
            const local = localWikiLookup(query, why);
            if (local != null) return local;

            // ── 两边都没有：如实说没有，并指向能离线用的工具 ──────────
            return (
                `searchWiki 拿不到「${query}」：${why}；本地资料（minecraft-data 离线兜底）里也没有这个名字。\n` +
                '这不是"你搜错了"，是这台机器访问不了 wiki。别再换关键词重试了，改用能离线工作的工具：\n' +
                '① 配方/材料数量：getCraftingPlan(targetItem=<名字>, quantity=<数量>)；\n' +
                '② 准确名字看 stats 里的背包/附近方块（都是 snake_case，例如 bow、oak_planks、crafting_table）。'
            );
        }
    },
    {
        name: '!inspect',
        description: td('inspect'),
        params: {
            'maxDistance': {
                type: 'int',
                description: tp('inspect', 'maxDistance'),
                optional: true,
                default: 5,
                domain: [1, 32]
            }
        },
        perform: function (agent: any, maxDistance = 5): string {
            return skills.inspectAimed(agent.bot, maxDistance);
        }
    },
];