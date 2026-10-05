import pf from 'mineflayer-pathfinder';
import * as mc from '../../utils/mcdata.js';

// Vec3 coordinates are structural: mineflayer ships no types (see src/types/mineflayer.d.ts),
// so bot/entity/block handles stay `any` while pure coordinate shapes use Vec3Like.
/** Minimal structural position shared by world helpers. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export function getNearestFreeSpace(bot: any, size: number = 1, distance: number = 8): any {
    /**
     * Get the nearest empty space with solid blocks beneath it of the given size.
     * @param {Bot} bot - The bot to get the nearest free space for.
     * @param {number} size - The (size x size) of the space to find, default 1.
     * @param {number} distance - The maximum distance to search, default 8.
     * @returns {Vec3} - The south west corner position of the nearest free space.
     * @example
     * let position = world.getNearestFreeSpace(bot, 1, 8);
     **/
    // Vec3 result (mineflayer untyped) — intentionally `any`.
    const empty_pos: any[] = bot.findBlocks({
        matching: (block: any) => {
            return block && block.name == 'air';
        },
        maxDistance: distance,
        count: 1000
    });
    for (let i = 0; i < empty_pos.length; i++) {
        let empty = true;
        for (let x = 0; x < size; x++) {
            for (let z = 0; z < size; z++) {
                const top: any = bot.blockAt((empty_pos[i] as any).offset(x, 0, z));
                const bottom: any = bot.blockAt((empty_pos[i] as any).offset(x, -1, z));
                // NOTE: `!top.name == 'air'` is preserved verbatim from the JS original
                // (it evaluates `(!top.name) == 'air'`, always false); the cast only
                // silences TS2367 without changing runtime behavior.
                if (!top || ((!top.name) as unknown as string) == 'air' || !bottom || bottom.drops.length == 0 || !bottom.diggable) {
                    empty = false;
                    break;
                }
            }
            if (!empty) break;
        }
        if (empty) {
            return empty_pos[i];
        }
    }
    return undefined;
}


export function getBlockAtPosition(bot: any, x: number = 0, y: number = 0, z: number = 0): any {
     /**
     * Get a block from the bot's relative position
     * @param {Bot} bot - The bot to get the block for.
     * @param {number} x - The relative x offset to serach, default 0.
     * @param {number} y - The relative y offset to serach, default 0.
     * @param {number} y - The relative z offset to serach, default 0.
     * @returns {Block} - The nearest block.
     * @example
     * let blockBelow = world.getBlockAtPosition(bot, 0, -1, 0);
     * let blockAbove = world.getBlockAtPosition(bot, 0, 2, 0); since minecraft position is at the feet
     **/
    let block: any = bot.blockAt(bot.entity.position.offset(x, y, z));
    if (!block) block = {name: 'air'};

    return block;
}


export function getSurroundingBlocks(bot: any): string[] {
    /**
     * Get the surrounding blocks from the bot's environment.
     * @param {Bot} bot - The bot to get the block for.
     * @returns {string[]} - A list of block results as strings.
     * @example
     **/
    // Create a list of block position results that can be unpacked.
    const res: string[] = [];
    res.push(`Block Below: ${getBlockAtPosition(bot, 0, -1, 0).name}`);
    res.push(`Block at Legs: ${getBlockAtPosition(bot, 0, 0, 0).name}`);
    res.push(`Block at Head: ${getBlockAtPosition(bot, 0, 1, 0).name}`);

    return res;
}


export function getFirstBlockAboveHead(bot: any, ignore_types: string | string[] | null = null, distance: number = 32): string {
     /**
     * Searches a column from the bot's position for the first solid block above its head
     * @param {Bot} bot - The bot to get the block for.
     * @param {string[]} ignore_types - The names of the blocks to ignore.
     * @param {number} distance - The maximum distance to search, default 32.
     * @returns {string} - The fist block above head.
     * @example
     * let firstBlockAboveHead = world.getFirstBlockAboveHead(bot, null, 32);
     **/
    // if ignore_types is not a list, make it a list.
    let ignore_blocks: string[] = [];
    if (ignore_types === null) ignore_blocks = ['air', 'cave_air'];
    else {
        let names: string[];
        if (!Array.isArray(ignore_types))
            names = [ignore_types];
        else
            names = ignore_types;
        for (const ignore_type of names) {
            if ((mc as any).getBlockId(ignore_type)) ignore_blocks.push(ignore_type);
        }
    }
    // The block above, stops when it finds a solid block .
    let block_above: any = {name: 'air'};
    let height = 0;
    for (let i = 0; i < distance; i++) {
        let block: any = bot.blockAt(bot.entity.position.offset(0, i+2, 0));
        if (!block) block = {name: 'air'};
        // Ignore and continue
        if (ignore_blocks.includes(block.name)) continue;
        // Defaults to any block
        block_above = block;
        height = i;
        break;
    }

    if (ignore_blocks.includes(block_above.name)) return 'none';

    return `${block_above.name} (${height} blocks up)`;
}


export function getNearestBlocks(bot: any, block_types: string | string[] | null = null, distance: number = 8, count: number = 10000): any[] {
    /**
     * Get a list of the nearest blocks of the given types.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string[]} block_types - The names of the blocks to search for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @param {number} count - The maximum number of blocks to find, default 10000.
     * @returns {Block[]} - The nearest blocks of the given type.
     * @example
     * let woodBlocks = world.getNearestBlocks(bot, ['oak_log', 'birch_log'], 16, 1);
     **/
    // if blocktypes is not a list, make it a list
    let block_ids: number[] = [];
    if (block_types === null) {
        block_ids = (mc as any).getAllBlockIds(['air']) as number[];
    }
    else {
        let names: string[];
        if (!Array.isArray(block_types))
            names = [block_types];
        else
            names = block_types;
        for (const block_type of names) {
            block_ids.push((mc as any).getBlockId(block_type) as number);
        }
    }
    return getNearestBlocksWhere(bot, block_ids, distance, count);
}

export function getNearestBlocksWhere(bot: any, predicate: any, distance: number = 8, count: number = 10000): any[] {
    /**
     * Get a list of the nearest blocks that satisfy the given predicate.
     * `predicate` is `any` because callers pass either a block-id array
     * (from getNearestBlocks) or a filter function — mineflayer is untyped.
     * @param {Bot} bot - The bot to get the nearest blocks for.
     * @param {function} predicate - The predicate to filter the blocks.
     * @param {number} distance - The maximum distance to search, default 16.
     * @param {number} count - The maximum number of blocks to find, default 10000.
     * @returns {Block[]} - The nearest blocks that satisfy the given predicate.
     * @example
     * let waterBlocks = world.getNearestBlocksWhere(bot, block => block.name === 'water', 16, 10);
     **/
    const positions: any[] = bot.findBlocks({matching: predicate, maxDistance: distance, count: count});
    const blocks: any[] = positions.map(position => bot.blockAt(position));
    return blocks;
}


export function getNearestBlock(bot: any, block_type: string | string[], distance: number = 16): any {
     /**
     * Get the nearest block of the given type.
     * @param {Bot} bot - The bot to get the nearest block for.
     * @param {string} block_type - The name of the block to search for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {Block} - The nearest block of the given type.
     * @example
     * let coalBlock = world.getNearestBlock(bot, 'coal_ore', 16);
     **/
    const blocks: any[] = getNearestBlocks(bot, block_type, distance, 1);
    if (blocks.length > 0) {
        return blocks[0];
    }
    return null;
}


export function getNearbyEntities(bot: any, maxDistance: number = 16): any[] {
    const entities: { entity: any; distance: number }[] = [];
    for (const entity of Object.values(bot.entities) as any[]) {
        const distance: number = entity.position.distanceTo(bot.entity.position);
        if (distance > maxDistance) continue;
        entities.push({ entity: entity, distance: distance });
    }
    entities.sort((a, b) => a.distance - b.distance);
    const res: any[] = [];
    for (let i = 0; i < entities.length; i++) {
        res.push(entities[i].entity);
    }
    return res;
}

export function getNearestEntityWhere(bot: any, predicate: (entity: any) => boolean, maxDistance: number = 16): any {
    return bot.nearestEntity((entity: any) => predicate(entity) && bot.entity.position.distanceTo(entity.position) < maxDistance);
}


export function getNearbyPlayers(bot: any, maxDistance?: number): any[] {
    if (maxDistance == null) maxDistance = 16;
    const players: { entity: any; distance: number }[] = [];
    for (const entity of Object.values(bot.entities) as any[]) {
        const distance: number = entity.position.distanceTo(bot.entity.position);
        if (distance > (maxDistance as number)) continue;
        if (entity.type == 'player' && entity.username != bot.username) {
            players.push({ entity: entity, distance: distance });
        }
    }
    players.sort((a, b) => a.distance - b.distance);
    const res: any[] = [];
    for (let i = 0; i < players.length; i++) {
        res.push(players[i].entity);
    }
    return res;
}

// Helper function to get villager profession from metadata
export function getVillagerProfession(entity: any): string {
    // Villager profession mapping based on metadata
    const professions: Record<number, string> = {
        0: 'Unemployed',
        1: 'Armorer',
        2: 'Butcher',
        3: 'Cartographer',
        4: 'Cleric',
        5: 'Farmer',
        6: 'Fisherman',
        7: 'Fletcher',
        8: 'Leatherworker',
        9: 'Librarian',
        10: 'Mason',
        11: 'Nitwit',
        12: 'Shepherd',
        13: 'Toolsmith',
        14: 'Weaponsmith'
    };

    if (entity.metadata && entity.metadata[18]) {
        // Check if metadata[18] is an object with villagerProfession property
        if (typeof entity.metadata[18] === 'object' && entity.metadata[18].villagerProfession !== undefined) {
            const professionId: number = entity.metadata[18].villagerProfession as number;
            const level: number = entity.metadata[18].level || 1;
            const professionName: string = professions[professionId] || 'Unknown';
            return `${professionName} L${level}`;
        }
        // Fallback for direct profession ID
        else if (typeof entity.metadata[18] === 'number') {
            const professionId: number = entity.metadata[18] as number;
            return professions[professionId] || 'Unknown';
        }
    }

    // If we can't determine profession but it's an adult villager
    if (entity.metadata && entity.metadata[16] !== 1) { // Not a baby
        return 'Adult';
    }

    return 'Unknown';
}


export function getInventoryCounts(bot: any): Record<string, number> {
    /**
     * Get an object representing the bot's inventory.
     * @param {Bot} bot - The bot to get the inventory for.
     * @returns {object} - An object with item names as keys and counts as values.
     * @example
     * let inventory = world.getInventoryCounts(bot);
     * let oakLogCount = inventory['oak_log'];
     * let hasWoodenPickaxe = inventory['wooden_pickaxe'] > 0;
     **/
    const inventory: Record<string, number> = {};
    for (const slot of bot.inventory.slots as any[]) {
        if (slot != null && slot.name) {
            if (inventory[slot.name] == null) {
                inventory[slot.name] = 0;
            }
            (inventory[slot.name] as number) += slot.count as number;
        }
    }
    return inventory;
}


export function getCraftableItems(bot: any): string[] {
    /**
     * Get a list of all items that can be crafted with the bot's current inventory.
     * @param {Bot} bot - The bot to get the craftable items for.
     * @returns {string[]} - A list of all items that can be crafted.
     * @example
     * let craftableItems = world.getCraftableItems(bot);
     **/
    let table: any = getNearestBlock(bot, 'crafting_table');
    if (!table) {
        for (const item of bot.inventory.items() as any[]) {
            if (item != null && item.name === 'crafting_table') {
                table = item;
                break;
            }
        }
    }
    const res: string[] = [];
    for (const item of (mc as any).getAllItems() as any[]) {
        const recipes: any[] = bot.recipesFor(item.id, null, 1, table);
        if (recipes.length > 0)
            res.push(item.name);
    }
    return res;
}


export function getPosition(bot: any): any {
    /**
     * Get your position in the world (Note that y is vertical).
     * @param {Bot} bot - The bot to get the position for.
     * @returns {Vec3} - An object with x, y, and x attributes representing the position of the bot.
     * @example
     * let position = world.getPosition(bot);
     * let x = position.x;
     **/
    // Vec3 (mineflayer untyped) — intentionally `any`; treat as Vec3Like {x,y,z}.
    return bot.entity.position;
}


export function getNearbyEntityTypes(bot: any): string[] {
    /**
     * Get a list of all nearby mob types.
     * @param {Bot} bot - The bot to get nearby mobs for.
     * @returns {string[]} - A list of all nearby mobs.
     * @example
     * let mobs = world.getNearbyEntityTypes(bot);
     **/
    const mobs: any[] = getNearbyEntities(bot, 16);
    const found: string[] = [];
    for (let i = 0; i < mobs.length; i++) {
        if (!found.includes(mobs[i].name)) {
            found.push(mobs[i].name);
        }
    }
    return found;
}

export function isEntityType(name: string): boolean {
    /**
     * Check if a given name is a valid entity type.
     * @param {string} name - The name of the entity type to check.
     * @returns {boolean} - True if the name is a valid entity type, false otherwise.
     */
    return (mc as any).getEntityId(name) !== null;
}

export function getNearbyPlayerNames(bot: any): string[] {
    /**
     * Get a list of all nearby player names.
     * @param {Bot} bot - The bot to get nearby players for.
     * @returns {string[]} - A list of all nearby players.
     * @example
     * let players = world.getNearbyPlayerNames(bot);
     **/
    const players: any[] = getNearbyPlayers(bot, 64);
    const found: string[] = [];
    for (let i = 0; i < players.length; i++) {
        if (!found.includes(players[i].username) && players[i].username != bot.username) {
            found.push(players[i].username);
        }
    }
    return found;
}


export function getNearbyBlockTypes(bot: any, distance: number = 16): string[] {
    /**
     * Get a list of all nearby block names.
     * @param {Bot} bot - The bot to get nearby blocks for.
     * @param {number} distance - The maximum distance to search, default 16.
     * @returns {string[]} - A list of all nearby blocks.
     * @example
     * let blocks = world.getNearbyBlockTypes(bot);
     **/
    const blocks: any[] = getNearestBlocks(bot, null, distance);
    const found: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
        if (!found.includes(blocks[i].name)) {
            found.push(blocks[i].name);
        }
    }
    return found;
}

export async function isClearPath(bot: any, target: any): Promise<boolean> {
    /**
     * Check if there is a path to the target that requires no digging or placing blocks.
     * @param {Bot} bot - The bot to get the path for.
     * @param {Entity} target - The target to path to.
     * @returns {boolean} - True if there is a clear path, false otherwise.
     */
    const movements: any = new (pf as any).Movements(bot);
    movements.canDig = false;
    movements.canPlaceOn = false;
    movements.canOpenDoors = false;
    const goal: any = new (pf as any).goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);
    const path: any = await bot.pathfinder.getPathTo(movements, goal, 100);
    return path.status === 'success';
}

export function shouldPlaceTorch(bot: any): boolean {
    if (bot.interrupt_code) return false;
    const pos: any = getPosition(bot);
    // TODO: check light level instead of nearby torches, block.light is broken
    let nearest_torch: any = getNearestBlock(bot, 'torch', 6);
    if (!nearest_torch)
        nearest_torch = getNearestBlock(bot, 'wall_torch', 6);
    if (!nearest_torch) {
        const block: any = bot.blockAt(pos);
        const has_torch: any = bot.inventory.findInventoryItem('torch');
        return Boolean(has_torch) && block?.name === 'air';
    }
    return false;
}

export function getBiomeName(bot: any): string {
    /**
     * Get the name of the biome the bot is in.
     * @param {Bot} bot - The bot to get the biome for.
     * @returns {string} - The name of the biome.
     * @example
     * let biome = world.getBiomeName(bot);
     **/
    const biomeId: number = bot.world.getBiome(bot.entity.position) as number;
    return (mc as any).getAllBiomes()[biomeId].name as string;
}
