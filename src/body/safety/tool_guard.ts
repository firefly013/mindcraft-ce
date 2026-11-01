/**
 * 附魔工具保护的**最后一道闸**：所有绕过 skills 的入口（用户 2026-11-01）。
 *
 * 为什么需要：`ensureHarvestTool` / `digWithTimeout` 只覆盖 skills 自己的挖掘路径，
 * 还有两条第三方路径会自己动工具：
 *
 *   1. **mineflayer-pathfinder 寻路挖路**：它自己 `bestHarvestTool()` + `equip()`，
 *      然后裸 `bot.dig(block, true)`（`mineflayer-pathfinder/index.js:502-506`）——
 *      完全绕过我们的换手判断，能把保护线上的附魔镐烧掉；
 *   2. **mineflayer-custom-pvp 近战**：`attack()` 里 `checkForWeapon()` 会自己从
 *      背包找一把武器换上（`swordpvp.js:286-288`）——也可能把保护线上的附魔武器
 *      举起来打。
 *
 * 所以这里在 bot 实例上装两个包装（幂等）：
 *   - `bot.dig`：手里是受保护的附魔工具时，先试着换一把能挖它的未保护工具；
 *     换不到就**拒绝这一镐**（抛 `PROTECTED_TOOL`，pathfinder 会当成"挖不动"
 *     停路，不会静默烧耐久）。
 *   - `bot.swordpvp.checkForWeapon`：永不返回受保护的附魔武器（返回 null ⇒
 *     插件不换手，按当前手持打/空手打）。
 *
 * 注意：这里只做"不自动用"，**不阻止模型手动 equip**——保护的是自动化。
 */
import { ensureHarvestTool, isHeldToolProtected, log, protectedToolNotice } from '../library/skills.js';
import { isToolProtected } from '../library/tool_choice.js';

/**
 * 给一个 bot 实例装上工具保护（幂等：重复调用不会重复包装）。
 *
 * 在 `MineflayerBody` 拿到 `initBot()` 之后立刻调用——那时 pathfinder /
 * custom-pvp 插件已经加载完（`bot.swordpvp` 已存在）。
 */
export function installToolGuard(bot: any): void {
    if (bot == null) return;
    installDigGuard(bot);
    installWeaponGuard(bot);
}

function installDigGuard(bot: any): void {
    if (typeof bot.dig !== 'function' || bot.__toolGuardDig === true) return;
    bot.__toolGuardDig = true;
    const original = bot.dig.bind(bot);
    bot.dig = async (block: any, ...rest: any[]): Promise<any> => {
        // 手里不是保护线上的附魔工具：零改动直接放行（绝大多数情况）。
        if (!isHeldToolProtected(bot)) return original(block, ...rest);
        // 先试着换一把能挖它的、未受保护的工具（pathfinder 可能刚把附魔那把举起来）。
        try {
            await ensureHarvestTool(bot, block);
        } catch {
            // 换手失败按"换不到"处理。
        }
        if (!isHeldToolProtected(bot)) return original(block, ...rest);
        // 换不到：拒绝这一镐，并把原因写进回执（同一句话只写一次）。
        const notice = protectedToolNotice(bot, block?.name ?? null);
        if (bot.__toolGuardDigNotice !== notice) {
            bot.__toolGuardDigNotice = notice;
            log(bot, notice);
        }
        // **让 pathfinder 干净地停下**：它规划时以为能挖（或挖到一半工具跌破
        // 保护线），现在拒绝下镐——不主动停，它会卡在 digging=true 原地等动作超时。
        try {
            if (bot.pathfinder?.isMoving?.() === true || bot.pathfinder?.isMining?.() === true) {
                bot.pathfinder.stop?.();
            }
        } catch {
            // 停不下来也照样拒绝这一镐。
        }
        // pathfinder 的 `digging` 标志只在真正的 diggingAborted/Completed 事件里
        // 复位；我们没真挖过，它收不到事件，下一次寻路会永远以为"还在挖"。
        // 下一拍补一个 aborted：那时它的 resetPath 已经挂上监听，收到就复位。
        setTimeout(() => {
            try {
                bot.emit?.('diggingAborted', block);
            } catch {
                // 没有监听也无害。
            }
        }, 0);
        const error: any = new Error('protected_tool: 附魔工具到保护线，拒绝用它挖掘');
        error.code = 'PROTECTED_TOOL';
        throw error;
    };
}

function installWeaponGuard(bot: any): void {
    const pvp = bot?.swordpvp;
    if (pvp == null || typeof pvp.checkForWeapon !== 'function' || pvp.__toolGuardWeapon === true) return;
    pvp.__toolGuardWeapon = true;
    const original = pvp.checkForWeapon.bind(pvp);
    pvp.checkForWeapon = (weapon?: string): any => {
        const item = original(weapon);
        if (item == null || !isToolProtected(item)) return item;
        // 受保护：按同一个选择器换**下一把**未保护的（自动切换仍然有效）；
        // 换不到返回 null ⇒ 插件不换手，按当前手持/空手打。
        const selector = weapon ?? pvp.weaponOfChoice ?? 'sword';
        try {
            const items = (bot?.inventory?.items?.() ?? []) as any[];
            return items.find((candidate) => String(candidate?.name ?? '').includes(selector) && !isToolProtected(candidate)) ?? null;
        } catch {
            return null;
        }
    };
}

export default { installToolGuard };
