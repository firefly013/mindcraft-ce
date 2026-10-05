import { readdirSync, readFileSync } from 'fs';
import { NPCData } from './data.js';
import type { NpcGoal } from './data.js';
import { ItemGoal } from './item_goal.js';
import { BuildGoal } from './build_goal.js';
import type { BuildGoalResult } from './build_goal.js';
import { itemSatisfied, rotateXZ } from './utils.js';
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';

export interface NpcConstruction {
  blocks: string[][][];
  offset: number;
  [key: string]: unknown;
}

export interface BuiltPosition {
  x: number;
  y: number;
  z: number;
}


export class NPCContoller {
    agent: any;
    data: NPCData;
    temp_goals: NpcGoal[];
    item_goal: ItemGoal;
    build_goal: BuildGoal;
    constructions: Record<string, NpcConstruction>;
    last_goals: Record<string, boolean>;

    constructor(agent: any) {
        this.agent = agent;
        this.data = NPCData.fromObject(agent.prompter.profile.npc);
        this.temp_goals = [];
        this.item_goal = new ItemGoal(agent, this.data);
        this.build_goal = new BuildGoal(agent);
        this.constructions = {};
        this.last_goals = {};
    }

    getBuiltPositions(): BuiltPosition[] {
        const positions: BuiltPosition[] = [];
        for (const name in this.data.built) {
            const position: BuiltPosition = this.data.built[name].position;
            const offset: number = this.constructions[name].offset;
            const sizex: number = (this.constructions[name].blocks[0] as string[][])[0].length;
            const sizez: number = (this.constructions[name].blocks[0] as string[][]).length;
            const sizey: number = this.constructions[name].blocks.length;
            for (let y = offset; y < sizey+offset; y++) {
                for (let z = 0; z < sizez; z++) {
                    for (let x = 0; x < sizex; x++) {
                        positions.push({x: position.x + x, y: position.y + y, z: position.z + z});
                    }
                }
            }
        }
        return positions;
    }

    init(): void {
        try {
            for (const file of readdirSync('src/agent/npc/construction')) {
                if (file.endsWith('.json')) {
                    this.constructions[file.slice(0, -5)] = JSON.parse(readFileSync('src/agent/npc/construction/' + file, 'utf8')) as NpcConstruction;
                }
            }
        } catch (e: unknown) {
            console.log('Error reading construction file');
        }

        for (const name in this.constructions) {
            const sizez: number = (this.constructions[name].blocks[0] as string[][]).length;
            const sizex: number = (this.constructions[name].blocks[0] as string[][])[0].length;
            const max_size: number = Math.max(sizex, sizez);
            for (let y = 0; y < this.constructions[name].blocks.length; y++) {
                for (let z = 0; z < max_size; z++) {
                    if (z >= this.constructions[name].blocks[y].length)
                        this.constructions[name].blocks[y].push([]);
                    for (let x = 0; x < max_size; x++) {
                        if (x >= (this.constructions[name].blocks[y] as string[][])[z].length)
                            (this.constructions[name].blocks[y] as string[][])[z].push('');
                    }
                }
            }
        }

        this.agent.bot.on('idle', async () => {
            if (this.data.goals.length === 0 && !this.data.curr_goal) return;
            // Wait a while for inputs before acting independently
            await new Promise((resolve) => setTimeout(resolve, 5000));
            if (!this.agent.isIdle()) return;

            // Persue goal
            if (!this.agent.actions.resume_func) {
                this.executeNext();
                this.agent.history.save();
            }
        });
    }

    async setGoal(name: string | null = null, quantity: number = 1): Promise<void> {
        this.data.curr_goal = null;
        this.last_goals = {};
        if (name) {
            this.data.curr_goal = {name: name, quantity: quantity};
            return;
        }

        if (!this.data.do_set_goal) return;

        const past_goals: Record<string, boolean> = {...this.last_goals};
        // NOTE: preserves the original `for...in` iteration quirk (keys, not
        // elements); the `as any` cast keeps strict-mode compilation without
        // changing runtime behavior.
        for (const goal in this.data.goals) {
            const g = goal as unknown as any;
            if (past_goals[g.name] === undefined) past_goals[g.name] = true;
        }
        const res: any = await this.agent.prompter.promptGoalSetting(this.agent.history.getHistory(), past_goals);
        if (res) {
            this.data.curr_goal = res as NpcGoal;
            console.log('Set new goal: ', res.name, ' x', res.quantity);
        } else {
            console.log('Error setting new goal.');
        }
    }

    async executeNext(): Promise<void> {
        if (!this.agent.isIdle()) return;
        await this.agent.actions.runAction('npc:moveAway', async () => {
            await skills.moveAway(this.agent.bot, 2);
        });

        if (!this.data.do_routine || this.agent.bot.time.timeOfDay < 13000) {
            // Exit any buildings
            const building: string | null = this.currentBuilding();
            if (building == this.data.home) {
                const door_pos: BuiltPosition | null = this.getBuildingDoor(building);
                if (door_pos) {
                    await this.agent.actions.runAction('npc:exitBuilding', async () => {
                        await skills.useDoor(this.agent.bot, door_pos);
                        await skills.moveAway(this.agent.bot, 2); // If the bot is too close to the building it will try to enter again
                    });
                }
            }

            // Work towards goals
            await this.executeGoal();

        } else {
            // Reset goal at the end of the day
            this.data.curr_goal = null;

            // Return to home
            const building: string | null = this.currentBuilding();
            if (this.data.home !== null && (building === null || building != this.data.home)) {
                const door_pos: BuiltPosition | null = this.getBuildingDoor(this.data.home);
                await this.agent.actions.runAction('npc:returnHome', async () => {
                    await skills.useDoor(this.agent.bot, door_pos);
                });
            }

            // Go to bed
            await this.agent.actions.runAction('npc:bed', async () => {
                await skills.goToBed(this.agent.bot);
            });
        }

        if (this.agent.isIdle())
            this.agent.bot.emit('idle');
    }

    async executeGoal(): Promise<void> {
        // If we need more blocks to complete a building, get those first
        let goals: NpcGoal[] = this.temp_goals.concat(this.data.goals);
        if (this.data.curr_goal)
            goals = goals.concat([this.data.curr_goal]);
        this.temp_goals = [];

        let acted = false;
        for (const goal of goals) {

            // Obtain goal item or block
            if (this.constructions[goal.name] === undefined) {
                if (!itemSatisfied(this.agent.bot, goal.name, goal.quantity)) {
                    const res: boolean = await this.item_goal.executeNext(goal.name, goal.quantity);
                    this.last_goals[goal.name] = res;
                    acted = true;
                    break;
                }
            }

            // Build construction goal
            else {
                let res: BuildGoalResult;
                if (Object.hasOwn(this.data.built, goal.name)) {
                    res = await this.build_goal.executeNext(
                        this.constructions[goal.name],
                        this.data.built[goal.name].position,
                        this.data.built[goal.name].orientation
                    );
                } else {
                    res = await this.build_goal.executeNext(this.constructions[goal.name]);
                    this.data.built[goal.name] = {
                        name: goal.name,
                        position: res.position,
                        orientation: res.orientation
                    };
                }
                if (Object.keys(res.missing).length === 0) {
                    this.data.home = goal.name;
                }
                for (const block_name in res.missing) {
                    this.temp_goals.push({
                        name: block_name,
                        quantity: res.missing[block_name] as number
                    });
                }
                if (res.acted) {
                    acted = true;
                    this.last_goals[goal.name] = Object.keys(res.missing).length === 0;
                    break;
                }
            }
        }

        if (!acted && this.data.do_set_goal)
            await this.setGoal();
    }

    currentBuilding(): string | null {
        const bot_pos: any = this.agent.bot.entity.position;
        for (const name in this.data.built) {
            const pos: BuiltPosition = this.data.built[name].position;
            const offset: number = this.constructions[name].offset;
            let sizex: number = (this.constructions[name].blocks[0] as string[][])[0].length;
            let sizez: number = (this.constructions[name].blocks[0] as string[][]).length;
            const sizey: number = this.constructions[name].blocks.length;
            if (this.data.built[name].orientation % 2 === 1) [sizex, sizez] = [sizez, sizex];
            if (bot_pos.x >= pos.x && bot_pos.x < pos.x + sizex &&
                bot_pos.y >= pos.y + offset && bot_pos.y < pos.y + sizey + offset &&
                bot_pos.z >= pos.z && bot_pos.z < pos.z + sizez) {
                return name;
            }
        }
        return null;
    }

    getBuildingDoor(name: string | null): BuiltPosition | null {
        if (name === null) return null;
        const built = this.data.built[name];
        if (built === undefined) return null;
        let door_x: number | null = null;
        let door_z: number | null = null;
        let door_y: number | null = null;
        for (let y = 0; y < this.constructions[name].blocks.length; y++) {
            for (let z = 0; z < (this.constructions[name].blocks[y] as string[][]).length; z++) {
                for (let x = 0; x < (this.constructions[name].blocks[y] as string[][])[z].length; x++) {
                    if ((this.constructions[name].blocks[y] as string[][])[z][x] !== null &&
                        ((this.constructions[name].blocks[y] as string[][])[z][x] as string).includes('door')) {
                        door_x = x;
                        door_z = z;
                        door_y = y;
                        break;
                    }
                }
                if (door_x !== null) break;
            }
            if (door_x !== null) break;
        }
        if (door_x === null) return null;

        const sizex: number = (this.constructions[name].blocks[0] as string[][])[0].length;
        const sizez: number = (this.constructions[name].blocks[0] as string[][]).length;
        let orientation: number = 4 - built.orientation; // this conversion is opposite
        if (orientation == 4) orientation = 0;
        [door_x, door_z] = rotateXZ(door_x, door_z as number, orientation, sizex, sizez);
        door_y = (door_y as number) + this.constructions[name].offset;

        return {
            x: built.position.x + (door_x as number),
            y: built.position.y + (door_y as number),
            z: built.position.z + (door_z as number)
        };
    }
}
