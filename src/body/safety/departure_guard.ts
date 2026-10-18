/**
 * **出发前准备检查**：末地 / 下界是"单向 + 致死地形"的旅程，不能空手走进去。
 *
 * 真机 2026-10-19 07:00：overnight_a 走过虚空桥、第一次踏上末地主岛（当晚最远进度），
 * 随后 `was slain by Enderman`——**死亡背包里只有 dirt×10：没有武器、没有盾、没有食物**。
 * 它是一路空手走进 40 血、每下 4-7 伤害的末影人堆里的。
 *
 * 食物那条（<12 不许进下界）一直是**人在聊天里说**的，说了好几次仍然发生；今天所有
 * 真正生效的约束都是**引擎强制**的。所以这一条进引擎。
 *
 * 三条纪律：
 *   ① **只拦"进去"**：`returnFromEnd` 之类的出口、逃跑、保命反射、甚至故意死，
 *      永远不受这条限制——已经在里面的人绝不能被它困住；
 *   ② **粗糙检查**（有没有武器、有没有吃的、有没有垫脚方块、血够不够），
 *      不做配装优化；
 *   ③ **能救就救**：武器在包里没拿在手上 ⇒ 帮它 `equip`，然后放行，而不是拒绝。
 */

/** 进维度类工具：只有这些会被检查。 */
export const DEPARTURE_TOOLS: ReadonlySet<string> = new Set(['enterEnd', 'enterNether']);

/** 硬性红线（明显必死）：没武器 / 食物 ≤2 / 方块 <8。 */
export const MIN_FOOD_HARD = 2;
export const MIN_BLOCKS_HARD = 8;
/** 建议值（低于这个数只警告，不拦）。 */
export const MIN_FOOD_SUGGESTED = 12;
export const MIN_BLOCKS_SUGGESTED = 16;
export const MIN_HEALTH_SUGGESTED = 12;

export interface DepartureFacts {
    tool: string;
    /** 当前维度（已经是目标维度 ⇒ 这不是"进入"，一律放行）。 */
    dimension: string | null;
    health: number | null;
    food: number | null;
    /** 背包里的武器名（剑/斧/三叉戟），读不到 = null。 */
    weapon: string | null;
    /** 背包里可垫脚的方块总数；读不到 = null（读不到就不拿它当拒绝理由）。 */
    blocks: number | null;
}

export interface DepartureVerdict {
    allowed: boolean;
    /** 放行但低于建议值时给一句响亮的提醒。 */
    warning?: string;
    /** 拒绝时给模型的完整回执（含补齐清单 + 一个下一步）。 */
    text?: string;
}

/** 这个物品名算不算"能打"的武器。 */
export function isWeaponName(name: unknown): boolean {
    if (typeof name !== 'string') return false;
    const value = name.trim().toLowerCase();
    if (value === '') return false;
    return value.endsWith('_sword') || value.endsWith('_axe') || value === 'trident' || value === 'bow' || value === 'crossbow';
}

/** 目标维度的名字（用于"已经是目标维度就不拦"的判定）。 */
export function targetDimensionOf(tool: string): string | null {
    if (tool === 'enterEnd') return 'the_end';
    if (tool === 'enterNether') return 'the_nether';
    return null;
}

function inDimension(dimension: string | null, target: string | null): boolean {
    if (dimension == null || target == null) return false;
    return dimension.toLowerCase().includes(target);
}

function placeLabel(tool: string): string {
    return tool === 'enterEnd' ? '末地' : '下界';
}

/**
 * 能不能出发。**先看出口/已经在里面，再看准备情况**——顺序反了就会把里面的人困住。
 */
export function departureVerdict(facts: DepartureFacts): DepartureVerdict {
    if (!DEPARTURE_TOOLS.has(facts.tool)) return { allowed: true };
    const target = targetDimensionOf(facts.tool);
    // 已经在目标维度：这不是"进入"（出口类工具根本不在名单里），一律放行。
    if (inDimension(facts.dimension, target)) return { allowed: true };

    const place = placeLabel(facts.tool);
    const health = facts.health;
    const food = facts.food ?? 0;
    const blocks = facts.blocks;
    const hasWeapon = facts.weapon != null && facts.weapon !== '';

    const missing: string[] = [];
    if (!hasWeapon) {
        missing.push(
            facts.tool === 'enterEnd'
                ? '**没有武器**（末影人 40 血、每下 4-7 伤害，空手必死）'
                : '**没有武器**（下界的猪灵/猪灵蛮兵/烈焰人都会主动打你）',
        );
    }
    if (food <= MIN_FOOD_HARD) missing.push(`**食物 ${Math.round(food)}**（进去就没有回血手段）`);
    if (blocks != null && blocks < MIN_BLOCKS_HARD) {
        missing.push(`**垫脚方块只有 ${blocks} 个**（末地虚空桥/下界跨岩浆都要垫，至少 ${MIN_BLOCKS_HARD} 个）`);
    }
    if (health != null && health < MIN_HEALTH_SUGGESTED && missing.length > 0) {
        missing.push(`血量 ${Math.round(health * 10) / 10}（低于建议的 ${MIN_HEALTH_SUGGESTED}）`);
    }

    const hardRefuse = !hasWeapon || food <= MIN_FOOD_HARD || (blocks != null && blocks < MIN_BLOCKS_HARD);
    if (hardRefuse) {
        const wantBlocks = facts.tool === 'enterEnd' ? 32 : 16;
        const prep: string[] = [];
        if (!hasWeapon) prep.push('`equip(item_name="…")`（先做/找一把剑或斧）');
        if (food <= MIN_FOOD_SUGGESTED) prep.push('`getFood()` / `consume(item_name="…")` 把食物补到 12 以上');
        if (blocks == null || blocks < MIN_BLOCKS_SUGGESTED)
            prep.push(`\`collectBlocks(type="dirt", num=${wantBlocks})\` 收集 ${wantBlocks} 个方块`);
        if (health != null && health < MIN_HEALTH_SUGGESTED) prep.push('先把血回到 12 以上（吃食物）');
        return {
            allowed: false,
            text:
                `**拒绝进${place}**：` +
                (missing.length > 0 ? missing.join('、') : '准备不足') +
                `。先补齐：${prep.join('；')}，然后再 \`${facts.tool}()\`。\n    ` +
                `下一步（照做即可）：${
                    !hasWeapon
                        ? '先弄到武器——`craft` 一把石剑（2 圆石 + 1 木棍）或从箱子里取；'
                        : food <= MIN_FOOD_SUGGESTED
                            ? '`getFood()`（或 `consume`）先把食物补够；'
                            : `\`collectBlocks(type="dirt", num=${wantBlocks})\` 先攒垫脚方块；`
                }\n    ` +
                '**出口/逃跑不受这条限制**：`returnFromEnd` 之类、保命反射、甚至故意死，都随时可用——已经在里面的人不会被它困住。',
        };
    }

    // 放行：低于建议值就给一句响亮提醒（不拦）。
    const warnings: string[] = [];
    if (food < MIN_FOOD_SUGGESTED) {
        warnings.push(`你食物只有 ${Math.round(food)}，${place}里**没有食物来源**——进去之前最好补到 ${MIN_FOOD_SUGGESTED}。`);
    }
    if (blocks != null && blocks < MIN_BLOCKS_SUGGESTED) {
        warnings.push(`垫脚方块只有 ${blocks} 个（建议 ≥${MIN_BLOCKS_SUGGESTED}）：虚空桥/跨岩浆一旦不够就会卡在中间。`);
    }
    if (health != null && health < MIN_HEALTH_SUGGESTED) {
        warnings.push(`血量 ${Math.round(health * 10) / 10} 低于建议的 ${MIN_HEALTH_SUGGESTED}，挨一下就危险。`);
    }
    return warnings.length > 0 ? { allowed: true, warning: `⚠️ 准备提醒（放行）：${warnings.join(' ')}` } : { allowed: true };
}
