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
import * as skills from './skills.js';
import * as world from './world.js';
import {
    DRAGON_MAX_HEALTH,
    END_PODIUM,
    assessEndGear,
    findPotionItem,
    formatEndgameReport,
    horizontalDistance,
    nextEndgameStep,
    normalizeName,
    planBedBombing,
    planBreathEscape,
    planCrystalAssault,
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
        backing: '复用 skills.goToNearestBlock + useToolOn(eye_of_ender, end_portal_frame)；维度切换判定照抄 nether_portal.ts 的 dimensionChanged。',
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
        name: 'locateStronghold',
        kind: 'action',
        description:
            '掷末影之眼找要塞：眼沿指向飞约 12 格（每次 20% 概率碎），跟到眼睛开始往下钻就往下挖。' +
            '**需要新原语**：目前没有"投掷手里的物品"这个原子动作。',
        params: {},
        timeoutMinutes: 10,
        backing: '⚠ 缺原语：需要新增 throwHeld（右键投掷）。在它落地前，先让模型用 goToCoordinates 沿眼的方向走 + 自己判断。',
    },
    {
        name: 'throwEnderPearl',
        kind: 'action',
        description:
            '扔末影珍珠位移/自救：被龙掀到空中时往地面扔一颗能免摔；平台离主岛太远时也能靠它过去。' +
            '同样依赖"投掷"原语。',
        params: {},
        timeoutMinutes: 2,
        backing: '⚠ 缺原语：同 locateStronghold 的 throwHeld。',
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
    // TODO(真机): 床是两格方块，placeBlock 对 bed 的支持未验证；失败就退回手工放。
    const placed = await skills.placeBlock(bot, bedItem, bedCell.x, bedCell.y, bedCell.z);
    if (!placed) return '床没放下去（两格方块的放置还没在真机验证过），先别点它。';
    skills.log(bot, `床放好了，预计打掉龙 ${plan.expectedDragonDamage.toFixed(0)} HP；${plan.reason}`);
    // TODO(真机): 引爆就是"在末地尝试睡觉"。必须先 allowDangerousOps("sleep_in_bed")，
    // 然后 bot.sleep(bot.blockAt(bedCell)) 或 bot.activateBlock(...)，并接住爆炸导致的异常。
    return '床已就位。TODO(真机)：引爆调用还没接上，见 docs/endgame/01-actions.md 的验证清单。';
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