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
import { initBot, isHostile } from './data/mcdata.js';
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
    consume,
    forceExitWater,
    goToPosition,
    stopPvp,
} from './library/skills.js';
import { headInWater } from './safety/water_safety.js';
import { movementsFor } from './safety/movements.js';
import {
    createEdgeWatcher,
    isHeartbeatDue,
    isStationaryAction,
    isStuck,
    resolvePriority,
    schedulerLevelFor,
    shouldEmitHurt,
    snapshotFromBot,
} from './edges.js';
import { renderEventText } from '../shared/event_stream.js';
import { nearestDropWithin, PICKUP_RADIUS, PICKUP_TIMEOUT_MS } from './auto_pickup.js';
import { nextPickupBackoffMs, shouldAttemptPickup } from '../shared/auto_pickup.js';
import type { PickupTarget } from '../shared/auto_pickup.js';
import { stripBang } from '../shared/tools.js';
import { getFullState } from './library/full_state.js';
import { decodeCursor, EMPTY_CURSOR, encodeCursor, readInbox, type InboxCursor } from './inbox.js';
import { safeguards } from './safety/safeguards.js';
import { permits } from './safety/permits.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { MESSAGES } from '../shared/prompts.js';
import settings from '../shared/settings.js';
import pf from 'mineflayer-pathfinder';

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
    const gained: Record<string, number> = {};
    for (const [name, count] of Object.entries(current)) {
        const delta = count - (previous[name] ?? 0);
        if (delta > 0) gained[name] = delta;
    }
    const parts = Object.entries(gained).map(([name, count]) => `${name}×${count}`);
    if (parts.length === 0) {
        return { text: '', gained, firstObservation: false, noChange: true };
    }
    return { text: parts.join('、'), gained, firstObservation: false, noChange: false };
}

/**
 * 附近另一个玩家的名字（没有就 null）。自动拾取提示用。
 *
 * 不判断掉落物的真正归属（客户端拿不到可靠的 owner），但至少能在
 * 「旁边站着队友」时提醒模型：这件东西可能是队友挖出来的。
 */
export function nearestOtherPlayerName(bot: unknown, radius: number = 8): string | null {
    const b = bot as {
        entity?: { id?: unknown; position?: { x?: number; y?: number; z?: number } };
        entities?: Record<string, unknown>;
    } | null | undefined;
    const self = b?.entity;
    const selfPos = self?.position;
    if (self == null || selfPos == null || typeof selfPos.x !== 'number' || typeof selfPos.y !== 'number' || typeof selfPos.z !== 'number') {
        return null;
    }
    let best: { name: string; distance: number } | null = null;
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
        if (best == null || distance < best.distance) best = { name, distance };
    }
    return best?.name ?? null;
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
    /** 模型动作请求已经在路上时，禁止新的自动拾取抢身体。 */
    private modelActionRequested = false;

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

    /**
     * 上一次看到的背包账目（物品名 → 数量）。给"刚捡到什么"反推用。
     *
     * 为什么不用掉落物实体：那个实体的 `name` 就是字面量 `'item'`，读不出是什么。
     * 而**背包的账目是服务端认的**，比猜实体元数据可靠。
     */
    private lastInventory: Record<string, number> | null = null;
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
            // 皮肤是身体的事（要发 /skin 命令）。主线的 `serverProxy.login()`
            // 是给 MindServer 看的，留在大脑。
            const skin = settings.profile?.['skin'] as { model: string; path: string } | undefined;
            if (skin) this.bot.chat(`/skin set URL ${skin.model} ${skin.path}`);
            else this.bot.chat(`/skin clear`);
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
     * 当前正在跑的动作名（模型的动作）。身体正在自主走路的反射（拾取）也报出来，
     * 免得模型看到"身体空着"却调不动。
     */
    currentActionName(): string | null {
        const label = this.actions?.currentActionLabel;
        if (label) return label;
        return this.pickingUp ? 'autoPickup' : null;
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
        };
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
        // 模型动作优先：只给拾取 300ms 收手，不能把模型工具调用拖成 ACTION_BUSY。
        this.requestInterrupt();
        const deadline = Date.now() + 300;
        while (this.pickingUp && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        // 还在跑就再发一次打断；modelActionRequested 会阻止新的拾取抢身体。
        if (this.pickingUp) this.requestInterrupt();
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

    /** 排空反射队列（已经在跑就什么都不做）。 */
    private async drainReflexes(): Promise<void> {
        if (this.reflexRunning) return;
        this.reflexRunning = true;
        try {
            for (;;) {
                const next = this.reflexQueue.shift();
                if (next == null) break;
                const started = Date.now();
                let outcome: 'ok' | 'failed' | 'partial' = 'ok';
                let detail = '';
                try {
                    const result = await this.rescue(next.intent);
                    if (result.reason === 'died') {
                        outcome = 'failed';
                        detail = '处理过程中死亡。';
                    } else if (result.escaped) {
                        outcome = 'ok';
                        detail = next.intent === 'surface' ? '已经把头露出水面。' : '已经脱离威胁。';
                    } else {
                        outcome = 'partial';
                        detail = '处理结束了，但没能确认脱险。';
                    }
                } catch (err: unknown) {
                    outcome = 'failed';
                    detail = err instanceof Error ? err.message : String(err);
                }
                this.notify(
                    'reflex.done',
                    KIND.WORLD,
                    LEVEL.STATE,
                    { reflex: next.reflex, outcome, detail, ms: Date.now() - started },
                    { completes: next.reflex },
                );
            }
        } finally {
            this.reflexRunning = false;
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
                this.notify('player.chat', KIND.USER, LEVEL.WAKE, {
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
        // 与上一次快照比对，多出来的就是刚捡到的。这个口径也顺带把"捡了 2 个"
        // 说清楚了（模型另外要求过带数量）。
        this.bot.on('playerCollect', (collector: any) => {
            try {
                if (!collector || collector.id !== this.bot?.entity?.id) return;
                // **等一拍再读背包**：玩家拾取事件常常先于客户端背包更新，
                // 立刻读会得到「没变化」——旧实现把这个占位文案写进了事件，
                // 模型据此误判背包是空的（真机 Feedback）。
                setTimeout(() => {
                    try {
                        const picked = this.inventoryDelta();
                        // 没有可识别的增量就**省略事件**，不写占位文案。
                        if (Object.keys(picked.gained).length === 0) return;
                        const now = Date.now();
                        if (now - this.lastCollectEmitAt < 2000) return;
                        this.lastCollectEmitAt = now;
                        const nearby = nearestOtherPlayerName(this.bot, PICKUP_RADIUS);
                        const hint =
                            nearby != null
                                ? `自动拾取：捡到了 ${picked.text}。附近有玩家 ${nearby}，这件可能是队友挖出的掉落物；需要的话和对方确认。`
                                : `自动拾取：捡到了 ${picked.text}。如果附近有队友挖出的掉落物，可能被自动拾取抢走了；需要时和队友确认。`;
                        this.notify('inventory.collected', KIND.WORLD, LEVEL.WAKE, {
                            item: picked.text,
                            gained: picked.gained,
                            auto_pickup: true,
                            nearby_player: nearby,
                            hint,
                        });
                    } catch (err: unknown) {
                        console.error('collect event failed:', err instanceof Error ? err.message : String(err));
                    }
                }, 100);
            } catch (err: unknown) {
                console.error('collect event failed:', err instanceof Error ? err.message : String(err));
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
     * 背包相对上一次快照的增量。返回一句给人看的话 + 结构化数字。
     *
     * 第一次调用只建立快照（没有可比对象），此时如实说"还没记下上一次的背包"，
     * 而不是编一个物品名出来。
     */
    private inventoryDelta(): InventoryGainSummary {
        const current: Record<string, number> = {};
        try {
            for (const item of (this.bot?.inventory?.items?.() ?? []) as Array<{ name?: string; count?: number }>) {
                const name = String(item?.name ?? '');
                if (name === '') continue;
                current[name] = (current[name] ?? 0) + Number(item?.count ?? 0);
            }
        } catch {
            return { text: '', gained: {}, firstObservation: false, noChange: true };
        }
        const previous = this.lastInventory;
        this.lastInventory = current;
        return summarizeInventoryGain(previous, current);
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
        this.schedulePickup(target);
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
        if (now < this.pickupBackoffUntil) return;
        const go = shouldAttemptPickup({
            busy: this.actions.executing || this.modelActionRequested,
            pickingUp: this.pickingUp,
            sinceLastAttemptMs: now - this.lastPickupAt,
            backoffRemainingMs: this.pickupBackoffUntil - now,
        });
        if (!go) return;
        this.lastPickupAt = now;
        this.pickingUp = true;
        void (async (): Promise<void> => {
            const started = Date.now();
            let arrived: boolean;
            try {
                arrived = await Promise.race([
                    goToPosition(this.bot, target.x, target.y, target.z, 0),
                    new Promise<boolean>((resolve) => {
                        setTimeout(() => resolve(false), PICKUP_TIMEOUT_MS);
                    }),
                ]);
            } catch {
                arrived = false;
            } finally {
                this.pickingUp = false;
            }
            // 被模型动作抢占不算拾取失败：不累计退避，也不把通道算在拾取头上。
            const preempted = this.modelActionRequested || this.actions.executing;
            let backoffMs = 0;
            if (arrived) {
                this.pickupFailures = 0;
                this.pickupBackoffUntil = 0;
            } else if (!preempted) {
                this.pickupFailures += 1;
                backoffMs = nextPickupBackoffMs(this.pickupFailures);
                this.pickupBackoffUntil = Date.now() + backoffMs;
            }
            this.notify(
                'reflex.done',
                KIND.WORLD,
                LEVEL.STATE,
                {
                    reflex: 'pickup',
                    outcome: arrived ? 'ok' : 'failed',
                    detail: arrived
                        ? '走到了 ' + target.name + ' 的位置，掉落物会被踩进背包。'
                        : preempted
                            ? '拾取被模型动作抢占，已释放身体通道（模型优先，本次不额外退避）。'
                            : '没走到 ' + target.name + ' 的位置（超时）；' +
                                '已释放身体通道，退避 ' + Math.round(backoffMs / 1000) + ' 秒后再试（连续失败 ' + this.pickupFailures + ' 次）。',
                    ms: Date.now() - started,
                    failures: arrived ? 0 : this.pickupFailures,
                    backoffMs,
                    preempted,
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
                    const hostile = isHostile(raw);
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
        try {
            return await runEmergency({
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
                    try {
                        return (Object.values(bot.entities ?? {}) as Array<Record<string, unknown>>)
                            .filter((e) => e != null && (e as { position?: unknown }).position != null)
                            .map((e) => {
                                const ent = e as { id?: unknown; name?: unknown; displayName?: unknown; position?: unknown };
                                const pos = ent.position as { x: unknown; y: unknown; z: unknown };
                                return {
                                    id: typeof ent.id === 'number' ? ent.id : -1,
                                    name: typeof ent.name === 'string' ? ent.name : 'unknown',
                                    hostile: isHostile(e),
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
                    this.requestInterrupt();
                },
                fleeTo: (x: number, z: number): void => {
                    try {
                        bot.pathfinder.setMovements(movementsFor(bot));
                        bot.pathfinder.setGoal(new pf.goals.GoalXZ(x, z));
                    } catch (err: unknown) {
                        console.warn('emergency flee failed:', err instanceof Error ? err.message : String(err));
                    }
                },
                eat: (food: string): Promise<void> => consume(bot, food).then(() => undefined),
                submerged: (): boolean => {
                    try {
                        const p = bot.entity.position;
                        return bot.blockAt(p)?.name === 'water' && bot.blockAt(p.offset(0, 1.6, 0))?.name === 'water';
                    } catch {
                        return false;
                    }
                },
                swimUp: (): void => {
                    try {
                        // 水里/岩浆里按 jump 就是上浮；顺便抬头，免得贴着天花板原地顶。
                        bot.setControlState('jump', true);
                        void bot.look(bot.entity.yaw, -Math.PI / 2, true);
                    } catch {
                        // 拿不到实体就没什么可做的。
                    }
                },
                feetBlockName: (): string | null => {
                    try {
                        return bot.blockAt(bot.entity.position)?.name ?? null;
                    } catch {
                        return null;
                    }
                },
                headBlockName: (): string | null => {
                    try {
                        return bot.blockAt(bot.entity.position.offset(0, 1.6, 0))?.name ?? null;
                    } catch {
                        return null;
                    }
                },
                lavaNear: (): { x: number; z: number } | null => {
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
            }, {
                // **处理按事件类型选定**：溺水只上浮，威胁只逃跑，不互相代劳。
                intent,
            });
        } catch (err: unknown) {
            this.log.with('emergency').warn({ phase: 'failed', intent, err: String(err) });
            throw err;
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

    /** `BodyServer` 的处理函数。所有异常都变成 `ok:false`，不让它穿到传输层。 */
    async handle(request: BrainRequest): Promise<BodyResponse> {
        switch (request.op) {
            case 'hello':
                return { ok: true, op: 'hello', capabilities: this.capabilities() };
            case 'sample':
                return { ok: true, op: 'sample', state: sampleLiveState(this.sampleContext()) };
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
                this.modelActionRequested = true;
                await this.yieldAutoPickupToModel();
                try {
                    const text = await executeToolCall(this, name, args);
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
                        result: { ok: false, text: `Tool ${name} failed: ${message}`, code: ERR.BODY_ERROR },
                    };
                } finally {
                    this.modelActionRequested = false;
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
                try {
                    await this.actions.stop();
                } finally {
                    this.modelActionRequested = false;
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
