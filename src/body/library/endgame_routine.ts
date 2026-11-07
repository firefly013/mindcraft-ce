/**
 * 末地相关动作里**碰世界的那一层**。
 *
 * 和末地相关的工具只剩 `enterEnd`；同文件里另外两个是通用动作
 * `drinkPotion` / `recoverAfterDeath`。拆水晶、床炸龙、躲龙息、复活龙
 * 的 routine 已经按用户要求删掉，这里只保留进入末地、掷眼找要塞、
 * 喝药和死亡回收真正用得到的原语。
 */
import Vec3Class from 'vec3';
import * as skills from './skills.js';
import * as world from './world.js';
import {
    END_PLATFORM,
    describeEyeDirection,
    findPotionById,
    normalizeName,
    planRecovery,
    potionIdOf,
    potionInventorySummary,
    trackEyeFlight,
    vec,
    type EyeFlightTrack,
    type EyeSample,
    type Vec3,
} from './endgame.js';

// ============================ 一、给 Lead 的工具声明（照抄进 actionsList 即可） ============================

export interface EndgameToolParam {
    type: string;
    description: string;
    optional?: boolean;
    domain?: [number, number];
}

export interface EndgameToolSpec {
    /** 去 `!` 的工具名。 */
    name: string;
    kind: 'query' | 'action';
    description: string;
    params: Record<string, EndgameToolParam>;
    /** 走身体通道的动作必须有上限（分钟）；query 不需要。 */
    timeoutMinutes?: number;
    /** 怎么落地：复用哪个现有能力，还是要补新原语。 */
    backing: string;
}

/**
 * 和末地相关的工具只剩 `enterEnd`，外带两个通用动作（drinkPotion / recoverAfterDeath）。
 * **我没有注册它们**，这是给 Lead 的接线清单。
 * `kind` 决定进查询表还是动作表（见 `registry.ts` 的注释）。
 */
export const endgameToolSpecs: EndgameToolSpec[] = [
    {
        name: 'enterEnd',
        kind: 'action',
        description:
            '自动进入末地：附近有已激活的传送门就走进去；有空的传送门框架就把 12 个都用末影之眼填满；**两样都没有就替你掷一颗末影之眼指路**（找要塞）。' +
            '进门之前会把主世界那个传送门的坐标记进 Memory Bank（overworld_end_portal，死亡回收要用）。' +
            '进去会落在 (100,49,0) 的黑曜石平台上，面朝西，平台和主岛之间可能隔着虚空。',
        params: {},
        timeoutMinutes: 5,
        backing: '复用 world.getNearestBlock/getNearestBlocksWhere + skills.equip/useToolOnBlock + throwHeld；维度切换判定照抄 nether_portal.ts 的 dimensionChanged。',
    },
    {
        name: 'drinkPotion',
        kind: 'action',
        description:
            '喝一瓶指定 id 的药水（`healing` / `strong_healing` / `long_slow_falling` 这类）。背包里所有药水的物品名都是 potion，id 才能精确到等级和时长；没有这瓶时返回背包里现有的药水 id 清单。',
        params: {
            potion: { type: 'string', description: '完整药水 id，例如 healing / strong_healing / long_slow_falling / fire_resistance。' },
        },
        timeoutMinutes: 2,
        backing: 'equip + consume；按 NBT/组件里的 potion id 对齐状态效果名。',
    },
    {
        name: 'recoverAfterDeath',
        kind: 'action',
        description:
            '死亡回收：告诉你尸体坐标、**已经在外面放了多久**、掉落物还剩多少秒、以及从记录的主世界传送门再进末地的路线。' +
            '掉落物 **5 分钟**消失，但只在区块被加载时才计时；掉进虚空（Y<-60）的东西**当场消失**，不用去捡。',
        params: {},
        timeoutMinutes: 10,
        backing: '新增动作命令；纯计算在 endgame.planRecovery，执行复用 goToCoordinates / enterEnd，传送门坐标来自 enterEnd 记的 overworld_end_portal。',
    },
];

// ============================ 二、把 bot 状态读成信号 ============================

export function toVec(raw: any): Vec3 | null {
    if (raw == null || typeof raw !== 'object') return null;
    const { x, y, z } = raw;
    if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return vec(x, y, z);
}

/** 用 minecraft-data 的效果表把数字 id 翻成名字；翻不到就保守地写成 `effect_<id>`。 */
export function readDimension(bot: any): string | null {
    const raw = bot?.game?.dimension ?? bot?.game?.dimensionName;
    if (typeof raw !== 'string') return null;
    return normalizeName(raw);
}
// ============================ 三、可执行动作（能落地的部分） ============================

function safeInventoryCounts(bot: any): Record<string, number> {
    try {
        return world.getInventoryCounts(bot) ?? {};
    } catch {
        return {};
    }
}

function safeInventoryItems(bot: any): any[] {
    try {
        const items = bot?.inventory?.items?.();
        return Array.isArray(items) ? items : [];
    } catch {
        return [];
    }
}

/** 背包里某个**完整药水 id** 的药水一共有几瓶（能区分普通/延长/强化版本）。 */
export function countPotionsById(bot: any, potionId: unknown): number {
    const wanted = normalizeName(potionId);
    if (wanted === '') return 0;
    let total = 0;
    for (const item of safeInventoryItems(bot)) {
        if (normalizeName(item?.name) !== 'potion') continue;
        if (normalizeName(potionIdOf(item)) !== wanted) continue;
        total += typeof item?.count === 'number' && Number.isFinite(item.count) ? Math.max(0, item.count) : 1;
    }
    return total;
}

/**
 * 喝一瓶**指定 id** 的药水（`healing` / `strong_healing` / `long_slow_falling` 这类）。
 *
 * 只返回结果：没有这瓶时列出背包里现有的；喝了报喝了哪一瓶、还剩几瓶；
 * 包发出去了但数量没变就如实说"不能确认喝下"。不写"下一步""再调一次"。
 */
export async function drinkPotionById(bot: any, potionId: unknown): Promise<string> {
    const wanted = normalizeName(potionId);
    if (wanted === '') return 'drinkPotion：没有给 potion id。';
    const items = safeInventoryItems(bot);
    const potion = findPotionById(items, wanted);
    if (potion == null) {
        const have = potionInventorySummary(items);
        return have === ''
            ? `背包里没有 '${String(potionId)}' 药水，也没有可饮用的药水。`
            : `背包里没有 '${String(potionId)}' 药水。现有：${have}。`;
    }
    const before = countPotionsById(bot, wanted);
    try {
        await bot.equip(potion, 'hand');
        await bot.consume();
    } catch (error) {
        return `喝 ${wanted} 没有成功，错误是 ${(error as Error)?.message ?? String(error)}。`;
    }
    // 服务端扣物品要过一两个 tick；给它三次机会再判定。
    let after = countPotionsById(bot, wanted);
    for (let attempt = 0; attempt < 2 && after >= before; attempt++) {
        await skills.wait(bot, 250);
        after = countPotionsById(bot, wanted);
    }
    if (after >= before) {
        return `使用包已经发出去了，但是 ${wanted} 的数量从 ${before} 个变成 ${after} 个，没有变化，所以不能确认已经喝下。`;
    }
    return `喝下 ${wanted}（剩 ${after} 瓶）。`;
}

// ============================ 三·B、床炸的选址与掩体（都从真实世界读） ============================
// ============================ 四、末地动作：把 plan 变成 bot 动作 ============================

/** 回执格式统一：第一行结论，后面每行一个细节。 */
export function endgameReceipt(headline: string, details: string[] = []): string {
    const lines = [headline];
    for (const detail of details) lines.push(`- ${detail}`);
    return lines.join('\n');
}

/** 按谓词数背包里有多少个（`world.getInventoryCounts` 的薄封装，坏数据一律当 0）。 */
function countOf(bot: any, predicate: (name: string) => boolean): number {
    const counts = safeInventoryCounts(bot);
    let total = 0;
    for (const [rawName, rawCount] of Object.entries(counts)) {
        if (!predicate(normalizeName(rawName))) continue;
        total += Number.isFinite(rawCount) ? Math.max(0, rawCount) : 0;
    }
    return total;
}

export function countEyesOfEnder(bot: any): number {
    return countOf(bot, (name) => name === 'ender_eye');
}

export const EYE_TRACK_MAX_MS = 1600;
export const EYE_TRACK_INTERVAL_MS = 100;

export interface EyeThrowReport {
    /** 眼睛有没有真的扔出去（按手里数量核对）。 */
    threw: boolean;
    /** 飞行的 8 方位方向；null = 没看清（**绝不编方向**）。 */
    track: EyeFlightTrack | null;
    samples: number;
    /** 给模型看的回执。 */
    message: string;
}

function eyeEntityIds(bot: any): Set<string> {
    const ids = new Set<string>();
    const entities = bot?.entities;
    if (entities == null || typeof entities !== 'object') return ids;
    for (const [id, entity] of Object.entries(entities as Record<string, any>)) {
        const e: any = entity;
        if (typeof e?.name === 'string' && e.name.includes('eye_of_ender')) ids.add(String(id));
    }
    return ids;
}

/**
 * 扔一颗末影之眼，并**立刻采样它的飞行方向**。
 *
 * 为什么非做不可：眼睛实体只活 1~2 秒。原实现只回一句"朝要塞方向飞约 12 格"，
 * 既没读方向也没记住任何东西——12 颗眼扔完，模型还是不知道要塞在哪。
 * 这里在投掷后按 {@link EYE_TRACK_INTERVAL_MS} 轮询 `bot.entities`，采到
 * **新出现**的那颗眼（投掷前快照过的旧眼不算），交给纯函数
 * `trackEyeFlight` 算方向。看不够就如实说"没看清"，不猜。
 *
 * 采样过程中尊重 `bot.interrupt_code`（急停时立刻收手）。
 */
export async function throwEyeAndTrack(
    bot: any,
    options: { maxMs?: number; intervalMs?: number } = {},
): Promise<EyeThrowReport> {
    if (normalizeName(bot?.heldItem?.name) !== 'ender_eye') {
        const equipped = await skills.equip(bot, 'ender_eye');
        if (!equipped) {
            return { threw: false, track: null, samples: 0, message: '手上没有末影之眼，也没能把它拿到手上（背包里没有 ender_eye？）。' };
        }
    }
    const existing = eyeEntityIds(bot);
    const threw = await throwHeld(bot, null);
    if (!threw) {
        return {
            threw: false,
            track: null,
            samples: 0,
            message: '没有扔出末影之眼，手里的数量没有变化。',
        };
    }

    const maxMs = Math.max(1, options.maxMs ?? EYE_TRACK_MAX_MS);
    const intervalMs = Math.max(1, options.intervalMs ?? EYE_TRACK_INTERVAL_MS);
    const samples: EyeSample[] = [];
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (bot?.interrupt_code) break;
        const entities = bot?.entities;
        let sawEyeThisPoll = false;
        if (entities != null && typeof entities === 'object') {
            for (const [id, entity] of Object.entries(entities as Record<string, any>)) {
                const e: any = entity;
                if (typeof e?.name !== 'string' || !e.name.includes('eye_of_ender')) continue;
                if (existing.has(String(id))) continue; // 上一颗还没消失的眼，不是这次的
                sawEyeThisPoll = true;
                const position = toVec(e.position);
                if (position == null) continue;
                samples.push({ position, atMs: Date.now() });
                break;
            }
        }
        // 采到轨迹之后眼睛消失 = 这一飞结束了（碎掉/落地），不用再等满窗口。
        if (!sawEyeThisPoll && samples.length >= 2) break;
        await skills.wait(bot, intervalMs);
    }

    const track = trackEyeFlight(samples);
    if (track == null) {
        return {
            threw: true,
            track: null,
            samples: samples.length,
            message: endgameReceipt('末影之眼扔出去了，但**没看清它往哪飞**（没采到足够的位置）。', [
                samples.length === 0
                    ? '一个采样点都没读到：眼睛可能一出膛就碎了（每次 20% 概率），或者服务端没把它同步过来。'
                    : `只采到 ${samples.length} 个采样点，位移太小，推不出方向。`,
                '**不要按猜测的方向走**。再调一次 enterEnd（多备几颗眼），或者用 goToCoordinates 换个方向站远一点再扔——两次方向交叉就能定位。',
            ]),
        };
    }

    return {
        threw: true,
        track,
        samples: samples.length,
        message: endgameReceipt('末影之眼扔出去了，方向已经量出来了。', [
            describeEyeDirection(track),
            `采样 ${samples.length} 个点。朝这个方向走约 12 格再扔一颗，两次方向交叉就是要塞；眼睛开始往下钻 → 要塞在脚下，往下挖。`,
            '每次扔有 20% 概率碎掉，多备几颗（12 颗眼才够填满传送门）。',
        ]),
    };
}

/** 投掷手里的东西（末影之眼指路 / 末影珍珠位移·自救）。末影之眼会顺带量方向并记进 Memory Bank。 */
export async function throwHeldSkill(bot: any, agent?: any): Promise<string> {
    const held: any = bot?.heldItem;
    if (held == null || typeof held.name !== 'string') {
        return '手里是空的，没扔出去。';
    }
    const name = normalizeName(held.name);

    // 末影之眼：**必须现场采样它的飞行方向**，实体只活 1~2 秒，错过就永远不知道要塞在哪。
    if (name.includes('ender_eye')) {
        const report = await throwEyeAndTrack(bot);
        if (report.track != null) {
            try {
                const last = report.track.lastPosition;
                agent?.memory_bank?.rememberPlace?.('last_eye_of_ender', last.x, last.y, last.z);
            } catch {
                // 记不住不影响这次掷眼，回执里已经有方向了。
            }
        }
        return report.message;
    }

    const position = toVec(bot?.entity?.position);
    const velocity = toVec(bot?.entity?.velocity);
    const falling = bot?.entity?.onGround === false && velocity != null && velocity.y < -0.4;
    const aim = falling && position != null ? vec(position.x, position.y - 8, position.z) : null;
    const threw = await throwHeld(bot, aim);
    if (!threw) {
        return `${name} 没有扔出去。`;
    }
    if (name.includes('ender_pearl')) {
        return falling ? '下坠中往脚下扔了一颗末影珍珠。' : '扔出了末影珍珠。';
    }
    return `扔出了 ${name}。`;
}

/**
 * 末地传送门框架上有没有眼。
 *
 * 1.13+ 的眼是**方块状态**（`eye=true/false`），1.12- 才是 metadata 的 bit 2。
 * 原来只读 `block.metadata & 4`：现代版本里 metadata 基本恒为 0，于是**所有框架都被
 * 当成空框架**，包括已经有眼的——对着"已经有眼的框架"再喂眼是白扔。
 */
export function frameHasEye(block: any): boolean {
    try {
        const props = typeof block?.getProperties === 'function' ? block.getProperties() : block?._properties;
        if (props != null && props.eye != null) return props.eye === true || props.eye === 'true';
    } catch {
        // 读属性失败就走下面的老版本判据
    }
    return ((Number(block?.metadata) || 0) & 4) === 4;
}

/**
 * 进末地：已有传送门就走进去；有框架就补眼再进；**两样都没有就掷眼指路找要塞**。
 *
 * 三件事必须记住：
 * 1. 掷眼是"找要塞"的唯一可编程手段（设计稿 §2 阶段 2），而原来 `enterEnd` 在
 *    "48 格内没门、附近没框架"时只是**干说一句"先用末影之眼找要塞"**就返回了——
 *    手里明明有眼，工具却不肯扔。现在它自己扔一颗并把方向写进回执。
 * 2. 进末地前把传送门坐标写进 Memory Bank（`overworld_end_portal`）：设计稿 §3.1 说
 *    "死亡回收全靠它"，而之前**没有任何地方**记过这个坐标，`recoverAfterDeath` 因此
 *    永远拿不到回去的路线。
 * 3. 失败回执要写清卡在哪一步（照抄 `nether_portal.ts` 的规矩），别只说"没进成"。
 */
export async function enterEndSkill(bot: any, agent?: any): Promise<string> {
    const before = readDimension(bot);
    if (before === 'the_end') return '已经在末地了，不用再进。';
    const details: string[] = [];
    const rememberPortal = (p: Vec3): void => {
        try {
            agent?.memory_bank?.rememberPlace?.('overworld_end_portal', p.x, p.y, p.z);
        } catch {
            // 记不住不影响这次进末地，但 recoverAfterDeath 会少一条路线。
        }
    };

    const stepThrough = async (portal: any): Promise<boolean> => {
        const p = toVec(portal?.position);
        if (p == null) return false;
        await skills.goToPosition(bot, p.x + 0.5, p.y, p.z + 0.5, 0.5);
        return skills.waitFor(bot, () => readDimension(bot) === 'the_end', 15000);
    };

    const existing = world.getNearestBlock(bot, 'end_portal', 48);
    if (existing != null) {
        const p = toVec(existing.position);
        if (p != null) rememberPortal(p);
        details.push(
            `发现已激活的末地传送门 (${p == null ? '?' : `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`})` +
                '，坐标已记进 Memory Bank（overworld_end_portal）'
        );
        if (await stepThrough(existing)) {
            details.push(`维度：${before ?? '未知'} → the_end。落点 (${END_PLATFORM.x},${END_PLATFORM.y},${END_PLATFORM.z}) 面朝西，先看平台和主岛之间有没有空隙：有就搭桥或扔珍珠，掉虚空当场死、掉落物也当场没。`);
            return endgameReceipt('已进入末地。', details);
        }
        details.push('走过去了但维度没切：可能没真的踩进传送门方块。用 stats 看坐标，再调一次。');
        return endgameReceipt('没进成末地。', details);
    }

    details.push('48 格内没有已激活的末地传送门，改找传送门框架');
    const frames = world.getNearestBlocksWhere(
        bot,
        (block: any) => block?.name === 'end_portal_frame' && !frameHasEye(block),
        32,
        12,
    );
    if (frames.length === 0) {
        details.push('附近没有空的末地传送门框架：要塞不在这。');
        const eyes = countEyesOfEnder(bot);
        if (eyes <= 0) {
            details.push('而且背包里没有末影之眼（ender_eye）。');
            details.push('末影之眼 = 末影珍珠 + 烈焰粉：打末影人拿珍珠、打烈焰人拿粉，合成 12 颗以上再来（每次扔还有 20% 概率碎）。');
            return endgameReceipt('没做到 enterEnd：框架 0、末影之眼 0。', details);
        }
        const equipped = await skills.equip(bot, 'ender_eye');
        if (!equipped) {
            details.push(`背包里有 ${eyes} 颗眼但没拿到手上，扔不出去：先 equip(ender_eye)。`);
            return endgameReceipt('有末影之眼，但没拿到手上。', details);
        }
        // throwHeldSkill 会**现场采样眼睛的飞行方向**并把最后位置记进 Memory Bank（last_eye_of_ender）。
        const throwReceipt = await throwHeldSkill(bot, agent);
        details.push(throwReceipt);
        details.push(
            `掷眼后还剩 ${countEyesOfEnder(bot)} 颗。跟着上面的方向走 ~12 格再调一次 enterEnd（两次方向交叉就是要塞）；眼睛开始往下钻就说明要塞在脚下，往下挖。`,
        );
        return endgameReceipt('要塞不在这附近，已经替你掷了一颗末影之眼指路。', details);
    }
    details.push(`找到 ${frames.length} 个空框架`);
    if (countEyesOfEnder(bot) <= 0) {
        details.push('背包里没有末影之眼：打末影人拿珍珠 + 烈焰粉合成 ender_eye（12 颗才够填满）。');
        return endgameReceipt('有框架，但没有末影之眼。', details);
    }

    let filled = 0;
    for (const frame of frames) {
        if (countEyesOfEnder(bot) <= 0) break;
        if (await skills.useToolOnBlock(bot, 'ender_eye', frame)) filled += 1;
    }
    details.push(`填了 ${filled} 个框架，还剩 ${countEyesOfEnder(bot)} 颗眼`);

    const opened = world.getNearestBlock(bot, 'end_portal', 48);
    if (opened == null) {
        details.push('12 个框架全部有眼才会激活；再攒几颗眼回来把剩下的填满。');
        return endgameReceipt(`填了 ${filled} 个，传送门还没亮。`, details);
    }
    const openedPosition = toVec(opened.position);
    if (openedPosition != null) rememberPortal(openedPosition);
    details.push('传送门亮了，走进去');
    if (await stepThrough(opened)) {
        details.push(`维度：${before ?? '未知'} → the_end。落点 (${END_PLATFORM.x},${END_PLATFORM.y},${END_PLATFORM.z}) 面朝西；平台和主岛之间可能有空隙。`);
        return endgameReceipt('已进入末地。', details);
    }
    details.push('传送门激活了但没走进去（维度没切），再调一次。');
    return endgameReceipt('没进成末地。', details);
}

/**
 * 死亡计时：掉落物 5 分钟消失，回执要报"已经过了多久"。
 *
 * 为什么需要它：原来 `recoverAfterDeathSkill` 把 `secondsSinceDeath` 写死成 0、
 * `chunkLoadedSinceDeath` 写死成 false —— 于是无论死多久，回执永远是
 * "掉落物基本还在，先别慌"。那两行是**编出来的乐观**，会直接把模型推到"慢慢走过去捡"，
 * 而掉落物 5 分钟就没了。
 *
 * 内存里只存了坐标（没有死亡时间戳，`mineflayer_body` 只在死亡瞬间写 xyz），
 * 所以这里的秒数是"从本进程第一次看到这个死亡点算起"的**下界**，回执里会写清这一点。
 */
const deathClocks = new Map<string, number>();

export function resetDeathClocks(): void {
    deathClocks.clear();
}

function deathKey(x: number, y: number, z: number): string {
    return `${Math.round(x)},${Math.round(y)},${Math.round(z)}`;
}

/**
 * 死亡回收：读记录下来的 `last_death_position`，按 5 分钟/区块加载规则给方案；同维度就带你走。
 *
 * 修掉的三处硬编码（都在原来那 6 行里）：
 * - `secondsSinceDeath: 0` → 用 `deathClocks` 量真实经过时间（下界）；
 * - `chunkLoadedSinceDeath: false` → 用 `bot.blockAt` 看尸体那格**现在**在不在加载区块里；
 * - `deathDimension: current` → 改成显式说清"维度是按现在推断的"，并读
 *   `overworld_end_portal`（enterEnd 进门前记的）给出回末地的路线；
 * - 另外补 `fellOutOfWorld`：Y < -60 基本就是掉出世界，那种尸体不用去捡。
 */
export async function recoverAfterDeathSkill(agent: any): Promise<string> {
    const bot = agent?.bot;
    const recalled = agent?.memory_bank?.recallPlace?.('last_death_position');
    if (!Array.isArray(recalled) || recalled.length < 3) {
        return '没有记录到死亡点（last_death_position 是空的）：要么还没死过，要么被清了。';
    }
    const x = Number(recalled[0]);
    const y = Number(recalled[1]);
    const z = Number(recalled[2]);
    if (![x, y, z].every((n) => Number.isFinite(n))) {
        return `死亡点记录坏了，字段 ${recalled.join('、')} 读不出坐标，所以只能按重新备战处理。`;
    }
    const current = readDimension(bot);
    const deathPosition = vec(x, y, z);

    // 经过时间：本进程第一次看到这个点的时间（下界）。同一个点再看一次会累计。
    const key = deathKey(x, y, z);
    const now = Date.now();
    const firstSeen = deathClocks.get(key);
    if (firstSeen == null) deathClocks.set(key, now);
    const secondsSinceDeath = Math.max(0, Math.round((now - (firstSeen ?? now)) / 1000));
    const elapsedIsLowerBound = firstSeen == null;

    // 尸体那格现在在不在加载区块里（读不到 = 不知道 → 按"不倒计时"处理，那是最乐观的一档，要说明）。
    const loaded: boolean | null = (() => {
        try {
            if (typeof bot?.blockAt !== 'function') return null;
            return bot.blockAt(new Vec3Class(Math.floor(x), Math.floor(y), Math.floor(z))) != null;
        } catch {
            return null;
        }
    })();

    const portal = agent?.memory_bank?.recallPlace?.('overworld_end_portal');
    const overworldPortal =
        Array.isArray(portal) && portal.length >= 3 && portal.every((n: unknown) => Number.isFinite(Number(n)))
            ? vec(Number(portal[0]), Number(portal[1]), Number(portal[2]))
            : null;

    const fellOutOfWorld = y < -60;
    const plan = planRecovery({
        deathDimension: current ?? 'unknown',
        deathPosition,
        overworldPortal,
        secondsSinceDeath,
        chunkLoadedSinceDeath: loaded === true,
        fellOutOfWorld,
    });

    const details: string[] = [
        `记录点：(${Math.round(x)},${Math.round(y)},${Math.round(z)})｜死亡维度按你**现在**所在的 ${current ?? '未知'} 推断（内存里只存了坐标）`,
        elapsedIsLowerBound
            ? '这是本进程第一次看到这个死亡点，**真实死亡时间未知**（不知道已经过了多久）——按最坏情况抓紧。'
            : `从本进程第一次看到这个死亡点起已经过了 ${secondsSinceDeath}s（掉落物 300s 上限，只在区块加载时倒计时）。`,
        loaded == null
            ? '尸体那格读不到（区块没加载/没有世界数据）：按"区块没人 → 不倒计时"处理，但**另一个 bot 如果在附近，计时是在跑的**。'
            : loaded
                ? '尸体那格现在是加载区块：**倒计时在跑**（也可能被另一个 bot 或者强加载区块跑着）。'
                : '尸体那格现在不在加载区块里：只要没人过去（**另一个 bot 也算人**），5 分钟计时是暂停的。',
        ...plan.steps,
        plan.message,
    ];

    if (current === 'the_end') {
        details.push('你现在就在末地：直接过去捡；路上先确认龙在哪，别在它头顶上捡东西。');
        const arrived = await skills.goToPosition(bot, x, y, z, 2);
        details.push(arrived ? '走到记录点附近了，把地上的东西捡回来。' : '没能走过去（路被堵/落差太大）：用 goToCoordinates 分段靠近。');
    } else {
        details.push(
            overworldPortal != null
                ? `回末地的路线：主世界那个末地传送门记在 (${Math.round(overworldPortal.x)},${Math.round(overworldPortal.y)},${Math.round(overworldPortal.z)})（激活过的门一直亮着），到了调 enterEnd 进去。`
                : '没有记下主世界传送门坐标（overworld_end_portal 是空的）：要么还没进过末地，要么身体重启把它清掉了——只能回要塞找那个门，或者掷末影之眼重找要塞。',
        );
        details.push(
            `你现在在 ${current ?? '未知维度'}，跨维度那一段（回要塞 → 进末地）要自己走，这个工具不会替你传送。` +
                '**如果掉进虚空死的（Y<-60）就别去捡了**：虚空里的掉落物当场消失。',
        );
    }
    return endgameReceipt(
        plan.itemOutlook === 'lost' ? '死亡回收：东西没了，改走"重新备战"。' : '死亡回收',
        details,
    );
}

/**
 * 投掷手里的东西（末影之眼 / 末影珍珠 / 雪球 / 鸡蛋）——末地找要塞和空中自救都要它。
 *
 * **为什么不在 `skills.ts`**：那是共享文件，接线期别人正在改；这个原语目前只有末地命令
 * 用得到，就先住在末地库里，等稳定了再由 Lead 决定要不要搬进 `skills.ts`。
 *
 * 三件事：先瞄准（可选）→ `activateItem` 右键 → **核对手里那一叠的数量**。
 * 数量没减少就说明服务端没采纳（或手里这个不是投掷物），如实报出来，绝不假装成功。
 */
export async function throwHeld(bot: any, aim: Vec3 | null = null): Promise<boolean> {
    const held: any = bot?.heldItem;
    if (held == null || typeof held.name !== 'string') {
        skills.log(bot, '手上是空的，没有拿着 ender_eye 或 ender_pearl。');
        return false;
    }
    const before: number = typeof held.count === 'number' ? held.count : 1;
    if (aim != null && Number.isFinite(aim.x) && Number.isFinite(aim.y) && Number.isFinite(aim.z)) {
        try {
            await bot.lookAt(new Vec3Class(aim.x, aim.y, aim.z), true);
        } catch {
            skills.log(bot, '瞄准时出错，按当前视角扔。');
        }
    }
    try {
        await bot.activateItem();
    } catch (err: unknown) {
        skills.log(bot, `投掷没有成功，错误是 ${err instanceof Error ? err.message : String(err)}。`);
        return false;
    }
    // 服务端要过一两个 tick 才会扣掉手里的数量；等一小会儿再核对。
    await skills.wait(bot, 300);
    const after: any = bot.heldItem;
    const afterCount: number =
        after != null && after.name === held.name && typeof after.count === 'number' ? after.count : 0;
    const threw: boolean = afterCount < before;
    skills.log(
        bot,
        threw
            ? `扔出了 1 个 ${held.name}（还剩 ${afterCount} 个）。`
            : `发了"使用物品"包，但 ${held.name} 数量没变（${before} → ${afterCount}）：可能服务端没采纳，或者手里这个不是投掷物。别当作扔成功。`,
    );
    return threw;
}
