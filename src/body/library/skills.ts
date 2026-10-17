import * as mc from "../data/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
/**
 * ⚠️ **必须读共享单例，不许读根目录那份 `settings.ts`。**
 *
 * 根 `settings.ts` 是**主进程**（MindServer 宿主）的配置字面量；身体进程拿到的是
 * 大脑转交过来的那一份，写在 `shared/settings.ts` 的单例里（`body/index.ts`
 * 的 `setSettings`）。以前这里 import 的是根那份，于是身体里的 `settings.cheat`
 * **永远是 false**——`/setblock`、瞬间放置这些 OP 快捷路径全是死代码，
 * 配了 `"cheat": true` 也不生效，而且没有任何报错。
 */
import settings from "../../shared/settings.js";
import { permits, opContextFor } from "../safety/permits.js";
import { refuseText } from "../safety/dangerous_ops.js";
import {
    blockAtFrom,
    waterUnderFeet,
    headInWater,
    dangerousWaterRefusal,
    type WaterClass,
} from "../safety/water_safety.js";
import { teleportRefusal } from "../safety/dangerous_blocks.js";
import { movementsFor } from "../safety/movements.js";
import { deepWaterAllowed } from "../safety/permits.js";
import { safeguards } from "../safety/safeguards.js";

export function log(bot: any, ...messages: any[]): void {
    bot.output += messages.join(' ') + '\n';
}

/**
 * 危险操作闸门。
 *
 * 默认禁止倒水/倒岩浆/点火/在下界或末地睡觉/进深水；只有三种例外：身上着火
 * （实时判定）、模型用 allowDangerousOps 授权、我们写死的保命代码。判据和记录
 * 全在 dangerous_ops/permits 里，这里只负责"问一句、不让就写回执"。
 *
 * 回执**必须带上怎么授权** —— 这一夜反复证明：把下一步写出来，模型才能自己走得通。
 */
function allowDangerousOp(bot: any, opId: string): boolean {
    const verdict = permits.isAllowed(opId, opContextFor(bot), Date.now());
    if (verdict.allowed) return true;
    log(bot, verdict.op != null ? refuseText(verdict.op) : `默认不允许这个操作（${opId}）。`);
    return false;
}

/** 脚下这滩水的判定（给强制出水和回执用）。 */
export function waterUnderFoot(bot: any): WaterClass {
    return waterUnderFeet(bot);
}

/**
 * 强制出水。
 *
 * 用户的要求是"其他情况，我们得想办法强制出水"——授权只管"模型想不想下去"，
 * 管不了"它已经站在水里了"。所以这里是**我们写死的反射**：发现脚下是危险的水，
 * 自己找岸、自己走上去。
 *
 * 为什么必须走 `bypassFor`：强制出水本身就要**穿过水**才能上岸，而寻路默认不
 * 下水。不给一张短票，这道闸会把自己的保命代码也拦在门外——这正是
 * `bypassFor` 存在的唯一理由，它是这里第一个真实调用者。
 *
 * 票是 30 秒：够走几格上岸，不够的话下一轮又会重新发（幂等，不会累积）。
 */
export async function forceExitWater(bot: any, urgency: 'oxygen-low' | 'drowning' = 'oxygen-low'): Promise<boolean> {
    // **这里不看任何危险操作许可——那是另一个层的闸门。**
    //
    // 分层（用户的原话）：
    // - **危险操作授权**（permits）管"动作能不能**把你带进**危险区"——倒岩浆、
    //   倒水、点火、寻路走深水。它们全在**动作执行前**生效（goToGoal 的目标闸门、
    //   activateItem 前的检查、寻路的 blocksToAvoid）。
    // - **保命**（L5，不经过模型）管"**已经在危险里**"——氧气将尽/开始掉血就接管。
    //   唯一豁免是 `disableSafeguards`（模型签生死状；工具存在但不常用）。
    //
    // prober 实测的死法就是这两层被混用的结果：它授权了 enter_deep_water
    // （为了让寻路走进深水做测试），然后被水淹——旧版这里有一行 `deepWaterAllowed`
    // 检查让保命让位，几百条 contact 伴着 bot.hurt 一路淹死，全程无人上浮。
    // "许可我进去"不等于"淹了别捞我"。
    if (safeguards.isSuppressed(Date.now())) return true;

    const info = waterUnderFeet(bot);
    const head = headInWater(bot);
    // 氧气只在**头**进水时消耗——脚湿、半身在水都没关系。
    if (!info.isWater && !head) return true;
    if (!info.dangerous && !head) return true;         // 1 格深的静水，踩着无所谓

    // **保命策略分两级（按紧迫程度），而不是一步到位乱抢：**
    //
    // ① **先按空格上浮**——最省事，浮起来氧气瞬间回满，什么都不用寻路。
    //    正常的开阔水域这级就解决了。
    // ② **上浮无效才寻路找岸**——头顶封死（被倒了一桶水盖住、在涵洞里）时，
    //    光按空格只能原地浮沉（prober 实测：y 在 60.5↔62.2 反复，x/z 一格不动，
    //    drowning 刷了十几次就是不往岸去），这时候必须**水平移动到没有水的地方**。
    //
    // `urgency` 只影响日志口径：'drowning'（已经开始掉血）说明氧气已耗尽，
    // 是最后的通牒；'oxygen-low' 还有一点点余量。
    if (head) {
        log(
            bot,
            urgency === 'drowning'
                ? '头在水下且正在掉血（溺水，或水下有别的伤害源比如岩浆块）——立刻处理：先上浮，浮不上去就往岸去。'
                : '氧气快用完了（水下待太久）——先上浮换气。',
        );
        const result = await swimToSurface(bot);
        if (result === 'surfaced') {
            log(bot, '头已露出水面。');
            return true;
        }
        if (result === 'slow') {
            // y 还在涨——上浮**有效**，只是深。继续按住空格等它出头，
            // 别切寻路把正在上升的身体拽去水平移动。第二轮总会落到
            // surfaced（出头）或 stuck（y 卡住），不会无限 'slow'。
            log(bot, '还在上浮中（水较深），继续。');
            const second = await swimToSurface(bot);
            if (second === 'surfaced') {
                log(bot, '头已露出水面。');
                return true;
            }
            if (second === 'slow') return true; // 仍在上升，尽力了；外层会继续盯。
            log(bot, '上浮无效：头顶上不去（被水或方块封住了）——改寻路，往没有水的地方去。');
        } else {
            // 'stuck'：y 卡住了——头顶封死，按空格只是原地浮沉。必须水平移动。
            log(bot, '上浮无效：头顶上不去（被水或方块封住了）——改寻路，往没有水的地方去。');
        }
    }
    if (urgency === 'drowning' || head) {
        try {
            bot.pathfinder?.stop?.();   // 打断当前寻路：保命优先于任何目标。
        } catch {
            // 没在寻路就无所谓。
        }
    }

    const pos: any = bot?.entity?.position;
    if (pos == null) return false;
    const at = blockAtFrom(bot);

    // 找最近的落脚点：脚下不是水也不是岩浆，而且它上面两格是空的（站得进去）。
    let land: { x: number; y: number; z: number } | null = null;
    for (let r = 1; r <= 12 && land == null; r++) {
        for (let dx = -r; dx <= r && land == null; dx++) {
            for (let dz = -r; dz <= r && land == null; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                for (let dy = -2; dy <= 3 && land == null; dy++) {
                    const x = Math.floor(pos.x) + dx;
                    const y = Math.floor(pos.y) + dy;
                    const z = Math.floor(pos.z) + dz;
                    const ground = at(x, y, z);
                    if (ground == null) continue;
                    const name = ground.name;
                    if (name === 'water' || name === 'lava' || name === 'air' || name == null) continue;
                    const above = at(x, y + 1, z);
                    const above2 = at(x, y + 2, z);
                    if (above?.name !== 'air' || above2?.name !== 'air') continue;
                    land = { x, y: y + 1, z };
                }
            }
        }
    }

    if (land == null) {
        // **纯水大陆（一眼望不到岸）** —— 这时候正确的目标不是"上岸"，而是
        // **"把头露出水面"**：淹死的条件是头进水，不是身体进水。找不到岸时后者
        // 仍然救得了命。
        //
        // 原来这里做的是"跳 1.5 秒然后松手"，配上外层 2 秒一轮的重试，效果是
        // 机器人**一直在原地上下浮动**，既上不了浮也沉不下去，直到耗死。而且每
        // 一轮都往 `bot.output` 里塞一条，后台调用产生的这些回执模型还不一定看得到。
        log(bot, `脚下是危险的水（${info.reason}），附近 12 格内找不到能上岸的地方——先浮起来把头露出水面。`);
        const floated = await swimToSurface(bot);
        // 'surfaced' = 真活下来了；'slow' = 仍在上升（尽力了）；'stuck' = 没救回来。
        // 返回值喂给外层的失败退避：true 不退避（继续保持浮着盯），false 退 30 秒。
        return floated !== 'stuck';
    }

    permits.bypassFor('enter_deep_water', 30_000, 'forceExitWater: 强制出水', Date.now());
    log(bot, `脚下是危险的水（${info.reason}），自动上岸：${land.x},${land.y},${land.z}。`);
    try {
        bot.pathfinder?.stop?.();
    } catch {
        // 没在寻路就无所谓。
    }
    return await goToGoal(bot, new (pf as any).goals.GoalNear(land.x, land.y, land.z, 1));
}

/**
 * 浮到**头露出水面**为止。
 *
 * 找不到岸时的活命办法：淹死的条件是头进水，不是身体进水。所以目标从上岸降级
 * 成浮头——做不到前者时后者仍然救得了命。
 *
 * 两处刻意的设计：
 * - **按结果停，不按时间停**：原来固定跳 1.5 秒就松手，配上外层 2 秒一轮的重试，
 *   机器人只会一直原地上下浮动。这里一直浮到 `headInWater` 变 false 为止。
 * - **结束时头还在水里就不松手**：那说明 L5 保命已经接管了（`runEmergency` 的
 *   `swimUp` 也按着 jump），这时候松手等于拆保命的台。
 */
/**
 * 上浮的结果——**三种，不是两种**。
 *
 * - `'surfaced'`：头露出了水面，氧气回满，完事。
 * - `'stuck'`：**y 不再上升**——头顶被水/方块封死（倒了一桶水盖头上、在涵洞里），
 *   继续按空格只是原地浮沉。这是"上浮无效"，该切换策略（水平寻路找岸）。
 * - `'slow'`：8 秒到了但 **y 还在涨**——多半是水太深，上浮有效只是慢。
 *   这时候**放弃上浮才是错的**：身体正在正确的路上，切去寻路反而把它拽偏。
 */
type SurfaceResult = 'surfaced' | 'stuck' | 'slow';

async function swimToSurface(bot: any): Promise<SurfaceResult> {
    const DEADLINE_MS = 8000;
    const STEP_MS = 250;
    // **"上浮无效"的判定是 y 停止上升，不是超时。** 以前是"8 秒头没出水 = 失败"，
    // 这在深水里会误判：从 60 格深处按着空格浮上来本来就要十几秒，y 明明一路在涨，
    // 却被判成"浮不出去"而切去寻路——身体正在正确的路上，反而被拽偏。
    // 正确的判据：持续按着空格，y 还有新高 = 上浮有效（继续等，放宽上限）；
    // y 卡住（2 秒没有新高）= 真被头顶封死，才切第二级。
    const STALL_MS = 2_000;
    const MAX_MS = 30_000; // 深水的兜底：30 秒还浮不上头，按 stuck 处理（总有别的祸）。
    const started = Date.now();
    let bestY: number | null = null;
    let bestAt = Date.now();
    try {
        bot.setControlState?.('jump', true);
        while (Date.now() - started < MAX_MS) {
            await new Promise((r) => setTimeout(r, STEP_MS));
            if (!headInWater(bot)) return 'surfaced';
            const y = Number(bot?.entity?.position?.y ?? 0);
            if (bestY == null || y > bestY + 0.05) {
                bestY = y;          // 新高：上浮在进行。
                bestAt = Date.now();
            } else if (Date.now() - bestAt > STALL_MS) {
                return 'stuck';     // 2 秒没有新高：头顶封死，继续按只是原地浮沉。
            }
            if (Date.now() - started > DEADLINE_MS && bestY != null) {
                // 超过初始预算但仍在上升：**不是失败**，继续浮（上限 MAX_MS）。
                // 深水上浮本来就要十几秒，别在这里判死。
            }
        }
        return 'slow'; // 30 秒兜底到了：头还没出水（极其罕见），按可上浮处理外层再试。
    } catch {
        return 'stuck';
    } finally {
        try {
            if (!headInWater(bot)) bot.setControlState?.('jump', false);
            // 头还在水里 → **保持按住继续浮**。松手就沉，而没人会接手这件事。
        } catch {
            // 拿不到 controlState 就算了。
        }
    }
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

/**
 * "想要 N 个成品" → "配方要跑几遍"。**这是被真机测出来的一条。**
 *
 * `num` 是**想要多少个**，不是"跑几遍配方"——一遍配方产多少由配方自己决定：
 * 1 原木 → 4 木板、2 木板 → 4 木棍。所以"给我 4 个木板"是**跑 1 遍**，不是 4 遍。
 *
 * 旧实现把 `num` 直接当次数交给 `bot.craft`，于是模型写 `output="4 oak_planks"`
 * （意思是"我要 4 个"）时被跑成 4 遍：吃掉 4 个原木、吐出 16 个木板。模型在
 * Feedback 里自己从材料消耗反推出了这个 4 倍，原话是"一次 craft 只执行一次配方
 * ……别默认 ×4"。
 *
 * 向上取整：`ceil` 而不是 `floor`——"要 3 个木板"跑 1 遍只有 4 个 ≥ 3，够；
 * 但"要 6 个木板"跑 1 遍只有 4 个，得跑 2 遍。少给不如多给，材料不够由
 * `craftLimit` 在调用方砍。
 */
export function craftsForRecipe(recipe: any, wanted: number): { perCraft: number; runs: number } {
    const perCraft = Math.max(1, Math.floor(Number(recipe?.result?.count ?? 1)) || 1);
    const want = Math.max(1, Math.floor(Number(wanted) || 1));
    return { perCraft, runs: Math.max(1, Math.ceil(want / perCraft)) };
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

    // **配方表可能返回 null**（itemId 不存在 / 没有 recipes 条目）。直接 `.length`
    // 会抛 `Cannot read properties of null (reading 'length')`——Feedback #31 的崩溃点。
    const recipeInfos: any = (mc as any).getItemCraftingRecipes(itemName);
    const itemId: any = (mc as any).getItemId(itemName);
    if (itemId == null || recipeInfos == null || recipeInfos.length === 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe.（金装备的注册名是 golden_*，例如 golden_boots）`);
        return false;
    }

    // 先找不需要工作台的配方；没有再看要不要 / 有没有工作台。
    let recipes: any[] = ((bot.recipesFor(itemId, null, 1, null) as any[]) ?? []);
    let craftingTable: any = null;
    const craftingTableRange = 16;
    placeTable: if (recipes.length === 0) {
        // `craftingTable=true` 只是让 mineflayer 假设有工作台来算材料够不够；
        // 真去合成时还必须找到或放下一个真的工作台。
        const tableRecipes: any[] = ((bot.recipesFor(itemId, null, 1, true) as any[]) ?? []);
        if (tableRecipes.length === 0) break placeTable;
        recipes = tableRecipes;

        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null) {
            const hasTable: boolean = Number(world.getInventoryCounts(bot)['crafting_table'] ?? 0) > 0;
            if (hasTable) {
                const pos: any = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = ((bot.recipesFor(itemId, null, 1, craftingTable) as any[]) ?? []);
                    placedTable = true;
                }
            } else {
                log(bot, `Crafting ${itemName} requires a crafting table: there is none nearby and none in the inventory. 先 placeHere 放一个工作台再合成。`);
                return false;
            }
        } else {
            recipes = ((bot.recipesFor(itemId, null, 1, craftingTable) as any[]) ?? []);
        }
    }
    if (recipes.length === 0) {
        const firstRequired = recipeInfos[0]?.[0] as Record<string, number> | undefined;
        const needText =
            firstRequired != null
                ? Object.entries(firstRequired).map(([key, value]) => `${key}: ${value}`).join(', ')
                : 'unknown';
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${needText}.`);
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

    const { perCraft, runs } = craftsForRecipe(recipe, num);
    const craftsWanted = runs;
    const limitNum = Number(craftLimit?.num);
    const crafts = Math.max(0, Math.floor(Math.min(Number.isFinite(limitNum) ? limitNum : craftsWanted, craftsWanted)));
    if (crafts <= 0) {
        const needText = Object.entries(requiredIngredients).map(([key, value]) => `${key}×${value}`).join('、');
        const haveText =
            Object.keys(requiredIngredients)
                .map((key) => `${key}×${Number(inventory[key] ?? 0)}`)
                .join('、') || '0';
        log(bot, `材料不够：做 ${num} 个 ${itemName} 需要 ${needText}；现有 ${haveText}。`);
        if (placedTable) await collectBlock(bot, 'crafting_table', 1);
        return false;
    }

    await bot.craft(recipe, crafts, craftingTable);
    const got = world.getInventoryCounts(bot)[itemName];
    if (crafts < craftsWanted) {
        log(bot, `材料不够：想做 ${num} 个 ${itemName}（需跑 ${craftsWanted} 遍配方，每遍出 ${perCraft} 个），只够跑 ${crafts} 遍；限料是 ${craftLimit.limitingResource}。现在背包里有 ${got} 个 ${itemName}。`);
    } else {
        log(bot, `合成了 ${itemName}：跑 ${crafts} 遍配方（每遍出 ${perCraft} 个），现在背包里有 ${got} 个。`);
    }
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
    await bot.lookAt(furnaceBlock.position.offset(0.5, 0.5, 0.5), true);

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


/** `target` 的解析结果：命中实体，或一条说清为什么没命中的原因。 */
export interface AttackTargetResult {
  entity: any | null;
  /** 人类可读的命中/失败说明，成功时用来告诉模型"打的是哪一只"。 */
  message: string;
}

/**
 * `target` 的语义类别——**必填，不给默认值**。
 *
 * - `id`：实体 ID，取 Live State 实体表里的 #编号。
 * - `player`：玩家名（`username`）。
 * - `mob`：实体类型名（`name`），取最近的。
 *
 * **为什么没有 `auto`**：靠字符串形状隐式猜（纯数字当 ID、其余先玩家名后类型名）
 * 等于把"玩家优先"这个人为约定藏起来——模型既不知道它存在，也无法覆盖它。
 * 曾经有个玩家就叫 `zombie`，而 `zombie` 也是最常见的怪物名。
 * 三个取值语义完全平级，谁也不压谁，所以让模型自己声明。
 */
export type AttackTargetType = 'id' | 'player' | 'mob';

const ATTACK_TARGET_TYPES: readonly AttackTargetType[] = ['id', 'player', 'mob'];

/**
 * 把模型给的 `target` 按 `targetType` 声明的语义解析成一个具体实体。
 *
 * - `id`：纯数字，直接取 `bot.entities[id]`。**不受 `maxDistance` 限制**——
 *   模型给的编号往往来自上一轮快照，现在可能已走出感知半径，但仍是能走过去的
 *   合法目标。
 * - `player`：按 `username` 匹配。玩家必须走这条——mineflayer 的玩家实体 `name`
 *   恒为 `'player'`（`entities.js:192`），按 `name` 找玩家永远落空。
 * - `mob`：按实体类型名（`name`）匹配，取最近的。
 */
export function resolveAttackTarget(
  bot: any,
  target: string,
  targetType: string,
  maxDistance: number = 64,
): AttackTargetResult {
  const raw = String(target ?? '').trim();
  const kind = String(targetType ?? '').trim().toLowerCase();

  if (!ATTACK_TARGET_TYPES.includes(kind as AttackTargetType)) {
    return {
      entity: null,
      message: `type 必填，且只认${ATTACK_TARGET_TYPES.join(' / ')}（收到 "${targetType ?? ''}"）。`,
    };
  }
  if (raw === '') {
    return {
      entity: null,
      message:
        kind === 'id' ? 'type=id 要的是实体编号（Live State 实体表里的 #数字）。'
        : kind === 'player' ? 'type=player 要的是玩家名。'
        : 'type=mob 要的是实体类型名（如 zombie）。',
    };
  }

  // ① 实体 ID。用 bot.entities 而不是"附近列表"——模型给的编号可能来自
  // 上一轮的快照，现在已经走出感知半径了，但仍是可以走过去的合法目标。
  if (kind === 'id') {
    if (!/^\d+$/.test(raw)) {
      return { entity: null, message: `type=id 要求 target 是纯数字的实体编号（收到 "${raw}"）。` };
    }
    const id = Number(raw);
    const direct = bot.entities?.[id];
    if (direct == null) {
      return { entity: null, message: `找不到实体 #${id}（可能已经死了或消失了）。看一眼 Live State 的实体表。` };
    }
    const distance = Math.round(bot.entity.position.distanceTo(direct.position) * 10) / 10;
    return {
      entity: direct,
      message: `锁定 #${id}（${describeEntity(direct)}，${distance}m），开打。`,
    };
  }

  const lower = raw.toLowerCase();
  const nearby: any[] = world.getNearbyEntities(bot, maxDistance);
  const describeWhat = kind === 'player' ? `叫 ${raw} 的玩家` : `${raw} 型实体`;

  // ② 玩家名（username）——只有 type=player 才走这条。
  if (kind === 'player') {
    const player: any = nearby.find((e: any) => typeof e.username === 'string' && e.username.toLowerCase() === lower);
    if (player) {
      return { entity: player, message: `锁定玩家 ${player.username}（#${player.id}），开打。` };
    }
  } else {
    // ③ 实体类型名。
    const mob: any = nearby.find((e: any) => typeof e.name === 'string' && e.name.toLowerCase() === lower);
    if (mob) {
      return {
        entity: mob,
        message: `锁定最近的 ${mob.name}#${mob.id}（${describeEntity(mob)}），开打。`,
      };
    }
  }

  // 没命中：把附近实际有什么列出来——模型真机报过"attack 报找不到 pig，
  // 而快照里 16 格内就有一只"，它无从自查。现在它能自己改目标。
  const seen = [
    ...new Set(
      nearby
        .map((e: any) => (typeof e.username === 'string' ? `${e.username}(player)` : e.name))
        .filter((n: unknown) => typeof n === 'string'),
    ),
  ];
  return {
    entity: null,
    message:
      `${maxDistance} 格内找不到可打的${describeWhat}。` +
      (seen.length > 0 ? `附近有：${seen.join('、')}。` : '附近什么都没有。'),
  };
}

/** 实体的一行式身份描述，给日志/回执用。 */
function describeEntity(entity: any): string {
  const name = typeof entity.username === 'string' ? entity.username : entity.name;
  return typeof name === 'string' ? name : 'unknown';
}

/**
 * 攻击 `target` 指向的实体，直到它死或跑掉。
 *
 * `targetType`（`id` / `player` / `mob`）**必填**，它决定 `target` 怎么解释。
 * 规则见 {@link resolveAttackTarget}。
 *
 * @returns true = 打到了并打死了；false = 没找到目标或被中断。
 */
export async function attackTarget(
  bot: any,
  target: string,
  targetType: string,
  kill: boolean = true,
): Promise<boolean> {
  const { entity, message } = resolveAttackTarget(bot, target, targetType);
  log(bot, message);
  if (entity == null) return false;
  const res: boolean | undefined = await attackEntity(bot, entity, kill);
  return res === true;
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
                bot.pathfinder.setMovements(movementsFor(bot));
                await runPathfindingInterruptibly(bot, new (pf as any).goals.GoalFollow(enemy, 3.5));
            } catch (err: unknown) {/* might error if entity dies, ignore */}
        }
        if (bot.entity.position.distanceTo(enemy.position) <= 2) {
            try {
                bot.pathfinder.setMovements(movementsFor(bot));
                const inverted_goal: any = new (pf as any).goals.GoalInvert(new (pf as any).goals.GoalFollow(enemy, 2));
                await runPathfindingInterruptibly(bot, inverted_goal);
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

    const movements: any = movementsFor(bot);
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
                // 统一走 digWithTimeout：裸 bot.dig 会在方块中途变化时永不 resolve。
                if (!(await digWithTimeout(bot, block, `@(${block.position.x},${block.position.y},${block.position.z})`))) {
                    log(bot, `挖 ${blockType} 超时，跳过这一格。`);
                } else {
                    await pickupNearbyItems(bot);
                    success = true;
                }
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
                // **背包满不等于挖不了**。mineflayer 的 collectBlock 插件满包时会抛 NoChests，
                // 但挖方块本身跟背包没关系，掉落物还能并进已有的半栈——模型真机报过
                // "free 0 死锁：collectBlocks 只认空格子"，就是这里直接放弃造成的。
                // 同一个函数上面已经有能用的手动路径，回退过去就是了。
                try {
                    await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                    // 统一走 digWithTimeout：裸 bot.dig 会在方块中途变化时永不 resolve。
                    if (!(await digWithTimeout(bot, block, `@(${block.position.x},${block.position.y},${block.position.z})`))) {
                        log(bot, `挖 ${blockType} 超时，跳过这一格。`);
                        continue;
                    }
                    await pickupNearbyItems(bot);
                    collected++;
                    log(bot, `背包满了，改用"自己挖 + 捡"的方式收了 ${blockType}（掉落物能并进已有的半栈）。`);
                    continue;
                } catch (fallbackErr: unknown) {
                    const fmsg: string = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                    log(
                        bot,
                        `Failed to collect ${blockType}: 背包满了，而且手动挖也失败（${fmsg}）。先 discard 一批，或者找个箱子存起来。`,
                    );
                    break;
                }
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
        const movements: any = movementsFor(bot);
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


/**
 * 挖一个方块，**带按硬度分档的超时**。
 *
 * 为什么必须分档：mineflayer 的 `bot.dig` promise 在方块中途被改、被打断、
 * 或者 bot 被 Stop 过之后会**永不 resolve**。固定 8 秒一刀切会两头不讨好——
 * 挖土嫌久，挖黑曜石（硬度 50，钻石镐也要 ~9.4 秒）又根本不够。
 *
 * 模型真机给的证据非常干净：同一格 `mineBlock(36,9,10)` 调了 3 次，
 * **空回执 ×2 + 卡死 280 秒 ×1**，而**同一片区域的另外 17 格全部正常**——
 * 唯一的差别就是"那一格是最难挖的黑曜石"。
 * （当时 8 秒超时只加在 `breakBlockAt` 上，`mineBlock` 走的是另一个入口，
 * 压根没有超时。）
 *
 * 分档：`5000 + 硬度 × 800`，下限 8 秒、上限 30 秒。
 * 黑曜石(50)→30 秒，远古残骸(30)→29 秒，石头(1.5)→8 秒，泥土(0.5)→8 秒。
 */
export interface DigTimeoutPlan {
    timeoutMs: number;
    expectedMs: number;
    hardness: number;
    toolId: number | null;
    unbreakable: boolean;
}

/**
 * 按方块硬度 + 当前工具动态估算挖穿超时。
 *
 * 真机 Feedback #30：黑曜石正常约 9.4 秒，旧的固定 9 秒/固定 8 秒超时让它
 * 永远挖不动，下界门在工具层直接堵死。这里优先用 mineflayer 的
 * `block.digTime(heldItemType)`（它已经算好工具倍率），再按
 * expected * multiplier + buffer，至少 minMs。
 */
export function estimateDigTimeoutMs(
    block: any,
    toolId: number | null = null,
    opts: { minMs?: number; bufferMs?: number; multiplier?: number; maxMs?: number; digTimeMs?: number } = {},
): DigTimeoutPlan {
    const hardness = typeof block?.hardness === 'number' ? block.hardness : 0;
    let expectedMs: number | null = null;
    if (opts.digTimeMs != null) {
        expectedMs = opts.digTimeMs;
    } else if (typeof block?.digTime === 'function') {
        try {
            const t = block.digTime(toolId, false, false, false);
            if (Number.isFinite(t) && t > 0) expectedMs = t;
            else if (t === Infinity) expectedMs = Infinity;
        } catch {
            expectedMs = null;
        }
    }
    const unbreakable = expectedMs === Infinity || hardness === -1;
    if (expectedMs == null) {
        // 没有 digTime 的替身/旧版本：用硬度粗略兜底（黑曜石 50 -> 45s）。
        expectedMs = hardness > 0 ? 5000 + hardness * 800 : 1000;
    }
    const minMs = opts.minMs ?? 12_000;
    const bufferMs = opts.bufferMs ?? 3_000;
    // 真机实测约 2.6×；给到 4× + buffer，黑曜石（预计 9.4s / 实测 24s）必须能过。
    const multiplier = opts.multiplier ?? 4;
    const maxMs = opts.maxMs ?? 180_000;
    const timeoutMs = unbreakable
        ? minMs
        : Math.min(maxMs, Math.max(minMs, expectedMs * multiplier + bufferMs));
    return { timeoutMs, expectedMs, hardness, toolId, unbreakable };
}

/** 等 ms 的 Promise（digWithTimeout 内部用，避免悬挂定时器）。 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 挖方块并动态超时；一次超时后在已有进度上续挖，尽量挖穿而不是放弃。
 *
 * 回执写清：当前方块、实际用时、预计用时、第几次尝试、是否仍在挖、每 3 秒进度。
 */
export async function digWithTimeout(bot: any, block: any, where: string): Promise<boolean> {
    const name = block?.name ?? '?';
    const toolId: number | null = typeof bot?.heldItem?.type === 'number' ? bot.heldItem.type : null;
    let expectedOverride: number | undefined;
    if (typeof bot?.digTime === 'function') {
        try {
            const t = bot.digTime(block);
            if (Number.isFinite(t) && t > 0) expectedOverride = t;
            else if (t === Infinity) expectedOverride = Infinity;
        } catch {
            expectedOverride = undefined;
        }
    }
    const plan = estimateDigTimeoutMs(block, toolId, expectedOverride == null ? {} : { digTimeMs: expectedOverride });
    const attempts = 2;
    let totalMs = 0;
    const expectedText = plan.expectedMs === Infinity ? '不可破坏/工具不够' : Math.round(plan.expectedMs / 100) / 10 + 's';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (bot?.interrupt_code) {
            log(bot, '挖 ' + name + ' ' + where + ' 被 Stop/保命打断，已放弃（累计 ' + Math.round(totalMs / 1000) + 's）。');
            try {
                bot.stopDigging?.();
            } catch {
                // 停不下来也如实返回。
            }
            return false;
        }
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), plan.timeoutMs);
        });
        const progressTimer: ReturnType<typeof setInterval> = setInterval(() => {
            const elapsed = Date.now() - started;
            const still = bot?.targetDigBlock != null;
            log(
                bot,
                '挖 ' + name + ' ' + where + ' 进度：已 ' + Math.round(elapsed / 1000) + 's，仍在挖=' + still +
                    (still ? '' : '（dig 还没返回，可能被客户端同步卡住）') + '。',
            );
        }, 3_000);
        let outcome: 'ok' | 'timeout' | 'error';
        try {
            outcome = await Promise.race([
                bot.dig(block, true).then(() => 'ok' as const),
                timeoutPromise,
            ]);
        } catch (err: unknown) {
            outcome = 'error';
            log(bot, '挖 ' + name + ' ' + where + ' 抛错：' + (err instanceof Error ? err.message : String(err)));
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            clearInterval(progressTimer);
        }
        const elapsed = Date.now() - started;
        totalMs += elapsed;
        const stillDigging = bot?.targetDigBlock != null;
        if (outcome === 'ok') {
            log(
                bot,
                '挖 ' + name + ' ' + where + ' 完成：用时 ' + Math.round(elapsed / 100) / 10 +
                    's（预计 ' + expectedText + '，第 ' + attempt + '/' + attempts + ' 次尝试，硬度 ' + plan.hardness + '）。',
            );
            return true;
        }
        if (outcome === 'timeout') {
            log(
                bot,
                '挖 ' + name + ' ' + where + ' 第 ' + attempt + '/' + attempts + ' 次超时：实际 ' +
                    Math.round(elapsed / 100) / 10 + 's，预计 ' + expectedText + '（硬度 ' + plan.hardness +
                    '），仍在挖=' + stillDigging + '。',
            );
        }
        if (attempt < attempts) {
            log(bot, '续挖 ' + name + ' ' + where + '（第 ' + (attempt + 1) + ' 次，' + (outcome === 'timeout' ? '在已有进度上继续' : '重试') + '）...');
            if (!stillDigging) {
                try {
                    bot.stopDigging?.();
                } catch {
                    // 忽略。
                }
            }
            await sleep(200);
            continue;
        }
    }
    try {
        bot.stopDigging?.();
    } catch {
        // 忽略。
    }
    log(
        bot,
        '挖 ' + name + ' ' + where + ' 结束：连续 ' + attempts + ' 次超时/失败，累计 ' +
            Math.round(totalMs / 1000) + 's；仍在挖=' + (bot?.targetDigBlock != null) + '。可稍后重试或换工具。',
    );
    return false;
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
            const movements: any = movementsFor(bot);
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
        // **给 dig 加超时**。mineflayer 的 `bot.dig` promise 在方块中途被改、
        // 被打断、或者 bot 被 Stop 过之后会**永不 resolve**——模型真机三次数据点：
        // digDown 静默卡死 115 / 140 / 152 秒（`task.stuck {action:"digDown",
        // stuckForSeconds:152}`，speed 0 一格没动），她的 workaround 是"Stop() 一下就继续"。
        // 有超时就不需要人肉 Stop 了。
        if (!(await digWithTimeout(bot, block, `@(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`))) return false;
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


/**
 * 等服务器把方块状态同步过来（`until` 为真即返回）。
 *
 * mineflayer 的 `placeBlock` / `breakBlockAt` **返回时什么都没发生**：只是把
 * 一个动作发给了服务端，客户端 `blockAt` 要等服务器处理完（1 tick = 50ms）
 * 再经网络广播才读得到。原来的写法是死等 200ms——那个数是猜的，网络好时
 * 纯浪费；而蓝图施工是 8000 块起步，200ms × 8000 就是 27 分钟纯等待。
 *
 * 改成轮询：确认到了**立刻**走人，慢的时候仍有上限兜底。
 * @param until 收到目标格的实际方块名，返回 true 表示成了
 */
async function waitForBlockAt(
    bot: any,
    pos: any,
    until: (name: string) => boolean,
    timeoutMs: number = 1000,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let name: string | null = null;
        try {
            name = bot.blockAt(pos)?.name ?? null;
        } catch {
            // 方块还没进视野/未加载：当作还没到，继续等。
        }
        if (name != null && until(name)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

/** placeBlock 清障前的风险判据。 */
export interface PlaceBlockRisk {
    ok: boolean;
    reason: string;
}

function blockName(block: { name?: unknown } | null | undefined): string | null {
    return typeof block?.name === 'string' ? block.name : null;
}

/**
 * 清障/放置前检查站位：绝不挖脚下承重块，目标旁有岩浆/水/悬崖就拒绝。
 *
 * 真机 Feedback #34：placeBlock 清障挖掉了机器人脚下的 deepslate，bot 掉
 * 进 y=-57 岩浆烧死。承重块不是障碍物，是命。
 */
export function assessPlaceBlockRisk(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
): PlaceBlockRisk {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const tx = Math.floor(target.x);
    const ty = Math.floor(target.y);
    const tz = Math.floor(target.z);
    const nameAt = (x: number, y: number, z: number): string | null => blockName(blockAt(x, y, z));

    // 1) 玩家站立格/脚下承重格：绝不能拆。
    if (tx === fx && tz === fz && (ty === fy || ty === fy - 1)) {
        return { ok: false, reason: '目标格是你脚下/站立格的承重方块，拆了会掉下去' };
    }
    const feetName = nameAt(fx, fy, fz);
    const supportName = nameAt(fx, fy - 1, fz);
    if (feetName === 'lava' || feetName === 'water') {
        return { ok: false, reason: '你正站在 ' + feetName + ' 里，先脱离再放/清障' };
    }
    if (supportName == null || supportName === 'air' || supportName === 'lava' || supportName === 'water') {
        return { ok: false, reason: '脚下没有实心支撑，先 goToCoordinates 站到安全地面' };
    }

    // 2) 目标格/目标下方紧邻格是危险流体或空：直接拒绝。
    const targetName = nameAt(tx, ty, tz);
    if (targetName === 'lava') return { ok: false, reason: '目标格就是岩浆，不能挖/放' };
    if (targetName === 'water') return { ok: false, reason: '目标格就是水，先处理水源' };
    const belowTarget = nameAt(tx, ty - 1, tz);
    if (belowTarget === 'lava' || belowTarget === 'water') {
        return { ok: false, reason: '目标格下方紧邻 ' + belowTarget + '，清障会挖穿到岩浆/水' };
    }
    // 3) 目标紧邻岩浆：清障可能放岩浆进来。
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0],[0,1,0]]) {
        const adjacent = nameAt(tx + dx, ty + dy, tz + dz);
        if (adjacent === 'lava') {
            return { ok: false, reason: '目标格紧邻岩浆，清障风险高；先换一格或用 placeHere' };
        }
    }
    return { ok: true, reason: '' };
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
        const risk = assessPlaceBlockRisk(
            (bx, by, bz) => bot.blockAt(new Vec3(bx, by, bz)),
            bot.entity.position,
            { x, y, z },
        );
        if (!risk.ok) {
            log(bot, '拒绝 removing block at ' + target_dest + '：' + risk.reason + '。');
            return false;
        }
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
    // 用桶"放水/放岩浆"是同一个危险操作，只是走 placeBlock 这条路。
    if (item_name === 'water_bucket' || item_name === 'lava_bucket') {
        if (!allowDangerousOp(bot, item_name === 'water_bucket' ? 'pour_water' : 'pour_lava')) return false;
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
        const risk = assessPlaceBlockRisk(
            (bx, by, bz) => bot.blockAt(new Vec3(bx, by, bz)),
            bot.entity.position,
            { x, y, z },
        );
        if (!risk.ok) {
            log(
                bot,
                '拒绝清障 ' + targetBlock.name + ' @' + targetBlock.position + '：' + risk.reason +
                    '。替代方案：换一格放、先用 goToCoordinates 站到安全实心处，或用 placeHere。',
            );
            return false;
        }
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed: boolean = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        // 拆完要确认那一格真的空了：紧接着就要往那儿放方块，
        // 服务端还没把破坏落地时 placeBlock 会撞上"格子里还有东西"。
        await waitForBlockAt(bot, target_dest, (name) => empty_blocks.includes(name));
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
        bot.pathfinder.setMovements(movementsFor(bot));
        if (!(await runPathfindingInterruptibly(bot, inverted_goal))) return false;
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        const tpos: any = targetBlock.position;
        const movements: any = movementsFor(bot);
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
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5), true);
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            // **确认方块真的落地了再 return true**：这个 true 是对调用方的
            // 承诺（蓝图施工会立刻在下一格继续、验证器会立刻读 blockAt）。
            // 原先死等 200ms，现在轮询到就立刻走人。超时仍按成功返回——
            // 契约与旧实现一致，只是把"确定失败"和"服务端慢"区分开。
            // 方块名要去掉 `[facing=…]` 之类后缀：blockType 在上面被改写过
            // （torch → wall_torch、stairs → stairs[facing=north]），而
            // blockAt 报的是裸名。
            const bareName = blockType.split('[')[0] ?? blockType;
            await waitForBlockAt(bot, target_dest, (name) => name === bareName);
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

/**
 * 按 `inventoryStart` 分界读取容器内容，**只取容器区间**。
 *
 * 真机 Feedback #35：读箱子串进查看者背包，槽位从 12 跳到 28。
 * mineflayer 的 `containerItems()` 在不同版本/容器类型下口径不稳，
 * 这里直接拿 slots，严格用 inventoryStart 分界。
 */
export function containerContents(container: any): {
    readable: boolean;
    invStart: number;
    end: number;
    lines: string[];
} {
    const slots = Array.isArray(container?.slots) ? container.slots : null;
    if (slots == null) {
        return { readable: false, invStart: 0, end: 0, lines: ['容器槽位表读不到（不代表容器是空的）'] };
    }
    const rawStart = Number(container?.inventoryStart ?? 27);
    const invStart = Number.isFinite(rawStart) ? Math.max(0, Math.floor(rawStart)) : 27;
    const end = Math.min(slots.length, invStart);
    const lines: string[] = [];
    for (let i = 0; i < end; i++) {
        const slot = slots[i] as { name?: unknown; count?: unknown } | null | undefined;
        if (slot?.name == null) continue;
        lines.push(String(slot.name) + '×' + String(slot.count ?? 1));
    }
    return { readable: true, invStart, end, lines };
}

export async function viewChest(bot: any): Promise<boolean> {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     **/
    const chest: any = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer: any = await bot.openContainer(chest);
    const contents = containerContents(chestContainer);
    if (!contents.readable) {
        log(bot, contents.lines.join('\n'));
    } else if (contents.lines.length === 0) {
        log(bot, '容器区间内没有物品（只读了槽位 0..' + contents.invStart + '，不含查看者背包）。');
    } else {
        log(bot, '容器内容（只读槽位 0..' + contents.invStart + '）：');
        for (const line of contents.lines) log(bot, line);
    }
    await chestContainer.close();
    return contents.readable;
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

    await bot.lookAt(player.position, true);
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

/**
 * 多远算"一步算不完"的远距离（格）。
 *
 * 跨矿洞的长路径要把"挖穿整段地形"的分支全展开，A* 的搜索量随距离指数涨——
 * 真机上 40+ 格的地下路径经常 20 秒都算不完（thinkTimeout 已经放宽过）。
 * 超过这个距离的 NoPath 先自动分一段再试，不直接报失败。
 */
export const SEGMENT_THRESHOLD = 48;

/** 可中断寻路的轮询间隔（毫秒）。 */
export const PATHFIND_INTERRUPT_POLL_MS = 200;

/**
 * 可中断的 `pathfinder.goto`。
 *
 * `bot.pathfinder.goto(goal)` 在计算/走路时**不认** `bot.interrupt_code`：
 * Stop 之后 `pathfinder.stop()` 可能只让它换个目标继续卡，于是 ActionManager.stop
 * 等 10 秒只能 cleanKill 杀 body（真机 13 分钟 3 次 goToCoordinates）。这里每
 * PATHFIND_INTERRUPT_POLL_MS 轮询一次 interrupt_code，一旦置位立刻 `pathfinder.stop()`
 * 并 resolve(false)，把控制权还给调用方，不再靠杀进程。
 */
export function runPathfindingInterruptibly(bot: any, goal: any): Promise<boolean> {
    if (bot?.interrupt_code) {
        try {
            bot.pathfinder?.stop?.();
        } catch {
            // 停不下来也要按中断返回。
        }
        return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearInterval(timer);
            fn();
        };
        const timer: ReturnType<typeof setInterval> = setInterval(() => {
            if (bot?.interrupt_code) {
                try {
                    bot.pathfinder?.stop?.();
                } catch {
                    // 忽略底层 stop 异常。
                }
                settle(() => resolve(false));
            }
        }, PATHFIND_INTERRUPT_POLL_MS);
        let gotoPromise: Promise<unknown>;
        try {
            gotoPromise = Promise.resolve(bot.pathfinder.goto(goal));
        } catch (err: unknown) {
            settle(() => reject(err));
            return;
        }
        gotoPromise.then(
            () => settle(() => resolve(true)),
            (err: unknown) => settle(() => reject(err)),
        );
    });
}

export async function goToGoal(bot: any, goal: any, _persist?: boolean): Promise<boolean> {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * (`_persist` is ignored; it exists only because one legacy call site
     * passes a third argument.)
     **/

    // **深水闸门（第一道）：目标点本身是不是危险的水。**
    // 原来 `enter_deep_water` 只是登记表里的一行——着火豁免、拒绝文案都写着它，
    // 但**没有任何代码真的拿它去问许可**，等于这条规则从来没生效过。用户的原话
    // 是"禁止接触到深度超过一格的水"，所以先拦目标：那片水深 / 在流动 / 连着
    // 流动水，就别过去。
    // 只有给了明确坐标的 goal（GoalNear / GoalBlock / GoalXZ 那一类）才查得动；
    // GoalFollow 之类追实体的没有坐标，交给下面第二道闸（allowWater）。
    const g = goal as { x?: unknown; y?: unknown; z?: unknown } | null | undefined;
    const gx = g != null ? Number(g.x) : NaN;
    const gy = g != null ? Number(g.y) : NaN;
    const gz = g != null ? Number(g.z) : NaN;
    if (Number.isFinite(gx) && Number.isFinite(gy) && Number.isFinite(gz)) {
        const refusal = dangerousWaterRefusal(bot, gx, gy, gz, '走到');
        if (refusal != null) {
            log(bot, refusal);
            return false;
        }
    }

    const nonDestructiveMovements: any = movementsFor(bot);
    const dontBreakBlocks: string[] = ['glass', 'glass_pane'];
    for (const block of dontBreakBlocks) {
        // 某些 Movements 版本/替身没有 blocksCantBreak，audit .add 时把这条兜住。
        nonDestructiveMovements.blocksCantBreak?.add?.((mc as any).getBlockId(block));
    }
    nonDestructiveMovements.placeCost = 2;
    nonDestructiveMovements.digCost = 10;

    const destructiveMovements: any = movementsFor(bot);

    // **安全基线（落差 / 冲刺 / 跑酷 / 深水）不在这里设**——两套 Movements 都来自
    // `movementsFor()`，它在出厂时就套好了，见 `movements.ts`。
    //
    // 这里**故意**不再重复一遍：原先这段是唯一一处安全配置，其余 16 处 `new
    // Movements(bot)` 全是裸的——追怪、逃跑、保命 fleeTo 都从水里直穿过去。
    // 安全配置跟着"创建实例的地方"走，才谈得上"任何情况下都有效"。
    // 真机证据（为什么要这些值）也一并搬去 `movements.ts` 了，不复制第二份。
    // **算路超时也要放宽**：默认 thinkTimeout 只有 5 秒，长路径（从 100 格深的竖井
    // 爬出来、绕过大片水域）根本算不完，就直接报 'Took to long to decide path to goal!'
    // ——模型真机报的"goToCoordinates 完全不动"就是这个。物理诊断加上之后一眼就看到了。
    try {
        bot.pathfinder.thinkTimeout = 20_000;
        bot.pathfinder.tickTimeout = 80;
    } catch {
        // 老版本没有这两个字段就算了。
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
        // **这句话以前很误导**：模型读到 "Path not found" 就以为走不到，开始换招。
        // 其实这只是 1 秒的快速探测没通过——长路径本来就算不完，接下来**仍然会走**
        // （goto 里有 20 秒的完整算路 + 边走边挖）。把"仍会走"放在句首，别让它误判。
        log(
            bot,
            `快速探测（1 秒预算）没算出完整路径——这不代表走不到；现在按破坏性寻路实际走（完整算路 + 需要时挖开挡路的方块）。`,
        );
    }

    const doorCheckInterval: ReturnType<typeof setInterval> = startDoorInterval(bot);

    bot.pathfinder.setMovements(final_movements);
    try {
        const arrived = await runPathfindingInterruptibly(bot, goal);
        clearInterval(doorCheckInterval);
        return arrived;
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

/**
 * 寻路走不动时，把**物理现场**摊开。
 *
 * 模型真机报过"goToCoordinates 完全不动且被 task.stuck，原因不明"，还自己给了
 * 堆栈定位（pathfinder monitorMovement→resetPath，疑似客户端物理被禁）。与其猜，
 * 不如把"卡在哪、脚/头是什么方块、物理开没开"直接写出来——模型能据此改策略
 * （挖出来 / 搭脚点 / 换目标），排查的人也能一眼看出原因。
 */
export function describeStuck(bot: any): string {
    try {
        const p = bot.entity.position;
        const at = (dy: number): string => {
            const b = bot.blockAt?.(p.offset(0, dy, 0));
            return typeof b?.name === 'string' ? b.name : '?';
        };
        const physics = bot.physicsEnabled === false ? '**物理已关闭**' : '物理正常';
        const inBlock = at(0) !== 'air' && at(0) !== 'cave_air' && at(0) !== 'water';
        return (
            `你在 (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})，` +
            `脚 ${at(0)} / 头 ${at(1)}，${physics}` +
            (inBlock ? '——**脚下方块是实心的，你可能卡在方块里**：用 mineBlock 挖开再走。' : '。')
        );
    } catch {
        return '（读不到物理状态）';
    }
}

/**
 * "到了目标附近"这句话的**如实版本**。
 *
 * 以前是无条件的 `You have reached at x, y, z`——三个坐标一报，听起来就是"到位了"。
 * 但寻路器说的"到"只是"进了 min_distance 这个球"，模型真正要知道的是
 * "我够得着吗"：真机上它离目标还有 3.4 格、目标在**头顶上方 3 格**，照样被报成
 * reached（Feedback #7），于是它以为自己站到了方块旁边。
 *
 * 所以这里报三件事：直线还差多少、**水平与垂直分开**、目标在上还是在下。
 * 垂直差尤其重要——差 3 格水平很好走，差 3 格高度意味着得垫方块或者挖上去。
 */
export function describeArrival(
    bot: any,
    x: number,
    y: number,
    z: number,
    distance: number,
): string {
    const pos = bot?.entity?.position;
    const one = (n: number): number => Math.round(n * 10) / 10;
    if (pos == null) return `到了 ${x}, ${y}, ${z} 附近（读不到自己的位置）。`;
    const dx = pos.x - x;
    const dz = pos.z - z;
    const dy = pos.y - y;
    const horizontal = Math.hypot(dx, dz);
    const vertical = Math.abs(dy);
    // 垂直差超过 1.5 格就值得单独说——1 格是台阶，走上去就行。
    const where =
        vertical <= 1.5
            ? '同一层'
            : dy < 0
              ? `在你的头顶上方 ${one(vertical)} 格`
              : `在你的脚下下方 ${one(vertical)} 格`;
    const tail =
        vertical <= 1.5
            ? ''
            : `；要够到它得先${dy < 0 ? '垫方块往上、或者找路上去' : '往下挖或跳下去'}`;
    return (
        `到了 ${x}, ${y}, ${z} 附近：还差 ${one(distance)} 格（水平 ${one(horizontal)} / 垂直 ${one(vertical)}），` +
            `目标${where}${tail}。`
    );
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
        // **传送也要过深水闸门** —— `/tp` 是唯一一条完全绕开寻路的移动路径：
        // 第 1 层（`blocksToAvoid`）管的是"怎么走过去"，第 2 层（`goToGoal` 的
        // 目标点判定）在这条分支上**根本不会被调用**。闸门管路径，管不了落点，
        // 所以落点得在这里单独判一次。
        //
        // 这条不难想到，难在意识到它存在：正常分支有闸，所以"模型把自己送进水里"
        // 看起来不可能——直到 cheat 开着。
    const tpRefusal = teleportRefusal(bot, x, y, z);
    if (tpRefusal != null) {
        log(bot, tpRefusal);
        return false;
    }
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
        // 中断优先于距离够近就算到了：Stop/急停之后不能报成功。
        if (bot.interrupt_code) {
            log(bot, `Navigation interrupted before reaching (${x},${y},${z}).`);
            return false;
        }
        const distance: number = bot.entity.position.distanceTo(new (Vec3 as any)(x, y, z));
        if (distance <= min_distance+1) {
            // **不许再说"已到达"就完事。** 寻路器的"到了"是"进了 min_distance
            // 这个球"，而模型关心的是"我够得着那个东西吗"——这两个不是一回事：
            // 真机上它站在 (-34.5,50,-13.5)，目标 (-33,53,-13) 在**头顶上方 3 格**，
            // 直线 3.4 格 ≤ 5 就算 reached，模型于是以为自己到位了（Feedback #7）。
            //
            // 所以把水平/垂直分开报出来，并明说目标在上方还是下方——"还差 3 格、
            // 在头顶"和"到了"对模型的含义完全不同。
            log(bot, describeArrival(bot, x, y, z, distance));
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away. ${describeStuck(bot)}`);
            return false;
        }
    } catch (err: unknown) {
        clearInterval(progressInterval);
        const msg: string = err instanceof Error ? err.message : String(err);
        // **NoPath 要给可执行的建议。** "No path to the goal!" 是寻路器的内部话，
        // 模型读到只知道"失败"，不知道该怎么办——它在地下矿洞之间反复撞的就是
        // 这个：两个洞隔着厚厚的石头，A* 要挖穿整段地形，20 秒内算不完。
        // 它真正需要的下一步是：分段走（先到中间点）、或干脆自己挖通道。
        if (/No path/i.test(msg)) {
            const here: any = bot?.entity?.position;
            const straight = Math.round(here?.distanceTo(new (Vec3 as any)(x, y, z)) ?? -1);
            // **远距离先自动分段一次。** 跨矿洞（几十上百格、中间全是实心石头）的
            // A* 要把"挖穿整段地形"的分支全展开，20 秒也算不完——这不是"没路"，
            // 是**一次算不完**。近距离（几十格内）它算得动，而且会边走边挖。
            // 所以：先贪心走到"朝目标方向的一段短途"，到近处再算剩下那段。
            // 只分一次，避免中点本身不可达时来回递归。
            if (here != null && straight > SEGMENT_THRESHOLD) {
                const t = Math.min(24, straight * 0.5) / straight;
                const mid = {
                    x: Math.round(here.x + ((x as number) - here.x) * t),
                    y: Math.round(here.y + ((y as number) - here.y) * t),
                    z: Math.round(here.z + ((z as number) - here.z) * t),
                };
                log(
                    bot,
                    `${straight} 格远，一步算不出完整路径——分段走：先到 (${mid.x}, ${mid.y}, ${mid.z})，` +
                        `到那儿再算剩下的一段。`,
                );
                const reached = await goToPosition(bot, mid.x, mid.y, mid.z, 1);
                if (reached) {
                    log(bot, `已到中途点，继续走剩下的路。`);
                    return await goToPosition(bot, x as number, y as number, z as number, min_distance);
                }
                log(bot, `中途点也走不到，不再继续分段。`);
            }
            log(
                bot,
                `走不到 (${x}, ${y}, ${z})：寻路器算不出一条完整路径` +
                    `（地下隔着厚地形时，把"挖过去"全考虑进去的搜索量会爆炸）。${describeStuck(bot)}\n` +
                    `可行的做法：① 自己挖——目标在隔壁矿洞就用 digDown / mineBlock 开一条通道；` +
                    `② 若你在**地上**而目标在**地下**（或反过来），先找洞口/竖井下去，别指望平地寻路穿越；` +
                    `③ 多试几个中间点（往别的方向绕一段往往就能算出来）。`,
            );
            return false;
        }
        log(bot, `Pathfinding stopped: ${msg}. ${describeStuck(bot)}`);
        return false;
    }
}

/**
 * 走到**能接触这个方块**的位置（相邻可站立格），而不是"离它几格就算到"。
 *
 * 为什么单独有这个函数：找方块（`searchForBlock` / `collectBlocks` 的第一步）的最终
 * 目的是**碰到那个方块**——挖它、放东西到它旁边、或者站上去。"距球心 4 格"这个
 * 判定既不能保证够得着，又会让回执说"已到达"，于是模型以为到位了（Feedback #7）。
 *
 * `GoalGetToBlock` 的 `isEnd` 就是"我站的位置能够到这个方块"，所以到达时**真的**
 * 就在旁边。走不到就返回 false，由调用方如实报"走不过去"。
 */
export async function goToBlockFace(bot: any, position: { x: number; y: number; z: number }): Promise<boolean> {
    if (bot?.entity?.position == null || position == null) return false;
    const goal = new (pf as any).goals.GoalGetToBlock(position.x, position.y, position.z);
    try {
        await goToGoal(bot, goal);
    } catch (err: unknown) {
        log(bot, `Pathfinding stopped: ${err instanceof Error ? err.message : String(err)}. ${describeStuck(bot)}`);
        return false;
    }
    // GoToBlock 到达即"够得着"，但仍有极少数情况（比如最后一步被挤开）——
    // 用实际的够得着距离再确认一次，免得又报一个假的"到了"。
    const distance = bot.entity.position.distanceTo(new (Vec3 as any)(position.x, position.y, position.z));
    if (distance <= 2.5) {
        log(bot, describeArrival(bot, position.x, position.y, position.z, distance));
        return true;
    }
    log(bot, `走到了 ${position.x}, ${position.y}, ${position.z} 边上但还差 ${Math.round(distance * 10) / 10} 格（够不着）。${describeStuck(bot)}`);
    return false;
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
    // **先说"开始搜了"**：`getNearestBlock` 是同步遍历，半径 512 时要扫几万个
    // 已加载方块，期间占住事件循环——一条日志都没有，模型看到的就是"给了
    // action_id 之后彻底静默"，只能靠 Stop（Feedback #16 原话）。
    // 先报一句，它至少知道是在搜、而不是卡死。
    log(bot, `Searching for ${blockType} within ${range} blocks...`);
    if (bot.interrupt_code) {
        log(bot, `Search interrupted before scanning ${blockType} (Stop/保命打断).`);
        return false;
    }
    let block: any;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks: any[] = world.getNearestBlocksWhere(bot, (block: any) => block.name === blockType && block.metadata === 0, range, 1);
        if (bot.interrupt_code) {
            log(bot, `Search interrupted while looking for ${blockType} (Stop/保命打断).`);
            return false;
        }
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, (b: any) => b.name === blockType, range, 1);
            if (bot.interrupt_code) {
                log(bot, `Search interrupted while looking for flowing ${blockType} (Stop/保命打断).`);
                return false;
            }
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
        if (bot.interrupt_code) {
            log(bot, `Search interrupted before navigation (Stop/保命打断).`);
            return false;
        }
    }
    if (!block) {
        // 找不到也要**给结论**——模型明确要求过：不管找没找到都要有回执，
        // "别让调用方只能靠猜"（Feedback #16：长距离搜索什么都不报，它只能 Stop）。
        log(bot, `Could not find any ${blockType} in ${range} blocks.（搜完了，范围内确实没有）`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    // **精确寻路到"够得着这个方块"的位置**，而不是"距它 4 格就算到"。
    //
    // 以前这里是 `goToPosition(..., min_distance)`，而 `searchForBlock` 传的
    // `min_distance` 是 **4**——这个 4 是 TS 迁移时从上游原样搬来的，没有任何
    // 设计理由（`git log -S` 只追到那次搬运）。于是寻路器只要进了"以目标为球心、
    // 半径 4 的球"就停下，并报 `You have reached`。真机上它在 (-34.5,50,-13.5)、
    // 目标 (-33,53,-13) 在头顶上方 3 格，直线 3.4 格 ≤ 5（4+1）就算到达——模型
    // 于是以为自己站到了方块旁边（Feedback #7）。
    //
    // `GoalGetToBlock` 的语义正是"站到能接触这个方块的位置"（相邻可站立格），
    // 它到达时人就在旁边，不需要再用一句"已到达"去圆。**真走不到就如实说走不到**，
    // 比假成功有用：模型还能改用 mineBlock（它的够得着阈值是 4.5 格）。
    const arrived = await goToBlockFace(bot, block.position);
    // **把结果如实返回**：原来无条件 return true;，路径不可达时工具照样报成功——
    // 模型反馈过"找不到目标时静默"，其实不是找不到，是找到了但走不过去，结果被吞了。
    if (!arrived) {
        if (bot.interrupt_code) {
            log(bot, `Found ${block.name} at ${block.position} but navigation was interrupted (Stop/保命打断).`);
        } else {
            log(bot, `Found ${block.name} at ${block.position} but could not reach it (path blocked or too far).`);
        }
    }
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

    const move: any = movementsFor(bot);
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
    bot.pathfinder.setMovements(movementsFor(bot));

    if (settings.cheat) {
        const move: any = movementsFor(bot);
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

    const moved = await goToGoal(bot, inverted_goal);
    const new_pos: any = bot.entity.position;
    log(bot, `Moved away from ${pos.floored()} to ${new_pos.floored()}.`);
    return moved;
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
    bot.pathfinder.setMovements(movementsFor(bot));
    return await runPathfindingInterruptibly(bot, inverted_goal);
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
        bot.pathfinder.setMovements(movementsFor(bot));
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
        if (bot.interrupt_code) {
            bot.pathfinder.stop();
            return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const door_block: any = bot.blockAt(door_pos);
    await bot.lookAt(door_pos, true);
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
    // 床在**下界和末地都会炸**（末地那个能一下把人秒了）。主世界睡觉不拦
    // —— op 的 when() 只在会炸的维度才判危险。
    if (!allowDangerousOp(bot, 'sleep_in_bed')) return false;

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
        bot.pathfinder.setMovements(movementsFor(bot));
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
        bot.pathfinder.setMovements(movementsFor(bot));
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
        // 工具不够就别白等动态超时：黑曜石手挖要很久，明确报工具不对更有用。
        const heldId: number | null = typeof bot?.heldItem?.type === 'number' ? bot.heldItem.type : null;
        if (
            bot?.game?.gameMode !== 'creative' &&
            typeof target.canHarvest === 'function' &&
            !target.canHarvest(heldId)
        ) {
            log(bot, '没有能挖 ' + target.name + ' 的工具（手持 ' + (bot?.heldItem?.name ?? '空手') + '）；先换镐/正确工具再来。');
            return false;
        }
        // **同一个入口**：mineBlock 以前是裸的 await bot.dig()，8 秒超时没覆盖到它
        // （模型真机报"mineBlock 挖黑曜石空回执×2 + 卡死 280 秒"，而其他 17 格全正常）。
        if (!(await digWithTimeout(bot, target, `@(${x},${y},${z})`))) return false;
        log(bot, `挖掉了 ${target.name} @(${x},${y},${z})。`);
        return true;
    } catch (err: unknown) {
        log(bot, `挖 ${target.name} @(${x},${y},${z}) 失败：${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/**
 * digDown 单步的判据结果。
 *
 * 抽成纯函数是为了能单测「水/岩浆/落差会不会提前停」——以前这些判定散在
 * 循环里，只能靠真机撞事故。
 */
export type DigStepVerdict =
    | { kind: 'stop'; reason: string }
    | { kind: 'skip_air'; target: { x: number; y: number; z: number } }
    | { kind: 'dig'; target: { x: number; y: number; z: number } };

const DIG_HAZARD_NAMES = new Set(['water', 'lava']);
const DIG_AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/** 连续挖下去最多容忍几格空气；达到这个数就按「落差 >=4」提前停。 */
export const MAX_DIG_FALL_BLOCKS = 4;

function isDigHazard(name: string | undefined | null): boolean {
    return name != null && DIG_HAZARD_NAMES.has(name);
}

/**
 * 判断 digDown 第 depth 格（depth=1 就是正下方那一格）能不能挖。
 *
 * 每轮都必须同时看：机器人当前所在方块、头顶、正下方、目标格、目标格
 * 下方。只查目标格会漏掉「脚下/身侧其实已经进水」「挖穿后会掉进岩浆或深井」
 * 这些真实停不下来的场景。
 */
export function classifyDigDownStep(
    blockAt: (x: number, y: number, z: number) => { name?: string } | null,
    feet: { x: number; y: number; z: number },
    depth: number,
): DigStepVerdict {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const nameAt = (x: number, y: number, z: number): string | null => blockAt(x, y, z)?.name ?? null;

    const atFeet = nameAt(fx, fy, fz);
    if (isDigHazard(atFeet)) return { kind: 'stop', reason: 'current block is ' + String(atFeet) };
    const atHead = nameAt(fx, fy + 1, fz);
    if (isDigHazard(atHead)) return { kind: 'stop', reason: 'head is in ' + String(atHead) };

    const targetY = fy - depth;
    const target = blockAt(fx, targetY, fz);
    if (!target) return { kind: 'stop', reason: 'reached the end of the world' };
    // 目标格是水/岩浆要先报：不能在下方读不到时伪装成 end of world。
    if (isDigHazard(target.name)) return { kind: 'stop', reason: 'reached ' + String(target.name) + ' (not digging into it)' };

    const below = blockAt(fx, targetY - 1, fz);
    if (!below) return { kind: 'stop', reason: 'reached the end of the world' };
    if (isDigHazard(below.name)) return { kind: 'stop', reason: String(below.name) + ' is directly below the target' };

    // 连续空气 = 挖掉目标后会往下掉的落差。达到 4 格就停，绝不冒险。
    let fall = 0;
    let probeY = targetY - 1;
    let probe: { name?: string } | null = below;
    while (probe != null && DIG_AIR_NAMES.has(probe.name ?? '') && fall < MAX_DIG_FALL_BLOCKS) {
        fall++;
        probeY--;
        probe = blockAt(fx, probeY, fz);
    }
    if (fall >= MAX_DIG_FALL_BLOCKS) {
        return { kind: 'stop', reason: 'a drop of ' + String(fall) + '+ blocks below the target' };
    }

    if (DIG_AIR_NAMES.has(target.name ?? '')) {
        return { kind: 'skip_air', target: { x: fx, y: targetY, z: fz } };
    }
    return { kind: 'dig', target: { x: fx, y: targetY, z: fz } };
}

/** 垂直上行单步判据。 */
export type VerticalStepPlan =
    | { kind: 'mine'; target: { x: number; y: number; z: number } }
    | { kind: 'step_forward'; target: { x: number; y: number; z: number } }
    | { kind: 'place_step'; target: { x: number; y: number; z: number } }
    | { kind: 'jump_place' }
    | { kind: 'blocked'; reason: string };

const VERTICAL_PASSABLE = new Set(['air', 'cave_air', 'void_air']);
const VERTICAL_HAZARD = new Set(['water', 'lava']);

function verticalName(block: { name?: unknown } | null | undefined): string | null {
    return typeof block?.name === 'string' ? block.name : null;
}

function isVerticalPassable(name: string | null): boolean {
    return name != null && VERTICAL_PASSABLE.has(name);
}

function verticalHazard(name: string | null): boolean {
    return name != null && VERTICAL_HAZARD.has(name);
}

/**
 * 在背包里挑一个能垫脚的方块。
 *
 * 优先圆石/石头/泥土/木板/原木；排除火把、水桶、岩浆桶、食物/工具这类
 * 放不下或放了没用的东西。
 */
export function choosePillarMaterial(items: Array<{ name?: unknown; count?: unknown }> | null | undefined): string | null {
    const available = new Set<string>();
    for (const item of items ?? []) {
        const name = typeof item?.name === 'string' ? item.name : null;
        const count = typeof item?.count === 'number' ? item.count : 1;
        if (name != null && count > 0) available.add(name);
    }
    const preferred = [
        'cobblestone', 'stone', 'dirt', 'coarse_dirt', 'oak_planks', 'spruce_planks',
        'birch_planks', 'oak_log', 'spruce_log', 'birch_log', 'deepslate', 'andesite',
        'granite', 'diorite', 'netherrack',
    ];
    for (const name of preferred) if (available.has(name)) return name;
    const blockedWords = ['torch', 'water', 'lava', 'bucket', 'sapling', 'seed', 'potion', 'sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'bread', 'apple', 'carrot', 'potato', 'beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'cookie', 'cake', 'stew'];
    const blockedExact = new Set(['bread', 'apple', 'carrot', 'potato', 'beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'cookie', 'cake', 'stew']);
    for (const name of available) {
        if (!blockedExact.has(name) && !blockedWords.some((word) => name.includes(word))) return name;
    }
    return null;
}

/** 柱子上行一步：先保证头顶两格是空的；否则先挖；水/岩浆直接 blocked。 */
export function planPillarStep(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
): VerticalStepPlan {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const head = blockAt(fx, fy + 1, fz);
    const head2 = blockAt(fx, fy + 2, fz);
    const headName = verticalName(head);
    const head2Name = verticalName(head2);
    if (verticalHazard(headName)) return { kind: 'blocked', reason: '头顶就是' + String(headName) };
    if (verticalHazard(head2Name)) return { kind: 'blocked', reason: '头顶上方是' + String(head2Name) };
    if (!isVerticalPassable(headName)) return { kind: 'mine', target: { x: fx, y: fy + 1, z: fz } };
    if (!isVerticalPassable(head2Name)) return { kind: 'mine', target: { x: fx, y: fy + 2, z: fz } };
    return { kind: 'jump_place' };
}

/** 台阶上行一步：优先挖开正前方/头顶，然后跳上前方实心格；空着就放一块垫脚。 */
export function planStairStep(
    blockAt: (x: number, y: number, z: number) => { name?: unknown } | null,
    feet: { x: number; y: number; z: number },
    dx: number,
    dz: number,
): VerticalStepPlan {
    const fx = Math.floor(feet.x);
    const fy = Math.floor(feet.y);
    const fz = Math.floor(feet.z);
    const stepX = fx + Math.sign(dx);
    const stepZ = fz + Math.sign(dz);
    const head = blockAt(fx, fy + 1, fz);
    const head2 = blockAt(fx, fy + 2, fz);
    const headName = verticalName(head);
    const head2Name = verticalName(head2);
    if (verticalHazard(headName)) return { kind: 'blocked', reason: '头顶就是' + String(headName) };
    if (verticalHazard(head2Name)) return { kind: 'blocked', reason: '头顶上方是' + String(head2Name) };
    if (!isVerticalPassable(headName)) return { kind: 'mine', target: { x: fx, y: fy + 1, z: fz } };

    const frontHead = blockAt(stepX, fy + 1, stepZ);
    const frontFeet = blockAt(stepX, fy, stepZ);
    const frontHeadName = verticalName(frontHead);
    const frontFeetName = verticalName(frontFeet);
    if (verticalHazard(frontHeadName)) return { kind: 'blocked', reason: '前方头顶是' + String(frontHeadName) };
    if (verticalHazard(frontFeetName)) return { kind: 'blocked', reason: '前方脚下是' + String(frontFeetName) };
    if (!isVerticalPassable(frontHeadName)) return { kind: 'mine', target: { x: stepX, y: fy + 1, z: stepZ } };
    if (frontFeetName == null) return { kind: 'blocked', reason: '前方区块读不到' };
    if (!isVerticalPassable(frontFeetName)) return { kind: 'step_forward', target: { x: stepX, y: fy, z: stepZ } };
    return { kind: 'place_step', target: { x: stepX, y: fy, z: stepZ } };
}

function forwardDelta(yaw: number): { dx: number; dz: number } {
    // 与项目其它地方一致：yaw=0 面朝南(+Z)，90 面朝西(-X)。
    const dx = -Math.round(Math.sin(yaw));
    const dz = Math.round(Math.cos(yaw));
    if (dx === 0 && dz === 0) return { dx: 0, dz: 1 };
    return { dx, dz };
}

/** 柱子上行：跳起后在脚下放块，适合 digDown 挖出的 1x1 竖井。 */
export async function pillarUp(bot: any, blocks: number = 1): Promise<boolean> {
    const wanted = Math.max(1, Math.floor(blocks));
    const material = choosePillarMaterial(bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }>);
    if (material == null) {
        log(bot, 'pillarUp 失败：背包里没有可垫脚的方块（圆石/石头/泥土/木板/原木都行）。');
        return false;
    }
    log(bot, 'pillarUp 开始：目标 ' + wanted + ' 格，用 ' + material + '，当前 y=' + Number(bot?.entity?.position?.y ?? 0).toFixed(1) + '。');
    if (bot?.interrupt_code) {
        log(bot, 'pillarUp 中断：Stop/保命打断，一步没走。');
        return false;
    }
    if (!(await equip(bot, material))) {
        log(bot, 'pillarUp 失败：拿不到 ' + material + '。');
        return false;
    }
    const deadline = Date.now() + Math.max(30_000, wanted * 8_000);
    let done = 0;
    while (done < wanted) {
        if (bot.interrupt_code) {
            log(bot, 'pillarUp 中断：Stop/保命打断，已完成 ' + done + '/' + wanted + ' 格。');
            return false;
        }
        if (Date.now() > deadline) {
            log(bot, 'pillarUp 超时：已完成 ' + done + '/' + wanted + ' 格，先停在这里。');
            return false;
        }
        const feet = bot.entity.position;
        const blockAt = (x: number, y: number, z: number): { name?: unknown } | null => bot.blockAt(new Vec3(x, y, z));
        const plan = planPillarStep(blockAt, { x: feet.x, y: feet.y, z: feet.z });
        if (plan.kind === 'blocked') {
            log(bot, 'pillarUp 停止：' + plan.reason + '（已完成 ' + done + '/' + wanted + ' 格）。');
            return false;
        }
        if (plan.kind === 'mine') {
            const dug = await breakBlockAt(bot, plan.target.x, plan.target.y, plan.target.z);
            if (!dug) {
                log(bot, 'pillarUp 停止：挖头顶方块失败（已完成 ' + done + '/' + wanted + ' 格）。');
                return false;
            }
            continue;
        }
        const startY = Number(feet.y);
        const startX = Math.floor(feet.x);
        const startZ = Math.floor(feet.z);
        bot.setControlState('jump', true);
        const rose = await waitFor(bot, () => Number(bot?.entity?.position?.y ?? 0) > startY + 0.4, 1200, 40);
        let placed = false;
        if (rose) {
            placed = await placeBlock(bot, material, startX, Math.floor(startY), startZ, 'bottom', true);
        }
        bot.setControlState('jump', false);
        if (!placed) {
            log(bot, 'pillarUp 第 ' + (done + 1) + ' 格失败：没能把 ' + material + ' 垫到脚下。');
            return false;
        }
        await waitFor(bot, () => bot?.entity?.onGround === true, 2500, 50);
        done++;
        log(bot, 'pillarUp 进度 ' + done + '/' + wanted + '：现在 y=' + Number(bot.entity.position.y).toFixed(1) + '。');
    }
    log(bot, 'pillarUp 完成：上升 ' + done + ' 格。');
    return true;
}

/** 台阶上行：挖开前方/头顶，跳上高一层的实心格；空着就放一块垫脚。 */
export async function stairUp(bot: any, blocks: number = 1): Promise<boolean> {
    const wanted = Math.max(1, Math.floor(blocks));
    const material = choosePillarMaterial(bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }>);
    log(bot, 'stairUp 开始：目标 ' + wanted + ' 格，材质 ' + (material ?? '无（只能挖台阶）') + '，当前 y=' + Number(bot?.entity?.position?.y ?? 0).toFixed(1) + '。');
    const deadline = Date.now() + Math.max(30_000, wanted * 8_000);
    let done = 0;
    while (done < wanted) {
        if (bot.interrupt_code) {
            log(bot, 'stairUp 中断：Stop/保命打断，已完成 ' + done + '/' + wanted + ' 格。');
            return false;
        }
        if (Date.now() > deadline) {
            log(bot, 'stairUp 超时：已完成 ' + done + '/' + wanted + ' 格，先停在这里。');
            return false;
        }
        const feet = bot.entity.position;
        const dir = forwardDelta(Number(bot?.entity?.yaw ?? 0));
        const blockAt = (x: number, y: number, z: number): { name?: unknown } | null => bot.blockAt(new Vec3(x, y, z));
        const plan = planStairStep(blockAt, { x: feet.x, y: feet.y, z: feet.z }, dir.dx, dir.dz);
        if (plan.kind === 'blocked') {
            log(bot, 'stairUp 停止：' + plan.reason + '（已完成 ' + done + '/' + wanted + ' 格）。');
            return false;
        }
        if (plan.kind === 'mine') {
            const dug = await breakBlockAt(bot, plan.target.x, plan.target.y, plan.target.z);
            if (!dug) {
                log(bot, 'stairUp 停止：挖 ' + plan.target.x + ',' + plan.target.y + ',' + plan.target.z + ' 失败（已完成 ' + done + '/' + wanted + ' 格）。');
                return false;
            }
            continue;
        }
        if (plan.kind === 'place_step') {
            if (material == null) {
                log(bot, 'stairUp 停止：前方要垫脚但背包里没有方块。');
                return false;
            }
            const placed = await placeBlock(bot, material, plan.target.x, plan.target.y, plan.target.z, 'bottom', true);
            if (!placed) {
                log(bot, 'stairUp 停止：前方垫脚失败。');
                return false;
            }
        }
        const beforeY = Number(feet.y);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await new Promise<void>((resolve) => setTimeout(resolve, 700));
        bot.setControlState('jump', false);
        bot.setControlState('forward', false);
        if (Number(bot.entity.position.y) <= beforeY + 0.4) {
            log(bot, 'stairUp 第 ' + (done + 1) + ' 格失败：跳不上去（前方可能被挡或高度太大）。');
            return false;
        }
        done++;
        log(bot, 'stairUp 进度 ' + done + '/' + wanted + '：现在 y=' + Number(bot.entity.position.y).toFixed(1) + '。');
    }
    log(bot, 'stairUp 完成：上升 ' + done + ' 格。');
    return true;
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
    const blockAt = (x: number, y: number, z: number): { name?: string } | null =>
        bot.blockAt(new Vec3(x, y, z));

    for (let i = 1; i <= distance; i++) {
        // Stop / 保命打断要先于下一铲：不然 ActionManager.stop 只能等 10 秒
        // 再杀进程，整晚反复回出生点。
        if (bot.interrupt_code) {
            log(bot, 'Dug down ' + (i - 1) + ' blocks, but Stop was requested (stopping before digging further).');
            return false;
        }

        // 每一轮都从机器人「现在」的位置重新取列——挖下去会横向漂移，不能
        // 拿起点那一列去检查脚下的岩浆。
        const feet = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z };
        const verdict = classifyDigDownStep(blockAt, feet, i);

        if (verdict.kind === 'stop') {
            log(bot, 'Dug down ' + (i - 1) + ' blocks, but stopped: ' + verdict.reason + '.');
            return false;
        }
        if (verdict.kind === 'skip_air') {
            log(bot, 'Skipping air block at (' + verdict.target.x + ',' + verdict.target.y + ',' + verdict.target.z + ').');
            continue;
        }

        const dug: boolean = await breakBlockAt(bot, verdict.target.x, verdict.target.y, verdict.target.z);
        if (!dug) {
            log(bot, 'Dug down ' + (i - 1) + ' blocks, failed to dig block at (' + verdict.target.x + ',' + verdict.target.y + ',' + verdict.target.z + ').');
            return false;
        }
        log(bot, 'Dug down ' + i + '/' + distance + ' blocks (broke (' + verdict.target.x + ',' + verdict.target.y + ',' + verdict.target.z + ')).');
    }
    log(bot, 'Dug down ' + distance + ' blocks.');
    return true;
}
export async function goToSurface(bot: any): Promise<boolean> {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached, false otherwise.
     **/
    const pos: any = bot.entity.position;
    for (let y = 360; y > -64; y--) {
        const block: any = bot.blockAt(new (Vec3 as any)(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air') {
            continue;
        }
        const targetY: number = block.position.y + 1;
        const dy: number = targetY - pos.y;
        log(bot, 'goToSurface：地表在 y=' + targetY + '（' + block.name + '），高差 ' + dy.toFixed(1) + ' 格。');
        if (bot.interrupt_code) {
            log(bot, 'goToSurface 中断：Stop/保命打断，一步没走。');
            return false;
        }
        if (dy >= 4) {
            const material = choosePillarMaterial(bot?.inventory?.items?.() as Array<{ name?: unknown; count?: unknown }>);
            const need = Math.ceil(dy);
            log(bot, 'goToSurface：高差 ' + dy.toFixed(1) + ' 格，先用 ' + (material != null ? 'pillarUp' : 'stairUp') + ' 垂直上行 ' + need + ' 格。');
            const climbed = material != null ? await pillarUp(bot, need) : await stairUp(bot, need);
            if (bot.interrupt_code) {
                log(bot, 'goToSurface 中断：垂直上行被 Stop/保命打断。');
                return false;
            }
            if (!climbed) {
                log(bot, 'goToSurface：垂直上行没能完成，继续尝试普通寻路（失败会说明卡在哪）。');
            }
        }
        const arrived = await goToPosition(bot, block.position.x, targetY, block.position.z, 0);
        if (!arrived) {
            log(
                bot,
                'Surface is at y=' + targetY + ' (' + block.name + ') but I could not get up there from here. 竖井/洞穴里常这样——用 stairUp/pillarUp 垂直上行，或者 mineBlock 挖头顶开路。',
            );
            return false;
        }
        log(bot, 'Reached the surface at y=' + targetY + '.');
        return true;
    }
    log(bot, 'goToSurface 失败：当前竖列读不到任何实心方块（区块可能没加载）。');
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
    // **手上没有这个东西要立刻说。** 原来这里还挂了一个 `(!gameMode) === 'creative'`
    // 的条件——那是 `(!undefined) === 'creative'` 即 `true === 'creative'`，**恒为
    // false**，于是这个分支从来没进过。结果：模型没带桶却去装水，一条回执都没有
    // （"既不说成功也不说失败"，它因此白试了两次）。
    const hasItem: boolean = toolName === 'hand' ||
        ((bot.inventory?.slots ?? []) as Array<{ name?: string }>).some((slot) => slot?.name === toolName);
    if (!hasItem && bot.game?.gameMode !== 'creative') {
        log(bot, `You do not have any ${toolName} to use.（背包里没有这个东西，先拿到手再说）`);
        return false;
    }

    targetName = targetName.toLowerCase();

    // **危险操作闸门必须放在最前**，覆盖全部三个分支。
    // 教训来自真机：模型用 useOn(flint_and_steel, "nothing") 点火，那条走的是
    // `targetName === 'nothing'` 分支，**根本不经过 useToolOnBlock** —— 闸门加在下层
    // 就等于没加，回执直接是 "Equipped flint_and_steel. / Used flint_and_steel."，零拦截。
    if (toolName === 'water_bucket' || toolName === 'lava_bucket') {
        if (!allowDangerousOp(bot, toolName === 'water_bucket' ? 'pour_water' : 'pour_lava')) return false;
    }
    if (toolName === 'flint_and_steel' && !allowDangerousOp(bot, 'ignite')) return false;

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
            // **要水源方块**（流动水装不进桶），但**不能因为"够近的那格不是水源"就跑去远处**。
            //
            // 模型真机实测（成功率 1/4）：站在 (43.4,63,1.6)、**脚下 1.6 格就是水**，
            // useOn(bucket,"water") 却跑去 **16 格外的 (27,62,7)** 并失败。原因是这里只认
            // `metadata === 0` 的方块，近处那格没被匹配上，就一路找到远处去了。
            //
            // 改成：**近处的任何水/岩浆优先**（桶能不能装由服务端说了算，失败了下面会
            // 如实报），只有近处完全没有时才去找水源方块。
            const anyLiquid: any[] = world.getNearestBlocksWhere(bot, (b: any) => b.name === targetName, 64, 8);
            const source: any = anyLiquid.find((b: any) => b.metadata === 0) ?? null;
            const nearest: any = anyLiquid[0] ?? null;
            if (nearest == null && source == null) {
                log(bot, `Could not find any ${targetName} within 64 blocks.`);
                return false;
            }
            // **桶只认水源方块**——流动水（`metadata !== 0`）在原版里就装不进桶，
            // 用它是注定失败的。以前为了"别跑远"会优先选近处**任意**液体，结果
            // 常选中流动水：回执写着 NOT a source block，却还是对它用了桶，然后
            // 把失败归因成"准星没对准"——模型按这个提示连试 6 次（Feedback 实测）。
            //
            // 所以：**近处有水源就用近处的；近处只有流动水，就明说并去找水源**。
            const nearSource: any =
                source != null && bot.entity.position.distanceTo(source.position) <= 6 ? source : null;
            block = nearSource ?? source ?? nearest;
            const chosenDist: number = bot.entity.position.distanceTo(block.position);
            if (block.metadata !== 0) {
                log(
                    bot,
                    `附近只有流动${targetName === 'water' ? '水' : '岩浆'}（${block.position}，${chosenDist.toFixed(1)} 格）——` +
                        `流动水装不进桶，得找**源头方块**（平静的、不流动的那一格）。` +
                        `64 格内${source == null ? '也没有找到源头方块' : `最近的源头在 ${source.position}`}。`,
                );
            } else {
                log(bot, `Using ${block.name} at ${block.position} (${chosenDist.toFixed(1)} blocks away, source block).`);
            }
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
    // **够得着就别走**。原来无条件先 goToPosition 走过去，而模型真机踩过这个坑：
    // "灌水失败时它为了够到水面重新寻路，结果把人带偏 20 多格"——本来站在水边
    // 1.5 格内，一走路反而走丢了。她的 workaround 就是"原地重试"，那本该是默认行为。
    const reach: number = bot.entity.position.distanceTo(block.position);
    if (reach > 4) {
        await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    } else {
        log(bot, `Already within ${reach.toFixed(1)} blocks of ${block.name}, using it from here.`);
    }
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);

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
        // **多试几个站位，别只随机试一个就放弃**。模型真机被这条卡过两次：
        // 'Block stone is in the way, not using water_bucket'——它在岩浆层上方倒水，
        // 准星被脚下的石头挡住，只试一个随机位置就返回失败，于是整条下界门链停住。
        // 围着目标绕一圈试 4 个方向，最后再退一步正对着看。
        log(bot, `Block ${blockInView.name} is in the way, trying other spots...`);
        const bx: number = block.position.x;
        const by: number = block.position.y;
        const bz: number = block.position.z;
        const spots: Array<[number, number, number]> = [
            [bx + 1, by, bz],
            [bx - 1, by, bz],
            [bx, by, bz + 1],
            [bx, by, bz - 1],
            [bx + 1, by, bz + 1],
            [bx - 1, by, bz - 1],
        ];
        for (const [sx, sy, sz] of spots) {
            try {
                await goToPosition(bot, sx, sy, sz, 1);
                await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
            } catch {
                continue;
            }
            if (!viewBlocked()) break;
        }
        if (viewBlocked()) {
            const blocked: any = bot.blockAtCursor(5);
            log(
                bot,
                `Block ${blocked?.name ?? '?'} is in the way, not using ${toolName}. ` +
                    '试了目标四周 6 个站位都被挡——先 mineBlock 挖掉挡路的那一格，或者换一个能正对着的目标再来。',
            );
            return false;
        }
    }

    const equipped: boolean = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    // **倒水 / 倒岩浆 / 点火默认禁止**。注意区分：
    //   - 倒水/倒岩浆：传的是 water_bucket / lava_bucket
    //   - 打水（把空桶灌满）：传的是 bucket —— 这个闸门**不拦**，主线照常
    if (toolName === 'water_bucket' || toolName === 'lava_bucket') {
        if (!allowDangerousOp(bot, toolName === 'water_bucket' ? 'pour_water' : 'pour_lava')) return false;
    }
    if (toolName === 'flint_and_steel' && !allowDangerousOp(bot, 'ignite')) return false;

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
                // **归因要对。** 对流动水用桶本来就不可能成功，怪"准星没对准"
                // 会让模型一直对着它重试（它自述重试了 6 次）。
                block.metadata !== 0 && (block.name === 'water' || block.name === 'lava')
                    ? `对 ${block.name} 用了 ${toolName}，没装进去：**这是流动水/岩浆，桶装不了**——要找源头方块（不流动的那一格）。` +
                        `换一个目标，别对着它再试。`
                    : `对 ${block.name} 用了 ${toolName}，但物品没变化——准星多半没真的对着它（或者够不着/被方块挡住）。往目标挪近、正对着再来一次。`,
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

// ── 原子动作 ────────────────────────────────────────────────────────────────
/**
 * 比 `goToXxx` / `collectBlocks` 低一档的动作：跳一下、挪几格、转个头、蹲下。
 *
 * 为什么要有这一层：高层命令（"去那里""挖这个"）解决的是"任务"，而模型经常
 * 卡在"我只要往前一步""我得先抬头看一眼"这种**单步**上。没有单步原语，它就只能
 * 用一个重得多的命令去表达一个轻动作，代价是每次都要占住身体好几秒。
 *
 * 两条规则是照着 VLM-Bot 的 vendored Baritone（`motionCommands.js` /
 * `observationCommands.js`）抄的，那两条的理由都写得很实在：
 *
 * 1. **键位随动作释放。** `moveBy(..., 'sneak')` 在动作结束（到达 / 被挡 / 被打断）
 *    时一定松手。让调用方自己记住"再站起来"的接口，调用方一定会忘——而忘了的
 *    后果是**永远蹲着走路**。长住的姿态另有 `setPosture`，与"这一次移动"分开。
 * 2. **一个动作占住身体，别人别抢。** 一边按着方向键、一边又有寻路器在驱动同一具
 *    身体，结果是"既没走向你指的地方，也没走向它要去的地方"。所以这些动作走
 *    身体通道（`runAsAction`），跑着的时候别人插不进来——这一条和 `lookAtXxx`
 *    要占通道是同一个理由。
 *
 * 另外：**这里没有"秒"这个参数。** 模型没有时钟（VLM-Bot 的原话），所以参数只有
 * 方向、距离、角度、次数。超时全是实现里的兜底，不进接口。
 */

/**
 * **能直接 `bot.openContainer()` 的方块**（mineflayer `chest.js` 的白名单）。
 * 不在这张表里的方块，`openContainer` 会抛
 * `containerToOpen is neither a block nor an entity`——**哪怕传进去的是完全正确的 Block**。
 */
export const CONTAINER_BLOCKS_OPENABLE = Object.freeze([
    'chest', 'trapped_chest', 'barrel', 'ender_chest', 'hopper', 'dispenser', 'dropper',
]);

/** **有自己入口的加工方块**（mineflayer `furnace.js` 的白名单）——走 `bot.openFurnace()`。 */
export const FURNACE_LIKE_BLOCKS = Object.freeze(['furnace', 'blast_furnace', 'smoker']);

/**
 * 打开一个方块的界面。**必须按类型分路**——这是这条链上最要紧的一件事。
 *
 * ## 为什么非要有这个函数（被错误信息骗了两次）
 *
 * `bot.openContainer()` 内部有一张**白名单**（`mineflayer/lib/plugins/chest.js`）：
 *
 * ```
 * generic / chest / dispenser / ender_chest / shulker_box(各色) /
 * hopper / container / dropper / trapped_chest / barrel
 * ```
 *
 * **熔炉、高炉、烟熏炉、工作台、铁砧、酿造台、附魔台都不在里面。**
 * 所以 `openContainer(furnaceBlock)` **必然**抛错，抛的还是那句极误导的
 * `containerToOpen is neither a block nor an entity`：它把"参数不对"写进了错误信息，
 * 而真相是"这个方块类型不走这条路"。
 *
 * 这句误导线**骗过两次修复**（`ae8f04d` 怀疑"要传 Block 不能传裸坐标"、
 * `d045e86` 怀疑"`blockAt` 返回了 null"）——两次都合理，两次都不可能生效。
 * 模型在真机上连着报了几条 Feedback 说"熔炉 100% 用不了"，方向一直是对的。
 *
 * 熔炉族有自己的入口 `bot.openFurnace()`（`furnace.js` 里它自己那张白名单就是
 * furnace / blast_furnace / smoker），返回的对象带
 * `inputItem()/fuelItem()/outputItem()/putInput/putFuel/takeOutput`。
 *
 * 工作台**没有"打开"这一说**——合成要经 `bot.craft(recipe, n, tableBlock)`，
 * 也就是 `craftRecipe`。所以这里如实报错，而不是让调用方去开一个开不了的界面。
 */
export async function openBlockUi(bot: any, block: any): Promise<any> {
    const name = String(block?.name ?? '');
    if (name === '') throw new Error('要打开的那一格读不到方块类型。');
    if (FURNACE_LIKE_BLOCKS.includes(name)) {
        if (typeof bot?.openFurnace !== 'function') {
            throw new Error(`这个 mineflayer 版本没有 openFurnace，开不了 ${name}。`);
        }
        return await bot.openFurnace(block);
    }
    if (CONTAINER_BLOCKS_OPENABLE.includes(name) || name.endsWith('shulker_box')) {
        return await bot.openContainer(block);
    }
    throw new Error(
        `${name} 没有"打开界面"这个操作。能打开的只有箱子/陷阱箱/木桶/末影箱/漏斗/发射器/投掷器/潜影盒；`
            + `熔炉/高炉/烟熏炉走 useBlock 的 input/output（投料、取货）。`
            + `工作台合成用 craft。`,
    );
}

/** 等一个条件成立；超时返回 false。轮询期间尊重打断。 */
export async function waitFor(
    bot: any,
    ready: () => boolean,
    timeoutMs: number,
    intervalMs: number = 50,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (bot?.interrupt_code) return false;
        try {
            if (ready()) return true;
        } catch {
            // 身体还没就绪（bot.entity 是 undefined）：当作条件不成立，继续等。
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

/** 水平位移（格）。竖直方向不算——跳起落下不该被算成"走了几格"。 */
function horizontalDistance(from: any, to: any): number {
    const dx = (to?.x ?? 0) - (from?.x ?? 0);
    const dz = (to?.z ?? 0) - (from?.z ?? 0);
    return Math.hypot(dx, dz);
}

/**
 * 跳一次。
 *
 * **离地就松开跳跃键**：一直按着会变成原地反复弹跳——模型看不出区别，但录像里
 * 很蠢，而且落点不可控。落地才算完成。
 */
export async function jump(bot: any): Promise<boolean> {
    if (bot == null || typeof bot.setControlState !== 'function') return false;
    bot.setControlState('jump', true);
    const leftGround = await waitFor(bot, () => bot.entity?.onGround === false, 1200);
    bot.setControlState('jump', false);
    if (!leftGround) {
        log(bot, '跳不起来：可能头顶被方块挡住了。');
        return false;
    }
    const landed = await waitFor(bot, () => bot.entity?.onGround === true, 3000);
    log(bot, landed ? '跳了一下，已经落地。' : '跳起来后 3 秒还没落地（可能掉进洞里了）。');
    return landed;
}

/** `moveBy` 认的方向。相对方向按当前朝向算，绝对方向按世界坐标算。 */
export const MOVE_DIRECTIONS = Object.freeze([
    'forward', 'back', 'left', 'right',
    'north', 'south', 'east', 'west',
] as const);

export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

/** 相对/绝对方向 → 世界坐标下的单位向量（+X 东，+Z 南，与 Minecraft 一致）。 */
function worldVectorFor(bot: any, direction: MoveDirection): { x: number; z: number } {
    switch (direction) {
        case 'north': return { x: 0, z: -1 };
        case 'south': return { x: 0, z: 1 };
        case 'east': return { x: 1, z: 0 };
        case 'west': return { x: -1, z: 0 };
        default: break;
    }
    // 相对方向：把"我的前/右"投影到世界坐标。
    // 偏航角 0 面朝南（+Z），90 面朝西（-X）——Minecraft 的约定。
    const yaw = ((bot?.entity?.yaw ?? 0) * Math.PI) / 180;
    const forward = { x: -Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: -Math.cos(yaw), z: -Math.sin(yaw) };
    const sign = direction === 'back' ? -1 : 1;
    const axis = direction === 'forward' || direction === 'back' ? forward : right;
    return { x: axis.x * sign, z: axis.z * sign };
}

/**
 * 往某个方向挪一小段。**不改变朝向**——绝对方向也是靠换算成"前/后/左/右"来走，
 * 所以模型一边看某个方向一边挪是可能的。
 *
 * 结束条件三个（谁先到算谁）：走满距离、卡住（半秒没有格级位移）、超时兜底。
 * 无论怎么结束**都会松掉所有键**，这是这个函数存在的意义。
 */
export async function moveBy(
    bot: any,
    direction: MoveDirection,
    distance: number,
    mode: 'walk' | 'sprint' | 'sneak' = 'walk',
): Promise<boolean> {
    if (bot == null || typeof bot.setControlState !== 'function') return false;
    if (!MOVE_DIRECTIONS.includes(direction)) {
        log(bot, `不认识的方向 ${direction}；可用：${MOVE_DIRECTIONS.join('、')}。`);
        return false;
    }
    // 上限兜底：走远路是 goToCoordinates 的活，这里只做"挪几格"。
    const MAX_STEP = 64;
    if (!(distance > 0) || distance > MAX_STEP) {
        log(bot, `距离要大于 0 且不超过 ${MAX_STEP} 格（更远请用 goToCoordinates），收到的是 ${distance}。`);
        return false;
    }
    const vector = worldVectorFor(bot, direction);
    const yaw = ((bot?.entity?.yaw ?? 0) * Math.PI) / 180;
    const forward = { x: -Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: -Math.cos(yaw), z: -Math.sin(yaw) };
    // 世界方向 → 我该按哪几个键（前/右 分量各自过阈值；斜向会同时按两个键）。
    const along = vector.x * forward.x + vector.z * forward.z;
    const across = vector.x * right.x + vector.z * right.z;
    const pressed: string[] = [];
    if (along > 0.3) pressed.push('forward');
    if (along < -0.3) pressed.push('back');
    if (across > 0.3) pressed.push('right');
    if (across < -0.3) pressed.push('left');
    if (mode === 'sneak') pressed.push('sneak');
    if (mode === 'sprint') pressed.push('sprint');

    const start = { x: bot.entity?.position?.x ?? 0, z: bot.entity?.position?.z ?? 0 };
    const startedAt = Date.now();
    // 兜底超时：按最慢的蹲行（约 1.3 格/秒）再留一倍余量。
    const timeoutMs = Math.max(3000, (distance / 1.3) * 1000 * 2 + 2000);
    let lastProgressAt = startedAt;
    let lastDistance = 0;
    let moved = 0;

    try {
        for (const key of pressed) bot.setControlState(key, true);
        while (true) {
            if (bot.interrupt_code) break;
            const now = Date.now();
            const here = { x: bot.entity?.position?.x ?? 0, z: bot.entity?.position?.z ?? 0 };
            moved = horizontalDistance(start, here);
            if (moved >= distance - 0.2) break;
            if (moved > lastDistance + 0.05) {
                lastDistance = moved;
                lastProgressAt = now;
            } else if (now - lastProgressAt > 500) {
                break; // 卡住了（墙、栅栏、坑沿…）
            }
            if (now - startedAt > timeoutMs) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    } finally {
        // **一定松手**：不管是走满、卡住、超时还是被 Stop 打断。
        for (const key of pressed) {
            try {
                bot.setControlState(key, false);
            } catch {
                // 已经断线之类，尽力而为。
            }
        }
    }

    const rounded = Math.round(moved * 10) / 10;
    if (moved >= distance - 0.2) {
        log(bot, `朝${direction}走了 ${rounded} 格（目标 ${distance} 格）${mode === 'sneak' ? '，走完已站起' : ''}。`);
        return true;
    }
    log(bot, `朝${direction}只挪了 ${rounded} 格（目标 ${distance} 格）就被挡住了或没进展。`);
    return false;
}

/**
 * 长住的姿态：蹲下 / 站起来。
 *
 * 和 `moveBy` 的 `sneak` 模式分开：那个是"蹲着走这一段，走完自己站起来"，
 * 这个是"从今往后蹲着"，**只有再叫一次或 Stop 才会解除**。多数情况该用前者。
 *
 * **它不走身体通道**，所以也不写 `bot.output`——瞬时状态改变不是任务
 * （VLM-Bot 那边同样把 posture 划在"不是 running task"里）。回执直接返回。
 */
export function setPosture(bot: any, posture: string): string {
    if (bot == null || typeof bot.setControlState !== 'function') return '身体还没就绪。';
    if (posture === 'sneak' || posture === 'crouch' || posture === '蹲') {
        bot.setControlState('sneak', true);
        return '开始保持潜行（蹲下）；要站起来用 posture stand。';
    }
    if (posture === 'stand' || posture === '站') {
        bot.setControlState('sneak', false);
        return '站起来了，不再潜行。';
    }
    return `不认识的姿态 ${posture}；可用：sneak（蹲下）、stand（站起）。`;
}

/** 方位名 → 偏航角。角度是 Minecraft 的约定：0 面朝南，90 朝西，180 朝北，-90 朝东。 */
const DIRECTION_YAW: Record<string, number> = {
    south: 0,
    west: 90,
    north: 180,
    east: -90,
};

/**
 * 把视角转到某个方位（北/南/东/西），或者抬到正上/正下。
 *
 * 和 `lookAtPosition` 的分工：那个是"看向某个坐标"（要算角度），这个是"朝向某个
 * 方位"——模型想说"面朝北"时不该被迫先算一个坐标出来。
 */
export async function lookInDirection(bot: any, direction: string, pitch?: number): Promise<boolean> {
    if (bot == null || typeof bot.look !== 'function') return false;
    const name = String(direction ?? '').trim().toLowerCase();
    const currentYaw = bot.entity?.yaw ?? 0;
    if (name === 'up' || name === 'down') {
        const target = name === 'up' ? -90 : 90;
        await bot.look(currentYaw, target, true);
        log(bot, `视角转到朝${name === 'up' ? '上' : '下'}。`);
        return true;
    }
    const yaw = DIRECTION_YAW[name];
    if (yaw == null) {
        log(bot, `不认识的方位 ${direction}；可用：north、south、east、west、up、down。`);
        return false;
    }
    const targetPitch = typeof pitch === 'number' ? Math.max(-90, Math.min(90, pitch)) : 0;
    await bot.look(yaw, targetPitch, true);
    log(bot, `视角转到朝${name}（水平${targetPitch === 0 ? '平视' : `俯仰 ${targetPitch}°`}）。`);
    return true;
}

/**
 * 在当前视角上转一个增量（度）。俯仰被夹在 ±90 之间。
 *
 * 为什么要有增量版：模型看到画面里的东西在左边一点点，它想"再往左转一点"，
 * 这时算绝对角度既麻烦又容易错。
 */
export async function turnView(bot: any, yawDelta: number, pitchDelta: number = 0): Promise<boolean> {
    if (bot == null || typeof bot.look !== 'function') return false;
    const yaw = (bot.entity?.yaw ?? 0) + yawDelta;
    const pitch = Math.max(-90, Math.min(90, (bot.entity?.pitch ?? 0) + pitchDelta));
    await bot.look(yaw, pitch, true);
    log(bot, `视角转了 水平 ${yawDelta}°、俯仰 ${pitchDelta}°。`);
    return true;
}

/**
 * 准星指着的那个东西是什么。**只读，不占身体通道。**
 *
 * 这是模型问得最多的三个问题之一（另两个是"我朝哪"和"那东西在哪"），
 * 而它从截图里读不出来——画面里那点像素看不出方块名和坐标。
 */
export function inspectAimed(bot: any, maxDistance: number = 5): string {
    if (bot == null) return '身体还没就绪。';
    const lines: string[] = [];
    let block: any;
    try {
        block = bot.blockAtCursor?.(maxDistance) ?? null;
    } catch {
        block = null;
    }
    if (block != null) {
        const p = block.position ?? {};
        lines.push(`准星指着方块 ${block.name} @(${p.x}, ${p.y}, ${p.z})`);
    }
    let entity: any;
    try {
        entity = bot.entityAtCursor?.(maxDistance) ?? null;
    } catch {
        entity = null;
    }
    if (entity != null) {
        lines.push(`准星指着实体 ${entity.name ?? entity.username ?? entity.type}（距离 ${entity.distance ?? '未知'}）`);
    }
    if (lines.length === 0) {
        return `${maxDistance} 格内的准星方向什么都没有（对着空气或太远）。`;
    }
    return lines.join('；') + '。';
}
