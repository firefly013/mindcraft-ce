import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getPosition } from '../library/world.js';
import { ConstructionTaskValidator, Blueprint } from './construction_tasks.js';
import { CookingTaskInitiator } from './cooking_tasks.js';
import { MESSAGES } from '../../prompts.js';

const PROGRESS_FILE = './hells_kitchen_progress.json';

interface HellsKitchenProgress {
  taskId: string | null;
  agent0Complete: boolean;
  agent1Complete: boolean;
}

const hellsKitchenProgressManager = {
  readProgress(): HellsKitchenProgress {
    try {
      if (existsSync(PROGRESS_FILE)) {
        const data = readFileSync(PROGRESS_FILE, 'utf8');
        return JSON.parse(data) as HellsKitchenProgress;
      }
    } catch (err) {
      console.error('Error reading progress file:', err);
    }
    return { taskId: null, agent0Complete: false, agent1Complete: false };
  },

  writeProgress(progress: HellsKitchenProgress): void {
    try {
      writeFileSync(PROGRESS_FILE, JSON.stringify(progress), 'utf8');
    } catch (err) {
      console.error('Error writing progress file:', err);
    }
  },

  resetTask(taskId: string): HellsKitchenProgress {
    const progress: HellsKitchenProgress = { taskId, agent0Complete: false, agent1Complete: false };
    this.writeProgress(progress);
    return progress;
  },

  updateAgentProgress(
    taskId: string,
    agentId: number,
    isComplete: boolean,
  ): HellsKitchenProgress {
    const progress = this.readProgress();

    // If it's a different task, reset first
    if (progress.taskId !== taskId) {
      progress.taskId = taskId;
      progress.agent0Complete = false;
      progress.agent1Complete = false;
    }

    // Update the specific agent's status
    if (agentId === 0) progress.agent0Complete = isComplete;
    if (agentId === 1) progress.agent1Complete = isComplete;

    this.writeProgress(progress);
    return progress;
  },

  isTaskComplete(taskId: string): boolean {
    const progress = this.readProgress();
    if (progress.taskId !== taskId) return false;
    return progress.agent0Complete && progress.agent1Complete;
  },
};

//todo: modify validator code to return an object with valid and score -> do more testing hahah
//todo: figure out how to log these things to the same place as bots/histories
// export class CraftTaskValidator {
//     constructor(data, agent) {
//         this.target = data.target;
//         this.number_of_target = data.number_of_target;
//         this.agent = agent;

/** Task data shapes vary per task type; fields are optional by design. */
export interface TaskData {
  task_id: string;
  type: string;
  goal: string | Record<string, string>;
  timeout?: number;
  blueprint?: unknown;
  blocked_actions?: Record<string, string[]>;
  restrict_to_inventory?: boolean;
  target?: string | string[] | Record<string, number>;
  number_of_target?: number | Record<string, number>;
  human_count: number;
  usernames: string[];
  agent_count: number;
  initial_inventory?: Record<string, Record<string, number>>;
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  score: number;
}

export interface ItemCheckResult {
  success: boolean;
  missingItems: Array<{ item: string; required: number; current: number; missing: number }>;
  error?: string;
  agentComplete?: boolean;
}

/**
 * Validates the presence of required items in an agent's inventory
 */
function checkItemPresence(
  data: TaskData,
  agent: any,  
): ItemCheckResult & { agentComplete?: boolean } {
  try {
    // Special handling for hells_kitchen tasks
    if (
      data.task_id &&
      data.task_id.endsWith('hells_kitchen') &&
      Array.isArray(data.target) &&
      data.target.length === 2
    ) {
      // Get agent ID and target for this agent
      const agentId: number = agent.count_id;

      if (agentId === 0 || agentId === 1) {
        // Use only the corresponding element from the target list
        const targetForThisAgent = (data.target as string[])[agentId] as string;
        const modifiedData: TaskData = {
          ...data,
          target: targetForThisAgent,
        };

        // Check if this agent has their required item
        const agentResult = checkItemForSingleAgent(modifiedData, agent);

        // Update the file-based progress tracker
        const progress = hellsKitchenProgressManager.updateAgentProgress(
          data.task_id,
          agentId,
          agentResult.success,
        );

        // Return combined result - success only if both agents have their items
        return {
          success: progress.agent0Complete && progress.agent1Complete,
          missingItems: agentResult.missingItems,
          agentComplete: agentResult.success, // Individual agent status for debugging
        };
      }
    }

    // Non-hells_kitchen tasks use the standard check
    return checkItemForSingleAgent(data, agent);
  } catch (error) {
    console.error('Error checking item presence:', error);
    return {
      success: false,
      missingItems: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Helper function to check a single agent's inventory
 * Extracted from the original checkItemPresence logic
 */
function checkItemForSingleAgent(data: TaskData, agent: any): ItemCheckResult {
  function isTargetDictionaryWithQuantities(target: unknown): boolean {
    return (
      typeof target === 'object' &&
      !Array.isArray(target) &&
      target !== null &&
      Object.values(target as Record<string, unknown>).every((value) => typeof value === 'number')
    );
  }

  function normalizeTargets(target: TaskData['target']): Record<string, number> {
    if (typeof target === 'string') {
      return { [target]: 1 };
    } else if (Array.isArray(target)) {
      return target.reduce<Record<string, number>>((acc, item) => {
        acc[item] = 1;
        return acc;
      }, {});
    } else if (typeof target === 'object' && target !== null) {
      return target as Record<string, number>;
    }
    throw new Error('Invalid target format');
  }

  function normalizeQuantities(
    targets: Record<string, number>,
    quantities: TaskData['number_of_target'],
  ): Record<string, number> {
    if (quantities === undefined) {
      return Object.keys(targets).reduce<Record<string, number>>((acc, key) => {
        acc[key] = 1;
        return acc;
      }, {});
    } else if (typeof quantities === 'number') {
      return Object.keys(targets).reduce<Record<string, number>>((acc, key) => {
        acc[key] = quantities;
        return acc;
      }, {});
    } else if (typeof quantities === 'object' && quantities !== null) {
      return quantities as Record<string, number>;
    }
    throw new Error('Invalid number_of_target format');
  }

  // First normalize targets to always have a consistent format
  const targets = normalizeTargets(data.target);

  // Determine the required quantities
  const requiredQuantities: Record<string, number> = isTargetDictionaryWithQuantities(data.target)
    ? (data.target as Record<string, number>)
    : normalizeQuantities(targets, data.number_of_target);

  // Count items in inventory
  const inventoryCount: Record<string, number> = {};
  agent.bot.inventory.slots.forEach((slot: { name: string; count: number } | null) => {
    if (slot) {
      const itemName = slot.name.toLowerCase();
      inventoryCount[itemName] = (inventoryCount[itemName] || 0) + slot.count;
    }
  });

  // Check if all required items are present in sufficient quantities
  const missingItems: ItemCheckResult['missingItems'] = [];
  let allTargetsMet = true;

  for (const [item, requiredCount] of Object.entries(requiredQuantities)) {
    const itemName = item.toLowerCase();
    const currentCount = inventoryCount[itemName] || 0;
    if (currentCount < (requiredCount as number)) {
      allTargetsMet = false;
      missingItems.push({
        item: itemName,
        required: requiredCount as number,
        current: currentCount,
        missing: (requiredCount as number) - currentCount,
      });
    }
  }

  return {
    success: allTargetsMet,
    missingItems: missingItems,
  };
}

class CookingCraftingTaskValidator {
  private data: TaskData;
  private agent: any;  

  constructor(data: TaskData, agent: any) {
    this.data = data;
    this.agent = agent;
  }
  validate(): ValidationResult {
    const result = checkItemPresence(this.data, this.agent);
    let score = 0;
    if (result.success) {
      score = 1;
    }
    return {
      valid: result.success,
      score: score,
    };
  }
}

export interface TaskDone {
  message: string;
  score: number;
}

export class Task {
  agent: any;  
  data: TaskData | null = null;
  taskStartTime: number;
  validator:
    | ConstructionTaskValidator
    | CookingCraftingTaskValidator
    | null = null;
  reset_function: null = null;
  blocked_actions: string[] = [];
  task_data: TaskData | null;
  task_id?: string;
  task_type?: string;
  blueprint?: Blueprint;
  goal?: string | null;
  taskTimeout?: number;
  restrict_to_inventory?: boolean;
  name: string;
  initiator?: CookingTaskInitiator | null;

  constructor(agent: any, task_data: TaskData | null, taskStartTime: number | null = null) {
    this.agent = agent;
    this.data = null;
    if (taskStartTime !== null) this.taskStartTime = taskStartTime;
    else this.taskStartTime = Date.now();
    this.validator = null;
    this.reset_function = null;
    this.blocked_actions = [];
    this.task_data = task_data;
    if (task_data) {
      console.log('Starting task', task_data.task_id);
      console.log('Task start time set to', this.taskStartTime);
      if (task_data.task_id.endsWith('hells_kitchen')) {
        // Reset hells_kitchen progress when a new task starts
        hellsKitchenProgressManager.resetTask(task_data.task_id);
        console.log('Reset Hells Kitchen progress for new task');
      }
      this.data = task_data;
      this.task_type = this.data.type;
      if (this.task_type === 'construction' && this.data.blueprint) {
        this.blueprint = new Blueprint(this.data.blueprint);
        this.goal =
          this.data.goal +
          ' \n' +
          this.blueprint.explain() +
          ' \n' +
          'make sure to place the lower levels of the blueprint first';
      } else {
        this.goal = this.data.goal as string;
      }
      this.taskTimeout = (this.data.timeout as number) || 300;
      // Set validator based on task_type

      // do goal initialization here

      if (this.task_type === 'construction') {
        this.validator = new ConstructionTaskValidator(this.data, this.agent);
      } else if (this.task_type === 'cooking' || this.task_type === 'techtree') {
        this.validator = new CookingCraftingTaskValidator(this.data, this.agent);
      } else {
        this.validator = null;
      }

      if (this.data.blocked_actions) {
        this.blocked_actions =
          this.data.blocked_actions[this.agent.count_id.toString()] || [];
      } else {
        this.blocked_actions = [];
      }
      this.restrict_to_inventory = !!this.data.restrict_to_inventory;
    } else {
      console.log('No task.');
    }

    this.name = this.agent.name;
  }

  // Add this method if you want to manually reset the hells_kitchen progress
  resetHellsKitchenProgress(): void {
    if (this.task_id && this.task_id.endsWith('hells_kitchen')) {
      hellsKitchenProgressManager.resetTask(this.task_id);
      console.log('Hells Kitchen progress reset manually');
    }
  }

  getAgentGoal(): string | null {
    if (!this.data || !this.data.goal) {
      return null;
    }

    let add_string = '';

    if (this.task_type === 'cooking') {
      if (this.data.task_id && this.data.task_id.endsWith('hells_kitchen')) {
        add_string = '';
      } else {
        add_string = '\nIn the end, all the food items should be given to one single bot.';
      }
    }

    // If goal is a string, all agents share the same goal
    if (typeof this.data.goal === 'string') {
      return this.data.goal + add_string;
    }

    // If goal is an object, get the goal for this agent's count_id
    if (typeof this.data.goal === 'object' && this.data.goal !== null) {
      const agentId = this.agent.count_id.toString();
      return ((this.data.goal as Record<string, string>)[agentId] || '') + add_string;
    }

    return null;
  }

  isDone(): TaskDone | false {
    let res: ValidationResult | null = null;
    if (this.validator) res = this.validator.validate();
    if (res && res.valid) {
      return { message: 'Task successful', score: res.score };
    }
    const elapsedTime = (Date.now() - this.taskStartTime) / 1000;

    if (this.taskTimeout) {
      if (elapsedTime >= this.taskTimeout) {
        console.log('Task timeout reached. Task unsuccessful.');
        if (res) {
          return { message: 'Task timeout reached', score: res.score };
        } else {
          return { message: 'Task timeout reached', score: 0 };
        }
      }
    }
    return false;
  }

  async setAgentGoal(): Promise<void> {
    const agentGoal = this.getAgentGoal();
    if (!agentGoal) return;
    const msg = MESSAGES.taskGoal(agentGoal);
    console.log(`Setting goal for agent ${this.agent.count_id}: ${agentGoal}`);
    // 无 goal 模式：目标作为系统消息进入 ReAct 循环，做到 Finish 为止
    await this.agent.handleMessage('system', msg);
  }

  async initBotTask(): Promise<void> {
    await this.agent.bot.chat(`/clear ${this.name}`);
    console.log(`Cleared ${this.name}'s inventory.`);

    //wait for a bit so inventory is cleared
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (this.data === null) return;

    if (this.task_type === 'cooking') {
      this.initiator = new CookingTaskInitiator(this.data, this.agent.bot);
    } else {
      this.initiator = null;
    }

    //wait for a bit so bots are teleported
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (this.agent.count_id === 0 && (this.data.human_count as number) > 0) {
      console.log('Clearing human player inventories');
      for (let i = 0; i < (this.data.human_count as number); i++) {
        const username = (this.data.usernames as string[])[i] as string;
        await this.agent.bot.chat(`/clear ${username}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.data.initial_inventory) {
      console.log('Setting inventory...');
      const initialInventory: Record<string, number> =
        (this.data.initial_inventory as Record<string, Record<string, number>>)[
          this.agent.count_id.toString()
        ] || {};
      console.log('Initial inventory for agent', this.agent.count_id, ':', initialInventory);
      console.log('');

      if ((this.data.human_count as number) > 0 && this.agent.count_id === 0) {
        // this.num_humans = num_keys - this.data.num_agents;
        if (this.data.human_count !== (this.data.usernames as string[]).length) {
          console.log(
            `Number of human players ${this.data.human_count} does not match the number of usernames provided. ${(this.data.usernames as string[]).length}`,
          );
          throw new Error(
            `Number of human players ${this.data.human_count} does not match the number of usernames provided. ${(this.data.usernames as string[]).length}`,
          );
        }

        const starting_idx = this.data.agent_count as number;
        for (let i = 0; i < (this.data.human_count as number); i++) {
          const username = (this.data.usernames as string[])[i] as string;
          const inventory = (
            this.data.initial_inventory as unknown as Array<Record<string, number>>
          )[starting_idx + i] as Record<string, number>;
          console.log(Object.keys(inventory));
          for (const key of Object.keys(inventory)) {
            const itemName = key.toLowerCase();
            const quantity = inventory[key] as number;
            console.log(`Give ${username} ${quantity} ${itemName}`);
            await this.agent.bot.chat(`/give ${username} ${itemName} ${quantity}`);
          }
        }
      }
      console.log(this.data.initial_inventory);

      // Assign inventory items
      for (const key of Object.keys(initialInventory)) {
        const itemName = key.toLowerCase();
        const quantity = initialInventory[key] as number;
        await this.agent.bot.chat(`/give ${this.name} ${itemName} ${quantity}`);
        console.log(`Gave ${this.name} ${quantity} ${itemName}`);
      }

      // Wait briefly for inventory commands to complete
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (this.initiator && this.agent.count_id === 0) {
      await this.initiator.init();
    }

    await this.teleportBots();

    await new Promise((resolve) => setTimeout(resolve, 500));
    await this.setAgentGoal();
  }

  async teleportBots(): Promise<void> {
    console.log('\n\nTeleporting bot');
    function getRandomOffset(range: number): number {
      return Math.floor(Math.random() * (range * 2 + 1)) - range;
    }

    const bot: any = this.agent.bot;  

    // Finding if there is a human player on the server
    let human_player_name: string | null = null;
    for (const playerName in bot.players) {
      if (playerName === this.name) continue;
      const player = bot.players[playerName];
      console.log('Found human player:', player.username);
      human_player_name = player.username;
      break;
    }

    // go to the human if there is one
    if (human_player_name) {
      console.log(`Teleporting ${this.name} to human ${human_player_name}`);
      bot.chat(`/tp ${this.name} ${human_player_name}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    // now all bots are teleport on top of each other (which kinda looks ugly)
    // Thus, we need to teleport them to random distances to make it look better

    /*
        Note : We don't want randomness for construction task as the reference point matters a lot.
        Another reason for no randomness for construction task is because, often times the user would fly in the air,
        then set a random block to dirt and teleport the bot to stand on that block for starting the construction,
        */

    if ((this.data as TaskData).type !== 'construction') {
      const pos = getPosition(bot);
      const xOffset = getRandomOffset(5);
      const zOffset = getRandomOffset(5);
      bot.chat(`/tp ${this.name} ${Math.floor(pos.x + xOffset)} ${pos.y + 3} ${Math.floor(pos.z + zOffset)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if ((this.data as TaskData).type === 'construction') {
      //Ensures construction is cleaned out first. -> relies on cheats which are turned off?
      if (this.blueprint) {
        console.log('Cleaning out construction blueprint');
        const result = this.blueprint.autoDelete();
        const commands = result.commands;
        const nearbyPosition = result.nearbyPosition;
        console.log('nearby position', nearbyPosition);
        const first_coord = (this.data as TaskData & { blueprint: { levels: Array<{ coordinates: number[] }> } }).blueprint.levels[0].coordinates;
        bot.chat(`/tp @a ${first_coord[0]} ${first_coord[1]} ${first_coord[2]}`);
        if (this.agent.agent_id === 0 && (this.data as TaskData).human_count > 0) {
          for (let i = 0; i < ((this.data as TaskData).human_count as number); i++) {
            const username = ((this.data as TaskData).usernames as string[])[i] as string;
            await bot.chat(`/tp ${username} ${nearbyPosition.x} ${nearbyPosition.y} ${nearbyPosition.z}`);
          }
        }
        for (const command of commands) {
          bot.chat(command);
        }
      } else {
        console.log('no construction blueprint?');
      }
    }
  }
}
