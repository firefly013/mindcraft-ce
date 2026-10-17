/*
 * 生存安全：把"现在危不危险、该干什么"从原始快照里算出来。
 *
 * 为什么需要这一层：
 *   - Live State 每次都给一堆**事实**（时间、坐标、药水效果、背包、附近实体），
 *     但"还有多久天黑""头顶有没有顶""够不够打烈焰人"都要模型自己心算。
 *     真机上模型算错过也漏看过，所以把这些判断收成**纯函数**，可单测、可复用。
 *   - 这一层只做**读**和**决策**；真正动手（挖、走、睡、喝）仍走 skills 里的原语，
 *     命令仍注册进现有 registry，不另起一套。
 *
 * 分三块：
 *   1) `sampleSurvivalSignals(bot)` 读 bot → `SurvivalSignals`（防御式，永不抛）；
 *   2) `assessSurvival(signals)` 纯函数 → `SurvivalAssessment`（结论 + 缺什么 + 建议）；
 *   3) `*Skill(bot)` 动作：复用 skills 原语执行，用 log 写人话回执。
 */

import { Vec3 } from 'vec3';
import * as skills from './skills.js';
import type { MoveDirection } from './skills.js';
import * as world from './world.js';
import { FOOD_VALUE, isHostile, pickBestFood } from '../safety/emergency.js';

/** 与 edges / live_state 同一套夜晚阈值（12542 起怪物可刷，23460 天亮）。 */
export const NIGHT_START = 12542;
export const NIGHT_END = 23460;
export const DAY_TICKS = 24000;
/** 天黑前多少 tick 就该准备庇护所（1500 tick ≈ 75 秒）。 */
export const NIGHT_WARNING_TICKS = 1500;
/** 抗火 Buff 少于这个秒数就算"快没了"，该补。 */
export const MIN_FIRE_RESIST_SECONDS = 45;
/** 一瓶普通抗火药水按 3 分钟估。 */
export const FIRE_RESIST_POTION_SECONDS = 180;
/** 判定"周围危险"的半径。 */
export const HOSTILE_RADIUS = 32;
/** 挖地下庇护所最多往下一段（避免一头扎进岩浆/基岩）。 */
export const MAX_SHELTER_DIG = 6;

export interface EffectInfo {
    name: string;
    amplifier: number | null;
    durationSeconds: number | null;
}

export interface HostileInfo {
    name: string;
    distance: number;
}

/**
 * 采出来的生存事实。全部允许 null —— 采不到就说采不到，不猜。
 */
export interface SurvivalSignals {
    dimension: string | null;
    timeOfDay: number | null;
    x: number | null;
    y: number | null;
    z: number | null;
    /** 该竖列最高实心方块的 y；读不到为 null。 */
    surfaceY: number | null;
    /** 头顶扫描到的第一个不透光方块名；null = 扫描到顶都是空的。 */
    roofBlock: string | null;
    /** 是否成功读到过头顶方块（区分"没顶"与"读不到"）。 */
    roofReadable: boolean;
    health: number | null;
    food: number | null;
    effects: EffectInfo[];
    hostiles: HostileInfo[];
    inventory: Record<string, number>;
    bedCount: number;
    foodCount: number;
    fireResistPotionCount: number;
}


/** 写一条人话回执，并把它作为返回值（方便直接测）。 */
function logLine(bot: any, message: string): string {
    skills.log(bot, message);
    return message;
}

const AIR = new Set(['air', 'cave_air', 'void_air']);

function isPassableName(name: string | null | undefined): boolean {
    return name == null || AIR.has(name);
}

/** `minecraft:fire_resistance` / `Fire Resistance` / `fire_resistance` 都归一到同一个键。 */
export function normalizeEffectName(name: string): string {
    // 去掉 `minecraft:` 命名空间前缀，再归一成下划线小写。
    const bare = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    return bare.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function isNightTime(timeOfDay: number | null | undefined): boolean {
    return timeOfDay != null && timeOfDay >= NIGHT_START && timeOfDay < NIGHT_END;
}

/** 距下一次天黑还有多少 tick（夜里返回 0）。 */
export function ticksUntilNight(timeOfDay: number | null | undefined): number | null {
    if (timeOfDay == null || !Number.isFinite(timeOfDay)) return null;
    const t = ((timeOfDay % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
    if (t < NIGHT_START) return NIGHT_START - t;
    if (t >= NIGHT_END) return DAY_TICKS - t + NIGHT_START;
    return 0;
}

/** 距天亮还有多少 tick（白天返回 0）。 */
export function ticksUntilDawn(timeOfDay: number | null | undefined): number | null {
    if (timeOfDay == null || !Number.isFinite(timeOfDay)) return null;
    const t = ((timeOfDay % DAY_TICKS) + DAY_TICKS) % DAY_TICKS;
    if (t < NIGHT_START) return 0;
    if (t >= NIGHT_END) return 0;
    return NIGHT_END - t;
}

/**
 * 药水物品是不是抗火药水。名字必须像 potion，NBT 里的 Potion 标签含 fire_resistance。
 * 兼容两种 NBT 形状：`value.Potion` 是字符串，或 `value.Potion.value` 是字符串。
 */
export function isFireResistancePotion(item: any): boolean {
    if (item == null || typeof item.name !== 'string' || !item.name.includes('potion')) return false;
    const tag = item.nbt?.value?.Potion;
    const raw = typeof tag === 'string' ? tag : typeof tag?.value === 'string' ? tag.value : null;
    return raw != null && raw.toLowerCase().includes('fire_resistance');
}

/** 从背包里挑一个抗火药水（不喝，只找）。 */
export function findFireResistancePotion(bot: any): any | null {
    try {
        const items: any[] = typeof bot?.inventory?.items === 'function' ? bot.inventory.items() : [];
        return items.find((item) => isFireResistancePotion(item)) ?? null;
    } catch {
        return null;
    }
}

/**
 * 读数药水效果。mineflayer 的实体效果只有 {id, amplifier, duration}，
 * 名字要查 mcData 的注册表（和 live_state 的 effectsOf 同一套口径）。
 */
export function readEffects(bot: any): EffectInfo[] {
    const out: EffectInfo[] = [];
    try {
        const raw = bot?.entity?.effects;
        const list: unknown[] = Array.isArray(raw)
            ? raw
            : raw != null && typeof raw === 'object'
              ? Object.values(raw)
              : [];
        const registry: Record<string, any> = bot?.registry?.effects ?? {};
        for (const entry of list) {
            const e = entry as { id?: unknown; name?: unknown; amplifier?: unknown; duration?: unknown } | null;
            if (e == null) continue;
            const id = typeof e.id === 'number' ? e.id : null;
            let meta = id != null ? registry[String(id)] : undefined;
            if (meta != null && typeof meta.id === 'number' && meta.id !== id) {
                meta = Object.values(registry).find((value: any) => value?.id === id);
            }
            const name =
                (typeof e.name === 'string' && e.name) ||
                (typeof meta?.displayName === 'string' && meta.displayName) ||
                (typeof meta?.name === 'string' && meta.name) ||
                (id != null ? `effect#${id}` : null);
            if (name == null) continue;
            const durationTicks = typeof e.duration === 'number' ? e.duration : null;
            out.push({
                name,
                amplifier: typeof e.amplifier === 'number' ? e.amplifier : null,
                durationSeconds: durationTicks != null ? Math.round(durationTicks / 20) : null,
            });
        }
    } catch {
        // 读不到效果就当没有 —— 好过抛异常把整次检查带崩。
    }
    return out;
}

/** 该竖列最高的非空气方块 y（从世界高度往下扫）。读不到返回 null。 */
export function surfaceHeightAt(bot: any, x: number, z: number): number | null {
    try {
        if (typeof bot?.blockAt !== 'function') return null;
        const rawHeight = bot?.game?.height;
        const top = Number.isFinite(rawHeight) ? Number(rawHeight) - 1 : 319;
        for (let y = top; y >= -64; y--) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block == null) continue;
            if (!isPassableName(block.name)) return y;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * 头顶第一个不透光方块。返回 null 有两种含义，用 second 返回值区分：
 * readable=false 表示方块读不到（区块没加载），readable=true & block=null 表示露天。
 */
export function roofAbove(bot: any, x: number, y: number, z: number): { block: string | null; readable: boolean } {
    try {
        if (typeof bot?.blockAt !== 'function') return { block: null, readable: false };
        let readable = false;
        for (let dy = 2; dy <= 10; dy++) {
            const block = bot.blockAt(new Vec3(x, y + dy, z));
            if (block == null) continue;
            readable = true;
            if (isPassableName(block.name) || block.transparent === true) continue;
            return { block: String(block.name), readable: true };
        }
        return { block: null, readable };
    } catch {
        return { block: null, readable: false };
    }
}

/** 食物名 → 计数（只认 emergency 那张表里的可食用物）。 */
export function countFood(inventory: Record<string, number>): number {
    let total = 0;
    for (const [name, count] of Object.entries(inventory)) {
        if (FOOD_VALUE[name] != null && Number.isFinite(count)) total += count;
    }
    return total;
}

/** 床的计数：床的注册名都是 `*_bed`（红床 red_bed 等）。 */
export function countBeds(inventory: Record<string, number>): number {
    let total = 0;
    for (const [name, count] of Object.entries(inventory)) {
        if (name.endsWith('_bed') && Number.isFinite(count)) total += count;
    }
    return total;
}

/** 从 bot 采一份生存事实。任何一步读失败都退化成 null，绝不抛。 */
export function sampleSurvivalSignals(bot: any): SurvivalSignals {
    const pos = bot?.entity?.position ?? {};
    const x = typeof pos.x === 'number' ? pos.x : null;
    const y = typeof pos.y === 'number' ? pos.y : null;
    const z = typeof pos.z === 'number' ? pos.z : null;

    let inventory: Record<string, number>;
    try {
        inventory = world.getInventoryCounts(bot) ?? {};
    } catch {
        inventory = {};
    }

    const hostiles: HostileInfo[] = [];
    try {
        const selfId = bot?.entity?.id;
        for (const entity of Object.values(bot?.entities ?? {}) as any[]) {
            if (entity == null || entity.id === selfId) continue;
            const name = typeof entity.name === 'string' ? entity.name : typeof entity.displayName === 'string' ? entity.displayName : '';
            if (name === '' || !isHostile(name, entity.hostile)) continue;
            const ep = entity.position;
            if (ep == null || x == null || y == null || z == null) continue;
            const distance = Math.hypot(ep.x - x, ep.y - y, ep.z - z);
            if (distance <= HOSTILE_RADIUS) hostiles.push({ name, distance: Math.round(distance * 10) / 10 });
        }
        hostiles.sort((a, b) => a.distance - b.distance);
        hostiles.length = Math.min(hostiles.length, 8);
    } catch {
        // 实体表读不到就不报威胁，交给保命程序兜底。
    }

    const roof = x != null && y != null && z != null ? roofAbove(bot, x, y, z) : { block: null, readable: false };

    return {
        dimension: typeof bot?.game?.dimension === 'string' ? bot.game.dimension : null,
        timeOfDay: typeof bot?.time?.timeOfDay === 'number' ? bot.time.timeOfDay : null,
        x,
        y,
        z,
        surfaceY: x != null && z != null ? surfaceHeightAt(bot, x, z) : null,
        roofBlock: roof.block,
        roofReadable: roof.readable,
        health: typeof bot?.health === 'number' ? bot.health : null,
        food: typeof bot?.food === 'number' ? bot.food : null,
        effects: readEffects(bot),
        hostiles,
        inventory,
        bedCount: countBeds(inventory),
        foodCount: countFood(inventory),
        fireResistPotionCount: findFireResistancePotion(bot) != null ? 1 : 0,
    };
}

export interface SurvivalAssessment {
    timeOfDay: number | null;
    isNight: boolean;
    ticksUntilNight: number | null;
    ticksUntilDawn: number | null;
    y: number | null;
    surfaceY: number | null;
    /** 明确在最高实心方块下面 2 格及以上为 true；算不出来为 null。 */
    underground: boolean | null;
    /** 头顶有不透光方块为 true；读不到为 null。 */
    roofed: boolean | null;
    roofBlock: string | null;
    /** 有顶且不在明确地表：能挡住地表怪物。 */
    sheltered: boolean;
    health: number | null;
    food: number | null;
    foodCount: number;
    bedCount: number;
    fireResistSeconds: number | null;
    fireResistPotionCount: number;
    /** Buff + 库存药水大约能覆盖多少秒。 */
    fireResistCoverSeconds: number;
    hostiles: HostileInfo[];
    hostileCount: number;
    nearestHostile: HostileInfo | null;
    foodReady: boolean;
    fireResistReady: boolean;
    blazeReady: boolean;
    missing: string[];
    advice: string;
    dimension: string | null;
}

function fireResistSecondsOf(effects: EffectInfo[]): number | null {
    const found = effects.filter((e) => normalizeEffectName(e.name).includes('fire_resistance'));
    if (found.length === 0) return null;
    const durations = found.map((e) => e.durationSeconds).filter((d): d is number => d != null);
    return durations.length > 0 ? Math.max(...durations) : null;
}

/**
 * 纯决策：给一份生存事实，算出"安不安全、缺什么、下一步做什么"。
 * 不碰 bot，所以可以把边界情况全测到。
 */
export function assessSurvival(signals: SurvivalSignals): SurvivalAssessment {
    const { timeOfDay, y, surfaceY, health, food, foodCount, bedCount, hostiles } = signals;
    const isNight = isNightTime(timeOfDay);
    const underground = y != null && surfaceY != null ? y <= surfaceY - 2 : null;
    const roofed = signals.roofReadable ? signals.roofBlock != null : null;
    const sheltered = roofed === true && underground !== false;

    const fireResistSeconds = fireResistSecondsOf(signals.effects);
    const fireResistPotionCount = signals.fireResistPotionCount;
    const fireResistCoverSeconds = (fireResistSeconds ?? 0) + fireResistPotionCount * FIRE_RESIST_POTION_SECONDS;
    const foodReady = foodCount >= 2 || (foodCount >= 1 && food != null && food >= 14);
    const fireResistReady = (fireResistSeconds != null && fireResistSeconds >= MIN_FIRE_RESIST_SECONDS) || fireResistPotionCount > 0;

    const nearestHostile = hostiles.length > 0 ? hostiles[0] : null;
    const missing: string[] = [];
    if (!fireResistReady) {
        missing.push(
            fireResistPotionCount === 0
                ? '抗火药水（背包 0 瓶、身上也没 Buff；要烈焰粉 + 岩浆膏 + 酿造台自制）'
                : '抗火 Buff（有药水但还没喝）',
        );
    }
    if (!foodReady) missing.push('食物（要能顶住饿的熟食，至少 2 份）');
    if (health != null && health < 6) missing.push('血量（先回血再打烈焰人）');

    const blazeReady = missing.length === 0;

    let advice: string;
    if (nearestHostile != null && health != null && health <= 8) {
        advice = `周围有敌对生物（最近 ${nearestHostile.name} ${nearestHostile.distance}m）而血量只剩 ${health}：先撤进地下掩体，别在地表硬拼。`;
    } else if (isNight && !sheltered) {
        advice = '现在是夜晚又没有地下掩体：立刻调用 seekShelter 回地下，别在地表打怪。';
    } else if (!isNight && (ticksUntilNight(timeOfDay) ?? DAY_TICKS) <= NIGHT_WARNING_TICKS && !sheltered) {
        advice = `快天黑了（还有 ${ticksUntilNight(timeOfDay)} tick）：先用 seekShelter 找/挖地下庇护所，把床和食物带下去。`;
    } else if (isNight && sheltered) {
        advice = bedCount > 0
            ? '已在地下且有床：用 sleepUnderground 睡觉到天亮。'
            : '已在地下但没有床：用 sleepUnderground 蹲到天亮，别出去。';
    } else if (!fireResistReady) {
        advice = '打烈焰人/进下界前要先备好抗火药水：调用 prepareBlaze 检查并喝下，Buff 快没了就再调一次。';
    } else if (sheltered) {
        advice = '地下掩体就绪，食物和抗火也够：按计划推进，Buff 快没了就补。';
    } else {
        advice = '先保证有地下掩体和食物，再考虑远行或打烈焰人。';
    }

    return {
        timeOfDay,
        isNight,
        ticksUntilNight: ticksUntilNight(timeOfDay),
        ticksUntilDawn: ticksUntilDawn(timeOfDay),
        y,
        surfaceY,
        underground,
        roofed,
        roofBlock: signals.roofBlock,
        sheltered,
        health,
        food,
        foodCount,
        bedCount,
        fireResistSeconds,
        fireResistPotionCount,
        fireResistCoverSeconds,
        hostiles,
        hostileCount: hostiles.length,
        nearestHostile,
        foodReady,
        fireResistReady,
        blazeReady,
        missing,
        advice,
        dimension: signals.dimension,
    };
}

const numOr = (value: number | null, suffix = ''): string => (value == null ? 'unknown' : `${value}${suffix}`);
const secs = (ticks: number | null): string => (ticks == null ? 'unknown' : `${Math.round(ticks / 20)}s`);

/** 把评估渲成给模型看的纯文本报告（query 工具用）。 */
export function formatSurvivalReport(a: SurvivalAssessment): string {
    const timeLabel = a.isNight ? '夜晚' : '白天';
    const timeLine = a.timeOfDay == null
        ? '时间：unknown'
        : `时间：${timeLabel}（timeOfDay ${a.timeOfDay}，距天黑 ${secs(a.ticksUntilNight)} / 距天亮 ${secs(a.ticksUntilDawn)}）`;
    const depth = a.y != null && a.surfaceY != null ? a.y - a.surfaceY : null;
    const posLine =
        a.surfaceY == null
            ? `位置：y=${numOr(a.y)}（地表高度 unknown）`
            : `位置：y=${numOr(a.y)}，该列地表 y=${a.surfaceY}（${depth != null && depth <= -2 ? `地下 ${-depth} 格` : '在地表或附近'}）`;
    const shelterLine = `掩体：${a.sheltered ? '有（地下或有顶）' : '没有'}${a.roofed === true ? `，头顶 ${a.roofBlock ?? '实体'} 挡着` : a.roofed === false ? '，头顶露天' : '，头顶读不到'}`;
    const threatLine = a.nearestHostile == null
        ? `危险生物：${HOSTILE_RADIUS} 格内没有`
        : `危险生物：${a.hostileCount} 个（最近 ${a.nearestHostile.name} ${a.nearestHostile.distance}m）`;
    const supplyLine =
        `物资：床 ${a.bedCount} 张；食物 hunger=${numOr(a.food)}，背包含 ${a.foodCount} 份；` +
        `抗火药水：Buff ${a.fireResistSeconds == null ? '无' : `${a.fireResistSeconds}s`}，库存 ${a.fireResistPotionCount} 瓶`;
    const readyLine =
        `就绪：地下庇护 ${a.sheltered ? '是' : '否'}；烈焰人准备 ${a.blazeReady ? '是' : `否（缺 ${a.missing.join('、') || '未知'}）`}`;
    return [
        '生存检查：',
        `- ${timeLine}`,
        `- ${posLine}`,
        `- ${shelterLine}`,
        `- ${threatLine}`,
        `- ${supplyLine}`,
        `- ${readyLine}`,
        `- 建议：${a.advice}`,
    ].join('\n');
}

/** query 工具入口。 */
export function survivalCheckReport(bot: any): string {
    return formatSurvivalReport(assessSurvival(sampleSurvivalSignals(bot)));
}

// ---------------------------------------------------------------
// 动作层：下面这些才真正动 bot，全部复用 skills 原语。
// ---------------------------------------------------------------

/** 往地下挖多少格：目标落在该列地表下 3 格，夹在 2~MAX_SHELTER_DIG。 */
export function shelterDigDepth(y: number | null, surfaceY: number | null, min = 2, max = MAX_SHELTER_DIG): number {
    if (y == null || surfaceY == null) return 3;
    const depth = Math.round(y - (surfaceY - 3));
    return Math.max(min, Math.min(max, depth));
}

/**
 * 找一个现成的"有顶 2 格空间"：脚下有地板、脚/头是空的、头顶再上一格是实心。
 * 找不到返回 null。全部防御式读取。
 */
export function findNearbyCoveredSpot(bot: any): { x: number; y: number; z: number } | null {
    try {
        if (typeof bot?.findBlocks !== 'function' || typeof bot?.blockAt !== 'function') return null;
        const pos = bot.entity.position;
        const candidates: any[] = bot.findBlocks({
            matching: (block: any) => block != null && isPassableName(block.name),
            maxDistance: 6,
            count: 64,
        });
        let best: { x: number; y: number; z: number } | null = null;
        let bestDistance = Infinity;
        for (const candidate of candidates) {
            const head = bot.blockAt(candidate.offset(0, 1, 0));
            const roof = bot.blockAt(candidate.offset(0, 2, 0));
            const floor = bot.blockAt(candidate.offset(0, -1, 0));
            if (head == null || roof == null || floor == null) continue;
            if (!isPassableName(head.name) || roof.transparent === true || isPassableName(roof.name)) continue;
            if (isPassableName(floor.name) || floor.transparent === true) continue;
            const distance = Math.hypot(candidate.x - pos.x, candidate.y - pos.y, candidate.z - pos.z);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = { x: candidate.x, y: candidate.y, z: candidate.z };
            }
        }
        return best;
    } catch {
        return null;
    }
}

const CARVE_DIRECTIONS: ReadonlyArray<{ name: MoveDirection; dx: number; dz: number }> = [
    { name: 'north', dx: 0, dz: -1 },
    { name: 'south', dx: 0, dz: 1 },
    { name: 'east', dx: 1, dz: 0 },
    { name: 'west', dx: -1, dz: 0 },
];

function isHazardName(name: string | null | undefined): boolean {
    return typeof name === 'string' && (name.includes('water') || name.includes('lava') || name === 'bedrock');
}

/**
 * 在当前位置旁边挖出一个 2 格高、有顶的窝：挖掉某一水平方向的脚/头两格，
 * 再走进去。挖进去后头顶那格没被碰过，天然就是顶。返回是否挖好。
 */
export async function carvePocket(bot: any): Promise<boolean> {
    const pos = bot?.entity?.position;
    if (pos == null || typeof bot?.blockAt !== 'function') return false;
    for (const dir of CARVE_DIRECTIONS) {
        const feet = pos.offset(dir.dx, 0, dir.dz);
        const head = pos.offset(dir.dx, 1, dir.dz);
        const roof = pos.offset(dir.dx, 2, dir.dz);
        const f = bot.blockAt(feet);
        const h = bot.blockAt(head);
        const r = bot.blockAt(roof);
        if (f == null || h == null || r == null) continue;
        if (isHazardName(f.name) || isHazardName(h.name) || isHazardName(r.name)) continue;
        // 头顶那格必须本来就有实体方块，否则挖进去也是露天的。
        if (isPassableName(r.name)) continue;
        const feetOpen = isPassableName(f.name);
        const headOpen = isPassableName(h.name);
        if (feetOpen && headOpen) {
            await skills.moveBy(bot, dir.name, 1);
            return true;
        }
        if (!feetOpen && (f.diggable === false || typeof f.diggable === 'undefined')) continue;
        if (!headOpen && (h.diggable === false || typeof h.diggable === 'undefined')) continue;
        const dugFeet = feetOpen || (await skills.mineBlockAt(bot, feet.x, feet.y, feet.z));
        if (!dugFeet) continue;
        const dugHead = headOpen || (await skills.mineBlockAt(bot, head.x, head.y, head.z));
        if (!dugHead) continue;
        await skills.moveBy(bot, dir.name, 1);
        return true;
    }
    return false;
}

/**
 * 找/挖一个地下庇护所。
 * 顺序：已经在里面 → 附近现成有顶空间 → 往下挖 → 往旁边掏窝。
 */
export async function seekShelterSkill(bot: any): Promise<string> {
    const before = assessSurvival(sampleSurvivalSignals(bot));
    if (before.sheltered) {
        return logLine(
            bot,
            `已经有庇护：y=${before.y}，头顶 ${before.roofBlock ?? '有方块'} 挡着，${before.underground ? '在地下' : '不在明确地下'}。不用再动。`,
        );
    }

    const spot = findNearbyCoveredSpot(bot);
    if (spot != null) {
        const ok = await skills.goToPosition(bot, spot.x, spot.y, spot.z, 1);
        const afterMove = assessSurvival(sampleSurvivalSignals(bot));
        if (ok && afterMove.sheltered) {
            return logLine(bot, `附近有现成有顶空间 (${spot.x},${spot.y},${spot.z})，已经过去躲好。`);
        }
        skills.log(bot, `附近的有顶空间 (${spot.x},${spot.y},${spot.z}) 没走成，改为自己挖。`);
    }

    let note: string;
    if (before.underground === true) {
        note = '已经在深处但没有顶，直接往旁边掏一个洞。';
    } else {
        const depth = shelterDigDepth(before.y, before.surfaceY);
        const dug = await skills.digDown(bot, depth);
        if (!dug) {
            const stuck = assessSurvival(sampleSurvivalSignals(bot));
            return logLine(
                bot,
                `往下挖受阻（水/岩浆/落差），停在 y=${stuck.y}。换个位置再试 seekShelter，或用 mineBlock 手动往旁边开洞。`,
            );
        }
        note = `向下挖了 ${depth} 格到 y=${sampleSurvivalSignals(bot).y}。`;
    }

    const carved = await carvePocket(bot);
    const after = assessSurvival(sampleSurvivalSignals(bot));
    if (after.sheltered) {
        return logLine(
            bot,
            `${note}${carved ? '又向旁边掏出一格有顶空间' : '站稳了'}：地下庇护就绪（y=${after.y}，头顶 ${after.roofBlock ?? '方块'}）。把床和食物带下来，天黑用 sleepUnderground。`,
        );
    }
    return logLine(
        bot,
        `${note}但没掏成有顶空间（四周可能都是水/岩浆/挖不动）。停在 y=${after.y}，先别上地表：换个地方再 seekShelter，或用 placeBlock 把头顶封上。`,
    );
}

/** 在地下等到天亮：每 10 秒看一次时间，最多 maxSeconds 秒。 */
export async function waitForDawn(bot: any, maxSeconds = 600): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < maxSeconds * 1000) {
        const timeOfDay = sampleSurvivalSignals(bot).timeOfDay;
        // 读不到时间不能当成天亮（否则会误上地表）；继续等，到 maxSeconds 为止。
        if (timeOfDay != null && !isNightTime(timeOfDay)) {
            return `已经天亮了（在地下待了 ${Math.round((Date.now() - start) / 1000)} 秒）。`;
        }
        if (bot?.interrupt_code === true) return '等待被打断了。';
        await skills.stay(bot, 10);
    }
    return `在地下等满 ${maxSeconds} 秒还没天亮，需要的话再调一次 sleepUnderground。`;
}

/**
 * 夜晚在地下睡觉或等待：先确保有庇护，有床就睡，没床就蹲到天亮。
 */
export async function sleepUndergroundSkill(bot: any): Promise<string> {
    const notes: string[] = [];
    const before = assessSurvival(sampleSurvivalSignals(bot));
    if (!before.sheltered) {
        notes.push(await seekShelterSkill(bot));
    }
    const now = assessSurvival(sampleSurvivalSignals(bot));
    if (!now.sheltered) {
        return logLine(bot, `${notes.join(' ')} 庇护还没弄好，先别睡也别上地表——处理完再调 sleepUnderground。`);
    }
    if (now.timeOfDay == null) {
        return logLine(bot, `${notes.join(' ')} 读不到游戏时间，没法判断白天黑夜——先在地下待着，稍后再调 survivalCheck。`);
    }
    if (!now.isNight) {
        return logLine(
            bot,
            `${notes.join(' ')} 现在是白天（距天黑 ${Math.round((now.ticksUntilNight ?? 0) / 20)} 秒），不用睡。天黑前记得早点回地下。`,
        );
    }
    if (now.bedCount > 0) {
        const slept = await skills.goToBed(bot);
        if (slept) {
            return logLine(bot, `${notes.join(' ')} 天亮前在地下睡了一觉，醒来再行动。`);
        }
        notes.push('周围有床，但没能睡下（可能旁边有怪、床被占、或没到睡觉时间）。');
    } else {
        notes.push('周围没有床。');
    }
    const waited = await waitForDawn(bot);
    return logLine(bot, `在地下等到天亮：${notes.join(' ')} ${waited}`);
}

/** 喝一瓶抗火药水（按 NBT 挑对药水，不靠名字猜）。 */
export async function drinkFireResistancePotion(bot: any): Promise<boolean> {
    const potion = findFireResistancePotion(bot);
    if (potion == null) return false;
    try {
        await bot.equip(potion, 'hand');
        await bot.consume();
        return true;
    } catch (error: unknown) {
        skills.log(bot, `喝抗火药水失败：${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
}

/**
 * 打烈焰人前的准备：喝抗火药水、吃饱，回报够不够。
 * Buff 快没了再调一次就是"保持 Buff"。
 */
export async function prepareBlazeSkill(bot: any): Promise<string> {
    const notes: string[] = [];
    let a = assessSurvival(sampleSurvivalSignals(bot));

    if (a.fireResistSeconds != null && a.fireResistSeconds >= MIN_FIRE_RESIST_SECONDS) {
        notes.push(`抗火 Buff 还在（剩 ${a.fireResistSeconds} 秒），够用。`);
    } else if (a.fireResistPotionCount > 0) {
        const drank = await drinkFireResistancePotion(bot);
        notes.push(drank ? '喝下抗火药水，Buff 已续上。' : '背包里有抗火药水，但没能喝下。');
    } else {
        notes.push(
            a.fireResistSeconds != null
                ? `没有抗火药水可补，当前 Buff 只剩 ${a.fireResistSeconds} 秒。`
                : '没有抗火药水：要烈焰粉 + 岩浆膏 + 酿造台自制。',
        );
    }

    const foodSignals = sampleSurvivalSignals(bot);
    a = assessSurvival(foodSignals);
    if (a.foodCount === 0) {
        notes.push('背包没有食物，先准备熟食（烤熟的肉/面包）。');
    } else if (a.food == null || a.food < 18) {
        const best = pickBestFood(Object.keys(foodSignals.inventory).filter((name) => (foodSignals.inventory[name] ?? 0) > 0));
        if (best != null) {
            const ate = await skills.consume(bot, best);
            notes.push(ate ? `吃了 ${best} 补饱食度。` : `想吃 ${best} 但没吃成。`);
        }
    } else {
        notes.push(`饱食度 ${a.food}，够。`);
    }

    const after = assessSurvival(sampleSurvivalSignals(bot));
    notes.push(
        after.blazeReady
            ? '烈焰人准备就绪：抗火 Buff + 食物都够。Buff 快没了就再调 prepareBlaze。'
            : `还没就绪，缺：${after.missing.join('、') || '见上'}。`,
    );
    return logLine(bot, notes.join(' '));
}

// ---------------------------------------------------------------
// 水中脱困：脚 water / 头 air 时，placeBlock 没支撑、placeHere NoPath、
// digDown 被水挡住，需要一个"找干燥落脚点并游过去"的工具。逻辑放这里
// （skills.ts 在 body-fixer 手里，本任务不动它）。
// ---------------------------------------------------------------

const WATERISH = new Set([
    'water', 'flowing_water', 'bubble_column',
    'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant',
]);

export function isWaterBlockName(name: unknown): boolean {
    return typeof name === 'string' && WATERISH.has(name);
}

function isAirBlockName(name: unknown): boolean {
    return name === 'air' || name === 'cave_air' || name === 'void_air';
}

/** 读某一格的方块名（读不到返回 null）。 */
function blockNameAtSafe(bot: any, x: number, y: number, z: number): string | null {
    try {
        const block = bot?.blockAt?.(new Vec3(x, y, z));
        return typeof block?.name === 'string' ? block.name : null;
    } catch {
        return null;
    }
}

/** 脚或头在水里就算卡水里。 */
export function isInWater(bot: any): boolean {
    const p = bot?.entity?.position;
    if (p == null) return false;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    return isWaterBlockName(blockNameAtSafe(bot, x, y, z)) || isWaterBlockName(blockNameAtSafe(bot, x, y + 1, z));
}

/** 脚下有实体支撑（不是空气/水/岩浆）。 */
export function hasSupport(bot: any): boolean {
    const p = bot?.entity?.position;
    if (p == null) return false;
    const below = blockNameAtSafe(bot, Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z));
    return below != null && !isAirBlockName(below) && !isWaterBlockName(below) && below !== 'lava';
}

/** 这一格能不能当"干燥落脚点"：脚/头是空气、脚下实心。 */
export function isDryStandableAt(bot: any, x: number, y: number, z: number): boolean {
    const feet = blockNameAtSafe(bot, x, y, z);
    const head = blockNameAtSafe(bot, x, y + 1, z);
    const below = blockNameAtSafe(bot, x, y - 1, z);
    if (feet == null || head == null || below == null) return false;
    if (!isAirBlockName(feet) || !isAirBlockName(head)) return false;
    if (isAirBlockName(below) || isWaterBlockName(below) || below === 'lava') return false;
    return true;
}

export interface DrySpot { x: number; y: number; z: number; distance: number; }

/**
 * 最近的干燥可站立点：按水平半径一圈圈向外找，y 只搜脚下 -2~+3，不往深水里钻。
 */
export function findNearestDrySpot(bot: any, radius = 16): DrySpot | null {
    const p = bot?.entity?.position;
    if (p == null || typeof bot?.blockAt !== 'function') return null;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    for (let r = 1; r <= radius; r++) {
        let best: DrySpot | null = null;
        let bestD = Number.POSITIVE_INFINITY;
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                for (let dy = -2; dy <= 3; dy++) {
                    const x = bx + dx;
                    const y = by + dy;
                    const z = bz + dz;
                    if (!isDryStandableAt(bot, x, y, z)) continue;
                    const d = Math.hypot(x + 0.5 - p.x, y - p.y, z + 0.5 - p.z);
                    if (d < bestD) { bestD = d; best = { x, y, z, distance: Math.round(d * 10) / 10 }; }
                }
            }
        }
        if (best != null) return best;
    }
    return null;
}

function posText(bot: any): string {
    const p = bot?.entity?.position;
    if (p == null) return '(unknown)';
    return `(${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10},${Math.round(p.z * 10) / 10})`;
}

export interface EscapeWaterDeps {
    goTo?: (bot: any, x: number, y: number, z: number, closeness: number) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    maxMs?: number;
}

/** 手动朝目标游/跳：持续按 forward + jump（上浮/爬上台阶），直到上岸或卡住。 */
export async function swimToward(
    bot: any,
    target: { x: number; y: number; z: number },
    deps: Required<Pick<EscapeWaterDeps, 'sleep' | 'now'>> & { maxMs: number },
): Promise<{ escaped: boolean; reason: string }> {
    const { sleep, now, maxMs } = deps;
    if (typeof bot?.setControlState !== 'function') return { escaped: false, reason: '身体还没就绪，按不了移动键' };
    const start = now();
    let lastProgressAt = start;
    let last = { x: bot?.entity?.position?.x ?? 0, z: bot?.entity?.position?.z ?? 0 };
    const look = new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    let iterations = 0;
    try {
        while (now() - start < maxMs && iterations++ < 400) {
            if (bot?.interrupt_code === true) return { escaped: false, reason: '被中断' };
            if (!isInWater(bot) && hasSupport(bot)) return { escaped: true, reason: '上岸成功' };
            try { await bot.lookAt(look, true); } catch { /* 转不过视角也继续按键 */ }
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await sleep(100);
            const here = bot?.entity?.position ?? { x: last.x, z: last.z };
            const moved = Math.hypot((here.x ?? 0) - last.x, (here.z ?? 0) - last.z);
            if (moved > 0.2) { lastProgressAt = now(); last = { x: here.x, z: here.z }; }
            else if (now() - lastProgressAt > 3000) return { escaped: false, reason: '朝岸边游了但 3 秒没有进展（可能被岸壁/方块挡住）' };
        }
    } finally {
        for (const key of ['forward', 'jump', 'sprint']) {
            try { bot.setControlState(key, false); } catch { /* 尽力松手 */ }
        }
    }
    if (!isInWater(bot) && hasSupport(bot)) return { escaped: true, reason: '上岸成功' };
    return { escaped: false, reason: `游了 ${Math.round((now() - start) / 1000)} 秒还没上岸` };
}

/**
 * 水中脱困：先找 16 格内最近的干燥落脚点，寻路过去；失败就手动朝那个方向
 * 游/跳。全过程给明确回执（起点、目标、寻路为什么失败、最后到没到岸）。
 */
export async function escapeWaterSkill(bot: any, deps: EscapeWaterDeps = {}): Promise<string> {
    const goTo = deps.goTo ?? ((b: any, x: number, y: number, z: number, c: number) => skills.goToPosition(b, x, y, z, c));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = deps.now ?? Date.now;
    const maxMs = deps.maxMs ?? 12000;
    if (!isInWater(bot)) {
        return logLine(bot, '你不在水里（脚/头都不是水），不用 escapeWater。要回地面可以用 goToSurface。');
    }
    const start = posText(bot);
    const spot = findNearestDrySpot(bot, 16);
    if (spot == null) {
        return logLine(bot, '在水里，而且 16 格内没找到"脚/头是空气、脚下实心"的干燥落脚点。先朝任意岸边游，或贴着实心墙用 placeBlock 垫脚（placeHere 在水里没有支撑会 NoPath）。');
    }
    let pathError = '';
    try {
        const ok = await goTo(bot, spot.x, spot.y, spot.z, 1);
        if (ok && !isInWater(bot)) {
            return logLine(bot, `寻路上岸成功：从 ${start} 到了干燥落脚点 (${spot.x},${spot.y},${spot.z})（离水边约 ${spot.distance} 格）。`);
        }
    } catch (error: unknown) {
        pathError = error instanceof Error ? error.message : String(error);
    }
    const swim = await swimToward(bot, spot, { sleep, now, maxMs });
    if (swim.escaped) {
        return logLine(bot, `寻路${pathError === '' ? '没走通' : `失败（${pathError}）`}，改为手动朝 (${spot.x},${spot.y},${spot.z}) 游/跳：${swim.reason}。现在在 ${posText(bot)}，脚下有支撑。`);
    }
    return logLine(bot, `寻路和手动游都没能上岸（${swim.reason}）。最近干燥点 (${spot.x},${spot.y},${spot.z})，现在在 ${posText(bot)}。可以朝岸边再试一次 escapeWater，或贴着实心墙用 placeBlock 垫脚（需要相邻支撑）。`);
}


// ---------------------------------------------------------------
// task-13：流体源头搜索与水桶装填。
// 实测：机器人水边找到的都是流动水，水桶装不进去；searchForBlock(water) 报的也是流动水。
// 这里只认**源方块**（level 0），流动水单独报告为"装不进桶"，让模型去更远找。
// ---------------------------------------------------------------

export type FluidKind = 'water' | 'lava';

/** 方块名 → 流体种类；不是流体返回 null。兼容 flowing_* 老命名。 */
export function fluidKindOf(name: unknown): FluidKind | null {
    if (typeof name !== 'string') return null;
    if (name === 'water' || name === 'flowing_water') return 'water';
    if (name === 'lava' || name === 'flowing_lava') return 'lava';
    return null;
}

/** 读流体 level：0=源，1..7 流动，8+ 下落。读不到返回 null。 */
export function readFluidLevel(block: any): number | null {
    const candidates: unknown[] = [];
    try {
        if (typeof block?.getProperties === 'function') candidates.push(block.getProperties()?.level);
    } catch { /* 读不到就算 */ }
    try { candidates.push(block?._properties?.level); } catch { /* 读不到就算 */ }
    try { candidates.push(block?.properties?.level); } catch { /* 读不到就算 */ }
    try { candidates.push(block?.metadata); } catch { /* 读不到就算 */ }
    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
}

/**
 * 是不是指定种类的**源**方块。
 * - 名字带 flowing_ 的一定是流动；
 * - 有 level 读数时只认 level === 0（源）；
 * - 层级完全读不到（老版本没有 level 属性）且名字不是 flowing_* 时按源处理。
 */
export function isFluidSourceBlock(block: any, kind?: FluidKind | 'any'): boolean {
    const fluid = fluidKindOf(block?.name);
    if (fluid == null) return false;
    if (kind != null && kind !== 'any' && kind !== fluid) return false;
    if (typeof block?.name === 'string' && block.name.startsWith('flowing_')) return false;
    const level = readFluidLevel(block);
    if (level == null) return true;
    return level === 0;
}

export interface FluidHit { kind: FluidKind; x: number; y: number; z: number; distance: number; }
export interface FluidScanResult { source: FluidHit | null; flowing: FluidHit | null; radius: number; }

/**
 * 环状向外扫最近流体方块：找到源就返回；同时记下最近的流动方块，
 * 好在"没有源"时明确告诉模型"只有流动水"。
 */
export function scanFluidSources(bot: any, kind: FluidKind | 'any' = 'any', radius = 32): FluidScanResult {
    const result: FluidScanResult = { source: null, flowing: null, radius };
    const p = bot?.entity?.position;
    if (p == null || typeof bot?.blockAt !== 'function') return result;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    const R = Math.max(1, Math.min(128, Math.floor(radius)));
    const V = 6;
    for (let r = 0; r <= R; r++) {
        let bestSource: FluidHit | null = null;
        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (r > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                for (let dy = -V; dy <= V; dy++) {
                    const x = bx + dx;
                    const y = by + dy;
                    const z = bz + dz;
                    let block: any;
                    try { block = bot.blockAt(new Vec3(x, y, z)); } catch { continue; }
                    const fluid = fluidKindOf(block?.name);
                    if (fluid == null) continue;
                    if (kind !== 'any' && fluid !== kind) continue;
                    const d = Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z);
                    const hit: FluidHit = { kind: fluid, x, y, z, distance: Math.round(d * 10) / 10 };
                    if (isFluidSourceBlock(block, kind)) {
                        if (bestSource == null || hit.distance < bestSource.distance) bestSource = hit;
                    } else if (result.flowing == null || hit.distance < result.flowing.distance) {
                        result.flowing = hit;
                    }
                }
            }
        }
        if (bestSource != null) { result.source = bestSource; return result; }
    }
    return result;
}

export function findFluidSource(bot: any, kind: FluidKind | 'any' = 'water', radius = 32): FluidHit | null {
    return scanFluidSources(bot, kind, radius).source;
}

const FLUID_LABEL: Record<FluidKind, string> = { water: '水源', lava: '岩浆源' };

/** `!findFluidSource` 的回执。 */
export function fluidSourceReport(bot: any, kind: FluidKind | 'any' = 'water', radius = 32): string {
    const scan = scanFluidSources(bot, kind, radius);
    const labels = kind === 'any' ? '水/岩浆' : FLUID_LABEL[kind];
    if (scan.source != null) {
        const s = scan.source;
        return `半径 ${scan.radius} 格内找到${FLUID_LABEL[s.kind]}源头 (${s.x},${s.y},${s.z})，距 ${s.distance} 格（level 0，能装桶）。`;
    }
    if (scan.flowing != null) {
        const f = scan.flowing;
        const kindName = f.kind === 'water' ? '水' : '岩浆';
        return `半径 ${scan.radius} 格内**没有${labels}源头，只有流动${kindName}**（最近流动${kindName}在 (${f.x},${f.y},${f.z})，距 ${f.distance} 格）。流动的装不进桶——去更远找源头，或找瀑布/岩浆瀑布最上面那一格。`;
    }
    return `半径 ${scan.radius} 格内没找到${labels}（连流动的都没有）。换个方向或扩大 radius 再 findFluidSource。`;
}

/** 找源方块旁边能站的格子（脚/头可通行、脚下实心）。 */
export function findStandNearFluid(bot: any, x: number, y: number, z: number): { x: number; y: number; z: number } | null {
    if (typeof bot?.blockAt !== 'function') return null;
    const offsets: Array<[number, number, number]> = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
    ];
    const passable = (name: unknown): boolean => name === 'air' || name === 'cave_air' || name === 'void_air';
    const solid = (name: unknown): boolean => typeof name === 'string' && name !== 'air' && name !== 'cave_air' && name !== 'void_air' && fluidKindOf(name) == null;
    for (const [dx, dy, dz] of offsets) {
        try {
            const feet = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
            const head = bot.blockAt(new Vec3(x + dx, y + dy + 1, z + dz));
            const below = bot.blockAt(new Vec3(x + dx, y + dy - 1, z + dz));
            if (!passable(feet?.name) || !passable(head?.name)) continue;
            if (!solid(below?.name)) continue;
            return { x: x + dx, y: y + dy, z: z + dz };
        } catch { continue; }
    }
    return null;
}

function countItemSafe(bot: any, name: string): number {
    try {
        const counts = world.getInventoryCounts(bot) ?? {};
        const n = Number(counts[name] ?? 0);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch { return 0; }
}

export interface FillBucketDeps {
    goTo?: (bot: any, x: number, y: number, z: number, closeness: number) => Promise<boolean>;
    useOnBlock?: (bot: any, tool: string, block: any) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

/**
 * 走到最近的**源**方块旁边把空桶装满。只认 level 0；只有流动水时明确回报
 * "没有源头，只有流动水"，让模型去更远找。
 */
export async function fillBucketFromSourceSkill(
    bot: any,
    kind: FluidKind | 'any' = 'water',
    radius = 32,
    deps: FillBucketDeps = {},
): Promise<string> {
    const actualKind: FluidKind = kind === 'lava' ? 'lava' : 'water';
    const goTo = deps.goTo ?? ((b: any, x: number, y: number, z: number, c: number) => skills.goToPosition(b, x, y, z, c));
    const useOnBlock = deps.useOnBlock ?? ((b: any, tool: string, block: any) => skills.useToolOnBlock(b, tool, block));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = deps.now ?? Date.now;
    const filledItem = actualKind === 'water' ? 'water_bucket' : 'lava_bucket';
    const kindName = actualKind === 'water' ? '水' : '岩浆';

    const emptyBuckets = countItemSafe(bot, 'bucket');
    if (emptyBuckets <= 0) {
        const already = countItemSafe(bot, filledItem);
        return logLine(
            bot,
            already > 0
                ? `没有空桶（只有 ${filledItem}×${already}）。先把 ${filledItem} 倒掉，或 craft 一个新桶（3 个铁锭）。`
                : `背包里没有空桶——先 craft 一个桶（3 个铁锭）再来装${kindName}。`,
        );
    }

    const scan = scanFluidSources(bot, actualKind, radius);
    if (scan.source == null) {
        if (scan.flowing != null) {
            const f = scan.flowing;
            return logLine(
                bot,
                `半径 ${scan.radius} 格内**没有${FLUID_LABEL[actualKind]}源头，只有流动${kindName}**（最近流动${kindName}在 (${f.x},${f.y},${f.z})，距 ${f.distance} 格）。` +
                    `流动${kindName}装不进桶——去更远找源头，或找瀑布/岩浆瀑布最上面那一格（源头 level 0）。`,
            );
        }
        return logLine(bot, `半径 ${scan.radius} 格内没找到${kindName}（连流动的都没有）。换方向或扩大 radius 再试。`);
    }

    const src = scan.source;
    const here = bot?.entity?.position;
    const startDist = Math.hypot(src.x + 0.5 - (here?.x ?? 0), src.y + 0.5 - (here?.y ?? 0), src.z + 0.5 - (here?.z ?? 0));
    if (startDist > 4.5) {
        const stand = findStandNearFluid(bot, src.x, src.y, src.z);
        let reached = false;
        if (stand != null) {
            try { reached = await goTo(bot, stand.x, stand.y, stand.z, 1); } catch { reached = false; }
        }
        if (!reached) {
            try { reached = await goTo(bot, src.x, src.y, src.z, 3); } catch { reached = false; }
        }
        if (!reached) {
            return logLine(bot, `找到了${FLUID_LABEL[actualKind]}源头 (${src.x},${src.y},${src.z})，但走不过去（寻路失败）。可以先 goToCoordinates 靠近，再 fillBucketFromSource。`);
        }
    }

    let block: any;
    try { block = bot.blockAt(new Vec3(src.x, src.y, src.z)); } catch { block = null; }
    if (block == null) return logLine(bot, `源头 (${src.x},${src.y},${src.z}) 读不到（区块可能没加载），稍后再试。`);
    if (!isFluidSourceBlock(block, actualKind)) {
        return logLine(bot, `(${src.x},${src.y},${src.z}) 现在不是${FLUID_LABEL[actualKind]}源头了（可能变成流动或被挡住），重新 findFluidSource 找一个。`);
    }
    const dist = here == null ? null : Math.hypot(src.x + 0.5 - here.x, src.y + 0.5 - here.y, src.z + 0.5 - here.z);
    if (dist != null && dist > 4.5) {
        return logLine(bot, `够不到${FLUID_LABEL[actualKind]}源头 (${src.x},${src.y},${src.z})：现在距 ${dist.toFixed(1)} 格（交互最多 4.5）。先 goToCoordinates 靠近再装。`);
    }

    const before = countItemSafe(bot, filledItem);
    let actionOk: boolean;
    try { actionOk = await useOnBlock(bot, 'bucket', block); } catch { actionOk = false; }
    if (!actionOk) {
        return logLine(bot, `在 (${src.x},${src.y},${src.z}) 装${kindName}失败：可能准星没对准、岸边够不着，或这一格其实不是源。源头还在，调整站位再试。`);
    }
    const deadline = now() + 2500;
    let after = countItemSafe(bot, filledItem);
    while (after <= before && now() < deadline) {
        if (bot?.interrupt_code === true) break;
        await sleep(150);
        after = countItemSafe(bot, filledItem);
    }
    if (after > before) {
        return logLine(bot, `已装满：从${FLUID_LABEL[actualKind]}源头 (${src.x},${src.y},${src.z})（距 ${dist == null ? '未知' : dist.toFixed(1)} 格）取${kindName}，` +
            `${filledItem} ${before} → ${after}，空桶还剩 ${countItemSafe(bot, 'bucket')} 个。`);
    }
    return logLine(bot, `装填动作执行了，但背包里没出现 ${filledItem}（before ${before} → after ${countItemSafe(bot, filledItem)}）。先 stats 核对，可能是同步延迟；确认没装到就换个站位重试。`);
}
