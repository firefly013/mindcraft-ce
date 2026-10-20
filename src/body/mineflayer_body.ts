/**
 * 身体：Mineflayer 实现。
 *
 * 它拥有真实的身体——Mineflayer 连接、动作实现（`skills.ts`）、相机、寻路、
 * 保命反射、以及**所有需要毫秒级反应的东西**。它**不**拥有模型、提示词、
 * 计划、记忆文档——那些在大脑里。
 *
 * 这个类同时扮演两个角色，是有意的：
 *
 * 1. **命令实现的宿主**。`executeToolCall(agent, name, args)` 的 `agent` 就是它。
 *    命令实现真正用到的东西只有 7 个（`agent.bot` / `actions` /
 *    `vision_interpreter` / `sampleContext()` / `liveStateText()` /
 *    `cleanKill()` / `memory_bank`），这里全部提供——**所以 `skills.ts`
 *    和 `commands/*.ts` 一行都不用改**。这是把 506 处 `bot.*` 收进契约里
 *    最省的做法：不动它们，只是让它们跑在另一个进程里。
 *
 * 2. **协议的一侧**。`handle()` 是 `BodyServer` 的处理函数。
 *
 * 界线（改动前先读）：
 * - **观察到的 → 推给大脑**（挨打、死亡、捡到东西、开箱……），带级别。
 * - **要求做的 → 等大脑来调**（挖、走、说……）。
 * - **保命的 → 自己动手**（溺水出水、着火、关残留界面），只在事后推一条事件。
 *   这些等不了一轮推理，属于身体的反射，不属于决策。
 *
 * 从 `agent.ts` 搬过来的方法**逐字保留**（含注释）：那边的注释记的都是真机
 * 踩出来的坑，是主线资产，不是装饰。
 */
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import type {
    BodyCapabilities,
    BodyPush,
    BrainRequest,
    BodyResponse,
} from '../shared/protocol/types.js';
import { ERR } from '../shared/protocol/types.js';
import { entityDataReady, initBot, isHostile } from './data/mcdata.js';
import { expandTagRecipes } from './data/recipe_tags.js';
import { executeToolCall } from './commands/execute.js';
import { toolDeclarations } from './commands/registry.js';
import { ActionManager } from './action_manager.js';
import { MemoryBank } from './memory_bank.js';
import { LEVEL } from '../shared/events.js';
import type { Kind, Level } from '../shared/events.js';
import { KIND } from '../shared/events.js';
import { sampleLiveState } from './live_state.js';
import { renderLiveState } from '../shared/live_state.js';
import type { SampleContext } from './live_state.js';
import { nearestThreat, runEmergency, FOOD_VALUE, shouldTriggerEmergency } from './safety/emergency.js';
import type { EmergencyIntent, EmergencyResult, ThreatEntity } from './safety/emergency.js';
import {
    closeStaleWindow,
    consume,
    forceExitWater,
    stopPvp,
} from './library/skills.js';
import { headInWater } from './safety/water_safety.js';
import { movementsFor } from './safety/movements.js';
import {
    createEdgeWatcher,
    DETECTORS,
    isHeartbeatDue,
    isStationaryAction,
    isStuck,
    resolvePriority,
    schedulerLevelFor,
    shouldEmitHurt,
    snapshotFromBot,
} from './edges.js';
import { renderEventText } from '../shared/event_stream.js';
import { pickupOverlapVerdict, shouldBypassThreatGateForPickup, summarizePickupTrace, isDiscardedDrop, isDiscardedDropById, nearestDropWithin, noteDiscardedEntity, PICKUP_GIVE_UP_ATTEMPTS, PICKUP_GIVE_UP_MS, PICKUP_RADIUS, PICKUP_SURVIVAL_SUPPRESS_MS, PICKUP_THREAT_RADIUS, PICKUP_TIMEOUT_MS, shouldGiveUpPickup } from './auto_pickup.js';
import {
    confirmedPickupGains,
    formatInventoryGains,
    nextPickupBackoffMs,
    positiveInventoryDelta,
    PICKUP_CONFIRM_DELAY_MS,
    shouldAttemptPickup,
    type InventoryCounts,
} from '../shared/auto_pickup.js';
import type { PickupTarget } from '../shared/auto_pickup.js';
import { stripBang } from '../shared/tools.js';
import { getFullState } from './library/full_state.js';
import { decodeCursor, EMPTY_CURSOR, encodeCursor, readInbox, type InboxCursor } from './inbox.js';
import { safeguards } from './safety/safeguards.js';
import { OFFENSIVE_TOOL_NAMES, combatRefusalVerdict } from './safety/reflex_override.js';
import { DEPARTURE_TOOLS, annotateReceipt, departureVerdict, isWeaponName, targetDimensionOf } from './safety/departure_guard.js';
import { permits } from './safety/permits.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { MESSAGES } from '../shared/prompts.js';
import settings from '../shared/settings.js';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import { chooseSafeFleeTarget } from './safety/flee.js';
import { planFallRecovery, readFallMedium, shouldEmitFallNotice } from './safety/fall_recovery.js';
import { isEdibleName, shouldEmitUnrecoverable, unrecoverableVerdict } from './safety/unrecoverable.js';
import type { DeadlockFacts } from './safety/deadlock.js';
import { voidWalkVerdict } from './safety/void_walk.js';

type EdgeWatcher = ReturnType<typeof createEdgeWatcher>;

/**
 * 把 `window.title` 归一化成一句人话。
 *
 * 这个字段在客户端里是**聊天组件**（对象），直接 `String()` 得到 `[object Object]`
 * ——模型的 Feedback 原文："容器标题被序列化成了 [object Object]"。它想知道的是
 * "我打开的是熔炉还是箱子"。
 *
 * 形状按可能性从高到低试：字符串（可能还是 JSON 文本）→ 组件的 `text`/`toString()`
 * → 兜底序列化。**不抛异常**：标题读不出来不该让开箱这件事跟着失败。
 */
/**
 * 从**任意形状**的聊天组件 / NBT 文本里挖出人话。
 *
 * `window.title` 这一个字段，真机上已经出现过**三种**形态（模型的 Feedback #9/#12/#19
 * 各撞见一种）：
 *
 * 1. 纯字符串 `"Furnace"`；
 * 2. 聊天组件对象（旧的 `String()` 出来是 `[object Object]`）；
 * 3. **序列化后的 NBT 复合标签**——
 *    `{"type":"compound","value":{"translate":{"type":"string","value":"container.furnace"}}}`
 *    （这条最坑：它是**包在字符串里的 JSON**，而 JSON 里面的值又各自套一层
 *    `{type,value}`，不递归根本取不到）。
 *
 * 所以这里递归下钻，并且**不把内部结构泄给模型**——它只需要知道"这是熔炉"。
 */
function chatTextFrom(raw: unknown, depth: number = 0): string | null {
    if (raw == null || depth > 8) return null;
    if (typeof raw === 'string') return raw.trim() === '' ? null : raw.trim();
    if (typeof raw !== 'object') return null;
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const found = chatTextFrom(item, depth + 1);
            if (found != null) return found;
        }
        return null;
    }
    const obj = raw as Record<string, unknown>;
    // NBT 的 `{type:"string", value:"..."}`：真正的字在 value 里。
    if (obj['type'] === 'string' && typeof obj['value'] === 'string') {
        return obj['value'].trim() === '' ? null : obj['value'].trim();
    }
    // 翻译键：`container.furnace`。**这里不急着翻译成人话**——`chatTextFrom`
    // 只管把字挖出来，说人话统一由 `readableWindowTitle` 做，否则"纯字符串形态"
    // 的 `container.blast_furnace`（没走递归的那条路）会漏掉翻译。
    const translate = chatTextFrom(obj['translate'], depth + 1);
    if (translate != null) return translate;
    const text = chatTextFrom(obj['text'], depth + 1);
    if (text != null) return text;
    // 复合标签：内容在 value 里。
    const inner = chatTextFrom(obj['value'], depth + 1);
    if (inner != null) return inner;
    // 最后试它自己的 `toString()`：有些聊天组件类是这么暴露文本的
    // （`Large Chest` 那一类）。但要挡掉默认的 `[object Object]`——那不是文本。
    if (typeof obj['toString'] === 'function') {
        const asString = String((obj as { toString: () => string }).toString());
        if (asString !== '' && asString !== '[object Object]') return asString;
    }
    return null;
}

/**
 * 语言键 → 人话：`container.furnace` → `Furnace`。
 *
 * 没有 Minecraft 的语言表可用，也没必要为几个容器名去带一份。Minecraft 的
 * 容器键一律是 `container.<名字>`，剥掉前缀、首字母大写就够了——模型要的是
 * "我打开的是熔炉还是箱子"，不是本地化。
 */
function humanizeLangKey(key: string): string {
    const last = key.includes('.') ? (key.split('.').pop() ?? key) : key;
    const spaced = last.replace(/_/g, ' ').trim();
    if (spaced === '') return key;
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function readableWindowTitle(raw: unknown): string {
    // 三种形态走**同一条路**：字符串（可能还是 JSON 文本）、对象、数组，
    // 统一交给 `chatTextFrom` 递归挖，挖出来再 `humanizeLangKey` 说人话。
    let candidate: unknown = raw;
    if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('['))) {
        try {
            candidate = JSON.parse(raw);
        } catch {
            candidate = raw; // 不是 JSON，按普通字符串处理。
        }
    }
    const text = chatTextFrom(candidate);
    if (text != null && text !== '[object Object]') return humanizeLangKey(text);
    // 实在认不出来也不吐内部结构——`[object Object]` 和那一长串 NBT 对模型
    // 都没意义，一个稳定的占位串反而更好判断。
    return 'container';
}


/**
 * 背包相对上一次快照的增量。
 *
 * 第一次观察和「真的没变化」都必须返回 `text: ''` 并标记原因；调用方
 * **不要**再把这些情况写成「背包没变化，可能捡的是已经被合并的堆」这类
 * 占位文案——模型真机把它误读成「背包是空的」。没有可识别的增量就省略事件。
 */
export interface InventoryGainSummary {
    text: string;
    gained: Record<string, number>;
    firstObservation: boolean;
    noChange: boolean;
}

export function summarizeInventoryGain(
    previous: Record<string, number> | null,
    current: Record<string, number>,
): InventoryGainSummary {
    if (previous == null) {
        return { text: '', gained: {}, firstObservation: true, noChange: false };
    }
    const gained = positiveInventoryDelta(previous, current);
    const text = formatInventoryGains(gained);
    if (Object.keys(gained).length === 0) {
        return { text: '', gained, firstObservation: false, noChange: true };
    }
    return { text, gained, firstObservation: false, noChange: false };
}

/**
 * 附近其他玩家的名字列表（按距离从近到远，去重）。自动拾取提示用。
 *
 * 不判断掉落物的真正归属（客户端拿不到可靠的 owner），但至少能在
 * 「旁边站着队友」时提醒模型：这件东西可能是队友掉落或队友也想捡。
 */
export function nearbyOtherPlayerNames(bot: unknown, radius: number = 8): string[] {
    const b = bot as {
        entity?: { id?: unknown; position?: { x?: number; y?: number; z?: number } };
        entities?: Record<string, unknown>;
    } | null | undefined;
    const self = b?.entity;
    const selfPos = self?.position;
    if (self == null || selfPos == null || typeof selfPos.x !== 'number' || typeof selfPos.y !== 'number' || typeof selfPos.z !== 'number') {
        return [];
    }
    const found: Array<{ name: string; distance: number }> = [];
    for (const raw of Object.values(b?.entities ?? {})) {
        if (raw == null) continue;
        const e = raw as {
            id?: unknown;
            name?: unknown;
            username?: unknown;
            type?: unknown;
            position?: { x?: unknown; y?: unknown; z?: unknown };
        };
        if (e.id === self.id) continue;
        const isPlayer = typeof e.username === 'string' || e.type === 'player' || e.name === 'player';
        if (!isPlayer) continue;
        const x = Number(e.position?.x);
        const y = Number(e.position?.y);
        const z = Number(e.position?.z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const distance = Math.hypot(x - selfPos.x, y - selfPos.y, z - selfPos.z);
        if (distance > radius) continue;
        const name = typeof e.username === 'string' ? e.username : typeof e.name === 'string' ? e.name : 'player';
        found.push({ name, distance });
    }
    found.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
    const names: string[] = [];
    for (const item of found) {
        if (!names.includes(item.name)) names.push(item.name);
    }
    return names;
}

/** 最近的那个玩家名（兼容旧调用；没有就 null）。 */
export function nearestOtherPlayerName(bot: unknown, radius: number = 8): string | null {
    return nearbyOtherPlayerNames(bot, radius)[0] ?? null;
}

/**
 * 从 `playerCollect` 的第二个参数里尽力读出掉落物名。
 *
 * 真名在 displayName / metadata 上，版本相关；读不到就返回 null，
 * 此时核验退回"全部正增量"，至少不会编造物品名。
 */
export function expectedItemNameFromEntity(collected: unknown): string | null {
    const e = collected as { displayName?: unknown; name?: unknown } | null | undefined;
    const displayName = typeof e?.displayName === 'string' ? e.displayName.trim() : '';
    if (displayName !== '' && displayName.toLowerCase() !== 'item') return displayName;
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    if (name !== '' && name.toLowerCase() !== 'item' && name.toLowerCase() !== 'player') return name;
    return null;
}

/**
 * 保命时的身体硬中断：取消寻路/挖掘/控制状态，并置 interrupt_code。
 *
 * 真机 Feedback #24：长寻路中敌人贴脸连射，保命反射只是排队，没有先把
 * 正在跑的模型动作打断，bot 被带走后淹死。威胁超过阈值时先调这里。
 */
/**
 * 受控岩浆作业是否处于安全站位：用于 emergency 入口跳过预测性 lava 保命。
 */
export function isControlledSafeLavaOperation(bot: any): boolean {
    if (bot?.controlledLavaOperation !== true) return false;
    const pos = bot?.entity?.position;
    if (pos == null) return false;
    const nameAt = (dy: number): string | null => {
        try {
            const p = typeof pos.offset === 'function' ? pos.offset(0, dy, 0) : { x: pos.x, y: Number(pos.y ?? 0) + dy, z: pos.z };
            const name = bot?.blockAt?.(p)?.name;
            return typeof name === 'string' ? name : null;
        } catch {
            return null;
        }
    };
    const feet = nameAt(0);
    const head = nameAt(1);
    const support = nameAt(-1);
    const hazard = (name: string | null): boolean =>
        name === 'lava' || name === 'water' || name === 'flowing_lava' || name === 'flowing_water';
    const solid = (name: string | null): boolean =>
        name != null && !hazard(name) && name !== 'air' && name !== 'cave_air' && name !== 'void_air';
    const health = typeof bot?.health === 'number' ? bot.health : 20;
    return !hazard(feet) && !hazard(head) && solid(support) && health > 12;
}

/**
 * 保命硬中断：**只置 interrupt_code + 停寻路/清控制**。
 *
 * 不直接调 `bot.stopDigging()`：mineflayer 的 stopDigging 会 cancel 一个
 * `Digging aborted` 的 Promise，旧代码没人接就变成 unhandledRejection 杀 body。
 * 挖矿由 digWithTimeout 每 200ms 轮询 interrupt_code 自行 stopDigging 退出。
 */
export function forceStopBody(agent: any): void {
    const bot = agent?.bot;
    if (bot != null) bot.interrupt_code = true;
    try {
        bot?.clearControlStates?.();
    } catch {
        // 继续尝试其余停法。
    }
    try {
        bot?.pathfinder?.stop?.();
    } catch {
        // 同上。
    }
    try {
        const cancelled: any = bot?.collectBlock?.cancelTask?.();
        if (cancelled != null && typeof cancelled.catch === 'function') cancelled.catch(() => undefined);
    } catch {
        // 同上。
    }
}

export interface ThreatEmergencyInput {
    threat: { name?: string; distance?: number } | null;
    health: number;
    damage: number;
    msSinceLastEmergency: number;
    cooldownMs?: number;
    maxDistance?: number;
    lowHealth?: number;
}

/**
 * 威胁是否已经到该主动中断当前动作的程度。
 *
 * 判定故意**不依赖挨打事件是否被 debounce 掉**：连续小伤害（骷髅连射）可能
 * 每一发都进不了 `bot.hurt` 的节流窗口，但威胁本身仍在，必须能触发保命。
 */
export function shouldThreatEmergency(input: ThreatEmergencyInput): boolean {
    const distance = Number(input.threat?.distance);
    if (input.threat == null || !Number.isFinite(distance)) return false;
    if (distance > (input.maxDistance ?? 16)) return false;
    if (input.msSinceLastEmergency < (input.cooldownMs ?? 10_000)) return false;
    return input.damage > 0 || input.health <= (input.lowHealth ?? 12);
}

/** fatal reason 的可落盘形态：message + stack + 尽量完整的对象序列化。 */
export function describeFatalReason(reason: unknown): { message: string; stack: string | null; serialized: string } {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error && typeof reason.stack === 'string' ? reason.stack : null;
    let serialized: string;
    try {
        if (reason instanceof Error) {
            serialized = JSON.stringify({ name: reason.name, message: reason.message, stack: reason.stack });
        } else if (reason != null && typeof reason === 'object') {
            const seen = new WeakSet<object>();
            serialized = JSON.stringify(reason, (_key, value: unknown) => {
                if (value instanceof Error) {
                    return { name: value.name, message: value.message, stack: value.stack };
                }
                if (value != null && typeof value === 'object') {
                    if (seen.has(value)) return '[circular]';
                    seen.add(value);
                }
                return value;
            }) ?? String(reason);
        } else {
            serialized = String(reason);
        }
    } catch {
        serialized = '[unserializable]';
    }
    return { message, stack, serialized };
}

/** uncaughtException 状态不可恢复；unhandledRejection 默认记录并继续。 */
export function shouldKillOnFatal(kind: 'uncaughtException' | 'unhandledRejection'): boolean {
    return kind === 'uncaughtException';
}

/** 是不是 mineflayer 挖矿被取消产生的非致命 abort。 */
export function isDiggingAborted(reason: unknown): boolean {
    const msg = reason instanceof Error ? reason.message : String(reason);
    return /Digging aborted/i.test(msg);
}

/**
 * 安全包装 bot.stopDigging：mineflayer 的 digging task 在取消时会 reject
 * `Digging aborted`，而 health/death/插件内部可能直接调 `bot.stopDigging()`
 * 没人接，就变成 unhandledRejection。包装后同步 throw 和 Promise rejection 都吞掉。
 */
export function installSafeStopDigging(bot: any): void {
    if (bot == null || typeof bot.stopDigging !== 'function') return;
    if (bot.__safeStopDigging === true) return;
    const original = bot.stopDigging.bind(bot);
    const safe = (...args: unknown[]): unknown => {
        try {
            const result: any = original(...args);
            if (result != null && typeof result.catch === 'function') {
                result.catch((err: unknown) => {
                    if (!isDiggingAborted(err)) {
                        console.warn('stopDigging rejected:', err instanceof Error ? err.message : String(err));
                    }
                });
            }
            return result;
        } catch (err: unknown) {
            if (!isDiggingAborted(err)) {
                console.warn('stopDigging threw:', err instanceof Error ? err.message : String(err));
            }
            return undefined;
        }
    };
    (safe as any).__originalStopDigging = original;
    bot.stopDigging = safe;
    bot.__safeStopDigging = true;
}

/** 相机的最小接口。
 *
 * **故意不 import `VisionInterpreter` 的具体类型**：那条导入链会把
 * `node-canvas-webgl`（原生模块）拉进来，而它在这台机器上**根本没有编译产物**
 * （`build/Release/*.node` 不存在）。主线为此整个进程都起不来。
 *
 * 视觉是**身体的一项可选能力**，不该有能力否掉身体本身。所以相机改成
 * `start()` 里动态 import + try/catch：拿不到就是"没有截图"，其余一切照常。
 */
interface BodyVision {
    captureBase64?: () => Promise<string | null>;
    lookAtPosition?: (x: number, y: number, z: number) => Promise<unknown>;
    lastScreenshot?: { file: string; takenAt: number } | null;
}

/** 身体侧的事件出口。由宿主（协议层）注入。 */
export type EventSink = (push: BodyPush) => void;

export interface MineflayerBodyOptions {
    name: string;
    countId: number;
    /** 事件出口。协议层给的是 `BodyServer.push`。 */
    sink: EventSink;
    /** 落盘根目录；默认 `./bots/<name>`。 */
    baseDir?: string;
}

/**
 * 氧气条多长算"快用完了"。
 *
 * Minecraft 的氧气机制：头**连续**在水下 15 秒（300 ticks）后开始掉溺水伤害，
 * 露出水面瞬间回满。取 90%（13.5 秒）作为保命介入点——留 1.5 秒余量给
 * 上浮动作本身，别掐着极限才动。
 */
const OXYGEN_ACT_MS = 13_500;

/** 申请额度的三个控制工具：它们**自己不发额度，也不消耗额度**。 */
const CONTROL_TOOL_NAMES = new Set(['allowDangerousOps', 'disableSafeguards', 'restoreAllSafety']);

/**
 * 反射跑过这个时长就把"已 N 秒"写进动作名里。
 *
 * 真机有一跑 419 秒的 escape（`{"reflex":"escape","outcome":"ok","ms":419426}`），
 * 而它跑着的时候快照只写 `action idle`——模型既不知道身体被占着，也不知道
 * 已经占了多久。30 秒之后开始报时长，够长才报，免得刷屏。
 */
const REFLEX_SLOW_MS = 30_000;

/**
 * 单次保命处理的时长上限（毫秒）。
 *
 * 真机有一条 `{"reflex":"escape","outcome":"ok","ms":419426}`——**七分钟**里
 * 身体一直被保命循环占着，模型的自救动作全被拒。保命循环当然是优先的，
 * 但它**不能永远不还身体**：跑过这个上限就中断它、如实报告，把通道交还给模型
 * （模型可以吃药/逃跑/换方向，而不是看着自己被打死还调不动）。
 */
export const REFLEX_MAX_MS = 120_000;

/**
 * 保命反射**连续占用**身体的预算（毫秒）。
 *
 * 单个反射有 `REFLEX_MAX_MS` 兜着，但**制度**没有上限：只要敌人在触发半径里，
 * 每一条边沿都会立刻新起一次 escape，从模型角度看就是"一次连续几分钟的占用"
 * （真机 17:15：`escape（已 102s）`，期间 stairUp/restart/disableSafeguards
 * 全被通道拒掉，它最后只能去关自己的安全护栏）。45 秒是给真实逃脱留的余量
 * （摔落/岩浆爬出来常常要 20~30 秒），超过就交还身体。
 */
export const SURVIVAL_BUDGET_MS = 45_000;

/**
 * 用完预算后把身体交还多久（毫秒）。
 *
 * 这段时间里**不重新接管**——模型需要一段确定的时间窗口去吃药/搭柱/挖开/Stop，
 * 而不是在它刚发出动作时又被反射抢走。
 */
export const SURVIVAL_COOLDOWN_MS = 25_000;

/** 保命反射之间超过这个间隔就算"新的占用段"（毫秒）。 */
export const SURVIVAL_GAP_MS = 10_000;

/**
 * Stop 之后等保命处理收手的宽限（毫秒）：超过就把通道**真的**还回去。
 *
 * 回执说"通道已释放"而快照还写着 `escape（已 102s）`，就是又一次撒谎。
 */
export const REFLEX_STOP_GRACE_MS = 2_000;

/**
 * 一次保命处理的可取消句柄。
 *
 * `cancel()` 一响，`rescue()` 就当场返回（不用等 `runEmergency` 自己发现危险没了）；
 * `aborted` 是给那之后仍在后台跑的旧循环看的——它必须**彻底哑火**（不再读世界、
 * 不再发 goal），直到自己自然收尾。
 */
interface RescueRun {
    aborted: boolean;
    cancel: (() => void) | null;
}

/**
 * **模型自己的自救动作**：它们到达身体时，保命反射必须先让位。
 *
 * 真机 2026-10-18 17:59（overnight_b）溺水死亡：`surface` 反射和模型主动调的
 * `escapeWater` 互相抢身体，十几轮都没上岸（"工具 escapeWater → rejected:
 * 保命反射正在占用身体"），y 从 61 掉到 56，最后 `overnight_b drowned`。
 * 在**水里**这件事上，模型的判断比一个 1 秒就 abort 一次的反射更靠谱——
 * 反射挡在这里不是保命，是把两个人都锁死。
 */
const MODEL_RESCUE_TOOLS = new Set(['escapeWater']);

/**
 * **致命危险清单**（= 永远不吃保命冷却的那些 L5）。
 *
 * 验证者探针（tmp/verify/emergency_lock.probe.test.ts ②/③）钉出两个洞：
 *   1. 25 秒冷却是按时间静音的，不看危险种类——被僵尸追 45 秒（预算交还身体）
 *      之后掉进岩浆/虚空、或者溺水，这 25 秒里所有 L5 都被丢掉，连事件都不推
 *      给大脑（模型不会被叫醒）；
 *   2. 岩浆/虚空/致命坠落是 `kind:'flag'` 的**一次性上升沿**（见 `DETECTORS`），
 *      被吞一次就再没有接管路径——`world.lava.nearby` 只是 L3，不会选反射。
 *
 * ## 这不是随便一张表，是**必须完整**的一张表
 *
 * 今晚抓到的三个 bug 都是同一种形状：**规则只在一个方向上成立**（有下限没上限、
 * 去重按名字不按意图、上限只加在一条路径上）。所以这里把它做成**显式分类**：
 * `tests/reflex_fatal.test.ts` 会枚举 `DETECTORS` 里**所有 level 5** 的类型，
 * 要求每一个要么在这张"致命"表里、要么在下面的 `NON_FATAL_L5_TYPES` 里写明理由；
 * **新增一个 L5 危险而忘了分类，测试直接红**。另外它强制要求：
 * **`kind:'flag'`（一次性边沿）的 L5 必须全部是致命的**——一次性边沿被吞掉
 * 就再也没有第二次机会。
 *
 * 判断标准：**"再等 25 秒会死/会掉出世界"** 才是致命。
 */
export const FATAL_DANGER_PREFIXES = ['world.lava.'] as const;
export const FATAL_DANGER_TYPES: ReadonlySet<string> = new Set([
    'world.water.drowning',
    'world.void.falling',
    'world.fall.lethal',
]);

/**
 * **不是致命**的 L5，以及为什么（新增 L5 时必须在这里或 `FATAL_DANGER_*` 里选一边）。
 *
 * 判成"非致命"的含义：冷却期内它会让位（身体归模型），但**事件照样推给大脑**
 * （STATE 记录），而且这些边沿都是 `kind:'all'|'keyed'`——会反复 fire，
 * 冷却一过就有下一次机会。
 *
 * ⚠️ 真机上如果出现"死在冷却期里的 X"，把 X 挪进 `FATAL_DANGER_TYPES`，
 * 别在这里加理由——这张单子的存在就是为了让那个决定显式发生。
 */
export const NON_FATAL_L5_TYPES: ReadonlySet<string> = new Set([
    // 着火且血少：会持续燃烧、边沿反复 fire，模型自己能吃/跑/放水。
    'world.fire.burning_low_hp',
    // 被卡住且血少：不是"下一秒就死"，模型需要时间换方向/挖开。
    'world.trapped.low_hp',
    // TNT 已点燃 / 苦力怕膨胀：**这两个最接近致命**，但都是短促的一次性爆发，
    // kind 是 keyed（每次事件带 key，会反复 fire），而且这里反射能做的
    // （跑开）和模型能做的完全一样。真要在冷却期里被炸死，把它们挪进致命集。
    'world.tnt.primed_nearby',
    'world.creeper.swelling',
]);

/** 这条 L5 是不是"再等一下就死了"的致命危险。 */
export function isFatalDanger(type: string): boolean {
    if (FATAL_DANGER_TYPES.has(type)) return true;
    return FATAL_DANGER_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/**
 * 这条 L5 危险被怎么分类（测试/诊断用）。
 *
 * `unclassified` = 清单漏了：新增 L5 危险必须二选一登记，否则
 * `tests/reflex_fatal.test.ts` 的"致命清单必须完整"会红。
 */
export function l5DangerClass(type: string): 'fatal' | 'non-fatal' | 'unclassified' {
    if (isFatalDanger(type)) return 'fatal';
    return NON_FATAL_L5_TYPES.has(type) ? 'non-fatal' : 'unclassified';
}

/** `kind:'flag'` 的边沿只 fire 一次——被吞掉就得自己补一枪（见 `pendingDanger`）。 */
export const FLAG_DANGER_TYPES: ReadonlySet<string> = new Set(
    DETECTORS.filter((detector) => detector.kind === 'flag').map((detector) => detector.type),
);

/**
 * 容器包转储关心的"开界面"包（只有这些记载荷）。
 *
 * ⚠️ **包名随协议版本改过，必须两个名字都认**：
 * 1.19 时代叫 `open_screen`，**1.20.2+ 改名为 `open_window`**（本机 minecraft-data 3.111.0
 * 的 1.20.6 数据里 toClient 只有 `packet_open_window`，没有 `packet_open_screen`）。
 * 我们的服务端是 **1.20.6** —— 只写 `open_screen` 会让转储**永远看不见开窗包**，
 * 于是把"服务端其实发了、我们没接住"误判成 `no-reply`。这个假阴性已经实际发生过一次
 * （2026-10-19 03:28 真机：三个箱子的 dump 全是"无入站包"，而 Meta.screen 一度闪过 open）。
 * 同类改名还有 `set_content` → `container_set_content`，一起留着。
 */
// 带槽位容器不可用结论的有效期：结束后自动重试，不许永久焊死。
const SLOTTED_CONTAINER_BLOCK_MS = 12 * 60 * 60_000;

const WINDOW_PACKET_RE = /open_screen|open_window|window_items|window_properties|close_window|set_content|container_set_content|open_sign_editor|merchant_offers/i;

/** 六个窗口包的一行摘要（只留判定字段；读不到就留空，绝不 dump 整包）。 */
function summarizeInboundWindowPacket(name: string, data: unknown): string {
    try {
        const d = (data ?? {}) as Record<string, unknown>;
        const bits: string[] = [];
        if (d.windowId != null) bits.push(`windowId=${String(d.windowId)}`);
        if (d.windowType != null) bits.push(`type=${String(d.windowType)}`);
        if (Array.isArray(d.items)) bits.push(`items=${d.items.length}`);
        if (d.title != null) bits.push(`title=${String(d.title).slice(0, 24)}`);
        return bits.length > 0 ? `(${bits.join(' ')})` : '';
    } catch {
        return '';
    }
    void name;
}

/**
 * 工具回执看起来是不是**失败**。
 *
 * `executeToolCall` 用字符串回执表示结果（失败形如 `Tool X failed: …` /
 * `Unknown tool: X`），所以"这次自救到底成没成"只能从回执判断。
 * 只有明确失败才不放宽保命——判错方向要偏保守（当成失败 = 保命继续待命）。
 */
export function toolResultLooksFailed(text: unknown): boolean {
    const first = String(text ?? '').trim().split('\n')[0] ?? '';
    return /^(Tool\s+\S+\s+failed:|Unknown tool:|Unknown tool\b)/i.test(first);
}

export class MineflayerBody {
    readonly name: string;
    readonly countId: number;

    _disconnectHandled = false;
    actions!: ActionManager;
    memory_bank!: MemoryBank;
    bot: any; // mineflayer 无类型，bot 统一 any
    vision_interpreter: BodyVision | undefined;
    edgeWatcher: EdgeWatcher | null = null;

    /**
     * 已经报过的那一件掉落物（实体 id）。同一件不重复报——事件是"发生"，
     * 不是"当前状态"；状态由每一轮的世界快照承担。
     */
    private seenDropId: string | null = null;

    /** 上一次报过的背包账目签名。变了才报（第一次观察也算一次变化）。 */
    private inventorySignature: string | null = null;

    private sink: EventSink;
    private log: Logger;
    private lastHurtEmitAt = 0;
    private lastCollectEmitAt = 0;
    /** 连续拾取失败次数与退避截止时间：失败后不许每 1.5 秒继续抢身体。 */
    private pickupFailures = 0;
    private pickupBackoffUntil = 0;
    /** 模型动作已经请求时，拾取正在收手；期间不再启动新的拾取。 */
    private pickupAbortRequested = false;
    /** 当前 pickup 寻路的即时取消回调；模型动作来时直接停 pathfinder。 */
    private pickupCancel: (() => void) | null = null;
    /** 当前 pickup 目标显示名；行走中复查 discard 免疫用。 */
    private pickupTargetName: string | null = null;
    /** 当前 pickup 目标实体 id：名字可能读不到/被改写，id 是身份。 */
    private pickupTargetId: number | null = null;
    /**
     * 这次拾取是**被谁抢掉的**（保命 / Stop / 模型动作）。
     *
     * 必须记下来：收尾时如果只看 `actions.executing`，保命抢占会被当成"拾取失败"
     * 去累计退避，回执还会说"退避 N 秒后再试"——而真实情况是"保命优先，主动放弃"。
     */
    private pickupPreemptReason: string | null = null;
    /** 保命抢占后的拾取静默截止时间：命保住了再谈捡东西。 */
    private pickupSuppressedUntil = 0;
    /** 已经因为"附近有敌人"跳过过哪一件（避免每 300ms 重复发回执）。 */
    private pickupThreatSkippedId: string | null = null;
    /** 正在跑的反射名 + 开始时间（快照要如实报；419 秒的 escape 不该事后才知道）。 */
    private currentReflexName: string | null = null;
    /** 正在跑的反射**意图**：`escape/flee` 和 `escape/lava` 不是同一件事（去重键要用）。 */
    private currentReflexIntent: EmergencyIntent | null = null;
    private currentReflexStartedAt = 0;
    /** 急停/Stop 之后不许再跑队列里剩下的反射。 */
    private reflexAbortRequested = false;
    /**
     * 正在跑的那一棒保命处理的**取消令牌**（每次 rescue 一个，Stop/急停只取消这一棒）。
     *
     * 真机抱怨「`Stop` 之后仍不停手」：`abortReflexes` 只置 `reflexAbortRequested` +
     * `requestInterrupt()`，而 `runEmergency` 的逃跑循环**每一步**都会重新
     * `setMovements` + `setGoal`——Stop 停掉的那次寻路，下一 tick（≤1 秒）又会被
     * 重新起一条。于是"Stop 了"只意味着通道被摘下来，身体还在被那条后台循环
     * 往同一个方向拖（`interrupt_code` 它也不看）。
     *
     * 为什么用**每次一个**令牌而不是只看 `reflexAbortRequested`：那个共享标记会在
     * 下一次 `emergency()` 排队时被清掉，被丢弃的旧循环会因此"复活"成第二个写手。
     * 令牌只属于创建它的那一棒，旧循环永远哑火、自然收尾。
     */
    private currentRescueRun: RescueRun | null = null;
    /**
     * 被冷却/去重吞掉的一次危险：**一次性边沿（kind:'flag'）没有第二次机会**，
     * 所以到窗口结束时自己补一枪（冷却结束、人还在岩浆里 → 必须有人来救）。
     */
    private pendingDanger: {
        type: string;
        payload: unknown;
        reflex: string;
        intent: EmergencyIntent;
        dueAt: number;
    } | null = null;
    private pendingDangerTimer: ReturnType<typeof setTimeout> | null = null;
    /** 保命反射"连续占用段"的起点（毫秒时间戳）；null = 当前没有占用段。 */
    private survivalBusySince: number | null = null;
    /** 当前占用段是哪种危险（fatal/other）：类别变了要开新段，别把两笔账混一起。 */
    private survivalBusyClass: 'fatal' | 'other' | null = null;
    /** 最近一次保命反射的时刻：用来判"中间的空档算不算同一段占用"。 */
    private survivalLastReflexAt = 0;
    /** 交还身体的冷却截止时间：这段时间身体归模型。 */
    private survivalCooldownUntil = 0;
    /** 冷却期回执的节流时刻（别每 300ms 刷一条）。 */
    private survivalYieldNotifiedAt = 0;
    /** 这条反射的完成报告已经发过了吗（Stop 宽限期抢发过一次就不再重复）。 */
    private reflexCompletionSent = false;
    /** 模型动作请求已经在路上时，禁止新的自动拾取抢身体。 */
    private modelActionRequested = false;
    /** 在途模型协议 action 数：查询/动作可能重叠，用计数而不是布尔。 */
    private modelActionsInFlight = 0;
    /**
     * **背包数据是否真的到过一次**（连接建立后服务端会发 `window_items`，windowId 0）。
     *
     * 真机 2026-10-18：进程重启（当晚第 3 次）后第一份快照读成
     * `Held: main empty` / `Backpack (free 36): empty`，而玩家数据里 dirt×11
     * 好端端躺着（Lead 解码 playerdata 核实）。模型据此以为丢了全部家当，
     * 从零开始重新采集。**"还没同步"必须是可区分的状态，不能渲染成"空"。**
     */
    private inventorySynced = false;

    /** 上一次"被怪打触发保命"的时间（10 秒防抖，免得连续挨打刷屏）。 */
    private lastThreatEmergencyAt = 0;

    /**
     * 头**连续**在水下的起始时刻（null = 头不在水下）。
     *
     * 这是我们自己的氧气表：mineflayer 在 1.20.6 读不到 air_supply，
     * 而"头连续水下 15 秒开始掉血、露头回满"是确定性机制——计时就是氧气。
     */
    private headUnderSince: number | null = null;

    /** 上一次看到的血量（掉血检测用）。 */
    private lastSeenHealth: number | null = null;
    private stuckPos: string | null = null;
    private stuckSince = 0;
    private lastHeartbeatAt = Date.now();
    private lowHpArmed = false;
    /** 自动拾取：上一次尝试的时刻 / 是否正在捡（见 `schedulePickup`）。 */
    private lastPickupAt = 0;
    private pickingUp = false;

    /** 开发者通道的读游标。逻辑在 `inbox.ts`（那边可单测）。 */
    private inbox: InboxCursor = EMPTY_CURSOR;

    private exitingWater = false;
    private lastWaterCheckAt = 0;
    private waterExitFailures = 0;
    private shuttingDown = false;

    constructor(options: MineflayerBodyOptions) {
        this.name = options.name;
        this.countId = options.countId;
        this.sink = options.sink;
        this.log = createLogger({ dir: `${options.baseDir ?? `./bots/${options.name}`}/logs` });
        // 开发者通道的游标在这里读回：**必须在第一次 `pollInbox` 之前**，
        // 否则重启后那几个 300ms 心跳会把整个 inbox 当新内容推一遍。
        this.loadInboxCursor();
    }

    // ── 生命周期 ───────────────────────────────────────────────────────────

    /**
     * 连上游戏并把所有观察接好。**不返回直到 spawn**——大脑等着这个承诺，
     * 晚一点握手比连上一个还没出生的身体要好。
     */
    async start(): Promise<void> {
        this.installProcessGuards();
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            throw new Error(nameCheck.msg);
        }

        // 只装身体自己的瞬时位置账（死亡位置那一类）。**模型记住的地名不在这里**——
        // 那是大脑侧会话的事。见 `memory_bank.ts` 顶部。
        this.memory_bank = new MemoryBank();
        this.actions = new ActionManager(this);
        this.edgeWatcher = createEdgeWatcher();

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        // 容器包转储入口：skills 侧只认这两个方法名，不 import 身体内部实现。
        (this.bot as { __armContainerPacketDump?: unknown }).__armContainerPacketDump = (reason: string): void =>
            this.armContainerPacketDump(reason);
        (this.bot as { __disarmContainerPacketDump?: unknown }).__disarmContainerPacketDump = (outcome: string): void =>
            this.finishContainerPacketDump(outcome);
        (this.bot as { __containerProtocolFault?: unknown }).__containerProtocolFault = (withinMs?: number) =>
            this.recentProtocolFault(withinMs);
        (this.bot as { __slottedContainerStatus?: unknown }).__slottedContainerStatus = (name?: string) =>
            this.slottedContainerStatus(name);
        // **抓错点铺到所有出口**（client-error / deserializer-error / uncaught）；
        // 见 installProtocolFaultCapture 的注释：一次没触发，不等于错误没发生。
        this.installProtocolFaultCapture();
        // 背包在登录后才会由服务端推下来；在此之前"空"是不可信的（见 inventorySynced）。
        this.inventorySynced = false;
        try {
            (this.bot as { __inventorySynced?: boolean }).__inventorySynced = false;
        } catch {
            // 挂不上不影响身体自己的判断。
        }
        // mineflayer 内部 health/death 会直接调 bot.stopDigging，先包一层吞掉 abort rejection。
        installSafeStopDigging(this.bot);

        const onDisconnect = (event: string, reason: unknown): void => {
            void event;
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;
            const { type, msg } = handleDisconnection(this.name, reason);
            try {
                this.log.with('lifecycle').error({ event: 'exit', msg, type, code: 1 });
            } catch {
                // 同上：退出原因优先上屏。
            }
            console.error(this.name, msg);
            process.exit(1);
        };

        this.bot.once('kicked', (reason: unknown) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason: unknown) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err: unknown) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                onDisconnect('Error', err);
            } else {
                log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        this.bot.on('login', () => {
            console.log(this.name, 'logged in');
            // **登录后背包一律先标"未知"**：服务端随后才会发 window_items。
            // 这段窗口里如果采样，必须报"还没同步"，绝不能报"空"（真机事故见
            // `inventorySynced` 的注释）。
            this.inventorySynced = false;
            try {
                (this.bot as { __inventorySynced?: boolean }).__inventorySynced = false;
            } catch {
                // 挂不上也不要紧：身体自己的字段才是权威。
            }
            // 包里没有任何物品时服务端也会发一次 window_items（空包同样算同步）；
            // 但那之前 `heldItemChanged` 也可能先到，一并当作"到过一次"。
            try {
                (this.bot as any)._client?.on?.('window_items', (packet: any) => {
                    if (Number(packet?.windowId) === 0) this.markInventorySynced();
                });
            } catch {
                // 拿不到底层 client 就只靠 heldItemChanged/超时兜底。
            }
            try {
                this.bot.on('heldItemChanged', () => this.markInventorySynced());
            // **开/关窗口也要把背包标成"未知"，而不是让"空"顶上来。**
            // 真机 2026-10-19/20（overnight_a）：「useBlock 一打开 crafting_table 界面，
            // 背包立刻被清空（已复现 2 次）」——那不是物品没了，是开窗时本地背包视图
            // 在重读的一瞬间是空的；而 `stats` 把"读不到/空"渲染成 `Backpack: empty`，
            // 模型据此相信家当没了，甚至推出"主线不可能完成"的全局结论。
            // 这是今晚第三次"未知被渲染成空"（复活窗口、容器槽位、现在是开窗）。
            this.bot.on('windowOpen', () => {
                this.inventorySynced = false;
                try {
                    (this.bot as { __inventorySynced?: boolean }).__inventorySynced = false;
                } catch {
                    // 挂不上不影响身体判断。
                }
                try {
                    this.log.with('lifecycle').info({
                        event: 'inventory-unsynced',
                        why: 'window-open',
                        windowId: Number((this.bot as any)?.currentWindow?.id ?? -1),
                    });
                } catch {
                    // 日志失败不影响。
                }
            });
            // 关窗之后客户端会重新收一遍玩家背包：**先标未知，再按"关窗后的读数"采信**。
            // 这样既不会把过渡态的空读成"清空"，也不会让背包永远停在未知。
            this.bot.on('windowClose', () => {
                this.inventorySynced = false;
                try {
                    (this.bot as { __inventorySynced?: boolean }).__inventorySynced = false;
                } catch {
                    // 同上。
                }
                try {
                    this.log.with('lifecycle').info({ event: 'inventory-unsynced', why: 'window-close' });
                } catch {
                    // 同上。
                }
                const timer = setTimeout(() => {
                    try {
                        if ((this.bot as any)?.currentWindow != null) return; // 还有窗口开着：继续未知
                        this.markInventorySynced();
                        this.log.with('lifecycle').info({ event: 'inventory-resynced', why: 'window-close' });
                    } catch {
                        // 读不到就保持未知（渲染层会说"还没同步，不是空的"）。
                    }
                }, 300);
                (timer as { unref?: () => void }).unref?.();
            });
            } catch {
                // 同上。
            }
            // **重连之后先把界面状态清干净。** 我们一晚上要重启十几次，旧进程
            // 来不及发 `close_window` 就没了，客户端/服务端都可能还记着一个窗口；
            // 这种状态下再开箱子，`windowOpen` 可能永远不来（真机 18:18：
            // `Event windowOpen did not fire within timeout of 20000ms`，
            // 紧接着身体才在空闲时清掉 `leaked-open-window`）。
            try {
                if (closeStaleWindow(this.bot)) {
                    this.log.with('lifecycle').info({ event: 'container-window-reset', why: 'relogin' });
                }
            } catch {
                // 清不掉不影响登录流程（每次开界面前还会再清一次）。
            }
            // 皮肤是身体的事（要发 /skin 命令）。主线的 `serverProxy.login()`
            // 是给 MindServer 看的，留在大脑。
            const skin = settings.profile?.['skin'] as { model: string; path: string } | undefined;
            if (skin) this.bot.chat(`/skin set URL ${skin.model} ${skin.path}`);
            else this.bot.chat(`/skin clear`);
        });

        // 每次复活（spawn）也清一次：死亡会让服务端关掉界面，客户端那个对象
        // 却可能还留着——留着就会让后续的 useBlock/placeBlock 全废。
        this.bot.on('spawn', () => {
            // **复活/换维度后背包也先标"未知"。**
            // 真机 2026-10-19（overnight_a）：「背包清空 4 次」——查 A 的日志：
            // 14 次"背包变空"**全部落在死亡事件同一秒**，其中 12 次在几秒后又被
            // `inventory.changed` 填回来（22:15:52 空 → 22:16:39 有 55 件）。
            // 这个存档 keepInventory=true，物品**没有丢**：那是复活瞬间服务端重发
            // 背包之前的本地视图清空。标成"未知"后，stats/回执会说"还没同步上来，
            // 不是空的"，而不是让模型以为家当没了。
            this.inventorySynced = false;
            try {
                (this.bot as { __inventorySynced?: boolean }).__inventorySynced = false;
            } catch {
                // 挂不上不影响身体自己的判断。
            }
            try {
                if (closeStaleWindow(this.bot)) {
                    this.log.with('lifecycle').info({ event: 'container-window-reset', why: 'spawn' });
                }
            } catch {
                // 同上。
            }
        });

        const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            log(this.name, `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);

        await new Promise<void>((resolve, reject) => {
            this.bot.once('spawn', async () => {
                try {
                    clearTimeout(spawnTimeout);
                    // 视觉：拿不到就安静退化（见 `BodyVision` 的说明）。
                    await this.initVision();

                    // wait for a bit so stats are not undefined
                    await new Promise<void>((r) => setTimeout(r, 1000));

                    // **补 tag 配方必须在这里做**：`bot.registry` 是登录之后才加载的，
                    // 之前放在 initBot 后面立刻调用，那时 registry 还是空的，补丁等于没打
                    // （模型真机报"木棍还是做不出来（2 birch_planks → 4 stick 失败）"）。
                    const addedRecipes = expandTagRecipes(this.bot?.registry);
                    this.log.with('lifecycle').info({ event: 'tag-recipes-expanded', added: addedRecipes });

                    console.log(`${this.name} spawned.`);
                    this.log.with('lifecycle').info({ event: 'spawned', bot: this.name });
                    this.clearBotLogs();

                    this.setupInteractionHandlers();
                    this.startEvents();
                    resolve();
                } catch (error: unknown) {
                    console.error('Error in spawn event:', error);
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
    }

    /**
     * 启动相机。**失败不算错误**——`node-canvas-webgl` 缺二进制时整个
     * 视觉栈都是不可用的，但世界快照、动作、事件全都不依赖它。
     */
    private async initVision(): Promise<void> {
        if (settings.allow_vision !== true) {
            this.log.with('vision').info({ event: 'disabled-by-settings' });
            return;
        }
        try {
            const mod = await import('./vision/vision_interpreter.js');
            this.vision_interpreter = new mod.VisionInterpreter(this, settings.allow_vision) as BodyVision;
            console.log('vision interpreter ready');
        } catch (err: unknown) {
            this.vision_interpreter = undefined;
            console.warn(
                'vision unavailable (screenshots disabled):',
                err instanceof Error ? err.message : String(err),
            );
            this.log.with('vision').warn({ event: 'unavailable', err: String(err) });
        }
    }

    // ── 命令实现用得着的表面（`executeToolCall` 的 agent）────────────────────

    /**
     * 当前正在跑的动作名（模型的动作）。身体正在自主走路的反射也报出来，
     * 免得模型看到"身体空着"却调不动。
     *
     * ⚠️ **这里以前会撒谎**：只报了模型动作和 pickup，**没报保命反射**。
     * 真机 2026-10-18 15:56（overnight_a）的原文：快照写 `Meta: action idle`，
     * 但 `speed 2.0-2.4`，身体正被反射拖着走——它据此以为"我可以发动作"，
     * 结果每条调用都被"动作已在跑"拒掉，几十秒里被打死。
     * 现在**谁占着身体就报谁**（模型动作 > pickup > 反射），并且反射跑久了
     * 把已运行时长一起报出来（419 秒的 escape 不该等它结束才知道）。
     */
    currentActionName(): string | null {
        const label = this.actions?.currentActionLabel;
        if (label) return label;
        // 保命反射优先于拾取：两者同时为真只可能出现在"拾取正在被摘下来"的
        // 那一两个 tick 里，此时真正驱动身体的是反射。
        if (this.currentReflexName != null) {
            const ms = this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0;
            return ms >= REFLEX_SLOW_MS
                ? `${this.currentReflexName}（已 ${Math.round(ms / 1000)}s）`
                : this.currentReflexName;
        }
        if (this.pickingUp) return 'autoPickup';
        return null;
    }

    /**
     * 以 bot 当前位置为圆心找最近的敌对生物（拾取前的保命判据用）。
     *
     * 位置读不到就返回 null——**宁可不挡拾取，也不许因为读不到位置就永久不捡**。
     */
    private threatNearRelative(radius: number): { name: string; distance: number } | null {
        try {
            const p = this.bot?.entity?.position;
            if (p == null) return null;
            return this.threatNear({ x: p.x, y: p.y, z: p.z }, radius);
        } catch {
            return null;
        }
    }

    /**
     * 正在跑的反射名 + 意图 + 开始时间（快照/诊断用）。
     *
     * 意图必须一起报：`escape(flee)` 和 `escape(lava)` 是**两件事**（flee 只逃跑、
     * 不爬岩浆），只报名字会把"在躲僵尸"和"在爬出岩浆"混成一句。
     */
    reflexStatus(): { reflex: string; intent: string | null; ms: number } | null {
        if (this.currentReflexName == null) return null;
        const ms = this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0;
        return { reflex: this.currentReflexName, intent: this.currentReflexIntent ?? null, ms };
    }

    /**
     * 现采一份 Live State 文本。
     *
     * 与 `sample()` 共用同一份采样——两处绝不能各采各的，否则模型会看到
     * 两份互相矛盾的状态。
     */
    liveStateText(): string {
        return renderLiveState(sampleLiveState(this.sampleContext()));
    }

    /**
     * 感知采样的**唯一入口**。
     *
     * `goal` / `todos` **身体不知道、也不该知道**：它们是大知识（`PlanStore`
     * 在大脑），由大脑在记录事件时自己填。以前靠一条 `setGoal` 把大脑的状态
     * 镜像进身体，那是"同一份事实两个持有者"——现在身体只报客观发生了什么，
     * 相关性判断留在大脑的处理里。
     */
    sampleContext(): SampleContext {
        return {
            bot: this.bot,
            vision: this.vision_interpreter,
            todos: [],
            currentAction: this.currentActionName(),
            // 裸 fixture（没有这个字段）按"已同步"兼容；真实 body 初始为 false。
            inventorySynced: this.inventorySynced !== false,
        };
    }

    /**
     * **容器包转储**：只在下一次"开容器"期间武装，回答两个问题：
     *   (a) 服务端到底有没有发 `open_screen` / `window_items`？
     *   (b) 我们到底发了什么（`block_place` / `use_item_on` 的位置、朝向、sequence、手持）？
     *
     * 为什么必须有它：真机 2026-10-19 overnight_a 报了 18 次 chest/furnace 的
     * `windowOpen` 超时，而 `crafting_table` 完全正常——`windowPackets === 0` 只是
     * **证据**（"服务端没发"），不是**原因**。有了这一行，下一次失败就能直接读出
     * 是我们没发包 / 发了服务端不认的包 / 服务端拒发。
     *
     * 纪律（Lead 的要求）：**只有失败才武装**（成功即解除）、**有界**（8 秒 /
     * 最多 24 条 / 约 1800 字符）、**脱敏**（只留名字和几个判定字段，不留整包）、
     * 最后落成**一行** lifecycle 日志——绝不常开、绝不刷屏。
     */
    private containerDumpArmed = false;
    private containerDumpTimer: ReturnType<typeof setTimeout> | null = null;
    private containerDumpLines: string[] = [];
    private containerDumpInbound: string[] = [];
    private containerDumpRestore: (() => void) | null = null;

    /**
     * **开窗之后紧跟着来的包**（按顺序，不受 24 条上限影响）。
     *
     * 为什么单独记这一串：mineflayer 收到 `open_window` 之后**不会立刻**发 `windowOpen`，
     * 它要等槽位数据（`window_items` → 内部事件 `setWindowItems:<id>`）才发（源码
     * `inventory.js` 的 `prepareWindow`："don't emit windowOpen until we have the slot data"）。
     * 真机（2026-10-19 03:54）已经确证：服务端**发了** `open_window(windowId=1)`，我们**收到了**，
     * 但 `displayWindow`/`openContainer` 仍然超时——所以问题在"槽位包到没到"。
     * 而 `lines`/`inboundNames` 都有 24 条上限（那次 `inboundCount` 是 2549），
     * **"没看到 window_items"根本不能当证据**。这一串就是为它准备的：小、定序、不截断。
     */
    private containerDumpAfterOpen: string[] = [];
    private containerDumpSawOpen = false;

    /** 武装一次转储（重复调用无害；已经在录就不重开）。 */
    armContainerPacketDump(reason: string, label: 'container' | 'craft' = 'container'): void {
        this.containerDumpLabel = label;
        if (this.containerDumpArmed) return;
        const client = (this.bot as { _client?: any } | null)?._client;
        if (client == null || typeof client.on !== 'function') return;
        this.containerDumpArmed = true;
        this.containerAttemptArmedAt = Date.now();
        this.containerSawOpenAt = 0;
        this.containerDumpLines = [`reason=${reason}`];
        this.containerDumpInbound = [];
        this.containerDumpAfterOpen = [];
        this.containerDumpSawOpen = false;
        const record = (line: string): void => {
            if (!this.containerDumpArmed) return;
            if (this.containerDumpLines.length >= 24) return;
            const joined = this.containerDumpLines.join(' | ');
            if (joined.length >= 1800) return;
            this.containerDumpLines.push(line);
        };
        // 收包：**所有**入站包都记名字（这才回答"服务端到底说没说话"），
        // 六个窗口包额外记判定字段。
        try {
            this.onContainerIncoming = (data: unknown, meta: { name?: unknown }): void => {
                const name = String(meta?.name ?? '');
                if (name === '') return;
                this.containerDumpInbound.push(name);
                // **合成窗口：内容包到达后 40ms 抓一次槽位快照**（材料进网格/产物取回都看这个）。
                if ((this.containerDumpLabel === 'craft' || this.containerDumpLabel === 'furnace') && /window_items|set_content|container_set_content/i.test(name)) {
                    const snapshot = (): void => {
                        try {
                            const window = (this.bot as any)?.currentWindow;
                            const slots: any[] = Array.isArray(window?.slots) ? window.slots : [];
                            this.containerDumpSlots = slots
                                .map((slot: any, index: number) => ({ slot: index, name: String(slot?.name ?? ''), count: Number(slot?.count ?? 0) }))
                                .filter((entry) => entry.name !== '')
                                .slice(0, 46);
                        } catch {
                            this.containerDumpSlots = null;
                        }
                    };
                    const timer = setTimeout(snapshot, 40);
                    (timer as { unref?: () => void }).unref?.();
                }
                // **开窗之后的头 12 个包按顺序单独留一份**（见 containerDumpAfterOpen 的注释：
                // 这是判断"槽位包到没到"的唯一可靠证据，不能被 24 条上限吃掉）。
                if (/open_window|open_screen/i.test(name)) {
                    this.containerDumpSawOpen = true;
                    this.containerSawOpenAt = Date.now();
                }
                else if (this.containerDumpSawOpen && this.containerDumpAfterOpen.length < 12) {
                    this.containerDumpAfterOpen.push(name);
                }
                if (WINDOW_PACKET_RE.test(name)) {
                    record(`in:${name}${summarizeInboundWindowPacket(name, data)}`);
                    // 槽位包到了才算真"开窗成功"——**别用 open_window 收尾**，否则恰好会
                    // 把紧接着要看的 window_items 挡在门外（那正是要诊断的东西）。
                    if (/window_items|set_content|container_set_content/i.test(name)) {
                        this.finishContainerPacketDump('window-arrived');
                    }
                    return;
                }
                // **catch-all：只记名字，不记载荷**（有界 + 脱敏，但"服务端回过话"
                // 必须看得见——block_change / ack 这类正是"它不认这次交互"的证据）。
                record(`in:${name}`);
            };
            client.on('packet', this.onContainerIncoming);
        } catch {
            // 挂不上就当没武装（不阻塞打开流程）。
            this.containerDumpArmed = false;
            return;
        }
        // 发包：临时包住 write，只记"我们发了什么"。
        try {
            const rawWrite = client.write;
            const original = typeof rawWrite === 'function' ? rawWrite.bind(client) : null;
            if (original != null) {
                client.write = (name: string, params: any): unknown => {
                    if (/block_place|use_item_on|block_dig|arm_animation|close_window|held_item_slot|player_action|entity_action/i.test(String(name))) {
                        const p = params ?? {};
                        const loc = p.location ?? p.position;
                        const bits = [
                            typeof loc?.x === 'number' ? `${Math.round(loc.x)},${Math.round(loc.y)},${Math.round(loc.z)}` : null,
                            p.direction != null ? `dir=${p.direction}` : null,
                            p.sequence != null ? `seq=${p.sequence}` : null,
                            p.hand != null ? `hand=${p.hand}` : null,
                            p.cursorX != null ? `cur=${p.cursorX},${p.cursorY},${p.cursorZ}` : null,
                            p.action != null ? `action=${p.action}` : null,
                        ].filter((x): x is string => x != null);
                        record(`out:${String(name)}(${bits.join(' ')})`);
                    }
                    return original(name, params);
                };
                this.containerDumpRestore = () => {
                    try {
                        client.write = rawWrite;
                    } catch {
                        // 还原失败也不影响后续（只是多记几条）。
                    }
                };
            }
        } catch {
            // 包不住 write 就只留收包证据。
        }
        this.containerDumpTimer = setTimeout(() => this.finishContainerPacketDump('window-expired'), 8_000);
        (this.containerDumpTimer as { unref?: () => void }).unref?.();
    }

    /** 收尾：**一行** lifecycle 日志（成功、超时、或显式解除都走这里，且只走一次）。 */
    finishContainerPacketDump(outcome: string): void {
        if (!this.containerDumpArmed) return;
        this.containerDumpArmed = false;
        if (this.containerDumpTimer != null) {
            clearTimeout(this.containerDumpTimer);
            this.containerDumpTimer = null;
        }
        try {
            const client = (this.bot as { _client?: any } | null)?._client;
            if (client != null && this.onContainerIncoming != null) client.removeListener?.('packet', this.onContainerIncoming);
        } catch {
            // 摘不掉监听不影响日志。
        }
        this.onContainerIncoming = null;
        this.containerDumpRestore?.();
        this.containerDumpRestore = null;
        try {
            const inbound = this.containerDumpInbound.filter((n) => n !== '');
            // **"开窗成功"必须由槽位包判定，不能由开窗包判定。**
            // 真机教训（2026-10-19 03:54）：服务端发了 `open_window(windowId=1)`、我们收到了，
            // 但 `openContainer` 仍然超时——因为 mineflayer 要等槽位数据（`window_items`）
            // 才发 `windowOpen`。旧口径把"开窗包到了"叫 window-arrived，等于**把故障说成成功**。
            const hasSlots = inbound.some((n) => /window_items|set_content|container_set_content/i.test(n));
            const hasOpen = inbound.some((n) => /open_window|open_screen/i.test(n));
            //   window-arrived    = 槽位包到了（mineflayer 真的会发 windowOpen）——问题才可能在我们接包
            //   opened-no-slots   = **服务端开了窗但没给槽位数据** ⇒ 我们必然超时（真机就是这个）
            //   replied-no-window = 回了别的（block_change / ack…）= 它**不认**这次交互
            //   no-reply          = 从头到尾一个字都没回
            const verdict = hasSlots
                ? 'window-arrived'
                : hasOpen
                    ? 'opened-no-slots'
                    : inbound.length === 0
                        ? 'no-reply'
                        : 'replied-no-window';
            // **把"带槽位容器在本服务端不可用"记成一条会过期的结论。**
            // 真机 2026-10-19 04:47 确证：服务端开窗（open_window）但从不发内容
            // （window_items 等），且本进程**零**协议解析错误 ⇒ mineflayer 永不发
            // windowOpen ⇒ 打开槽位容器必然超时。这不是站位/协议问题，重试没有意义。
            // 但结论**必须能自己过期**：真有窗口内容到达（window-arrived）立刻解除，
            // 否则 10 分钟后自动失效——不许让一条旧结论把容器永久焊死。
            if (verdict === 'opened-no-slots') {
                this.slottedContainerBlockedUntil = Date.now() + SLOTTED_CONTAINER_BLOCK_MS;
                // **记下结论是在哪个维度得出的**：主世界"容器打不开"的结论不许直接
                // 短路下界/末地的尝试（这是"跨维度串味"里我们自己能制造的那一种）。
                const dim = (this.bot?.game as { dimension?: unknown })?.dimension;
                this.slottedContainerBlockedDim = typeof dim === 'string' ? dim : null;
                // **结论只属于失败的那一种方块**（真机 2026-10-20：B 报「容器全坏」，
                // 几行后自我纠正「熔炉其实完全可用，21 块玻璃已产出」——箱子失败不等于
                // 熔炉失败，它们是不同路径，不许互相短路）。
                const armReason = String(this.containerDumpReason ?? '');
                this.slottedContainerBlockedFor = armReason.startsWith('useBlock ')
                    ? armReason.slice('useBlock '.length).trim()
                    : null;
                this.slottedContainerBlockedReason =
                    '服务端开窗但不发内容（open_window 到了，window_items/set_content 一个都没有，且本进程零协议解析错误）';
            } else if (verdict === 'window-arrived') {
                this.slottedContainerBlockedUntil = 0;
                this.slottedContainerBlockedReason = null;
                this.slottedContainerBlockedDim = null;
            }
            // **合成窗口的单行结论**（Lead 2026-10-19 ①）：crafting 走 `bot.craft`，
            // 不经过 `openBlockUi`，所以必须单独出一行——否则工作台 0/4 没有任何证据，
            // 就分不清"(a) 两条 crafting 实现一条死"和"(b) 窗口偶发无内容"。
            if (this.containerDumpLabel === 'furnace') {
                this.log.with('lifecycle').info({
                    event: 'furnace-window-diagnosis',
                    outcome,
                    verdict,
                    openWindow: this.containerDumpSawOpen,
                    contents: inbound.some((n) => /window_items|set_content|container_set_content/i.test(n)),
                    slots: this.containerDumpSlots,
                });
            }
            if (this.containerDumpLabel === 'craft') {
                this.log.with('lifecycle').info({
                    event: 'craft-window-diagnosis',
                    recipe: this.containerDumpReason,
                    // **槽位快照**：材料进了网格？产物槽里有没有东西？（读不到 = null，不猜）
                    slots: this.containerDumpSlots,
                    outcome,
                    verdict,
                    openWindow: this.containerDumpSawOpen,
                    contents: inbound.some((n) => /window_items|set_content|container_set_content/i.test(n)),
                    protocolFaults: this.protocolFaultCount,
                    inboundNames: [...new Set(inbound)].slice(0, 12),
                });
            }
            this.log.with('lifecycle').info({
                event: 'container-packet-dump',
                outcome,
                verdict,
                inboundNames: [...new Set(inbound)].slice(0, 24),
                inboundCount: inbound.length,
                // **开窗之后紧跟着来的包（定序、不截断）**：`sawOpen=false` ⇒ 服务端没发开窗包；
                // `sawOpen=true` 而这一串里没有 `window_items`/`container_set_content` ⇒
                // 服务端开了窗却没发槽位数据（mineflayer 因此永不发 windowOpen，我们必然超时）。
                sawOpen: this.containerDumpSawOpen,
                // **错误有没有真的发生、发生在这段时间里没有**（回答 Lead 的 ①）：
                //   protocolFaultsTotal        = 本进程一共抓到几条解析类错误（含开容器之外的）
                //   protocolFaultsDuringAttempt= 落在这次开容器尝试窗口里的条数（>0 才是"这次真的崩了解析"）
                //   lastFault                   = 最近一条（via/包id/距 open_window 多少毫秒）
                protocolFaultsTotal: this.protocolFaultCount,
                protocolFaultsDuringAttempt:
                    this.protocolFault == null || this.containerAttemptArmedAt === 0
                        ? 0
                        : this.protocolFault.at >= this.containerAttemptArmedAt
                            ? 1
                            : 0,
                lastFault: this.protocolFault,
                afterOpen: this.containerDumpAfterOpen,
                lines: this.containerDumpLines,
            });
        } catch {
            // 日志失败不能影响动作。
        }
        this.containerDumpLines = [];
        this.containerDumpInbound = [];
        this.containerDumpAfterOpen = [];
        this.containerDumpSawOpen = false;
    }

    private onContainerIncoming: ((data: unknown, meta: { name?: unknown }) => void) | null = null;

    /**
     * **协议解析失败**（protodef 的 `PartialReadError`）——真机 2026-10-19 03:54 的
     * 最终根因：服务端**发了** `open_window(windowId=1)`，但紧随其后的**窗口内容包
     * 解不开**，于是 `'packet'` 事件根本不触发 → mineflayer 的 `prepareWindow` 等
     * `setWindowItems:<id>` → `windowOpen` 永不触发 → `openContainer` 必然超时。
     *
     * 为什么必须单独记：解析失败的包**在转储里是不可见的**（监听器根本没被调用），
     * 所以"没看到 window_items"会被误读成"服务端没发"——这是仪器撒谎的第三种形态。
     */
    private protocolFault: {
        at: number;
        message: string;
        packetId: number | null;
        bytesHex: string;
        /** 从哪条路抓到的：client-error / deserializer-error / uncaught。 */
        via: string;
    } | null = null;
    /** "带槽位容器在本服务端不可用"结论的过期时刻；0 = 当前没被判定为坏。 */
    /** 这次转储是开容器还是合成窗口（合成走 bot.craft，不经过 openBlockUi）。 */
    private containerDumpLabel: 'container' | 'craft' | 'furnace' = 'container';
    private containerDumpReason = '';
    /** 合成窗口的**槽位实测快照**（craft 报 ok 但背包不变时，这是唯一能看穿"材料进网格、产物没取回"的仪器）。 */
    private containerDumpSlots: Array<{ slot: number; name: string; count: number }> | null = null;
    /** 上一条容器结论是针对**哪种方块**的（不同容器类型是不同路径，不许互相短路）。 */
    private slottedContainerBlockedFor: string | null = null;
    private slottedContainerBlockedUntil = 0;
    /** 上一条容器不可用结论是在哪个维度得出的（跨维度不串用）。 */
    private slottedContainerBlockedDim: string | null = null;
    private slottedContainerBlockedReason: string | null = null;
    /** 一次逃生里刹车了几次 + 上一次刹车回执（重复内容不重播，见 shouldEmitFallNotice）。 */
    private fallBrakeNotices = 0;
    private lastFallNotice: { key: string; at: number } | null = null;
    /** 上一次"无法自愈"提示的时间 + 进入该状态的时刻（去重 + 报"已持续多久"）。 */
    private unrecoverableNotice: { at: number } | null = null;
    private unrecoverableSince = 0;
    /** 最近一次死亡时刻（刺激"刚死且身上空"的逃生交还判定）+ 进度回执节流。 */
    private lastDeathAt = 0;
    private escapeProgressAt = 0;
    /** 三方互锁的呼吸反射临时停用截止时间（只停 surface 一条，见 deadlock.ts）。 */
    private surfaceStandDownUntil = 0;
    /** 位置卡住追踪：上次采样 + 最近一次"动过"的时刻。 */
    private lastPosSample: { x: number; y: number; z: number; at: number } | null = null;
    private lastMovedAt = 0;
    /** 最近 3 分钟里呼吸反射触发的时刻（三方互锁的证据）。 */
    private surfaceTriggerTimes: number[] = [];
    /** 击杀后拾取优先窗口的截止时刻 + 最近一次受伤时刻（保命优先于捡东西）。 */
    private pickupPriorityUntil = 0;
    /** 动作失败/被 Stop 打断时，收尾清扫的说明（接在失败回执末尾）。 */
    private actionTailNote: string | null = null;
    private lastDamageAt = 0;

    /** 本进程里一共抓到几条解析类错误（**不管有没有在开容器**）。 */
    private protocolFaultCount = 0;
    /** 最近一次"开容器尝试"的武装时刻；用来回答"错误是不是发生在这次尝试期间"。 */
    private containerAttemptArmedAt = 0;
    /** `open_window` 到达时刻（武装期间），用于时间关联。 */
    private containerSawOpenAt = 0;
    private faultCaptureInstalled = false;

    /**
     * **把抓错点铺到所有可能的出口上**（真机 2026-10-19 04:20：hook 在一个新尝试里
     * 一次都没触发，但那不等于"错误没发生"——先要排除"错误没走这条路"）。
     *
     * 三条独立出口，任何一条先到都算：
     *   1. `client.on('error')`（nmp `client.js` 的 deserializer handler 会 `emit('error')`）；
     *   2. `client.deserializer.prependListener('error')`——**在 nmp 自己的 handler 之前**，
     *      万一 nmp 的 handler 自己抛（比如 `e.field` 为 undefined 时 `.split` 崩），这条仍有记录；
     *   3. `process.on('uncaughtExceptionMonitor')`——只在监听、绝不吞异常，用来抓
     *      "错误被打印到 stdout 但没经过我们 hook"的那种形态。
     * 同一错误（同 message 且 1 秒内）只记一次。
     */
    installProtocolFaultCapture(): void {
        if (this.faultCaptureInstalled) return;
        const client = (this.bot as { _client?: any } | null)?._client;
        if (client == null) return;
        this.faultCaptureInstalled = true;
        const capture = (err: unknown, via: string): void => this.onProtocolFault(err, via);
        try {
            client.on?.('error', (err: unknown) => capture(err, 'client-error'));
        } catch {
            // 这条挂不上还有别的。
        }
        try {
            const deserializer = client.deserializer;
            // prependListener：排在 nmp 自己的 handler **之前**，它抛也影响不到这条。
            deserializer?.prependListener?.('error', (err: unknown) => capture(err, 'deserializer-error'));
        } catch {
            // 同上。
        }
        try {
            // 只监听不处理：绝不影响进程崩溃语义（monitor 不会被被吞掉）。
            process.on('uncaughtExceptionMonitor', (err: unknown) => capture(err, 'uncaught'));
        } catch {
            // 某些沙箱不允许挂 process 监听，忽略。
        }
    }

    /** 客户端 deserializer 抛错时调用：只留**一行**、有界、脱敏。 */
    onProtocolFault(err: unknown, via = 'client-error'): void {
        try {
            const e = err as { name?: unknown; message?: unknown; partialReadError?: any; id?: unknown; packetId?: unknown };
            const message = String(e?.message ?? err ?? '');
            const isPartial =
                /PartialReadError|Read error for|Parse error for/i.test(String(e?.name ?? '')) ||
                /Read error for|Parse error for|PartialReadError/i.test(message);
            if (!isPartial) return;
            const last = this.protocolFault;
            if (last != null && last.message === message.slice(0, 160) && Date.now() - last.at < 1_000) return;
            const detail = e?.partialReadError ?? {};
            const buffer: unknown = detail?.buffer ?? (e as { buffer?: unknown })?.buffer;
            let bytesHex = '';
            try {
                const slice = (buffer as { slice?: unknown } | null | undefined)?.slice;
                if (buffer != null && typeof slice === 'function') {
                    bytesHex = Buffer.from((buffer as Buffer).slice(0, 24)).toString('hex');
                }
            } catch {
                bytesHex = '';
            }
            // 解析失败的包**不会触发 'packet'**，所以包 id 只能从残留字节里读：
            // nmp 的包体头部就是 varint(packetId)，第一个字节通常是 id（<128 时）。
            let idGuess: number | null = null;
            try {
                if (buffer != null) {
                    const head = Buffer.from((buffer as Buffer).slice(0, 5));
                    let value = 0;
                    let shift = 0;
                    for (const byte of head) {
                        value |= (byte & 0x7f) << shift;
                        if ((byte & 0x80) === 0) break;
                        shift += 7;
                        if (shift > 28) break;
                    }
                    if (Number.isFinite(value) && value >= 0 && value < 512) idGuess = value;
                }
            } catch {
                idGuess = null;
            }
            const idRaw = Number(e?.packetId ?? e?.id ?? detail?.packetId ?? detail?.id ?? idGuess);
            this.protocolFaultCount = (Number(this.protocolFaultCount) || 0) + 1;
            this.protocolFault = {
                at: Date.now(),
                message: message.slice(0, 160),
                packetId: Number.isFinite(idRaw) ? idRaw : null,
                bytesHex,
                via,
            };
            try {
                this.log.with('lifecycle').info({
                    event: 'container-protocol-fault',
                    error: this.protocolFault.message,
                    packetId: this.protocolFault.packetId,
                    firstBytesHex: this.protocolFault.bytesHex,
                    via,
                    total: this.protocolFaultCount,
                    duringContainerAttempt:
                        this.containerAttemptArmedAt > 0 && this.protocolFault.at >= this.containerAttemptArmedAt,
                    msAfterOpenWindow: this.containerSawOpenAt > 0 ? this.protocolFault.at - this.containerSawOpenAt : null,
                });
            } catch {
                // 日志失败不影响判定。
            }
            // 正在录转储就把这条也记进去并收尾（这是"为什么看不见槽位包"的直接答案）。
            if (this.containerDumpArmed) {
                try {
                    this.containerDumpLines.push(`fault:PartialReadError(${this.protocolFault.message})`);
                } catch {
                    // 记不进去也要收尾。
                }
                this.finishContainerPacketDump('protocol-parse-error');
            }
        } catch {
            // 故障记录本身绝不允许抛出。
        }
    }

    /** 最近的协议解析故障（默认 15 秒内有效）；给回执层判定"这不是服务端没响应"。 */
    recentProtocolFault(withinMs = 15_000): { message: string; packetId: number | null } | null {
        const fault = this.protocolFault;
        if (fault == null) return null;
        if (Date.now() - fault.at > withinMs) return null;
        return { message: fault.message, packetId: fault.packetId };
    }

    /**
     * 带槽位容器现在还能不能试：**最近的失败结论会短路它**（快速失败，不烧 45 秒 + 重试）。
     * 结论带 TTL，且一旦有窗口内容真的到达就会被清掉（见 finishContainerPacketDump）。
     */
    slottedContainerStatus(askingFor?: string | null): { blocked: boolean; reason: string | null; msLeft: number } {
        const left = Math.max(0, this.slottedContainerBlockedUntil - Date.now());
        // **只在同一维度里生效**：跨维度不串用旧结论（主世界打不开箱子，不许直接
        // 短路下界/末地的尝试——这是"跨维度串味"里我们自己能制造的那一种）。
        const here = (this.bot?.game as { dimension?: unknown })?.dimension;
        if (
            left > 0 &&
            this.slottedContainerBlockedDim != null &&
            typeof here === 'string' &&
            this.slottedContainerBlockedDim !== here
        ) {
            return { blocked: false, reason: null, msLeft: 0 };
        }
        // **不同类型不互相短路**：上次失败的是箱子，熔炉/合成台照试
        // （真机 2026-10-20：B 报「容器全坏」，随后自我纠正「熔炉可用，21 块玻璃已产出」）。
        if (
            left > 0 &&
            this.slottedContainerBlockedFor != null &&
            typeof askingFor === 'string' &&
            askingFor !== '' &&
            askingFor !== this.slottedContainerBlockedFor
        ) {
            return { blocked: false, reason: null, msLeft: 0 };
        }
        return {
            blocked: left > 0,
            reason: left > 0 ? this.slottedContainerBlockedReason : null,
            msLeft: left,
        };
    }

    /**
     * 重伤时拒掉**进攻类**动作（在身体动手之前），返回要退回给模型的文本；允许则 null。
     *
     * 真机 2026-10-19（overnight_b，下界第 8 次死亡）：血 **1.53**、食物 4，模型正在
     * `attack`——"attack 成功"的回执让它以为一切正常。反射只在挨打之后才接管，
     * **拦不住"濒死时主动开打"**这个选择。这条守卫只拦进攻：
     * 逃跑/吃/垫方块/自救/保命反射一律放行（绝不让守卫削弱"跑得掉"的能力）。
     */
    criticalHealthRefusalFor(toolName: string): string | null {
        try {
            if (!OFFENSIVE_TOOL_NAMES.has(String(toolName ?? ''))) return null;
            const bot = this.bot as { health?: unknown; food?: unknown } | null;
            const health = Number(bot?.health);
            const food = Number(bot?.food);
            const gameplay = (settings as any)?.gameplay ?? {};
            const keepInventory =
                gameplay.keepInventoryOnDeath === true ? true : gameplay.keepInventoryOnDeath === false ? false : null;
            const immediateRespawn =
                gameplay.doImmediateRespawn === true ? true : gameplay.doImmediateRespawn === false ? false : null;
            const verdict = combatRefusalVerdict({
                health: Number.isFinite(health) ? health : null,
                food: Number.isFinite(food) ? food : null,
                // 只做"附近有没有威胁"的粗判：读不到就是 null（不拿它当理由）。
                hostileMeters: this.nearestHostileMeters(),
                // **背包里有没有吃的**：有 ⇒ 回执必须先让模型吃，而不是先谈"故意死一次"
                // （Lead 2026-10-19：把死亡写进回执是最有效的人工干预，但也可能造出
                // "有食物却去送死"这个新失败模式——所以这两种情况的措辞必须不同）。
                foodItems: (() => {
                    try {
                        return ((this.bot as any)?.inventory?.items?.() ?? [])
                            .map((item: any) => String(item?.name ?? ''))
                            .filter((name: string) => name !== '' && FOOD_VALUE[name] != null);
                    } catch {
                        return null;
                    }
                })(),
                keepInventory,
                immediateRespawn,
            });
            if (!verdict.allowed) {
                // **一行有界日志**：真机出现"有食物却去送死"时，这一行能直接给出证据
                // （血量/食物/威胁/背包里有什么吃的），不用等到早上看复盘。
                try {
                    this.log.with('lifecycle').info({
                        event: 'combat-refusal',
                        tool: String(toolName ?? ''),
                        health: Number.isFinite(health) ? health : null,
                        food: Number.isFinite(food) ? food : null,
                        hostileMeters: this.nearestHostileMeters(),
                        foodItems: (() => {
                            try {
                                return ((this.bot as any)?.inventory?.items?.() ?? [])
                                    .map((item: any) => String(item?.name ?? ''))
                                    .filter((name: string) => name !== '' && FOOD_VALUE[name] != null)
                                    .slice(0, 5);
                            } catch {
                                return null;
                            }
                        })(),
                    });
                } catch {
                    // 日志失败不影响拒绝本身。
                }
            }
            return verdict.allowed ? null : verdict.text;
        } catch {
            // 守卫自己出错时**放行**（不能因为守卫坏了让模型动不了）。
            return null;
        }
    }

    /**
     * **出发前准备检查**（`enterEnd` / `enterNether`）：返回 `{text}` = 拒绝文本。
     *
     * 只拦"进入"这两个工具；已经在目标维度、出口类工具、逃跑、保命反射都不受影响。
     * **武器在背包里但没拿在手上 ⇒ 帮它 `equip` 再放行**（能救就救，不当成拒绝理由）。
     */
    async departureCheckFor(toolName: string): Promise<{ text: string | null; warning?: string }> {
        try {
            const tool = String(toolName ?? '');
            if (!DEPARTURE_TOOLS.has(tool)) return { text: null };
            const bot = this.bot as any;
            const target = targetDimensionOf(tool);
            let dimension: string | null = null;
            try {
                dimension = typeof bot?.game?.dimension === 'string' ? bot.game.dimension : null;
            } catch {
                dimension = null;
            }
            if (dimension != null && target != null && dimension.toLowerCase().includes(target)) {
                return { text: null }; // 已经在里面：这不是"进入"
            }
            // **背包读不到 ≠ 背包是空的**：读失败就放行（不能让守卫因为读不到把人困住）。
            const items: Array<{ name?: unknown; count?: unknown }> | null = (() => {
                try {
                    return (bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown; count?: unknown }>;
                } catch {
                    return null;
                }
            })();
            if (items == null) return { text: null };
            const weapon = items.find((item) => isWeaponName(item?.name)) ?? null;
            const heldNameOf = (): string => {
                try {
                    return String(bot?.heldItem?.name ?? '');
                } catch {
                    return '';
                }
            };
            // **能救就救**：武器在背包里但没拿在手上 ⇒ 先帮它拿上，再判定。
            // （这不是"拒绝理由"——空手进末地才是。）
            if (weapon != null && !isWeaponName(heldNameOf())) {
                try {
                    await bot.equip(weapon, 'hand');
                } catch {
                    // 拿不上就继续判定（真没武器在手上才拒）。
                }
            }
            const heldName = heldNameOf();
            const blocks = (() => {
                try {
                    let total = 0;
                    let known = false;
                    for (const item of items) {
                        const name = String(item?.name ?? '');
                        const def = bot?.registry?.blocksByName?.[name];
                        if (def == null || def.boundingBox !== 'block') continue;
                        known = true;
                        total += Number(item?.count ?? 0) || 0;
                    }
                    return known ? total : null;
                } catch {
                    return null;
                }
            })();
            const health = Number(bot?.health);
            const food = Number(bot?.food);
            const facts = {
                tool,
                dimension,
                health: Number.isFinite(health) ? health : null,
                food: Number.isFinite(food) ? food : null,
                // 拿在手上算数；拿不上但包里有，也算"有武器"（模型只要 equip 就能用）。
                weapon: isWeaponName(heldName) ? heldName : typeof weapon?.name === 'string' ? weapon.name : null,
                blocks,
            };
            const verdict = departureVerdict(facts);
            if (!verdict.allowed) {
                // 一行有界日志：以后能回答"这道门拦对了，还是拦下了一个准备好的 bot？"
                try {
                    this.log.with('lifecycle').info({
                        event: 'departure-refusal',
                        tool,
                        weapon: facts.weapon,
                        food: facts.food,
                        blocks: facts.blocks,
                        health: facts.health,
                    });
                } catch {
                    // 日志失败不影响拒绝。
                }
                return { text: verdict.text ?? `**拒绝进${tool === 'enterEnd' ? '末地' : '下界'}**：准备不足。` };
            }
            return { text: null, warning: verdict.warning };
        } catch {
            // 守卫自己坏了 ⇒ 放行（不能让模型因为守卫出错而走不了）。
            return { text: null };
        }
    }

    /**
     * 两次背包账目之间的差异（拾取路径用）。
     *
     * 只报**变化**；读数不可用（未同步/读失败）时说"读不到"，**绝不**把它当成"没变化"。
     * 名字最多列 8 项，避免长跑进程里刷屏。
     */
    private describeInventoryDelta(
        before: InventoryCounts | null,
        after: InventoryCounts | null,
        targetName: string,
    ): { changed: boolean; gained: string[]; lost: string[]; note: string } {
        if (before == null || after == null) {
            return {
                changed: false,
                gained: [],
                lost: [],
                note: `读数不可用（${before == null ? '之前' : '之后'}读不到，可能是刚重连还没同步）——不能据此判断捡没捡到`,
            };
        }
        const names = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
        const gained: string[] = [];
        const lost: string[] = [];
        for (const name of names) {
            const delta = (after[name] ?? 0) - (before[name] ?? 0);
            if (delta > 0) gained.push(`+${name}×${delta}`);
            else if (delta < 0) lost.push(`-${name}×${-delta}`);
        }
        const changed = gained.length > 0 || lost.length > 0;
        const targetGain = (after[targetName] ?? 0) - (before[targetName] ?? 0);
        const parts: string[] = [];
        if (gained.length > 0) parts.push(`增加 ${gained.slice(0, 8).join('、')}`);
        if (lost.length > 0) parts.push(`**减少 ${lost.slice(0, 8).join('、')}**`);
        if (lost.length > 0) {
            parts.push('（**有物品减少**——这不是"没捡到"，是背包真的被改动了，先用 stats 核对再行动）');
        } else if (targetGain <= 0) {
            parts.push('（目标物品并没有增加）');
        }
        return { changed, gained, lost, note: parts.join('') };
    }

    /**
     * **"僵尸状态"检测**：活着但无法自愈（血 ≤4、食物 0、背包无食物）。
     *
     * **纯建议，不是锁**：不拦任何工具、不动身体、不取消反射；只是把状态和一个
     * 有条件的出口说清楚。是否推荐"主动死"完全取决于**当场**读到的 `keepInventory`：
     * true 才说；false 或读不到 ⇒ 明说"不要主动死"并指向找吃的（见 unrecoverable.ts）。
     */
    checkUnrecoverableState(): void {
        try {
            const bot = this.bot as { health?: unknown; food?: unknown } | null;
            const health = Number(bot?.health);
            const food = Number(bot?.food);
            if (!Number.isFinite(health) || !Number.isFinite(food)) return;
            if (health > 4 || food > 0) {
                // 离开状态 ⇒ 清掉去重记录，下次再进入能立刻说。
                this.unrecoverableNotice = null;
                this.unrecoverableSince = 0;
                return;
            }
            const names = (() => {
                if (this.inventorySynced === false) return null; // 未同步 ⇒ 不判定
                try {
                    return ((bot as any)?.inventory?.items?.() ?? []).map((item: any) => String(item?.name ?? ''));
                } catch {
                    return null;
                }
            })();
            if (names == null) return;
            const gameplay = (settings as any)?.gameplay ?? {};
            const keepInventory =
                gameplay.keepInventoryOnDeath === true ? true : gameplay.keepInventoryOnDeath === false ? false : null;
            const immediateRespawn =
                gameplay.doImmediateRespawn === true ? true : gameplay.doImmediateRespawn === false ? false : null;
            if (this.unrecoverableSince === 0) this.unrecoverableSince = Date.now();
            const elapsedSec = Math.round((Date.now() - this.unrecoverableSince) / 1000);
            const verdict = unrecoverableVerdict({
                health,
                food,
                itemNames: names,
                keepInventory,
                immediateRespawn,
                elapsedSec,
            });
            if (!verdict.unrecoverable || verdict.advice == null) return;
            const now = Date.now();
            if (!shouldEmitUnrecoverable(this.unrecoverableNotice, now)) return;
            this.unrecoverableNotice = { at: now };
            // 一行有界证据：以后能回答"多常进入这个状态、以及它们有没有走那个出口"。
            try {
                this.log.with('lifecycle').info({
                    event: 'unrecoverable-state',
                    health,
                    food,
                    foodItems: names.filter((itemName: string) => isEdibleName(itemName)).slice(0, 5),
                    keepInventory,
                    elapsedSec,
                });
            } catch {
                // 日志失败不影响建议。
            }
            void this.writeAdvice(verdict.advice);
        } catch {
            // 检测自身出错绝不影响身体。
        }
    }

    /** 把一段建议写进 bot.output（模型下一轮就能看到）；不拦任何工具。 */
    private async writeAdvice(text: string): Promise<void> {
        try {
            const bot = this.bot as { output?: unknown } | null;
            if (bot == null) return;
            if (typeof bot.output !== 'string') (bot as { output?: string }).output = '';
            (bot as { output: string }).output += `\n${text}\n`;
        } catch {
            // 写不进去也不影响别的。
        }
    }

/**
     * **三方互锁的事实**：只有全部可读、且都成立时才算"真的出不去"。
     * 任何一项读不到 ⇒ 返回 null ⇒ 拒绝照旧（不许拿读不到当放行理由）。
     */
    deadlockFacts(): DeadlockFacts | null {
        try {
            const bot = this.bot as any;
            const health = Number(bot?.health);
            const food = Number(bot?.food);
            if (!Number.isFinite(health) || !Number.isFinite(food)) return null;
            if (this.inventorySynced === false) return null;
            const items = ((bot?.inventory?.items?.() ?? []) as Array<{ name?: unknown }>).map((item) =>
                String(item?.name ?? ''),
            );
            const hasDigTool = items.some((name) =>
                ['_pickaxe', '_shovel', '_axe', '_hoe'].some((suffix) => name.endsWith(suffix)),
            );
            // 身边（含脚下）有没有可挖的方块：镐子有没有先不管，这里只回答"挖出去这条路成立吗"。
            const p = bot?.entity?.position;
            const hasDiggableNeighbour = (() => {
                if (p == null) return false;
                const base = { x: Math.floor(Number(p.x)), y: Math.floor(Number(p.y)), z: Math.floor(Number(p.z)) };
                for (const d of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) {
                    const b = bot.blockAt?.(new Vec3(base.x + d[0]!, base.y + d[1]!, base.z + d[2]!));
                    const name = String(b?.name ?? '');
                    if (name === '' || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
                    if (name === 'bedrock' || name === 'lava' || name === 'water') continue;
                    return true;
                }
                return false;
            })();
            const now = Date.now();
            const window = this.surfaceTriggerTimes.filter((at) => now - at <= 180_000);
            const gameplay = (settings as any)?.gameplay ?? {};
            const keepInventory =
                gameplay.keepInventoryOnDeath === true ? true : gameplay.keepInventoryOnDeath === false ? false : null;
            const immediateRespawn =
                gameplay.doImmediateRespawn === true ? true : gameplay.doImmediateRespawn === false ? false : null;
            return {
                stuckSec: this.lastMovedAt > 0 ? Math.round((now - this.lastMovedAt) / 1000) : 0,
                health,
                food,
                hasDigTool,
                hasDiggableNeighbour,
                surfaceTriggers: window.length,
                keepInventory,
                immediateRespawn,
            };
        } catch {
            return null;
        }
    }

    /** **只停呼吸反射**这么多毫秒（三方互锁的唯一出口）；带响亮日志与自动恢复。 */
    enableSurfaceStandDown(ms: number): void {
        const bounded = Math.min(Math.max(1_000, Math.floor(ms)), 60_000);
        const until = Date.now() + bounded;
        this.surfaceStandDownUntil = Math.max(this.surfaceStandDownUntil, until);
        try {
            this.log.with('lifecycle').info({
                event: 'deadlock-override-granted',
                scope: 'surface',
                ms: bounded,
                health: Number((this.bot as any)?.health ?? null),
                food: Number((this.bot as any)?.food ?? null),
            });
        } catch {
            // 日志失败不影响放行。
        }
        // 自动恢复（有界；到点后呼吸反射照旧）。
        const timer = setTimeout(() => {
            try {
                this.log.with('lifecycle').info({ event: 'deadlock-override-reverted', scope: 'surface' });
            } catch {
                // 同上。
            }
        }, bounded);
        (timer as { unref?: () => void }).unref?.();
    }

    /** 位置卡住追踪：每次采样路径更新一次（用来算"同一坐标多久没动"）。 */
    trackPositionStuck(): void {
        try {
            const p = (this.bot as any)?.entity?.position;
            if (p == null) return;
            const now = Date.now();
            const here = { x: Math.floor(Number(p.x)), y: Math.floor(Number(p.y)), z: Math.floor(Number(p.z)) };
            if (this.lastPosSample == null) {
                this.lastPosSample = { ...here, at: now };
                this.lastMovedAt = now;
                return;
            }
            const moved =
                here.x !== this.lastPosSample.x || here.y !== this.lastPosSample.y || here.z !== this.lastPosSample.z;
            if (moved) this.lastMovedAt = now;
            this.lastPosSample = { ...here, at: now };
        } catch {
            // 追踪失败不影响别的。
        }
    }

/**
     * **void 预检**（走路工具专用）：拒绝"必须跨越无支撑空间"的 `move`/`goToCoordinates`。
     * 边界见 `void_walk.ts`：搭桥工具不受影响；空中不拦；读不到方块就不拦。
     */
    private voidWalkRefusalFor(toolName: string, args: Record<string, unknown>): string | null {
        const name = stripBang(toolName);
        if (name !== 'move' && name !== 'goToCoordinates') return null;
        try {
            const p = (this.bot as any)?.entity?.position;
            if (p == null) return null;
            const velocityY = Number((this.bot as any)?.entity?.velocity?.y ?? 0);
            const airborne =
                Number.isFinite(velocityY) && velocityY < -0.5 ? true : (this.bot as any)?.entity?.onGround === false;
            // 两种工具的坐标参数形状不同：move 用 direction/distance，goToCoordinates 用 xyz。
            // move 的方向语义我们**不在这里猜**（它可能相对朝向），所以只对 goToCoordinates
            // 做点位预检；move 留空并交给到达时的支撑检查（见 goToPosition）。
            const target =
                name === 'move'
                    ? null
                    : {
                          x: Number(args.x),
                          y: Number(args.y),
                          z: Number(args.z),
                      };
            if (target == null || ![target.x, target.y, target.z].every((v) => Number.isFinite(v))) return null;
            const verdict = voidWalkVerdict({
                tool: name,
                from: { x: p.x, y: p.y, z: p.z },
                to: target,
                blockAt: (bx, by, bz) => (this.bot as any).blockAt?.(new Vec3(bx, by, bz)) ?? null,
                airborne,
            });
            return verdict.refuse ? verdict.text : null;
        } catch {
            // 预检自己出错就不拦（不许让守卫的 bug 变成新的墙）。
            return null;
        }
    }

    /**
     * **有没有验证过的逃跑落点**（真机 2026-10-20：escape 把一个 bot 从 (28,60,15) "横移到
     * 实心落点"，结果跑到 (-65,65,-24)、连死三次——落点"实心"不等于"安全"）。
     * 判据：脚下实心 + 不是岩浆/水 + **附近没有敌对生物**（isHostile，mcdata category 权威）。
     * 读不到就返回 true（守卫坏了不许变成新的墙）。
     */
    hasVerifiedEscapeDestination(): boolean {
        try {
            const bot = this.bot;
            const p = bot?.entity?.position;
            if (p == null) return true;
            const from = { x: p.x, y: p.y, z: p.z };
            const blockAt = (bx: number, by: number, bz: number): { name?: unknown } | null =>
                bot.blockAt(new Vec3(bx, by, bz));
            // 朝"远离最近威胁"的方向找，但**候选必须没有怪**才作数。
            const threat = this.threatNearRelative(16);
            const away = threat == null ? { x: from.x + 1, y: from.y, z: from.z } : { x: from.x - (from.x - (from.x + 1)), y: from.y, z: from.z };
            const safe = chooseSafeFleeTarget(blockAt, from, away, 6);
            if (!safe.ok) return false;
            const under = blockAt(safe.target.x, safe.target.y - 1, safe.target.z)?.name;
            const underName = String(under ?? '');
            if (underName === 'lava' || underName === 'flowing_lava' || underName === 'water' || underName === 'flowing_water') {
                return false;
            }
            return this.threatNear({ x: safe.target.x, y: safe.target.y, z: safe.target.z }, 8) == null;
        } catch {
            return true;
        }
    }

    /** 该立刻交还身体吗：**刚死过、身上没东西**时再逃只是再死一次（Hard 档掉光装备）。 */
    escapeYieldVerdict(): { yield: boolean; reason: string } | null {
        try {
            if (this.lastDeathAt > 0 && Date.now() - this.lastDeathAt <= 120_000) {
                const items = this.bot?.inventory?.items?.() ?? [];
                if (items.length === 0) {
                    return { yield: true, reason: 'empty-after-death' };
                }
            }
            if (this.reflexAbortRequested === true) return { yield: true, reason: 'aborted' };
            return null;
        } catch {
            return null;
        }
    }

    /** 进度/放弃回执：32 秒只看到一句 "in_progress" 等于把模型蒙住眼睛。 */
    reportEscapeProgress(info: { step: number; ms: number; health: number; safeDestination: boolean; final: string | null }): void {
        try {
            const nowMs = Date.now();
            if (info.final == null && nowMs - this.escapeProgressAt < 5_000) return;
            this.escapeProgressAt = nowMs;
            if (info.final == null) {
                const detail =
                    `escape 第 ${info.step} 步 / 已用 ${Math.round(info.ms / 1000)} 秒 / 血 ${Math.round(info.health * 10) / 10} / ` +
                    (info.safeDestination ? '正在朝验证过的落点撤' : '**还没有验证过安全的落点**（不会盲目横移）') +
                    '。急的话先 Stop，身体立刻归你。';
                this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                    reflex: this.currentReflexName ?? 'escape',
                    outcome: 'in_progress',
                    detail,
                    ms: info.ms,
                });
                return;
            }
            const reason = info.final;
            const next =
                reason === 'no-safe-destination-and-losing-health'
                    ? '下一步：`stop()` 确认身体在你手上，然后**挖洞自封**（mineBlock 脚下/侧身一格）或用 `placeHere` 把入口封住；别继续朝开阔地跑。'
                    : reason.startsWith('yield:empty-after-death')
                      ? '下一步：你已经死过且身上没东西了，**不要再重试同一条逃生链**；先 respawn 后收装备、再决定去哪。'
                      : '下一步：`stop()` 接管身体；要么挖洞自封，要么用 placeHere 放方块挡出一条路，再决定往哪跑。';
            this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                reflex: this.currentReflexName ?? 'escape',
                outcome: 'in_progress',
                detail: `**escape 放弃并交还身体**（${Math.round(info.ms / 1000)} 秒 / ${info.step} 步，原因：${reason}）。` + next,
                ms: info.ms,
            });
        } catch {
            // 回执失败不影响交还身体。
        }
    }

    /** 最近的敌对生物距离（米）；读不到 / 没有 = null。 */
    private nearestHostileMeters(): number | null {
        try {
            const self = (this.bot as any)?.entity;
            const pos = self?.position;
            let best: number | null = null;
            for (const raw of Object.values((this.bot as any)?.entities ?? {}) as any[]) {
                if (raw == null || raw.id === self?.id) continue;
                if (!isHostile(raw)) continue;
                const p = raw.position ?? {};
                const meters = Math.hypot(Number(p.x) - Number(pos?.x), Number(p.y) - Number(pos?.y), Number(p.z) - Number(pos?.z));
                if (Number.isFinite(meters) && (best == null || meters < best)) best = meters;
            }
            return best;
        } catch {
            return null;
        }
    }

    /** 背包数据到过一次了（服务端 window_items / heldItemChanged 触发）。 */
    private markInventorySynced(): void {
        if (this.inventorySynced) return;
        this.inventorySynced = true;
        try {
            (this.bot as { __inventorySynced?: boolean }).__inventorySynced = true;
        } catch {
            // 挂不上不影响身体自己的判断。
        }
        try {
            this.log.with('lifecycle').info({ event: 'inventory-synced' });
        } catch {
            // 日志失败不影响同步状态。
        }
    }

    /**
     * **等背包第一次同步**（有界）。
     *
     * 刚连上时立刻采样会读到"空包"——真机里模型据此以为丢了全部家当。
     * 这里最多等 `ms`，等到就是真数据，等不到就让调用方如实报"还没同步"。
     * 只在**报告**路径上用（sample）；动作路径不能因为等它而拖延。
     */
    async waitForInventorySync(ms = 1500): Promise<boolean> {
        if (this.inventorySynced) return true;
        const deadline = Date.now() + Math.max(0, ms);
        while (Date.now() < deadline) {
            if (this.inventorySynced) return true;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        return this.inventorySynced;
    }

    isIdle(): boolean {
        return !this.bodyBusy();
    }

    /**
     * 身体此刻有没有人在用。
     *
     * 来源只有模型的动作（`actions.executing`）——身体的自主反射（保命上浮、
     * 走过去捡东西）不算"占用"：它们是本能的兜底，模型要用身体时它们让位。
     *
     * 两个反射必须靠它避开——主线注释明写"模型正在干活就不抢方向盘"
     * 和"正在跑容器动作时绝不能碰"，那两条都是**正确性**要求，不是优化。
     */
    private bodyBusy(): boolean {
        return this.actions.executing;
    }

    /** 模型协议 action 是否在途（查询/动作可能重叠，按计数判）。 */
    private hasModelActionInFlight(): boolean {
        return this.modelActionsInFlight > 0 || this.modelActionRequested;
    }

    requestInterrupt(): void {
        if (this.bot == null) return;
        this.bot.interrupt_code = true;
        // mineflayer 的 stopDigging 在同/异步两条路上都可能抛 `Digging aborted`；
        // 这里是保命/Stop 的中断路径，不能因为一次 abort rejection 杀 body。
        const swallow = (result: any): void => {
            try {
                if (result != null && typeof result.catch === 'function') result.catch(() => undefined);
            } catch {
                // 同步 throw 已由外层 try 处理。
            }
        };
        try {
            swallow(this.bot.stopDigging?.());
        } catch (err: unknown) {
            this.noteNonFatal('stopDigging', err);
        }
        try {
            swallow(this.bot.collectBlock?.cancelTask?.());
        } catch (err: unknown) {
            this.noteNonFatal('collectBlock.cancelTask', err);
        }
        try {
            this.bot.pathfinder?.stop?.();
        } catch (err: unknown) {
            this.noteNonFatal('pathfinder.stop', err);
        }
        try {
            stopPvp(this.bot);
        } catch (err: unknown) {
            this.noteNonFatal('stopPvp', err);
        }
    }

    /** 非致命中断异常只记日志，不升级成 fatal。 */
    private noteNonFatal(where: string, err: unknown): void {
        try {
            this.log.with('lifecycle').warn({
                event: 'interrupt-swallowed',
                where,
                err: err instanceof Error ? err.message : String(err),
            });
        } catch {
            // 日志失败也不能让中断路径崩。
        }
    }

    /**
     * 模型的动作要开始时，先把自动拾取（如果正在跑）让出来。
     *
     * 自动拾取是身体的自主反射，只该在模型空闲时用身体。以前这里没有让位：
     * useBlock 这类裸 async 工具不会设置 `actions.executing`，于是自动拾取可以
     * 一边走一边和模型的动作抢方向盘，快照里 Meta 显示 autoPickup，模型却
     * 以为自己的动作根本没跑。
     */
    private async yieldAutoPickupToModel(): Promise<void> {
        if (!this.pickingUp) return;
        this.pickupPreemptReason = '模型动作抢占：已让出身体通道。';
        // 模型动作优先：标记取消并调用 pickup 自己的即时取消回调。
        // pickupAbortRequested 与 interrupt_code 不同：ActionManager.clearBotLogs
        // 清掉 interrupt_code 也不会影响它；取消回调会立刻 pathfinder.stop()。
        this.pickupAbortRequested = true;
        this.requestInterrupt();
        try {
            this.pickupCancel?.();
        } catch {
            // 取消失败由 50ms 轮询兜底。
        }
        // 等 pickup 真的收手再放行：否则它可能在模型动作开始后补一刀
        // pathfinder.stop()，把模型动作的寻路也停掉。正常情况下取消回调立即
        // resolve，这里只等几毫秒；500ms 是事件循环被卡住时的兜底上限。
        const deadline = Date.now() + 500;
        while (this.pickingUp && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    }

    /**
     * **保命优先**：把自动拾取从身体上摘下来，并给它一段静默期。
     *
     * 真机 2026-10-18 15:56（overnight_a）：被骷髅/末影人围攻时，拾取反射反复
     * 超时重试、每次都占着通道，模型 consume/move/stay/goToCoordinates 全被拒，
     * 血从 17.26 掉到 0.045。**一个替模型打输这场架的反射，比没有反射更糟。**
     *
     * @returns 是否真的打断了一次正在跑的拾取（用来决定要不要发回执）。
     */
    private abortAutoPickup(reason: string): boolean {
        const wasRunning = this.pickingUp;
        this.pickupAbortRequested = true;
        this.pickupPreemptReason = reason;
        try {
            this.pickupCancel?.();
        } catch {
            // 取消失败由 50ms 轮询兜底。
        }
        if (wasRunning || this.pickingUp) return true;
        return false;
    }

    /**
     * 停掉**非保命反射**（当前只有自动拾取），并把静默期推后。
     *
     * 保命反射（escape/surface）不在这一档：它们正是"先活下来"的那件事，
     * 只有 Stop / 急停（`abortReflexes`）能硬停。
     */
    private yieldNonSurvivalReflexes(reason: string): void {
        if (this.pickingUp) {
            this.abortAutoPickup(reason);
            this.pickupSuppressedUntil = Math.max(this.pickupSuppressedUntil, Date.now() + PICKUP_SURVIVAL_SUPPRESS_MS);
        }
    }

    /**
     * 硬停反射（Stop / 急停）：清队列 + 给正在跑的那条打中断标记。
     *
     * 真机抱怨："Stop 之后反射还在跑"——反射占着身体时，模型的动作全被拒，
     * 于是 Stop 也救不了它。
     */
    private abortReflexes(reason: string): number {
        const pending = this.reflexQueue?.length ?? 0;
        if (Array.isArray(this.reflexQueue)) this.reflexQueue.length = 0;
        const running = this.reflexRunning === true;
        if (running) {
            this.reflexAbortRequested = true;
            try {
                this.requestInterrupt();
            } catch {
                // 中断失败也要把队列清掉。
            }
            // **还要让正在跑的那一棒当场收手**：`requestInterrupt()` 只停掉"此刻"
            // 的寻路，而逃跑循环下一 tick 就会重新 setGoal（真机抱怨的
            // 「Stop 之后仍不停手」就是这么来的）。
            this.cancelRunningRescue();
            // **通道必须真的还回去**：宽限期内它自己收手最好；收不了就由
            // `releaseAbortedReflexChannel` 把通道摘下来（快照与回执一致）。
            const timer = setTimeout(() => {
                try {
                    this.releaseAbortedReflexChannel(reason);
                } catch {
                    // 释放失败也不能抛到定时器外面。
                }
            }, REFLEX_STOP_GRACE_MS);
            // Node 的定时器不该拖住进程退出（body 常常是随进程重启的）。
            if (typeof (timer as { unref?: () => void }).unref === 'function') {
                (timer as { unref: () => void }).unref();
            }
        }
        this.pickupPreemptReason = running || pending > 0 ? reason : this.pickupPreemptReason;
        return pending + (running ? 1 : 0);
    }

    /**
     * 开一棒保命处理：发一个只属于它的取消令牌。
     *
     * `rescue()` 拿这个 `cancelled` 和 `runEmergency(...)` **赛跑**：谁先到谁说了算
     * （危险自己解除 vs Stop/急停取消）。
     */
    private beginRescueRun(): { run: RescueRun; cancelled: Promise<EmergencyResult> } {
        const run: RescueRun = { aborted: false, cancel: null };
        const cancelled = new Promise<EmergencyResult>((resolve) => {
            run.cancel = (): void => {
                resolve({ escaped: false, reason: 'safe', position: null, health: null });
            };
        });
        this.currentRescueRun = run;
        return { run, cancelled };
    }

    /**
     * Stop / 急停 / 保命预算用完：让**这一棒**保命处理当场收手。
     *
     * 只认令牌不认共享标记：共享的 `reflexAbortRequested` 会被下一次 `emergency()`
     * 清掉，被丢弃的旧循环一旦"复活"就会变成第二个写手（两个循环同时 setGoal）。
     */
    private cancelRunningRescue(): void {
        const run = this.currentRescueRun;
        if (run == null) return;
        run.aborted = true;
        try {
            run.cancel?.();
        } catch {
            // 已经取消过就算了：令牌是幂等的。
        }
    }

    /**
     * Stop/急停宽限期到了、保命处理却还在跑：**把通道摘下来还给模型**。
     *
     * 真机 17:15：Stop 回 `{"stopped":true}`、事件也说"身体通道已释放"，而快照
     * 仍写着 `escape（已 102s）`——回执和状态各说各话，模型只能去关自己的护栏。
     * 这里以**通道状态**为准：摘下来就真的摘下来（后台那条会自己收尾），
     * 并且只发一次完成报告（`reflexCompletionSent` 防重复）。
     */
    private releaseAbortedReflexChannel(reason: string): void {
        if (this.reflexRunning !== true) return;
        const name = this.currentReflexName;
        this.currentReflexName = null;
        this.currentReflexIntent = null;
        this.currentReflexStartedAt = 0;
        this.reflexRunning = false;
        if (Array.isArray(this.reflexQueue)) this.reflexQueue.length = 0;
        if (this.reflexCompletionSent) return;
        this.reflexCompletionSent = true;
        this.notify(
            'reflex.done',
            KIND.WORLD,
            LEVEL.STATE,
            {
                reflex: name ?? 'reflex',
                outcome: 'aborted',
                detail:
                    `${reason}：保命处理没有在 ${Math.round(REFLEX_STOP_GRACE_MS / 1000)} 秒内收手，` +
                    '**已把身体通道还给模型**（后台那条会自己收尾）；危险还在的话会重新接管。',
                ms: 0,
            },
            name != null ? { completes: name } : {},
        );
    }

    clearBotLogs(): void {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    cleanKill(msg = 'Killing agent process...', code = 1): void {
        // **同步写盘**：紧接着就是 process.exit，异步日志会连同缓冲区一起丢——
        // 而"退出前最后一行"恰恰是排错最需要的（静默死亡最难查）。
        try {
            this.log.with('lifecycle').error({ event: 'exit', msg, code });
        } catch {
            // 日志失败不能阻止退出原因上屏。
        }
        console.log(this.name, msg);
        try {
            this.bot?.chat?.(code > 1 ? MESSAGES.restarting : MESSAGES.exiting);
        } catch {
            // 还没登录/连接已断时 chat 会抛；但这里是退出路径，不能再被它带崩。
        }
        process.exit(code);
    }

    /**
     * 进程级兜底：未捕获异常/未处理 rejection 至少要留下 exit 原因和当时的动作名。
     *
     * 真机 body-lost #4：stay 之后 body 静默退出，没有 cleanKill 记录，只能从外部
     * 猜。装了这个之后，fatal 原因、当前 action、报错文本都会写进日志。
     */
    private installProcessGuards(): void {
        const fatal = (kind: 'uncaughtException' | 'unhandledRejection', reason: unknown): void => {
            // `Digging aborted` 是挖矿取消的正常信号，不是 fatal；记录后继续。
            if (kind === 'unhandledRejection' && isDiggingAborted(reason)) {
                try {
                    this.log.with('lifecycle').warn({ event: 'digging-aborted-nonfatal', err: String(reason) });
                } catch {
                    // 日志失败也不能让 abort 变成 fatal。
                }
                return;
            }
            const info = describeFatalReason(reason);
            const action = ((): string => {
                try {
                    return this.currentActionName() ?? this.actions?.currentActionLabel ?? 'none';
                } catch {
                    return 'none';
                }
            })();
            try {
                this.log.with('lifecycle').error({
                    event: 'fatal',
                    kind,
                    action,
                    err: info.message,
                    stack: info.stack,
                    reason: info.serialized,
                });
            } catch {
                // 日志失败也不能阻止退出原因上屏。
            }
            console.error(this.name + ' fatal ' + kind + ' while action ' + action + ': ' + info.message);
            if (info.stack != null) console.error(info.stack);
            if (shouldKillOnFatal(kind)) {
                this.cleanKill('fatal ' + kind + ' while action "' + action + '": ' + info.message, 1);
            }
        };
        process.on('uncaughtException', (err) => fatal('uncaughtException', err));
        process.on('unhandledRejection', (reason) => fatal('unhandledRejection', reason));
    }

    // ── 观察 → 事件 ────────────────────────────────────────────────────────

    /**
     * 事件的唯一出口。与主线 `Agent.notify` 的区别只有一处：那边直接喂
     * `intake`，这边过协议推给大脑。**文本渲染仍走同一个 `renderEventText`**，
     * 所以模型看到的字一个字都没变。
     *
     * `type` 是**处理的匹配键**；`level` 只是这条事件的属性（用多大力气把模型
     * 叫来看一眼）。`reflex` / `completes` 是身体在声明"这条事件我已经交给哪个
     * 处理了 / 这是哪个处理的完成报告"。
     */
    private notify(
        type: string,
        kind: Kind,
        level: Level,
        payload: unknown,
        extra: { reflex?: string | null; completes?: string | null } = {},
    ): void {
        const text = renderEventText(kind, level, payload);
        // `type` / `kind` / `payload` 一起发过去：文本给模型看，结构化那份给大脑的
        // 审计台账（见 `BodyEvent` 的说明）。多两个字段，省掉大脑重渲一遍。
        this.push({
            push: 'event',
            event: {
                type,
                kind,
                level,
                text,
                ts: Date.now(),
                payload,
                reflex: extra.reflex ?? null,
                completes: extra.completes ?? null,
            },
        });
    }

    // ── 身体侧的处理（反射）────────────────────────────────────────────────

    /** 身体侧反射的串行队列：同一时刻只跑一个——两个保命循环抢身体没有意义。 */
    private reflexQueue: Array<{ reflex: string; intent: EmergencyIntent }> = [];
    private reflexRunning = false;

    /**
     * 一条 L5 事件 = **事件 + 身体侧的处理**。
     *
     * 顺序不能反：**事件先推出去**（大脑据此立刻打断在途推理、锁住动作通道），
     * 处理随后在身体侧跑（毫秒级的事不能等一轮推理）。处理跑完再发一条
     * `reflex.done`（带 `completes`），那条记录就是"我替你做了什么"，同样进上下文。
     *
     * 这样就没有"保命"这个独立的协议操作了：处理是**事件类型**的属性，
     * 不是等级 5 的属性，也不需要大脑隔着一趟协议来点名调用。
     */
    private emergency(type: string, payload: unknown, reflex: string, intent: EmergencyIntent): void {
        // 记录真正触发的 event type：Feedback #47-49 靠它查是哪个 L5 打断的。
        try {
            this.log.with('reflex').info({ event: 'emergency-triggered', type, reflex, intent });
        } catch {
            // 日志失败不能阻止保命动作。
        }
        // 受控安全岩浆作业：预测性 lava 保命在入口直接跳过（task-32/33/34 的豁免
        // 也应该在这里兜一层，避免 pollEdges 口径变化或动作间隙漏网）。
        if (type.startsWith('world.lava.') && isControlledSafeLavaOperation(this.bot)) {
            try {
                this.log.with('reflex').info({ event: 'emergency-skipped', type, reason: 'controlled-lava-safe' });
            } catch {
                // 日志失败也要跳过。
            }
            return;
        }
        // ── ① 模型把保命关了：**必须真的不介入** ─────────────────────────
        // `disableSafeguards` 的回执原文是「保命程序已关闭，接下来 N 次工具调用内
        // 不介入」，而反射引擎以前根本不看这个开关——真机 17:59 溺水时模型正是
        // 靠它开条生路，结果 surface 照旧占着身体、escapeWater 照旧被拒，
        // 最后淹死。回执承诺什么，这里就做到什么（关掉期间**不发 L5、不上锁**，
        // 身体完全归模型）。恢复方式也一并说清。
        const now = Date.now();
        if (safeguards.isSuppressed(now)) {
            if (now - this.survivalYieldNotifiedAt > SURVIVAL_GAP_MS) {
                this.survivalYieldNotifiedAt = now;
                this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                    reflex,
                    outcome: 'muted',
                    detail:
                        `保命程序已被你关闭（${safeguards.describe(now)}），这次**不介入**——身体是你的，` +
                        '自己想办法脱险；要恢复保命就用 disableSafeguards(restore=true) 或 restoreAllSafety。',
                    ms: 0,
                });
            }
            return;
        }
        // ── ② 保命"制度"预算（不是单个反射的预算）─────────────────────────
        // 真机 17:15（overnight_b）：escape 卡在「已 102s」，Stop 说"通道已释放"
        // 但快照还是 escape，stairUp/restart/disableSafeguards 全被
        // `An action is already running. Stop() first, then retry.` 拒掉。
        // 根因**不是一次反射太长**（那有 REFLEX_MAX_MS 兜着），而是：附近的僵尸
        // 一直在触发半径内 → 每来一条边沿就新起一次 escape → 从模型角度看是
        // **一次连续 100+ 秒的占用**。所以这里按"连续占用段"记账。
        //
        // **致命危险不吃这套**（验证者探针 ②/③）：25 秒足够淹死/烧死，而且
        // 岩浆/虚空/致命坠落是一次性边沿，被吞一次就再没有接管路径。
        const fatal = isFatalDanger(type);
        if (fatal) {
            this.survivalCooldownUntil = 0;
            this.clearPendingDanger();
        }
        // 空闲够久 → 开一段新的占用；**危险类别变了也开新段**（被僵尸追了 45 秒
        // 的账不能算到刚踩进去的岩浆头上）；否则接着上一段算。
        const segmentClass: 'fatal' | 'other' = fatal ? 'fatal' : 'other';
        if (
            this.survivalBusySince == null
            || (this.survivalBusyClass ?? null) !== segmentClass
            || now - this.survivalLastReflexAt > SURVIVAL_GAP_MS
        ) {
            this.survivalBusySince = now;
        }
        this.survivalBusyClass = segmentClass;
        this.survivalLastReflexAt = now;
        // 冷却期内绝不重新接管：这段时间身体是**模型的**（吃药/搭柱/挖开/Stop）。
        if (!fatal && now < this.survivalCooldownUntil) {
            // 被吞掉的危险要留个尾巴：flag 边沿不会再 fire，必须自己在窗口结束时补一枪。
            this.recordPendingDanger(type, payload, reflex, intent, this.survivalCooldownUntil);
            if (now - this.survivalYieldNotifiedAt > SURVIVAL_GAP_MS) {
                this.survivalYieldNotifiedAt = now;
                this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                    reflex,
                    outcome: 'deferred',
                    detail:
                        `保命还在冷却期（还有 ${Math.max(1, Math.round((this.survivalCooldownUntil - now) / 1000))} 秒），` +
                        '这段时间身体归你（吃药/搭柱/挖开/Stop 都行）；危险还在的话冷却结束会重新接管。',
                    ms: 0,
                });
                // **事件本身也要进上下文**：早退路径以前连推都不推，模型根本
                // 不知道自己在冷却期里又遇到了危险（只有那行回执，还带节流）。
                this.notify(type, KIND.WORLD, LEVEL.STATE, payload, { reflex });
            }
            return;
        }
        // 连续占用超预算：交还身体 + 冷却，并说清"会重新接管"。
        //
        // 预算**对致命危险也生效**（跟冷却不同）：45 秒还在水里/岩浆里，说明
        // "这一棒出不来"，交还身体让模型自己动手（挖开/搭柱/Stop）比继续闷头
        // 尝试更有用。致命危险随后**可以立刻重新接管**（它们不看冷却），
        // 所以这个交还只是把身体递出去一下，不是把保命关掉。
        if (now - this.survivalBusySince >= SURVIVAL_BUDGET_MS) {
            this.survivalCooldownUntil = now + SURVIVAL_COOLDOWN_MS;
            this.survivalBusySince = null;
            this.survivalBusyClass = null;
            const released = this.abortReflexes('保命预算用完');
            // 致命危险不需要补枪：它们本来就不吃冷却，下一条边沿照常接管。
            if (!fatal) this.recordPendingDanger(type, payload, reflex, intent, this.survivalCooldownUntil);
            this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                reflex,
                outcome: 'yielded',
                detail:
                    `保命连续占用 ${Math.round(SURVIVAL_BUDGET_MS / 1000)} 秒仍未脱险，` +
                    `**先交还身体 ${Math.round(SURVIVAL_COOLDOWN_MS / 1000)} 秒让你自救**` +
                    '（吃药/搭柱/挖开/Stop 都行）；危险还在的话，冷却结束后会重新接管。' +
                    (released > 0 ? '' : '（当前没有正在跑的保命处理。）'),
                ms: 0,
            });
            this.notify(type, KIND.WORLD, LEVEL.STATE, payload, { reflex });
            return;
        }
        // ── ③ 同一件事已经在处理：**不重复触发，也不打断它** ────────────────
        // 这一条是"abort 循环"的解药。以前每条边沿都会 `forceStopBody`（把
        // interrupt_code 置位）再排一条新反射——正在跑的那条于是被自己的下一次
        // 触发打断（真机日志：surface `outcome:"aborted", ms:0` 反复出现，
        // 模型看到的是"一直在占着身体，却永远不上岸"）。
        // 同一件事就让它跑完：边沿只报一句"还在处理"。
        //
        // 去重键必须是 **reflex + intent**：`escape/flee`（被僵尸追）和
        // `escape/lava`（踩进岩浆）同名不同事——flee 分支压根不处理岩浆
        // （emergency.ts 的 flee 只跑逃跑），把 lava 当"正在进行"吞掉，
        // 人就会站在岩浆里等一场永远不会来的逃生。
        const sameRunning =
            this.reflexRunning === true
            && this.currentReflexName === reflex
            && (this.currentReflexIntent ?? null) === intent;
        const sameQueued =
            Array.isArray(this.reflexQueue)
            && this.reflexQueue.some((q) => q.reflex === reflex && q.intent === intent);
        if (sameRunning || sameQueued) {
            if (now - this.survivalYieldNotifiedAt > SURVIVAL_GAP_MS) {
                this.survivalYieldNotifiedAt = now;
                const ms = this.currentReflexStartedAt > 0 ? now - this.currentReflexStartedAt : 0;
                this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                    reflex,
                    outcome: 'in_progress',
                    detail:
                        `${reflex} 保命处理正在进行中（已 ${Math.round(ms / 1000)} 秒），**不重复触发**；` +
                        '它跑完会自己报结果。急的话先 Stop（会立刻把身体给你）。',
                    ms,
                });
            }
            // 这里**不发**新的 L5：大脑的 `beginReflex` 是按名字计数的，同一条反射
            // 重复上报会让计数永远还不清（就是 17:15 那把永久锁的成因）。同一件事
            // 已经在跑 = 有人在处理，不需要再叫醒谁。
            return;
        }
        // 模型的动作请求已经在路上：这次不抢（它可能正是在自救）。
        // 致命危险例外——等一个在途请求的时间就够死一次了。
        if (!fatal && this.modelActionRequested && !this.actions?.executing) {
            this.recordPendingDanger(type, payload, reflex, intent, now + SURVIVAL_GAP_MS);
            this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                reflex,
                outcome: 'deferred',
                detail:
                    '你有一个动作请求正在处理，这次保命**不抢身体**（先让你的动作跑）；' +
                    '危险还在的话，下一条事件会再报一次。',
                ms: 0,
            });
            this.notify(type, KIND.WORLD, LEVEL.STATE, payload, { reflex });
            return;
        }
        // **保命抢占（第 0 步）**：先把自动拾取从身体上摘下来，再排队保命。
        // 顺序反了就会出现真机 15:56 那一幕——拾取反射反复超时重试占着通道，
        // 模型的 consume/move/stay/goToCoordinates 全被拒，人被打死。
        this.yieldNonSurvivalReflexes(`保命优先（${type}）：已放弃这次自动拾取。`);
        // 新的保命需求来了：清掉上一次的急停标记，让这一棒能真的跑起来。
        this.reflexAbortRequested = false;
        // **先硬中断正在跑的模型动作**，再通知/排队保命：
        // 真机 Feedback #24 长寻路遇敌时，反射只是排队，身体还在被寻路带走，
        // 等 rescue 跑到 stopAll 时人已经在水里了。
        forceStopBody(this);
        // 急停后模型锁也要清零：否则下一次模型动作可能被 ACTION_BUSY/modelActionRequested
        // 残留挡住（body 的 actions.executing 由 ActionManager 自己收敛）。
        this.modelActionRequested = false;
        this.notify(type, KIND.WORLD, LEVEL.EMERGENCY, payload, { reflex });
        this.reflexQueue.push({ reflex, intent });
        void this.drainReflexes();
    }

    /**
     * 记下"这次危险被窗口吞掉了"，到窗口结束时补一枪。
     *
     * 为什么必须补：`world.lava.contact` / `world.void.falling` / `world.fall.lethal`
     * 是 `kind:'flag'` 的**上升沿**，只 fire 一次；被冷却/去重吞掉之后不会再有
     * 第二条边沿，而 `world.lava.nearby` 只是 L3（不选反射）——人还在岩浆里，
     * 却再也没有接管路径（验证者探针 ③）。
     */
    private recordPendingDanger(
        type: string,
        payload: unknown,
        reflex: string,
        intent: EmergencyIntent,
        dueAt: number,
    ): void {
        const flagEdge = FLAG_DANGER_TYPES.has(type);
        // 只有一次性边沿才需要这条兜底；kind:'all' 的边沿下一条马上又来。
        if (!flagEdge) return;
        this.pendingDanger = { type, payload, reflex, intent, dueAt };
        if (this.pendingDangerTimer != null) {
            clearTimeout(this.pendingDangerTimer);
            this.pendingDangerTimer = null;
        }
        const delay = Math.max(50, Math.min(60_000, dueAt - Date.now() + 50));
        this.pendingDangerTimer = setTimeout(() => {
            this.pendingDangerTimer = null;
            const pending = this.pendingDanger;
            if (pending == null) return;
            this.pendingDanger = null;
            if (Date.now() < pending.dueAt) return;
            try {
                this.log.with('reflex').info({
                    event: 'pending-danger-retry',
                    type: pending.type,
                    reflex: pending.reflex,
                    intent: pending.intent,
                });
            } catch {
                // 日志失败也要补这一枪。
            }
            this.emergency(pending.type, pending.payload, pending.reflex, pending.intent);
        }, delay);
        // 别为了这个定时器拽着进程不退出。
        (this.pendingDangerTimer as { unref?: () => void }).unref?.();
    }

    private clearPendingDanger(): void {
        if (this.pendingDangerTimer != null) {
            clearTimeout(this.pendingDangerTimer);
            this.pendingDangerTimer = null;
        }
        this.pendingDanger = null;
    }

    /** 排空反射队列（已经在跑就什么都不做）。 */
    private async drainReflexes(): Promise<void> {
        if (this.reflexRunning) return;
        this.reflexRunning = true;
        try {
            for (;;) {
                const next = this.reflexQueue?.shift?.() ?? null;
                if (next == null) break;
                // Stop/急停清过队列：不再跑下一棒。
                if (this.reflexAbortRequested) break;
                const started = Date.now();
                // **如实报给快照**：谁占着身体、占了多久、为什么（intent）。
                this.currentReflexName = next.reflex;
                this.currentReflexIntent = next.intent ?? null;
                this.currentReflexStartedAt = started;
                this.reflexCompletionSent = false;
                this.survivalLastReflexAt = started;
                let outcome: 'ok' | 'failed' | 'partial' | 'aborted' | 'muted' = 'ok';
                let detail = '';
                let guardTimer: ReturnType<typeof setInterval> | null = null;
                try {
                    // **把上一次急停留下的 interrupt_code 清掉再跑。**
                    // `emergency()` 为了抢身体会 `forceStopBody`（置 interrupt_code），
                    // 而 skills 每一步都认这个标记——不清的话这一棒刚起步就被自己
                    // 上一次的急停打断（真机日志：surface `aborted, ms:0` 无限重复）。
                    // 模型/Stop 的抢占另有 `reflexAbortRequested` / `modelActionRequested`
                    // 兜着，不会被这里清掉。
                    try {
                        if (this.bot != null) this.bot.interrupt_code = false;
                    } catch {
                        // 清不掉也要继续跑（最坏是这一棒立刻返回 aborted）。
                    }
                    // **保命循环要有上限，也要认模型的开关。**
                    // 每 500ms 查两件事：
                    //   ① 跑过 REFLEX_MAX_MS → 交还身体（真机有一次 escape 跑了 419 秒）；
                    //   ② **模型关掉了保命程序**（disableSafeguards）→ 立刻让位。
                    // 第 ② 条是真机 17:59 淹死的直接原因：模型关掉保命后，**正在跑的
                    // surface 照旧占着身体**，escapeWater 依然被拒——回执承诺"不介入"
                    // 就必须当场生效，包括正在跑的这一条。
                    const raced = await Promise.race([
                        this.rescue(next.intent).then((r) => ({ kind: 'done' as const, r })),
                        new Promise<{ kind: 'timeout' | 'muted' }>((resolve) => {
                            guardTimer = setInterval(() => {
                                const at = Date.now();
                                if (at - started >= REFLEX_MAX_MS) {
                                    resolve({ kind: 'timeout' });
                                    return;
                                }
                                if (safeguards.isSuppressed(at)) {
                                    resolve({ kind: 'muted' });
                                }
                            }, 500);
                        }),
                    ]);
                    if (raced.kind === 'muted') {
                        // 模型明确关掉了保命：让位 + 冷却（别立刻又抢回来）。
                        this.reflexAbortRequested = true;
                        this.survivalCooldownUntil = Math.max(
                            this.survivalCooldownUntil,
                            Date.now() + SURVIVAL_COOLDOWN_MS,
                        );
                        try {
                            this.requestInterrupt();
                        } catch {
                            // 中断失败也要如实报"让位"。
                        }
                        // 正在跑的循环也要**当场**收手（它下一步就会重新 setGoal）。
                        this.cancelRunningRescue();
                        outcome = 'muted';
                        detail =
                            '你把保命程序关掉了：**正在跑的 ' + next.reflex + ' 立刻让位**，身体归你；' +
                            `接下来 ${Math.round(SURVIVAL_COOLDOWN_MS / 1000)} 秒内保命不会介入` +
                            '（要恢复就用 disableSafeguards(restore=true) 或 restoreAllSafety）。';
                    } else if (raced.kind === 'timeout') {
                        // 让它收手（skills 认 interrupt_code），并把通道还给模型。
                        this.reflexAbortRequested = true;
                        try {
                            this.requestInterrupt();
                        } catch {
                            // 中断失败也要如实报"交还身体"。
                        }
                        // 跑满上限的循环同样要当场收手：只 stop 一次寻路没用，
                        // 它下一 tick 会重新 setGoal（交还身体不能是句空话）。
                        this.cancelRunningRescue();
                        outcome = 'aborted';
                        detail =
                            `保命处理跑了 ${Math.round(REFLEX_MAX_MS / 1000)} 秒还没脱险，` +
                            '已中断并**交还身体通道**（模型可以吃药/逃跑/换方向自救）；' +
                            '**如果危险还在，保命会在下一条受击事件上重新接管**——' +
                            '这一段只是先把身体还给你，不是把保命关掉。';
                    } else if (raced.kind === 'done') {
                        const result = raced.r;
                        if (result.reason === 'died') {
                            outcome = 'failed';
                            detail = '处理过程中死亡。';
                        } else if (this.reflexAbortRequested || this.bot?.interrupt_code === true) {
                            // 被 Stop / 模型抢占打断：如实说"中断"，别说成"脱险了"。
                            outcome = 'aborted';
                            detail = '被 Stop/急停中断（模型要用身体，或保命升级）。';
                        } else if (result.escaped) {
                            outcome = 'ok';
                            detail = next.intent === 'surface' ? '已经把头露出水面。' : '已经脱离威胁。';
                        } else {
                            outcome = 'partial';
                            detail = '处理结束了，但没能确认脱险。';
                        }
                    }
                } catch (err: unknown) {
                    outcome = 'failed';
                    detail = err instanceof Error ? err.message : String(err);
                } finally {
                    if (guardTimer != null) clearInterval(guardTimer);
                }
                this.currentReflexName = null;
                this.currentReflexIntent = null;
                this.currentReflexStartedAt = 0;
                this.survivalLastReflexAt = Date.now();
                // Stop 宽限期已经代发过一次完成报告：这里只收尾，不再重复上报
                // （重复上报会让大脑的紧急锁统计错位）。
                if (!this.reflexCompletionSent) {
                    this.notify(
                        'reflex.done',
                        KIND.WORLD,
                        LEVEL.STATE,
                        { reflex: next.reflex, outcome, detail, ms: Date.now() - started },
                        { completes: next.reflex },
                    );
                }
                this.reflexCompletionSent = false;
            }
        } finally {
            this.reflexRunning = false;
            this.currentReflexName = null;
            this.currentReflexIntent = null;
            this.currentReflexStartedAt = 0;
            this.reflexAbortRequested = false;
        }
    }

    /**
     * 身体侧的反射出口：**事件类型 → 处理**。
     *
     * 旧实现把所有 L5 事件都丢给同一个循环，让循环进去以后自己再猜一遍处境
     * （先看是不是溺水、再看有没有怪）。那是"处理被按等级归并"——事件类型的
     * 信息在到达处理的那一刻就丢了，也没法只给某一类事件换处理。
     * 现在这张表就是一一对应：溺水归上浮，其余危险归逃跑。
     */
    private static readonly EDGE_REFLEX: Record<string, { reflex: string; intent: EmergencyIntent }> = {
        'world.water.drowning': { reflex: 'surface', intent: 'surface' },
        'world.lava.contact': { reflex: 'escape', intent: 'lava' },
        'world.lava.about_to_enter': { reflex: 'escape', intent: 'lava' },
        'world.lava.nearby': { reflex: 'escape', intent: 'lava' },
        'world.fire.burning_low_hp': { reflex: 'escape', intent: 'flee' },
        'world.void.falling': { reflex: 'escape', intent: 'flee' },
        'world.fall.lethal': { reflex: 'escape', intent: 'flee' },
        'world.trapped.low_hp': { reflex: 'escape', intent: 'flee' },
        'world.tnt.primed_nearby': { reflex: 'escape', intent: 'flee' },
        'world.creeper.swelling': { reflex: 'escape', intent: 'flee' },
        'bot.health_danger': { reflex: 'escape', intent: 'flee' },
        'bot.attacked': { reflex: 'escape', intent: 'flee' },
    };

    private push(push: BodyPush): void {
        try {
            this.sink(push);
        } catch {
            // 大脑没连上就丢事件。事件不是账本——真丢了，下一轮世界快照仍然是真的。
            // 反过来（为了不丢而缓冲）会在大脑重启后灌一堆过期事件。
        }
    }

    /**
     * 聊天与自动行为。
     *
     * 聊天**不渲染成事件**，走单独的 push：主线区分"玩家在问我"（必须回应，
     * 投成真正的用户回合）和"队友在报坐标"（事件即可），而这个区分依赖大脑侧
     * profile 知识（谁是队友）。身体只如实转发，由大脑判。
     */
    private setupInteractionHandlers(): void {
            const chat = (username: string, message: string, whisper: boolean): void => {
                if (message === '') return;
                if (username === this.name) return;
                // **聊天也是事件**（`player.chat`）。身体只如实转发"有人说了什么"，
                // 而"这是玩家在问我、还是队友在报坐标"依赖大脑侧的知识（谁是队友
                // 来自 profiles）——所以那是这条事件在大脑侧的**处理**，
                // 不是身体该替它判的事。
                //
                // ⚠️ **这里必须是 STATE（只记录），不能是 WAKE。** 真机事故
                // （2026-10-18 23:26）：玩家的建造工具以 `mcbuild` 的名字批量填充方块，
                // 每批广播一条 `Successfully filled N block(s)`。原来这里写 `LEVEL.WAKE`，
                // 于是**每条聊天都在大脑判级之前就先唤醒了一次模型**——大脑侧
                // `routeChat` 的黑名单/`classifyChat` 跑在唤醒**之后**，根本拦不住，
                // 两个 bot 的上下文被 80+ 条刷爆。
                // 分层说得很清楚：**判级是大脑的事**，身体给一个"只记录"的等级，
                // `routeChat` 会按 `classifyChat` 把真正该唤醒的提到 WAKE。
                this.notify('player.chat', KIND.USER, LEVEL.STATE, {
                    from: username,
                    message,
                    whisper,
                });
            };

        this.bot.on('whisper', (username: string, message: string) => chat(username, message, true));
        this.bot.on('chat', (username: string, message: string) => chat(username, message, false));

        // Set up auto-eat
        this.bot.autoEat.setOpts({
            priority: 'foodPoints',
            minHunger: 14,
            bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'],
        });
        this.bot.autoEat.enableAuto();

        // 保命应急交由 common-sense 插件（着火/摔落等基础响应），自研 modes 已退役
        try {
            this.bot.commonSense?.setOptions?.({
                autoRespond: true,
                // 注意选项名：插件里摔落反射叫 **mlgCheck**（默认 false），
                // 没有 `fallCheck` 这个键——以前写 `fallCheck: true` 是个静默
                // 无效键，等于摔落反射从未开启（setOptions 只做 Object.assign）。
                mlgCheck: true,
                fireCheck: true,
                useOffhand: true,
            });
        } catch (err: unknown) {
            console.warn('commonSense options failed:', err instanceof Error ? err.message : String(err));
        }
    }

    startEvents(): void {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0) this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000) this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000) this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000) this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                // **"正在挨打"**：击杀后的拾取优先窗口靠它决定要不要让位给保命
                // （见 shouldBypassThreatGateForPickup）。
                this.lastDamageAt = Date.now();
                // 挨打即事件（带伤害量）：阈值越线是另一组检测器的事，
                // 这里只管"挨打了"这个事实；持续掉血 1.5 秒只报一次。
                //
                // **L2 而不是 L3**：掉血本身不该唤醒模型——`bot.health_low`（L3）
                // 和 `bot.health_danger`（L5）才是该唤醒的那两档。真机日志里
                // 一场骷髅战掉 8 次血就是 8 次 L3 唤醒。
                const hurt = shouldEmitHurt(prev_health, this.bot.health, this.lastHurtEmitAt, Date.now());
                if (hurt.fire) {
                    this.lastHurtEmitAt = Date.now();
                    this.notify('bot.hurt', KIND.WORLD, LEVEL.STATE, {
                        health: this.bot.health,
                        damage: hurt.damage,
                    });
                    // **被敌对生物打了就直接保命，不等血线。**
                    // 保命以前只看血线（30% = 6/20）——prober 实测 17.5 → 12.5 →
                    // 10 → 5 → 死亡，10 还没到线，轮到 5 时下一次攻击已经把它带走了
                    // （"全程没有反击、没有逃跑、也没有中断动作"）。被怪打本身就是
                    // "危险正在发生"，不需要血线确认。10 秒防抖：连续挨打不刷屏。
                }
                // **威胁保命独立于 hurt 的节流**：骷髅连射可能被 debounce 掉，
                // 但敌人还贴着脸，必须立刻中断当前动作（Feedback #24）。
                const threat = (() => {
                    try {
                        const p = this.bot.entity.position;
                        return this.threatNear({ x: p.x, y: p.y, z: p.z }, 16);
                    } catch {
                        return null;
                    }
                })();
                const threatDamage = Math.max(0, Math.round((prev_health - this.bot.health) * 100) / 100);
                if (
                    shouldThreatEmergency({
                        threat,
                        health: this.bot.health,
                        damage: threatDamage,
                        msSinceLastEmergency: Date.now() - this.lastThreatEmergencyAt,
                    })
                ) {
                    this.lastThreatEmergencyAt = Date.now();
                    this.emergency(
                        'bot.attacked',
                        {
                            health: this.bot.health,
                            damage: threatDamage,
                            by: threat?.name,
                            threatMeters: threat?.distance,
                        },
                        'escape',
                        'flee',
                    );
                }
            }
            prev_health = this.bot.health;
            // 低血边沿：掉进线以下发一次 L5，回到 12 以上才重新 armed。
            if (shouldTriggerEmergency(this.bot.health) && !this.lowHpArmed) {
                this.lowHpArmed = true;
                this.emergency('bot.health_danger', { health: this.bot.health }, 'escape', 'flee');
            } else if (typeof this.bot.health === 'number' && this.bot.health >= 12) {
                this.lowHpArmed = false;
            }
        });
        // Logging callbacks
        this.bot.on('error', (err: unknown) => {
            console.error('Error event', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason: unknown) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.stop();
            // 死着不该继续干活。真机日志里 pia 12:32:38 被骷髅射死，
            // 12:32:39 还在 claim `moveAway` 躲怪——因为死亡只停了身体，
            // 没中断模型那一轮推理。
            this.requestInterrupt();
            // 中断推理是大脑的事：推一条 L4（PREEMPT），大脑收到会 abort
            // 当前请求。主线在这里还额外直接调了一次 `runtime.abort()`，
            // 那是同进程时代的"belt and braces"，跨进程后由 L4 承担。
        });
        this.bot.on('kicked', (reason: unknown) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', (message: string, _: unknown, jsonMsg: any) => {
            void _;
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                const death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text: string | null = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                const dimention = this.bot.game.dimension;
                // **掉落清单：死亡瞬间的背包就是"你带走的全部"**（没开
                // keepInventory 的话，它们正躺在死亡点）。模型要靠它决定
                // "回去捡还是重新准备"——以前这里什么都不给。
                const carried = ((this.bot.inventory?.items?.() ?? []) as Array<{
                    name?: string;
                    count?: number;
                }>)
                    .map((item) => `${item.name}×${item.count ?? 1}`)
                    .slice(0, 12)
                    .join('、');
                const text = MESSAGES.death(death_pos_text || 'unknown', dimention, message, carried);
                this.lastDeathAt = Date.now();
                // **先写一条 L2 被动记录**。L4 会走 `abort()`，而 `abort()` 撤回
                // 排队中的输入——真机上这条死亡消息 19 秒后才落地，最后连同被
                // abort 的那一轮一起丢了，模型全程不知道自己死了。
                // L2 是 write，pi-durable 明确"queued writes stay"，不参与撤回。
                //
                // 这里**不走 `handleMessage`**：它静音时会直接丢事件（`stfu`），
                // 而死亡不该被静音吃掉。
                this.notify('agent.death', KIND.WORLD, LEVEL.STATE, { source: 'system', message: text });
                // 再用 L4 把模型叫起来（优先通道，立刻插队）。
                this.notify('agent.death.wake', KIND.WORLD, LEVEL.PREEMPT, {
                    source: 'system',
                    message: MESSAGES.deathWake(),
                });
            }
        });
        this.bot.on('idle', () => {
            // 动作结束后的清场：清掉残留的操作状态，避免上一个动作的
            // 按键/寻路目标漏到下一个动作里。
            this.bot.clearControlStates();
        });
        // 拾取：自己捡起掉落物。连捡时 2 秒只报一次，免得刷屏开轮。
        //
        // **物品名不能从 `collected` 上读**：掉落物实体的 `name` 就是字面量 `'item'`，
        // 于是这条事件曾经报的是 `{"type":"inventory.collected","item":"item"}`——
        // 模型直接写了 Feedback：「这没告诉我任何东西」。
        // 真名要读实体元数据（版本相关、容易错），所以改成**用背包账目反推**：
        // 事件发生那一刻先读 before，**200ms 后重读 player inventory**；只有 after
        // 相对 before 确实多出来的才报 gained（知道掉落物名时只认这个物品）。
        this.bot.on('playerCollect', (collector: any, collected: any) => {
            try {
                this.handlePlayerCollect(collector, collected);
            } catch (err: unknown) {
                console.error('collect event failed:', err instanceof Error ? err.message : String(err));
            }
        });
        // 掉落物实体出现：把 id 认领到最近一次 discard 上。
        // 名字匹配靠不住（实体名可能还没同步），id 才是"就是刚扔的那件"的证明。
        this.bot.on('itemDrop', (entity: any) => {
            try {
                noteDiscardedEntity(entity?.id);
            } catch {
                // 认领失败不影响别的路径（名字/落点仍在挡）。
            }
        });
        // 开箱：容器界面打开即事件（关箱不报，没信息量）。
        this.bot.on('windowOpen', (window: any) => {
            try {
                this.notify('inventory.container', KIND.WORLD, LEVEL.WAKE, {
                    // 标题要**归一化成一句人话**：`window.title` 在这个版本里是个对象
                    // （聊天组件），`String()` 出来就是 `[object Object]`——模型的
                    // Feedback 原文："容器标题被序列化成了 [object Object]"。
                    title: readableWindowTitle(window?.title),
                });
            } catch (err: unknown) {
                console.error('container event failed:', err instanceof Error ? err.message : String(err));
            }
        });

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (!this.shuttingDown) {
                const start = Date.now();
                await this.update(start - last);
                const remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    /**
     * 一个心跳。
     *
     * `checkTaskDone()` **不在这里**——任务与完成度是决策层概念，大脑那边由
     * `inventory.changed` 事件的处理触发（不再有定时轮询）。
     */
    update(delta: number): void {
        void delta;
        // 开发者通道：读 inbox 的新行（见 pollInbox）。
        this.pollInbox();
        // 自动拾取**不在身体里了**：它是为 VLM 做的外层设施（模型不会捡东西），
        // 属于大脑的策略。身体只负责在掉落物出现的那一刻报一条事件。
        // 兜底关窗：残留的开着的容器界面会废掉一整类世界交互（见 maybeCloseStaleScreen）。
        this.maybeCloseStaleScreen();
        // 深水强制出水（见 maybeForceExitWater）。同样是后台行为，不能 await。
        this.maybeForceExitWater();
        this.pollEdges();
    }

    /**
     * **氧气反射**：连续水下接近极限（90%）或开始掉血时强制出水。
     *
     * 触发时机是"氧气即将耗尽"，**不是头一碰到水**——正常的水下作业（过河时
     * 潜一段水、在水下挖矿）是授权范围内的合法行为，头一湿就把人拽上去等于
     * 没法在水边干活。而氧气是**确定性的游戏机制**：头连续在水下 15 秒开始掉血，
     * 露出水面瞬间回满。mineflayer 在 1.20.6 读不到 air_supply（oxygen 字段是
     * 垃圾，见 edges.ts 里删掉 bot.oxygen_low 的记录），所以我们自己计时——
     * "头连续在水下的时长"就是氧气的忠实镜像。
     *
     * - **计时到 90%**（约 13.5 秒）：`urgency='oxygen-low'`，先按空格上浮。
     * - **头在水下且血在掉**（氧气耗尽的铁证）：`urgency='drowning'`，最后通牒。
     *
     * 与许可无关（分层见 `forceExitWater` 顶部）：`enter_deep_water` 许的是
     * "动作可以带你进水"，不是"氧气耗尽也别捞"。**动作在跑也接管**——水下作业
     * 的合法时长就是一条氧气的长度，超了就该浮头换气。
     *
     * ⚠️ **已知偏差（可接受的近似）**：头露出水面就清零计时，但游戏里氧气
     * **不是瞬间回满**的——如果头只露了半秒又潜下去，实际氧气只回了一部分，
     * 这里却重新数满 15 秒，会**低估**溺水风险。精确做法是按露头时长比例恢复
     * （游戏里回满约需 1.5 秒），但"露头多半意味着浮到了水面喘气"，偏差方向
     * 是偶尔晚半拍而不是不救，够用。真到掉血了还有 bleeding 这条兜底线。
     */
    private maybeForceExitWater(): void {
        if (this.exitingWater) return;
        if (this.bot == null) return;
        const now = Date.now();
        const head = headInWater(this.bot);

        // 连续水下计时：头出水就清零（氧气瞬间回满），头在水下就累加。
        if (!head) {
            this.headUnderSince = null;
        } else if (this.headUnderSince == null) {
            this.headUnderSince = now;
        }
        const underMs = head && this.headUnderSince != null ? now - this.headUnderSince : 0;

        // 掉血检测：氧气耗尽后每秒掉 2 点。头在水下 + 血比上一次看的时候低 =
        // 已经进入溺水伤害，是最后的通牒。
        const health = typeof this.bot.health === 'number' ? this.bot.health : null;
        const bleeding = head && health != null && this.lastSeenHealth != null && health < this.lastSeenHealth;
        this.lastSeenHealth = health;

        if (!head || (underMs < OXYGEN_ACT_MS && !bleeding)) return;

        // **失败就退避**：纯水大陆上"岸"这件事不会靠重试变可能，2 秒一轮只会
        // 反复抢身体、反复往回执里塞同一句话。退到 30 秒，把身体还给模型
        // （它也许想造船、或者游向某个方向）。掉血中不退避——那是最后通牒。
        const gap = this.waterExitFailures > 0 ? 30_000 : 2000;
        if (now - this.lastWaterCheckAt < gap && !bleeding) return;
        this.lastWaterCheckAt = now;

        const urgency: 'oxygen-low' | 'drowning' = bleeding ? 'drowning' : 'oxygen-low';
        const bot = this.bot;
        this.exitingWater = true;
        void forceExitWater(bot, urgency)
            .then((ok: boolean) => {
                this.waterExitFailures = ok ? 0 : this.waterExitFailures + 1;
            })
            .catch((err: unknown) => {
                this.waterExitFailures++;
                this.log.with('water').warn({ phase: 'exit-failed', err: String(err) });
            })
            .finally(() => {
                this.exitingWater = false;
            });
    }

    /**
     * 兜底关窗。
     *
     * **为什么需要**：只要有一个容器界面还开着，一整类"对着世界动手"的操作就
     * 全都废掉——`placeBlock` / `useBlock` / `useOn` 都要求手上没开着界面。
     * 而失败的样子是**回执各说各的**，模型根本看不出"我界面还开着"。
     * 真机抓到过这个现象（pib 报 `screen: open`，pia 说这条"可能比准星更值钱"，
     * 因为准星只影响需要瞄准的动作，界面残留影响一**大类**）。
     *
     * **只在身体空闲时关**：正在跑容器动作时（`useBlock` 全程都在动作里）绝不能碰，
     * 否则会把模型正在用的界面关掉。
     */
    private maybeCloseStaleScreen(): void {
        if (this.bodyBusy()) return;
        const win = (this.bot as { currentWindow?: unknown } | null)?.currentWindow;
        if (win == null) return;
        try {
            this.bot.closeWindow(win as never);
            this.log.with('lifecycle').info({ event: 'screen-closed', why: 'leaked-open-window' });
        } catch {
            // 关不掉就算了，下一轮还会再试。
        }
    }

    /**
     * 读当前 player inventory 的完整账目。
     *
     * 拾取核验必须拿**同一口径的两次读数**比：一次是 playerCollect 刚发生时，
     * 一次是 200ms 后。读不到返回 null，调用方宁可不报也不能把"读失败"当"没变化"。
     *
     * **还没同步过背包时一律返回 null**：刚重连的 `inventory.items()` 是空数组，
     * 但那不是"背包空了"，是"还没到"。把它当 0 会让拾取核验算出"没捡到"、
     * 让回执写"背包 0 → 0"（真机 2026-10-18 就是这么把模型骗去重采的）。
     */
    private readInventoryCounts(): InventoryCounts | null {
        if (this.inventorySynced === false) return null;
        try {
            const items = (this.bot?.inventory?.items?.() ?? []) as Array<{ name?: string; count?: number }>;
            const counts: InventoryCounts = {};
            for (const item of items) {
                const name = String(item?.name ?? '');
                if (name === '') continue;
                counts[name] = (counts[name] ?? 0) + Number(item?.count ?? 0);
            }
            return counts;
        } catch {
            return null;
        }
    }

    /**
     * `playerCollect` 后的核验流程。
     *
     * 真机 Feedback #62：事件先报"捡到 porkchop×1"，但背包里没有——原因是
     * 旧实现拿一份可能很旧的 `lastInventory` 做差，把别处的变化算到了这次拾取头上。
     * 现在在事件发生那一刻先读一份 before，**200ms 后重读 player inventory**，
     * 只有 after 相对 before 的正增量（知道物品名时还只认这个物品）才发事件。
     */
    private handlePlayerCollect(collector: unknown, collected: unknown): void {
        const c = collector as { id?: unknown } | null | undefined;
        if (!c || c.id !== this.bot?.entity?.id) return;
        const before = this.readInventoryCounts();
        const expectedItem = expectedItemNameFromEntity(collected);
        setTimeout(() => {
            try {
                const after = this.readInventoryCounts();
                const gained = confirmedPickupGains(before, after, expectedItem);
                if (Object.keys(gained).length === 0) {
                    this.log.with('pickup').info({
                        event: 'not-confirmed',
                        expected_item: expectedItem,
                        entity_id: (collected as { id?: unknown } | null | undefined)?.id ?? null,
                        before,
                        after,
                    });
                    return;
                }
                const now = Date.now();
                if (now - this.lastCollectEmitAt < 2000) return;
                this.lastCollectEmitAt = now;
                const nearbyPlayers = nearbyOtherPlayerNames(this.bot, PICKUP_RADIUS);
                const text = formatInventoryGains(gained);
                const hint =
                    nearbyPlayers.length > 0
                        ? `自动拾取：捡到了 ${text}。附近有玩家 ${nearbyPlayers.join('、')}，这件可能是队友掉落；需要的话和对方确认。`
                        : `自动拾取：捡到了 ${text}。如果附近有队友掉落，可能被自动拾取捡走；需要时和队友确认。`;
                this.notify('inventory.collected', KIND.WORLD, LEVEL.WAKE, {
                    item: text,
                    gained,
                    auto_pickup: true,
                    nearby_players: nearbyPlayers,
                    nearby_player: nearbyPlayers[0] ?? null,
                    expected_item: expectedItem,
                    hint,
                });
            } catch (err: unknown) {
                console.error('collect event failed:', err instanceof Error ? err.message : String(err));
            }
        }, PICKUP_CONFIRM_DELAY_MS);
    }

    /**
     * 开发者通道：`bots/<name>/inbox.txt` 里**新增的每一行**都当一条用户消息投进去。
     *
     * 为什么需要：跑起来之后要跟机器人说话，原来只有两条路——人肉在游戏里打字，
     * 或者重启（丢进度）。而临时起一个 mineflayer 客户端进服在这台服务器上会卡在
     * 握手。文件通道不依赖任何协议细节，脚本能写、也能一次性给两个 bot 发。
     *
     * 记游标只读新增内容，所以重复调用不会重复投递。读到就当成一条
     * "developer 说的话"推给大脑，和玩家在游戏里说话是同一条路。
     *
     * **游标会落盘**（`bots/<name>/.inbox-cursor.json`）：不落盘的话重启会把
     * 上一个文件里的最后几行又推一遍，大脑那边看起来就是"人又重复说了一遍"，
     * 白跑一轮推理。落盘时必须**连头部指纹一起存**，理由见 `encodeCursor`。
     */
    private pollInbox(): void {
        const file = `./bots/${this.name}/inbox.txt`;
        try {
            const size = statSync(file).size;
            const content = Buffer.alloc(size);
            const fd = openSync(file, 'r');
            try {
                if (size > 0) readSync(fd, content, 0, size, 0);
            } finally {
                closeSync(fd);
            }
            const before = this.inbox;
            const { lines, cursor } = readInbox(content, before);
            this.inbox = cursor;
            if (cursor.offset !== before.offset || cursor.prefix !== before.prefix) {
                this.saveInboxCursor();
            }
            for (const line of lines) {
                // 开发者通道也走同一类事件：它只是"消息"，不假装是玩家在说话。
                this.notify('developer.message', KIND.USER, LEVEL.WAKE, {
                    from: 'developer',
                    message: line,
                    whisper: false,
                });
            }
        } catch {
            // 没有 inbox 文件是常态，不是错误。
        }
    }

    /** 读回上次的读游标。读不到 / 坏了都当"没读过"——最坏后果只是重放一次 inbox。 */
    private loadInboxCursor(): void {
        try {
            this.inbox = decodeCursor(readFileSync(this.inboxCursorFile(), 'utf8'));
        } catch {
            this.inbox = EMPTY_CURSOR;
        }
    }

    /** 落盘读游标。写不进去不影响本体——只是下次重启会重放，不是错误。 */
    private saveInboxCursor(): void {
        try {
            writeFileSync(this.inboxCursorFile(), encodeCursor(this.inbox), 'utf8');
        } catch {
            // 同上：落盘失败不该让身体出问题。
        }
    }

    private inboxCursorFile(): string {
        return `./bots/${this.name}/.inbox-cursor.json`;
    }

    /**
     * 边沿轮询（300ms 一次）：现拼快照，过检测器，定级后交给 `notify`。
     * 等级高的先处理。
     *
     * 不再 async：事件的投递现在是一次同步 `notify`（`EventIntake` 内部把
     * 异步动作串行化）——现在它在另一个进程，由传输层负责不阻塞心跳。
     */
    private pollEdges(): void {
        if (!this.edgeWatcher || !this.bot) return;
        let snapshot;
        try {
            snapshot = snapshotFromBot(this.bot, {
                currentAction: this.currentActionName(),
                foodNames: Object.keys(FOOD_VALUE),
                controlledLavaOperation: (this.bot as { controlledLavaOperation?: unknown }).controlledLavaOperation === true,
            });
        } catch {
            return;
        }
        let events;
        try {
            events = this.edgeWatcher.poll(snapshot);
        } catch {
            return;
        }
        // 卡住：有动作在跑但位置 60 秒没动（动了就重算；报一次后再等 60 秒）。
        const now = Date.now();
        const pos = snapshot.position ?? null;
        if (pos !== this.stuckPos) {
            this.stuckPos = pos;
            this.stuckSince = now;
        } else {
            const currentAction = this.currentActionName();
            // **站着干活不算卡住**：开箱子/合成/查背包时位置当然不变。模型真机报过
            // "误报 task.stuck"，每次误报都白花一次 PREEMPT 唤醒。
            const stuck =
                !isStationaryAction(currentAction) &&
                isStuck(this.stuckPos, pos, this.stuckSince, now, currentAction != null);
            if (stuck) {
                const seconds = Math.round((now - this.stuckSince) / 1000);
                this.stuckSince = now;
                this.notify('task.stuck', KIND.WORLD, LEVEL.PREEMPT, {
                    position: pos,
                    action: currentAction,
                    // 把"卡了多久"写进去，模型能据此判断是真卡还是刚起步。
                    stuckForSeconds: seconds,
                });
            }
        }
        // 心跳：5 分钟无动作无请求，醒一次做反思，防睡死。
        if (isHeartbeatDue(this.lastHeartbeatAt, now) && this.currentActionName() == null) {
            this.lastHeartbeatAt = now;
            this.notify('system.heartbeat', KIND.WORLD, LEVEL.WAKE, { at: now });
        }
        // 掉落物与背包变化：**边沿事件**，不是"每 300ms 问一次大脑要不要捡"。
        this.pollDrops();
        this.pollInventory();
        if (events.length === 0) return;
        events.sort((a, b) => b.level - a.level);
        for (const event of events) {
            const edgeLevel = resolvePriority(
                { type: event.type, level: event.level, key: event.key },
                snapshot,
            );
            const level = schedulerLevelFor(edgeLevel);
            const payload = {
                key: event.key,
                delta: event.delta,
                actionContext: event.actionContext,
            };
            // L5 的边沿：**事件带着它的处理一起走**（`reflex` 声明身体为它启动了
            // 哪个反射），不再是"大脑收到 L5 再回头点名调用保命"。
            if (event.type.startsWith('world.lava.')) {
                this.log.with('reflex').info({
                    event: 'lava-edge',
                    type: event.type,
                    controlledLavaOperation: snapshot.controlledLavaOperation === true,
                    hasSupport: snapshot.hasSupport === true,
                    distance: snapshot.lavaDistance ?? null,
                    inLava: snapshot.inLava === true,
                    nextIsLava: snapshot.nextIsLava === true,
                });
            }
            const reflex = level === LEVEL.EMERGENCY ? MineflayerBody.EDGE_REFLEX[event.type] : undefined;
            if (reflex != null) {
                this.emergency(event.type, payload, reflex.reflex, reflex.intent);
            } else {
                this.notify(event.type, KIND.WORLD, level, payload);
            }
        }
    }

    /**
     * 掉落物出现：**在它出现的那一刻报一次**，而不是每 300ms 问一次"附近有没有"。
     *
     * 轮询的错不在于多几次往返，而在于**在世界没有变化的时候声称"发生了"**——
     * 那是伪造事件，而且伪造出来的"发生"没有时点，模型永远不知道该以哪一刻为准。
     * 大脑侧的处理（走过去踩进背包）挂在事件类型 `item.drop.nearby` 上。
     */
    private pollDrops(): void {
        let target: PickupTarget | null;
        try {
            target = nearestDropWithin(this.bot, PICKUP_RADIUS);
        } catch {
            return;
        }
        const key = target == null ? null : String(target.id);
        if (key === this.seenDropId) return; // 还是那一件：没有新发生的事
        this.seenDropId = key;
        if (target == null) return;
        // **事件与处理一起走**：事件让模型知道地上出现了什么（L2，不唤醒），
        // 处理是身体自己走过去踩进背包（不用等一轮推理）。
        this.notify('item.drop.nearby', KIND.WORLD, LEVEL.STATE, target, { reflex: 'pickup' });
        // **掉落物出现这一刻，把"要不要去捡、为什么不去"记下来。**
        // 真机 2026-10-19（harness 追问「怪物击杀后掉落物恒为 0」）：日志里
        // `item.drop.nearby` 出现了（id 434443，就在击杀点 (-43.16,58,6.25)），
        // 但**一个都没进背包**——所以"没掉落"和"掉了但没人去踩"是两件事，
        // 必须由这一行分开：它回答 (b) 实体出现了吗、(c) 为什么没去捡。
        try {
            const threat = this.threatNearRelative(PICKUP_THREAT_RADIUS);
            const gate = {
                busy: this.actions.executing || this.hasModelActionInFlight(),
                pickingUp: this.pickingUp,
                sinceLastAttemptMs: Date.now() - this.lastPickupAt,
                backoffRemainingMs: this.pickupBackoffUntil - Date.now(),
                reflexBusy: this.reflexRunning === true || (this.reflexQueue?.length ?? 0) > 0,
                threatNear: threat != null,
            };
            const reasons: string[] = [];
            // **"背包未同步"不再是拦路理由**：它只影响能不能**测量**，不影响要不要去捡。
            // 真机 2026-10-19：`blockedBy=[背包未同步, 模型动作占用身体]` 让掉落物在
            // 3.3 米外躺着没人踩——把"测不出来"当成"不要去"是尾巴摇狗。
            const measurement: string[] = [];
            if (this.inventorySynced === false) measurement.push('背包未同步（捡到了也暂时读不出增量，用 stats 核对）');
            if (this.pickupAbortRequested) reasons.push('已被要求中止');
            if (gate.backoffRemainingMs > 0) reasons.push(`退避中 ${Math.round(gate.backoffRemainingMs)}ms`);
            if (this.pickupSuppressedUntil > Date.now()) reasons.push('保命后静默期');
            if (this.survivalCooldownUntil > Date.now()) reasons.push('保命交还冷却期');
            if (gate.reflexBusy) reasons.push(`反射在跑(${this.reflexRunning === true ? this.currentReflexName ?? '?' : 'queue'})`);
            if (gate.busy) reasons.push('模型动作占用身体');
            if (gate.threatNear) reasons.push(`附近有敌对生物(${threat?.name ?? '?'} ${Math.round(threat?.distance ?? 0)}格)`);
            if (this.pickingUp) reasons.push('已经在捡另一件');
            const metres = Math.round(Math.hypot(target.x - (this.bot as any).entity.position.x, target.y - (this.bot as any).entity.position.y, target.z - (this.bot as any).entity.position.z) * 10) / 10;
            this.log.with('lifecycle').info({
                event: 'drop-seen',
                id: target.id ?? null,
                distance: metres,
                willAttempt: reasons.length === 0,
                blockedBy: reasons,
                // 只影响"能不能测出增量"，不影响"要不要去捡"。
                measurement,
            });
            // **把四件事里的 (b)(c) 作为事实写给模型**（Lead 2026-10-19 裁定 ①）：
            // 「怪物掉落恒为 0」是错的——真机是"掉在地上 8 秒没人踩"。所以这里**不声称
            // 有没有掉落、也不声称捡没捡到**，只说三件我们知道的事：实体出现了（坐标）、
            // 距离多少、自动拾取会不会去（不去的话被什么挡住）。
            //
            // **首行是稳定的机器可读标记 `drop-seen{…}`**：`progression.ts`（feedback-analyst）
            // 会从 `bot.output` 里取最后一条 `drop-seen{…}` 当 `dropDiagnostics`，用来把
            // 「捡到 0 个」拆成四个事实。两边对齐、不重复——标记在前，人话在后。
            const marker =
                `drop-seen{id=${target.id ?? '?'}, ` +
                `pos=(${Number(target.x).toFixed(1)},${Number(target.y).toFixed(1)},${Number(target.z).toFixed(1)}), ` +
                `dist=${metres}m, willAttempt=${reasons.length === 0}, blockedBy=[${reasons.join('、')}]}`;
            void this.writeAdvice(
                `${marker}\n    【掉落物出现】Item id=${target.id ?? '?'} @(${Number(target.x).toFixed(1)},${Number(target.y).toFixed(1)},${Number(target.z).toFixed(1)})，` +
                    `距离 ${metres} 格。自动拾取：${reasons.length === 0 ? '**会去踩**' : `**暂时不会去**（${reasons.join('、')}）`}` +
                    (measurement.length > 0 ? `（注意：${measurement.join('；')}——这只影响读数，不阻止去捡）` : '') +
                    '。这三句是事实：**实体已经存在**、距离多少、去不去捡——它**不代表**你捡到了，也不代表没有掉落。',
            );
        } catch {
            // 诊断失败不影响拾取。
        }
        this.schedulePickup(target);
    }

    /**
     * 自动拾取专用寻路：直接走 pathfinder，不经过 goToGoal 的两次 1s 快速探测。
     *
     * goToGoal 的探测阶段不认 interrupt_code；模型动作来抢占时如果卡在探测里，
     * ActionManager 会 clearBotLogs 把 interrupt_code 清掉，拾取继续跑并和模型
     * 动作抢 pathfinder，把模型动作卡成 ACTION_BUSY（Feedback #64）。
     */
/**
     * **动作收尾的拾取清扫**（Lead 2026-10-19 裁定 ②）。
     *
     * 真机：`huntFor` 打死骷髅、掉落物 id=450058 就在 3.3 米外，因为
     * `blockedBy=[背包未同步, 模型动作占用身体]` 一步都没走——战利品在地上躺 8 秒以上
     * 直到消失。**动作刚结束的那一刻正是捡东西的最佳时机**（东西就在刚才干活的地方），
     * 所以给一个**有界**（1.5 秒）的清扫：走过去、报告捡到了什么。
     *
     * 约束：只在动作收尾、身体空闲时跑；不抢保命（反射在跑就直接放弃）；有界 + 有日志。
     */
    private async sweepPickupAtActionTail(): Promise<string | null> {
        const started = Date.now();
        if (this.pickingUp) return null;
        // **只有真保命在跑才放弃清扫。** 模型 Stop 留下的 `pickupAbortRequested` 不是危险，
        // 而战利品**只会**在这一瞬间被捡到（Lead 2026-10-19：abort 窗口里掉的战利品
        // 之前永远没人捡——`blockedBy=["已被要求中止","模型动作占用身体"]` 就是这么来的）。
        if (this.reflexRunning === true || (this.reflexQueue?.length ?? 0) > 0) return null;
        let target: PickupTarget | null = null;
        try {
            target = nearestDropWithin(this.bot, 4);
        } catch {
            return null;
        }
        if (target == null) return null;
        const before = this.readInventoryCounts();
        // **一次性几何取证**（Lead 2026-10-19 要求）：掉落在 0.2–0.5 米却不被捡，
        // 必须能回答"是我们的距离算错了、还是实体是假的、还是服务端不干活"。
        // 只记事实：双方 y、dy、实体 onGround、物品脚下方块、包围盒重叠判定、双方 onGround。
        try {
            const e: any = (this.bot as any)?.entities?.[target.id as any];
            const bp: any = (this.bot as any)?.entity?.position;
            const ip = e?.position;
            const under = ip != null
                ? (this.bot as any).blockAt?.(new Vec3(Math.floor(ip.x), Math.floor(ip.y) - 1, Math.floor(ip.z)))
                : null;
            const verdict =
                ip != null && bp != null
                    ? pickupOverlapVerdict({
                          bot: { x: bp.x, y: bp.y, z: bp.z, height: Number((this.bot as any)?.entity?.height ?? 1.8) },
                          item: { x: ip.x, y: ip.y, z: ip.z },
                      })
                    : null;
            this.log.with('lifecycle').info({
                event: 'drop-geometry',
                id: target.id ?? null,
                botY: bp != null ? Math.round(Number(bp.y) * 100) / 100 : null,
                itemY: ip != null ? Math.round(Number(ip.y) * 100) / 100 : null,
                dy: ip != null && bp != null ? Math.round((Number(ip.y) - Number(bp.y)) * 100) / 100 : null,
                itemOnGround: e?.onGround ?? null,
                underItem: String(under?.name ?? ''),
                overlap: verdict?.overlap ?? null,
                overlapReason: verdict?.reason ?? null,
                botOnGround: (this.bot as any)?.entity?.onGround ?? null,
            });
        } catch {
            // 取证失败不影响清扫。
        }
        let collected = false;
        try {
            // 有界：最多 1.5 秒（超时就走人，不拖住回执）。
            const walk = this.walkToPickup(target);
            const budget = new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), 1_500);
                (timer as { unref?: () => void }).unref?.();
            });
            await Promise.race([walk, budget]);
            // 判定"捡到"优先看实体是否消失（背包读数可能未同步，不能当唯一依据）。
            const entity = (this.bot as any)?.entities?.[target.id as any];
            const after = this.readInventoryCounts();
            const gained = before != null && after != null
                ? Object.keys(after).some((name) => (after[name] ?? 0) > (before[name] ?? 0))
                : null;
            collected = entity == null || gained === true;
        } catch {
            collected = false;
        }
        const ms = Date.now() - started;
        try {
            this.log.with('lifecycle').info({
                event: 'pickup-tail-sweep',
                attempted: true,
                target: target.name,
                id: target.id ?? null,
                collected,
                ms,
            });
        } catch {
            // 日志失败不影响回执。
        }
        const delta = this.describeInventoryDelta(before, this.readInventoryCounts(), target.name);
        return collected
            ? `\n    【收尾清扫】动作结束后去捡了 ${target.name}（${ms}ms）：**捡到了**${delta.changed ? `（背包实测：${delta.note}）` : ''}。`
            : `\n    【收尾清扫】动作结束后试着去捡 ${target.name}（${ms}ms），**这次没进包**（东西可能还在原地或已被别的东西挡住）。`;
    }

    private async walkToPickup(target: PickupTarget): Promise<boolean> {
        try {
            const movements = movementsFor(this.bot);
            // 拾取只是走过去，别为了抄近路乱挖：和 goToGoal 的非破坏性配置对齐。
            movements.digCost = 10;
            movements.placeCost = 2;
            this.bot.pathfinder.setMovements(movements);
            return await this.gotoPickupInterruptibly(
                new (pf as any).goals.GoalNear(target.x, target.y, target.z, 0),
                PICKUP_TIMEOUT_MS,
            );
        } catch {
            return false;
        }
    }

    /**
     * 拾取专用可中断 goto：同时认 interrupt_code 和 pickupAbortRequested。
     *
     * runPathfindingInterruptibly 只看 interrupt_code；模型动作一开始
     * ActionManager.clearBotLogs 会把它清掉，所以拾取需要一个独立取消标志。
     * 50ms 轮询足够快，模型动作不用等拾取超时。
     */
    private gotoPickupInterruptibly(goal: unknown, timeoutMs: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const started = Date.now();
            let settled = false;
            const finish = (ok: boolean): void => {
                if (settled) return;
                settled = true;
                clearInterval(timer);
                this.pickupCancel = null;
                resolve(ok);
            };
            this.pickupCancel = () => {
                try {
                    this.bot.pathfinder?.stop?.();
                } catch {
                    // 停不下来也要按取消返回。
                }
                finish(false);
            };
            const timer: ReturnType<typeof setInterval> = setInterval(() => {
                const timedOut = Date.now() - started >= timeoutMs;
                // 名字 / 实体 id 两条都查：名字可能读不到或中途被改写，
                // id 只在这件实体身上成立（markDiscarded 时由 itemDrop 认领）。
                const discarded =
                    (this.pickupTargetName != null && isDiscardedDrop(this.pickupTargetName)) ||
                    isDiscardedDropById(this.pickupTargetId);
                if (this.pickupAbortRequested || this.bot?.interrupt_code || timedOut || discarded) {
                    try {
                        this.bot.pathfinder?.stop?.();
                    } catch {
                        // 停不下来也要按取消/超时返回。
                    }
                    finish(false);
                }
            }, 50);
            let gotoPromise: Promise<unknown>;
            try {
                gotoPromise = Promise.resolve(this.bot.pathfinder.goto(goal));
            } catch {
                finish(false);
                return;
            }
            gotoPromise.then(() => finish(true), () => finish(false));
        });
    }

    /**
     * 自动拾取的处理：走过去把掉落物踩进背包。
     *
     * 它是**最低优先级的房客**：身体正在给模型干活时（`actions.executing`）
     * 就老实等着，下一次边沿再试；反过来模型要用身体时，身体动作入口的
     * `stop()` 会打断这段走路——**模型的动作永远优先**。
     *
     * 为什么它住在身体侧：走路 + 踩掉落物全是 `bot` 操作，毫秒到秒级，
     * 等不了一轮推理；而且"身体忙不忙"在这里是同步可读的
     * （`actions.executing`），在大脑侧只能靠一趟协议往返猜。
     */
    private schedulePickup(target: PickupTarget): void {
        const now = Date.now();
        if (this.pickupAbortRequested) return;
        // **背包没同步不许再挡住"去捡"。** 走路踩到掉落物是无害且可逆的；同步状态只影响
        // 我们**能不能测出**"捡没捡到"，不决定要不要去捡。（真机 2026-10-19：掉落物
        // id=450058 就在 3.3 米外，`blockedBy=[背包未同步, 模型动作占用身体]`，一步都没走。）
        // 没同步时照捡，回执写"捡了，但背包读数此刻不可用——用 stats 核对"。
        const canMeasure = this.inventorySynced !== false;
        if (now < this.pickupBackoffUntil) return;
        // 保命抢占后的静默期：命保住了再谈捡东西。
        if (now < this.pickupSuppressedUntil) return;
        // 保命把身体交还给模型的冷却期：**这段时间身体是模型的**，
        // 拾取别去抢（它是最低优先级的房客）。
        if (now < this.survivalCooldownUntil) return;
        // 刚 discard 的东西即使实体已经出现，也不许再被自己捡回：
        // 名字 / 落点 / 实体 id 三条路一起判（见 auto_pickup.ts 的 matchedRecord）。
        if (isDiscardedDrop(target.name, target, target.id)) return;
        // 威胁范围内有敌对生物：**别去捡**（真机 15:56 就是一边挨打一边被拖着走）。
        const threat = this.threatNearRelative(PICKUP_THREAT_RADIUS);
        const go = shouldAttemptPickup({
            busy: this.actions.executing || this.hasModelActionInFlight(),
            pickingUp: this.pickingUp,
            sinceLastAttemptMs: now - this.lastPickupAt,
            backoffRemainingMs: this.pickupBackoffUntil - now,
            // 保命反射在跑（或队列里还有）：非保命反射让路。
            reflexBusy: this.reflexRunning === true || (this.reflexQueue?.length ?? 0) > 0,
            // **击杀后 5 秒内，"附近有怪"不再挡住拾取**——刚打完怪正是要踩战利品的时候
            // （战利品在地上躺 5 分钟就没了）。但**正在挨打就不抢**：保命优先。
            threatNear:
                threat != null &&
                !shouldBypassThreatGateForPickup({
                    now,
                    priorityUntil: this.pickupPriorityUntil,
                    lastHurtAt: this.lastDamageAt,
                }),
        });
        if (!go) {
            if (threat != null && this.pickupThreatSkippedId !== String(target.id)) {
                this.pickupThreatSkippedId = String(target.id);
                this.notify(
                    'reflex.done',
                    KIND.WORLD,
                    LEVEL.STATE,
                    {
                        reflex: 'pickup',
                        outcome: 'skipped',
                        detail:
                            `附近有敌对生物 ${threat.name ?? '?'}（${Math.round(threat.distance ?? 0)} 格），` +
                            '这次不去捡掉落物——先保命。',
                        ms: 0,
                        failures: this.pickupFailures,
                        backoffMs: 0,
                        preempted: true,
                    },
                    { completes: 'pickup' },
                );
            }
            return;
        }
        this.pickupThreatSkippedId = null;
        this.lastPickupAt = now;
        this.pickupTargetName = target.name;
        this.pickupTargetId = typeof target.id === 'number' ? target.id : null;
        this.pickingUp = true;
        void (async (): Promise<void> => {
            const started = Date.now();
            // **背包快照差分**（真机 2026-10-19：pickup 走到位置没入包，同时原有 dirt×6
            // 消失——"背包变了却没人说"）。走路前后各读一次完整账目，走路期间**任何**
            // 变化都留一行有界证据，这样下一次能直接区分：
            //   ① 从没捡到（账目没变）；② 捡到了又丢（先 + 后 -）；③ 只是读错了（读数不可用）。
            const invBeforeWalk = this.readInventoryCounts();
            let arrived: boolean;
            // **轨迹采样**：走路期间每 250ms 记一次"掉落物相对 bot 的位置 + bot 有没有动"，
            // 最多 6 次（有界）。真机 overnight_a：「0.9m 同层第 6 次捡不到；move 方向反；
            // jump 无效」——到底有没有真正靠近、还是原地没动，只能靠这段轨迹回答。
            const traceSamples: Array<{ botMoved: number; dx: number; dy: number; dz: number; overlap: boolean }> = [];
            let lastBotPos: { x: number; y: number; z: number } | null = null;
            const sampleTrace = (): void => {
                if (traceSamples.length >= 6) return;
                try {
                    const p = (this.bot as any)?.entity?.position;
                    const entity = (this.bot as any)?.entities?.[String(target.id)] ?? (this.bot as any)?.entities?.[target.id as any];
                    const itemPos = entity?.position;
                    if (p == null || itemPos == null) return;
                    const botPos = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
                    const botMoved =
                        lastBotPos == null
                            ? 0
                            : Math.hypot(botPos.x - lastBotPos.x, botPos.y - lastBotPos.y, botPos.z - lastBotPos.z);
                    lastBotPos = botPos;
                    const verdict = pickupOverlapVerdict({
                        bot: { x: botPos.x, y: botPos.y, z: botPos.z, height: Number((this.bot as any)?.entity?.height ?? 1.8) },
                        item: { x: Number(itemPos.x), y: Number(itemPos.y), z: Number(itemPos.z) },
                    });
                    traceSamples.push({ botMoved, dx: verdict.dx, dy: verdict.dy, dz: verdict.dz, overlap: verdict.overlap });
                } catch {
                    // 采样失败不影响拾取。
                }
            };
            const traceTimer = setInterval(sampleTrace, 250);
            (traceTimer as { unref?: () => void }).unref?.();
            try {
                arrived = await this.walkToPickup(target);
            } catch {
                arrived = false;
            } finally {
                clearInterval(traceTimer);
                sampleTrace();
                this.pickingUp = false;
                this.pickupCancel = null;
                this.pickupTargetName = null;
                this.pickupTargetId = null;
                // 模型动作的抢占标志由拾取任务收尾时清掉，确保它至少被本次
                // walkToPickup/gotoPickupInterruptibly 看到一次。
                this.pickupAbortRequested = false;
            }
            const pickupTrace = summarizePickupTrace(traceSamples);
            if (!arrived && pickupTrace.samples > 0) {
                try {
                    this.log.with('lifecycle').info({
                        event: 'pickup-trace',
                        target: target.name,
                        id: target.id ?? null,
                        samples: pickupTrace.samples,
                        botTravel: Math.round(pickupTrace.botTravel * 100) / 100,
                        overlapEver: pickupTrace.overlapEver,
                        closest: pickupTrace.closest,
                        note: pickupTrace.note,
                    });
                } catch {
                    // 日志失败不影响拾取流程。
                }
            }
            const invAfterWalk = this.readInventoryCounts();
            const walkDiff = this.describeInventoryDelta(invBeforeWalk, invAfterWalk, target.name);
            if (walkDiff.changed) {
                try {
                    this.log.with('lifecycle').info({
                        event: 'pickup-inventory-diff',
                        target: target.name,
                        arrived,
                        gained: walkDiff.gained,
                        lost: walkDiff.lost,
                        note: walkDiff.note,
                    });
                } catch {
                    // 日志失败不影响拾取流程。
                }
            }
            // 被抢占（模型动作 / 保命 / Stop）不算拾取失败：不累计退避，
            // 也不把通道算在拾取头上。
            const preemptReason = this.pickupPreemptReason;
            this.pickupPreemptReason = null;
            const preempted = preemptReason != null || this.hasModelActionInFlight() || this.actions.executing;
            let backoffMs = 0;
            let gaveUp = false;
            if (arrived) {
                this.pickupFailures = 0;
                this.pickupBackoffUntil = 0;
            } else if (!preempted) {
                this.pickupFailures += 1;
                if (shouldGiveUpPickup(this.pickupFailures)) {
                    // **认了，别 3 秒一次地无限重试。** 真机 15:56：反复
                    // "退避 3 秒后再试"每次都占着通道，模型的自救动作全被拒。
                    gaveUp = true;
                    backoffMs = PICKUP_GIVE_UP_MS;
                    this.pickupBackoffUntil = Date.now() + backoffMs;
                    this.pickupSuppressedUntil = Math.max(this.pickupSuppressedUntil, this.pickupBackoffUntil);
                    this.pickupFailures = 0;
                } else {
                    backoffMs = nextPickupBackoffMs(this.pickupFailures);
                    this.pickupBackoffUntil = Date.now() + backoffMs;
                }
            }
            this.notify(
                'reflex.done',
                KIND.WORLD,
                LEVEL.STATE,
                {
                    reflex: 'pickup',
                    outcome: arrived ? 'ok' : 'failed',
                    detail:
                        (arrived
                            ? '走到了 ' + target.name + ' 的位置；是否入包由 playerCollect 核验后另行报告。'
                            : preemptReason != null
                                ? preemptReason
                                : preempted
                                    ? '拾取被模型动作抢占，已释放身体通道（模型优先，本次不额外退避）。'
                                    : gaveUp
                                        ? `连续 ${PICKUP_GIVE_UP_ATTEMPTS} 次没走到掉落物，**放弃这次拾取**` +
                                            `（${Math.round(backoffMs / 1000)} 秒内不再自动捡；地上那件先放着，` +
                                            '要就拿它当目标自己走过去踩）。'
                                        : '没走到 ' + target.name + ' 的位置（超时）；' +
                                            '已释放身体通道，退避 ' + Math.round(backoffMs / 1000) + ' 秒后再试。') +
                        // **接上"走路期间背包发生了什么"**：没变化 ⇒ "没捡到"不等于"捡了又丢"；
                        // 有变化 ⇒ 点名变化（含"原有物品减少"这种数据丢失形态），别让模型猜。
                        (walkDiff.changed
                            ? `；走路期间背包变化：${walkDiff.note}`
                            : '；走路期间背包**没有变化**（没捡到 ≠ 捡了又丢）。') +
                        // **几何证据**：没走到时把轨迹摘要也带上（有没有真靠近、bot 动没动）。
                        (!arrived && pickupTrace.samples > 0 ? `；拾取轨迹：${pickupTrace.note}` : ''),
                    ms: Date.now() - started,
                    failures: arrived ? 0 : this.pickupFailures,
                    backoffMs,
                    preempted,
                    gaveUp,
                },
                { completes: 'pickup' },
            );
        })();
    }

    /**
     * 背包变化：**变化的那一刻报一次**，载荷是新的完整槽位表。
     *
     * 第一次观察也算一次变化（从"还不知道"到"已知"），所以大脑启动后不用再
     * 专门问一次背包——`Task` 数物品用的缓存就是这条事件喂起来的。
     */
    private pollInventory(): void {
        let slots: ({ name: string; count: number } | null)[];
        try {
            slots = this.getInventorySlots();
        } catch {
            return;
        }
        const signature = JSON.stringify(slots);
        if (signature === this.inventorySignature) return;
        this.inventorySignature = signature;
        this.notify('inventory.changed', KIND.WORLD, LEVEL.STATE, { slots });
    }

    // ── 保命反射（L5）──────────────────────────────────────────────────────

    /**
     * 半径内最近的敌对生物（没有就 null）。
     *
     * 给"挨打就跑"用的轻量版。**判定直接用 `emergency.isHostile`**——
     * 手写第二份怪物名单迟早和它漂移。
     */
    private threatNear(feet: { x: number; y: number; z: number } | null, radius: number): {
        name: string;
        distance: number;
    } | null {
        if (feet == null) return null;
        try {
            const threats = (Object.values((this.bot?.entities ?? {}) as Record<string, unknown>) as Array<
                Record<string, unknown>
            >)
                .filter((e) => e != null && e['position'] != null && (e as { name?: unknown }).name !== 'item')
                .map((raw) => {
                    const e = raw as {
                        name?: unknown;
                        displayName?: unknown;
                        kind?: unknown;
                        position?: { x?: number; y?: number; z?: number };
                    };
                    const name = typeof e.name === 'string' ? e.name : 'unknown';
                    // **判定复用 mcdata 的 `isHostile(e)`**——`rescue()` 的 threats()
                    // 用的是同一个函数，两处结论天然一致。id 沿用原值（nearestThreat
                    // 只用它当标识）。
                    const id = typeof (raw as { id?: unknown }).id === 'number' ? (raw as { id: number }).id : -1;
                    // 没有 mcdata 时（登录前/测试夹具）退回实体自己的 type；生产里
                    // runtime type 是协议种类（mob/player/object），不会是 hostile。
                    const hostile =
                        isHostile(raw) ||
                        (raw as { type?: unknown }).type === 'hostile';
                    // 生产环境里 mineflayer 的 runtime 	ype 只有 'player'/'mob'/'object'，
                    // 不会是 'hostile'，所以这条只对测试夹具/自定义模拟生效，不会误伤真实世界。
                    const pos = e.position;
                    const position =
                        typeof pos?.x === 'number' && typeof pos?.y === 'number' && typeof pos?.z === 'number'
                            ? { x: pos.x, y: pos.y, z: pos.z }
                            : null;
                    return { id, name, hostile, position };
                })
                .filter((e): e is { id: number; name: string; hostile: boolean; position: { x: number; y: number; z: number } } =>
                    e.hostile && e.position != null);
            const found = nearestThreat(threats, feet, radius);
            return found == null
                ? null
                : { name: found.entity.name, distance: Math.round(found.distance * 10) / 10 };
        } catch {
            return null;
        }
    }

    /**
     * 身体侧的保命处理：**按事件类型选定的那一种处境**跑一次。
     *
     * 它不再是一个被大脑隔着一趟协议点名调用的独立操作——调用它的是这条
     * 事件自己的处理（见 `emergency()` / `EDGE_REFLEX`）。返回值就是处理的
     * 结果，会被写成 `reflex.done` 记录进上下文。
     */
    async rescue(intent: EmergencyIntent): Promise<EmergencyResult> {
        const bot = this.bot;
        // 这一棒的取消令牌：Stop/急停/预算用完会 `cancel()` 它，`rescue` 当场返回
        // （否则 stopAll 停掉的寻路会在下一 tick 被逃跑循环重新起一条）。
        const { run, cancelled } = this.beginRescueRun();
        try {
            const loop = runEmergency({
                get health(): number {
                    return typeof bot.health === 'number' ? bot.health : 0;
                },
                inventoryNames: (): string[] => {
                    try {
                        return (bot.inventory.items() as Array<{ name: string }>).map((i) => i.name);
                    } catch {
                        return [];
                    }
                },
                feet: (): { x: number; y: number; z: number } | null => {
                    try {
                        const p = bot.entity.position;
                        return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
                    } catch {
                        return null;
                    }
                },
                threats: (): ThreatEntity[] => {
                    // Stop/急停之后这一棒已经被取消：**不再读世界**，让循环
                    // 按"没有威胁"自然收尾（只需再等一次 SAFE_SECONDS），
                    // 而不是继续每秒重算一份威胁表。
                    if (run.aborted) return [];
                    try {
                        return (Object.values(bot.entities ?? {}) as Array<Record<string, unknown>>)
                            .filter((e) => e != null && (e as { position?: unknown }).position != null)
                            .map((e) => {
                                const ent = e as { id?: unknown; name?: unknown; displayName?: unknown; position?: unknown };
                                const pos = ent.position as { x: unknown; y: unknown; z: unknown };
                                return {
                                    id: typeof ent.id === 'number' ? ent.id : -1,
                                    name: typeof ent.name === 'string' ? ent.name : 'unknown',
                                    // 运行时 	ype==='hostile' 只出现在测试夹具/模拟里（生产协议值
                                    // 只有 player/mob/object）；isHostile 在 mcdata 未就绪时无法判定。
                                    hostile:
                                        isHostile(e) ||
                                        (e as { type?: unknown }).type === 'hostile',
                                    position:
                                        typeof pos?.x === 'number' && typeof pos?.y === 'number' && typeof pos?.z === 'number'
                                            ? { x: pos.x, y: pos.y, z: pos.z }
                                            : null,
                                };
                            });
                    } catch {
                        return [];
                    }
                },
                stopAll: (): void => {
                    // 已经被 Stop/急停取消的这一棒**不许再动身体**：
                    // `requestInterrupt()` 会再停一次寻路，而模型此刻已经在用身体。
                    if (run.aborted) return;
                    this.requestInterrupt();
                },
                fleeTo: (x: number, z: number): void => {
                    // **每一次迈步前都认一次取消令牌**：Stop 之后一毫米都不许再平移
                    // （真机原话：「Stop 之后仍不停手」）。
                    if (run.aborted) return;
                    try {
                        const p = bot.entity.position;
                        const from = { x: p.x, y: p.y, z: p.z };
                        const dx = x - p.x;
                        const dz = z - p.z;
                        const distance = Math.max(1, Math.hypot(dx, dz));
                        // 把来路方向当成威胁，安全落点选择器会沿着逃跑方向找可站立的岸。
                        const awayFrom = { x: p.x - dx, y: p.y, z: p.z - dz };
                        const blockAt = (bx: number, by: number, bz: number): { name?: unknown } | null =>
                            bot.blockAt(new Vec3(bx, by, bz));
                        // ── **先刹车，再选路**（真机 2026-10-19：末地 4 次同因死亡，
                        // x/z 冻在 88.5/-1.40、y 从 39 一路掉到 -201——逃跑把它带出了岛）
                        // 判定顺序不能反：脚下没有实心 / 正在下坠时，**任何横向平移
                        // 都可能是往崖外走**。这时候唯一正确的动作是停止平移（下落本身
                        // 还可以靠落地/水桶救），而不是继续朝"远离威胁"的方向跑。
                        const feetCell = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
                        const under = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)));
                        const feetName = String(feetCell?.name ?? '');
                        const underName = String(under?.name ?? '');
                        const noFloor = underName === '' || underName === 'air' || underName === 'cave_air' || underName === 'void_air';
                        const velocityY = Number((bot.entity as { velocity?: { y?: unknown } })?.velocity?.y ?? 0);
                        const falling = Number.isFinite(velocityY) && velocityY < -0.5;
                        if (noFloor || falling || feetName === 'lava' || feetName === 'flowing_lava') {
                            // **介质决定这一档怎么走**（Lead 2026-10-19 裁定）：
                            //   虚空 / 读不到 ⇒ 保守只刹车（末地那四条命的教训）；
                            //   岩浆 / 水 ⇒ 刹车之后必须试：先朝**验证过安全**的落点横移，
                            //     再考虑水桶 MLG；都没有就诚实说"试过了，确实没有落点"。
                            // 真机 overnight_b：y≈79 自由落体到 y≈25 的岩浆，x/z 一格没动
                            // ——刹车对了，但"下方是岩浆"时刹车本身就是死刑。
                            const mediumProbe = readFallMedium(
                                (bx, by, bz) => bot.blockAt(new Vec3(bx, by, bz)),
                                { x: p.x, y: p.y, z: p.z },
                            );
                            const landedSpot = chooseSafeFleeTarget(blockAt, from, awayFrom, Math.max(2, distance));
                            const fallPlan = planFallRecovery({
                                feet: { x: p.x, y: p.y, z: p.z },
                                medium: mediumProbe.medium,
                                mediumAtY: mediumProbe.atY,
                                mediumName: mediumProbe.name,
                                // 走到这里就说明"脚下没有实心/正在下坠"，所以不是实地。
                                onSolidGround: false,
                                safeLanding: landedSpot.ok ? landedSpot.target : null,
                                hasPlaceableBlocks: (() => {
                                    try {
                                        return ((bot.inventory?.items?.() ?? []) as Array<{ name?: unknown }>).some((item) => {
                                            const name = String(item?.name ?? '');
                                            const def = (bot as any)?.registry?.blocksByName?.[name];
                                            return def != null && def.boundingBox === 'block';
                                        });
                                    } catch {
                                        return false;
                                    }
                                })(),
                                // 身边可依托的实心面（垫脚要靠在它侧面）：在 2 格内找一块非空、非危险方块。
                                placeAgainst: (() => {
                                    try {
                                        const base = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
                                        for (const d of [[0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0]]) {
                                            const b = bot.blockAt(new Vec3(base.x + d[0]!, base.y + d[1]!, base.z + d[2]!));
                                            const name = String(b?.name ?? '');
                                            if (name === '' || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
                                            if (name === 'lava' || name === 'flowing_lava' || name === 'water' || name === 'flowing_water') continue;
                                            return { x: base.x + d[0]!, y: base.y + d[1]!, z: base.z + d[2]! };
                                        }
                                        return null;
                                    } catch {
                                        return null;
                                    }
                                })(),
                                hasWaterBucket: (() => {
                                    try {
                                        return ((bot.inventory?.items?.() ?? []) as Array<{ name?: unknown }>).some(
                                            (item) => item?.name === 'water_bucket',
                                        );
                                    } catch {
                                        return false;
                                    }
                                })(),
                                dropDistance: mediumProbe.atY == null ? null : Math.floor(p.y) - mediumProbe.atY,
                            });
                            const stopTranslation = (): void => {
                                try {
                                    bot.pathfinder.stop();
                                } catch {
                                    // 停不掉寻路也要把控制键松开。
                                }
                                for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
                                    try {
                                        bot.setControlState(key as never, false);
                                    } catch {
                                        // 拿不到控制就尽力而为。
                                    }
                                }
                            };
                            if (fallPlan.rung === 'place' && fallPlan.target != null) {
                                // **垫脚，不横移**：末地虚空被击退时唯一的救命动作。
                                // 靠在身边实心面的侧面，把方块放到自己脚下那一格。
                                stopTranslation();
                                const against = fallPlan.target;
                                const feetCell = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
                                const offset = { x: against.x - feetCell.x, y: against.y - feetCell.y, z: against.z - feetCell.z };
                                void (async (): Promise<void> => {
                                    try {
                                        const item = ((bot.inventory?.items?.() ?? []) as Array<{ name?: unknown }>).find((entry) => {
                                            const name = String(entry?.name ?? '');
                                            const def = (bot as any)?.registry?.blocksByName?.[name];
                                            return def != null && def.boundingBox === 'block';
                                        });
                                        if (item == null) return;
                                        await bot.equip(item, 'hand');
                                        const refBlock = bot.blockAt(new Vec3(against.x, against.y, against.z));
                                        if (refBlock == null) return;
                                        // 面向"从依托块指向脚下格"的方向。
                                        await bot.placeBlock(refBlock, new Vec3(offset.x, offset.y, offset.z));
                                    } catch {
                                        // 垫不上也要留下回执（下面统一报）。
                                    }
                                })();
                                if (this.currentReflexName != null) {
                                    this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                                        reflex: this.currentReflexName,
                                        outcome: 'in_progress',
                                        detail: '逃生**下坠恢复（脚下垫方块）**：' + fallPlan.text,
                                        ms: this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0,
                                    });
                                }
                                return;
                            }                            if (fallPlan.rung === 'lateral' && fallPlan.target != null) {
                                // **横移这一档是"救命动作"**：目标已经过 `chooseSafeFleeTarget`
                                // 验证（脚/头空气 + 脚下实心 + 不碰岩浆/水）。
                                stopTranslation();
                                try {
                                    bot.pathfinder.setMovements(movementsFor(bot));
                                    bot.pathfinder.setGoal(
                                        new (pf as any).goals.GoalNear(fallPlan.target.x, fallPlan.target.y, fallPlan.target.z, 1),
                                    );
                                } catch {
                                    // 设不了目标就退回刹车（下面还会报一次）。
                                }
                                if (this.currentReflexName != null) {
                                    this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                                        reflex: this.currentReflexName,
                                        outcome: 'in_progress',
                                        detail:
                                            '逃生**下坠恢复（横移）**：' + fallPlan.text +
                                            ' 目标是那里而不是继续朝反方向跑；跑到就立刻站住。',
                                        ms: this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0,
                                    });
                                }
                                return;
                            }
                            if (fallPlan.rung === 'mlg') {
                                stopTranslation();
                                // `fleeTo` 是同步接口，所以这里**不 await**：拿桶 + 低头是
                                // "落地前倒水"的准备动作，fire-and-forget 即可，失败不影响回执。
                                void (async (): Promise<void> => {
                                    try {
                                        const bucket = ((bot.inventory?.items?.() ?? []) as Array<{ name?: unknown }>).find(
                                            (item) => item?.name === 'water_bucket',
                                        );
                                        if (bucket != null) {
                                            await bot.equip(bucket, 'hand');
                                            await bot.look(bot.entity.yaw, -Math.PI / 2, true);
                                        }
                                    } catch {
                                        // 倒水失败也要留下回执（下面统一报）。
                                    }
                                })();
                                if (this.currentReflexName != null) {
                                    this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                                        reflex: this.currentReflexName,
                                        outcome: 'in_progress',
                                        detail: '逃生**下坠恢复（水桶落地）**：' + fallPlan.text,
                                        ms: this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0,
                                    });
                                }
                                return;
                            }
                            stopTranslation();
                            // **同一条刹车回执不要每 tick 重播**：真机审计发现它在 B 的日志里
                            // 出现 152 次、A 里 54 次（内容一模一样）——"说太多等于没说"。
                            // 状态变了立刻说；没变最多每 5 秒说一次，并带上"第几次/已持续多久"。
                            this.fallBrakeNotices += 1;
                            const brakeKey = `brake:${mediumProbe.medium}:${fallPlan.target?.x ?? '-'},${fallPlan.target?.z ?? '-'}`;
                            if (
                                this.currentReflexName != null &&
                                shouldEmitFallNotice(this.lastFallNotice, brakeKey, Date.now())
                            ) {
                                this.lastFallNotice = { key: brakeKey, at: Date.now() };
                                // 说清"为什么这一棒什么都没做"，而不是让它像是逃成功了。
                                this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                                    reflex: this.currentReflexName,
                                    outcome: 'in_progress',
                                    detail:
                                        '逃生**刹车**：' + fallPlan.text +
                                        ` 请立刻用方块垫脚或往回走上实地。（第 ${this.fallBrakeNotices} 次刹车，已持续 ${Math.round((this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0) / 1000)} 秒）`,
                                    ms: this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0,
                                });
                            }
                            return;
                        }
                        const safe = chooseSafeFleeTarget(blockAt, from, awayFrom, distance);
                        if (!safe.ok) {
                            // 附近没有可站立落点 ⇒ **原地不动**（站着吃饭/垒方块严格优于走进虚空）。
                            console.warn('emergency flee has no safe target:', safe.reason);
                            try {
                                bot.pathfinder.stop();
                            } catch {
                                // 同上。
                            }
                            if (this.currentReflexName != null) {
                                this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                                    reflex: this.currentReflexName,
                                    outcome: 'in_progress',
                                    detail:
                                        `逃生**原地不动**：找不到能站住的落点（${safe.reason}）。` +
                                        '站在原地吃/垒方块/等它过来，比走进虚空或岩浆好；请自己选一个方向用方块开路。',
                                    ms: this.currentReflexStartedAt > 0 ? Date.now() - this.currentReflexStartedAt : 0,
                                });
                            }
                            return;
                        }
                        bot.pathfinder.setMovements(movementsFor(bot));
                        // **用 GoalNear 而不是 GoalXZ**：GoalXZ 只匹配 x/z、**不看 y**，
                        // 于是路径可以走到"同一个 x/z 的另一个高度"——在末地就是沿着
                        // 岛边/虚空上方的格子绕过去。安全落点已经算出了 y，就必须要求
                        // 走到那个 y（1 格容差），否则"验证过的落点"形同虚设。
                        bot.pathfinder.setGoal(
                            new (pf as any).goals.GoalNear(safe.target.x, safe.target.y, safe.target.z, 1),
                        );
                    } catch (err: unknown) {
                        console.warn('emergency flee failed:', err instanceof Error ? err.message : String(err));
                    }
                },
                eat: (food: string): Promise<void> => {
                    if (run.aborted) return Promise.resolve();
                    return consume(bot, food).then(() => undefined);
                },
                submerged: (): boolean => {
                    // 取消之后不再上浮：这一棒已经交还身体，让 `runSurface` 立刻收尾。
                    if (run.aborted) return false;
                    try {
                        const p = bot.entity.position;
                        return bot.blockAt(p)?.name === 'water' && bot.blockAt(p.offset(0, 1.6, 0))?.name === 'water';
                    } catch {
                        return false;
                    }
                },
                swimUp: (): void => {
                    if (run.aborted) return;
                    try {
                        // 记录"呼吸反射在把我们顶上去"的证据（三方互锁判定要用）。
                        // 惰性初始化：测试 fixture 用 Object.create，拿不到类字段初值。
                        if (!Array.isArray(this.surfaceTriggerTimes)) this.surfaceTriggerTimes = [];
                        this.surfaceTriggerTimes.push(Date.now());
                        if (this.surfaceTriggerTimes.length > 200) this.surfaceTriggerTimes.splice(0, 100);
                        // **三方互锁例外**：确认卡死时只停呼吸反射 60 秒（其它保命照旧）。
                        if (Date.now() < this.surfaceStandDownUntil) return;
                        // 水里/岩浆里按 jump 就是上浮；顺便抬头，免得贴着天花板原地顶。
                        bot.setControlState('jump', true);
                        void bot.look(bot.entity.yaw, -Math.PI / 2, true);
                    } catch {
                        // 拿不到实体就没什么可做的。
                    }
                },
                feetBlockName: (): string | null => {
                    // 取消之后报"脚下不是岩浆"：让 `runLavaEscape` 当场收尾，而不是
                    // 继续每秒 setControlState / setGoal。
                    if (run.aborted) return null;
                    try {
                        return bot.blockAt(bot.entity.position)?.name ?? null;
                    } catch {
                        return null;
                    }
                },
                headBlockName: (): string | null => {
                    if (run.aborted) return null;
                    try {
                        return bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.name ?? null;
                    } catch {
                        return null;
                    }
                },
                lavaNear: (): { x: number; z: number } | null => {
                    if (run.aborted) return null;
                    try {
                        const p = bot.entity.position;
                        let best: { x: number; z: number; d: number } | null = null;
                        for (let dx = -3; dx <= 3; dx++) {
                            for (let dy = -2; dy <= 1; dy++) {
                                for (let dz = -3; dz <= 3; dz++) {
                                    const b = bot.blockAt(p.offset(dx, dy, dz));
                                    if (b?.name !== 'lava') continue;
                                    const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.1;
                                    if (best == null || d < best.d) {
                                        best = { x: Math.floor(p.x) + dx, z: Math.floor(p.z) + dz, d };
                                    }
                                }
                            }
                        }
                        return best == null ? null : { x: best.x, z: best.z };
                    } catch {
                        return null;
                    }
                },
                // 模型用 !disableSafeguards 签了生死状 → 连溺水都不再上浮。
                safeguardsOff: (): boolean => safeguards.isSuppressed(Date.now()),
                // **逃生必须能"验证落点"和"及时交还身体"**（Lead 2026-10-20：
                // escape 曾空转 30+ 秒、边掉血边把 bot 横移进怪堆、最后跑出 90 格）。
                hasSafeDestination: (): boolean => this.hasVerifiedEscapeDestination(),
                shouldYieldEscape: (): { yield: boolean; reason: string } | null => this.escapeYieldVerdict(),
                reportProgress: (info): void => this.reportEscapeProgress(info),
                // **逃跑必须有验证过的落点**：没有就在掉血时立刻交还身体（真机 2026-10-20：
                // escape 空转 30+ 秒，一边掉血一边被"横移到实心落点"，最后跑出 90 格、连死三次）。
            }, {
                // **处理按事件类型选定**：溺水只上浮，威胁只逃跑，不互相代劳。
                intent,
            });
            // 危险解除（loop 先到）或 Stop/急停（cancelled 先到）——谁先到谁说了算。
            return await Promise.race([loop, cancelled]);
        } catch (err: unknown) {
            this.log.with('emergency').warn({ phase: 'failed', intent, err: String(err) });
            throw err;
        } finally {
            if (this.currentRescueRun === run) this.currentRescueRun = null;
            // 被取消时 `runEmergency` 可能还在后台跑：令牌继续哑火，让它自己收尾。
            run.aborted = true;
        }
    }

    // ── 协议 ───────────────────────────────────────────────────────────────

    capabilities(): BodyCapabilities {
        return {
            bodyKind: 'mineflayer',
            agentName: this.name,
            // **工具声明从这里报给大脑**：名字/描述/参数/要不要附图/是不是长动作。
            // 实现（`perform`）不出去——大脑不需要，也不该拿到。
            //
            // 为什么声明由身体出而不是大脑自带一份清单：那样大脑里就得有整份
            // mineflayer 代码（历史欠债），而"身体/大脑是两个进程"只剩拓扑意义。
            // 声明不在握手里，就没法换一个身体（Java 真客户端）而大脑一行不改。
            //
            // 为什么不直接回 `[]`（那正是这一版之前的写法）：那等于把能力协商做成
            // 装饰——大脑没法区分"这个身体什么都能做"和"这个身体坏了"。现在
            // 空表会被大脑判成协议错误并拒绝启动（见 `Agent.bootstrap`）。
            tools: toolDeclarations(),
            // **截图是可选能力，所以它要如实申报**：相机起不来（`allow_vision=false`
            // 或原生模块坏了）就不报，大脑据此**不再每个回合白跑一次协议往返**。
            // 报一个自己给不了的能力，等于凭空多一次必然为 null 的调用。
            observations: [
                'live-state',
                ...(this.vision_interpreter?.captureBase64 != null ? ['screenshot'] : []),
            ],
        };
    }

    /**
     * 一次动作跑完，扣掉一次"按次数"额度（危险操作授权 / 保命抑制）。
     *
     * **这件事本来就该在身体侧做，而且理由比"状态在身体里"更直接**：
     * 计数的单位就是"身体执行了一次动作"，而唯一知道这件事的地方正是这里。
     * 以前是大脑在每次工具调用后专门发一条 `consumeCall` 指令来通知——
     * 一条为了同步一份身体已经知道的事实而存在的协议指令。
     *
     * 三条豁免与大脑侧原来保持一致：
     *   - 申请额度的三个控制工具本身不消耗（申请 3 次却只剩 2 次，模型算不清）；
     *   - **只读查询不消耗**：配额的是"危险操作"，查背包不该烧额度
     *     （Feedback #4：模型"只调了 allowDangerousOps"，额度却从 2 变 1）。
     */
    private consumePermitFor(toolName: string): void {
        const name = stripBang(toolName);
        if (CONTROL_TOOL_NAMES.has(name)) return;
        const declaration = toolDeclarations().find((d) => d.name === name);
        if (declaration?.kind === 'query') return;
        try {
            const permitSpent = permits.consumeCall(Date.now());
            const guardSpent = safeguards.consumeCall(Date.now());
            if (permitSpent || guardSpent) {
                this.log.with('safety').info({ note: '次数额度用尽，闸门/保命恢复默认', tool: name });
            }
        } catch {
            // 扣不动就算了：最坏是额度比模型以为的多用一次，不该让动作本身失败。
        }
    }

    getInventorySlots(): ({ name: string; count: number } | null)[] {        try {
            const slots = (this.bot.inventory?.slots ?? []) as Array<{ name?: string; count?: number } | null>;
            return slots.map((slot) =>
                slot == null ? null : { name: String(slot.name ?? ''), count: Number(slot.count ?? 0) },
            );
        } catch {
            return [];
        }
    }

    /**
     * 模型自救动作收尾：**成功才给 25 秒窗口，失败什么都不给**。
     *
     * 验证者探针 ①/⑤：旧实现把"让位 + 25 秒静音"放在执行**之前**，于是模型
     * 调一次 `consume`（或一次失败的 escapeWater）就能把正在救命的 `surface`
     * 关掉 25 秒。现在让位照旧要在执行前发生（否则两边同时驱动身体），
     * 但**冷却只在真成功之后**才给；失败时反射随时可以重新接管。
     */
    private settleModelRescue(success: boolean, baseName: string, preempted: number): void {
        if (success) {
            this.survivalCooldownUntil = Math.max(this.survivalCooldownUntil, Date.now() + SURVIVAL_COOLDOWN_MS);
            this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                reflex: baseName,
                outcome: 'preempted',
                detail:
                    `你用 ${baseName} 自救：已让出身体` +
                    (preempted > 0 ? `（中断 ${preempted} 条保命/反射）` : '') +
                    `，接下来 ${Math.round(SURVIVAL_COOLDOWN_MS / 1000)} 秒内保命不会抢回去。`,
                ms: 0,
            });
            return;
        }
        // 没成功：**不碰冷却**（既不新建也不清掉已有的），保命随时回来。
        this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
            reflex: baseName,
            outcome: 'preempted',
            detail:
                `你用 ${baseName} 自救：反射已让位` +
                (preempted > 0 ? `（中断 ${preempted} 条）` : '') +
                '，但这次**没成功**——保命随时会重新接管（没有静音窗口）。' +
                '看一眼为什么失败，必要时再发一次或先 Stop。',
            ms: 0,
        });
    }

    /** `BodyServer` 的处理函数。所有异常都变成 `ok:false`，不让它穿到传输层。 */
    async handle(request: BrainRequest): Promise<BodyResponse> {
        switch (request.op) {
            case 'hello':
                return { ok: true, op: 'hello', capabilities: this.capabilities() };
            case 'sample': {
                // 报告路径上**有界等一次背包同步**：刚重连立刻读会读到空包，
                // 而空包会被模型当成"家当没了"（真机事故见 inventorySynced）。
                await this.waitForInventorySync();
                // **"僵尸状态"检测放在这里**：模型每次采样都会经过，而它正是最需要
                // 知道"你已经无法自愈、出口在哪"的时候（真机：0.375 血/食物 0/空背包
                // 站了十多分钟，唯一恢复手段是人类在聊天里说了一句）。
                this.checkUnrecoverableState();
                return { ok: true, op: 'sample', state: sampleLiveState(this.sampleContext()) };
            }
            case 'image': {
                const vision = this.vision_interpreter;
                if (vision?.captureBase64 == null) return { ok: true, op: 'image', data: null };
                try {
                    return { ok: true, op: 'image', data: await vision.captureBase64() };
                } catch {
                    return { ok: true, op: 'image', data: null };
                }
            }
            case 'action': {
                const { name, args } = request.request;
                // 模型的动作优先于自动拾取：先占位阻止新的拾取，再让旧的收手。
                // 用计数而不是布尔：查询类 action 和占用类 action 可能重叠，
                // 一个先结束不能把另一个的在途状态清掉（否则 pickup 会钻空子）。
                this.modelActionRequested = true;
                this.modelActionsInFlight += 1;
                try {
                    await this.yieldAutoPickupToModel();
                    // 非保命反射也让位（保命反射除外：那是"先活下来"的那件事，
                    // 只有 Stop / 模型的自救动作能硬停它）。
                    this.yieldNonSurvivalReflexes('模型动作抢占：已放弃这次自动拾取。');
                    // **模型自己的自救动作优先于保命反射。** 真机 17:59 溺水：
                    // surface 反射和模型调的 escapeWater 互相抢，十几轮没上岸，
                    // 最后淹死。水里这件事模型的判断比反射准——让它接手。
                    //
                    // 注意三点（验证者探针 ①/⑤ 的教训）：
                    //   - 只有 `escapeWater` 在这一类里。`consume` 曾经也在，结果
                    //     "吃一口"（哪怕吃失败）就能打断正在救命的 surface 并静音
                    //     25 秒——吃饭不是从水里/岩浆里出来；
                    //   - 先让位是必须的（否则两边同时驱动身体，谁都做不完）；
                    //   - **冷却只在自救真的执行成功之后才给**：失败还静音 25 秒，
                    //     等于把命交给运气。
                    const baseName = String(name ?? '').replace(/^!/, '');
                    const rescueAttempt = MODEL_RESCUE_TOOLS.has(baseName);
                    let preempted = 0;
                    if (rescueAttempt) {
                        preempted = this.abortReflexes(`模型要用 ${baseName} 自救`);
                        this.survivalBusySince = null;
                        this.survivalBusyClass = null;
                    }
                    let text: string;
                    // **残留界面 = 所有动作空转 60 秒的元凶**（真机 2026-10-20：熔炉 GUI 的
                    // 方块被队友挖走了、界面还在，`goToSurface` 跑 61 秒、speed 0、位置没动）。
                    // 不变式：动作入口发现有窗口开着、且这个动作不是"自己管界面"的容器动作，
                    // 就先关掉再干活，并在回执里说明；关不掉就**大声失败**，不许空转。
                    let residualScreenNote = '';
                    try {
                        const hasWindow = (this.bot as any)?.currentWindow != null;
                        const managesWindow = name === 'useBlock' || name === 'craft' || name === 'smelt';
                        if (hasWindow && !managesWindow) {
                            const closed = closeStaleWindow(this.bot);
                            if (closed) {
                                residualScreenNote =
                                    '\n    先关掉了**残留界面**（否则所有动作都会空转）。';
                            } else if ((this.bot as any)?.currentWindow != null) {
                                return {
                                    ok: true,
                                    op: 'action',
                                    result: {
                                        ok: false,
                                        text:
                                            '**先失败在门口**：有个残留界面关不掉，继续执行只会空转 60 秒。\n' +
                                            '    先 `stop()`（Stop 会顺手关界面），再重发这个动作；别反复重试同一个调用。',
                                        code: 'REFUSED_RESIDUAL_SCREEN',
                                    },
                                };
                            }
                        }
                    } catch {
                        // 关界面出错不许挡住动作本身（守卫坏了就不拦）。
                    }
                    // **重伤不打架**：进攻类动作在这里被拒（在身体真的动手之前），
                    // 但只拒进攻——逃跑/吃/垫方块/自救一律放行，绝不让这条守卫
                    // 削弱"跑得掉"的能力。见 reflex_override.ts 的 combatRefusalVerdict。
                    const combatRefusal = this.criticalHealthRefusalFor(baseName);
                    if (combatRefusal != null) {
                        return {
                            ok: true,
                            op: 'action',
                            result: { ok: false, text: combatRefusal, code: 'REFUSED_CRITICAL_HEALTH' },
                        };
                    }
                    // **void 预检：走路工具不许把 bot 走进没有支撑的空间**（Lead 2026-10-19
                    // ②-3）。只在 `move`/`goToCoordinates` 上生效，边界写死：
                    //   走路工具拒绝"必须跨越无支撑空间"的目标；
                    //   搭桥工具（travelTo/placeBlock）才是过缺口的合法手段。
                    // 已经在空中不拦（那是保命反射的事）；其它工具一律原样放行。
                    const voidRefusal = this.voidWalkRefusalFor(baseName, args);
                    if (voidRefusal != null) {
                        return {
                            ok: true,
                            op: 'action',
                            result: { ok: false, text: voidRefusal, code: 'REFUSED_VOID_WALK' },
                        };
                    }
                    // **出发前准备检查**（末地/下界是单向 + 致死地形）：空手走进去不是
                    // 模型该"不小心"做的决定。真机 2026-10-19 07:00：overnight_a 空手
                    // （背包只有 dirt×10）走过虚空桥，被末影人打死。
                    // 只拦"进入"：出口/逃跑/保命反射一律不受影响；武器在包里就帮它拿上。
                    const departure = await this.departureCheckFor(baseName);
                    if (departure.text != null) {
                        return {
                            ok: true,
                            op: 'action',
                            result: { ok: false, text: departure.text, code: 'REFUSED_UNPREPARED_DEPARTURE' },
                        };
                    }
                    // 边界情况放行，但**提醒必须带进回执**（模型下一轮就看得到）。
                    const departureWarning = departure.warning ?? null;
                    if (departureWarning != null) {
                        // **一行有界日志**（只在真的带提醒时记）：以后能回答"这些提醒
                        // 是在帮忙，还是变成了墙纸"——统计放行次数 vs 后续死亡/进食。
                        try {
                            this.log.with('lifecycle').info({
                                event: 'departure-note',
                                tool: baseName,
                                food: Number.isFinite(Number((this.bot as any)?.food))
                                    ? Number((this.bot as any).food)
                                    : null,
                                blocks: null,
                            });
                        } catch {
                            // 日志失败不影响动作。
                        }
                    }
                    try {
                        text = await executeToolCall(this, name, args);
                        // **击杀确认 ⇒ 开 5 秒拾取优先窗口**：战利品就躺在脚下，而
                        // "附近有怪就跳过拾取"这条闸门恰好在这一刻最容易关着（真机：
                        // 骷髅死后 id 434443 在击杀点躺了 8 秒以上没人踩）。有界 + 有日志。
                        if (/Successfully killed|击杀已验证|已被你击杀/.test(String(text ?? ''))) {
                            this.pickupPriorityUntil = Date.now() + 5_000;
                            this.log.with('lifecycle').info({
                                event: 'pickup-priority-window',
                                ms: 5_000,
                                reason: 'kill-confirmed',
                            });
                        }
                        // **清掉粘住的 abort 标记**：模型 Stop 设的 `pickupAbortRequested`
                        // 若不清，之后**每一件**掉落物都会被判"已被要求中止"——真机里
                        // 0.2 米的掉落物就是这样一直不被捡的。保命反射真在跑时不清。
                        if (this.reflexRunning !== true) this.pickupAbortRequested = false;
                        // **动作收尾清扫掉落物**（有界 1.5 秒）：动作刚结束、东西就在刚才
                        // 干活的地方——这是捡战利品的最佳时机（真机：掉落物在 3.3 米外躺着没人踩）。
                        try {
                            const sweep = await this.sweepPickupAtActionTail();
                            if (sweep != null) text = String(text ?? '') + sweep;
                        } catch {
                            // 清扫失败绝不影响动作本身的回执。
                        }
                        // 提醒**追加在末尾**（见 annotateReceipt）：第一行留给"放行 + 实际发生了什么"。
                        text = annotateReceipt(text, departureWarning);
                        if (residualScreenNote !== '') text = String(text ?? '') + residualScreenNote;
                    } catch (err: unknown) {
                        // 抛错也算"这次自救没成"：**不许给冷却**，让保命随时能回来。
                        if (rescueAttempt) this.settleModelRescue(false, baseName, preempted);
                        // **被 Stop/中断打断的动作也要捡战利品**（Lead 2026-10-19 裁定：
                        // 模型 Stop 不是危险；abort 窗口里掉的掉落物之前永远没人捡）。
                        // 保命反射真在跑时才让路；结果接到失败回执末尾。
                        if (this.reflexRunning !== true) {
                            this.pickupAbortRequested = false;
                            try {
                                this.actionTailNote = await this.sweepPickupAtActionTail();
                            } catch {
                                this.actionTailNote = null;
                            }
                        }
                        throw err;
                    }
                    if (rescueAttempt) {
                        this.settleModelRescue(!toolResultLooksFailed(text), baseName, preempted);
                    }
                    this.consumePermitFor(name);
                    return { ok: true, op: 'action', result: { ok: true, text, code: 'OK' } };
                } catch (err: unknown) {
                    // **失败也要消耗**——这是"按次数授权"的全部意义：模型申请 3 次，
                    // 第 2 次寻路失败，额度当场用完，闸门立刻回到默认禁止。
                    this.consumePermitFor(name);
                    const message = err instanceof Error ? err.message : String(err);
                    return {
                        ok: true,
                        op: 'action',
                        result: {
                            ok: false,
                            text: `Tool ${name} failed: ${message}` + (this.actionTailNote ?? ''),
                            code: ERR.BODY_ERROR,
                        },
                    };
                } finally {
                    this.modelActionsInFlight = Math.max(0, this.modelActionsInFlight - 1);
                    if (this.modelActionsInFlight === 0) this.modelActionRequested = false;
                }
            }
            case 'say': {
                // 换行会被当成多条聊天，触发刷屏过滤 → 一律替换成空格（主线行为）。
                const text = String(request.text ?? '').replaceAll('\n', ' ');
                if (request.to != null) this.bot.whisper(request.to, text);
                else if (settings.chat_ingame) this.bot.chat(text);
                return { ok: true, op: 'say' };
            }
            case 'stop':
                // Stop 无条件清模型锁：即使 ActionManager.stop 内部异常/超时，
                // 也不能让 modelActionRequested 或 executing 残留卡住下一轮动作。
                this.modelActionRequested = false;
                this.modelActionsInFlight = 0;
                // **Stop 还要真的停掉反射。** 真机抱怨："Stop 之后反射还在跑"——
                // 反射占着身体时模型的动作全被拒，于是 Stop 也救不了它。
                // 拾取立刻收手并静默一段；正在跑的保命反射打中断标记。
                // **Stop 顺便关界面**：模型能用的唯一控制手段必须能解开残留界面这个死结。
                try {
                    if (closeStaleWindow(this.bot)) {
                        this.log.with('lifecycle').info({ event: 'residual-screen-closed', by: 'stop' });
                    }
                } catch {
                    // 关不掉也不影响 Stop 的其它语义。
                }
                this.abortAutoPickup('收到 Stop：已放弃这次自动拾取。');
                this.pickupSuppressedUntil = Math.max(
                    this.pickupSuppressedUntil,
                    Date.now() + PICKUP_SURVIVAL_SUPPRESS_MS,
                );
                const abortedReflexes = this.abortReflexes('收到 Stop');
                // Stop 还意味着"把身体判给模型一段时间"：否则危险还在时反射
                // 立刻重新接管，Stop 在模型眼里就是没反应（真机 17:15 的原话）。
                this.survivalCooldownUntil = Math.max(
                    this.survivalCooldownUntil,
                    Date.now() + SURVIVAL_COOLDOWN_MS,
                );
                this.survivalBusySince = null;
                this.survivalBusyClass = null;
                if (abortedReflexes > 0) {
                    // 回执走事件通道（协议里 stop 的响应形状不动）：让模型知道
                    // Stop 到底停了什么，而不是以为"没反应"。
                    // ⚠️ 措辞只承诺**已经做到的**：宽限期内那条保命处理可能还在收尾。
                    this.notify('reflex.done', KIND.WORLD, LEVEL.STATE, {
                        reflex: 'stop',
                        outcome: 'aborted',
                        detail:
                            `Stop 已中断自动拾取和 ${abortedReflexes} 条保命/反射` +
                            (this.reflexRunning === true
                                ? `（正在跑的 ${this.currentReflexName ?? '反射'} 最多再等 ${Math.round(REFLEX_STOP_GRACE_MS / 1000)} 秒收手，之后通道一定还给你）`
                                : '，通道现在就是你的') +
                            `；接下来 ${Math.round(SURVIVAL_COOLDOWN_MS / 1000)} 秒内保命不会重新接管（危险还在的话之后会再接管）。`,
                        ms: 0,
                    });
                }
                try {
                    await this.actions.stop();
                } finally {
                    this.modelActionRequested = false;
                    this.modelActionsInFlight = 0;
                    this.actions.releaseCurrentAction();
                }
                return { ok: true, op: 'stop' };
            case 'fullState':
                return { ok: true, op: 'fullState', state: getFullState(this as never) };
            case 'shutdown':
                this.shuttingDown = true;
                setTimeout(() => process.exit(0), 50);
                return { ok: true, op: 'shutdown' };
            default:
                return {
                    ok: false,
                    op: (request as { op: string }).op,
                    error: 'unknown op',
                    code: ERR.BAD_ENVELOPE,
                };
        }
    }
}
