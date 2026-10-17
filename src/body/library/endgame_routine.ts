/**
 * 末地通关：**碰世界的那一层**（骨架 + 已可用的部分）。
 *
 * 分工：
 * - `endgame.ts` 是纯逻辑（拆水晶顺序、床炸闸门、龙息躲避、装备清单、状态机），有 44 条单元测试；
 * - 这个文件只做两件事：**(1) 把 bot 状态读成纯逻辑吃的信号**，**(2) 按 plan 调 `skills` 干活**。
 *
 * ⚠️ 接手须知（Lead 看这里）：
 * 本文件**没有**注册进 `commands/registry.ts`，也**没有**改 `actions.ts` / `prompts.ts`
 * ——按协作边界，共享入口留给 Lead 接线。下面 `endgameToolSpecs` 就是"要注册成什么"的
 * 完整声明，照抄进 `actionsList` 即可（每条都写清了复用哪个现有能力）。
 *
 * 标了 `TODO(真机)` 的地方是**我无法离线验证**的 mineflayer 行为（床的两格放置、
 * 主动引爆床、投掷末影之眼），已经在 docs/endgame/01-actions.md 里列成验证清单。
 */
import Vec3Class from 'vec3';
import * as skills from './skills.js';
import * as world from './world.js';
import { opContextFor, permits } from '../safety/permits.js';
import {
    DRAGON_MAX_HEALTH,
    END_PODIUM,
    assessEndGear,
    choosePotionToDrink,
    findPotionItem,
    formatEndgameReport,
    horizontalDistance,
    nextEndgameStep,
    normalizeName,
    planBedBombing,
    planBreathEscape,
    planCrystalAssault,
    planRecovery,
    potionStock,
    vec,
    type BreathCloud,
    type EffectInfo,
    type EndCrystalInfo,
    type EndGearAssessment,
    type EndgamePhase,
    type PotionKind,
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
 * 末地通关建议暴露的 9 条工具。**我没有注册它们**，这是给 Lead 的接线清单。
 * `kind` 决定进查询表还是动作表（见 `registry.ts` 的注释）。
 */
export const endgameToolSpecs: EndgameToolSpec[] = [
    {
        name: 'endFightStatus',
        kind: 'query',
        description:
            '末地通关体检：当前阶段、还差哪些装备、还有几颗水晶、龙还剩多少血、有没有故意踩进龙息云。' +
            '**进末地前先调这个**，它会把"没带缓降药水"这种要命的缺口直接点出来。',
        params: {},
        backing: '新增查询命令；纯读 bot 状态，不占身体通道。',
    },
    {
        name: 'enterEnd',
        kind: 'action',
        description:
            '自动进入末地：找末地传送门 → 有末影之眼就把 12 个框架填满 → 走进传送门并等维度切换。' +
            '进去会落在 (100,49,0) 的黑曜石平台上，面朝西，平台和主岛之间可能隔着虚空。',
        params: {},
        timeoutMinutes: 5,
        backing: '复用 skills.goToNearestBlock + useToolOn(ender_eye, end_portal_frame)；维度切换判定照抄 nether_portal.ts 的 dimensionChanged。',
    },
    {
        name: 'clearEndCrystals',
        kind: 'action',
        description:
            '拆末地水晶：地面能看到的用弓射（站到 12 格外），笼中那两颗用 TNT 从顶上掏或上柱子拆铁栏杆。' +
            '**只要还剩一颗，龙就一直回血**，所以这一步做完才该去打龙。',
        params: {
            crystal_id: { type: 'string', description: '可选。只拆指定 id 的那颗（快照实体表里的 #N）。不给就按 plan 的推荐顺序全拆。', optional: true },
        },
        timeoutMinutes: 5,
        backing: '新增动作命令；射箭复用 skills.attackEntity，TNT 复用 skills.placeBlock + ignite 许可，拆栏杆复用 skills.mineBlockAt。',
    },
    {
        name: 'bedBombDragon',
        kind: 'action',
        description:
            '床炸末影龙：龙低头停在 (0,64,0) 传送门结构上时，走到它头边 → 放床 → 旁边放一块挡爆风的方块 → 点床 → 立刻退。' +
            '**安全闸门是硬的**：没有掩体、又退不到 10 格外时会直接拒绝执行，只告诉你为什么。',
        params: {
            beds: { type: 'int', description: '最多炸几张床（默认 1，能省就省）。', optional: true, domain: [1, 10] },
        },
        timeoutMinutes: 3,
        backing: '新增动作命令；放床复用 skills.placeBlock，引爆需要新原语（bot.sleep / activateBlock，见 docs 的待验证清单），必须先 allowDangerousOps("sleep_in_bed")。',
    },
    {
        name: 'dodgeDragonBreath',
        kind: 'action',
        description:
            '躲龙息：按地上的紫色云和"龙头低停时 20 格内会被喷"两条规则算出该往哪跑，然后跑过去。' +
            '已经站在云里时就近方向冲刺出去。',
        params: {},
        timeoutMinutes: 2,
        backing: '新增动作命令；计算在 endgame.planBreathEscape，执行复用 skills.moveBy / goToPosition。',
    },
    {
        name: 'drinkPotion',
        kind: 'action',
        description:
            '按**效果**喝药，而不是按物品名：kind=slow_falling / resistance / regeneration / healing / strength / milk。' +
            '现有的 consume 只认物品名，而所有药水都叫 "potion" —— 模型没法说"喝缓降"，所以这条是补的硬缺口。' +
            'kind=milk 会用牛奶桶清掉**全部** Buff（包括你自己刚喝的好 Buff），悠着用。',
        params: {
            kind: { type: 'string', description: '要喝哪一类：slow_falling / resistance / regeneration / healing / strength / fire_resistance / milk。' },
        },
        timeoutMinutes: 2,
        backing: '新增动作命令；equip + consume，逻辑照抄 survival.ts 的 drinkFireResistancePotion 但按大类找。',
    },
    {
        name: 'recoverAfterDeath',
        kind: 'action',
        description:
            '死亡回收：告诉你尸体坐标、掉落物还剩多少秒、以及从记录的主世界传送门再进末地的路线。' +
            '掉进虚空的东西不用捡。',
        params: {},
        timeoutMinutes: 10,
        backing: '新增动作命令；纯计算在 endgame.planRecovery，执行复用 goToCoordinates / enterEnd。',
    },
    {
        name: 'drinkMilk',
        kind: 'action',
        description:
            '喝牛奶桶：立刻清掉自己身上的**全部**状态效果。**会连自己刚喝的缓降/再生/抗性一起清掉**，' +
            '所以只在中了负面效果（中毒/虚弱/缓慢…）时用，别当疗伤药；也**不能灭火**。',
        params: {},
        timeoutMinutes: 2,
        backing: '调用 endgame_routine.drinkPotionByKind(bot, "milk")（equip + consume）。',
    },
    {
        name: 'throwHeld',
        kind: 'action',
        description:
            '把手里的东西扔出去（先 equip）：末影之眼指路找要塞（飞约 12 格，每次 20% 概率碎），' +
            '末影珍珠位移/免摔伤（下坠时会自动往脚下扔）。扔完会核对手里那一叠的数量有没有真的减少，' +
            '没减少就如实报"没扔成"，不假装成功。',
        params: {},
        timeoutMinutes: 1,
        backing: '原子原语 throwHeld 在 library/endgame_routine.ts（瞄准 + activateItem + 数量核对），已实现。',
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
export function effectNameFromRegistry(bot: any, id: number): string {
    const registry = bot?.registry;
    const fromMap = registry?.effects?.[id];
    if (fromMap?.name != null) return normalizeName(fromMap.name);
    const arr = registry?.effectsArray;
    if (Array.isArray(arr)) {
        const found = arr.find((entry: any) => entry?.id === id);
        if (found?.name != null) return normalizeName(found.name);
    }
    return `effect_${id}`;
}

/** 读身上 Buff。mineflayer 的 `bot.entity.effects` 是 {id: {id, amplifier, duration}}，duration 是 tick。 */
export function readEffects(bot: any): EffectInfo[] {
    const raw = bot?.entity?.effects;
    if (raw == null || typeof raw !== 'object') return [];
    const entries: Array<[string, any]> = Array.isArray(raw)
        ? raw.map((value: any, index: number) => [String(index), value] as [string, any])
        : Object.entries(raw as Record<string, any>);
    const out: EffectInfo[] = [];
    for (const [, value] of entries) {
        const effect: any = value;
        if (effect == null || typeof effect !== 'object') continue;
        const id = typeof effect.id === 'number' ? effect.id : null;
        const name =
            effect.name != null ? normalizeName(effect.name) : id != null ? effectNameFromRegistry(bot, id) : 'unknown';
        const durationTicks = typeof effect.duration === 'number' ? effect.duration : null;
        out.push({
            name,
            seconds: durationTicks == null ? null : Math.max(0, Math.round(durationTicks / 20)),
            amplifier: typeof effect.amplifier === 'number' ? effect.amplifier : 0,
        });
    }
    return out;
}

/**
 * 从 boss bar 读末影龙血量。
 * mineflayer 的 `bot.bossBars` 项是 {title, health(0~1), ...}；标题可能是 ChatMessage 对象，
 * 所以两边都试。读不到返回 null —— **null 表示"不知道"，不是"死透了"**。
 */
export function readDragonHealth(bot: any): number | null {
    const bars = bot?.bossBars;
    if (!Array.isArray(bars)) return null;
    for (const bar of bars) {
        const title = typeof bar?.title === 'string' ? bar.title : (bar?.title?.toString?.() ?? '');
        const text = String(title);
        const lowered = text.toLowerCase();
        if (!lowered.includes('dragon') && !text.includes('末影龙')) continue;
        if (typeof bar?.health !== 'number') return null;
        return Math.max(0, Math.min(1, bar.health)) * DRAGON_MAX_HEALTH;
    }
    return null;
}

/** 水晶是不是被铁栏杆罩住。读不到世界就返回 undefined（**不猜**）。 */
function detectCagedCrystal(bot: any, entity: any): boolean | undefined {
    try {
        const base = entity?.position;
        if (base == null || typeof base.offset !== 'function' || typeof bot?.blockAt !== 'function') return undefined;
        const neighbors: Array<[number, number, number]> = [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 0, 1],
            [0, 0, -1],
            [0, 1, 0],
        ];
        for (const [dx, dy, dz] of neighbors) {
            const block = bot.blockAt(base.offset(dx, dy, dz));
            if (block?.name === 'iron_bars') return true;
        }
        return false;
    } catch {
        return undefined;
    }
}

export function readEndCrystals(bot: any): EndCrystalInfo[] {
    const entities = bot?.entities;
    if (entities == null || typeof entities !== 'object') return [];
    const out: EndCrystalInfo[] = [];
    for (const [id, entity] of Object.entries(entities as Record<string, any>)) {
        const e: any = entity;
        if (e == null || typeof e !== 'object') continue;
        if (typeof e.name !== 'string' || !e.name.includes('end_crystal')) continue;
        const position = toVec(e.position);
        if (position == null) continue;
        const caged = detectCagedCrystal(bot, e);
        out.push(caged === undefined ? { id, position } : { id, position, caged });
    }
    return out;
}

export function readDimension(bot: any): string | null {
    const raw = bot?.game?.dimension ?? bot?.game?.dimensionName;
    if (typeof raw !== 'string') return null;
    return normalizeName(raw);
}

/**
 * 龙是不是正低头停在出口传送门上。
 *
 * **启发式（TODO 真机标定）**：龙实体水平离 (0,64,0) 很近、且高度低到 70 以下。
 * Wiki 只说"它停到出口传送门结构最高处"，没给可编程的判据；先用这个阈值，
 * 真机跑起来用反馈校准。
 */
export function readDragonPerched(bot: any): boolean {
    const dragon = findDragonEntity(bot);
    if (dragon == null) return false;
    const position = toVec(dragon.position);
    if (position == null) return false;
    return horizontalDistance(position, END_PODIUM) < 6 && position.y < 70;
}

function findDragonEntity(bot: any): any | null {
    const entities = bot?.entities;
    if (entities == null || typeof entities !== 'object') return null;
    for (const entity of Object.values(entities as Record<string, any>)) {
        const e: any = entity;
        if (typeof e?.name === 'string' && e.name.includes('ender_dragon')) return e;
    }
    return null;
}

export interface EndSignals {
    dimension: string | null;
    inEnd: boolean;
    position: Vec3 | null;
    crystals: EndCrystalInfo[];
    crystalsAlive: number;
    dragonHealth: number | null;
    dragonPerched: boolean;
    effects: EffectInfo[];
    gear: EndGearAssessment;
    breath: BreathCloud[];
}

/** 一次把"末地决策要用到的所有信号"读出来。整个函数对坏数据一律降级成 null/空数组，不抛。 */
export function readEndSignals(bot: any): EndSignals {
    const dimension = readDimension(bot);
    const position = toVec(bot?.entity?.position);
    const crystals = readEndCrystals(bot);
    const effects = readEffects(bot);
    const gear = assessEndGear({
        inventory: safeInventoryCounts(bot),
        items: safeInventoryItems(bot),
        effects,
    });
    return {
        dimension,
        inEnd: dimension === 'the_end',
        position,
        crystals,
        crystalsAlive: crystals.length,
        dragonHealth: readDragonHealth(bot),
        dragonPerched: readDragonPerched(bot),
        effects,
        gear,
        breath: readBreathClouds(bot),
    };
}

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

/** 龙息云在客户端是 area_effect_cloud 实体（`cloud.name` 里带 area_effect_cloud / dragon_breath）。 */
export function readBreathClouds(bot: any): BreathCloud[] {
    const entities = bot?.entities;
    if (entities == null || typeof entities !== 'object') return [];
    const out: BreathCloud[] = [];
    for (const entity of Object.values(entities as Record<string, any>)) {
        const e: any = entity;
        if (typeof e?.name !== 'string') continue;
        if (!e.name.includes('area_effect_cloud')) continue;
        const position = toVec(e.position);
        if (position == null) continue;
        out.push({ position });
    }
    return out;
}

// ============================ 三、可执行动作（能落地的部分） ============================

/**
 * 按**效果**喝药。这是 `drinkPotion` 命令的实现体，逻辑同 survival.ts 的
 * `drinkFireResistancePotion`，只是按大类找而不是写死抗火。
 */
export async function drinkPotionByKind(bot: any, kind: PotionKind | 'milk' | string): Promise<boolean> {
    const wanted = normalizeName(kind) as PotionKind | 'milk';
    const items = safeInventoryItems(bot);
    const potion = findPotionItem(items, wanted);
    if (potion == null) {
        skills.log(bot, `背包里没有 ${wanted} 这一类药水。`);
        return false;
    }
    try {
        await bot.equip(potion, 'hand');
        await bot.consume();
        skills.log(bot, `喝下了 ${wanted}${wanted === 'milk' ? '（全部 Buff 会被清掉）' : ''}。`);
        return true;
    } catch (error) {
        skills.log(bot, `喝 ${wanted} 失败：${(error as Error)?.message ?? String(error)}`);
        return false;
    }
}

/** 喝牛奶 = 清掉所有状态效果。**会连自己刚喝的好 Buff 一起清**，只在中毒/虚弱等时候用。 */
export function drinkMilk(bot: any): Promise<boolean> {
    return drinkPotionByKind(bot, 'milk');
}

/**
 * 龙低头时，按 planBedBombing 的闸门决定要不要炸。
 *
 * 这里**只实现到"算 + 判定"**；真正下手的两步（放床、引爆）标了 TODO(真机)：
 * mineflayer 对"两格宽的床"的放置、以及主动引爆床的交互我离线验证不了，
 * 宁可先返回"拒绝/演练"也不要瞎按。
 */
export async function bedBombDragon(bot: any, options: { beds?: number; dryRun?: boolean } = {}): Promise<string> {
    const signals = readEndSignals(bot);
    if (!signals.inEnd) return '你现在不在末地，先 enterEnd。';
    const dragon = findDragonEntity(bot);
    const headPosition = toVec(dragon?.position);
    if (headPosition == null) return '看不见末影龙，先别放床。';
    if (!signals.dragonPerched) return '龙没低头停在传送门上——床炸打不到它，等它停。';

    const position = signals.position;
    if (position == null) return '读不到自己的坐标，不做危险动作。';

    // 站/床都取"龙脚下那一格": 床放在龙的水平位置旁边 1 格，人站在 2 格外但有掩体。
    const bedCell = vec(Math.round(headPosition.x) + 1, Math.floor(headPosition.y) - 1, Math.round(headPosition.z));
    const standCell = vec(bedCell.x + 1, bedCell.y, bedCell.z);
    const plan = planBedBombing({
        dragonHead: headPosition,
        bedCell,
        standCell,
        inTrench: true,
    });

    if (!plan.ok) return `没有执行床炸：${plan.reason}`;
    if (options.dryRun === true) return `演练（没真放）：${plan.reason}`;

    const bedItem = pickBedItemName(bot);
    if (bedItem == null) return '背包里没有床。';

    // 末地点床 = 尝试睡觉 = 爆炸。**先把闸门问清楚：没授权就一个方块都不放。**
    const verdict = permits.isAllowed('sleep_in_bed', opContextFor(bot), Date.now());
    if (!verdict.allowed) {
        return '床炸要先授权：调 allowDangerousOps(ops="sleep_in_bed", calls=1)（一张床 = 一次），再调这个工具。没有放任何方块。';
    }

    // TODO(真机): 床是两格方块，placeBlock 对 bed 的支持未验证；失败就退回手工放。
    const placed = await skills.placeBlock(bot, bedItem, bedCell.x, bedCell.y, bedCell.z);
    if (!placed) return '床没放下去（两格方块的放置还没在真机验证过），先别点它。';
    skills.log(bot, `床放好了，预计打掉龙 ${plan.expectedDragonDamage.toFixed(0)} HP；${plan.reason}`);

    const bedBlock = typeof bot?.blockAt === 'function' ? bot.blockAt(new Vec3Class(bedCell.x, bedCell.y, bedCell.z)) : null;
    if (bedBlock == null) return '床放好了但读不到那一格，没敢点（怕点错东西）。';
    const healthBefore = typeof bot?.health === 'number' ? bot.health : null;
    try {
        // TODO(真机): bot.sleep 与 bot.activateBlock 在末地谁更好用要实测；两个都会炸，
        // 所以用 race + 吞异常，别让预期中的爆炸把整条命令带崩。
        await Promise.race([bot.sleep(bedBlock), skills.wait(bot, 2000)]);
    } catch {
        // 预期：末地睡不成，床炸了
    }
    await skills.moveAway(bot, 6);
    const healthAfter = typeof bot?.health === 'number' ? bot.health : null;
    const hurt = healthBefore != null && healthAfter != null ? Math.max(0, healthBefore - healthAfter) : null;
    const hurtText = hurt == null ? '自伤读不到' : hurt > 6 ? `自伤 ${hurt} 点偏高——下次先把掩体补好或退得更远` : `自伤 ${hurt} 点`;
    return `床炸完了（${hurtText}）。预期打掉龙 ${plan.expectedDragonDamage.toFixed(0)} HP；如果龙没掉血，说明它没停在床上方。`;
}

export function pickBedItemName(bot: any): string | null {
    const items = safeInventoryItems(bot);
    for (const item of items) {
        if (typeof item?.name === 'string' && /(^|_)bed$/.test(normalizeName(item.name))) return item.name;
    }
    return null;
}

/**
 * 一键体检报告：把一个 query 工具该说的话全拼好。
 * 直接喂给模型就能用，不需要它自己拼坐标。
 */
export function endgameStatusReport(bot: any): string {
    const signals = readEndSignals(bot);
    const advice = nextEndgameStep({
        gearReady: signals.gear.ok,
        inEnd: signals.inEnd,
        crystalsAlive: signals.crystalsAlive,
        dragonHealth: signals.dragonHealth,
    });
    const lines = [formatEndgameReport(signals.gear, advice)];
    lines.push(
        `【现状】维度 ${signals.dimension ?? '未知'}｜水晶 ${signals.crystals.length} 颗｜龙血 ${
            signals.dragonHealth == null ? '读不到' : `${signals.dragonHealth.toFixed(0)}/${DRAGON_MAX_HEALTH}`
        }｜龙${signals.dragonPerched ? '正低头停在传送门上' : '在飞'}`
    );
    if (signals.position != null) {
        const { x, y, z } = signals.position;
        lines.push(`【位置】(${Math.round(x)},${Math.round(y)},${Math.round(z)})`);
    }
    if (signals.crystalsAlive > 0 && signals.position != null) {
        lines.push(`【拆水晶】${planCrystalAssault({ crystals: signals.crystals, self: signals.position }).message}`);
    }
    if (signals.breath.length > 0 && signals.position != null) {
        const escape = planBreathEscape({
            self: signals.position,
            clouds: signals.breath,
            dragonPerched: signals.dragonPerched,
        });
        lines.push(`【龙息】${escape.reason}`);
    }
    return lines.join('\n');
}

/** 供 Lead 接线时用的阶段枚举导出（避免文档和代码里两份字符串）。 */
export type { EndgamePhase };

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

export function countEnderPearls(bot: any): number {
    return countOf(bot, (name) => name === 'ender_pearl');
}

/** 拆水晶的家当：弓/弩、箭、镐、TNT。 */
export function crystalToolKit(bot: any): { bow: string | null; arrows: number; pickaxe: boolean; tnt: number } {
    const counts = safeInventoryCounts(bot);
    const bow = ['bow', 'crossbow'].find((name) => (counts[name] ?? 0) > 0) ?? null;
    const arrows =
        (counts['arrow'] ?? 0) + (counts['spectral_arrow'] ?? 0) + (counts['tipped_arrow'] ?? 0);
    const pickaxe = Object.keys(counts).some((name) => normalizeName(name).endsWith('_pickaxe'));
    return { bow, arrows, pickaxe, tnt: counts['tnt'] ?? 0 };
}

/**
 * 拉弓射一箭。
 *
 * TODO(真机)：`activateItem`（开始拉弓）→ 等 → `deactivateItem`（放箭）这套是按协议
 * 推的，离线验证不了：要确认箭真的飞出去、拉弓多久命中率最好。弩是立刻击发，时序不同，
 * 这里先按弓处理。
 */
export async function shootAtEntity(bot: any, entity: any, chargeMs = 900): Promise<string> {
    const kit = crystalToolKit(bot);
    if (kit.bow == null) return '没有弓/弩，射不了——先去弄一把。';
    if (kit.arrows <= 0) return '没有箭，射不了。';
    const equipped = await skills.equip(bot, kit.bow);
    if (!equipped) return `弓/弩没拿到手上（${kit.bow}），射不了。`;
    const position = toVec(entity?.position);
    if (position == null) return '目标位置读不到，射不了。';
    const height = typeof entity?.height === 'number' ? entity.height : 1;
    try {
        await bot.lookAt(new Vec3Class(position.x, position.y + height / 2, position.z), true);
        await bot.activateItem();
        await skills.wait(bot, chargeMs);
        await bot.deactivateItem();
        await skills.wait(bot, 300);
    } catch (err) {
        return `射箭时出错：${err instanceof Error ? err.message : String(err)}`;
    }
    return `朝 ${entity?.name ?? '目标'} 放了一箭（拉弓 ${chargeMs}ms）。如果没打中，先看准星是不是被方块挡住了。`;
}

/** 按优先级喝药。**决策是纯函数**（`choosePotionToDrink`），这里只负责找药、喝、回报。 */
export async function drinkPotionsByPriority(bot: any): Promise<string> {
    const signals = readEndSignals(bot);
    const stock = potionStock(safeInventoryItems(bot));
    const health = typeof bot?.health === 'number' ? bot.health : null;
    const airborne = bot?.entity?.onGround === false;
    const decision = choosePotionToDrink({
        effects: signals.effects,
        stock,
        health,
        inEnd: signals.inEnd,
        airborne,
    });
    if (decision.kind == null) return decision.reason;
    const drank = await drinkPotionByKind(bot, decision.kind);
    if (!drank) return `想喝 ${decision.kind}（${decision.reason}），但背包里没有这一类药水。`;
    return `喝了 ${decision.kind}：${decision.reason}`;
}

/** 被掀飞/高空坠落时的自保：往脚下扔一颗末影珍珠。不适用时返回 null。 */
export async function pearlFallRescue(bot: any): Promise<string | null> {
    if (bot?.entity?.onGround !== false) return null;
    const velocity = toVec(bot?.entity?.velocity);
    if (velocity == null || velocity.y >= -0.4) return null;
    if (countEnderPearls(bot) <= 0) return null;
    const position = toVec(bot?.entity?.position);
    if (position == null) return null;
    const equipped = await skills.equip(bot, 'ender_pearl');
    if (!equipped) return null;
    const threw = await throwHeld(bot, vec(position.x, position.y - 8, position.z));
    return threw
        ? `正在下坠（vy=${velocity.y.toFixed(2)}）：往脚下扔了一颗末影珍珠落地。`
        : '正在下坠，但末影珍珠没扔出去（手里数量没变）——改用缓降药水/水桶自救。';
}

/** 躲龙息。先自保（空中扔珍珠），再按 `planBreathEscape` 挪出伤害区/20 格。 */
export async function dodgeDragonBreathSkill(bot: any): Promise<string> {
    const rescue = await pearlFallRescue(bot);
    if (rescue != null) return rescue;

    const start = toVec(bot?.entity?.position);
    if (start == null) return '读不到自己的坐标，先别乱跑。';
    const first = planBreathEscape({
        self: start,
        clouds: readBreathClouds(bot),
        dragonPerched: readDragonPerched(bot),
    });
    if (first.urgency === 'none') return first.reason;

    let latest = first;
    for (let step = 0; step < 6; step++) {
        const self = toVec(bot?.entity?.position) ?? start;
        latest = planBreathEscape({
            self,
            clouds: readBreathClouds(bot),
            dragonPerched: readDragonPerched(bot),
        });
        if (latest.urgency === 'none') break;
        const target = latest.escapeTarget;
        const reached = await skills.goToPosition(bot, target.x, target.y, target.z, 1.2);
        if (!reached) break;
    }
    return `${first.reason} 已经往 (${Math.round(latest.escapeTarget.x)},${Math.round(latest.escapeTarget.z)}) 方向挪开；还是不安全就再调一次。`;
}

/** 投掷手里的东西（末影之眼指路 / 末影珍珠位移·自救）。 */
export async function throwHeldSkill(bot: any): Promise<string> {
    const held: any = bot?.heldItem;
    if (held == null || typeof held.name !== 'string') {
        return '手上是空的：先用 equip 把要扔的东西拿到手上（ender_eye 末影之眼 / ender_pearl 末影珍珠），再调这个工具。';
    }
    const name = normalizeName(held.name);
    const position = toVec(bot?.entity?.position);
    const velocity = toVec(bot?.entity?.velocity);
    const falling = bot?.entity?.onGround === false && velocity != null && velocity.y < -0.4;
    const aim = falling && position != null ? vec(position.x, position.y - 8, position.z) : null;
    const threw = await throwHeld(bot, aim);
    if (!threw) {
        return `没有把 ${name} 扔出去（手里数量没变）：可能服务端没采纳，或者手里这个不是投掷物。`;
    }
    if (name.includes('ender_eye')) {
        return endgameReceipt('末影之眼扔出去了，它朝最近的要塞方向飞约 12 格。', [
            '跟着眼睛指的方向走；眼睛开始往下钻 → 要塞在脚下，往下挖。',
            '每次扔有 20% 概率碎掉，多备几颗（12 颗眼才够填满传送门）。',
        ]);
    }
    if (name.includes('ender_pearl')) {
        return falling ? '下坠中往脚下扔了一颗末影珍珠，摔落伤害基本免掉。' : '末影珍珠扔出去了。';
    }
    return `扔出了 ${name}。`;
}

/** 进末地：已有传送门就走进去；没有就把空框架用末影之眼填满，再走进去。 */
export async function enterEndSkill(bot: any): Promise<string> {
    const before = readDimension(bot);
    if (before === 'the_end') return '已经在末地了，不用再进。';
    const details: string[] = [];

    const stepThrough = async (portal: any): Promise<boolean> => {
        const p = toVec(portal?.position);
        if (p == null) return false;
        await skills.goToPosition(bot, p.x + 0.5, p.y, p.z + 0.5, 0.5);
        return skills.waitFor(bot, () => readDimension(bot) === 'the_end', 15000);
    };

    const existing = world.getNearestBlock(bot, 'end_portal', 48);
    if (existing != null) {
        const p = toVec(existing.position);
        details.push(`发现已激活的末地传送门 (${p == null ? '?' : `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`})`);
        if (await stepThrough(existing)) {
            details.push(`维度：${before ?? '未知'} → the_end。落点 (100,49,0) 面朝西，先看平台和主岛之间有没有空隙。`);
            return endgameReceipt('已进入末地。', details);
        }
        details.push('走过去了但维度没切：可能没真的踩进传送门方块。用 stats 看坐标，再调一次。');
        return endgameReceipt('没进成末地。', details);
    }

    details.push('48 格内没有已激活的末地传送门，改找传送门框架');
    const frames = world.getNearestBlocksWhere(
        bot,
        (block: any) => block?.name === 'end_portal_frame' && ((block.metadata ?? 0) & 4) === 0,
        32,
        12,
    );
    if (frames.length === 0) {
        details.push('附近没有空的末地传送门框架：要塞不在这。先用末影之眼找要塞，站到传送门房再调这个工具。');
        return endgameReceipt('没有找到可以放眼的传送门框架。', details);
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
    details.push('传送门亮了，走进去');
    if (await stepThrough(opened)) {
        details.push(`维度：${before ?? '未知'} → the_end。落点 (100,49,0) 面朝西。`);
        return endgameReceipt('已进入末地。', details);
    }
    details.push('传送门激活了但没走进去（维度没切），再调一次。');
    return endgameReceipt('没进成末地。', details);
}

/** 找那颗水晶对应的实体（先按 id 对，再按坐标兜底）。 */
function findCrystalEntity(bot: any, crystal: EndCrystalInfo): any | null {
    const entities = bot?.entities;
    if (entities == null || typeof entities !== 'object') return null;
    const entries = Object.entries(entities as Record<string, any>);
    if (crystal.id != null) {
        const byId = entries.find(([id]) => id === String(crystal.id));
        if (byId != null && typeof (byId[1] as any)?.name === 'string') return byId[1];
    }
    for (const [, entity] of entries) {
        const e: any = entity;
        if (typeof e?.name !== 'string' || !e.name.includes('end_crystal')) continue;
        const p = toVec(e.position);
        if (p == null) continue;
        if (horizontalDistance(p, crystal.position) <= 2 && Math.abs(p.y - crystal.position.y) <= 3) return e;
    }
    return null;
}

/** 笼中水晶的安全打法：在铁栏杆顶上放 TNT，点火，立刻后撤。 */
async function tntTheCage(bot: any, crystal: EndCrystalInfo, details: string[]): Promise<string> {
    if ((safeInventoryCounts(bot)['tnt'] ?? 0) <= 0) {
        details.push('没有 TNT：要么去合成（火药+沙子），要么上柱子拆铁栏杆（先喝缓降）。');
        return endgameReceipt('笼中水晶现在拆不掉。', details);
    }
    const verdict = permits.isAllowed('ignite', opContextFor(bot), Date.now());
    if (!verdict.allowed) {
        details.push('在铁栏杆顶上放 TNT 后要点火：先 allowDangerousOps(ops="ignite", calls=1)。**这次没有放任何东西**。');
        return endgameReceipt('点火没授权，中止。', details);
    }
    const top = vec(crystal.position.x, crystal.position.y + 1, crystal.position.z);
    const placed = await skills.placeBlock(bot, 'tnt', top.x, top.y, top.z);
    if (!placed) {
        details.push(`TNT 没放到 (${top.x},${top.y},${top.z})（上面可能不是空格/够不着）`);
        return endgameReceipt('TNT 没放下去。', details);
    }
    const tntBlock = typeof bot?.blockAt === 'function' ? bot.blockAt(new Vec3Class(top.x, top.y, top.z)) : null;
    if (tntBlock == null) {
        details.push('TNT 放下了但读不到那一格，没敢点火（怕点错别的方块）。');
        return endgameReceipt('TNT 已就位但没点火。', details);
    }
    await skills.useToolOnBlock(bot, 'flint_and_steel', tntBlock);
    await skills.moveAway(bot, 6);
    details.push('点了火并后撤 6 格：TNT 大约 4 秒后炸，水晶会跟着炸。');
    return endgameReceipt('笼中水晶的 TNT 已点燃。', details);
}

/** 拆水晶：按 `planCrystalAssault` 的顺序处理下一颗（每次调用拆一颗）。 */
export async function clearEndCrystalsSkill(bot: any): Promise<string> {
    const position = toVec(bot?.entity?.position);
    if (position == null) return '读不到自己的坐标，先别碰水晶。';
    const crystals = readEndCrystals(bot);
    if (crystals.length === 0) {
        return '视野里没有末地水晶了。如果还能看见治疗光束，说明区块外还有没拆的；否则可以直接打龙。';
    }
    const kit = crystalToolKit(bot);
    const plan = planCrystalAssault({
        crystals,
        self: position,
        hasPickaxe: kit.pickaxe,
        tntCount: kit.tnt,
    });
    const target = plan.targets[0];
    if (target == null) return plan.message;

    const at = `(${Math.round(target.crystal.position.x)},${Math.round(target.crystal.position.y)},${Math.round(target.crystal.position.z)})`;
    const details: string[] = [
        `目标：${target.crystal.caged === true ? '笼中水晶' : '普通水晶'} ${at}，离你 ${target.distance.toFixed(1)} 格`,
        target.note,
    ];

    if (target.distance < plan.safeShootDistance) {
        const stand = target.standPoint;
        const moved = await skills.goToPosition(bot, stand.x, stand.y, stand.z, 2);
        details.push(
            moved
                ? `退到安全射程（爆炸威力 6，要 ≥${plan.safeShootDistance} 格）`
                : '后退没走成（路被堵？）：射的时候注意别被爆炸波及',
        );
    }

    if (target.method === 'tnt_cage') return tntTheCage(bot, target.crystal, details);

    const entity = findCrystalEntity(bot, target.crystal);
    if (entity == null) return endgameReceipt('那颗水晶的实体找不到了（可能刚被拆掉）。', details);
    details.push(await shootAtEntity(bot, entity));
    if (target.method === 'climb_cage') {
        details.push('这是笼中水晶：地面射经常被铁栏杆挡住。这一箭没效果就用 TNT 掏，或者上柱子拆栏杆（先喝缓降）。');
    }
    return endgameReceipt('朝水晶放了一箭，听爆炸声 / 看它还亮不亮。', details);
}

/** 死亡回收：读记录下来的 last_death_position，按 5 分钟/区块加载规则给方案；同维度就带你走。 */
export async function recoverAfterDeathSkill(agent: any): Promise<string> {
    const bot = agent?.bot;
    const recalled = agent?.memory_bank?.recallPlace?.('last_death_position');
    if (!Array.isArray(recalled) || recalled.length < 3) {
        return '没有记录到死亡点（last_death_position 是空的）：要么还没死过，要么被清了。';
    }
    const x = Number(recalled[0]);
    const y = Number(recalled[1]);
    const z = Number(recalled[2]);
    const current = readDimension(bot);
    const plan = planRecovery({
        deathDimension: current ?? 'unknown',
        deathPosition: vec(x, y, z),
        secondsSinceDeath: 0,
        chunkLoadedSinceDeath: false,
    });
    const details: string[] = [`记录点：(${Math.round(x)},${Math.round(y)},${Math.round(z)})`, ...plan.steps, plan.message];

    if (current === 'the_end') {
        details.push('你现在就在末地：直接过去捡；路上先确认龙在哪，别在它头顶上捡东西。');
        const arrived = await skills.goToPosition(bot, x, y, z, 2);
        details.push(arrived ? '走到记录点附近了，把地上的东西捡回来。' : '没能走过去（路被堵/落差太大）：用 goToCoordinates 分段靠近。');
    } else {
        details.push(
            `你现在在 ${current ?? '未知维度'}，跨维度那一段（回要塞 → 进末地）要自己走，这个工具不会替你传送。`,
        );
    }
    return endgameReceipt('死亡回收', details);
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
        skills.log(bot, '手上是空的：先用 equip 要扔的东西拿到手上（ender_eye 末影之眼 / ender_pearl 末影珍珠），再投掷。');
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
        skills.log(bot, `投掷失败：${err instanceof Error ? err.message : String(err)}`);
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
