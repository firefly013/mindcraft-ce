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
    BLOCK_REACH_DISTANCE,
    DRAGON_MAX_HEALTH,
    END_PLATFORM,
    END_PODIUM,
    EXPLOSION_POWER,
    PLATFORM_BLOCKS,
    assessEndGear,
    blastRadius,
    choosePotionToDrink,
    compassBearing,
    describeEyeDirection,
    distance as vecDistance,
    findPotionItem,
    formatEndgameReport,
    horizontalDirection,
    horizontalDistance,
    nextEndgameStep,
    normalizeName,
    planBedBombing,
    planBreathEscape,
    planCrystalAssault,
    planRecovery,
    potionKindOf,
    potionStock,
    trackEyeFlight,
    vec,
    type BreathCloud,
    type EffectInfo,
    type EndCrystalInfo,
    type EndGearAssessment,
    type EndgamePhase,
    type EyeFlightTrack,
    type EyeSample,
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
            '自动进入末地：附近有已激活的传送门就走进去；有空的传送门框架就把 12 个都用末影之眼填满；**两样都没有就替你掷一颗末影之眼指路**（找要塞）。' +
            '进门之前会把主世界那个传送门的坐标记进 Memory Bank（overworld_end_portal，死亡回收要用）。' +
            '进去会落在 (100,49,0) 的黑曜石平台上，面朝西，平台和主岛之间可能隔着虚空。',
        params: {},
        timeoutMinutes: 5,
        backing: '复用 world.getNearestBlock/getNearestBlocksWhere + skills.equip/useToolOnBlock + throwHeld；维度切换判定照抄 nether_portal.ts 的 dimensionChanged。',
    },
    {
        name: 'clearEndCrystals',
        kind: 'action',
        description:
            '拆末地水晶：地面能看到的用弓射（**退不到 12 格外就不放箭**，只告诉你该退到哪），笼中那两颗用 TNT 从顶上掏（点完按爆炸半径 12 格后撤）或上柱子拆铁栏杆。' +
            '**只要还剩一颗，龙就一直回血**，所以这一步做完才该去打龙。每次调用只处理一颗，回执会报"还剩几颗"。',
        params: {
            crystal_id: { type: 'string', description: '可选。只拆指定 id 的那颗（快照实体表里的 #N）。不给就按 plan 的推荐顺序拆下一颗。', optional: true },
        },
        timeoutMinutes: 5,
        backing: '新增动作命令；射箭复用 skills.attackEntity/equip（并核对箭数），TNT 复用 skills.placeBlock + ignite 许可，拆栏杆复用 skills.mineBlockAt。',
    },
    {
        name: 'bedBombDragon',
        kind: 'action',
        description:
            '床炸末影龙，**一次一张床**：龙低头停在 (0,64,0) 时，用 bot.blockAt 探真实地形选好"床位/掩体/站位" → 放床 → 床边放一块挡爆风的方块 → 站到掩体后 → 复检 → 点床 → 退到 10 格外。' +
            '**安全闸门是硬的**：血量 <10、饥饿 <6、没有掩体、够不着床、自伤超过一半血、龙离床 >3 格，任一成立都直接拒绝执行并说清原因。' +
            '在末地点床 = 尝试睡觉 = 爆炸，必须先 allowDangerousOps(ops="sleep_in_bed", calls=1)（一张床 = 一次授权）。',
        params: {},
        timeoutMinutes: 3,
        backing: '新增动作命令；选址 planBedBombSite（bot.blockAt 探方块），闸门 planBedBombing，放床/掩体复用 skills.placeBlock，引爆 TODO(真机) bot.sleep / activateBlock。',
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
            '死亡回收：告诉你尸体坐标、**已经在外面放了多久**、掉落物还剩多少秒、以及从记录的主世界传送门再进末地的路线。' +
            '掉落物 **5 分钟**消失，但只在区块被加载时才计时；掉进虚空（Y<-60）的东西**当场消失**，不用去捡。',
        params: {},
        timeoutMinutes: 10,
        backing: '新增动作命令；纯计算在 endgame.planRecovery，执行复用 goToCoordinates / enterEnd，传送门坐标来自 enterEnd 记的 overworld_end_portal。',
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
    /** 龙实体还在不在——龙死后 boss bar 会消失，`dragonHealth` 变 null，只能靠这一位判"打完了"。 */
    dragonAlive: boolean;
    /** 龙的位置（读不到给 null）。 */
    dragonPosition: Vec3 | null;
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
    const dragon = findDragonEntity(bot);
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
        dragonAlive: dragon != null,
        dragonPosition: toVec(dragon?.position),
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

/** 背包里某一类药水/牛奶一共几瓶（按效果大类数，不是按物品名——它们全叫 potion）。 */
export function countPotionsOfKind(bot: any, kind: PotionKind | 'milk' | string): number {
    const wanted = normalizeName(kind);
    let total = 0;
    for (const item of safeInventoryItems(bot)) {
        if (potionKindOf(item) !== wanted) continue;
        total += typeof item?.count === 'number' && Number.isFinite(item.count) ? Math.max(0, item.count) : 1;
    }
    return total;
}

/**
 * 按**效果**喝药。这是 `drinkPotion` 命令的实现体，逻辑同 survival.ts 的
 * `drinkFireResistancePotion`，只是按大类找而不是写死抗火。
 *
 * **不许假成功**（和 `throwHeld` 同一条规矩）：`bot.consume()` 只保证"包发出去了"，
 * 所以喝之前/之后各数一遍这类药水的数量，数量没减少就如实报"没喝下去"并返回 false。
 * 它直接关系到"没带缓降会不会摔死"，报成功必须有证据。
 */
export async function drinkPotionByKind(bot: any, kind: PotionKind | 'milk' | string): Promise<boolean> {
    const wanted = normalizeName(kind) as PotionKind | 'milk';
    const items = safeInventoryItems(bot);
    const potion = findPotionItem(items, wanted);
    if (potion == null) {
        skills.log(bot, `背包里没有 ${wanted} 这一类药水。`);
        return false;
    }
    const before = countPotionsOfKind(bot, wanted);
    try {
        await bot.equip(potion, 'hand');
        await bot.consume();
    } catch (error) {
        skills.log(bot, `喝 ${wanted} 失败：${(error as Error)?.message ?? String(error)}`);
        return false;
    }
    // 服务端扣物品要过一两个 tick；给它三次机会再判定。
    let after = countPotionsOfKind(bot, wanted);
    for (let attempt = 0; attempt < 2 && after >= before; attempt++) {
        await skills.wait(bot, 250);
        after = countPotionsOfKind(bot, wanted);
    }
    if (after >= before) {
        skills.log(
            bot,
            `发了"使用物品"包，但背包里 ${wanted} 的数量没变（${before} → ${after}）：可能没真的喝下去（手里是空的？被别的动作打断？）。` +
                '**别当成功**——再调一次这个工具，或者用 equip + consume 手动确认。',
        );
        return false;
    }
    skills.log(bot, `喝下了 ${wanted}（还剩 ${after} 瓶）${wanted === 'milk' ? '，全部 Buff 会被清掉' : ''}。`);
    return true;
}

/** 喝牛奶 = 清掉所有状态效果。**会连自己刚喝的好 Buff 一起清**，只在中毒/虚弱等时候用。 */
export function drinkMilk(bot: any): Promise<boolean> {
    return drinkPotionByKind(bot, 'milk');
}

// ============================ 三·B、床炸的选址与掩体（都从真实世界读） ============================

/** 床炸的最低血线：低于这个数就别赌自伤，先回血。 */
export const MIN_BED_BOMB_HEALTH = 10;
/**
 * 床炸的最低饥饿值：受伤之后靠饥饿回血，空着肚子点床就没有第二次机会。
 * （`bot.food` 读不到时不拦，只在**读到且偏低**时拒绝。）
 */
export const MIN_BED_BOMB_FOOD = 6;

const CARDINALS: ReadonlyArray<readonly [number, number]> = Object.freeze([
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
] as const);

/** 能在这一格放东西的方块名（空/草/雪这类可替换的）。 */
const REPLACEABLE_NAMES = new Set([
    'air',
    'cave_air',
    'void_air',
    'water',
    'flowing_water',
    'lava',
    'flowing_lava',
    'short_grass',
    'tall_grass',
    'grass',
    'fern',
    'dead_bush',
    'snow',
    'fire',
    'soul_fire',
    'light',
    'structure_void',
]);

function isAirLikeName(name: string | null): boolean {
    return name != null && REPLACEABLE_NAMES.has(name);
}

function isSolidName(name: string | null): boolean {
    return name != null && !REPLACEABLE_NAMES.has(name);
}

/** 读一格方块名；读不到（区块没加载 / bot 没有 `blockAt`）返回 **null——表示"不知道"，不是"空气"**。 */
function blockNameAt(bot: any, p: Vec3): string | null {
    try {
        if (typeof bot?.blockAt !== 'function') return null;
        const block = bot.blockAt(new Vec3Class(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
        return typeof block?.name === 'string' ? block.name : null;
    } catch {
        return null;
    }
}

/** 读整格方块对象（放完床之后要拿它去点）。 */
function blockObjectAt(bot: any, p: Vec3): any | null {
    try {
        if (typeof bot?.blockAt !== 'function') return null;
        return bot.blockAt(new Vec3Class(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) ?? null;
    } catch {
        return null;
    }
}

export interface BedBombSite {
    /** 床放哪一格。 */
    bedCell: Vec3;
    /** 掩体方块放哪一格（床和你之间）。 */
    coverCell: Vec3;
    /** 点床时站哪一格（掩体后面）。 */
    standCell: Vec3;
    /** 掩体格**现在**就是实体方块（不用放）。 */
    coverAlreadySolid: boolean;
    /** 站位到床的距离（目标 2 格：中间隔着一格掩体，还在 4.5 格交互距离内）。 */
    standDistance: number;
    /** 床到龙头的距离（决定打掉多少血）。 */
    dragonDistance: number;
}

/**
 * 从**真实世界**选床炸的三个格子：床位、掩体位、站位。
 *
 * 为什么要这么麻烦：原实现直接写死
 * `bedCell = (龙头 x+1, 龙头 y-1, 龙头 z)`、`standCell = bedCell.x+1`、并硬编码 `inTrench: true`
 * —— 等于**替世界宣布"我躲在坑里"**，让 `planBedBombing` 按暴露度 0.15 放行。
 * 真机上只要它没在坑里，那 0.15 就是假的，床一炸就是 71 点原始伤害。
 * 现在每一格都用 `bot.blockAt` 探过；**探不到就不猜**（返回 ok=false）。
 *
 * 站位固定取"床 + 2 格"：中间那格放掩体，人躲在掩体后面点床（wiki 的标准姿势：
 * 床边放一块方块挡爆风）。2 格也远小于 4.5 格的交互距离，点得着。
 */
export function planBedBombSite(input: {
    dragonHead: Vec3;
    self: Vec3;
    probe: (p: Vec3) => string | null;
}): { ok: boolean; site?: BedBombSite; reason: string } {
    const { dragonHead, self, probe } = input;
    const headY = Math.floor(dragonHead.y);

    // 1) 床位：龙头水平方向的 4 个邻格 × 两个高度，取"离龙头最近、能放下床"的那个。
    let bedCell: Vec3 | null = null;
    let bestDragonDistance = Infinity;
    for (const [dx, dz] of CARDINALS) {
        for (const y of [headY - 1, headY]) {
            const candidate = vec(Math.floor(dragonHead.x) + dx, y, Math.floor(dragonHead.z) + dz);
            const name = probe(candidate);
            if (!isAirLikeName(name)) continue; // 读不到（null）或有方块 → 这格放不了
            const d = vecDistance(candidate, dragonHead);
            if (d < bestDragonDistance) {
                bestDragonDistance = d;
                bedCell = candidate;
            }
        }
    }
    if (bedCell == null) {
        return {
            ok: false,
            reason: '龙头四周没有一个能放下床的空格（要么被方块占着，要么区块没加载读不到）——先挖/垫一格，或者换到龙头另一边再试。',
        };
    }

    // 2) 掩体 + 站位：4 个正方向里挑一个"能站住、且掩体在你和床之间"的方向。
    const away = { x: self.x - bedCell.x, z: self.z - bedCell.z };
    const awayLength = Math.hypot(away.x, away.z);
    let best: { dir: readonly [number, number]; coverAlreadySolid: boolean; score: number } | null = null;
    for (const dir of CARDINALS) {
        const coverCell = vec(bedCell.x + dir[0], bedCell.y, bedCell.z + dir[1]);
        const standCell = vec(bedCell.x + dir[0] * 2, bedCell.y, bedCell.z + dir[1] * 2);
        const coverName = probe(coverCell);
        const feet = probe(standCell);
        const support = probe(vec(standCell.x, standCell.y - 1, standCell.z));
        // 读不到（null）一律不用：宁可不动手，也不拿"猜的地形"当掩体。
        if (coverName == null || feet == null || support == null) continue;
        if (!isAirLikeName(feet)) continue; // 站的地方得是空的
        if (!isSolidName(support)) continue; // 脚下得踩得住（虚空/水都不算）
        // 方向分：越靠近"我现在站的那一侧"越好（少走路，掩体天然在中间）。已经实心的掩体更值钱。
        const alignment = awayLength === 0 ? 0 : (dir[0] * away.x + dir[1] * away.z) / awayLength;
        const coverAlreadySolid = isSolidName(coverName);
        const score = alignment + (coverAlreadySolid ? 0.5 : 0);
        if (best == null || score > best.score) best = { dir, coverAlreadySolid, score };
    }
    if (best == null) {
        return {
            ok: false,
            reason: '床边没有能站住的位置：掩体格或落脚点被占/是虚空/读不到世界——先清出"床边一格掩体 + 掩体后一格站位"再点床。',
        };
    }

    const coverCell = vec(bedCell.x + best.dir[0], bedCell.y, bedCell.z + best.dir[1]);
    const standCell = vec(bedCell.x + best.dir[0] * 2, bedCell.y, bedCell.z + best.dir[1] * 2);
    return {
        ok: true,
        site: {
            bedCell,
            coverCell,
            standCell,
            coverAlreadySolid: best.coverAlreadySolid,
            standDistance: vecDistance(bedCell, standCell),
            dragonDistance: bestDragonDistance,
        },
        reason: `床放 (${bedCell.x},${bedCell.y},${bedCell.z})，掩体放 (${coverCell.x},${coverCell.y},${coverCell.z})，人站 (${standCell.x},${standCell.y},${standCell.z}) 隔着一格点床。`,
    };
}

/**
 * 探"是不是钻进了出口传送门那个碗形基岩框里"（wiki 说的 safest pose 之一）。
 * 判据只用真实方块：站在传送门 4 格内、脚/头两层的水平邻格里至少两面基岩、脚下实心。
 * **读不到就返回 null**（不知道），绝不返回 true —— 这条判据直接决定暴露度 0.15 是否成立。
 */
export function detectPodiumTrench(bot: any, standCell: Vec3): boolean | null {
    if (horizontalDistance(standCell, END_PODIUM) > 4) return false;
    const names: Array<string | null> = [];
    for (const [dx, dz] of CARDINALS) {
        names.push(blockNameAt(bot, vec(standCell.x + dx, standCell.y, standCell.z + dz)));
        names.push(blockNameAt(bot, vec(standCell.x + dx, standCell.y + 1, standCell.z + dz)));
    }
    names.push(blockNameAt(bot, vec(standCell.x, standCell.y - 1, standCell.z)));
    if (names.some((name) => name == null)) return null;
    return names.filter((name) => name === 'bedrock').length >= 2;
}

/** 拿来当掩体/垫脚的方块：优先清单里的，其次背包里任何"不是床、不是工具"的方块。 */
export function pickCoverBlockItemName(bot: any): string | null {
    const counts = safeInventoryCounts(bot);
    for (const name of PLATFORM_BLOCKS) {
        if ((counts[name] ?? 0) > 0) return name;
    }
    for (const item of safeInventoryItems(bot)) {
        const name = normalizeName(item?.name);
        if (name === '' || name.endsWith('_bed') || name === 'bed') continue;
        if (name.endsWith('_pickaxe') || name.endsWith('_sword') || name.endsWith('_axe') || name.endsWith('_shovel')) continue;
        if (name.endsWith('_bucket') || name.includes('potion') || name.endsWith('_apple') || name.includes('arrow')) continue;
        if (counts[name] == null) continue;
        if (name.endsWith('_block') || name.endsWith('_planks') || name.endsWith('_stone') || name.endsWith('_bricks') || name.endsWith('_log')) {
            return name;
        }
    }
    return null;
}

/**
 * 龙低头时，按 `planBedBombing` 的闸门决定要不要炸，**一次一张床**。
 *
 * 为什么一次只炸一张：`sleep_in_bed` 的授权是**按工具调用次数**扣的
 * （`mineflayer_body.consumePermitFor`），"一张床 = 一次"是写进说明书的账。
 * 在一次调用里连炸四张，等于用一张票干四件危险动作——账对不上，闸门也就形同虚设。
 *
 * 流程（每一步做完都复检，任一不成立就中止）：
 * 前置（血/饿/床） → 选址（探真实方块） → 闸门算账 → 问许可 → 放床 → 验证床 →
 * 放掩体 → 验证掩体 → 站到掩体后 → **复检龙还低头/床还在/血还够** → 点床 → 立刻后撤。
 */
export async function bedBombDragon(bot: any, options: { dryRun?: boolean } = {}): Promise<string> {
    const signals = readEndSignals(bot);
    if (!signals.inEnd) return '你现在不在末地，先 enterEnd。';
    const dragon = findDragonEntity(bot);
    const headPosition = toVec(dragon?.position);
    if (headPosition == null) {
        return signals.dragonAlive
            ? '看见了末影龙但读不到它的位置，先别放床。'
            : '看不见末影龙（它可能已经死了）：先调 endFightStatus 确认，别在空地上放床。';
    }
    if (!signals.dragonPerched) return '龙没低头停在传送门上——床炸打不到它，等它停。';

    const position = signals.position;
    if (position == null) return '读不到自己的坐标，不做危险动作。';

    // —— 前置条件：床炸是"赌一次自伤"，血/饿不够就不赌 ——
    const health = typeof bot?.health === 'number' && Number.isFinite(bot.health) ? bot.health : null;
    if (health == null) return '读不到自己的血量，不做危险动作（床炸前必须先知道还剩几条命）。';
    if (health < MIN_BED_BOMB_HEALTH) {
        return `血量 ${health.toFixed(1)}/20 太低（床炸保险线 ${MIN_BED_BOMB_HEALTH}）：先喝再生/吃金苹果/吃东西回血，再点床。`;
    }
    const food = typeof bot?.food === 'number' && Number.isFinite(bot.food) ? bot.food : null;
    if (food != null && food < MIN_BED_BOMB_FOOD) {
        return `饥饿值 ${food}/20 太低（低于 ${MIN_BED_BOMB_FOOD}）：先吃东西。受伤后要靠饥饿回血，空着肚子点床等于没有第二次机会。`;
    }

    const bedItem = pickBedItemName(bot);
    if (bedItem == null) return '背包里没有床。';

    // —— 选址：全部从真实世界读，不写死坐标 ——
    const siteResult = planBedBombSite({
        dragonHead: headPosition,
        self: position,
        probe: (p) => blockNameAt(bot, p),
    });
    if (!siteResult.ok || siteResult.site == null) return `没有执行床炸：${siteResult.reason}`;
    const site = siteResult.site;

    const trench = detectPodiumTrench(bot, site.standCell);
    const coverItem = site.coverAlreadySolid ? null : pickCoverBlockItemName(bot);
    const coverAvailable = site.coverAlreadySolid || coverItem != null;
    const plan = planBedBombing({
        dragonHead: headPosition,
        bedCell: site.bedCell,
        standCell: site.standCell,
        // 掩体只有**现在就是实心**、或者**手里有方块能放下去**时才算数。
        coverCells: coverAvailable ? [site.coverCell] : [],
        inTrench: trench === true,
        health,
        dragonHealth: signals.dragonHealth,
    });

    if (!plan.ok) {
        return endgameReceipt('没有执行床炸（安全闸门拒绝，一个方块都没放）。', [
            plan.reason,
            siteResult.reason,
            ...plan.warnings.slice(0, 3),
        ]);
    }
    if (options.dryRun === true) {
        return endgameReceipt('演练（没有放任何方块）：床炸闸门通过。', [plan.reason, siteResult.reason]);
    }

    // 末地点床 = 尝试睡觉 = 爆炸。**先把闸门问清楚：没授权就一个方块都不放。**
    const verdict = permits.isAllowed('sleep_in_bed', opContextFor(bot), Date.now());
    if (!verdict.allowed) {
        return endgameReceipt('床炸没授权，中止（**没有放任何方块**）。', [
            `缺的授权项：sleep_in_bed（${verdict.op?.what ?? '上床睡觉'}）——${verdict.op?.why ?? '下界和末地的床会炸'}。`,
            '先调 allowDangerousOps(ops="sleep_in_bed", calls=1)（一张床 = 一次），再调 bedBombDragon。',
            plan.reason,
        ]);
    }

    const details: string[] = [siteResult.reason, plan.reason];
    const bedCell = site.bedCell;
    const placed = await skills.placeBlock(bot, bedItem, bedCell.x, bedCell.y, bedCell.z);
    const bedBlock = blockObjectAt(bot, bedCell);
    if (!placed || bedBlock == null || !String(bedBlock.name ?? '').includes('bed')) {
        return endgameReceipt('床没放下去，中止（没点火）。', [
            ...details,
            '床是两格方块，`placeBlock` 对它的支持还没在真机验证过：换一格更平的地方，或者用 placeHere 手动放床之后再调这个工具。',
        ]);
    }
    details.push(`床已放下（${bedItem}）。`);

    // —— 掩体：床边放一块方块（wiki 标准姿势：挡爆风的头） ——
    if (!site.coverAlreadySolid) {
        if (coverItem == null) {
            return endgameReceipt('床放好了但**没有方块可以做掩体**，没敢点（床还在原地，可以用 placeHere 补一块再点）。', details);
        }
        const coverPlaced = await skills.placeBlock(bot, coverItem, site.coverCell.x, site.coverCell.y, site.coverCell.z);
        const coverName = blockNameAt(bot, site.coverCell);
        if (!coverPlaced || !isSolidName(coverName)) {
            return endgameReceipt('掩体没放成，没敢点床（床还在原地）。', [
                ...details,
                `掩体本该放在 (${site.coverCell.x},${site.coverCell.y},${site.coverCell.z})（用 ${coverItem}），现在读到的是 ${coverName ?? '读不到'}。`,
            ]);
        }
        details.push(`掩体已放好（${coverItem} @ ${site.coverCell.x},${site.coverCell.y},${site.coverCell.z}）。`);
    } else {
        details.push('掩体格本来就是实心方块，直接用。');
    }

    // —— 站到掩体后面（不是掩体那一格） ——
    await skills.goToPosition(bot, site.standCell.x + 0.5, site.standCell.y, site.standCell.z + 0.5, 0.7);

    // —— 复检：点下去之前再确认一次状态（龙还低头、床还在、血还够） ——
    const stillPerched = readDragonPerched(bot);
    const bedStillThere = blockObjectAt(bot, bedCell);
    const healthNow = typeof bot?.health === 'number' && Number.isFinite(bot.health) ? bot.health : null;
    if (!stillPerched) {
        return endgameReceipt('龙已经抬头飞走了，没点那张床（床留在原地，等它再停下来再点）。', details);
    }
    if (bedStillThere == null || !String(bedStillThere.name ?? '').includes('bed')) {
        return endgameReceipt('床不见了（被龙撞掉/被别人拿走），没点。', details);
    }
    if (healthNow != null && healthNow < MIN_BED_BOMB_HEALTH) {
        return endgameReceipt(`血量掉到 ${healthNow.toFixed(1)}/20，没点这张床——先回血。`, details);
    }

    const healthBefore = healthNow;
    try {
        // TODO(真机): bot.sleep 与 bot.activateBlock 在末地谁更好用要实测；两个都会炸，
        // 所以用 race + 吞异常，别让预期中的爆炸把整条命令带崩。
        await Promise.race([bot.sleep(bedStillThere), skills.wait(bot, 2500)]);
    } catch {
        // 预期：末地睡不成，床炸了
    }

    // —— 撤退：退到爆炸半径（10 格）之外。原来只 moveAway(6)，仍在 10 格半径里 ——
    const retreat = plan.retreat;
    if (retreat != null) {
        await skills.goToPosition(bot, retreat.x, retreat.y, retreat.z, 1.2);
    }
    await skills.moveAway(bot, Math.max(2, plan.retreatDistance - 6));

    const healthAfter = typeof bot?.health === 'number' && Number.isFinite(bot.health) ? bot.health : null;
    const hurt = healthBefore != null && healthAfter != null ? Math.max(0, healthBefore - healthAfter) : null;
    const hurtText =
        hurt == null
            ? '自伤读不到'
            : hurt > 6
                ? `自伤 ${hurt.toFixed(1)} 点偏高——下次先把掩体补好或退得更远`
                : `自伤 ${hurt.toFixed(1)} 点`;

    const dragonAliveNow = findDragonEntity(bot) != null;
    const dragonHealthNow = readDragonHealth(bot);
    const crystalsLeft = readEndCrystals(bot).length;
    const bedsLeft = countOf(bot, (name) => /(^|_)bed$/.test(name));
    const clearedEnd = !dragonAliveNow || dragonHealthNow === 0;

    details.push(`龙血：${dragonHealthNow == null ? (dragonAliveNow ? '读不到' : '龙实体已消失') : `${dragonHealthNow.toFixed(0)}/${DRAGON_MAX_HEALTH}`}`);
    details.push(`还剩 ${bedsLeft} 张床；预计这一张打掉 ${plan.expectedDragonDamage.toFixed(0)} HP，最多要 ${plan.bedsNeeded} 张。`);
    if (crystalsLeft > 0) details.push(`**还有 ${crystalsLeft} 颗水晶活着**：龙会回血，先把水晶拆完再来炸。`);

    return endgameReceipt(
        clearedEnd
            ? `床炸完了（${hurtText}）：龙已经死了，去 (0,64,0) 的出口传送门。`
            : `床炸完了（${hurtText}）。龙没掉血说明它没停在床上方；要再来一张就再调一次（一张床 = 一次授权）。`,
        details,
    );
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
 *
 * ⚠️ 这份报告是**打架时的唯一信息来源**，所以它必须报"进度"而不是"感觉"：
 * - 龙**死没死**单独说（boss bar 消失时 `dragonHealth` 是 null，不能当"还在飞"）；
 * - 水晶剩几颗、笼中的两颗有没有工具拆；
 * - **床炸闸门现在过不过**（和 `bedBombDragon` 同一段判定，不用真放床就能先知道行不行）；
 * - 龙息：以前只在"有云"时才提示，漏了最有价值的那条——龙低头 + 我在 20 格内。
 */
export function endgameStatusReport(bot: any): string {
    const signals = readEndSignals(bot);
    const advice = nextEndgameStep({
        gearReady: signals.gear.ok,
        inEnd: signals.inEnd,
        crystalsAlive: signals.crystalsAlive,
        dragonHealth: signals.dragonHealth,
        dragonAlive: signals.dragonAlive,
    });
    const lines = [formatEndgameReport(signals.gear, advice)];
    const dragonText = !signals.inEnd
        ? '不在末地'
        : signals.dragonHealth != null
            ? `${signals.dragonHealth.toFixed(0)}/${DRAGON_MAX_HEALTH}`
            : signals.dragonAlive
                ? '血量读不到（boss bar 没出来），但实体在视野里'
                : '血量读不到、实体也不在视野里（要么打完了，要么没加载——用 boss bar/治疗光束复核）';
    lines.push(
        `【现状】维度 ${signals.dimension ?? '未知'}｜水晶 ${signals.crystals.length} 颗｜龙 ${dragonText}｜${
            signals.dragonPerched ? '正低头停在传送门上（可以床炸）' : '在飞'
        }`
    );
    if (signals.position != null) {
        const { x, y, z } = signals.position;
        lines.push(`【位置】(${Math.round(x)},${Math.round(y)},${Math.round(z)})`);
        if (signals.inEnd) {
            lines.push(`【离出口传送门】${horizontalDistance(signals.position, END_PODIUM).toFixed(1)} 格（≥20 格龙息喷不到你）`);
        }
    }
    if (signals.crystalsAlive > 0 && signals.position != null) {
        const kit = crystalToolKit(bot);
        const cageKit =
            kit.tnt > 0
                ? `笼中的两颗：TNT×${kit.tnt}（笼顶放一个点燃后撤）`
                : kit.pickaxe
                    ? '笼中的两颗：没 TNT，只能带缓降上柱子拆栏杆（危险）'
                    : '笼中的两颗：**既没 TNT 也没镐，拆不掉**——龙会一直回血';
        lines.push(`【拆水晶】${planCrystalAssault({ crystals: signals.crystals, self: signals.position }).message}${cageKit}`);
    }
    if (signals.position != null && (signals.breath.length > 0 || signals.dragonPerched)) {
        const escape = planBreathEscape({
            self: signals.position,
            clouds: signals.breath,
            dragonPerched: signals.dragonPerched,
        });
        if (escape.urgency !== 'none') lines.push(`【龙息】${escape.reason}`);
    }
    if (signals.inEnd && signals.dragonAlive && signals.dragonPerched && signals.position != null) {
        // 干跑一次床炸闸门：让模型在"放床之前"就知道现在能不能炸。
        const site = planBedBombSite({
            dragonHead: signals.dragonPosition ?? END_PODIUM,
            self: signals.position,
            probe: (p) => blockNameAt(bot, p),
        });
        const health = typeof bot?.health === 'number' && Number.isFinite(bot.health) ? bot.health : null;
        if (!site.ok || site.site == null) {
            lines.push(`【床炸闸门】现在不能炸：${site.reason}`);
        } else {
            const coverItem = site.site.coverAlreadySolid ? null : pickCoverBlockItemName(bot);
            const coverAvailable = site.site.coverAlreadySolid || coverItem != null;
            const plan = planBedBombing({
                dragonHead: signals.dragonPosition ?? END_PODIUM,
                bedCell: site.site.bedCell,
                standCell: site.site.standCell,
                coverCells: coverAvailable ? [site.site.coverCell] : [],
                inTrench: detectPodiumTrench(bot, site.site.standCell) === true,
                health: health ?? undefined,
                dragonHealth: signals.dragonHealth,
            });
            lines.push(`【床炸闸门】${plan.ok ? '现在可以炸：' : '现在不能炸：'}${plan.reason}`);
            if (plan.ok) lines.push(`  站位/掩体：${site.reason}`);
        }
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
 *
 * **箭数核对**（和 `throwHeld` 同一条规矩）：射完再数一遍背包里的箭，数量没变就说明
 * 这一箭没射出去，如实报出来——"我以为我射了"和"它真的飞了"对拆水晶是两件事。
 * 满蓄力是 20 tick = 1000ms（拉不满箭会软绵绵地掉在脚下）。
 */
export async function shootAtEntity(bot: any, entity: any, chargeMs = 1000): Promise<string> {
    const kit = crystalToolKit(bot);
    if (kit.bow == null) return '没有弓/弩，射不了——先去弄一把。';
    if (kit.arrows <= 0) return '没有箭，射不了。';
    const equipped = await skills.equip(bot, kit.bow);
    if (!equipped) return `弓/弩没拿到手上（${kit.bow}），射不了。`;
    const position = toVec(entity?.position);
    if (position == null) return '目标位置读不到，射不了。';
    const height = typeof entity?.height === 'number' ? entity.height : 1;
    const arrowsBefore = kit.arrows;
    try {
        await bot.lookAt(new Vec3Class(position.x, position.y + height / 2, position.z), true);
        await bot.activateItem();
        await skills.wait(bot, chargeMs);
        await bot.deactivateItem();
        await skills.wait(bot, 300);
    } catch (err) {
        return `射箭时出错：${err instanceof Error ? err.message : String(err)}`;
    }
    const arrowsAfter = crystalToolKit(bot).arrows;
    if (arrowsAfter >= arrowsBefore) {
        return `拉了弓但箭没射出去（箭数 ${arrowsBefore} → ${arrowsAfter} 没变）：可能手滑/被打断/没箭了。别当射中了。`;
    }
    return `朝 ${entity?.name ?? '目标'} 放了一箭（拉弓 ${chargeMs}ms，箭 ${arrowsBefore} → ${arrowsAfter}）。如果没打中，先看准星是不是被方块挡住了。`;
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
    if (!drank) {
        return `想喝 ${decision.kind}（${decision.reason}），但**没喝成**：要么背包里没有这一类药水，要么包发出去了但数量没变（别当作已经喝到）。`;
    }
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

/**
 * 躲龙息。先自保（空中扔珍珠），再按 `planBreathEscape` 挪出伤害区/20 格。
 *
 * **回执必须诚实**（原来这里会谎报）：原实现里"目标格 == 当前格"时
 * `goToPosition` 直接返回 true，循环跑满 6 次一步没动，最后照样输出"已经往 (x,z) 方向挪开"。
 * 现在按**真实位移**说话：挪了就说挪了多少格，没挪动就说没挪动并给出原因（路被堵/方向退化）。
 */
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
    let blocked = false;
    for (let step = 0; step < 6; step++) {
        const self = toVec(bot?.entity?.position) ?? start;
        latest = planBreathEscape({
            self,
            clouds: readBreathClouds(bot),
            dragonPerched: readDragonPerched(bot),
        });
        if (latest.urgency === 'none') break;
        const target = latest.escapeTarget;
        // 目标格和脚下是同一格（方向退化）→ 别把 goToPosition 的"已到达"当成功。
        if (Math.hypot(target.x - self.x, target.z - self.z) < 0.75) {
            blocked = true;
            break;
        }
        const reached = await skills.goToPosition(bot, target.x, target.y, target.z, 1.2);
        if (!reached) {
            blocked = true;
            break;
        }
    }

    const end = toVec(bot?.entity?.position) ?? start;
    const moved = Math.hypot(end.x - start.x, end.z - start.z);
    const urgencyText = first.urgency === 'sprint' ? '冲刺' : '挪开';
    if (moved < 1) {
        return `${first.reason} **但一步都没${urgencyText}动**（${blocked ? '路被堵/寻路失败' : '算出来的目标格就在脚下'}）——` +
            '手动用 moveBy/goToCoordinates 往远离龙息的方向走，别站着挨。';
    }
    return `${first.reason} 实际${urgencyText}了 ${moved.toFixed(1)} 格，到 (${Math.round(end.x)},${Math.round(end.z)})。${
        latest.urgency === 'none' ? '现在不在龙息区里了。' : `还没脱离（${latest.reason}）——再调一次这个工具。`
    }`;
}

/** 末影之眼的采样窗口：实体只活 1~2 秒，窗口给够但必须有限。 */
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
            message: '末影之眼没扔出去（手里数量没变）：别当作扔了，先确认手上有 ender_eye，再调一次。',
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
                '**不要按猜测的方向走**。再调一次 throwHeld（多备几颗眼），或者用 goToCoordinates 换个方向站远一点再扔——两次方向交叉就能定位。',
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
        return '手上是空的：先用 equip 把要扔的东西拿到手上（ender_eye 末影之眼 / ender_pearl 末影珍珠），再调这个工具。';
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
        return `没有把 ${name} 扔出去（手里数量没变）：可能服务端没采纳，或者手里这个不是投掷物。`;
    }
    if (name.includes('ender_pearl')) {
        return falling ? '下坠中往脚下扔了一颗末影珍珠，摔落伤害基本免掉。' : '末影珍珠扔出去了。';
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
            return endgameReceipt('没有框架、也没有末影之眼，先备眼。', details);
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

/**
 * 笼中水晶的安全打法：在铁栏杆顶上放 TNT，点火，立刻后撤。
 *
 * **后撤距离**：原来只 `moveAway(6)`。水晶爆炸威力 6 → 半径 `2×6=12` 格，
 * TNT 自己也有 8 格；退 6 格等于站在自己点的炸药里。现在按爆炸半径退。
 */
async function tntTheCage(bot: any, crystal: EndCrystalInfo, details: string[]): Promise<string> {
    if ((safeInventoryCounts(bot)['tnt'] ?? 0) <= 0) {
        details.push('没有 TNT：要么去合成（火药+沙子），要么上柱子拆铁栏杆（先喝缓降、带镐）。');
        return endgameReceipt('笼中水晶现在拆不掉。', details);
    }
    const verdict = permits.isAllowed('ignite', opContextFor(bot), Date.now());
    if (!verdict.allowed) {
        details.push(
            `缺的授权项：ignite（${verdict.op?.what ?? '主动点火'}）——${verdict.op?.why ?? '火会烧掉基地和自己'}。` +
                '先 allowDangerousOps(ops="ignite", calls=1)。**这次没有放任何东西**。',
        );
        return endgameReceipt('点火没授权，中止。', details);
    }
    const top = vec(crystal.position.x, crystal.position.y + 1, crystal.position.z);
    const placed = await skills.placeBlock(bot, 'tnt', top.x, top.y, top.z);
    const placedName = blockNameAt(bot, top);
    if (!placed || placedName !== 'tnt') {
        details.push(`TNT 没放到 (${Math.round(top.x)},${Math.round(top.y)},${Math.round(top.z)})：那一格现在读到的是 ${placedName ?? '读不到'}（要空格、且够得着）。`);
        return endgameReceipt('TNT 没放下去（没点火）。', details);
    }
    const tntBlock = blockObjectAt(bot, top);
    if (tntBlock == null) {
        details.push('TNT 放下了但读不到那一格，没敢点火（怕点错别的方块）。');
        return endgameReceipt('TNT 已就位但没点火。', details);
    }
    await skills.useToolOnBlock(bot, 'flint_and_steel', tntBlock);
    // 退到水晶爆炸半径（12 格）之外：TNT 引信只有 4 秒，方向就直接背离水晶。
    const safety = blastRadius(EXPLOSION_POWER.endCrystal) + 2;
    const self = toVec(bot?.entity?.position);
    if (self != null) {
        const { dx, dz, length } = horizontalDirection(crystal.position, self);
        const away = length === 0
            ? vec(self.x + safety, self.y, self.z)
            : vec(crystal.position.x + dx * safety, self.y, crystal.position.z + dz * safety);
        await skills.goToPosition(bot, away.x, away.y, away.z, 1.5);
    }
    await skills.moveAway(bot, Math.max(4, safety - 6));
    const now = toVec(bot?.entity?.position) ?? self;
    const nowDistance = now == null ? null : horizontalDistance(now, crystal.position);
    details.push(
        `点了火、并退到 ${nowDistance == null ? '?' : nowDistance.toFixed(1)} 格（水晶爆炸半径 ${blastRadius(EXPLOSION_POWER.endCrystal)} 格）：TNT 引信约 4 秒，水晶跟着炸。`,
    );
    details.push('**别回去看**：等 5 秒再调 endFightStatus，确认这颗水晶没了（只剩一颗龙就回血）。');
    return endgameReceipt('笼中水晶的 TNT 已点燃。', details);
}

/**
 * 拆水晶：按 `planCrystalAssault` 的顺序处理下一颗（每次调用拆一颗）。
 *
 * 这一条的核心是**距离是硬线**：水晶爆炸威力 6，`2×6=12` 格内至少吃 1 点、
 * 8 格内接近 20 点（见 `explosionDamage`）。所以：
 * - 后退按"安全线 +1"算，并且用 `min_distance=0.8` 走（原来传 2：算的是 12 格，
 *   实际寻路停在 2 格误差内 → 可能只退到 10 格，仍在半径里）；
 * - 退完**重新量一次真实距离**，没退够就**不放箭**，只回执告诉你该退到哪。
 */
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
        `还有 ${plan.total} 颗没拆（笼中 ${plan.cagedCount} 颗）`,
        target.note,
    ];

    // —— 退到安全线之外（+1 格余量，抵消寻路的 min_distance 误差）——
    if (target.distance < plan.safeShootDistance) {
        const push = horizontalDirection(target.crystal.position, target.standPoint);
        const stand =
            push.length === 0
                ? target.standPoint
                : vec(target.standPoint.x + push.dx, target.standPoint.y, target.standPoint.z + push.dz);
        const moved = await skills.goToPosition(bot, stand.x, stand.y, stand.z, 0.8);
        const now = toVec(bot?.entity?.position) ?? position;
        const nowDistance = horizontalDistance(now, target.crystal.position);
        details.push(
            moved
                ? `退到 ${nowDistance.toFixed(1)} 格（安全线 ${plan.safeShootDistance} 格）`
                : `后退没走成（路被堵？），现在离水晶 ${nowDistance.toFixed(1)} 格`,
        );
        if (nowDistance < plan.safeShootDistance) {
            return endgameReceipt('没退到安全距离，**没有放箭**（一个方块/一支箭都没动）。', [
                ...details,
                `现在离水晶 ${nowDistance.toFixed(1)} 格 < ${plan.safeShootDistance} 格：在这个距离把它打爆，威力 6 的爆炸会连伤害带击退一起吃到（水挡不住伤害）。`,
                `用 moveBy/goToCoordinates 退到 ${plan.safeShootDistance + 1} 格外，再调一次 clearEndCrystals。`,
            ]);
        }
    }

    if (target.method === 'tnt_cage') return tntTheCage(bot, target.crystal, details);

    const entity = findCrystalEntity(bot, target.crystal);
    if (entity == null) return endgameReceipt('那颗水晶的实体找不到了（可能刚被拆掉）。', details);

    if (target.method === 'climb_cage') {
        const hasSlowFalling = readEffects(bot).some((effect) => effect.name.includes('slow_falling'));
        details.push(
            kit.tnt <= 0 && (!kit.pickaxe || !hasSlowFalling)
                ? `笼中水晶的正规解法是 TNT 掏笼顶或上柱子拆栏杆（要镐 + 缓降）。你现在：TNT ${kit.tnt} 个、镐 ${kit.pickaxe ? '有' : '没有'}、缓降 ${hasSlowFalling ? '有' : '没有'}——` +
                  '下面这一箭是**最后的碰运气**，从地面射笼中水晶基本会被铁栏杆挡掉。'
                : '笼中水晶：有 TNT 就优先用 TNT 掏笼顶（比贴脸拆安全）。',
        );
    }

    details.push(await shootAtEntity(bot, entity));

    // —— 打完复检：还剩几颗（拿真实实体数说话，别靠感觉） ——
    const after = readEndCrystals(bot);
    const killed = after.length < crystals.length;
    details.push(
        killed
            ? `这一下有效：水晶从 ${crystals.length} 颗掉到 ${after.length} 颗。`
            : `水晶还是 ${after.length} 颗（没掉）：这一箭多半没打中/被挡住了。`,
    );
    if (after.length === 0) {
        return endgameReceipt('水晶全拆完了，可以去打龙了（龙不再回血）。', details);
    }
    return endgameReceipt(
        killed ? '拆掉一颗水晶。' : '这一箭没拆掉水晶，再来一次（或者换个角度/换打法）。',
        details,
    );
}

/**
 * 死亡点 -> 本进程**第一次看到它**的时刻。
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

/** 清掉死亡计时（测试用；真机不需要）。 */
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
        return `死亡点记录坏了（${recalled.join(',')}）：读不出坐标，只能按"重新备战"走。`;
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
