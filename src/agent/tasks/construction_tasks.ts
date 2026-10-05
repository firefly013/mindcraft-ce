import {Vec3} from 'vec3';

export type BlueprintLevel = {
  level: number;
  coordinates: [number, number, number];
  placement: string[][];
};

export type BlueprintData = {
  levels: BlueprintLevel[];
  materials?: Record<string, number>;
};

export interface BlockCheck {
  level: number;
  coordinates: [number, number, number];
  expected: string;
  actual: string;
}

export interface BlueprintCheckResult {
  mismatches: BlockCheck[];
  matches: BlockCheck[];
}

export class ConstructionTaskValidator {
    blueprint: Blueprint;
    agent: any;

    constructor(data: any, agent: any) {
        this.blueprint = new Blueprint(data.blueprint as BlueprintData);
        this.agent = agent;
    }
    validate(): { valid: boolean; score: number } {
        try {
            //todo: somehow make this more of a percentage or something
            // console.log('Validating task...');
            let valid = false;
            let score = 0;
            const result: BlueprintCheckResult = this.blueprint.check(this.agent.bot);
            if (result.mismatches.length === 0) {
                valid = true;
                console.log('Task is complete');
            }
            const total_blocks: number = result.mismatches.length + result.matches.length;
            score = total_blocks === 0 ? 100 : (result.matches.length / total_blocks) * 100;
            console.log(`Task score: ${score}%`);
            return {
                "valid": valid,
                "score": score
            };
        } catch (error: unknown) {
            console.error('Error validating task:', error);
            return {
                "valid": false,
                "score": 0
            };
        }
    }
}

export function resetConstructionWorld(bot: any, blueprint: BlueprintData): void {
    console.log('Resetting world...');
    const starting_position: [number, number, number] = blueprint.levels[0].coordinates;
    const length: number = blueprint.levels[0].placement.length + 5;
    const height: number = blueprint.levels.length + 5;
    const width: number = blueprint.levels[0].placement[0].length + 5;
    const command: string = `/fill ${starting_position[0]} ${starting_position[1]} ${starting_position[2]} ${starting_position[0] + width} ${starting_position[1] + height} ${starting_position[2] + length} air`;
    bot.chat(command);
    console.log('World reset');
}

export function checkLevelBlueprint(agent: any, levelNum: number): string {
    const blueprint: Blueprint = agent.task.blueprint;
    const bot: any = agent.bot;
    const result: BlueprintCheckResult | false = blueprint.checkLevel(bot, levelNum);
    if ((result as BlueprintCheckResult).mismatches.length === 0) {
        return `Level ${levelNum} is correct`;
    } else {
        const explanation: string = blueprint.explainLevelDifference(bot, levelNum);
        return explanation;
    }
}

export function checkBlueprint(agent: any): string {
    console.log('Checking blueprint...');
    console.log(agent);
    const blueprint: Blueprint = agent.task.blueprint;
    const bot: any = agent.bot;
    const result: BlueprintCheckResult = blueprint.check(bot);
    if (result.mismatches.length === 0) {
        return "Blueprint is correct";
    } else {
        const explanation: string = blueprint.explainBlueprintDifference(bot);
        return explanation;
    }
}

export class Blueprint {
    data: BlueprintData;

    constructor(blueprint: any) {
        this.data = blueprint as BlueprintData;
    }
    explain(): string {
        let explanation = "";

        for (const item of this.data.levels) {
            const coordinates: [number, number, number] = item.coordinates;
            explanation += `Level ${item.level}: `;
            explanation += `Start at coordinates X: ${coordinates[0]}, Y: ${coordinates[1]}, Z: ${coordinates[2]}`;
            // let placement_string = this._getPlacementString(item.placement);
            // explanation += `\n${placement_string}\n`;
        }
        return explanation;
    }
    _getPlacementString(placement: string[][]): string {
        let placement_string = "[\n";
        for (const row of placement) {
            placement_string += "[";
            for (let i = 0; i < row.length - 1; i++) {
                const item: string = row[i] as string;
                placement_string += `${item}, `;
            }
            const final_item: string = row[row.length - 1] as string;
            placement_string += `${final_item}],\n`;
        }
        placement_string += "]";
        return placement_string;
    }
    explainLevel(levelNum: number): string {
        const levelData: BlueprintLevel = this.data.levels[levelNum] as BlueprintLevel;
        let explanation = `Level ${levelData.level} `;
        explanation += `starting at coordinates X: ${levelData.coordinates[0]}, Y: ${levelData.coordinates[1]}, Z: ${levelData.coordinates[2]}`;
        const placement_string: string = this._getPlacementString(levelData.placement);
        explanation += `\n${placement_string}\n`;
        return explanation;
    }
    explainBlueprintDifference(bot: any): string {
        let explanation = "";
        const levels: BlueprintLevel[] = this.data.levels;
        for (let i = 0; i < levels.length; i++) {
            const level_explanation: string = this.explainLevelDifference(bot, i);
            explanation += level_explanation + "\n";
        }
        return explanation;
    }
    explainLevelDifference(bot: any, levelNum: number): string {
        const results: BlueprintCheckResult = this.checkLevel(bot, levelNum) as BlueprintCheckResult;
        const mismatches: BlockCheck[] = results.mismatches;
        const levelData: BlueprintLevel = this.data.levels[levelNum] as BlueprintLevel;

        if (mismatches.length === 0) {
            return `Level ${levelData.level} is complete`;
        }
        let explanation = `Level ${levelData.level} `;
        // explanation += `at coordinates X: ${levelData.coordinates[0]}, Y: ${levelData.coordinates[1]}, Z: ${levelData.coordinates[2]}`;
        explanation += " requires the following fixes:\n";
        for (const item of mismatches) {
            if (item.actual === 'air') {
                explanation += `Place ${item.expected} at coordinates X: ${item.coordinates[0]}, Y: ${item.coordinates[1]}, Z: ${item.coordinates[2]}\n`;
            } else if (item.expected === 'air') {
                explanation += `Remove the ${item.actual} at coordinates X: ${item.coordinates[0]}, Y: ${item.coordinates[1]}, Z: ${item.coordinates[2]}\n`;
            } else {
                explanation += `Replace the ${item.actual} with a ${item.expected} at coordinates X: ${item.coordinates[0]}, Y: ${item.coordinates[1]}, Z: ${item.coordinates[2]} \n`;
            }
        }
        return explanation;
    }
    check(bot: any): BlueprintCheckResult {
        if (!bot || typeof bot !== 'object' || !Object.hasOwn(bot, 'blockAt')) {
            throw new Error('Invalid bot object. Expected a mineflayer bot.');
        }
        const levels: BlueprintLevel[] = this.data.levels;
        const mismatches: BlockCheck[] = [];
        const matches: BlockCheck[] = [];
        for (let i = 0; i < levels.length; i++) {
            // Preserves original behavior: checkLevel can return `false` on
            // block-read errors (callers would throw); cast keeps it compiling.
            const result: BlueprintCheckResult = this.checkLevel(bot, i) as BlueprintCheckResult;
            mismatches.push(...result.mismatches);
            matches.push(...result.matches);
        }
        return {
            "mismatches": mismatches,
            "matches": matches
        };
    }
    checkLevel(bot: any, levelNum: number): BlueprintCheckResult | false {
        const levelData: BlueprintLevel = this.data.levels[levelNum] as BlueprintLevel;
        const startCoords: [number, number, number] = levelData.coordinates;
        const placement: string[][] = levelData.placement;
        const mismatches: BlockCheck[] = [];
        const matches: BlockCheck[] = [];

        for (let zOffset = 0; zOffset < placement.length; zOffset++) {
            const row: string[] = placement[zOffset] as string[];
            for (let xOffset = 0; xOffset < row.length; xOffset++) {
                const blockName: string = row[xOffset] as string;

                const x: number = startCoords[0] + xOffset;
                const y: number = startCoords[1];
                const z: number = startCoords[2] + zOffset;

                try {
                    const blockAtLocation: any = bot.blockAt(new (Vec3 as any)(x, y, z));
                    const actualBlockName: string = blockAtLocation ? bot.registry.blocks[blockAtLocation.type].name : "air";

                    // Skip if both expected and actual block are air
                    if (blockName === "air" && actualBlockName === "air") {
                        continue;
                    }

                    if (actualBlockName !== blockName) {
                        mismatches.push({
                            level: levelData.level,
                            coordinates: [x, y, z],
                            expected: blockName,
                            actual: actualBlockName
                        });
                    } else {
                        matches.push({
                            level: levelData.level,
                            coordinates: [x, y, z],
                            expected: blockName,
                            actual: actualBlockName
                        });
                    }
                } catch (err: unknown) {
                    console.error(`Error getting block at (${x}, ${y}, ${z}):`, err);
                    return false; // Stop checking if there's an issue getting blocks
                }
            }
        }
        return {
            "mismatches": mismatches,
            "matches": matches
        };
    }

    /**
     * Takes in the blueprint, and then converts it into a set of /setblock commands for the bot to follow
     * @Returns: An object containing the setblock commands as a list of strings, and a position nearby the blueprint but not in it
     * @param blueprint
     */
    autoBuild(): { commands: string[]; nearbyPosition: { x: number; y: number; z: number } } {
        const commands: string[] = [];
        const blueprint: BlueprintData = this.data;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (const level of blueprint.levels) {
            console.log(level.level);
            const baseX: number = level.coordinates[0];
            const baseY: number = level.coordinates[1];
            const baseZ: number = level.coordinates[2];
            const placement: string[][] = level.placement;

            // Update bounds
            minX = Math.min(minX, baseX);
            maxX = Math.max(maxX, baseX + placement[0].length - 1);
            minY = Math.min(minY, baseY);
            maxY = Math.max(maxY, baseY);
            minZ = Math.min(minZ, baseZ);
            maxZ = Math.max(maxZ, baseZ + placement.length - 1);

            // Loop through the 2D placement array
            for (let z = 0; z < placement.length; z++) {
                for (let x = 0; x < placement[z].length; x++) {
                    const blockType: string = placement[z][x] as string;
                    if (blockType) {
                        const setblockCommand: string = `/setblock ${baseX + x} ${baseY} ${baseZ + z} ${blockType}`;
                        commands.push(setblockCommand);
                    }
                }
            }
        }

        // Calculate a position nearby the blueprint but not in it
        const nearbyPosition = {
            x: maxX + 5, // Move 5 blocks to the right
            y: minY,     // Stay on the lowest level of the blueprint
            z: minZ      // Stay aligned with the front of the blueprint
        };

        return { commands, nearbyPosition };
    }


    /**
     * Takes in a blueprint, and returns a set of commands to clear up the space.
     *
     */
    autoDelete(): { commands: string[]; nearbyPosition: { x: number; y: number; z: number } } {
        console.log("auto delete called");
        const commands: string[] = [];
        const blueprint: BlueprintData = this.data;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (const level of blueprint.levels) {
            const baseX: number = level.coordinates[0];
            const baseY: number = level.coordinates[1];
            const baseZ: number = level.coordinates[2];
            const placement: string[][] = level.placement;

            // Update bounds
            minX = Math.min(minX, baseX);
            maxX = Math.max(maxX, baseX + placement[0].length - 1);
            minY = Math.min(minY, baseY);
            maxY = Math.max(maxY, baseY);
            minZ = Math.min(minZ, baseZ);
            maxZ = Math.max(maxZ, baseZ + placement.length - 1);

            // Loop through the 2D placement array
            for (let z = 0; z < placement.length; z++) {
                for (let x = 0; x < placement[z].length; x++) {
                    const blockType: string = placement[z][x] as string;
                    if (blockType) {
                        const setblockCommand: string = `/setblock ${baseX + x} ${baseY} ${baseZ + z} air`;
                        commands.push(setblockCommand);
                    }
                }
            }
        }

        // Calculate a position nearby the blueprint but not in it
        const nearbyPosition = {
            x: maxX + 5, // Move 5 blocks to the right
            y: minY,     // Stay on the lowest level of the blueprint
            z: minZ      // Stay aligned with the front of the blueprint
        };

        return { commands, nearbyPosition };
    }
}