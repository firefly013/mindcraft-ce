import { Vec3 } from 'vec3';
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { blockSatisfied, getTypeOfGeneric, rotateXZ } from './utils.js';

export interface BuildGoalResult {
  missing: Record<string, number>;
  acted: boolean;
  position: any;
  orientation: number;
}

export interface ConstructionGoal {
  blocks: string[][][];
  offset: number;
}

export class BuildGoal {
    agent: any;
    constructor(agent: any) {
        this.agent = agent;
    }

    async wrapSkill(func: () => Promise<void>): Promise<boolean> {
        if (!this.agent.isIdle())
            return false;
        const res: any = await this.agent.actions.runAction('BuildGoal', func);
        return !res.interrupted;
    }

    async executeNext(goal: ConstructionGoal, position: any = null, orientation: number | null = null): Promise<BuildGoalResult> {
        const sizex: number = goal.blocks[0]![0]!.length;
        const sizez: number = goal.blocks[0]!.length;
        const sizey: number = goal.blocks.length;
        if (!position) {
            for (let x = 0; x < sizex - 1; x++) {
                position = world.getNearestFreeSpace(this.agent.bot, sizex - x, 16);
                if (position) break;
            }
        }
        let orient: number;
        if (orientation === null) {
            orient = Math.floor(Math.random() * 4);
        } else {
            orient = orientation;
        }

        const inventory: Record<string, number> = world.getInventoryCounts(this.agent.bot);
        const missing: Record<string, number> = {};
        let acted = false;
        for (let y = goal.offset; y < sizey+goal.offset; y++) {
            for (let z = 0; z < sizez; z++) {
                for (let x = 0; x < sizex; x++) {

                    const [rx, rz]: [number, number] = rotateXZ(x, z, orient, sizex, sizez);
                    const ry: number = y - goal.offset;
                    const block_name: string = goal.blocks[ry]![rz]![rx] as string;
                    if (block_name === null || block_name === '') continue;

                    const world_pos: any = new (Vec3 as any)(position.x + x, position.y + y, position.z + z);
                    const current_block: any = this.agent.bot.blockAt(world_pos);

                    let res: boolean | null;
                    if (current_block !== null && !blockSatisfied(block_name, current_block)) {
                        acted = true;

                        if (current_block.name !== 'air') {
                            res = await this.wrapSkill(async () => {
                                await skills.breakBlockAt(this.agent.bot, world_pos.x, world_pos.y, world_pos.z);
                            });
                            if (!res) return {missing: missing, acted: acted, position: position, orientation: orient};
                        }

                        if (block_name !== 'air') {
                            const block_typed: string = getTypeOfGeneric(this.agent.bot, block_name);
                            if ((inventory[block_typed] as number | undefined ?? 0) > 0) {
                                res = await this.wrapSkill(async () => {
                                    await skills.placeBlock(this.agent.bot, block_typed, world_pos.x, world_pos.y, world_pos.z);
                                });
                                if (!res) return {missing: missing, acted: acted, position: position, orientation: orient};
                            } else {
                                if (missing[block_typed] === undefined)
                                    missing[block_typed] = 0;
                                (missing[block_typed] as number)++;
                            }
                        }
                    }
                }
            }
        }
        return {missing: missing, acted: acted, position: position, orientation: orient};
    }

}
