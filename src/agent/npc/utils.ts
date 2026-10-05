import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';


export function getTypeOfGeneric(bot: any, block_name: string): string {
    // Get type of wooden block
    if ((mc as any).MATCHING_WOOD_BLOCKS.includes(block_name)) {

        // Return most common wood type in inventory
        const type_count: Record<string, number> = {};
        let max_count = 0;
        let max_type: string | null = null;
        const inventory: Record<string, number> = world.getInventoryCounts(bot);
        for (const item in inventory) {
            for (const wood of (mc as any).WOOD_TYPES as string[]) {
                if (item.includes(wood)) {
                    if (type_count[wood] === undefined)
                        type_count[wood] = 0;
                    type_count[wood] += inventory[item] as number;
                    if ((type_count[wood] as number) > max_count) {
                        max_count = type_count[wood] as number;
                        max_type = wood;
                    }
                }
            }
        }
        if (max_type !== null)
            return max_type + '_' + block_name;

        // Return nearest wood type
        const log_types: string[] = ((mc as any).WOOD_TYPES as string[]).map((wood: string) => wood + '_log');
        const blocks: any[] = world.getNearestBlocks(bot, log_types, 16, 1);
        if (blocks.length > 0) {
            const wood: string = (blocks[0].name as string).split('_')[0] as string;
            return wood + '_' + block_name;
        }

        // Return oak
        return 'oak_' + block_name;
    }

    // Get type of bed
    if (block_name === 'bed') {

        // Return most common wool type in inventory
        const type_count: Record<string, number> = {};
        let max_count = 0;
        let max_type: string | null = null;
        const inventory: Record<string, number> = world.getInventoryCounts(bot);
        for (const item in inventory) {
            for (const color of (mc as any).WOOL_COLORS as string[]) {
                if (item === color + '_wool') {
                    if (type_count[color] === undefined)
                        type_count[color] = 0;
                    type_count[color] += inventory[item] as number;
                    if ((type_count[color] as number) > max_count) {
                        max_count = type_count[color] as number;
                        max_type = color;
                    }
                }
            }
        }
        if (max_type !== null)
            return max_type + '_' + block_name;

        // Return white
        return 'white_' + block_name;
    }
    return block_name;
}


export function blockSatisfied(target_name: string, block: any): boolean {
    if (target_name == 'dirt') {
        return block.name == 'dirt' || block.name == 'grass_block';
    } else if (((mc as any).MATCHING_WOOD_BLOCKS as string[]).includes(target_name)) {
        return (block.name as string).endsWith(target_name);
    } else if (target_name == 'bed') {
        return (block.name as string).endsWith('bed');
    } else if (target_name == 'torch') {
        return (block.name as string).includes('torch');
    }
    return block.name == target_name;
}


export function itemSatisfied(bot: any, item: string, quantity: number = 1): boolean {
    const qualifying: string[] = [item];
    if (item.includes('pickaxe') ||
            item.includes('axe') ||
            item.includes('shovel') ||
            item.includes('hoe') ||
            item.includes('sword')) {
        const material: string = item.split('_')[0] as string;
        const type: string = item.split('_')[1] as string;
        if (material === 'wooden') {
            qualifying.push('stone_' + type);
            qualifying.push('iron_' + type);
            qualifying.push('gold_' + type);
            qualifying.push('diamond_' + type);
        } else if (material === 'stone') {
            qualifying.push('iron_' + type);
            qualifying.push('gold_' + type);
            qualifying.push('diamond_' + type);
        } else if (material === 'iron') {
            qualifying.push('gold_' + type);
            qualifying.push('diamond_' + type);
        } else if (material === 'gold') {
            qualifying.push('diamond_' + type);
        }
    }
    for (const q of qualifying) {
        if ((world.getInventoryCounts(bot)[q] as number | undefined ?? 0) >= quantity) {
            return true;
        }
    }
    return false;
}


export function rotateXZ(x: number, z: number, orientation: number, sizex: number, sizez: number): [number, number] {
    if (orientation === 0) return [x, z];
    if (orientation === 1) return [z, sizex-x-1];
    if (orientation === 2) return [sizex-x-1, sizez-z-1];
    if (orientation === 3) return [sizez-z-1, x];
    return [x, z];
}
