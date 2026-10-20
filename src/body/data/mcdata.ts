import minecraftData from 'minecraft-data';
import { expandTagRecipes } from './recipe_tags.js';
import settings from '../../shared/settings.js';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import { createRequire } from 'module';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { loader as autoEat } from 'mineflayer-auto-eat';
import plugin from 'mineflayer-armor-manager';
import { installArmorGuard } from '../library/armor_guard.js';
const armorManager = plugin;

const require = createRequire(import.meta.url);

/**
 * @nxg-org 的包是 CJS 且把插件挂在 `exports.default` 上，
 * ESM import 拿到的 namespace.default 是一层对象不是函数。
 * 这里走 require 精确取到 module.exports，启动期就断言是函数，
 * 免得进游戏才炸。
 */
function loadNxgPlugin(name: string): (bot: unknown) => void {
    const mod = require(name) as { default?: unknown } | ((bot: unknown) => void);
    const plugin = typeof mod === 'function' ? mod : (mod as { default?: unknown }).default;
    if (typeof plugin !== 'function') {
        throw new Error(`${name} did not export a mineflayer plugin function`);
    }
    return plugin as (bot: unknown) => void;
}
let mc_version = settings.minecraft_version;
// minecraft-data / prismarine-item ship no usable types here; treat registries as any
let mcdata: any = null;
let Item: any = null;

const FABRIC_REGISTRY_SYNC = 'fabric:registry/sync';
const FABRIC_REGISTRY_SYNC_COMPLETE = 'fabric:registry/sync/complete';

/**
 * Completes Fabric API's configuration-phase registry handshake.
 *
 * Fabric servers advertise the serverbound completion channel through
 * minecraft:register. Advertising the matching clientbound sync channel lets
 * Fabric send its registry map; Mineflayer can then finish configuration after
 * acknowledging that map. Servers without Fabric API are left untouched.
 */
function enableFabricRegistrySync(bot: any): void {
    let registrySyncAdvertised = false;

    bot._client.on('custom_payload', (packet: any) => {
        const channels: string[] = Array.isArray(packet.data) ? packet.data : [];

        if (packet.channel === 'minecraft:register'
            && channels.includes(FABRIC_REGISTRY_SYNC_COMPLETE)
            && !registrySyncAdvertised) {
            registrySyncAdvertised = true;
            bot._client.write('custom_payload', {
                channel: 'minecraft:register',
                data: Buffer.from(FABRIC_REGISTRY_SYNC, 'ascii'),
            });
            return;
        }

        if (packet.channel === FABRIC_REGISTRY_SYNC && registrySyncAdvertised) {
            bot._client.write('custom_payload', {
                channel: FABRIC_REGISTRY_SYNC_COMPLETE,
                data: Buffer.alloc(0),
            });
        }
    });
}

export type ItemName = string;
export type BlockName = string;

export const WOOD_TYPES: string[] = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];
export const MATCHING_WOOD_BLOCKS: string[] = [
    'log',
    'planks',
    'sign',
    'boat',
    'fence_gate',
    'door',
    'fence',
    'slab',
    'stairs',
    'button',
    'pressure_plate',
    'trapdoor',
];
export const WOOL_COLORS: string[] = [
    'white',
    'orange',
    'magenta',
    'light_blue',
    'yellow',
    'lime',
    'pink',
    'gray',
    'light_gray',
    'cyan',
    'purple',
    'blue',
    'brown',
    'green',
    'red',
    'black',
];


export function initBot(username: string): any {
    const options: {
        username: string;
        host: string;
        port: number | string;
        auth: string;
        version?: string;
        checkTimeoutInterval: number;
    } = {
        username: username,
        host: settings.host,
        port: settings.port ?? -1,
        auth: settings.auth,
        version: mc_version,
        checkTimeoutInterval: 60000,  // 60s keep-alive check (default 30s) — reduces disconnects on slow servers
    };
    if (!mc_version || mc_version === 'auto') {
        delete options.version;
    }

    const bot: any = createBot(options);

    enableFabricRegistrySync(bot);

    // Throttle position packets to avoid kicks on Paper/Spigot servers
    // Paper enforces stricter packet rate limits than vanilla, causing ECONNRESET
    // when mineflayer sends position updates faster than 50ms apart
    let lastPositionUpdate = 0;
    let pendingPositionPacket: NodeJS.Timeout | null = null;
    const POSITION_THROTTLE_MS = 50;
    const originalWrite: any = bot._client.write.bind(bot._client);
    bot._client.write = function (name: string, data: any) {
        if (name === 'position' || name === 'position_look' || name === 'look') {
            const now = Date.now();
            if (now - lastPositionUpdate < POSITION_THROTTLE_MS) {
                // Queue this packet so the last position update is never lost
                if (!pendingPositionPacket) {
                    pendingPositionPacket = setTimeout(() => {
                        pendingPositionPacket = null;
                        lastPositionUpdate = Date.now();
                        originalWrite(name, data);
                    }, POSITION_THROTTLE_MS - (now - lastPositionUpdate));
                }
                return;
            }
            lastPositionUpdate = now;
            if (pendingPositionPacket) {
                clearTimeout(pendingPositionPacket);
                pendingPositionPacket = null;
            }
        }
        return originalWrite(name, data);
    };

    // Suppress PartialReadError for non-critical packets
    // Paper servers sometimes send packets that node-minecraft-protocol
    // can't fully parse (scoreboard, resource_pack, custom_payload, etc.)
    // These errors crash the bot but the packets aren't needed for gameplay
    const originalEmit: any = bot._client.emit.bind(bot._client);
    bot._client.emit = function (event: string, ...args: any[]) {
        if (event === 'error' && args[0]) {
            const err: unknown = args[0];
            const errStr = err instanceof Error ? err.message : String(err);
            if (errStr.includes('PartialReadError')) {
                console.warn('[mcdata] Suppressed PartialReadError:', errStr.substring(0, 120));
                return true; // Swallow the error
            }
        }
        return originalEmit(event, ...args);
    };

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(loadNxgPlugin('@nxg-org/mineflayer-custom-pvp')); // bot.swordpvp 近战 + bot.bowpvp 远程
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(loadNxgPlugin('@nxg-org/mineflayer-common-sense')); // 保命应急：着火/摔落等基础响应
    bot.loadPlugin(armorManager); // auto equip armor
    // 这个插件按**材质等级**自动换甲（leather < golden < iron < …），在下界会把金甲换成铁甲，
    // 于是猪灵从"中立"变成"主动攻击"（overnight_b 真机事故）。装上守卫：下界保留金甲 + 任何
    // 护甲变化都要说出来；主世界/末地照旧换更好的甲。
    installArmorGuard(bot);
    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        mc_version = bot.version;
        mcdata = minecraftData(mc_version);
        // **这份 mcdata 也要打 tag 配方补丁**：craftRecipe 的"它还缺什么"提示和
        // getItemCraftingRecipes 读的是**这份**，而 mineflayer 的 recipesFor 读的是
        // bot.registry——两个是不同的对象。只补一处的话，就会出现"明明用桦木板做出来了，
        // 提示却说 requires oak_planks"（模型真机报过 shield 那条）。
        expandTagRecipes(mcdata);
        Item = prismarine_items(mc_version);
    });

    return bot;
}

export function isHuntable(mob: any): boolean {
    if (!mob || !mob.name) return false;
    const animals = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];
    return animals.includes(mob.name.toLowerCase()) && !mob.metadata[16]; // metadata 16 is not baby
}

/**
 * 这个生物是不是"敌对"。
 *
 * **不能用 mineflayer 运行时实体的 `type`。** 运行时的 `entity.type` 是**协议层**的
 * 实体种类（`'player' | 'mob' | 'object' | ...`），`'mob'` 的意思是"这是个生物、
 * 不是玩家也不是物体"——牛、猪、鳕鱼、三文鱼、鱿鱼**全都是 `'mob'`**。原来这里写的是
 * `(mob.type === 'mob' || mob.type === 'hostile')`，等于"**凡是生物都算敌对**"。
 *
 * 真机两例：
 * - 旧档（1.20.6）：「快照里只有两只 glow_squid，却收到一堆 hostile_nearby」；
 * - 新档（**1.21.11**）：「**salmon 被当成敌对生物，导致一直不捡掉落物**」，
 *   原话 `附近有敌对生物 salmon（13 格），这次不去捡掉落物——先保命`。
 *   水边十几条鱼，于是永远捡不到东西。
 *
 * 1.21.11 里 salmon 的 mcdata `type` 恰好是 `'mob'`（1.20.6 是 `'water_creature'`），
 * 所以这个 bug 在新版本上**暴露面更大**——版本一升级，鱼就变成了"敌人"。
 *
 * 权威判据是 mcdata 的 **`category`**（`'Hostile mobs'` / `'Passive mobs'`），
 * 两个版本都正确。没有 `category` 时退回 mcdata 自己的 `type === 'hostile'`
 * （这个字段的语义就是敌意，和协议层的 `type` 不是一回事）。
 * 两者都读不到 ⇒ **不当敌对**：宁可漏报（真正的保命是挨打触发的反射），
 * 也不能把整片鱼塘当敌人，让 bot 永远不敢捡东西。
 */
/** mcdata 是否已经就绪（只在 bot login 之后才有）。 */
export function entityDataReady(): boolean {
    return mcdata != null;
}

export function isHostile(mob: any): boolean {
    if (mob == null || typeof mob.name !== 'string' || mob.name.length === 0) return false;
    const name = mob.name.toLowerCase();
    if (name === 'iron_golem' || name === 'snow_golem' || name === 'player') return false;
    const data: any = (mcdata as any)?.entitiesByName?.[name];
    return hostileFromEntityData(data);
}

/**
 * 纯判定：只吃 mcdata 的实体数据条目，不读运行时实体。
 *
 * 和 `isHostile` 分开是为了可测——`mcdata` 只在 bot `login` 之后才有，
 * 而这条规则必须能在没有 bot 的情况下被钉住（它已经出过两次真机事故）。
 */
export function hostileFromEntityData(data: any): boolean {
    if (data == null) return false;
    if (typeof data.category === 'string') return data.category === 'Hostile mobs';
    if (typeof data.type === 'string') return data.type === 'hostile';
    return false;
}

// blocks that don't work with collectBlock, need to be manually collected
export function mustCollectManually(blockName: string): boolean {
    // all crops (that aren't normal blocks), torches, buttons, levers, redstone,
    const full_names = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart', 'cocoa', 'sugar_cane', 'kelp', 'short_grass', 'fern', 'tall_grass', 'bamboo',
        'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lilac', 'wither_rose', 'lily_of_the_valley', 'wither_rose',
        'lever', 'redstone_wire', 'lantern'];
    const partial_names = ['sapling', 'torch', 'button', 'carpet', 'pressure_plate', 'mushroom', 'tulip', 'bush', 'vines', 'fern'];
    return full_names.includes(blockName.toLowerCase()) || partial_names.some(partial => blockName.toLowerCase().includes(partial));
}

export function getItemId(itemName: string): number | null {
    const item: any = mcdata.itemsByName[itemName];
    if (item) {
        return item.id;
    }
    return null;
}

export function getItemName(itemId: number | string): string | null {
    const item: any = mcdata.items[itemId];
    if (item) {
        return item.name;
    }
    return null;
}

/**
 * 物品的耐久上限（mcData 静态表）。
 *
 * 为什么需要：真机上 `stone_pickaxe` 的手持物品读数是 `used=95 max=1`——
 * mineflayer 在 Fabric/模组注册表下给出的 `maxDurability` 可能不是耐久上限
 * （1 明显是错的，石头镐应为 131）。快照里宁可回退到 mcData 的静态表，
 * 也不要拿一个假上限去算"还剩几次"（模型会据此判断要不要换工具）。
 * 读不到 / 不是耐用品 / 上限 <=1 都返回 null，由调用方如实说"算不出剩余"。
 */
export function getItemMaxDurability(itemName: string): number | null {
    try {
        const item: any = mcdata?.itemsByName?.[itemName];
        const max = item?.maxDurability;
        return typeof max === 'number' && max > 1 ? max : null;
    } catch {
        // mcdata 还没初始化（bot 没连上）：如实返回读不到。
        return null;
    }
}

export function getBlockId(blockName: string): number | null {
    const block: any = mcdata.blocksByName[blockName];
    if (block) {
        return block.id;
    }
    return null;
}

export function getBlockName(blockId: number | string): string | null {
    const block: any = mcdata.blocks[blockId];
    if (block) {
        return block.name;
    }
    return null;
}

export function getEntityId(entityName: string): number | null {
    const entity: any = mcdata.entitiesByName[entityName];
    if (entity) {
        return entity.id;
    }
    return null;
}

export function getAllItems(ignore?: string[]): any[] {
    if (!ignore) {
        ignore = [];
    }
    const items: any[] = [];
    for (const itemId in mcdata.items) {
        const item: any = mcdata.items[itemId];
        if (!ignore.includes(item.name)) {
            items.push(item);
        }
    }
    return items;
}

export function getAllItemIds(ignore?: string[]): number[] {
    const items = getAllItems(ignore);
    const itemIds: number[] = [];
    for (const item of items) {
        itemIds.push(item.id);
    }
    return itemIds;
}

export function getAllBlocks(ignore?: string[]): any[] {
    if (!ignore) {
        ignore = [];
    }
    const blocks: any[] = [];
    for (const blockId in mcdata.blocks) {
        const block: any = mcdata.blocks[blockId];
        if (!ignore.includes(block.name)) {
            blocks.push(block);
        }
    }
    return blocks;
}

export function getAllBlockIds(ignore?: string[]): number[] {
    const blocks = getAllBlocks(ignore);
    const blockIds: number[] = [];
    for (const block of blocks) {
        blockIds.push(block.id);
    }
    return blockIds;
}

export function getAllBiomes(): any {
    return mcdata.biomes;
}

/**
 * 离线配方/物品资料的数据源（给 `searchWiki` 的本地兜底用）。
 *
 * 优先用**连上服务器之后那份 `mcdata`**——它带 `expandTagRecipes` 的 tag 补丁，
 * 和 `getItemCraftingRecipes` 是同一份数据（不复制第二份真相）。
 * 没连服务器（单测、离线部署、重启后的头几秒）就按 settings 的版本自己造一份，
 * 逐版本退让；**任何情况下都不抛**，读不到就返回 null，由调用方如实报"本地也没有"。
 */
let fallbackRecipeData: any = null;
export function getRecipeData(): any {
    if (mcdata != null) return mcdata;
    if (fallbackRecipeData != null) return fallbackRecipeData;
    const candidates: unknown[] = [mc_version, '1.20.6', '1.20.4', '1.21.4'];
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate === '' || candidate === 'auto') continue;
        try {
            const data = minecraftData(candidate);
            expandTagRecipes(data);
            fallbackRecipeData = data;
            return fallbackRecipeData;
        } catch {
            // 这个版本拿不到就试下一个。
        }
    }
    return null;
}

/**
 * 把 minecraft-data 的配方表归一化成 `[材料名→数量, { craftedCount }]`。
 *
 * **纯函数**：显式吃一份 dataset。这样"连上服务器那份"（带 tag 补丁）和
 * searchWiki 的离线兜底那份共用同一份归一化逻辑——两份各写一遍迟早漂移
 * （盾牌那次 `requires oak_planks` 的假提示就是这么来的）。
 */
export function normalizeRecipes(data: any, itemName: string): Array<[Record<string, number>, { craftedCount: number }]> | null {
    const itemId: number | null = typeof data?.itemsByName?.[itemName]?.id === 'number' ? data.itemsByName[itemName].id : null;
    if (itemId === null || !data?.recipes?.[itemId]) {
        return null;
    }
    const nameOfId = (id: unknown): string | null => {
        if (typeof id !== 'number') return null;
        const direct = data?.items?.[id];
        if (typeof direct?.name === 'string') return direct.name;
        for (const [name, def] of Object.entries(data?.itemsByName ?? {})) {
            if ((def as any)?.id === id) return name;
        }
        return null;
    };

    const recipes: Array<[Record<string, number>, { craftedCount: number }]> = [];
    for (const r of data.recipes[itemId] as any[]) {
        const recipe: Record<string, number> = {};
        let ingredients: any[] = [];
        if (r.ingredients) {
            ingredients = r.ingredients;
        } else if (r.inShape) {
            ingredients = r.inShape.flat();
        }
        for (const ingredient of ingredients) {
            const ingredientId = typeof ingredient === 'object' && ingredient !== null ? ingredient.id : ingredient;
            const ingredientName = nameOfId(ingredientId);
            if (ingredientName === null) continue;
            if (!recipe[ingredientName]) recipe[ingredientName] = 0;
            recipe[ingredientName] += typeof ingredient === 'object' && ingredient !== null && typeof ingredient.count === 'number'
                ? ingredient.count
                : 1;
        }
        recipes.push([recipe, { craftedCount: r.result.count }]);
    }
    // sort recipes by if their ingredients include common items
    const commonItems = ['oak_planks', 'oak_log', 'coal', 'cobblestone'];
    recipes.sort((a, b) => {
        const commonCountA = Object.keys(a[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + a[0][key], 0);
        const commonCountB = Object.keys(b[0]).filter(key => commonItems.includes(key)).reduce((acc, key) => acc + b[0][key], 0);
        return commonCountB - commonCountA;
    });

    return recipes;
}

export function getItemCraftingRecipes(itemName: string): Array<[Record<string, number>, { craftedCount: number }]> | null {
    return normalizeRecipes(mcdata, itemName);
}

export function isSmeltable(itemName: string): boolean {
    const misc_smeltables = ['beef', 'chicken', 'cod', 'mutton', 'porkchop', 'rabbit', 'salmon', 'tropical_fish', 'potato', 'kelp', 'sand', 'cobblestone', 'clay_ball'];
    return itemName.includes('raw') || itemName.includes('log') || misc_smeltables.includes(itemName);
}

export function getSmeltingFuel(bot: any): any {
    let fuel: any = bot.inventory.items().find((i: any) => i.name === 'coal' || i.name === 'charcoal' || i.name === 'blaze_rod');
    if (fuel)
        return fuel;
    fuel = bot.inventory.items().find((i: any) => i.name.includes('log') || i.name.includes('planks'));
    if (fuel)
        return fuel;
    return bot.inventory.items().find((i: any) => i.name === 'coal_block' || i.name === 'lava_bucket');
}

export function getFuelSmeltOutput(fuelName: string): number {
    // **完整燃料表**（Lead 2026-10-21：只认 oak_planks 导致「有 stick×4 却说燃料不够」，
    // B 卡在「有原料、有燃料、系统说没燃料」）。单位 = 每 1 个该物品能烧多少个物品。
    const FUEL_VALUES: Record<string, number> = {
        coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100,
        stick: 0.5, bamboo: 0.25, dried_kelp_block: 20, dead_bush: 0.5,
        oak_sapling: 0.5, spruce_sapling: 0.5, birch_sapling: 0.5, jungle_sapling: 0.5,
        acacia_sapling: 0.5, dark_oak_sapling: 0.5, cherry_sapling: 0.5, mangrove_propagule: 0.5,
        crafting_table: 1.5, chest: 1.5, bookshelf: 1.5, ladder: 0.5,
        white_wool: 0.5, cactus: 1, note_block: 1.5, jukebox: 1.5, scaffolding: 0.25,
    };
    const direct = FUEL_VALUES[fuelName];
    if (direct != null) return direct;
    // 名字类的兜底（不硬编码单个物品）：
    if (fuelName.endsWith('_planks') || fuelName.includes('_log') || fuelName.includes('_wood') || fuelName.endsWith('_stem') || fuelName.endsWith('_hyphae')) return 1.5;
    if (fuelName.endsWith('_sapling') || fuelName === 'torch' || fuelName.endsWith('_banner') || fuelName.includes('_door')) return 0.5;
    if (fuelName.endsWith('_axe') || fuelName.endsWith('_pickaxe') || fuelName.endsWith('_shovel') || fuelName.endsWith('_hoe') || fuelName.endsWith('_sword') || fuelName === 'bow' || fuelName === 'fishing_rod' || fuelName === 'wooden_pressure_plate' || fuelName === 'wooden_button') return 1;
    return 0;
}

export function getItemSmeltingIngredient(itemName: string): string | undefined {
    const table: Record<string, string> = {
        baked_potato: 'potato',
        steak: 'raw_beef',
        cooked_chicken: 'raw_chicken',
        cooked_cod: 'raw_cod',
        cooked_mutton: 'raw_mutton',
        cooked_porkchop: 'raw_porkchop',
        cooked_rabbit: 'raw_rabbit',
        cooked_salmon: 'raw_salmon',
        dried_kelp: 'kelp',
        iron_ingot: 'raw_iron',
        gold_ingot: 'raw_gold',
        copper_ingot: 'raw_copper',
        glass: 'sand',
    };
    return table[itemName];
}

export function getItemBlockSources(itemName: string): string[] {
    const itemId = getItemId(itemName);
    const sources: string[] = [];
    for (const block of getAllBlocks()) {
        if (block.drops.includes(itemId)) {
            sources.push(block.name);
        }
    }
    return sources;
}

export function getItemAnimalSource(itemName: string): string | undefined {
    const table: Record<string, string> = {
        raw_beef: 'cow',
        raw_chicken: 'chicken',
        raw_cod: 'cod',
        raw_mutton: 'sheep',
        raw_porkchop: 'pig',
        raw_rabbit: 'rabbit',
        raw_salmon: 'salmon',
        leather: 'cow',
        wool: 'sheep',
    };
    return table[itemName];
}

/**
 * **挖这个方块会掉什么物品**（真机 2026-10-21：`collectBlocks('coal_ore')` 用**方块名**
 * 查背包，可煤矿掉的是 `coal` ⇒ 挖成功了也永远显示「背包 0 → 0，没变化」，
 * 模型在 200+ 块煤矿中间反复说"没有采集到 coal_ore"）。
 *
 * 数据源：minecraft-data 的 `blocksByName[name].drops`（方块表里的掉落物品 id）。
 * 读不到就退回最常见的矿石映射表；再不行就返回 [blockName]（有些方块掉自己）。
 */
export const BLOCK_DROP_FALLBACK: Record<string, string[]> = {
    coal_ore: ['coal'],
    deepslate_coal_ore: ['coal'],
    iron_ore: ['raw_iron'],
    deepslate_iron_ore: ['raw_iron'],
    copper_ore: ['raw_copper'],
    deepslate_copper_ore: ['raw_copper'],
    gold_ore: ['raw_gold'],
    deepslate_gold_ore: ['raw_gold'],
    diamond_ore: ['diamond'],
    deepslate_diamond_ore: ['diamond'],
    emerald_ore: ['emerald'],
    deepslate_emerald_ore: ['emerald'],
    lapis_ore: ['lapis_lazuli'],
    deepslate_lapis_ore: ['lapis_lazuli'],
    redstone_ore: ['redstone'],
    deepslate_redstone_ore: ['redstone'],
    nether_quartz_ore: ['quartz'],
    nether_gold_ore: ['gold_nugget'],
    stone: ['cobblestone'],
    deepslate: ['cobblestone'],
    grass_block: ['dirt'],
    tall_grass: ['wheat_seeds'],
    gravel: ['gravel', 'flint'],
    oak_leaves: ['oak_sapling', 'stick', 'apple', 'oak_leaves'],
};

export function getBlockDropNames(blockName: string): string[] {
    const names = new Set<string>();
    try {
        const block: any = mcdata?.blocksByName?.[blockName];
        const drops: unknown = block?.drops;
        if (Array.isArray(drops)) {
            for (const entry of drops as any[]) {
                const drop = entry?.drop ?? entry;
                const id = typeof drop === 'number' ? drop : drop?.id;
                const name = id != null ? getItemName(id) : null;
                if (name != null) names.add(name);
            }
        }
    } catch {
        // 读不到方块数据就走下面的兜底。
    }
    if (names.size === 0) {
        for (const fallback of BLOCK_DROP_FALLBACK[blockName] ?? []) names.add(fallback);
    }
    if (names.size === 0) names.add(blockName);
    return [...names];
}

export function getBlockTool(blockName: string): string | null {
    const block: any = mcdata.blocksByName[blockName];
    if (!block || !block.harvestTools) {
        return null;
    }
    return getItemName(Object.keys(block.harvestTools)[0]);  // Double check first tool is always simplest
}

export function makeItem(name: string, amount = 1): any {
    return new Item(getItemId(name), amount);
}

/**
 * Returns the number of ingredients required to use the recipe once.
 */
export function ingredientsFromPrismarineRecipe(recipe: any): Record<string, number> {
    const requiredIngedients: Record<string, number> = {};
    if (recipe.inShape)
        for (const ingredient of recipe.inShape.flat()) {
            if (ingredient.id < 0) continue; //prismarine-recipe uses id -1 as an empty crafting slot
            const ingredientName = String(getItemName(ingredient.id));
            requiredIngedients[ingredientName] ??= 0;
            requiredIngedients[ingredientName] += ingredient.count;
        }
    if (recipe.ingredients)
        for (const ingredient of recipe.ingredients) {
            if (ingredient.id < 0) continue;
            const ingredientName = String(getItemName(ingredient.id));
            requiredIngedients[ingredientName] ??= 0;
            requiredIngedients[ingredientName] -= ingredient.count;
            //Yes, the `-=` is intended.
            //prismarine-recipe uses positive numbers for the shaped ingredients but negative for unshaped.
            //Why this is the case is beyond my understanding.
        }
    return requiredIngedients;
}

export interface LimitingResourceResult {
    num: number;
    limitingResource: string | null;
}

/**
 * Calculates the number of times an action, such as a crafing recipe, can be completed before running out of resources.
 */
export function calculateLimitingResource(
    availableItems: Record<string, number>,
    requiredItems: Record<string, number>,
    discrete = true,
): LimitingResourceResult {
    let limitingResource: string | null = null;
    let num = Infinity;
    for (const itemType in requiredItems) {
        if (availableItems[itemType] < requiredItems[itemType] * num) {
            limitingResource = itemType;
            num = availableItems[itemType] / requiredItems[itemType];
        }
    }
    if (discrete) num = Math.floor(num);
    return { num, limitingResource };
}

let loopingItems = new Set<string>();

export function initializeLoopingItems(): void {

    loopingItems = new Set(['coal',
        'wheat',
        'bone_meal',
        'diamond',
        'emerald',
        'raw_iron',
        'raw_gold',
        'redstone',
        'blue_wool',
        'packed_mud',
        'raw_copper',
        'iron_ingot',
        'dried_kelp',
        'gold_ingot',
        'slime_ball',
        'black_wool',
        'quartz_slab',
        'copper_ingot',
        'lapis_lazuli',
        'honey_bottle',
        'rib_armor_trim_smithing_template',
        'eye_armor_trim_smithing_template',
        'vex_armor_trim_smithing_template',
        'dune_armor_trim_smithing_template',
        'host_armor_trim_smithing_template',
        'tide_armor_trim_smithing_template',
        'wild_armor_trim_smithing_template',
        'ward_armor_trim_smithing_template',
        'coast_armor_trim_smithing_template',
        'spire_armor_trim_smithing_template',
        'snout_armor_trim_smithing_template',
        'shaper_armor_trim_smithing_template',
        'netherite_upgrade_smithing_template',
        'raiser_armor_trim_smithing_template',
        'sentry_armor_trim_smithing_template',
        'silence_armor_trim_smithing_template',
        'wayfinder_armor_trim_smithing_template']);
}


/**
 * Gets a detailed plan for crafting an item considering current inventory
 */
export function getDetailedCraftingPlan(
    targetItem: string,
    count = 1,
    current_inventory: Record<string, number> = {},
): string {
    initializeLoopingItems();
    if (!targetItem || count <= 0 || !getItemId(targetItem)) {
        return 'Invalid input. Please provide a valid item name and positive count.';
    }

    if (isBaseItem(targetItem)) {
        const available = current_inventory[targetItem] || 0;
        if (available >= count) return 'You have all required items already in your inventory';
        return `${targetItem} is a base item, you need to find ${count - available} more in the world`;
    }

    const inventory = { ...current_inventory };
    const leftovers: Record<string, number> = {};
    const plan = craftItem(targetItem, count, inventory, leftovers);
    return formatPlan(targetItem, plan);
}

export interface CraftPlan {
    required: Record<string, number>;
    steps: string[];
    leftovers: Record<string, number>;
}

function isBaseItem(item: string): boolean {
    return loopingItems.has(item) || getItemCraftingRecipes(item) === null;
}

function craftItem(
    item: string,
    count: number,
    inventory: Record<string, number>,
    leftovers: Record<string, number>,
    crafted: CraftPlan = { required: {}, steps: [], leftovers: {} },
): CraftPlan {
    // Check available inventory and leftovers first
    const availableInv = inventory[item] || 0;
    const availableLeft = leftovers[item] || 0;
    const totalAvailable = availableInv + availableLeft;

    if (totalAvailable >= count) {
        // Use leftovers first, then inventory
        const useFromLeft = Math.min(availableLeft, count);
        leftovers[item] = availableLeft - useFromLeft;

        const remainingNeeded = count - useFromLeft;
        if (remainingNeeded > 0) {
            inventory[item] = availableInv - remainingNeeded;
        }
        return crafted;
    }

    // Use whatever is available
    const stillNeeded = count - totalAvailable;
    if (availableLeft > 0) leftovers[item] = 0;
    if (availableInv > 0) inventory[item] = 0;

    if (isBaseItem(item)) {
        crafted.required[item] = (crafted.required[item] || 0) + stillNeeded;
        return crafted;
    }

    const recipe = getItemCraftingRecipes(item)?.[0];
    if (!recipe) {
        crafted.required[item] = stillNeeded;
        return crafted;
    }

    const [ingredients, result] = recipe;
    const craftedPerRecipe = result.craftedCount;
    const batchCount = Math.ceil(stillNeeded / craftedPerRecipe);
    const totalProduced = batchCount * craftedPerRecipe;

    // Add excess to leftovers
    if (totalProduced > stillNeeded) {
        leftovers[item] = (leftovers[item] || 0) + (totalProduced - stillNeeded);
    }

    // Process each ingredient
    for (const [ingredientName, ingredientCount] of Object.entries(ingredients)) {
        const totalIngredientNeeded = ingredientCount * batchCount;
        craftItem(ingredientName, totalIngredientNeeded, inventory, leftovers, crafted);
    }

    // Add crafting step
    const stepIngredients = Object.entries(ingredients)
        .map(([name, amount]) => `${amount * batchCount} ${name}`)
        .join(' + ');
    crafted.steps.push(`Craft ${stepIngredients} -> ${totalProduced} ${item}`);

    return crafted;
}

function formatPlan(targetItem: string, { required, steps, leftovers }: CraftPlan): string {
    const lines: string[] = [];

    if (Object.keys(required).length > 0) {
        lines.push('You are missing the following items:');
        Object.entries(required).forEach(([item, count]) =>
            lines.push(`- ${count} ${item}`));
        lines.push('\nOnce you have these items, here\'s your crafting plan:');
    } else {
        lines.push('You have all items required to craft this item');
        lines.push('Here\'s your crafting plan:');
    }

    lines.push('');
    lines.push(...steps);

    if (Object.keys(required).some(item => item.includes('oak')) && !targetItem.includes('oak')) {
        lines.push('Note: Any varient of wood can be used for this recipe.');
    }

    if (Object.keys(leftovers).length > 0) {
        lines.push('\nYou will have leftover:');
        Object.entries(leftovers).forEach(([item, count]) =>
            lines.push(`- ${count} ${item}`));
    }

    return lines.join('\n');
}
