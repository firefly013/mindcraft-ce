/**
 * **为什么走不进去：把工具与方块连起来说**（Lead 2026-10-21，A 的两次回执）：
 * 「走不进去：按了前进键但位置没变」+ 另一行「镐：wooden_pickaxe 还剩约 36 次」——
 * 回执从不说"这一格是 stone，你这把木镐挖它大概要 N 秒 > 预算"。没有这句，模型只能撞墙。
 *
 * 另外：`cleared[]` 为空时代表目标脚/头格**读起来是空的**——那不是"挖不动"，
 * 而是"移动被别的东西挡住"，必须换一组诊断（天花板/落脚点/身体没动）。
 */
export const CLEAR_DIG_BUDGET_SEC = 4;

/** 原版徒手基准：硬度 × 1.5 秒（与 oak_log 徒手 3000ms 的实测一致）。 */
const HAND_BASE = 1.5;

const TOOL_SPEED: Array<[RegExp, number]> = [
    [/netherite_(pickaxe|axe|shovel)/, 9],
    [/diamond_(pickaxe|axe|shovel)/, 8],
    [/iron_(pickaxe|axe|shovel)/, 6],
    [/stone_(pickaxe|axe|shovel)/, 4],
    [/golden_(pickaxe|axe|shovel)/, 12],
    [/wooden_(pickaxe|axe|shovel)/, 2],
];

/**
 * 粗略估计挖掉这格要几秒。`hardness == null` 或方块不可挖 ⇒ null（不猜）。
 * 木镐挖石头：hardness 1.5 × 1.5 / 2 ≈ 1.1 秒；但**工具档位不够**（比如木镐挖铁矿）
 * 会额外 ×5 惩罚，这里同样计入。只是"够不够预算"的量级判断，不追求原版逐 tick 精确。
 */
export function estimateDigSeconds(input: {
    hardness: number | null;
    toolName: string | null;
}): number | null {
    if (input.hardness == null || !(input.hardness >= 0)) return null;
    if (input.hardness === 0) return 0;
    const toolName = String(input.toolName ?? '');
    const speed = TOOL_SPEED.find(([pattern]) => pattern.test(toolName))?.[1] ?? 1;
    return Math.round(((input.hardness * HAND_BASE) / speed) * 10) / 10;
}

/**
 * 挖这一格之前该说什么（纯函数）：
 * - 预计超过预算 ⇒ `over-budget`（带上"这格是什么/手里是什么/要几秒 > 预算"）；
 * - 工具剩得很少（≤10）⇒ `tool-nearly-broken`（宁可先换镐也别把镐用断）；
 * - 否则 `ok`，去挖。
 */
export function planClearStep(input: {
    blockName: string;
    toolName: string | null;
    toolDurabilityLeft: number | null;
    seconds: number | null;
    budgetSec?: number;
}): { action: 'ok' | 'over-budget' | 'tool-nearly-broken'; message: string | null } {
    const budget = input.budgetSec ?? CLEAR_DIG_BUDGET_SEC;
    const held = input.toolName ?? '空手';
    if (input.seconds != null && input.seconds > budget) {
        return {
            action: 'over-budget',
            message:
                `这格是 ${input.blockName}，你手里是 ${held}，挖它大概要 ${input.seconds} 秒 > 预算 ${budget} 秒——` +
                '**先换一把更好的镐（或绕路）**，别在这里耗到超时。',
        };
    }
    if (input.toolDurabilityLeft != null && input.toolDurabilityLeft <= 10) {
        return {
            action: 'tool-nearly-broken',
            message:
                `这格是 ${input.blockName}，但 ${held} 只剩 ${input.toolDurabilityLeft} 次耐久——` +
                '挖它很可能挖到一半镐就断了（然后仍然是"位置没变"）。**先换镐**。',
        };
    }
    return { action: 'ok', message: null };
}

/** `cleared[]` 为空时的诊断（目标格是空的，却走不进去）。 */
export function formatNoObstacleDiagnosis(input: {
    target: { x: number; y: number; z: number };
    headSolid: string | null;
    floorSolid: string | null;
    onGround: boolean | null;
    movedAny: boolean;
}): string {
    const where = `(${input.target.x}, ${input.target.y}, ${input.target.z})`;
    const facts: string[] = [];
    if (input.headSolid != null) facts.push(`你头顶那格是 ${input.headSolid}`);
    if (input.floorSolid != null && input.floorSolid !== 'solid') facts.push(`目标脚下是 ${input.floorSolid}（站不住）`);
    if (input.onGround === false) facts.push('你现在没站在地面上（悬空/被顶回）');
    if (!input.movedAny) facts.push('按键期间位置完全没变');
    return (
        `走不进去 ${where}：**目标脚/头那格读起来是空的**（不是"挖不动"那种失败），` +
        (facts.length > 0 ? facts.join('；') + '。' : '') +
        '先 mineBlock 掉目标头顶那一格（腾出跳的空间），或换 goToCoordinates 绕开这一列。'
    );
}
