import { getPosition } from "../library/world.js";

export interface Region {
  type: string;
  width: number;
  depth: number;
}

interface OccupiedRegion {
  xMin: number;
  xMax: number;
  zMin: number;
  zMax: number;
}

interface RegionStart {
  xStart: number;
  zStart: number;
}

export class CookingTaskInitiator {
    bot: any;
    data: any;

    constructor(data: any, bot: any) {
        this.bot = bot;
        this.data = data;
    }

    async init(): Promise<void> {
        const bot: any = this.bot;

        //// Setting up the cooking world using minecraft cheats ////

        // Only run the setup if the agent is the first one

        // Clear and prepare the base area
        await bot.chat(`/fill ~ ~-1 ~ ~50 ~-3 ~50 grass_block`);
        await bot.chat(`/fill ~ ~-1 ~ ~-50 ~-3 ~50 grass_block`);
        await bot.chat(`/fill ~ ~-1 ~ ~-50 ~-3 ~-50 grass_block`);
        await bot.chat(`/fill ~ ~-1 ~ ~50 ~-3 ~-50 grass_block`);
        await bot.chat(`/fill ~ ~ ~ ~50 ~10 ~50 air`);
        await bot.chat(`/fill ~ ~ ~ ~-50 ~10 ~50 air`);
        await bot.chat(`/fill ~ ~ ~ ~-50 ~10 ~-50 air`);
        await bot.chat(`/fill ~ ~ ~ ~50 ~10 ~-50 air`);
        console.log("Base area cleared and prepared.");

        const position: any = getPosition(bot);
        const botX: number = Math.floor(position.x);
        const botZ: number = Math.floor(position.z);

        // Region management system
        const isOverlapping = (newXMin: number, newXMax: number, newZMin: number, newZMax: number, occupiedRegions: OccupiedRegion[]): boolean => {
            for (const region of occupiedRegions) {
                if (newXMin < region.xMax && newXMax > region.xMin &&
                    newZMin < region.zMax && newZMax > region.zMin) {
                    return true;
                }
            }
            return false;
        };

        const findValidPosition = (width: number, depth: number, occupiedRegions: OccupiedRegion[]): RegionStart => {
            const maxXStart: number = position.x + 25 - width;  // Constrain to 50x50 area
            const minXStart: number = position.x - 25;
            const maxZStart: number = position.z + 25 - depth;
            const minZStart: number = position.z - 25;

            let attempts = 0;
            while (attempts < 10000) {
                const xStart: number = Math.floor(minXStart + Math.random() * (maxXStart - minXStart + 1));
                const zStart: number = Math.floor(minZStart + Math.random() * (maxZStart - minZStart + 1));
                const xMin = xStart;
                const xMax = xStart + width - 1;
                const zMin = zStart;
                const zMax = zStart + depth - 1;

                if (!isOverlapping(xMin, xMax, zMin, zMax, occupiedRegions)) {
                    return { xStart, zStart };
                }
                attempts++;
            }
            throw new Error('Failed to find non-overlapping position after 1000 attempts');
        };

        // Define all regions with their sizes
        const regionsToPlace: Region[] = [
            { type: 'wheat', width: 3, depth: 3 },
            { type: 'beetroots', width: 3, depth: 3 },
            { type: 'mushrooms', width: 3, depth: 3 },
            { type: 'potatoes', width: 3, depth: 3 },
            { type: 'carrots', width: 3, depth: 3 },
            { type: 'sugar_cane', width: 3, depth: 3 },
            { type: 'sugar_cane', width: 3, depth: 3 },
            { type: 'pumpkins', width: 5, depth: 1 },
            { type: 'house', width: 11, depth: 11 }
        ];

        // Expand the regions of each type to make sure they don't overlap

        for (let i = 0; i < regionsToPlace.length; i++) {
            const region: Region = regionsToPlace[i] as Region;
            const { width, depth } = region;
            regionsToPlace[i]!.width = width + 4;
            regionsToPlace[i]!.depth = depth + 4;
        }

        const occupiedRegions: OccupiedRegion[] = [{
            xMin : botX - 1,
            xMax : botX + 1,
            zMin : botZ - 1,
            zMax : botZ + 1
        }];
        const regionPositions: Record<string, RegionStart | RegionStart[]> = {};

        // Calculate positions for all regions
        for (const region of regionsToPlace) {
            const { xStart, zStart } = findValidPosition(region.width, region.depth, occupiedRegions);

            occupiedRegions.push({
                xMin: xStart,
                xMax: xStart + region.width - 1,
                zMin: zStart,
                zMax: zStart + region.depth - 1
            });

            if (region.type === 'sugar_cane') {
                if (!regionPositions.sugar_cane) regionPositions.sugar_cane = [];
                (regionPositions.sugar_cane as RegionStart[]).push({ xStart, zStart });
            } else {
                regionPositions[region.type] = { xStart, zStart };
            }
        }

        // Execute all planting
        // await plantWheat(regionPositions.wheat.xStart, regionPositions.wheat.zStart);
        await this.plantCrops((regionPositions.wheat as RegionStart).xStart, (regionPositions.wheat as RegionStart).zStart, 'wheat[age=7]', true);
        await this.plantCrops((regionPositions.beetroots as RegionStart).xStart, (regionPositions.beetroots as RegionStart).zStart, 'beetroots[age=3]', true);
        await this.plantMushrooms((regionPositions.mushrooms as RegionStart).xStart, (regionPositions.mushrooms as RegionStart).zStart);
        await new Promise(resolve => setTimeout(resolve, 300));
        await this.plantCrops((regionPositions.potatoes as RegionStart).xStart, (regionPositions.potatoes as RegionStart).zStart, 'potatoes[age=7]', true);
        await this.plantCrops((regionPositions.carrots as RegionStart).xStart, (regionPositions.carrots as RegionStart).zStart, 'carrots[age=7]', true);
        await this.plantCrops((regionPositions.pumpkins as RegionStart).xStart, (regionPositions.pumpkins as RegionStart).zStart, 'pumpkin', false);
        await this.plantSugarCane(regionPositions.sugar_cane as RegionStart[]);
        await new Promise(resolve => setTimeout(resolve, 300));
        console.log("planted crops!");
        // await plantPumpkins(regionPositions.pumpkins.xStart, regionPositions.pumpkins.zStart);
        // await new Promise(resolve => setTimeout(resolve, 300));


        await this.buildHouse((regionPositions.house as RegionStart).xStart, (regionPositions.house as RegionStart).zStart);

        console.log("House built!");

        // Add a chest with cooking items near the bot
        // const addChestWithItems = async () => {
        //     // Find a valid position near the bot (within 10 blocks)
        //     const findChestPosition = () => {
        //         const maxAttempts = 100;
        //         for (let attempt = 0; attempt < maxAttempts; attempt++) {
        //             const x = botX + Math.floor(Math.random() * 10 - 5); // Within ±5 blocks X
        //             const z = botZ + Math.floor(Math.random() * 10 - 5); // Within ±5 blocks Z
        //             const y = position.y;

        //             // Check if the position is not overlapping with existing structures
        //             if (!isOverlapping(x, x, z, z, occupiedRegions)) {
        //                 return { x, y, z };
        //             }
        //         }
        //         throw new Error('Failed to find valid chest position');
        //     };

        //     const { x, y, z } = findChestPosition();

        //     // Place the chest
        //     await bot.chat(`/setblock ${x} ${y} ${z} chest`);

            const cookingItems: [string, number][] = [
                ['minecraft:milk_bucket', 1],     // Non-stackable
                ['minecraft:egg', 16],            // Stacks to 16
                ['minecraft:dandelion', 64],    // Stacks to 64
                ['minecraft:sugar', 64],
                ['minecraft:cocoa_beans', 64],
                ['minecraft:apple', 64],
                ['minecraft:milk_bucket', 1],
                ['minecraft:milk_bucket', 1],
                ['minecraft:salmon', 64],
                ['minecraft:cod', 64],
                ['minecraft:kelp', 64],
                ['minecraft:dried_kelp', 64],
                ['minecraft:sweet_berries', 64],
                ['minecraft:honey_bottle', 1],     // Non-stackable
                ['minecraft:glow_berries', 64],
                ['minecraft:bowl', 64],
                ['minecraft:milk_bucket', 1],
                ['minecraft:milk_bucket', 1],
                ['minecraft:milk_bucket', 1],
                ['minecraft:milk_bucket', 1],
                ['minecraft:cooked_salmon', 64],
                ['minecraft:cooked_cod', 64],
                ['minecraft:gold_ingot', 64],
                ['minecraft:oak_planks', 64],
                ['minecraft:iron_ingot', 64],
                ['minecraft:milk_bucket', 1],
                ['minecraft:milk_bucket', 1],
            ];
            void cookingItems;

        //     // Fill the chest with random cooking items
        //     for (let slot = 0; slot < cookingItems.length; slot++) { // Chest has 27 slots
        //         const randomItem = cookingItems[slot];
        //         await bot.chat(`/item replace block ${x} ${y} ${z} container.${slot} with ${randomItem[0]} ${randomItem[1]}`);
        //     }

        //     // Mark the chest area as occupied
        //     occupiedRegions.push({
        //         xMin: x,
        //         xMax: x,
        //         zMin: z,
        //         zMax: z
        //     });
        // };

        // await addChestWithItems();
        await new Promise(resolve => setTimeout(resolve, 300));

        const animals: string[] = ['chicken', 'cow', 'llama', 'mooshroom', 'pig', 'rabbit', 'sheep'];

        // Animal management
        await this.killEntities(["item"]);
        await this.killEntities(animals);
        await this.killEntities(["item"]);

        console.log("killed entities!");

        await new Promise(resolve => setTimeout(resolve, 300));

        // Summon new animals

        await this.summonAnimals(animals, 8);
        console.log("summoned animals!");
    }

    async plantCrops(xStart: number, zStart: number, crop_and_age: string, till: boolean = true): Promise<void> {
        const position: any = getPosition(this.bot);
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) {
                const x: number = xStart + i;
                const z: number = zStart + j;
                if (till) {
                    await this.bot.chat(`/setblock ${x} ${position.y - 1} ${z} farmland`);
                }
                await this.bot.chat(`/setblock ${x} ${position.y} ${z} ${crop_and_age}`);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    async plantSugarCane(patches: RegionStart[]): Promise<void> {
        const position: any = getPosition(this.bot);
        for (const patch of patches) {
            const xCenter: number = patch.xStart + 1;
            const zCenter: number = patch.zStart + 1;
            await this.bot.chat(`/setblock ${xCenter} ${position.y - 1} ${zCenter} water`);
            const offsets: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const [dx, dz] of offsets) {
                await this.bot.chat(`/setblock ${xCenter + dx} ${position.y} ${zCenter + dz} sugar_cane[age=15]`);
            }
        }
    }

    async plantMushrooms(xStart: number, zStart: number): Promise<void> {
        const position: any = getPosition(this.bot);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 5; j++) {
                const x: number = xStart + i;
                const z: number = zStart + j;
                await this.bot.chat(`/setblock ${x} ${position.y - 1} ${z} mycelium`);
                const mushroomType: string = (i + j) % 2 === 0 ? 'red_mushroom' : 'brown_mushroom';
                await this.bot.chat(`/setblock ${x} ${position.y} ${z} ${mushroomType}`);
            }
        }
    }

    async summonAnimals(animals: string[], amount: number): Promise<void> {
        const position: any = getPosition(this.bot);
        for (const animal of animals) {
            for (let i = 0; i < amount; i++) {
                const x: number = position.x - 25 + Math.random() * 50;
                const z: number = position.z - 25 + Math.random() * 50;
                await this.bot.chat(`/summon ${animal} ${Math.floor(x)} ${position.y} ${Math.floor(z)}`);
            }
        }
    }

    async killEntities(entities: string[]): Promise<void> {
        for (const entity of entities) {
            await this.bot.chat(`/kill @e[type=${entity},distance=..200]`);
        }
    }

    async buildHouse(xStart: number, zStart: number): Promise<void> {
        const position: any = getPosition(this.bot);
        const startX: number = xStart;
        const startY: number = position.y;
        const startZ: number = zStart;
        const width = 10;
        const depth = 10;
        const height = 5;

        // Foundation and walls
        for (let x = startX; x <= startX + depth; x++) {
            for (let y = startY; y <= startY + height; y++) {
                for (let z = startZ; z <= startZ + width; z++) {
                    if (y === startY) {
                        if (!(x === startX + depth - 1 && z === startZ + Math.floor(width / 2))) {
                            await this.bot.chat(`/setblock ${x} ${y} ${z} stone_bricks`);
                        }
                        continue;
                    }

                    if (x === startX || x === startX + depth ||
                        z === startZ || z === startZ + width ||
                        y === startY + height) {

                        const isWindow: boolean = (
                            (x === startX || x === startX + depth) &&
                            (z === startZ + 3 || z === startZ + width - 3) &&
                            (y === startY + 2 || y === startY + 3)
                        ) || (
                            (z === startZ || z === startZ + width) &&
                            (x === startX + 3 || x === startX + depth - 3) &&
                            (y === startY + 2 || y === startY + 3)
                        );

                        const isDoor: boolean = x === startX + depth &&
                                        z === startZ + Math.floor(width / 2) &&
                                        (y === startY + 1 || y === startY + 2);

                        if (!isWindow && !isDoor) {
                            await this.bot.chat(`/setblock ${x} ${y} ${z} stone_bricks`);
                        }
                    }
                }
            }
        }

        // Entrance features
        const doorZ: number = startZ + Math.floor(width / 2);
        await this.bot.chat(`/setblock ${startX + depth - 1} ${startY} ${doorZ} stone_brick_stairs[facing=west]`);
        await this.bot.chat(`/setblock ${startX + depth} ${startY} ${doorZ} air`);
        // await bot.chat(`/setblock ${startX + depth - 1} ${startY} ${doorZ - 1} stone_bricks`);
        // await bot.chat(`/setblock ${startX + depth - 1} ${startY} ${doorZ + 1} stone_bricks`);
        // await bot.chat(`/setblock ${startX + depth} ${startY} ${doorZ} oak_door[half=lower,hinge=left,facing=west,powered=false]`);
        // await bot.chat(`/setblock ${startX + depth} ${startY + 1} ${doorZ} oak_door[half=upper,hinge=left,facing=west,powered=false]`);

        // Roof construction
        for (let i = 0; i < 3; i++) {
            for (let x = startX + i; x <= startX + depth - i; x++) {
                for (let z = startZ + i; z <= startZ + width - i; z++) {
                    if (x === startX + i || x === startX + depth - i ||
                        z === startZ + i || z === startZ + width - i) {
                        await this.bot.chat(`/setblock ${x} ${startY + height + i} ${z} cobblestone`);
                    }
                }
            }
        }

        // Interior items
        await this.bot.chat(`/setblock ${startX + 4} ${startY + 1} ${startZ + 3} crafting_table`);
        await this.bot.chat(`/setblock ${startX + 4} ${startY + 1} ${startZ + 5} furnace`);
        // Add fuel to the furnace
        await this.bot.chat(`/data merge block ${startX + 4} ${startY + 1} ${startZ + 5} {Items:[{Slot:1b,id:"minecraft:coal",Count:64b}]}`);
        await this.bot.chat(`/setblock ${startX + 4} ${startY + 1} ${startZ + 7} smoker`);
        // Add fuel to the smoker
        await this.bot.chat(`/data merge block ${startX + 4} ${startY + 1} ${startZ + 7} {Items:[{Slot:1b,id:"minecraft:coal",Count:64b}]}`);
        await this.bot.chat(`/setblock ${startX + depth - 3} ${startY + 1} ${startZ + 2} bed`);
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}
