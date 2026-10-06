import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";

export function log(bot: any, ...messages: any[]): void {
    bot.output += messages.join(' ') + '\n';
}

async function autoLight(bot: any): Promise<boolean> {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos: any = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err: unknown) { return false; }
    }
    return false;
}

async function equipHighestAttack(bot: any): Promise<void> {
    let weapons: any[] = bot.inventory.items().filter((item: any) => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter((item: any) => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a: any, b: any) => b.attackDamage - a.attackDamage);
    const weapon: any = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function craftRecipe(bot: any, itemName: string, num: number = 1): Promise<boolean> {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if ((mc as any).getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe`);
        return false;
    }

    // get recipes that don't require a crafting table
    let recipes: any[] = bot.recipesFor((mc as any).getItemId(itemName), null, 1, null);
    let craftingTable: any = null;
    const craftingTableRange = 16;
    placeTable: if (!recipes || recipes.length === 0) {
        recipes = bot.recipesFor((mc as any).getItemId(itemName), null, 1, true);
        if(!recipes || recipes.length === 0) break placeTable; //Don't bother going to the table if we don't have the required resources.

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null){

            // Try to place crafting table
            const hasTable: boolean = world.getInventoryCounts(bot)['crafting_table'] > 0;
            if (hasTable) {
                const pos: any = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = bot.recipesFor((mc as any).getItemId(itemName), null, 1, craftingTable);
                    placedTable = true;
                }
            }
            else {
                log(bot, `Crafting ${itemName} requires a crafting table.`);
                return false;
            }
        }
        else {
            recipes = bot.recipesFor((mc as any).getItemId(itemName), null, 1, craftingTable);
        }
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries((mc as any).getItemCraftingRecipes(itemName)[0][0] as Record<string, number>).map(([key, value]) => `${key}: ${value}`).join(', ')}.`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }

    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe: any = recipes[0];
    console.log('crafting...');
    //Check that the agent has sufficient items to use the recipe `num` times.
    const inventory: Record<string, number> = world.getInventoryCounts(bot); //Items in the agents inventory
    const requiredIngredients: Record<string, number> = (mc as any).ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit: any = (mc as any).calculateLimitingResource(inventory, requiredIngredients);

    await bot.craft(recipe, Math.min(craftLimit.num, num), craftingTable);
    if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
    if (placedTable) {
        await collectBlock(bot, 'crafting_table', 1);
    }

    //Equip any armor the bot may have crafted.
    //There is probablly a more efficient method than checking the entire inventory but this is all mineflayer-armor-manager provides. :P
    bot.armorManager.equipAll();

    return true;
}

export async function wait(bot: any, milliseconds: number): Promise<boolean> {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    const startTime = Date.now();

    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;

        const waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        const elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot: any, itemName: string, num: number = 1): Promise<boolean> {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!(mc as any).isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock: any;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        const hasFurnace: boolean = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            const pos: any = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    await bot.lookAt(furnaceBlock.position);

    console.log('smelting...');
    const furnace: any = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    const input_item: any = furnace.inputItem();
    if (input_item && input_item.type !== (mc as any).getItemId(itemName) && input_item.count > 0) {
        // TODO: check if furnace is currently burning fuel. furnace.fuel is always null, I think there is a bug.
        // This only checks if the furnace has an input item, but it may not be smelting it and should be cleared.
        log(bot, `The furnace is currently smelting ${(mc as any).getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    const inv_counts: Record<string, number> = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || (inv_counts[itemName] as number) < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        const fuel: any = (mc as any).getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel: number = Math.ceil(num / (mc as any).getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${(mc as any).getItemName(fuel.type)} to furnace fuel.`);
        console.log(`Added ${put_fuel} ${(mc as any).getItemName(fuel.type)} to furnace fuel.`);
    }
    // put the items in the furnace
    await furnace.putInput((mc as any).getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item: any = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${(mc as any).getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${(mc as any).getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot: any): Promise<boolean> {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    const furnaceBlock: any = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    console.log('clearing furnace...');
    const furnace: any = await bot.openFurnace(furnaceBlock);
    console.log('opened furnace...');
    // take the items out of the furnace
    let smelted_item: any, intput_item: any, fuel_item: any;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        intput_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    console.log(smelted_item, intput_item, fuel_item);
    const smelted_name: string = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    const input_name: string = intput_item ? `${intput_item.count} ${intput_item.name}` : `0 input items`;
    const fuel_name: string = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot: any, mobType: string, kill: boolean = true): Promise<boolean> {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    // 范围原来只有 24 格、失败只回一句"找不到"——模型真机报过
    // "attack 报找不到 pig，而快照里 16 格内就有一只"，它无从自查。
    // 现在放宽到 64 格，**失败时把附近实际有什么列出来**，让它能自己改目标。
    const ATTACK_RANGE = 64;
    const nearby: any[] = world.getNearbyEntities(bot, ATTACK_RANGE);
    const mob: any = nearby.find((entity: any) => entity.name === mobType);
    if (mob) {
        const res: boolean | undefined = await attackEntity(bot, mob, kill);
        return res === true;
    }
    const seen = [...new Set(nearby.map((e: any) => e.name).filter((n: unknown) => typeof n === 'string'))];
    log(
        bot,
        `Could not find any ${mobType} to attack within ${ATTACK_RANGE} blocks.` +
            (seen.length > 0 ? ` Nearby: ${seen.join(', ')}.` : ' Nothing nearby.'),
    );
    return false;
    }

export function stopPvp(bot: any): void {
    // @nxg-org/mineflayer-custom-pvp：近战 swordpvp + 远程 bowpvp 都要停
    try { bot?.swordpvp?.stop?.(); } catch { /* best-effort: bot may lack pvp plugins */ }
    try { bot?.bowpvp?.stop?.(); } catch { /* best-effort: bot may lack pvp plugins */ }
}

export async function attackEntity(bot: any, entity: any, kill: boolean = true): Promise<boolean | undefined> {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    const pos: any = entity.position;
    await equipHighestAttack(bot);

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            console.log('moving to mob...');
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        console.log('attacking mob...');
        await bot.attack(entity);
    }
    else {
        // 用手里已装备的精确武器名，避免插件按子串拿错武器；空手则不指定
        if (bot.heldItem?.name) {
            bot.swordpvp.weaponOfChoice = bot.heldItem.name;
        }
        await bot.swordpvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                stopPvp(bot);
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot: any, range: number = 9): Promise<boolean> {
    /**
     * Defend yourself from all nearby hostile mobs until there are no more.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 8.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     * @example
     * await skills.defendSelf(bot);
     * **/
    let attacked = false;
    let enemy: any = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        if (bot.entity.position.distanceTo(enemy.position) >= 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                bot.pathfinder.setMovements(new (pf as any).Movements(bot));
                await bot.pathfinder.goto(new (pf as any).goals.GoalFollow(enemy, 3.5), true);
            } catch (err: unknown) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(new (pf as any).Movements(bot));
                const inverted_goal: any = new (pf as any).goals.GoalInvert(new (pf as any).goals.GoalFollow(enemy, 2));
                await bot.pathfinder.goto(inverted_goal, true);
            } catch (err: unknown) {/* might error if entity dies, ignore */}
        }
        if (bot.heldItem?.name) {
            bot.swordpvp.weaponOfChoice = bot.heldItem.name;
        }
        await bot.swordpvp.attack(enemy);
        attacked = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), range);
        if (bot.interrupt_code) {
            stopPvp(bot);
            return false;
        }
    }
    stopPvp(bot);
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot: any, blockType: string, num: number = 1, exclude: any = null): Promise<boolean> {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    const blocktypes: string[] = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;

    const movements: any = new (pf as any).Movements(bot);
    movements.dontMineUnderFallingBlock = false;
    movements.dontCreateFlow = true;

    // Blocks to ignore safety for, usually next to lava/water
    const unsafeBlocks: string[] = ['obsidian'];

    for (let i=0; i<num; i++) {
        const blocks: any[] = world.getNearestBlocksWhere(bot, (block: any) => {
            if (!blocktypes.includes(block.name)) {
                return false;
            }
            if (exclude) {
                for (const position of exclude as any[]) {
                    if (block.position.x === position.x && block.position.y === position.y && block.position.z === position.z) {
                        return false;
                    }
                }
            }
            if (isLiquid) {
                // collect only source blocks
                return block.metadata === 0;
            }

            return movements.safeToBreak(block) || unsafeBlocks.includes(block.name);
        }, 64, 1);

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block: any = blocks[0];
        await bot.tool.equipForBlock(block);
        if (isLiquid) {
            const bucket: any = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId: any = bot.heldItem ? bot.heldItem.type : null;
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        try {
            let success = false;
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if ((mc as any).mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await bot.dig(block);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                await bot.collectBlock.collect(block);
                success = true;
            }
            if (success)
                collected++;
            await autoLight(bot);
        }
        catch (err: unknown) {
            const e = err as { name?: string } | null | undefined;
            if (e?.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                const msg: string = err instanceof Error ? err.message : String(err);
                log(bot, `Failed to collect ${blockType}: ${msg}.`);
                continue;
            }
        }

        if (bot.interrupt_code)
            break;
    }
    log(bot, `Collected ${collected} ${blockType}.`);
    return collected > 0;
}

export async function pickupNearbyItems(bot: any): Promise<boolean> {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = 8;
    const getNearestItem = (b: any): any => b.nearestEntity((entity: any) => entity.name === 'item' && b.entity.position.distanceTo(entity.position) < distance);
    let nearestItem: any = getNearestItem(bot);
    let pickedUp = 0;
    while (nearestItem) {
        const movements: any = new (pf as any).Movements(bot);
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new (pf as any).goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        const prev: any = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot: any, x: number, y: number, z: number): Promise<boolean> {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    const block: any = bot.blockAt((Vec3 as any)(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (settings.cheat) {
            const msg: string = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            const pos: any = block.position;
            const movements: any = new (pf as any).Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new (pf as any).goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await bot.tool.equipForBlock(block);
            const itemId: any = bot.heldItem ? bot.heldItem.type : null;
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        await bot.dig(block, true);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function placeBlock(bot: any, blockType: string, x: number, y: number, z: number, placeOn: string = 'bottom', dontCheat: boolean = false): Promise<boolean> {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest: any = new (Vec3 as any)(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (settings.cheat && !dontCheat) {
        if (bot.restrict_to_inventory) {
            const block: any = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        const face: string = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        const msg: string = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item: any = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, (mc as any).makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock: any = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks: string[] = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed: boolean = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock: any = null;
    let faceVec: any = null;
    const dir_map: Record<string, any> = {
        'top': (Vec3 as any)(0, 1, 0),
        'bottom': (Vec3 as any)(0, -1, 0),
        'north': (Vec3 as any)(0, 0, -1),
        'south': (Vec3 as any)(0, 0, 1),
        'east': (Vec3 as any)(1, 0, 0),
        'west': (Vec3 as any)(-1, 0, 0),
    };
    const dirs: any[] = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter((d: any) => !dirs.includes(d)));

    for (const d of dirs) {
        const block: any = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new (Vec3 as any)(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos: any = bot.entity.position;
    const pos_above: any = pos.plus((Vec3 as any)(0,1,0));
    const dont_move_for: string[] = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail',
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close
        const goal: any = new (pf as any).goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        const inverted_goal: any = new (pf as any).goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new (pf as any).Movements(bot));
        await bot.pathfinder.goto(inverted_goal);
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        const tpos: any = targetBlock.position;
        const movements: any = new (pf as any).Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new (pf as any).goals.GoalNear(tpos.x, tpos.y, tpos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err: unknown) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
    return false;
}

export async function equip(bot: any, itemName: string): Promise<boolean> {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item: any = bot.inventory.slots.find((slot: any) => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, (mc as any).makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot: any, itemName: string, num: number = -1): Promise<boolean> {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        const item: any = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        const to_discard: number = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot: any, itemName: string, num: number = -1): Promise<boolean> {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    const chest: any = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    const item: any = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    const to_put: number = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer: any = await bot.openContainer(chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot: any, itemName: string, num: number = -1): Promise<boolean> {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    const chest: any = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer: any = await bot.openContainer(chest);

    // Find all matching items in the chest
    const matchingItems: any[] = chestContainer.containerItems().filter((item: any) => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }

    const totalAvailable: number = matchingItems.reduce((sum: number, item: any) => sum + item.count, 0);
    let remaining: number = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;

    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;

        const toTakeFromSlot: number = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);

        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }

    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot: any): Promise<boolean> {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    const chest: any = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer: any = await bot.openContainer(chest);
    const items: any[] = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (const item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot: any, itemName: string = ""): Promise<boolean> {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item: any;
    let name: string | undefined;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    await bot.consume();
    log(bot, `Consumed ${item.name}.`);
    return true;
}


export async function giveToPlayer(bot: any, itemType: string, username: string, num: number = 1): Promise<boolean> {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    const player: any = bot.players[username].entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        const start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector: any, collected: any) => {
            console.log(collected.name);
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        const start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

export async function goToGoal(bot: any, goal: any, _persist?: boolean): Promise<boolean> {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * (`_persist` is ignored; it exists only because one legacy call site
     * passes a third argument.)
     **/

    const nonDestructiveMovements: any = new (pf as any).Movements(bot);
    const dontBreakBlocks: string[] = ['glass', 'glass_pane'];
    for (const block of dontBreakBlocks) {
        nonDestructiveMovements.blocksCantBreak.add((mc as any).getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements: any = new (pf as any).Movements(bot);

    // **落差上限压到 2 格**。这两套 Movements 原来都没设 maxDropDown（默认 4），
    // 而 destructiveMovements 更是纯默认值——模型真机上反复被它带进大落差：
    // pib "从 y=29 掉回来 12 格"、pia "searchForBlock 带我从竖井直落 13 格"（摔死）。
    // 多绕几步也比摔死强，何况它手上有 mineBlock/placeBlock 可以自己开路。
    for (const movements of [nonDestructiveMovements, destructiveMovements]) {
        movements.maxDropDown = 2;
    }
    // 破坏性寻路也别太随便挖：让"挖"比"绕"贵，只有真绕不过去才动镐。
    destructiveMovements.digCost = 5;

    let final_movements: any = destructiveMovements;

    const pathfind_timeout = 1000;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
    }
    else {
        log(bot, `Path not found, but attempting to navigate anyway using destructive movements.`);
    }

    const doorCheckInterval: ReturnType<typeof setInterval> = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        await bot.pathfinder.goto(goal);
        clearInterval(doorCheckInterval);
        return true;
    } catch (err: unknown) {
        clearInterval(doorCheckInterval);
        // we need to catch so we can clean up the door check interval, then rethrow the error
        throw err;
    }
}

let _doorInterval: ReturnType<typeof setInterval> | null = null;
function startDoorInterval(bot: any): ReturnType<typeof setInterval> {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos: any = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval: ReturnType<typeof setInterval> = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }

        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions: any[] = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1),
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ];
            const elevated_positions: any[] = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet

            let currentIndex = positions.length;
            while (currentIndex != 0) {
                const randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }

            for (const position of positions) {
                const block: any = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor')))
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot: any, x: number | null, y: number | null, z: number | null, min_distance: number = 2): Promise<boolean> {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (settings.cheat) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }

    const checkDigProgress = (): void => {
        if (bot.targetDigBlock) {
            const targetBlock: any = bot.targetDigBlock;
            const itemId: any = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };

    const progressInterval: ReturnType<typeof setInterval> = setInterval(checkDigProgress, 1000);

    try {
        await goToGoal(bot, new (pf as any).goals.GoalNear(x, y, z, min_distance));
        clearInterval(progressInterval);
        const distance: number = bot.entity.position.distanceTo(new (Vec3 as any)(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err: unknown) {
        const msg: string = err instanceof Error ? err.message : String(err);
        log(bot, `Pathfinding stopped: ${msg}.`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToNearestBlock(bot: any, blockType: string, min_distance: number = 2, range: number = 64): Promise<boolean> {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block: any;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks: any[] = world.getNearestBlocksWhere(bot, (block: any) => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, (b: any) => b.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    const arrived = await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    // **把结果如实返回**：原来无条件 return true;，路径不可达时工具照样报成功——
    // 模型反馈过"找不到目标时静默"，其实不是找不到，是找到了但走不过去，结果被吞了。
    if (!arrived) log(bot, `Found ${block.name} at ${block.position} but could not reach it (path blocked or too far).`);
    return arrived;
}

export async function goToNearestEntity(bot: any, entityType: string, min_distance: number = 2, range: number = 64): Promise<boolean> {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    const entity: any = world.getNearestEntityWhere(bot, (entity: any) => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    const distance: number = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    const arrived = await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    // **把结果如实返回**：原来无条件 return true;，路径不可达时工具照样报成功——
    // 模型反馈过"找不到目标时静默"，其实不是找不到，是找到了但走不过去，结果被吞了。
    if (!arrived) log(bot, `Found ${entity.name} at ${entity.position} but could not reach it (path blocked or too far).`);
    return arrived;
}

export async function goToPlayer(bot: any, username: string, distance: number = 3): Promise<boolean | undefined> {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (settings.cheat) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    const player: any = bot.players[username].entity;
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal: any = new (pf as any).goals.GoalFollow(player, distance);

    await goToGoal(bot, goal, true);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot: any, username: string, distance: number = 4): Promise<boolean> {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    const player: any = bot.players[username].entity;
    if (!player)
        return false;

    const move: any = new (pf as any).Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval: ReturnType<typeof setInterval> | null = startDoorInterval(bot);

    bot.pathfinder.setGoal(new (pf as any).goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // with cheat enabled, if the distance is too far, teleport to the player
        const distance_from_player: number = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && settings.cheat) {
            // teleport with cheat enabled
            await goToPlayer(bot, username);
        }

        if (distance_from_player <= nearby_distance) {
            if (doorCheckInterval) clearInterval(doorCheckInterval);
            doorCheckInterval = null;
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
        }
    }
    if (doorCheckInterval) clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot: any, distance: number): Promise<boolean> {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos: any = bot.entity.position;
    const goal: any = new (pf as any).goals.GoalNear(pos.x, pos.y, pos.z, distance);
    const inverted_goal: any = new (pf as any).goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new (pf as any).Movements(bot));

    if (settings.cheat) {
        const move: any = new (pf as any).Movements(bot);
        const path: any = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        const last_move: any = path.path[path.path.length-1];
        if (last_move) {
            const x: number = Math.floor(last_move.x);
            const y: number = Math.floor(last_move.y);
            const z: number = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    const new_pos: any = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot: any, entity: any, distance: number = 16): Promise<boolean> {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    const goal: any = new (pf as any).goals.GoalFollow(entity, distance);
    const inverted_goal: any = new (pf as any).goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new (pf as any).Movements(bot));
    await bot.pathfinder.goto(inverted_goal);
    return true;
}

export async function avoidEnemies(bot: any, distance: number = 16): Promise<boolean> {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    let enemy: any = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), distance);
    while (enemy) {
        const follow: any = new (pf as any).goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal: any = new (pf as any).goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new (pf as any).Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, (entity: any) => (mc as any).isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot: any, seconds: number = 30): Promise<boolean> {
    /**
     * Stay in the current position until interrupted.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    const start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot: any, door_pos: any = null): Promise<boolean> {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    // Vec3-like position (mineflayer untyped) — `any`; may be null to auto-find.
    if (!door_pos) {
        for (const door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            const found: any = world.getNearestBlock(bot, door_type, 16);
            door_pos = found ? found.position : null;
            if (door_pos) break;
        }
    } else {
        door_pos = (Vec3 as any)(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    bot.pathfinder.setGoal(new (pf as any).goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const door_block: any = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);

    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot: any): Promise<boolean> {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds: any[] = bot.findBlocks({
        matching: (block: any) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    const loc: any = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed: any = bot.blockAt(loc);
    await bot.sleep(bed);
    log(bot, `You are in bed.`);
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot: any, x: number, y: number, z: number, seedType: string | null = null): Promise<boolean> {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    const pos: any = new (Vec3 as any)(Math.floor(x), Math.floor(y), Math.floor(z));
    const block: any = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (settings.cheat) {
        const to_remove: string[] = ['_seed', '_seeds'];
        for (const remove of to_remove) {
            // Non-null assertion: original code assumes a seed name in cheat mode.
            if ((seedType as string).endsWith(remove)) {
                seedType = (seedType as string).replace(remove, '');
            }
        }
        await placeBlock(bot, 'farmland', x, y, z);
        await placeBlock(bot, seedType as string, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    const above: any = bot.blockAt(new (Vec3 as any)(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        const broken: boolean = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        const bpos: any = block.position;
        bot.pathfinder.setMovements(new (pf as any).Movements(bot));
        await goToGoal(bot, new (pf as any).goals.GoalNear(bpos.x, bpos.y, bpos.z, 4));
    }
    if (block.name !== 'farmland') {
        const hoe: any = bot.inventory.items().find((item: any) => item.name.includes('hoe'));
        const to_equip: string = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }

    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        const equipped_seeds: boolean = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot: any, type: string): Promise<boolean> {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    const block: any = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        const pos: any = block.position;
        bot.pathfinder.setMovements(new (pf as any).Movements(bot));
        await goToGoal(bot, new (pf as any).goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot: any, id: string | number): Promise<any> {
    id = id+"";
    const entity: any = bot.entities[id];

    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        const entities: any[] = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (const entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession: string = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }

    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }

    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }

    const distance: number = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            const goal: any = new (pf as any).goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);


            log(bot, 'Successfully reached villager');
        } catch (err: unknown) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            console.log(err);
            return null;
        }
    }

    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot: any, id: string | number): Promise<boolean> {
    const villagerEntity: any = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }

    try {
        const villager: any = await bot.openVillager(villagerEntity);

        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }

        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade: string, i: number) => {
            const tradeInfo: string = `${i + 1}: ${trade}`;
            console.log(tradeInfo);
            log(bot, tradeInfo);
        });

        villager.close();
        return true;
    } catch (err: unknown) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        const msg: string = err instanceof Error ? err.message : String(err);
        console.log('Villager trading error:', msg);
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot: any, id: string | number, index: string | number, count: string | number): Promise<boolean> {
    const villagerEntity: any = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }

    try {
        const villager: any = await bot.openVillager(villagerEntity);

        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }

        const tradeIndex: number = parseInt(String(index)) - 1; // Convert to 0-based index
        const trade: any = villager.trades[tradeIndex];

        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }

        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2: string = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);

        const maxPossibleTrades: number = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount: number = Number(count);
        const actualCount: number = Math.min(requestedCount, maxPossibleTrades);

        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }

        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }

        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);

        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr: unknown) {
            log(bot, 'An error occurred while trying to execute the trade');
            const msg: string = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
            console.log('Trade execution error:', msg);
            villager.close();
            return false;
        }
    } catch (err: unknown) {
        log(bot, 'Failed to open villager trading interface');
        const msg: string = err instanceof Error ? err.message : String(err);
        console.log('Villager interface error:', msg);
        return false;
    }
}

function hasResources(window: any, trade: any, count: number): boolean {
    const first: boolean = enough(trade.inputItem1, count);
    const second: boolean = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item: any, count: number): boolean {
        let c = 0;
        (window as any[]).forEach((element: any) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot: any, trades: any[]): string[] {
    return trades.map((trade: any) => {
        let text: string = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot: any, item: any): string {
    if (!item) return 'nothing';
    let text: string = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench: any = item.nbt.value.ench;
        const StoredEnchantments: any = item.nbt.value.StoredEnchantments;
        const Potion: any = item.nbt.value.Potion;
        const display: any = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            text += ` enchanted with ${(ench || StoredEnchantments).value.value.map((e: any) => {
                const lvl: any = e.lvl.value;
                const id: any = e.id.value;
                return bot.registry.enchantments[id].displayName + ' ' + lvl;
            }).join(' ')}`;
        }
    }
    return text;
}

export async function mineBlockAt(bot: any, x: number, y: number, z: number): Promise<boolean> {
    /**
     * 挖掉**指定坐标**的那一格。
     *
     * 为什么需要：`collectBlock` 是"自己找最近的并挖"（中层），`digDown` 只会往下。
     * 模型真机报过这个硬缺口："我在 100 格深的洞里**没有挖掉头顶方块的工具**，
     * 所以搭不了落脚点"——它要的是"挖我指定的那一格"这个原语。
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, y, z, 目标方块坐标。
     * @returns {Promise<boolean>} 挖掉了返回 true。
     **/
    const target: any = bot.blockAt(new Vec3(x, y, z));
    if (!target) {
        log(bot, `(${x},${y},${z}) 读不到方块。`);
        return false;
    }
    if (target.name === 'air' || target.name === 'cave_air' || target.name === 'void_air') {
        log(bot, `(${x},${y},${z}) 是空气，不用挖。`);
        return false;
    }
    const dist: number = bot.entity.position.distanceTo(target.position);
    if (dist > 4.5) {
        log(bot, `${target.name} @(${x},${y},${z}) 离你 ${dist.toFixed(1)} 格，够不着（最多 4.5）。先走过去，或者用 placeBlock 搭个脚点。`);
        return false;
    }
    try {
        // 尽力换上合适的工具；换不上也让 dig 自己试（原版手也能挖土/木）。
        try { await bot.tool?.equipForBlock?.(target); } catch { /* best-effort */ }
        await bot.dig(target);
        log(bot, `挖掉了 ${target.name} @(${x},${y},${z})。`);
        return true;
    } catch (err: unknown) {
        log(bot, `挖 ${target.name} @(${x},${y},${z}) 失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

export async function digDown(bot: any, distance: number = 10): Promise<boolean> {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    const start_block_pos: any = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock: any = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock: any = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' ||
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`);
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            console.log(targetBlock.position);
            continue;
        }

        const dug: boolean = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot: any): Promise<boolean> {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos: any = bot.entity.position;
    for (let y = 360; y > -64; y--) { // probably not the best way to find the surface but it works
        const block: any = bot.blockAt(new (Vec3 as any)(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        // **把结果如实返回**。原来这里无条件 log 'Going to the surface' + return true——
        // 模型真机报过 'goToSurface 静默结束：无结果事件、人没动'：它以为上去了，其实
        // 一步没动，后面的判断全建立在错误前提上。
        const arrived = await goToPosition(bot, block.position.x, block.position.y + 1, block.position.z, 0);
        if (!arrived) {
            log(
                bot,
                `Surface is at y=${y + 1} (${block.name}) but I could not get up there from here. 竖井/洞穴里常这样——用 mineBlock 挖头顶开路，或者 placeBlock 搭落脚点一段段往上。`,
            );
            return false;
        }
        log(bot, `Reached the surface at y=${y + 1}.`);
        return true;
    }
    return false;
}

export async function useToolOn(bot: any, toolName: string, targetName: string): Promise<boolean> {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    // NOTE: `!bot.game.gameMode === 'creative'` is preserved verbatim from the JS
    // original (it evaluates `(!gameMode) === 'creative'`, always false); the cast
    // only silences TS2367 without changing runtime behavior.
    if (!bot.inventory.slots.find((slot: any) => slot && slot.name === toolName) && (((!bot.game.gameMode) as unknown as string) === 'creative')) {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped: boolean = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity: any = world.getNearestEntityWhere(bot, (e: any) => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped: boolean = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block: any;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            const blocks: any[] = world.getNearestBlocksWhere(bot, (block: any) => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

  export async function useToolOnBlock(bot: any, toolName: string, block: any): Promise<boolean> {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance: number = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = (): boolean => {
        const blockInView: any = bot.blockAtCursor(5);
        const headPos: any = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView &&
            !blockInView.position.equals(block.position) &&
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    };
    const blockInView: any = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos: any = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blocked: any = bot.blockAtCursor(5);
            log(bot, `Block ${blocked.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped: boolean = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        // **必须验证**：`activateItem` 只是发一个"用物品"包，服务端采不采纳要看
        // 十字准星是否真的对着目标。模型真机报过"连续两次 useOn(水桶, water)，
        // 回执都是 Used bucket on water，但背包里还是空桶"——原来这里无条件
        // log 成功 + return true，等于假成功，把整个下界门计划卡死了。
        const before: number = (world.getInventoryCounts(bot) as Record<string, number>)[toolName] ?? 0;
        await bot.activateItem();
        await new Promise((resolve) => setTimeout(resolve, 350));
        const after: number = (world.getInventoryCounts(bot) as Record<string, number>)[toolName] ?? 0;
        if (after >= before) {
            log(
                bot,
                `对 ${block.name} 用了 ${toolName}，但物品没变化——准星多半没真的对着它（或者够不着/被方块挡住）。往目标挪近、正对着再来一次。`,
            );
            return false;
        }
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }
