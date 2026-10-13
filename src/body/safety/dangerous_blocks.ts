/**
 * 落点致命方块：**站上去或碰到会掉血**的那些。
 *
 * ## 为什么单独一张表
 *
 * 正常的走动由 pathfinder 把关（`Movements.blocksToAvoid`，见 `movements.ts`），
 * 但**传送绕过寻路**——`goToPosition` 在 cheat 下是直接 `/tp`，pathfinder 从头到
 * 尾不参与。所以"走到哪儿"有人管，"传到哪儿"必须另有一张网。
 *
 * ## 名单怎么来的
 *
 * 从 `minecraft-data` 的 1058 个方块里按关键词捞出候选，再逐个人工判定。被剔除的
 * 都是**名字像但性质不对**的：
 *
 * - `fire_coral*` / `dead_fire_coral*`：是珊瑚，名字里带 fire 而已，不掉血。
 * - `dripstone_block` / `pointed_dripstone`：只有**坠落中**的滴水石才伤人，作为
 *   地面方块站着没事。
 * - `anvil` / `chipped_anvil` / `damaged_anvil`：同上，落下的铁砧才砸人。
 * - `snow` / `snow_block` / `rose_bush`：完全无害。
 * - `cobweb`：会**困住**但**不掉血**——那是另一类危险（卡死），不归这张表。
 * - `potted_*` / `*_cauldron`（非 magma 的）：盆栽和水缸是装饰/容器，站不进去。
 *
 * `HURTING_BLOCKS_EXIST` 那条测试会定期回头验一遍这些名字在当前 MC 版本里真的
 * 存在，免得版本升级后某个方块改了名、这条闸门悄悄变成空判据。
 */

import { blockAtFrom, dangerousWaterRefusal } from './water_safety.js';

/** 踩上去/碰着就持续掉血。新增前先确认它在这个版本里真的存在。 */
export const HURTING_BLOCKS: readonly string[] = Object.freeze([
    'lava', // 岩浆
    'lava_cauldron', // 装着岩浆的炼药锅
    'fire', // 火
    'soul_fire', // 灵魂火（烧得更狠）
    'magma_block', // 岩浆块
    'campfire', // 营火
    'soul_campfire', // 灵魂营火
    'cactus', // 仙人掌
    'sweet_berry_bush', // 甜浆果丛（扎人 + 减速）
    'wither_rose', // 凋零玫瑰（凋零效果）
    'powder_snow', // 细雪（冻伤）
]);

/**
 * 一个方块踩上去会不会挨打。
 *
 * `HURTING_BLOCKS` 之外的名字另有命运（有的会窒息、有的无害），所以返回的是
 * `'hurting'` / `'solid'` / `'safe'` 三态而不是布尔——调用方要据此给不同的回执。
 */
export type LandingVerdict = 'hurting' | 'solid' | 'safe';

/**
 * 落点那一格能不能站人。
 *
 * **材料和 Notch 的共识**：`air` 系列算空的，`water` 由另一张网管（见
 * `water_safety.dangerousWaterRefusal`），剩下的实体方块会把人卡在里面窒息。
 */
export function landingVerdictFor(name: string | null | undefined): LandingVerdict {
    if (name == null || name === '') return 'safe'; // 取不到就别瞎拦
    if (HURTING_BLOCKS.includes(name)) return 'hurting';
    if (name === 'air' || name === 'cave_air' || name === 'void_air') return 'safe';
    if (name === 'water') return 'safe'; // 归水的那张网管，别判两次
    return 'solid'; // 石头、泥土……传送进去会窒息
}

/**
 * 传送落点闸门：能不能传到 `(x, y, z)`。返回给模型的回执，可以传就返回 null。
 *
 * **为什么传送要查得比走路多**：正常走路由 pathfinder 把关（走不到实体方块里、
 * 也会绕开 `blocksToAvoid` 里的东西），而 `/tp` 是整个绕过寻路的——所以这里得把
 * pathfinder 替我们做的那部分自己再做一遍：掉血方块、**还有卡在方块里窒息**。
 *
 * 三类问题的性质不同，回执也不同：
 *
 * - **掉血方块**（岩浆/火/仙人掌…）：**硬禁止，没有授权通道**。站上去就得挨打，
 *   没有任何正当理由要主动传送进去。
 * - **卡在实体方块里**：同上是硬的，回执告诉它换个落脚点。
 * - **危险的水**：归 `allowDangerousOps("enter_deep_water")` 管——水下作业是有正当
 *   用途的，所以这一项**可以**授权（见 `water_safety.dangerousWaterRefusal`）。
 */
export function teleportRefusal(bot: unknown, x: number, y: number, z: number): string | null {
    const rawName = blockAtFrom(bot)(Math.floor(x), Math.floor(y), Math.floor(z))?.name;
    const name = typeof rawName === 'string' ? rawName : '那个方块';
    const verdict = landingVerdictFor(typeof rawName === 'string' ? rawName : null);
    if (verdict === 'hurting') {
        return `不允许传送到 ${name} 上——碰到会掉血，这一类没有例外。换个落脚点。`;
    }
    if (verdict === 'solid') {
        return `不允许传送到 ${name} 里——会卡在方块中窒息。传送坐标要落在空气上。`;
    }
    return dangerousWaterRefusal(bot, x, y, z, '传送到');
}

export default { HURTING_BLOCKS, landingVerdictFor, teleportRefusal };
