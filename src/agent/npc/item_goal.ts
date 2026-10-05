import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { itemSatisfied } from './utils.js';


const blacklist: string[] = [
    'coal_block',
    'iron_block',
    'gold_block',
    'diamond_block',
    'deepslate',
    'blackstone',
    'netherite',
    '_wood',
    'stripped_',
    'crimson',
    'warped',
    'dye'
];

export interface RecipeChild {
  node: ItemWrapper;
  quantity: number;
}

export interface NextInfo {
  node: ItemNode;
  quantity: number;
}


class ItemNode {
    manager: any;
    wrapper: ItemWrapper | null;
    name: string;
    type: string;
    source: string | null;
    prereq: ItemWrapper | null;
    recipe: RecipeChild[];
    fails: number;

    constructor(manager: any, wrapper: ItemWrapper | null, name: string) {
        this.manager = manager;
        this.wrapper = wrapper;
        this.name = name;
        this.type = '';
        this.source = null;
        this.prereq = null;
        this.recipe = [];
        this.fails = 0;
    }

    setRecipe(recipe: Record<string, number>): ItemNode {
        this.type = 'craft';
        let size = 0;
        this.recipe = [];
        for (const [key, value] of Object.entries(recipe)) {
            if (this.manager.nodes[key] === undefined)
                this.manager.nodes[key] = new ItemWrapper(this.manager, this.wrapper, key);
            this.recipe.push({node: this.manager.nodes[key] as ItemWrapper, quantity: value});
            size += value;
        }
        if (size > 4) {
            if (this.manager.nodes['crafting_table'] === undefined)
                this.manager.nodes['crafting_table'] = new ItemWrapper(this.manager, this.wrapper, 'crafting_table');
            this.prereq = this.manager.nodes['crafting_table'] as ItemWrapper;
        }
        return this;
    }

    setCollectable(source: string | null = null, tool: string | null = null): ItemNode {
        this.type = 'block';
        if (source)
            this.source = source;
        else
            this.source = this.name;
        if (tool) {
            if (this.manager.nodes[tool] === undefined)
                this.manager.nodes[tool] = new ItemWrapper(this.manager, this.wrapper, tool);
            this.prereq = this.manager.nodes[tool] as ItemWrapper;
        }
        return this;
    }

    setSmeltable(source_item: string): ItemNode {
        this.type = 'smelt';
        if (this.manager.nodes['furnace'] === undefined)
            this.manager.nodes['furnace'] = new ItemWrapper(this.manager, this.wrapper, 'furnace');
        this.prereq = this.manager.nodes['furnace'] as ItemWrapper;

        if (this.manager.nodes[source_item] === undefined)
            this.manager.nodes[source_item] = new ItemWrapper(this.manager, this.wrapper, source_item);
        if (this.manager.nodes['coal'] === undefined)
            this.manager.nodes['coal'] = new ItemWrapper(this.manager, this.wrapper, 'coal');
        this.recipe = [
            {node: this.manager.nodes[source_item] as ItemWrapper, quantity: 1},
            {node: this.manager.nodes['coal'] as ItemWrapper, quantity: 1}
        ];
        return this;
    }

    setHuntable(animal_source: string): ItemNode {
        this.type = 'hunt';
        this.source = animal_source;
        return this;
    }

    getChildren(): RecipeChild[] {
        const children: RecipeChild[] = [...this.recipe];
        if (this.prereq) {
            children.push({node: this.prereq, quantity: 1});
        }
        return children;
    }

    isReady(): boolean {
        for (const child of this.getChildren()) {
            if (!child.node.isDone(child.quantity)) {
                return false;
            }
        }
        return true;
    }

    isDone(quantity: number = 1): boolean {
        if (this.manager.goal.name === this.name)
            return false;
        return itemSatisfied(this.manager.agent.bot, this.name, quantity);
    }

    getDepth(q: number = 1): number {
        if (this.isDone(q)) {
            return 0;
        }
        let depth = 0;
        for (const child of this.getChildren()) {
            depth = Math.max(depth, child.node.getDepth(child.quantity));
        }
        return depth + 1;
    }

    getFails(q: number = 1): number {
        if (this.isDone(q)) {
            return 0;
        }
        let fails = 0;
        for (const child of this.getChildren()) {
            fails += child.node.getFails(child.quantity);
        }
        return fails + this.fails;
    }

    getNext(q: number = 1): NextInfo | null {
        if (this.isDone(q))
            return null;
        if (this.isReady())
            return {node: this, quantity: q};
        for (const child of this.getChildren()) {
            const res: NextInfo | null = child.node.getNext(child.quantity);
            if (res)
                return res;
        }
        return null;
    }

    async execute(quantity: number = 1): Promise<void> {
        if (!this.isReady()) {
            this.fails += 1;
            return;
        }
        const inventory: Record<string, number> = world.getInventoryCounts(this.manager.agent.bot);
        const init_quantity: number = inventory[this.name] || 0;
        if (this.type === 'block') {
            await skills.collectBlock(this.manager.agent.bot, this.source as string, quantity, this.manager.agent.npc.getBuiltPositions());
        } else if (this.type === 'smelt') {
            const to_smelt_name: string = this.recipe[0]!.node.name;
            const to_smelt_quantity: number = Math.min(quantity, inventory[to_smelt_name] || 1);
            await skills.smeltItem(this.manager.agent.bot, to_smelt_name, to_smelt_quantity);
        } else if (this.type === 'hunt') {
            for (let i=0; i<quantity; i++) {
                // NOTE: original code assigned to an undeclared `res` global here;
                // declared locally to satisfy strict mode without behavior change.
                const res: boolean | void = await skills.attackNearest(this.manager.agent.bot, this.source as string);
                if (!res || this.manager.agent.bot.interrupt_code)
                    break;
            }
        } else if (this.type === 'craft') {
            await skills.craftRecipe(this.manager.agent.bot, this.name, quantity);
        }
        const final_quantity: number = world.getInventoryCounts(this.manager.agent.bot)[this.name] || 0;
        if (final_quantity <= init_quantity) {
            this.fails += 1;
        }
    }
}


class ItemWrapper {
    manager: any;
    name: string;
    parent: ItemWrapper | null;
    methods: ItemNode[];

    constructor(manager: any, parent: ItemWrapper | null, name: string) {
        this.manager = manager;
        this.name = name;
        this.parent = parent;
        this.methods = [];

        let blacklisted = false;
        for (const match of blacklist) {
            if (name.includes(match)) {
                blacklisted = true;
                break;
            }
        }

        if (!blacklisted && !this.containsCircularDependency()) {
            this.createChildren();
        }
    }

    add_method(method: ItemNode): void {
        for (const child of method.getChildren()) {
            if (child.node.methods.length === 0)
                return;
        }
        this.methods.push(method);
    }

    createChildren(): void {
        const recipes: Record<string, number>[] = (mc as any).getItemCraftingRecipes(this.name).map(([recipe, _craftedCount]: [Record<string, number>, number]) => recipe);
        if (recipes) {
            for (const recipe of recipes) {
                let includes_blacklisted = false;
                for (const ingredient in recipe) {
                    for (const match of blacklist) {
                        if (ingredient.includes(match)) {
                            includes_blacklisted = true;
                            break;
                        }
                    }
                    if (includes_blacklisted) break;
                }
                if (includes_blacklisted) continue;
                this.add_method(new ItemNode(this.manager, this, this.name).setRecipe(recipe));
            }
        }

        const block_sources: string[] = (mc as any).getItemBlockSources(this.name) as string[];
        if (block_sources.length > 0 && this.name !== 'torch' && !this.name.includes('bed')) {  // Do not collect placed torches or beds
            for (const block_source of block_sources) {
                if (block_source === 'grass_block') continue;  // Dirt nodes will collect grass blocks
                const tool: string | null = (mc as any).getBlockTool(block_source) as string | null;
                this.add_method(new ItemNode(this.manager, this, this.name).setCollectable(block_source, tool));
            }
        }

        const smeltingIngredient: string | null = (mc as any).getItemSmeltingIngredient(this.name) as string | null;
        if (smeltingIngredient) {
            this.add_method(new ItemNode(this.manager, this, this.name).setSmeltable(smeltingIngredient));
        }

        const animal_source: string | null = (mc as any).getItemAnimalSource(this.name) as string | null;
        if (animal_source) {
            this.add_method(new ItemNode(this.manager, this, this.name).setHuntable(animal_source));
        }
    }

    containsCircularDependency(): boolean {
        let p: ItemWrapper | null = this.parent;
        while (p) {
            if (p.name === this.name) {
                return true;
            }
            p = p.parent;
        }
        return false;
    }

    getBestMethod(q: number = 1): ItemNode | null {
        let best_cost = -1;
        let best_method: ItemNode | null = null;
        for (const method of this.methods) {
            const cost: number = method.getDepth(q) + method.getFails(q);
            if (best_cost == -1 || cost < best_cost) {
                best_cost = cost;
                best_method = method;
            }
        }
        return best_method;
    }

    isDone(q: number = 1): boolean {
        if (this.methods.length === 0)
            return false;
        return (this.getBestMethod(q) as ItemNode).isDone(q);
    }

    getDepth(q: number = 1): number {
        if (this.methods.length === 0)
            return 0;
        return (this.getBestMethod(q) as ItemNode).getDepth(q);
    }

    getFails(q: number = 1): number {
        if (this.methods.length === 0)
            return 0;
        return (this.getBestMethod(q) as ItemNode).getFails(q);
    }

    getNext(q: number = 1): NextInfo | null {
        if (this.methods.length === 0)
            return null;
        return (this.getBestMethod(q) as ItemNode).getNext(q);
    }
}

export { ItemWrapper };


export class ItemGoal {
    agent: any;
    goal: ItemWrapper | null;
    nodes: Record<string, ItemWrapper>;
    failed: string[];

    // NOTE: controller.js calls `new ItemGoal(agent, this.data)`; the second
    // argument is accepted and ignored to preserve that call site.
    constructor(agent: any, _data?: any) {
        void _data;
        this.agent = agent;
        this.goal = null;
        this.nodes = {};
        this.failed = [];
    }

    async executeNext(item_name: string, item_quantity: number = 1): Promise<boolean> {
        if (this.nodes[item_name] === undefined)
            this.nodes[item_name] = new ItemWrapper(this, null, item_name);
        this.goal = this.nodes[item_name] as ItemWrapper;

        // Get next goal to execute
        const next_info: NextInfo | null = (this.goal as ItemWrapper).getNext(item_quantity);
        if (!next_info) {
            console.log(`Invalid item goal ${(this.goal as ItemWrapper).name}`);
            return false;
        }
        const next: ItemNode = next_info.node;
        const quantity: number = next_info.quantity;

        // Prevent unnecessary attempts to obtain blocks that are not nearby
        if (next.type === 'block' && !world.getNearbyBlockTypes(this.agent.bot).includes(next.source as string) ||
                next.type === 'hunt' && !world.getNearbyEntityTypes(this.agent.bot).includes(next.source as string)) {
            next.fails += 1;

            // If the bot has failed to obtain the block before, explore
            if (this.failed.includes(next.name)) {
                this.failed = this.failed.filter((item: string) => item !== next.name);
                await this.agent.actions.runAction('itemGoal:explore', async () => {
                    await skills.moveAway(this.agent.bot, 8);
                });
            } else {
                this.failed.push(next.name);
                await new Promise((resolve) => setTimeout(resolve, 500));
                this.agent.bot.emit('idle');
            }
            return false;
        }

        // Wait for the bot to be idle before attempting to execute the next goal
        if (!this.agent.isIdle())
            return false;

        // Execute the next goal
        const init_quantity: number = world.getInventoryCounts(this.agent.bot)[next.name] || 0;
        await this.agent.actions.runAction('itemGoal:next', async () => {
            await next.execute(quantity);
        });
        const final_quantity: number = world.getInventoryCounts(this.agent.bot)[next.name] || 0;

        // Log the result of the goal attempt
        if (final_quantity > init_quantity) {
            console.log(`Successfully obtained ${next.name} for goal ${(this.goal as ItemWrapper).name}`);
        } else {
            console.log(`Failed to obtain ${next.name} for goal ${(this.goal as ItemWrapper).name}`);
        }
        return final_quantity > init_quantity;
    }
}
