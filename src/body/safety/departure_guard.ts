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
 *   ① **只拦"进去"**：`returnFromEnd` 之类的出口、逃跑、保命反射，
 *      永远不受这条限制——已经在里面的人绝不能被它困住；
 *   ② **粗糙检查**（有没有武器、有没有吃的、有没有垫脚方块、血够不够），
 *      不做配装优化；
 *   ③ **能救就救**：武器在包里没拿在手上 ⇒ 帮它 `equip`，然后放行，而不是拒绝。
 *
 * ## 默认拒绝，但**可以显式授权**（2026-10-30 用户裁定）
 *
 * 这道闸挂在 `allowDangerousOps(…, ops="departure_underprepared")` 上：
 * 默认照样拒，模型要硬进就必须自己点一次"我知道我在干什么"（时间制或次数制都行）。
 *
 * 为什么要有这个口子：门槛（没武器 / 食物 ≤2 / 垫脚块 <8）是算术，但"这次要不要赌"
 * 仍是模型的判断——它可能只是去下界门口看一眼就回来，或者带着别的 bot 一起走。
 * 引擎的职责是把代价说清楚（缺什么、进去会怎样），不是替它决定值不值得。
 * 拒绝回执会直接写出授权写法，所以这道闸也不会变成"拒绝 + 无法执行的出路"。
 */

import { findOp, refuseText } from './dangerous_ops.js';

/** 进维度类工具：只有这些会被检查。 */
export const DEPARTURE_TOOLS: ReadonlySet<string> = new Set(['enterEnd', 'enterNether']);

/** `dangerous_ops.ts` 里注册的授权项：模型显式点头才能硬进。 */
export const DEPARTURE_OP = 'departure_underprepared';

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
    /**
     * 模型已经用 `allowDangerousOps(…, ops="departure_underprepared")` 显式授权过这一次。
     *
     * 用户 2026-10-30 裁定：安全闸也走同一套授权机制——闸门默认拒绝，但"我知道我在干什么"
     * 必须能表达出来（能不能玩得转交给提示词工程，不交给引擎替它决定）。
     */
    authorized?: boolean;
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
    // **读不到 ≠ 0**（Lead 2026-10-20 裁定）：这是**许可问题**（"这个 bot 可以出发吗"），
    // 所以未知必须**fail OPEN**——不能拿一个没读到的数字去拦它。
    // （反向的例子是"要不要跳过某个威胁"，那种未知必须 fail CLOSED。）
    // 之前这里写 `facts.food ?? 0`，读不到就当成 0 直接拒绝 ⇒ 读不到食物 = 一堵墙。
    const foodKnown = typeof facts.food === 'number' && Number.isFinite(facts.food);
    const food = foodKnown ? (facts.food as number) : null;
    const blocks = facts.blocks;
    const hasWeapon = facts.weapon != null && facts.weapon !== '';

    /** 读不到的那些读数（只用来"说明"，**绝不**当拒绝理由）。 */
    const unread: string[] = [];
    if (!foodKnown) unread.push('食物');
    if (blocks == null) unread.push('垫脚方块');

    const missing: string[] = [];
    if (!hasWeapon) {
        missing.push(
            facts.tool === 'enterEnd'
                ? '**没有武器**（末影人 40 血、每下 4-7 伤害，空手必死）'
                : '**没有武器**（下界的猪灵/猪灵蛮兵/烈焰人都会主动打你）',
        );
    }
    if (food != null && food <= MIN_FOOD_HARD) missing.push(`**食物 ${Math.round(food)}**（进去就没有回血手段）`);
    if (blocks != null && blocks < MIN_BLOCKS_HARD) {
        missing.push(`**垫脚方块只有 ${blocks} 个**（末地虚空桥/下界跨岩浆都要垫，至少 ${MIN_BLOCKS_HARD} 个）`);
    }
    if (health != null && health < MIN_HEALTH_SUGGESTED && missing.length > 0) {
        missing.push(`血量 ${Math.round(health * 10) / 10}（低于建议的 ${MIN_HEALTH_SUGGESTED}）`);
    }

    // **已知的坏**才硬拦；**未知**一律不拦（`null` 当"没读到"）。
    const hardRefuse = !hasWeapon || (food != null && food <= MIN_FOOD_HARD) || (blocks != null && blocks < MIN_BLOCKS_HARD);
    if (hardRefuse && facts.authorized === true) {
        // 授权过就放行，但把"你赌的是什么"留在回执里——出事时这一行就是证据。
        return {
            allowed: true,
            warning:
                `（**这次是你显式授权过的**：${missing.length > 0 ? missing.join('、') : '准备不足'}。` +
                '授权只覆盖一次/一段时间，到了那边自己看着办。）',
        };
    }
    if (hardRefuse) {
        return {
            allowed: false,
            text:
                `**拒绝进${place}**：` +
                (missing.length > 0 ? missing.join('、') : '准备不足') +
                `。补齐这些再来 \`${facts.tool}()\`——怎么补由你安排。\n    ` +
                // **不给四步合成链**（2026-10-30 用户裁定）：那是替模型排计划。
                // 只留一条**算术事实**——空手做剑要多少料，是可核对的，不是选择。
                (hasWeapon
                    ? ''
                    : '（材料账：木剑 = 2 木板 + 1 木棍，工作台 = 4 木板，合计 8 木板 = **2 根原木**；1 根不够。）\n    ') +
                // **唯一出口**：这次就想去。写清确切的调用，别让它去猜参数名。
                `硬要现在进就显式授权这一次：${
                    (() => {
                        const op = findOp(DEPARTURE_OP);
                        return op != null
                            ? refuseText(op, 5)
                            : `\`allowDangerousOps(5, "原因", "${DEPARTURE_OP}")\``;
                    })()
                }\n    ` +
                '**出口/逃跑不受这条限制**：`returnFromEnd` 之类、保命反射都随时可用——已经在里面的人不会被它困住。',
        };
    }

    // 放行：低于建议值就给一句响亮提醒（不拦）。
    const warnings: string[] = [];
    if (food !== null && food < MIN_FOOD_SUGGESTED) {
        warnings.push(`你食物只有 ${Math.round(food)}，${place}里**没有食物来源**——进去之前最好补到 ${MIN_FOOD_SUGGESTED}。`);
    }
    if (blocks != null && blocks < MIN_BLOCKS_SUGGESTED) {
        warnings.push(`垫脚方块只有 ${blocks} 个（建议 ≥${MIN_BLOCKS_SUGGESTED}）：虚空桥/跨岩浆一旦不够就会卡在中间。`);
    }
    if (health != null && health < MIN_HEALTH_SUGGESTED) {
        warnings.push(`血量 ${Math.round(health * 10) / 10} 低于建议的 ${MIN_HEALTH_SUGGESTED}，挨一下就危险。`);
    }
    // **读不到的读数**：明确说"这不作为拒绝理由"，并且告诉它自己去看一眼
    // （否则模型会把"读不到"读成"被拦了"，或者干脆不知道食物是未知的）。
    if (unread.length > 0) {
        warnings.push(
            `${unread.join('、')}**读不到**（读数不可用）——**这不作为拒绝理由**：已经放行；` +
                '进去之前自己 `stats(type="body")` 看一眼真实数值再决定。',
        );
    }
    return warnings.length > 0
        ? {
              allowed: true,
              // **必须是"补充说明"，不能长得像拒绝**（Lead 2026-10-19 的担心：
              // 模型把提醒当成拒绝，或者提醒把真正的动作挤没了）。
              warning: `（**这只是提醒，不是拒绝**——已经放行，该做的事照做。）⚠️ ${warnings.join(' ')}`,
          }
        : { allowed: true };
}

/**
 * 把提醒**追加在回执末尾**，而不是顶在开头。
 *
 * 理由：回执第一行是模型最先读、最容易当结论的一行；把"放行 + 实际发生了什么"
 * 留在前面，提醒放后面并标注"只是提醒，不是拒绝"，既保留提示，也不会让模型
 * 以为这次动作被拦了。
 */
export function annotateReceipt(text: string, warning?: string | null): string {
    if (warning == null || warning === '') return text;
    return `${text}\n    ${warning}`;
}
