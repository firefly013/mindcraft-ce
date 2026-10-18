/*
 * 通用投掷原语（用户要求：「做一个通用的投掷工具，比如鸡蛋、末影之眼这些东西都可以扔。
 * 它们的轨迹好像不太一样：有的走直线，有的直接飞过去。总而言之，得看着适配。」）
 *
 * 为什么不是"一个 activateItem 打天下"——**轨迹分三类**：
 *
 *   1. **抛物线类**（egg / snowball / ender_pearl / splash_potion / lingering_potion /
 *      experience_bottle）：初速 ~1.5 格/刻、重力 ~0.03 格/刻²、阻力 0.99。
 *      平着瞄一定打低（10 格外就掉一截），**必须先解抛物线再把枪口抬起来**。
 *   2. **箭矢类**（arrow，用弓）：速度随蓄力变、重力更大；而且要
 *      `activateItem`（开始拉弓）→ 等 → `deactivateItem`（放箭）两步。
 *      老代码 `endgame_routine.shootAtEntity` 里有 `TODO(真机)`：这套时序从没被真机验证过。
 *      本文件把它连同"箭数核对"一起做成可测的：**箭数没少就不算射出去**。
 *   3. **制导类**（eye_of_ender）：**根本不走抛物线**——它朝要塞飞，然后掉落或碎掉。
 *      所以这一类**不做弹道解算**（拿抛物线公式瞄它只会得到"打不到"），
 *      而是"按朝向扔出去 + 采样轨迹推方向"，方向几何复用 `endgame.ts` 的纯函数
 *      （`trackEyeFlight` / `compassBearing` / `describeEyeDirection`，只 import 不改）。
 *
 * **表是可校准的**（用户原话"得看着适配"）：`THROW_PROFILES` 只是默认值，
 * `applyThrowCalibration()` 按真机观测改 v/g；每次投掷的回执里都带一行**可校准观测值**
 * （飞了多少刻、最后在哪、沿瞄准方向多远 vs 预测多远），下一轮就能拿真机数据修表。
 *
 * 规矩和 `consume` / `mineTunnel` 一致：**事实，不是假设**。投前记数量 → 投后重新数，
 * 数量没少就是"没扔出去"；看到投掷物实体才报实体，没看到就说没看到；方向看不清就说看不清。
 *
 * 注：`endgame_routine.ts` 的 `throwHeld` / `throwEyeAndTrack` 这轮保持原样（那个文件不碰）。
 * 它以后可以改成委托给这里的原语——它的"数量核对"就是本文件 `ensureThrown` 的特例。
 */

import Vec3 from 'vec3';
import * as skills from './skills.js';
import { describeEyeDirection, trackEyeFlight, type EyeSample } from './endgame.js';

/** 一格/刻 → 格/秒（诊断用；1 刻 = 50ms）。 */
export const TICKS_PER_SECOND = 20;

export type ThrowClass = 'parabolic' | 'arrow' | 'guided';

export interface ThrowProfile {
    /** 规范物品名（`throwProfileOf` 会先把别名归一化）。 */
    item: string;
    klass: ThrowClass;
    /** 抛物线的初速（格/刻）。制导类不参与弹道解算，可以没有。 */
    velocity?: number;
    /** 抛物线的重力（格/刻²）。 */
    gravity?: number;
    /** 空气阻力（诊断/校准用；闭式解不含阻力，靠 v 校准吸收）。 */
    drag?: number;
    /** 需要"拉弓 → 放箭"两步。 */
    charged?: boolean;
    /** 满蓄力时间（毫秒；1 秒 = 20 刻）。 */
    chargeMs?: number;
    /** 观察投掷物实体时匹配的实体名。 */
    projectile: string;
    /** 扔完要等传送。 */
    teleports?: boolean;
    /** 走追踪（不做弹道解算）。 */
    guided?: boolean;
    /** 回执里给模型看的一句要点。 */
    note: string;
}

const PARABOLIC_VELOCITY = 1.5;
const PARABOLIC_GRAVITY = 0.03;
const PARABOLIC_DRAG = 0.99;
const ARROW_VELOCITY = 3.0;
const ARROW_GRAVITY = 0.05;
const ARROW_CHARGE_MS = 1000;

function parabolic(item: string, projectile: string, note: string, extra: Partial<ThrowProfile> = {}): ThrowProfile {
    return {
        item,
        klass: 'parabolic',
        velocity: PARABOLIC_VELOCITY,
        gravity: PARABOLIC_GRAVITY,
        drag: PARABOLIC_DRAG,
        projectile,
        note,
        ...extra,
    };
}

/**
 * 默认档案表（**可校准**：改这里之前先看 `applyThrowCalibration`）。
 *
 * v/g 是原版量级：投掷物 1.5 格/刻、0.03 格/刻²、阻力 0.99；箭满蓄力约 3 格/刻、0.05。
 * 阻力没进闭式解（那会变成数值题），而是"用实测数据回头调 v"——这就是校准的落点。
 */
export const THROW_PROFILES: Readonly<Record<string, ThrowProfile>> = Object.freeze({
    egg: parabolic('egg', 'egg', '鸡蛋：抛物线，抬高瞄；碎在落点，不伤人。'),
    snowball: parabolic('snowball', 'snowball', '雪球：抛物线，抬高瞄；对烈焰人有伤害，是好武器。'),
    ender_pearl: parabolic('ender_pearl', 'ender_pearl', '末影珍珠：抛物线；**传送固定吃 5 点伤害**，血少先别扔。', {
        teleports: true,
    }),
    splash_potion: parabolic('splash_potion', 'splash_potion', '喷溅药水：抛物线；落地才生效，抬高瞄能让它落在目标脚边。'),
    lingering_potion: parabolic('lingering_potion', 'lingering_potion', '滞留药水：抛物线；落地留云，别扔在自己脚下。'),
    experience_bottle: parabolic('experience_bottle', 'experience_bottle', '经验瓶：抛物线，抬高瞄；碎了给经验。'),
    arrow: {
        item: 'arrow',
        klass: 'arrow',
        velocity: ARROW_VELOCITY,
        gravity: ARROW_GRAVITY,
        drag: PARABOLIC_DRAG,
        charged: true,
        chargeMs: ARROW_CHARGE_MS,
        projectile: 'arrow',
        note: '箭：要弓，**满蓄力 1000ms** 才射得远（拉不满会软绵绵掉在脚下）。',
    },
    eye_of_ender: {
        item: 'eye_of_ender',
        klass: 'guided',
        projectile: 'eye_of_ender',
        guided: true,
        note: '末影之眼：**制导类，不做弹道解算**——它朝要塞飞；扔出去后看它往哪飞（8 方位），别看落点。',
    },
});

/** 别名 → 规范名（两代物品名 + 常用俗称）。 */
const THROW_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    ender_eye: 'eye_of_ender',
    eye: 'eye_of_ender',
    xp_bottle: 'experience_bottle',
    bottle_o_enchanting: 'experience_bottle',
    snow_ball: 'snowball',
    pearl: 'ender_pearl',
    splash: 'splash_potion',
    lingering: 'lingering_potion',
    tipped_arrow: 'arrow',
    spectral_arrow: 'arrow',
});

export function normalizeThrowName(name: unknown): string {
    return typeof name === 'string' ? name.trim().toLowerCase().replace(/^minecraft:/, '') : '';
}

/** 当前生效的档案（含校准覆盖）。 */
const calibrations = new Map<string, Partial<ThrowProfile>>();

/** 这个物品怎么扔；不认识的物品返回 null（由调用方如实拒绝，不猜）。 */
export function throwProfileOf(name: unknown): ThrowProfile | null {
    const key = normalizeThrowName(name);
    if (key === '') return null;
    const canonical = THROW_ALIASES[key] ?? key;
    const base = THROW_PROFILES[canonical];
    if (base == null) return null;
    const patch = calibrations.get(canonical);
    return patch == null ? base : { ...base, ...patch };
}

/** 支持哪些投掷物（拒绝时点名用）。 */
export function supportedThrowables(): string[] {
    return Object.keys(THROW_PROFILES);
}

/**
 * 用真机观测校准某一项的弹道参数（v/g）。
 *
 * 用户说的"得看着适配"就落在这里：回执里给了"飞了多少刻、落在哪、比对预测差多少"，
 * 拿这些数据回头调 v（阻力、服务端差异都会被吸收进这个数）。不传的字段不动。
 */
export function applyThrowCalibration(item: unknown, patch: { velocity?: number; gravity?: number }): ThrowProfile | null {
    const key = normalizeThrowName(item);
    const canonical = THROW_ALIASES[key] ?? key;
    const base = THROW_PROFILES[canonical];
    if (base == null) return null;
    const mergedPatch: Partial<ThrowProfile> = { ...calibrations.get(canonical) };
    if (typeof patch.velocity === 'number' && Number.isFinite(patch.velocity) && patch.velocity > 0) {
        mergedPatch.velocity = patch.velocity;
    }
    if (typeof patch.gravity === 'number' && Number.isFinite(patch.gravity) && patch.gravity > 0) {
        mergedPatch.gravity = patch.gravity;
    }
    calibrations.set(canonical, mergedPatch);
    return throwProfileOf(canonical);
}

/** 清掉全部校准（测试与"回到默认"用）。 */
export function resetThrowCalibrations(): void {
    calibrations.clear();
}

// ─────────────────────────────── 瞄准（纯函数） ───────────────────────────────

export interface FlatPosition {
    x: number;
    y: number;
    z: number;
}

/**
 * 闭式**低伸弹道**俯仰角（返回 mineflayer 的 `pitch`：**抬头为负**）。
 *
 *   tanθ = (v² − √(v⁴ − g(g·x² + 2·y·v²))) / (g·x)
 *
 * x = 水平距离、y = 高差（目标更高为正）、v = 初速、g = 重力。
 * 判别式 < 0 → 这个距离打不到（返回 null，由调用方如实说"打不到"，不许硬扔）。
 * 取减号 = 低伸解（平射）；加号是高抛解，命中间隔太久、容易被挡，不用。
 *
 * 不含阻力：原版阻力 0.99/刻会让实际射程略短，所以表里的 v 是**可校准**的，
 * 回执也会把 v/g 写出来，方便用实测数据改。
 */
export function solveBallisticPitch(x: number, y: number, v: number, g: number): number | null {
    if (![x, y, v, g].every((n) => Number.isFinite(n))) return null;
    if (v <= 0 || g <= 0) return null;
    if (x <= 0) {
        // 垂直上下：目标在正上方就抬头 90°，正下方就低头（这种扔法没意义，如实返回）。
        if (Math.abs(y) < 1e-9) return 0;
        return y > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    const v2 = v * v;
    const discriminant = v2 * v2 - g * (g * x * x + 2 * y * v2);
    if (discriminant < 0) return null;
    const tanTheta = (v2 - Math.sqrt(discriminant)) / (g * x);
    return -Math.atan(tanTheta);
}

/** 水平朝向角（mineflayer 的 yaw：0 = 南(+z)，90° = 西(-x)）。 */
export function yawTo(from: FlatPosition, to: FlatPosition): number {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    return Math.atan2(-dx, dz);
}

/** 同一俯仰角下的**平射射程**（真空解；用来和实测比对，差多少就是校准数据）。 */
export function predictedRange(pitch: number, v: number, g: number): number | null {
    if (![pitch, v, g].every((n) => Number.isFinite(n)) || g <= 0) return null;
    return (v * v * Math.sin(-2 * pitch)) / g;
}

export type AimPlan =
    | {
          kind: 'ballistic';
          yaw: number;
          pitch: number;
          velocity: number;
          gravity: number;
          distance: number;
          heightDiff: number;
          predictedRange: number | null;
      }
    | { kind: 'guided'; yaw: number; pitch: number; note: string }
    | { kind: 'unreachable'; distance: number; heightDiff: number; velocity: number; gravity: number; maxRange: number };

/**
 * 给一次投掷定朝向。
 *
 * - 抛物线类：有目标就解闭式弹道（低伸），没目标就按当前朝向平扔（回执会提醒"没抬高"）；
 * - 制导类（末影之眼）：**永远不做弹道解算**——有目标就朝目标的水平方向，没目标就按当前朝向，俯仰 0。
 */
export function planThrowAim(
    profile: ThrowProfile,
    from: FlatPosition,
    currentYaw: number,
    target: FlatPosition | null,
): AimPlan {
    if (profile.guided === true) {
        return {
            kind: 'guided',
            yaw: target == null ? currentYaw : yawTo(from, target),
            pitch: 0,
            note: target == null ? '按当前朝向' : '朝目标的水平方向',
        };
    }
    const velocity = profile.velocity ?? PARABOLIC_VELOCITY;
    const gravity = profile.gravity ?? PARABOLIC_GRAVITY;
    if (target == null) {
        return {
            kind: 'ballistic',
            yaw: currentYaw,
            pitch: 0,
            velocity,
            gravity,
            distance: 0,
            heightDiff: 0,
            predictedRange: null,
        };
    }
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dz);
    const pitch = solveBallisticPitch(distance, dy, velocity, gravity);
    if (pitch == null) {
        return {
            kind: 'unreachable',
            distance,
            heightDiff: dy,
            velocity,
            gravity,
            maxRange: (velocity * velocity) / gravity,
        };
    }
    return {
        kind: 'ballistic',
        yaw: yawTo(from, target),
        pitch,
        velocity,
        gravity,
        distance,
        heightDiff: dy,
        predictedRange: predictedRange(pitch, velocity, gravity),
    };
}

// ─────────────────────────── 投掷（事实核验） ───────────────────────────

export interface ThrowDeps {
    position?: (bot: any) => FlatPosition;
    yaw?: (bot: any) => number | null;
    /** 背包里某个物品的数量；读不到 null。 */
    countOf?: (bot: any, item: string) => number | null;
    /** 背包里有没有这个物品（用来区分"没有"和"读不到"）。 */
    hasItem?: (bot: any, item: string) => boolean;
    /** 装备；返回是否成功。 */
    equip?: (bot: any, item: string) => Promise<boolean>;
    look?: (bot: any, yaw: number, pitch: number) => Promise<void>;
    activate?: (bot: any) => Promise<void>;
    deactivate?: (bot: any) => Promise<void>;
    /** 实体表（观察投掷物）。 */
    entities?: (bot: any) => Record<string, any>;
    health?: (bot: any) => number | null;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface ThrowOptions {
    /** 观察投掷物实体的最长时间。 */
    observeMs?: number;
    /** 轮询间隔。 */
    pollMs?: number;
    /** 末影珍珠等传送的时间。 */
    teleportWaitMs?: number;
    /** 拉弓蓄力时长（箭）。 */
    chargeMs?: number;
}

export interface ProjectileSighting {
    id: number | null;
    name: string;
    samples: number;
    /** 第一次/最后一次看到它的时刻（相对投掷时刻，毫秒）。 */
    firstSeenMs: number;
    lastSeenMs: number;
    lastPosition: FlatPosition | null;
    /** true = 在我们停止观察之前它就消失了（落地/碎裂/传送）。 */
    vanished: boolean;
}

export interface ThrowOutcome {
    item: string;
    profile: ThrowClass;
    /** 手上/背包数量：投前 → 投后。 */
    countBefore: number | null;
    countAfter: number | null;
    /** 真的扔出去了（数量确实少了）。 */
    thrown: boolean;
    aim: AimPlan | null;
    /** 观测到的投掷物。 */
    sighting: ProjectileSighting | null;
    /** 末影珍珠：传送结果。 */
    teleport: { moved: boolean; to: FlatPosition | null; drop: number | null } | null;
    /** 末影之眼：追踪到的方向（人话）。 */
    guidance: string | null;
    interrupted: boolean;
    /** 观测到的飞行时长（毫秒，估算）。 */
    flightMs: number | null;
    /** 沿瞄准方向飞了多远（有落点时）。 */
    flownBlocks: number | null;
    notes: string[];
}

function defaultPosition(bot: any): FlatPosition {
    const p = bot?.entity?.position;
    return { x: Number(p?.x ?? 0), y: Number(p?.y ?? 0), z: Number(p?.z ?? 0) };
}

function samePoint(a: FlatPosition, b: FlatPosition): boolean {
    return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9;
}

/** 投掷物实体快照（按实体名匹配档案）。 */
function snapshotProjectiles(entities: Record<string, any>, wanted: string): Map<number, any> {
    const out = new Map<number, any>();
    for (const raw of Object.values(entities ?? {})) {
        const entity = raw as { id?: unknown; name?: unknown; position?: any };
        if (typeof entity?.id !== 'number') continue;
        if (normalizeThrowName(entity?.name) !== wanted) continue;
        out.set(entity.id, entity);
    }
    return out;
}

/**
 * 投掷：瞄准 → 扔 → **用数量核对**"到底扔没扔" → 观察投掷物 → 分类收尾。
 *
 * 返回的是**回执字符串**（和 exploreFor/mineTunnel 一样，直接进 `bot.output`）。
 */
export async function throwItemSkill(
    bot: any,
    rawItem: unknown,
    rawTargetX?: unknown,
    rawTargetY?: unknown,
    rawTargetZ?: unknown,
    deps: ThrowDeps = {},
    options: ThrowOptions = {},
): Promise<string> {
    const position = deps.position ?? defaultPosition;
    const yawOf = deps.yaw ?? ((b: any) => (Number.isFinite(Number(b?.entity?.yaw)) ? Number(b.entity.yaw) : 0));
    const countOf = deps.countOf ?? ((b: any, item: string) => skills.inventoryCountOf(b, item));
    const hasItem = deps.hasItem ?? ((b: any, item: string) => {
        try {
            return b?.inventory?.findInventoryItem?.(item) != null;
        } catch {
            return false;
        }
    });
    const equip = deps.equip ?? ((b: any, item: string) => skills.equip(b, item));
    const look = deps.look ?? ((b: any, yaw: number, pitch: number) => b.look(yaw, pitch, true));
    const activate = deps.activate ?? ((b: any) => b.activateItem());
    const deactivate = deps.deactivate ?? ((b: any) => b.deactivateItem());
    const entitiesOf = deps.entities ?? ((b: any) => (b?.entities ?? {}) as Record<string, any>);
    const healthOf = deps.health ?? ((b: any) => (Number.isFinite(Number(b?.health)) ? Number(b.health) : null));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = deps.now ?? Date.now;

    const observeMs = options.observeMs ?? 2500;
    const pollMs = options.pollMs ?? 100;
    const teleportWaitMs = options.teleportWaitMs ?? 2000;

    const item = normalizeThrowName(rawItem);
    const profile = throwProfileOf(item);
    const notes: string[] = [];
    const health = healthOf(bot);
    const launch = position(bot);

    const lines: string[] = [];
    const finish = (text: string): string => {
        lines.push(text);
        return lines.join('\n');
    };

    // ── 认不出的物品：如实拒绝并点名支持哪些（不猜） ──
    if (profile == null) {
        const throwables = inventoryThrowables(bot, countOf, hasItem);
        return finish(
            `throwItem：不认识 "${item || '(没给物品名)'}"，不敢瞎扔。支持：${supportedThrowables().join(' / ')}。` +
                (throwables.length > 0 ? `背包里能扔的有：${throwables.join('、')}。` : '背包里没有可扔的东西。') +
                `\n下一步（照做即可）：stats(type="inventory")`,
        );
    }

    // ── 箭矢类：要弓，核对的是**箭**；其余：核对物品本身 ──
    const ammoItem = profile.klass === 'arrow' ? 'arrow' : profile.item;
    const held = profile.klass === 'arrow' ? bestBowInInventory(bot) : profile.item;
    const countBefore = countOf(bot, ammoItem);
    const present = hasItem(bot, ammoItem) || (countBefore ?? 0) > 0;

    if (!present) {
        const others = inventoryThrowables(bot, countOf, hasItem);
        return finish(
            `throwItem：背包里没有 ${ammoItem}（手上/背包都数不到），投不了。` +
                (others.length > 0 ? `能扔的还有：${others.join('、')}。` : '没有任何可扔的东西：先去做（雪球=雪块×4、箭=燧石+木棍+羽毛）。') +
                `\n下一步（照做即可）：stats(type="inventory")`,
        );
    }
    if (profile.klass === 'arrow' && held == null) {
        return finish(
            `throwItem：有箭但没有弓/弩，射不出去。**先做一把弓**（3 木棍 + 3 线），或换别的投掷物。` +
                `\n下一步（照做即可）：stats(type="inventory")`,
        );
    }

    // ── 瞄准（抛物线解算 / 制导直扔） ──
    const targetRaw = [rawTargetX, rawTargetY, rawTargetZ];
    const given = targetRaw.filter((value) => value != null && value !== '');
    let target: FlatPosition | null = null;
    if (given.length !== 0 && given.length !== 3) {
        return finish(
            `throwItem：目标坐标要么全给（target_x/target_y/target_z），要么都不给；现在给了 ${given.length} 个。` +
                `\n下一步（照做即可）：stats(type="body")`,
        );
    }
    if (given.length === 3) {
        const [x, y, z] = targetRaw.map((value) => Number(value));
        if (![x, y, z].every((n) => Number.isFinite(n))) {
            return finish(`throwItem：目标坐标读不出数字，不扔。\n下一步（照做即可）：stats(type="body")`);
        }
        target = { x, y, z };
    }

    const currentYaw = yawOf(bot) ?? 0;
    const aim = planThrowAim(profile, launch, currentYaw, target);
    if (aim.kind === 'unreachable') {
        const closer = closerPoint(launch, target, aim.maxRange);
        return finish(
            `throwItem ${profile.item}：**这个距离打不到**——水平 ${aim.distance.toFixed(1)} 格、高差 ${aim.heightDiff.toFixed(1)} 格，` +
                `按 v=${aim.velocity} 格/刻、g=${aim.gravity} 格/刻² 的最大平射射程只有 ${aim.maxRange.toFixed(1)} 格。` +
                `**没有扔**（扔出去只会掉在半路）。走近一点再扔，或者改用别的办法。` +
                `\n下一步（照做即可）：goToCoordinates(x=${closer.x}, y=${closer.y}, z=${closer.z}, closeness=2)`,
        );
    }
    const pitchDeg = (-aim.pitch * 180) / Math.PI;
    if (aim.kind === 'ballistic') {
        lines.push(
            `throwItem ${profile.item}：瞄准 → 水平 ${aim.distance.toFixed(1)} 格、高差 ${aim.heightDiff >= 0 ? '+' : ''}${aim.heightDiff.toFixed(1)} 格；` +
                `弹道解算（低伸）**抬头 ${pitchDeg.toFixed(1)}°**（v=${aim.velocity} 格/刻、g=${aim.gravity} 格/刻²，未计阻力）。` +
                (target == null ? '（没给目标：按当前朝向平扔，没抬高——目标远就别指望命中。）' : ''),
        );
        if (target != null && aim.predictedRange != null) {
            notes.push(`预测平射射程 ${aim.predictedRange.toFixed(1)} 格（实测差多少就用来校准 v）。`);
        }
    } else {
        lines.push(
            `throwItem ${profile.item}：**制导类，不做弹道解算**——${aim.note}扔出去（俯仰 0°），然后看它往哪飞。`,
        );
    }

    // ── 装备 + 投（先记实体表，扔完才知道哪个是新的） ──
    const equipped = held == null ? false : await equip(bot, held);
    if (!equipped) {
        return finish(
            `throwItem：${held ?? profile.item} 没拿到手上，投不了（装备失败）。` +
                `\n下一步（照做即可）：stats(type="inventory")`,
        );
    }
    const beforeEntities = snapshotProjectiles(entitiesOf(bot), profile.projectile);
    const launchedAt = now();
    const healthBefore = health;
    let throwError: string | null = null;
    try {
        await look(bot, aim.yaw, aim.pitch);
        await activate(bot);
        if (profile.charged === true) {
            const chargeMs = options.chargeMs ?? profile.chargeMs ?? ARROW_CHARGE_MS;
            await sleep(chargeMs);
            await deactivate(bot);
        }
    } catch (err) {
        throwError = err instanceof Error ? err.message : String(err);
    }

    // ── 核对：数量没少就是没扔出去（事实，不是假设） ──
    await sleep(300);
    const countAfter = countOf(bot, ammoItem);
    const thrown = countBefore != null && countAfter != null && countAfter < countBefore;
    if (!thrown) {
        const why = throwError == null ? '' : `（调用报错：${throwError}）`;
        return finish(
            `throwItem ${profile.item}：**没扔出去**——${ammoItem} 数量没变（${countBefore ?? '读不到'} → ${countAfter ?? '读不到'}）${why}。` +
                (profile.klass === 'arrow'
                    ? '拉弓→放箭的时序可能没被服务端采纳（这条路径以前从没真机验证过）：先确认弓在手上、箭在背包。'
                    : '服务端可能没采纳这次"使用物品"（或被挡/被打断）。别当作扔成功了。') +
                `\n下一步（照做即可）：stats(type="inventory")`,
        );
    }
    lines.push(`投出：${ammoItem} ${countBefore} → ${countAfter}（数量确实少了 = 真的扔出去了）。`);

    // ── 观察投掷物实体（"看着适配"的数据来源）──
    // **一次采样两用**：普通类只要"命运"（飞多久/在哪消失），制导类还要用同一批采样推方向。
    // （早先分两趟采样是错的：第一趟就把眼睛的飞行窗口耗光了，第二趟什么也看不到。）
    const observed = await observeProjectile(bot, profile, beforeEntities, launchedAt, {
        entities: entitiesOf,
        sleep,
        now,
        observeMs,
        pollMs,
    });
    const sighting = observed.sighting;
    const flightMs = sighting == null ? null : Math.max(0, sighting.lastSeenMs - sighting.firstSeenMs);
    const flownBlocks =
        sighting?.lastPosition == null ? null : Math.hypot(sighting.lastPosition.x - launch.x, sighting.lastPosition.z - launch.z);

    if (sighting == null) {
        lines.push(
            `观测：**没看到 ${profile.projectile} 实体**（可能是太快消失/没加载/服务端没广播）。` +
                `数量确实少了，所以是扔出去了，但这一趟拿不到落点数据。`,
        );
    } else {
        const fate = sighting.vanished ? '已消失（落地/碎裂/传送）' : `观察时间到（${observeMs}ms）时还在飞`;
        const where = sighting.lastPosition == null
            ? '位置读不到'
            : `最后看到它在 (${fmt(sighting.lastPosition.x)}, ${fmt(sighting.lastPosition.y)}, ${fmt(sighting.lastPosition.z)})`;
        lines.push(
            `观测：${profile.projectile} 实体现身（id=${sighting.id ?? '?'}），飞了约 ${Math.round((flightMs ?? 0) / 50)} 刻` +
                `（${((flightMs ?? 0) / 1000).toFixed(1)} 秒，${sighting.samples} 次采样），${fate}；${where}` +
                (flownBlocks == null ? '' : `，沿地面飞了约 ${flownBlocks.toFixed(1)} 格`) +
                `。`,
        );
        // **可校准观测值**（用户说的"得看着适配"）：预测射程 vs 实测距离/刻数。
        // 只在两边都有意义时给，并写明前提（观察窗口可能截断），免得拿半截数据去调表。
        if (aim.kind === 'ballistic' && aim.predictedRange != null && flownBlocks != null && target != null) {
            lines.push(
                `校准用：同角度（抬头 ${pitchDeg.toFixed(1)}°）的真空预测平射射程 ${aim.predictedRange.toFixed(1)} 格，` +
                    `这次实测最后看到在 ${flownBlocks.toFixed(1)} 格处。**如果实体是飞完才消失的**，这两个数的差就是该调的量` +
                    `（当前 v=${aim.velocity} 格/刻、g=${aim.gravity} 格/刻²）；调完下次瞄准会自动用新值。`,
            );
        }
    }

    // ── 分类收尾 ──
    let teleport: ThrowOutcome['teleport'] = null;
    if (profile.teleports === true) {
        teleport = await waitForTeleport(bot, launch, { position, sleep, now, teleportWaitMs, pollMs });
        if (teleport.moved && teleport.to != null) {
            const drop = launch.y - teleport.to.y;
            lines.push(
                `传送：坐标跳到 (${fmt(teleport.to.x)}, ${fmt(teleport.to.y)}, ${fmt(teleport.to.z)})，` +
                    `相对出发点${drop >= 0 ? `低 ${drop.toFixed(1)} 格` : `高 ${Math.abs(drop).toFixed(1)} 格`}。` +
                    `⚠️ 末影珍珠传送**固定吃 5 点伤害**（2.5 颗心）${healthBefore == null ? '' : `，扔之前血量 ${healthBefore}`}——` +
                    `伤后别立刻再扔第二颗。` +
                    (drop > 3 ? `**落点在下方，注意落地/岩浆。**` : ''),
            );
        } else {
            lines.push(
                `传送：**珠子扔出去了但没传送**（等了 ${teleportWaitMs}ms，人还在 (${fmt(launch.x)}, ${fmt(launch.y)}, ${fmt(launch.z)})）。` +
                    `可能落在水里/被方块挡住/珍珠没了——别当成"传过去了"。`,
            );
        }
    }
    let guidance: string | null = null;
    if (profile.guided === true) {
        guidance = describeGuidance(observed.samples);
        lines.push(guidance);
    }

    lines.push(`下一步（照做即可）：${throwNextAction(profile, teleport)}`);

    const outcome: ThrowOutcome = {
        item: item,
        profile: profile.klass,
        countBefore,
        countAfter,
        thrown,
        aim,
        sighting,
        teleport,
        guidance,
        interrupted: bot?.interrupt_code === true,
        flightMs,
        flownBlocks,
        notes,
    };
    void outcome; // 结构体给未来复用（校准管线），当前回执直接由上面的行拼成
    return lines.join('\n');
}

/** 把校准观测写进回执的一句（诊断用；目前并入"观测"行）。 */
function fmt(value: number): string {
    return (Math.round(value * 10) / 10).toString();
}

function closerPoint(from: FlatPosition, target: FlatPosition | null, maxRange: number): FlatPosition {
    if (target == null) return { x: Math.round(from.x), y: Math.round(from.y), z: Math.round(from.z) };
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dz) || 1;
    const want = Math.max(1, maxRange * 0.7);
    const ratio = Math.min(1, want / distance);
    return {
        x: Math.round(from.x + dx * ratio),
        y: Math.round(from.y),
        z: Math.round(from.z + dz * ratio),
    };
}

function throwNextAction(profile: ThrowProfile, teleport: ThrowOutcome['teleport']): string {
    if (profile.teleports === true) return 'stats(type="body")';
    if (profile.guided === true) return 'stats(type="body")';
    void teleport;
    return 'stats(type="inventory")';
}

/** 背包里能扔的东西（拒绝/推荐时点名）。 */
function inventoryThrowables(
    bot: any,
    countOf: (bot: any, item: string) => number | null,
    hasItem: (bot: any, item: string) => boolean,
): string[] {
    const out: string[] = [];
    for (const name of supportedThrowables()) {
        const count = countOf(bot, name);
        if ((count ?? 0) > 0 || hasItem(bot, name)) {
            out.push(count == null ? name : `${name}x${count}`);
        }
    }
    return out;
}

/** 背包里最好的弓/弩。 */
export function bestBowInInventory(bot: any): string | null {
    let items: Array<{ name?: unknown; count?: unknown }>;
    try {
        items = (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>;
    } catch {
        return null;
    }
    if (!Array.isArray(items)) return null;
    const rank = ['crossbow', 'bow'];
    const candidates = items
        .filter((item) => typeof item?.name === 'string' && (item.name.includes('bow')))
        .filter((item) => (typeof item.count === 'number' ? item.count : 0) > 0)
        .map((item) => String(item.name));
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => {
        const ra = rank.findIndex((suffix) => a.includes(suffix));
        const rb = rank.findIndex((suffix) => b.includes(suffix));
        return (ra < 0 ? rank.length : ra) - (rb < 0 ? rank.length : rb);
    })[0] as string;
}

interface ObserveDeps {
    entities: (bot: any) => Record<string, any>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    observeMs: number;
    pollMs: number;
}

/**
 * 盯着"新出现的那个投掷物"看：位置采样、飞了多久、什么时候消失。
 *
 * 返回**采样点**有两个用途：普通类只要 `sighting`（命运 + 落点），制导类（末影之眼）
 * 还要用同一批采样去推方向——所以这一趟必须同时把两样都收下来。
 */
async function observeProjectile(
    bot: any,
    profile: ThrowProfile,
    before: Map<number, any>,
    launchedAt: number,
    deps: ObserveDeps,
): Promise<{ sighting: ProjectileSighting | null; samples: EyeSample[] }> {
    const deadline = deps.now() + deps.observeMs;
    let id: number | null = null;
    const samples: EyeSample[] = [];
    const sighting: ProjectileSighting = {
        id: null,
        name: profile.projectile,
        samples: 0,
        firstSeenMs: 0,
        lastSeenMs: 0,
        lastPosition: null,
        vanished: false,
    };
    let seen = false;
    while (deps.now() < deadline) {
        if (bot?.interrupt_code === true) break;
        const now = deps.now();
        const current = snapshotProjectiles(deps.entities(bot), profile.projectile);
        const target: any = id == null ? pickNewProjectile(current, before) : (current.get(id) ?? null);
        if (target != null) {
            const entityId: number | null = typeof target.id === 'number' ? target.id : null;
            if (entityId != null) id = entityId;
            sighting.id = id;
            sighting.samples += 1;
            if (!seen) {
                seen = true;
                sighting.firstSeenMs = now - launchedAt;
            }
            sighting.lastSeenMs = now - launchedAt;
            const p = target.position;
            if (p != null) {
                const point = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
                sighting.lastPosition = point;
                samples.push({ position: new Vec3(point.x, point.y, point.z), atMs: now });
            }
        } else if (seen) {
            sighting.vanished = true;
            break;
        }
        await deps.sleep(deps.pollMs);
    }
    return { sighting: seen ? sighting : null, samples };
}

function pickNewProjectile(current: Map<number, any>, before: Map<number, any>): any | null {
    for (const [id, entity] of current) {
        if (!before.has(id)) return entity;
    }
    // 没找到"新"的：可能服务端复用了 id —— 仍返回最近的任何一个（比什么都不报强，且回执会写 id）。
    let fallback: any = null;
    for (const entity of current.values()) fallback = fallback ?? entity;
    return fallback;
}

/**
 * 末影之眼：从**同一批采样**里推方向（复用 endgame.ts 的纯函数；看不清就说看不清）。
 *
 * 制导类绝不用弹道公式：眼睛不是抛体，它朝要塞飞。所以这里只有"看到什么说什么"。
 */
export function describeGuidance(samples: readonly EyeSample[]): string {
    if (samples.length === 0) {
        return `追踪：**没看到 eye_of_ender 实体**，这趟拿不到方向（数量少了说明扔出去了；眼睛只活 1~2 秒，也可能没加载）。别猜方向。`;
    }
    const track = trackEyeFlight([...samples]);
    if (track == null) {
        return `追踪：看到了眼睛（${samples.length} 次采样）但**位移太小/太短，看不出方向**——别猜；换个开阔位置再扔一颗。`;
    }
    return `追踪：${describeEyeDirection(track)}`;
}

/** 末影珍珠：等玩家的坐标**跳变**到落点（没跳就是没传送）。 */
async function waitForTeleport(
    bot: any,
    launch: FlatPosition,
    deps: { position: (bot: any) => FlatPosition; sleep: (ms: number) => Promise<void>; now: () => number; teleportWaitMs: number; pollMs: number },
): Promise<{ moved: boolean; to: FlatPosition | null; drop: number | null }> {
    const deadline = deps.now() + deps.teleportWaitMs;
    let last = deps.position(bot);
    while (deps.now() < deadline) {
        await deps.sleep(deps.pollMs);
        const here = deps.position(bot);
        // 判据是"相对**投掷时**的位置跳了 ≥4 格"：传送可能在观察窗口里就发生了，
        // 所以不能拿"上一轮轮询的位置"当基准（那会把已经发生的传送当成没动）。
        const fromLaunch = Math.hypot(here.x - launch.x, here.y - launch.y, here.z - launch.z);
        const jump = Math.hypot(here.x - last.x, here.y - last.y, here.z - last.z);
        if (fromLaunch >= 4 || jump >= 4) {
            return { moved: true, to: here, drop: launch.y - here.y };
        }
        last = here;
    }
    return { moved: false, to: null, drop: null };
}
