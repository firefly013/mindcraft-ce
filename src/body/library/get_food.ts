/*
 * getFood：把"找吃的"从**五步链**变成**一次调用**。
 *
 * 为什么要有它（2026-10-18 夜里的第三次饿肚子）：overnight_b 这一晚三次掉到 food 0~2
 * （其中一次血 1.68），而引擎其实**什么都知道**——huntFor 会点名可再生路线、存粮规则会拦住
 * 最后一份、生存报告会打告急行、`!fish` 也能钓。问题是**执行是五步链**：
 *   做竿（要线 → 蜘蛛/蛛网 → 工作台）→ 找水 → 抛竿 → 烤 → 吃
 * 弱模型在压力下走不完这条链，于是"知识都在回执里，人还是饿死了"。
 * 和 `mineTunnel` / `escapeWater` 同一个思路：这是**能力**，不是建议。
 *
 * 优先级（每一步都按**事实**核对，拿不到就如实说卡在哪一步）：
 *   ① 包里有吃的 + 真饿（food < 18，且不违反存粮规则）→ 吃（走 `skills.consume`，报前后食物/饱和度）
 *   ② 附近有被动动物 → 打猎（`huntFor` 语义；"这一带被打光了"就换路，不空跑）
 *   ③ 鱼（唯一可再生的）→ 没竿就**弄竿**（线：蜘蛛/蛛网；竿：**工作台**上做）→ 找水 → 钓
 *   ④ 种子 + 锄头 → 种地（**长期**方案：说清生长时间，别在危机里等）
 *   ⑤ 最后手段 → 腐肉（带"会附带饥饿效果"的警告）
 *
 * 三条硬规矩：
 *   - **背包增量是唯一证据**（和 consume / mineTunnel 一样）：没多出能吃的，就不许说拿到了；
 *   - **有界 + 可续**：每一步都有子预算，整趟有总预算；停下来时给**一条**能照抄的"接着做"调用；
 *   - **存粮规则穿过去**：拿到吃的**不等于**立刻吃掉最后两份——阈值与 `skills.consume` 同一套，
 *     两边不许打架（否则会来回振荡：getFood 刚钓到，consume 立刻拒吃）。
 */

import * as skills from './skills.js';
import * as world from './world.js';
import {
    capLines,
    capReceipt,
    exploreForSkill,
    huntForSkill,
    isPassiveFoodAnimal,
    nearestWater,
    type FlatPosition,
} from './progression.js';
import {
    FISH_FOOD_ENOUGH,
    FOOD_REGEN_THRESHOLD,
    FOOD_RESERVE_COMFORT,
    FOOD_RESERVE_LOW,
    FISH_WATER_REACH,
    FISH_WATER_SCAN_RADIUS,
    countFood,
    fishSkill,
    foodReserveAssets,
} from './survival.js';
import { cookedCounterpartOf, foodValueOf, pickBestFood } from '../safety/emergency.js';

/** 默认目标：背包里能有 N 份能吃的。 */
export const DEFAULT_GETFOOD_WANT = 3;
/** 整趟默认时间预算（5 分钟；命令侧 7 分钟，保险丝 8.5 分钟——内部必须最短）。 */
export const DEFAULT_GETFOOD_BUDGET_MS = 5 * 60 * 1000;
export const GETFOOD_MAX_MS_LIMIT = 6 * 60 * 1000;
/** 打猎子预算（够打几只，又不至于把整趟预算烧在一只硬怪上）。 */
export const GETFOOD_HUNT_MAX_MS = 90_000;
export const GETFOOD_HUNT_RADIUS = 48;
/** 钓鱼子预算。 */
export const GETFOOD_FISH_MAX_MS = 90_000;
export const GETFOOD_FISH_MAX_CASTS = 3;
/** 找线（蜘蛛/蛛网）子预算与上限。 */
export const GETFOOD_STRING_MAX_MS = 60_000;
export const GETFOOD_COBWEB_RADIUS = 48;
export const GETFOOD_MAX_COBWEBS = 3;
/** 每个子步骤至少要有这么多剩余预算才值得开始。 */
export const GETFOOD_MIN_STEP_MS = 15_000;
/** 背包里已经有这么多能吃的：**什么都不用做**（和 `!fish` 的同一条线，复用同一个常量）。 */
export const FOOD_ACCEPTABLE = FISH_FOOD_ENOUGH;

/** 能"走过去打"的陆地动物（水里/天上的不算：huntFor 要陆地接近）。按食物价值排优先级。 */
export const HUNTABLE_ANIMALS: readonly string[] = [
    'cow',
    'mooshroom',
    'hoglin',
    'pig',
    'sheep',
    'goat',
    'chicken',
    'rabbit',
    'turtle',
];

export type GetFoodStopReason = 'enough' | 'reached' | 'gained' | 'blocked' | 'budget' | 'interrupted' | 'eat_only';

export interface GetFoodStepRecord {
    id: 'eat' | 'hunt' | 'rod' | 'fish' | 'crops' | 'rotten';
    /** 一句话摘要（事实）。 */
    text: string;
    /** 这一步有没有真的改变背包。 */
    gained: number;
}

export interface GetFoodOutcome {
    want: number;
    ediblesBefore: number;
    ediblesAfter: number;
    healthBefore: number | null;
    healthAfter: number | null;
    foodBefore: number | null;
    foodAfter: number | null;
    saturationBefore: number | null;
    saturationAfter: number | null;
    eaten: Array<{ name: string; gained: number }>;
    steps: GetFoodStepRecord[];
    stopReason: GetFoodStopReason;
    nextCall: string;
    elapsedMs: number;
    water: { position: FlatPosition; distance: number } | null;
    warnings: string[];
    /** 长期方案（种地）的一句话；没有就是 ''. */
    longTerm: string;
    /**
     * **失败时**的食物分布（量出来的）：能看见什么、多远、读没读到。
     * `undefined` = 这一趟没扫（成功了就不必扫）；`null` = 扫了但读不到。
     */
    survey?: FoodSurvey | null;
    /** 当时有没有钓竿（决定"水面"那行是说"能钓鱼"还是"先弄竿"）。 */
    rodAvailable?: boolean;
    /** 这次确实去猎了、但没进账（用来区分"看得见但没弄到"和"根本没看见"）。 */
    huntedWithoutGain?: boolean;
}

// ───────────────────── 食物分布：失败时必须给"在哪" ─────────────────────
//
// 真机（overnight_a 2026-10-21 01:03~01:05）：血 8.575、食物 14 卡了 8 分钟，
// 它**确实在试**（collectBlocks → escapeWater → collectBlocks → getFood → goToCoordinates），
// 但 getFood 只说"没拿到"，模型没有可执行的下一步 ⇒ 空转。
// 所以失败回执要带上**已经能看见的分布**：动物/作物/水的坐标与距离、四个方向的开阔度，
// 以及"往哪走多少格"。**只报量到的**：扫描失败就说"读不到"，绝不等于"没有"。

/** 动物扫描半径（实体表一次拿，便宜）。 */
export const GETFOOD_ANIMAL_RADIUS = 48;
/** 方块扫描半径（要按类型逐个查，必须更小）与**上限类型数**。 */
export const GETFOOD_BLOCK_RADIUS = 24;
/** 方块候选最多探这几种（有界，回执里会写明探了哪几种）。 */
export const GETFOOD_SURVEY_BLOCK_TYPES: readonly string[] = [
    'sweet_berry_bush',
    'pumpkin',
    'melon',
    'kelp_plant',
    'wheat',
];
/** 每类最多报几个候选（回执一行，不铺墙）。 */
export const GETFOOD_SURVEY_CANDIDATE_CAP = 3;
/** "往哪个方向走"建议的距离。 */
export const GETFOOD_EXPAND_DISTANCE = 48;

export interface FoodCandidate {
    kind: 'animal' | 'crop' | 'water';
    name: string;
    position: FlatPosition;
    distance: number;
}

export interface FoodSurvey {
    /** 实体扫描读得到吗（**读不到 ≠ 没有**）。 */
    readable: boolean;
    animalRadius: number;
    blockRadius: number;
    animals: FoodCandidate[];
    crops: FoodCandidate[];
    water: FoodCandidate | null;
    /** 实际探了哪几种方块（回执要写明"查过什么"）。 */
    blockTypesProbed: string[];
    /** 四个方向的开阔度：探了几个点、几个能走（读不到 ⇒ probed=0）。 */
    open: Array<{ dir: '+x' | '-x' | '+z' | '-z'; open: number; probed: number }>;
}

export interface SurveyDeps {
    position?: (bot: any) => FlatPosition;
    /** 半径内的实体（**必须带位置**）；读不到返回 null。 */
    nearbyEntities?: (
        bot: any,
        radius: number,
    ) => Array<{ name?: unknown; position?: { x?: unknown; y?: unknown; z?: unknown } }> | null;
    findBlock?: (bot: any, name: string, radius: number) => FlatPosition | null;
    water?: (bot: any, from: FlatPosition, radius: number) => { position: FlatPosition; distance: number } | null;
    /** 探一格能不能走：true/false，读不到 null。 */
    probeOpen?: (bot: any, pos: FlatPosition) => boolean | null;
}

function flatOf(position: { x?: unknown; y?: unknown; z?: unknown } | null | undefined): FlatPosition | null {
    if (position == null) return null;
    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
}

function distanceBetween(a: FlatPosition, b: FlatPosition): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** 量一份"食物在哪"的分布。**任何一步读不到都不抛**（读不到就记 null/readable=false）。 */
export function surveyFood(bot: any, deps: SurveyDeps = {}): FoodSurvey {
    const position = deps.position ?? ((b: any) => {
        const p = b?.entity?.position ?? {};
        return { x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0) };
    });
    const nearbyEntities =
        deps.nearbyEntities ??
        ((b: any, radius: number) => {
            try {
                return world.getNearbyEntities(b, radius) as Array<{ name?: unknown; position?: any }>;
            } catch {
                return null;
            }
        });
    const findBlock = deps.findBlock ?? ((_b: any, _name: string, _r: number) => null);
    const waterLookup = deps.water ?? ((_b: any, _from: FlatPosition, _r: number) => null);
    const probeOpen = deps.probeOpen ?? ((b: any, pos: FlatPosition) => {
        try {
            const block = b?.blockAt?.(pos);
            if (block == null) return null;
            const name = String(block.name ?? '');
            if (name === '') return null;
            return name === 'air' || name === 'cave_air' || name.includes('water');
        } catch {
            return null;
        }
    });

    const here = position(bot);
    const survey: FoodSurvey = {
        readable: false,
        animalRadius: GETFOOD_ANIMAL_RADIUS,
        blockRadius: GETFOOD_BLOCK_RADIUS,
        animals: [],
        crops: [],
        water: null,
        blockTypesProbed: [],
        open: [],
    };

    // ① 实体（一次扫描，最便宜）：只收"能吃的动物"
    let entities: ReturnType<NonNullable<SurveyDeps['nearbyEntities']>> = null;
    try {
        entities = nearbyEntities(bot, GETFOOD_ANIMAL_RADIUS);
    } catch {
        entities = null;
    }
    if (entities != null) {
        survey.readable = true;
        for (const entity of entities) {
            const name = typeof entity?.name === 'string' ? entity.name.trim().toLowerCase() : '';
            if (name === '' || !isPassiveFoodAnimal(name)) continue;
            const at = flatOf(entity.position);
            if (at == null) continue;
            survey.animals.push({ kind: 'animal', name, position: at, distance: Math.round(distanceBetween(here, at) * 10) / 10 });
        }
        survey.animals.sort((a, b) => a.distance - b.distance);
        survey.animals = survey.animals.slice(0, GETFOOD_SURVEY_CANDIDATE_CAP);
    }

    // ② 方块（有界：固定几种 + 小半径）
    for (const name of GETFOOD_SURVEY_BLOCK_TYPES) {
        survey.blockTypesProbed.push(name);
        let at: FlatPosition | null = null;
        try {
            at = flatOf(findBlock(bot, name, GETFOOD_BLOCK_RADIUS) as unknown as { x?: unknown; y?: unknown; z?: unknown } | null);
        } catch {
            at = null;
        }
        if (at == null) continue;
        survey.crops.push({ kind: 'crop', name, position: at, distance: Math.round(distanceBetween(here, at) * 10) / 10 });
    }
    survey.crops.sort((a, b) => a.distance - b.distance);
    survey.crops = survey.crops.slice(0, GETFOOD_SURVEY_CANDIDATE_CAP);

    // ③ 水面（钓鱼路线；复用现有 nearestWater）
    try {
        const w = waterLookup(bot, here, GETFOOD_ANIMAL_RADIUS);
        const at = flatOf(w?.position as unknown as { x?: unknown; y?: unknown; z?: unknown } | null);
        if (w != null && at != null) {
            survey.water = {
                kind: 'water',
                name: 'water',
                position: at,
                distance: Number.isFinite(w.distance) ? w.distance : Math.round(distanceBetween(here, at) * 10) / 10,
            };
        }
    } catch {
        survey.water = null;
    }

    // ④ 四个方向的开阔度（"往哪走"必须有测量依据，不能凭空指方向）
    const dirs: Array<{ dir: '+x' | '-x' | '+z' | '-z'; dx: number; dz: number }> = [
        { dir: '+x', dx: 1, dz: 0 },
        { dir: '-x', dx: -1, dz: 0 },
        { dir: '+z', dx: 0, dz: 1 },
        { dir: '-z', dx: 0, dz: -1 },
    ];
    for (const d of dirs) {
        let open = 0;
        let probed = 0;
        for (const step of [4, 8, 12, 16]) {
            const sample = { x: Math.round(here.x + d.dx * step), y: Math.round(here.y), z: Math.round(here.z + d.dz * step) };
            let passable: boolean | null = null;
            try {
                passable = probeOpen(bot, sample);
            } catch {
                passable = null;
            }
            if (passable == null) continue;
            probed += 1;
            if (passable) open += 1;
        }
        survey.open.push({ dir: d.dir, open, probed });
    }
    return survey;
}

/**
 * 把分布渲染成**一行一类**的回执片段（纯函数）。
 *
 * 规矩：只报量到的；扫不到就说"读不到"，**绝不说"这一带没有"**；
 * 什么候选都没有时才说"确实没有"，并且**必须给方向和距离**（否则就是"接着找"式空转）。
 */
export function foodDistributionLines(
    survey: FoodSurvey | null,
    options: { hasRod?: boolean; huntedWithoutGain?: boolean } = {},
): string[] {
    const lines: string[] = [];
    if (survey == null) {
        return ['食物分布：**没扫到**（这一趟没做成扫描）——这不代表这一带没有食物。'];
    }
    const fmt = (c: FoodCandidate): string => `(${Math.round(c.position.x)}, ${Math.round(c.position.y)}, ${Math.round(c.position.z)})，约 ${c.distance} 格`;
    const animals = survey.animals;
    const crops = survey.crops;
    const water = survey.water;

    if (!survey.readable) {
        lines.push(
            `食物分布：**实体读不到**（扫描失败）——这只说明**没读到**，不代表没有动物；` +
                `用 \`stats(type="entities")\` 再看一次，或换个位置再 getFood。`,
        );
    } else if (animals.length > 0) {
        lines.push(
            `最近的动物：${animals.map((a) => `${a.name} 在 ${fmt(a)}`).join('；')}` +
                `${options.huntedWithoutGain === true ? '——**这次看得见但没猎到**（别当成没有）' : ''}`,
        );
    }
    if (crops.length > 0) {
        lines.push(`可采的食物方块：${crops.map((c) => `${c.name} 在 ${fmt(c)}`).join('；')}（扫了 ${survey.blockRadius} 格）`);
    }
    if (water != null) {
        lines.push(
            `最近的水面：${fmt(water)}` +
                (options.hasRod === true ? '（有钓竿 ⇒ 可以 fish）' : '（**可以钓鱼，但你现在没有钓竿**：先弄竿——蛛网→线，或 3 木棍 + 2 线）'),
        );
    }
    const nothing = survey.readable && animals.length === 0 && crops.length === 0 && water == null;
    if (nothing) {
        // **说清"确实没有"再给方向**：光说"没找到"就是空转的源头。
        const probed = survey.open.filter((o) => o.probed > 0);
        const ranked = [...probed].sort((a, b) => b.open - a.open);
        if (ranked.length > 0) {
            const best = ranked[0]!;
            const others = ranked.slice(1).map((o) => `${o.dir} ${o.open}/${o.probed}`).join('、');
            lines.push(
                `**这一带确实没有食物来源**（动物 ${survey.animalRadius} 格、方块 ${survey.blockRadius} 格内都没有）——` +
                    `**往 ${best.dir} 方向走约 ${GETFOOD_EXPAND_DISTANCE} 格再 getFood**（那个方向探了 ${best.probed} 个点、${best.open} 个能走` +
                    `${others === '' ? '' : `；其余方向 ${others}`}）。`,
            );
        } else {
            lines.push(
                `**这一带确实没有食物来源**（动物 ${survey.animalRadius} 格、方块 ${survey.blockRadius} 格内都没有）——` +
                    `四个方向都探不到方块（读不到），**沿当前朝向往前走约 ${GETFOOD_EXPAND_DISTANCE} 格**再 getFood。`,
            );
        }
    }
    return lines;
}

/** 失败时的"一条可执行下一步"（候选优先；什么都没有就用方向 + 距离换地方）。 */
export function foodNextCallFromSurvey(survey: FoodSurvey | null, here: FlatPosition | null): string | null {
    if (survey == null) return null;
    const nearest = [...survey.animals, ...survey.crops].sort((a, b) => a.distance - b.distance)[0];
    if (nearest != null) {
        if (nearest.kind === 'animal') return `huntFor(entity="${nearest.name}", want=1, max_ms=120000)`;
        return `collectBlocks(type="${nearest.name}", num=3)`;
    }
    if (survey.water != null) {
        return `travelTo(x=${Math.round(survey.water.position.x)}, y=${Math.round(survey.water.position.y)}, z=${Math.round(survey.water.position.z)})`;
    }
    if (here == null) return null;
    const probed = survey.open.filter((o) => o.probed > 0);
    if (probed.length === 0) return null;
    const best = [...probed].sort((a, b) => b.open - a.open)[0]!;
    const dx = best.dir === '+x' ? GETFOOD_EXPAND_DISTANCE : best.dir === '-x' ? -GETFOOD_EXPAND_DISTANCE : 0;
    const dz = best.dir === '+z' ? GETFOOD_EXPAND_DISTANCE : best.dir === '-z' ? -GETFOOD_EXPAND_DISTANCE : 0;
    return `goToCoordinates(x=${Math.round(here.x + dx)}, y=${Math.round(here.y)}, z=${Math.round(here.z + dz)}, closeness=3)`;
}

const STOP_TEXT: Record<GetFoodStopReason, string> = {
    enough: `背包里的吃的够用（≥${FOOD_ACCEPTABLE} 份），不用动`,
    reached: '到目标份数了',
    gained: '拿到了（还没到目标份数）',
    blocked: '每一条路都卡住了',
    budget: '时间预算用完',
    interrupted: '被 Stop 打断',
    eat_only: '只是吃了点，没去补',
};

/** 子步骤的一句话摘要 / 下一步 提取（纯函数，可从子回执里取回"接着做"的那条调用）。 */
export function firstLine(text: string): string {
    const line = String(text ?? '').split('\n').find((l) => l.trim() !== '');
    return (line ?? '').trim();
}

/** 从子回执里取最后一条 `下一步（照做即可）：…`（没有就 null）。 */
export function lastNextCall(text: string): string | null {
    const lines = String(text ?? '').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim() ?? '';
        const marker = '下一步（照做即可）：';
        if (line.startsWith(marker)) {
            const call = line.slice(marker.length).trim();
            if (call !== '') return call;
        }
    }
    return null;
}

/** 能吃的份数 + 逐项（从背包计数表算）。 */
export function edibleItemsFrom(inventory: Record<string, number>): Array<{ name: string; count: number }> {
    return Object.entries(inventory ?? {})
        .filter(([name, count]) => foodValueOf(name) != null && Number.isFinite(count) && count > 0)
        .map(([name, count]) => ({ name, count }));
}

/** 做竿/做锄这类"要工作台"的配方，回执里必须点名工作台（2×2 放不下）。 */
export function craftingTableCall(input: string, output: string): string {
    return `useBlock(type="crafting_table", input="${input}", output="${output}")`;
}

/** 生食 → 先烤（拿到生肉/生鱼时的下一步）。 */
export function cookCallFor(name: string, count: number): string | null {
    const cooked = cookedCounterpartOf(name);
    if (cooked == null) return null;
    return `useBlock(type="furnace", input="${count} ${name}", output="${count} ${cooked}")`;
}

export interface GetFoodStepResult {
    /** 这一步净拿到几份能吃的（由调用方复核背包增量得出）。 */
    gained: number;
    /** 一句话摘要。 */
    label: string;
    /** 子步骤自己给的"接着做"（可为 null）。 */
    nextCall?: string | null;
}

export interface GetFoodDeps {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    position?: (bot: any) => FlatPosition;
    health?: (bot: any) => number | null;
    foodState?: (bot: any) => { food: number | null; saturation: number | null };
    inventory?: (bot: any) => Record<string, number>;
    countOf?: (bot: any, item: string) => number;
    /** 半径内最近的、名字在这些里面的实体（返回实体名）。 */
    nearestEntity?: (bot: any, names: readonly string[], radius: number) => string | null;
    eat?: (bot: any, item: string) => Promise<boolean>;
    hunt?: (bot: any, entity: string, want: number, radius: number, maxMs: number) => Promise<GetFoodStepResult>;
    fish?: (bot: any, maxMs: number, casts: number) => Promise<GetFoodStepResult>;
    findBlock?: (bot: any, block: string, radius: number) => FlatPosition | null;
    /** 一次拿到**多个**蛛网（用来挑"最省事"的那个：先看竖直距离，少爬少挖）。 */
    findCobwebs?: (bot: any, radius: number) => FlatPosition[];
    travel?: (bot: any, x: number, y: number, z: number, closeness: number) => Promise<boolean>;
    mine?: (bot: any, x: number, y: number, z: number) => Promise<boolean>;
    craftRod?: (bot: any) => Promise<boolean>;
    water?: (bot: any, from: FlatPosition, radius: number) => { position: FlatPosition; distance: number } | null;
    explore?: (bot: any, block: string, maxSteps: number, step: number) => Promise<GetFoodStepResult>;
}

function inventorySafe(bot: any): Record<string, number> {
    try {
        return (world.getInventoryCounts(bot) ?? {}) as Record<string, number>;
    } catch {
        return {};
    }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 已知的蛛网点（**实测**，不是推算）：overnight_a 在 2026-10-19 找到第 5 个蛛网
 * (71, 28, -76)，**y=28** —— 比从存档推出来的那四个浅得多（那四个要往下挖 ~80 格，
 * 深度才是这条链上真正贵的东西）。扫描半径内没有蛛网时，直接给这个点，别再让它
 * 靠 `exploreFor` 瞎撞。
 */
export const KNOWN_COBWEB_SITES: ReadonlyArray<FlatPosition> = Object.freeze([{ x: 71, y: 28, z: -76 }]);

/**
 * 已知蛛网**成片**的范围（Lead 从存档里核过）：(71,28,-76) 加上 ±40 格内十来个，
 * **全部在 y=24~30**。也就是说这是个"浅差事"——**从侧面走进去**就行，
 * 不要顺着水层往下挖竖井（真机：连续水层把 digDown 挡住，goToCoordinates 在水边干等 90 秒）。
 */
export const KNOWN_COBWEB_CLUSTER_RADIUS = 40;
export const KNOWN_COBWEB_CLUSTER_Y: readonly [number, number] = Object.freeze([24, 30]);

/** 已知蛛网点里最"省事"的一个：**先看竖直距离**（少爬少挖），再看水平距离。 */
export function bestKnownCobwebSite(
    here: FlatPosition | null,
    sites: ReadonlyArray<FlatPosition> = KNOWN_COBWEB_SITES,
): FlatPosition | null {
    if (sites.length === 0) return null;
    if (here == null) return sites[0] ?? null;
    const cost = (site: FlatPosition): number => Math.abs(site.y - here.y) * 4 + Math.hypot(site.x - here.x, site.z - here.z);
    return [...sites].sort((a, b) => cost(a) - cost(b))[0] ?? null;
}

/**
 * 一条能照抄的"接着做"：把这条链**从当前断点继续**。
 *
 * 关键点：杆子这条路**永远点名工作台**（3×3 配方，2×2 的 `craft` 放不下——我们自己踩过）。
 */
export function rodNextCall(options: {
    hasRod: boolean;
    string: number;
    sticks: number;
    cobweb: FlatPosition | null;
    spawner: string | null;
    water: { position: FlatPosition; distance: number } | null;
    /** 现在在哪（用来挑"最省事"的已知蛛网点）；读不到就 null。 */
    here?: FlatPosition | null;
    /** 当前维度：已知蛛网点在主世界，别的维度不能照抄。 */
    dimension?: string | null;
}): string {
    if (options.hasRod) {
        if (options.water == null) return 'searchForBlock(type="water", search_range=256)';
        return `goToCoordinates(x=${Math.round(options.water.position.x)}, y=${Math.round(options.water.position.y)}, z=${Math.round(options.water.position.z)}, closeness=3)`;
    }
    if (options.string < 2) {
        if (options.spawner != null) {
            return `huntFor(entity="${options.spawner}", want=2, max_ms=60000)`;
        }
        if (options.cobweb != null) {
            return `goToCoordinates(x=${Math.round(options.cobweb.x)}, y=${Math.round(options.cobweb.y)}, z=${Math.round(options.cobweb.z)}, closeness=2)`;
        }
        // 已知蛛网点是**主世界**的坐标：只有调用方明确说"在主世界"才照抄
        // （维度未知时不猜——猜错等于把人指到另一个维度去）。
        const dimension = (options.dimension ?? '').toLowerCase();
        if (dimension.includes('overworld')) {
            const site = bestKnownCobwebSite(options.here ?? null);
            if (site != null) {
                // **用 travelTo，不用 goToCoordinates**：水层挡路时 travelTo 会自己规划斜台阶/横向
                // 隧道绕过去（goToCoordinates 只会在水边干等，真机卡了 90 秒）。
                return `travelTo(x=${Math.round(site.x)}, y=${Math.round(site.y)}, z=${Math.round(site.z)})`;
            }
        }
        return 'exploreFor(block="cobweb", max_steps=8, step=32)';
    }
    if (options.sticks < 3) return 'craft(input="2 oak_planks", output="4 stick")';
    // **工作台**：3 木棍 + 2 线是 3×3 配方，背包里的 2×2 craft 做不出来。
    return craftingTableCall('3 stick, 2 string', '1 fishing_rod');
}

/** 渲染回执（纯函数）。 */
export function getFoodReceipt(o: GetFoodOutcome): string {
    const lines: string[] = [];
    const delta = o.ediblesAfter - o.ediblesBefore;
    const num = (value: number | null): string => (value == null ? '读不到' : String(value));
    const head =
        o.stopReason === 'enough'
            ? `getFood：**不用动**——背包里已经有 ${o.ediblesBefore} 份能吃的（≥${FOOD_ACCEPTABLE}），先去干正事。`
            : delta > 0
              ? `getFood：这一步**拿到了 ${delta} 份能吃的**（${o.ediblesBefore} → ${o.ediblesAfter}）。`
              : o.eaten.length > 0
                ? `getFood：**只吃了东西，没补到新的**（能吃的 ${o.ediblesBefore} → ${o.ediblesAfter}，少的那份就是吃掉的）。`
                : `getFood：**没拿到吃的**（能吃的 ${o.ediblesBefore} → ${o.ediblesAfter}）——停止原因：${STOP_TEXT[o.stopReason]}。`;
    lines.push(head);
    lines.push(
        `起手/结束：血 ${num(o.healthBefore)} → ${num(o.healthAfter)}、食物 ${num(o.foodBefore)} → ${num(o.foodAfter)}` +
            `（饱和度 ${num(o.saturationBefore)} → ${num(o.saturationAfter)}）；能吃的 ${o.ediblesBefore} → ${o.ediblesAfter} 份；` +
            `用了 ${Math.round(o.elapsedMs / 1000)} 秒。`,
    );
    for (const step of o.steps) lines.push(`- ${step.text}`);
    // **失败时必须告诉模型"吃的在哪"**（真机 overnight_a：血 8.575 / 食物 14 卡了 8 分钟，
    // 它确实在试 getFood，但回执只说"没拿到"，于是它 collectBlocks↔getFood↔goToCoordinates 空转）。
    // 这一块是**量出来的分布**：能看见什么、多远、读没读到；一条候选一行。
    if (o.survey !== undefined) {
        for (const line of foodDistributionLines(o.survey, { hasRod: o.rodAvailable === true, huntedWithoutGain: o.huntedWithoutGain === true })) {
            lines.push(line);
        }
    }
    if (o.eaten.length > 0) {
        lines.push(`吃了：${o.eaten.map((e) => e.name).join('、')}（走 consume 的规矩：数量与饱食度都核对过，前后值见上）。`);
    }
    if (o.longTerm !== '') lines.push(o.longTerm);
    for (const warning of capLines(o.warnings, 8, '警告')) lines.push(warning);
    lines.push(`下一步（照做即可）：${o.nextCall}`);
    return capReceipt(lines.join('\n'));
}

/**
 * 一次调用把"找吃的"做完（能做多少做多少，并给出一条"接着做"的调用）。
 */
export async function getFoodSkill(
    bot: any,
    rawWant?: unknown,
    rawMaxMs?: unknown,
    deps: GetFoodDeps = {},
): Promise<string> {
    const want = clampInt(rawWant, DEFAULT_GETFOOD_WANT, 1, 32);
    const budgetMs = clampInt(rawMaxMs, DEFAULT_GETFOOD_BUDGET_MS, 10_000, GETFOOD_MAX_MS_LIMIT);

    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const position = deps.position ?? ((b: any) => {
        const p = b?.entity?.position ?? {};
        return { x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0) };
    });
    const health = deps.health ?? ((b: any) => (Number.isFinite(Number(b?.health)) ? Number(b.health) : null));
    const foodState = deps.foodState ?? ((b: any) => ({
        food: Number.isFinite(Number(b?.food)) ? Number(b.food) : null,
        saturation: Number.isFinite(Number(b?.foodSaturation)) ? Number(b.foodSaturation) : null,
    }));
    const inventory = deps.inventory ?? inventorySafe;
    const countOf = deps.countOf ?? ((b: any, item: string) => skills.inventoryCountOf(b, item) ?? 0);
    const nearestEntity =
        deps.nearestEntity ??
        ((b: any, names: readonly string[], radius: number) => {
            try {
                const found = world.getNearbyEntities(b, radius) as any[];
                for (const entity of found) {
                    const name = typeof entity?.name === 'string' ? entity.name.trim().toLowerCase() : '';
                    if (names.includes(name)) return name;
                }
                return null;
            } catch {
                return null;
            }
        });
    const eat = deps.eat ?? ((b: any, item: string) => skills.consume(b, item));
    const hunt =
        deps.hunt ??
        (async (b: any, entity: string, huntWant: number, radius: number, maxMs: number) => {
            const before = countFood(inventory(b));
            const receipt = await huntForSkill(b, entity, huntWant, radius, maxMs, {});
            const gained = countFood(inventory(b)) - before;
            return { gained, label: firstLine(receipt), nextCall: lastNextCall(receipt) };
        });
    const fish =
        deps.fish ??
        (async (b: any, maxMs: number, casts: number) => {
            const before = countFood(inventory(b));
            const receipt = await fishSkill(b, maxMs, casts, {}, {});
            const gained = countFood(inventory(b)) - before;
            return { gained, label: firstLine(receipt), nextCall: lastNextCall(receipt) };
        });
    const findBlock =
        deps.findBlock ??
        ((b: any, block: string, radius: number) => {
            try {
                const found = world.getNearestBlocksWhere(b, (x: any) => String(x?.name ?? '').trim().toLowerCase() === block, radius, 1);
                const p = found[0]?.position;
                return p == null ? null : { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
            } catch {
                return null;
            }
        });
    /**
     * 找蛛网：**先看竖直距离**（少爬少挖），再看水平距离。
     *
     * 真机经验（overnight_a）：第 5 个蛛网在 y=28，而按存档推出来的四个要往下挖 ~80 格——
     * **深度才是这条链上贵的东西**。原来的 `getNearestBlocksWhere(..., 1)` 只给"最近"的，
     * 于是可能挑中头顶 40 格那个（要搭/爬）而错过脚下 20 格那个（走过去就行）。
     */
    const findShallowCobweb = (b: any): FlatPosition | null => {
        const candidates: FlatPosition[] = (() => {
            if (deps.findCobwebs != null) {
                try {
                    return deps.findCobwebs(b, GETFOOD_COBWEB_RADIUS) ?? [];
                } catch {
                    return [];
                }
            }
            if (deps.findBlock != null) {
                const one = findBlock(b, 'cobweb', GETFOOD_COBWEB_RADIUS);
                return one == null ? [] : [one];
            }
            try {
                return (world.getNearestBlocksWhere(b, (x: any) => String(x?.name ?? '').trim().toLowerCase() === 'cobweb', GETFOOD_COBWEB_RADIUS, 8) ?? [])
                    .map((block: any) => block?.position)
                    .filter((p: any) => p != null)
                    .map((p: any) => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }));
            } catch {
                return [];
            }
        })();
        if (candidates.length === 0) return null;
        let here: FlatPosition | null = null;
        try {
            const pos = b?.entity?.position;
            if (pos != null) here = { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) };
        } catch {
            here = null;
        }
        const cost = (site: FlatPosition): number =>
            here == null ? Math.hypot(site.x, site.z) : Math.abs(site.y - here.y) * 4 + Math.hypot(site.x - here.x, site.z - here.z);
        return [...candidates].sort((a, b2) => cost(a) - cost(b2))[0] ?? null;
    };
    const travel =
        deps.travel ?? ((b: any, x: number, y: number, z: number, closeness: number) => skills.goToPosition(b, x, y, z, closeness));
    const mine = deps.mine ?? ((b: any, x: number, y: number, z: number) => skills.breakBlockAt(b, x, y, z));
    const craftRod =
        deps.craftRod ??
        (async (b: any) => {
            // `craftRecipe` 自己会找/放下工作台（3×3 配方），做完我们再用背包核对。
            const ok = await skills.craftRecipe(b, 'fishing_rod', 1);
            return ok && (skills.inventoryCountOf(b, 'fishing_rod') ?? 0) > 0;
        });
    const water = deps.water ?? ((b: any, from: FlatPosition, radius: number) => nearestWater(b, from, radius));
    const explore =
        deps.explore ??
        (async (b: any, block: string, maxSteps: number, step: number) => {
            const receipt = await exploreForSkill(b, block, maxSteps, step, {});
            return { gained: 0, label: firstLine(receipt), nextCall: lastNextCall(receipt) };
        });

    const startedAt = now();
    const ediblesBefore = countFood(inventory(bot));
    const before = foodState(bot);
    const healthBefore = health(bot);
    const steps: GetFoodStepRecord[] = [];
    const warnings: string[] = [];
    const eaten: Array<{ name: string; gained: number }> = [];
    const here = position(bot);
    let nextCall: string | null = null;
    let longTerm = '';
    let stopReason: GetFoodStopReason = 'blocked';
    let waterInfo: { position: FlatPosition; distance: number } | null = null;

    const left = (): number => budgetMs - (now() - startedAt);
    const ediblesNow = (): number => countFood(inventory(bot));
    const record = (id: GetFoodStepRecord['id'], text: string, gained: number): void => {
        steps.push({ id, text, gained });
    };

    // ── 已经不缺吃的：什么都不做（"want 是下限，不是目标"） ──
    if (ediblesBefore >= FOOD_ACCEPTABLE) {
        stopReason = 'enough';
        nextCall = 'stats(type="inventory")';
    } else {
        // ── ① 吃：真饿（food < 回血线）且**不违反存粮规则**才吃 ──
        const foodNow = before.food;
        const reserveBlocked = ediblesBefore > 0 && ediblesBefore <= FOOD_RESERVE_LOW && foodNow != null && foodNow >= FOOD_RESERVE_COMFORT;
        if (ediblesBefore === 0) {
            record('eat', '吃：跳过（背包里没有能吃的）。', 0);
        } else if (foodNow == null) {
            record('eat', '吃：跳过（食物值读不到，不瞎吃）。', 0);
        } else if (foodNow >= FOOD_REGEN_THRESHOLD) {
            record('eat', `吃：跳过（食物 ${foodNow} ≥ 回血线 ${FOOD_REGEN_THRESHOLD}，先补库存）。`, 0);
        } else if (reserveBlocked) {
            record(
                'eat',
                `吃：**先留着**——食物 ${foodNow}（≥${FOOD_RESERVE_COMFORT} 不算饿）而背包只剩 ${ediblesBefore} 份，` +
                    `存粮规则要求留给低血期（和 consume 同一套阈值）。`,
                0,
            );
        } else {
            const names = edibleItemsFrom(inventory(bot)).map((item) => item.name);
            const best = pickBestFood(names);
            if (best == null) {
                record('eat', '吃：跳过（挑不出可吃的东西）。', 0);
            } else {
                const gainedBefore = ediblesNow();
                const ok = await eat(bot, best);
                const gained = gainedBefore - ediblesNow(); // 吃掉了 → 库存份数会减少（不算"拿到"）
                record('eat', `吃：${ok ? `吃了 ${best}` : `想吃 ${best} 但没吃成（回执里有原因）`}。`, 0);
                if (ok) eaten.push({ name: best, gained });
            }
        }

        // ── ② 打猎：附近有陆地动物就去打（打光了就换路） ──
        if (ediblesNow() < want && left() >= GETFOOD_MIN_STEP_MS) {
            const animal = nearestEntity(bot, HUNTABLE_ANIMALS, GETFOOD_HUNT_RADIUS);
            if (animal == null) {
                record('hunt', `打猎：${GETFOOD_HUNT_RADIUS} 格内没有被动动物（这一带被打光了），换钓鱼。`, 0);
            } else {
                const need = Math.max(1, want - ediblesNow());
                const gainedBefore = ediblesNow();
                const result = await hunt(bot, animal, need, GETFOOD_HUNT_RADIUS, Math.min(GETFOOD_HUNT_MAX_MS, Math.max(5_000, left() - 5_000)));
                const gained = ediblesNow() - gainedBefore;
                record('hunt', `打猎：${animal} → ${result.label}（能吃的 ${gained >= 0 ? '+' : ''}${gained}）`, gained);
                if (result.nextCall != null) nextCall = result.nextCall;
            }
        } else if (ediblesNow() < want) {
            record('hunt', `打猎：跳过（剩余预算不足 ${GETFOOD_MIN_STEP_MS / 1000} 秒）。`, 0);
        }

        // ── ③ 钓鱼：唯一可再生的那条路（没竿就弄竿） ──
        if (ediblesNow() < want && left() >= GETFOOD_MIN_STEP_MS) {
            waterInfo = water(bot, position(bot), FISH_WATER_SCAN_RADIUS);
            let hasRod = countOf(bot, 'fishing_rod') > 0;
            if (!hasRod) {
                let string = countOf(bot, 'string');
                const sticks = countOf(bot, 'stick');
                if (string < 2) {
                    // (a) 附近有蜘蛛 → 打蜘蛛（掉线）
                    const spider = nearestEntity(bot, ['spider', 'cave_spider'], GETFOOD_HUNT_RADIUS);
                    if (spider != null && left() >= GETFOOD_MIN_STEP_MS) {
                        const beforeString = string;
                        const result = await hunt(bot, spider, 2, GETFOOD_HUNT_RADIUS, Math.min(GETFOOD_STRING_MAX_MS, Math.max(5_000, left() - 5_000)));
                        string = countOf(bot, 'string');
                        record('rod', `找线：打了 ${spider} → string ${beforeString} → ${string}（${result.label}）`, 0);
                    }
                    // (b) 蛛网 → 自己走过去挖（挖到才算）
                    if (string < 2 && left() >= GETFOOD_MIN_STEP_MS) {
                        let websMined = 0;
                        for (let i = 0; i < GETFOOD_MAX_COBWEBS && string < 2 && left() >= 5_000; i++) {
                            const web = findShallowCobweb(bot);
                            if (web == null) break;
                            const arrived = await travel(bot, web.x, web.y, web.z, 2);
                            if (!arrived) break;
                            const broke = await mine(bot, web.x, web.y, web.z);
                            if (!broke) break;
                            websMined += 1;
                            string = countOf(bot, 'string');
                        }
                        const web = findShallowCobweb(bot);
                        record(
                            'rod',
                            websMined === 0
                                ? `找线：${GETFOOD_COBWEB_RADIUS} 格内${web == null ? '没有蛛网' : '有蛛网但没挖到'}（string 还差 ${Math.max(0, 2 - string)}）。`
                                : `找线：挖了 ${websMined} 个蛛网 → string ${string}。`,
                            0,
                        );
                    }
                } else {
                    record('rod', `找线：背包里已有 stringx${string}，跳过。`, 0);
                }

                if (string >= 2 && sticks >= 3) {
                    const crafted = await craftRod(bot);
                    hasRod = countOf(bot, 'fishing_rod') > 0;
                    record('rod', `做竿：${crafted || hasRod ? '成了（fishing_rod +1）' : '**没成**（缺材料或附近没有工作台）'}。`, 0);
                }
                if (!hasRod) {
                    const web = findShallowCobweb(bot);
                    const spawner = nearestEntity(bot, ['spider', 'cave_spider'], GETFOOD_HUNT_RADIUS);
                    const here = (() => {
                        try {
                            const pos = bot?.entity?.position;
                            return pos == null ? null : { x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) };
                        } catch {
                            return null;
                        }
                    })();
                    const dimension = (() => {
                        try {
                            return typeof bot?.game?.dimension === 'string' ? bot.game.dimension : null;
                        } catch {
                            return null;
                        }
                    })();
                    nextCall = rodNextCall({
                        hasRod: false,
                        string: countOf(bot, 'string'),
                        sticks: countOf(bot, 'stick'),
                        cobweb: web,
                        spawner,
                        water: waterInfo,
                        here,
                        dimension,
                    });
                    record(
                        'rod',
                        `竿子这条路卡住了：string ${countOf(bot, 'string')}/2、stick ${countOf(bot, 'stick')}/3` +
                            (waterInfo == null ? '；半径内也没有水' : `；水在 (${Math.round(waterInfo.position.x)}, ${Math.round(waterInfo.position.y)}, ${Math.round(waterInfo.position.z)})`),
                        0,
                    );
                }
            }
            if (hasRod && left() >= GETFOOD_MIN_STEP_MS) {
                if (waterInfo == null || waterInfo.distance > FISH_WATER_REACH) {
                    record(
                        'fish',
                        waterInfo == null
                            ? `钓鱼：半径 ${FISH_WATER_SCAN_RADIUS} 格内没扫到水面（只扫已加载区块），钓不了。`
                            : `钓鱼：最近的水在 (${Math.round(waterInfo.position.x)}, ${Math.round(waterInfo.position.y)}, ${Math.round(waterInfo.position.z)})，${waterInfo.distance.toFixed(1)} 格——超过抛竿距离 ${FISH_WATER_REACH} 格，先走过去。`,
                        0,
                    );
                    if (nextCall == null) {
                        nextCall =
                            waterInfo == null
                                ? 'searchForBlock(type="water", search_range=256)'
                                : `goToCoordinates(x=${Math.round(waterInfo.position.x)}, y=${Math.round(waterInfo.position.y)}, z=${Math.round(waterInfo.position.z)}, closeness=3)`;
                    }
                } else {
                    const gainedBefore = ediblesNow();
                    const result = await fish(bot, Math.min(GETFOOD_FISH_MAX_MS, Math.max(5_000, left() - 5_000)), GETFOOD_FISH_MAX_CASTS);
                    const gained = ediblesNow() - gainedBefore;
                    record('fish', `钓鱼：${result.label}（能吃的 ${gained >= 0 ? '+' : ''}${gained}）`, gained);
                    if (result.nextCall != null) nextCall = result.nextCall;
                }
            }
        } else if (ediblesNow() < want) {
            record('fish', `钓鱼：跳过（剩余预算不足 ${GETFOOD_MIN_STEP_MS / 1000} 秒）。`, 0);
        }

        // ── 结果：到目标了？拿到了？还是卡住了？ ──
        const after = ediblesNow();
        if (after >= want) {
            stopReason = 'reached';
        } else if (after > ediblesBefore) {
            stopReason = 'gained';
        } else if (bot?.interrupt_code === true) {
            stopReason = 'interrupted';
        } else {
            stopReason = left() <= 0 ? 'budget' : 'blocked';
        }

        // ── ④ 种地：长期方案（**说清生长时间**，别在危机里等） ──
        const assets = foodReserveAssets(inventory(bot));
        if (assets.seeds > 0) {
            longTerm =
                `④ 种地（**长期方案，不是现在**）：背包有 ${assets.seeds} 个种子——` +
                `${craftingTableCall('2 oak_planks, 2 stick', '1 wooden_hoe')} → 在水边泥土/草方块上锄地、播种；` +
                `小麦要 **20~40 分钟**才熟（现实时间），**别在危机里站着等**，先去钓鱼/打猎。`;
            record('crops', `种地：有 ${assets.seeds} 个种子（长期方案，生长 20~40 分钟，不在这一趟里等）。`, 0);
        }

        // ── ⑥ **优先级**：主世界里的蛛网这条链是有界的浅差事，先做完它 ──
        //
        // 真机：这条链四个办法全撞墙（digDown 被连续水层挡、128 格内没蜘蛛、goToCoordinates
        // 卡在水边 90 秒），而它解锁的是**弓**——弓又解锁恶魂之泪，并让末影人变得能打
        // （overnight_a：末地主岛六只末影人，空手上去是送）。所以它该排在打猎/种地前面。
        const dimension = (() => {
            try {
                return typeof bot?.game?.dimension === 'string' ? bot.game.dimension.toLowerCase() : '';
            } catch {
                return '';
            }
        })();
        if (dimension.includes('overworld') && countOf(bot, 'string') < 2 && countOf(bot, 'fishing_rod') === 0) {
            const site = bestKnownCobwebSite(position(bot) ?? null);
            warnings.unshift(
                `⑥ **优先做这条**：蛛网→线→弓（3 块蛛网 = 2 根线 = 1 把弓；弓解锁恶魂之泪，也让末影人能远打）。` +
                    (site == null
                        ? ''
                        : `已知**最浅**的一片在主世界 (${Math.round(site.x)}, ${Math.round(site.y)}, ${Math.round(site.z)}) 一带` +
                          `（±${KNOWN_COBWEB_CLUSTER_RADIUS} 格内十来个，全在 y=${KNOWN_COBWEB_CLUSTER_Y[0]}~${KNOWN_COBWEB_CLUSTER_Y[1]}）：` +
                          `**从侧面进**（` + `travelTo(x=${Math.round(site.x)}, y=${Math.round(site.y)}, z=${Math.round(site.z)})` + `），` +
                          `别顺着水层往下挖竖井（会被连续水层挡住）。`),
            );
        }

        // ── ⑤ 最后手段：腐肉（会附带饥饿效果） ──
        const rotten = countOf(bot, 'rotten_flesh');
        if (after === 0 && rotten > 0) {
            warnings.push(
                `⑤ 最后手段：背包里有 rotten_fleshx${rotten}——**吃它会附带"饥饿"效果**（掉饱食度更快），只当应急，别当主食。`,
            );
            record('rotten', `腐肉：有 ${rotten} 个（应急可选，带饥饿效果）。`, 0);
        }

        // ── "接着做"：没拿到就跟着断点走；拿到了就提醒先烤 ──
        if (nextCall == null || (after > ediblesBefore && stopReason === 'gained' && !nextCall.startsWith('useBlock(type="furnace"'))) {
            const gainedItems = edibleItemsFrom(inventory(bot));
            const rawItem = gainedItems.find((item) => cookedCounterpartOf(item.name) != null);
            if (after > ediblesBefore && rawItem != null) {
                nextCall = cookCallFor(rawItem.name, rawItem.count) ?? 'stats(type="inventory")';
            } else if (nextCall == null) {
                nextCall = ediblesNow() > 0 ? 'stats(type="inventory")' : 'stats(type="inventory")';
            }
        }
    }

    const satBefore = before.saturation;
    const after = foodState(bot);
    const outcome: GetFoodOutcome = {
        want,
        ediblesBefore,
        ediblesAfter: ediblesNow(),
        healthBefore,
        healthAfter: health(bot),
        foodBefore: before.food,
        foodAfter: after.food,
        saturationBefore: satBefore,
        saturationAfter: after.saturation,
        eaten,
        steps,
        stopReason,
        nextCall: nextCall ?? 'stats(type="inventory")',
        elapsedMs: now() - startedAt,
        water: waterInfo,
        warnings,
        longTerm,
    };
    // 血/食物都没变、背包也没变 → **不许说成功**（headline 已经这么写了，这里再加一条硬提醒）
    if (outcome.ediblesAfter === outcome.ediblesBefore && outcome.eaten.length === 0 && stopReason !== 'enough') {
        outcome.warnings.unshift(
            `⚠️ 这一趟**什么都没变**（能吃的 ${outcome.ediblesBefore} 份、食物 ${outcome.foodBefore ?? '读不到'}）——按上面的断点接着做，别把这当成"找过了"。`,
        );
    }
    // **失败时补上"吃的在哪"**（真机 overnight_a：血 8.575、食物 14 卡了 8 分钟，
    // 它确实在试 getFood，但回执只说"没拿到" ⇒ 模型只能在几个工具之间空转）。
    // 只报量到的：实体扫描失败 ⇒ 写"读不到"，绝不说"这一带没有"。
    // `interrupted` = 人按了 Stop：那不是"路走不通"，不要借机劝它往别处走。
    if (outcome.ediblesAfter === outcome.ediblesBefore && stopReason !== 'enough' && stopReason !== 'interrupted') {
        try {
            const survey = surveyFood(bot, { position, findBlock, water });
            outcome.survey = survey;
            outcome.rodAvailable = countOf(bot, 'fishing_rod') > 0;
            outcome.huntedWithoutGain = steps.some((step) => step.id === 'hunt' && step.gained <= 0);
            const better = foodNextCallFromSurvey(survey, position(bot) ?? null);
            // **只在下一步是死胡同时才换**（`stats`/再调一次 getFood 都是空转的形状）；
            // 已经有具体动作（蛛网/水/烤）就不抢。
            if (
                better != null &&
                (outcome.nextCall.startsWith('stats(') || outcome.nextCall.startsWith('getFood('))
            ) {
                outcome.nextCall = better;
            }
        } catch {
            // 扫描本身炸了 ⇒ 明确说"没扫到"，不猜（`null` 会被渲染成"没扫到"）。
            outcome.survey = null;
        }
    }
    void sleep;
    void explore;
    return getFoodReceipt(outcome);
}
