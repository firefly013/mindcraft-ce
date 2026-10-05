import minecraftData from 'minecraft-data';
import settings from '../agent/settings.js';
import { createBot } from 'mineflayer';
import prismarine_items from 'prismarine-item';
import { pathfinder } from 'mineflayer-pathfinder';
import * as customPvpMod from '@nxg-org/mineflayer-custom-pvp';
import { plugin as collectblock } from 'mineflayer-collectblock';
import { loader as autoEat } from 'mineflayer-auto-eat';
import commonSense from '@nxg-org/mineflayer-common-sense';
import plugin from 'mineflayer-armor-manager';
const armorManager = plugin;
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
        port: settings.port,
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
    bot.loadPlugin((customPvpMod as any).default ?? customPvpMod); // bot.swordpvp 近战 + bot.bowpvp 远程
    bot.loadPlugin(collectblock);
    bot.loadPlugin(autoEat);
    bot.loadPlugin(commonSense); // 保命应急：着火/摔落等基础响应
    bot.loadPlugin(armorManager); // auto equip armor
    bot.once('resourcePack', () => {
        bot.acceptResourcePack();
    });

    bot.once('login', () => {
        mc_version = bot.version;
        mcdata = minecraftData(mc_version);
        Item = prismarine_items(mc_version);
    });

    return bot;
}

export function isHuntable(mob: any): boolean {
    if (!mob || !mob.name) return false;
    const animals = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];
    return animals.includes(mob.name.toLowerCase()) && !mob.metadata[16]; // metadata 16 is not baby
}

export function isHostile(mob: any): boolean {
    if (!mob || !mob.name) return false;
    return (mob.type === 'mob' || mob.type === 'hostile') && mob.name !== 'iron_golem' && mob.name !== 'snow_golem';
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

export function getItemCraftingRecipes(itemName: string): Array<[Record<string, number>, { craftedCount: number }]> | null {
    const itemId: number | null = getItemId(itemName);
    if (itemId === null || !mcdata.recipes[itemId]) {
        return null;
    }

    const recipes: Array<[Record<string, number>, { craftedCount: number }]> = [];
    for (const r of mcdata.recipes[itemId] as any[]) {
        const recipe: Record<string, number> = {};
        let ingredients: any[] = [];
        if (r.ingredients) {
            ingredients = r.ingredients;
        } else if (r.inShape) {
            ingredients = r.inShape.flat();
        }
        for (const ingredient of ingredients) {
            const ingredientName = getItemName(ingredient);
            if (ingredientName === null) continue;
            if (!recipe[ingredientName])
                recipe[ingredientName] = 0;
            recipe[ingredientName]++;
        }
        recipes.push([
            recipe,
            { craftedCount: r.result.count },
        ]);
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
    if (fuelName === 'coal' || fuelName === 'charcoal')
        return 8;
    if (fuelName === 'blaze_rod')
        return 12;
    if (fuelName.includes('log') || fuelName.includes('planks'))
        return 1.5;
    if (fuelName === 'coal_block')
        return 80;
    if (fuelName === 'lava_bucket')
        return 100;
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
