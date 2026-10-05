import fs from 'fs';
import path from 'path';
import {proceduralGeneration} from "../../src/agent/tasks/construction_tasks.js";

//note 'main' (script to run generation of tasks) is at bottom of page

interface BlueprintLevel {
    placement: string[][];
    coordinates?: unknown;
    [key: string]: unknown;
}

interface BlueprintLike {
    levels: BlueprintLevel[];
    [key: string]: unknown;
}

/**
 * Helper function to initalize agent inventories
 * @param blueprint
 * @param agents
 * @param evenlySplit - When true, splits materials evenly across inventories
 * @returns {{}}
 */
function createInitialInventory(
    blueprint: BlueprintLike,
    agents: number,
    evenlySplit = true
): Record<number, Record<string, number>> {
    const inventories: Record<number, Record<string, number>> = {};
    const materialCounts: Record<string, number> = {};
    let currentAgent = 0;

    // Initialize inventories
    for (let i = 0; i < agents; i++) {
        inventories[i] = {'diamond_pickaxe': 1};
    }

    // Count materials in blueprint and replace ladder variants with "ladder"
    for (const level of blueprint.levels) {
        for (let rowIndex = 0; rowIndex < level.placement.length; rowIndex++) {
            const row = level.placement[rowIndex] as string[];
            for (let blockIndex = 0; blockIndex < row.length; blockIndex++) {
                const block = row[blockIndex] as string;

                if (block !== 'air') {
                    // Check if material contains 'door' or 'ladder' and convert appropriately
                    let materialKey = block;
                    if (block.includes('dark_oak_door')) {
                        materialKey = 'dark_oak_door';
                    } else if (block.includes('oak_door')) {
                        materialKey = 'oak_door';
                    } else if (block.includes('ladder')) {
                        materialKey = 'ladder';
                        row[blockIndex] = 'ladder'; // Replace in blueprint
                    }

                    materialCounts[materialKey] = (materialCounts[materialKey] ?? 0) + 1;
                }
            }
        }
    }

    if (evenlySplit) {
        // Distribute materials evenly among agents
        for (const [material, count] of Object.entries(materialCounts)) {
            const baseAmount = Math.floor(count / agents);
            const remainder = count % agents;

            // Give each agent the base amount
            for (let i = 0; i < agents; i++) {
                (inventories[i] as Record<string, number>)[material] = baseAmount;
            }

            // Distribute remainder one by one to agents
            for (let i = 0; i < remainder; i++) {
                const inv = inventories[i] as Record<string, number>;
                inv[material] = ((inv[material] ?? 0) + 1);
            }
        }
    } else {
        // Original distribution - one material type to one agent
        for (const [material, count] of Object.entries(materialCounts)) {
            (inventories[currentAgent] as Record<string, number>)[material] = count;
            currentAgent = (currentAgent + 1) % agents;
        }
    }

    for (let i = 0; i < agents; i++) {
        (inventories[i] as Record<string, number>)['dirt'] = 128;
    }

    return inventories;
}

/**
 * Helper function to allocate space for the blueprint based on the number of rooms
 * @param rooms
 * @returns {number}
 */
function calculateSpaceNeeded(rooms: number): number {
    const baseSize = 10;
    const scaleFactor = Math.floor(rooms / 4) * 5;
    return baseSize + scaleFactor;
}

/**
 * MAIN GENERATION FUNCTION
 *
 * Varies agents, materials, room count, windows and carpets to create different complexities of construction tasks.
 * @param variants is the number of variants within each complexity level you want.
 * @returns The tasks as nested JSON {{}}
 */
function generateConstructionTasks(variants: number, agents: number): Record<string, unknown> {
    const materialLevels = 5;
    const roomCounts = [4, 6, 8];
    const windowStyles = [0, 1, 2];
    const carpetStyles = [0, 1, 2];
    const timeout = 600; // 10 min base

    const tasks: Record<string, unknown> = {};

    for (let m = 0; m < materialLevels; m++) {
        for (let r = 0; r < roomCounts.length; r++) {
            for (let w = 0; w < windowStyles.length; w++) {
                for (let c = 0; c < carpetStyles.length; c++) {
                        for (let variant = 0; variant < variants; variant++) {

                            const rooms = roomCounts[r] as number;
                            const spaceSize = calculateSpaceNeeded(rooms);

                            const blueprint = proceduralGeneration(
                                spaceSize,
                                spaceSize,
                                spaceSize,
                                rooms,
                                5,
                                5,
                                4,
                                5,
                                "air",
                                carpetStyles[c] as number,
                                windowStyles[w] as number,
                                m + 1
                            );

                            const taskName = `materials_${m}_rooms_${r}_window_${w}_carpet_${c}_variant_${variant}`;

                            tasks[taskName] = {
                                type: "construction",
                                goal: "Make a house with the blueprint",
                                conversation: "Let's share materials and make a house with the blueprint",
                                agent_count: agents,
                                initial_inventory: createInitialInventory(blueprint, agents),
                                timeout: timeout + (300 * r), // 5 minute per additional level of complexity
                                blueprint: blueprint,

                            };
                        }

                }
            }
        }
    }

    return tasks;
}


// const fs = require('fs');
// const path = require('path');

// Function to create directories and generate tasks
function setupTaskFiles(baseDirs: string[], agentCounts: number[], variants: number): void {
    baseDirs.forEach(base => {
        if (!fs.existsSync(base)) {
            fs.mkdirSync(base, { recursive: true });
        }

        agentCounts.forEach(count => {
            const tasks = generateConstructionTasks(variants, count);
            const filePath = path.join(base, `${count}agents.json`);

            fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2));
            console.log(`Generated tasks saved to ${filePath}`);
        });
    });
}

const baseDirs = ['./train', './test'];
const agentCounts = [2, 3, 4, 5];
const variants = 5;

setupTaskFiles(baseDirs, agentCounts, variants);
