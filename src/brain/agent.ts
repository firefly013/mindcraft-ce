/**
 * 大脑：模型、提示词、会话、计划、记忆、以及"决定要做什么"的全部逻辑。
 *
 * 它**不碰 Mineflayer**。所有"读世界"和"动身体"的事都过 `this.body`（`Body`
 * 契约），今天的实现在另一个进程里（`RemoteBody` → 协议 → `MineflayerBody`）。
 *
 * **工具的声明与实现也是分开的**：这里只有握手里报上来的声明
 * （`BodyCapabilities.tools`），实现（`perform`）全在身体进程里。
 * 所以大脑进程里不会加载 mineflayer 的任何模块——`src/brain/**` 不许 import
 * `src/body/**`，这条由 `tests/isolation.test.ts` 机器守卫。
 *
 * 从旧版搬过来的方法**逐字保留**（含注释）：那边的注释记的都是真机踩出来的坑。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension } from '@earendil-works/pi-durable';
import { ActionRunner } from './action_runner.js';
import { buildGameTools, actionChannelInvoker } from './tools/game_tools.js';
import { createToolCatalog, EMPTY_TOOL_CATALOG, type ToolCatalog } from './tools/catalog.js';
import type { ToolDeclaration } from '../shared/tools.js';
import { CliJobTracker } from './cli_jobs.js';
import { log } from './connection_handler.js';
import { classifyChat, noteChatRepeat } from '../shared/chat.js';
import { EVENT_LOG_LIMIT, eventTextFor, renderEventText } from '../shared/event_stream.js';
import { renderLiveState } from '../shared/live_state.js';
import type { LiveState } from '../shared/live_state.js';
import type { PlanTodoInput } from './plan.js';
import { PlanStore } from './plan.js';
import { KIND, LEVEL } from '../shared/events.js';
import type { Kind, Level } from '../shared/events.js';
import { Scheduler } from './scheduler.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from '../shared/settings.js';
import { Task } from './tasks/tasks.js';
import type { TaskData } from './tasks/tasks.js';
import { MESSAGES } from '../shared/prompts.js';
import { openBotWiring, type BotWiring } from './runtime/bot.js';
import {
  createFeedbackTool,
  createGetPlacesTool,
  createGoToRememberedPlaceTool,
  createRememberHereTool,
  createStopTool,
  createUpdatePlanTool,
} from './tools/control_tools.js';
import { EventIntake } from './runtime/events.js';
import type { GameEvent } from './runtime/events.js';
import type { EventHandler } from './runtime/handlers.js';
import { compactionLogHook, providerLogHook } from './runtime/log_hooks.js';
import { migrateLegacyState, readLegacySave } from './runtime/legacy.js';
import { createLogger, nullLogger, type Logger } from '../shared/logger.js';
import { liveTailFromText } from './runtime/perception.js';
import { systemPromptFromProfile } from './runtime/prompt.js';
import { loadProfile, validateProfile } from '../shared/config/load.js';
import { compactionPageHook, createRequestLogSink, requestLogHook } from './runtime/request_log.js';
import type { ToolOutcome } from './tools/tools.js';
import type { Body } from '../shared/body.js';
import type { BodyCapabilities } from '../shared/protocol/types.js';
import { RemoteBody } from './remote_body.js';
import { bodyExitInfo, startBody, stopBody } from './process/body_launcher.js';
import type { CloseInfo } from '../shared/protocol/transport.js';
import type { BodyEvent, ChatMessage } from '../shared/protocol/types.js';

/** CLI 事件缓冲上限。一次调试会话够用就行，别让数组无限长。 */
const CLI_EVENT_LOG_LIMIT = 200;

/** CLI 拿走的一条事件。 */
export interface CliEvent {
    at: number;
    level: number;
    action: string;
    text: string;
}

/**
 * 同一发送者重复同一句话的计数（防批量工具刷屏）。判据在 `shared/chat.ts`。
 *
 * 真机事故（2026-10-18 23:26）：玩家的建造工具以 `mcbuild` 的名字批量填充方块，
 * 每批广播一条 `Successfully filled 15 block(s)`，两个 bot **每一条**都被要求
 * 「先用 Say 回一句」——上下文被刷爆。黑名单只能挡已知文案，这条才是兜底。
 */
export class Agent {
    count_id: number = 0;

    name: string = '';
    task: any; // 未迁移模块，统一 any
    blocked_actions: string[] = [];
    respondFunc: ((username: string, message: string) => Promise<void>) | undefined;
    scheduler!: Scheduler;
    loopLog: Array<{ type: string; kind: string; level: number; payload: unknown }> = [];
    /**
     * 计划（goal / todos）。**在 `name` 就绪后才建**——落盘路径要用它。
     * 见 `initProfile` 里的赋值；在那之前是空的纯内存实例（还没有名字可存）。
     */
    plan: PlanStore = new PlanStore();

    /**
     * 身体。**大脑唯一的出口**——所有动作、观测、说话、保命都过它。
     * 在 `connectBody()` 里就绪；就绪前的事件由 `intake` 暂存。
     */
    body: Body | null = null;

    /** 身体协议端口。由进程入口（`src/brain/index.ts`）在 `start()` 前设好。 */
    private bodyPort: number | null = null;

    /**
     * 背包槽位缓存。**由 `inventory.changed` 事件喂**（身体在每次变化的那一刻
     * 报一次，连初始状态一起），不再有 300ms 轮询。
     *
     * 只给 `Task` 数物品用，见 `inventorySlots()`。
     */
    private slotsCache: ({ name: string; count: number } | null)[] = [];

    /**
     * 队友 bot 的名字（从 settings.profiles 那些 profile 文件里读）。
     *
     * **用来区分"人"和"队友"**：队友之间是高频背景音，走事件就够；
     * 而**玩家（人）在跟你说话是必须回应的**，得投成真正的用户回合。
     */
    private teammateNames: Set<string> = new Set();
    /**
     * 每个队友**上一次真的把我叫醒**的时刻（`classifyChat` 的预算用）。
     *
     * 为什么需要：状态汇报里天然带对方名字（"overnight_a：等你来"），只看
     * "有没有点名"在实测里等于"每条都唤醒"——overnight_a 每 4 分钟被叫起来回
     * 一句话，自己的活一直没推进。见 `shared/chat.ts` 的 `TEAMMATE_WAKE_MIN_GAP_MS`。
     */
    private teammateWakeAt: Map<string, number> = new Map();

    /**
     * 同一发送者重复同一句话的计数（防批量工具刷屏）。
     *
     * 真机事故（2026-10-18 23:26）：玩家的建造工具以 `mcbuild` 的名字批量填充方块，
     * 每批广播一条 `Successfully filled 15 block(s)`，两个 bot **每一条**都被要求
     * 「先用 Say 回一句」——上下文被刷爆。黑名单只能挡已知文案，这条才是兜底：
     * 窗口内重复超过阈值 ⇒ 只记录一次，其余静默。
     */
    private chatRepeatAt: Map<string, { count: number; firstAt: number; lastAt: number }> = new Map();

    /** 从 profile 文件里读队友名字（读不到就当没有，不影响主流程）。 */
    private loadTeammateNames(): void {
        const raw = (settings as { profiles?: unknown }).profiles;
        const files: string[] = Array.isArray(raw) ? (raw as string[]) : [];
        for (const f of files) {
            try {
                const profile = loadProfile(f);
                if (profile.name !== '') this.teammateNames.add(profile.name);
            } catch {
                // 读不到就算了，最坏情况是队友的话也走用户回合。
            }
        }
    }

    /**
     * deliberative 层：pi-durable 会话 + 工具 + 尾巴注入 + 事件接入。
     *
     * 异步装配（要开 SQLite、建 Harness），而 `start()` 是同步的——所以
     * 装配在后台跑，**就绪前的事件由 `intake` 暂存**，接上时按顺序补投
     * （`EventIntake.attach`）。连接建立到就绪之间的事件因此不会丢。
     */
    private wiring: BotWiring | null = null;
    /** 事件 → 处理的唯一入口。`buildRuntime` 里接上运行时。 */
    private readonly intake = new EventIntake();
    /** 动作通道：占身体的动作走它（E1–E4 的契约住在这里）。 */
    private actionRunner: ActionRunner | null = null;
    /** profile 原文：供应商、上下文压缩参数、提示词集都从它读。 */
    private profile: Record<string, unknown> | null = null;
    /**
     * 结构化日志：`bots/<name>/logs/agent-YYYYMMDD.log`（JSONL，同步写盘）。
     *
     * 在 `start()` 里建（那时才知道 bot 名，而身体握手比它更早，那一步要留痕）。
     * 在此之前用空实现，调用方不用到处写 `?.`。
     */
    private log: Logger = nullLogger();

    /**
     * 身体报上来的能力表。**工具的 schema 是它的函数**（`buildGameTools`）。
     *
     * 握手完成前为 `null`——那时还没有工具，也没有身体。
     */
    private caps: BodyCapabilities | null = null;

    /**
     * 工具目录（握手声明派生）。**只读查询不消耗次数制额度**、动作类要占身体
     * 通道——两条判据都从这里查，不手写第二份名单：手写两份迟早对不上，
     * 而对不上的后果是"某个查询悄悄烧掉一次危险操作额度"。
     *
     * 握手之前是空目录：此刻一个工具都没有，这是事实，不是占位。
     */
    private catalog: ToolCatalog = EMPTY_TOOL_CATALOG;

    /**
     * 正在主动关停。**用来区分"身体断了"的两种情况**：我们叫它死的（关停路径）
     * 和它自己死的（事故）。只有后者才该触发退出。
     */
    private killing = false;

    /** 进程入口用它把身体端口交进来（`start()` 之前调用）。 */
    setBodyPort(port: number): void {
        this.bodyPort = port;
    }

    start(load_mem = false, init_message: string | null = null, count_id = 0): void {
        this.count_id = count_id;

        const profile = settings.profile;
        if (!profile) {
            log(this.name || 'unknown', 'Agent profile is not loaded.');
            process.exit(1);
            return;
        }
        // profile 是随 settings 传过来的（可能是网页上传的），这里再校验一次：
        // 形状不对就带着说明退出，而不是让下面各处读到 undefined。
        try {
            this.profile = validateProfile(profile) as unknown as Record<string, unknown>;
        } catch (error: unknown) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
            return;
        }
        this.name = String(this.profile['name'] ?? this.name).trim();
        console.log(`Initializing agent ${this.name}...`);

        // 旧存档（memory.json）：这里只取 taskStart；记忆/地点/计划在运行时就绪后
        // 由 migrateLegacyState 迁进 SQLite 文档（幂等，不覆盖已有新状态）。
        const save_data = load_mem ? readLegacySave(`./bots/${this.name}`) : null;
        const taskStart = save_data?.taskStart ?? Date.now();
        this.task = new Task(this, settings.task as TaskData | null, taskStart);
        // 原生工具黑名单：getOpenAITools 按此过滤，不再需要文本命令黑名单
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        // 日志器在这里就建好，而不是等 `buildRuntime`——身体握手在它之前发生，
        // 那一步是要留痕的（连不上、拒连、能力表为空都在那儿判）。
        this.log = createLogger({ dir: `./bots/${this.name}/logs` });

        this.loadTeammateNames();
        console.log(this.name, 'connecting to body...');
        void this.bootstrap(save_data, init_message);
    }

    /**
     * 启动顺序：**先连身体 → 再建运行时 → 最后讲开场白**。
     *
     * 为什么身体必须排在运行时之前：**工具 schema 是身体声明的函数**。
     * `buildGameTools` 要按握手里报上来的 `caps.tools` 装配，而声明只有握完手
     * 才有。以前是反过来的（先建运行时、身体在旁边异步连），因为那时 schema
     * 是写死的、不用问身体——那正是"分层没做完"留下的形状。
     */
    private async bootstrap(save_data: unknown, init_message: string | null): Promise<void> {
        let caps: BodyCapabilities;
        try {
            caps = await this.attachBody();
        } catch (err: unknown) {
            // 身体是唯一的执行体，连不上就没有"降级"可言——**大声退出**，
            // 别留一个什么都干不了的空壳在跑。
            console.error('Failed to attach body:', err instanceof Error ? err.message : String(err));
            this.log.with('lifecycle').error({
                event: 'body-attach-failed',
                err: err instanceof Error ? err.message : String(err),
            });
            process.exit(1);
            return;
        }
        this.caps = caps;
        this.catalog = createToolCatalog(caps.tools);
        await this.buildRuntime(caps);
        try {
            await this._setupEventHandlers(save_data, init_message);
        } catch (err: unknown) {
            console.error('Failed to set up event handlers:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    }

    /**
     * 拉起身体、连上、握手、订阅观察。
     *
     * 顺序不能换：**事件订阅必须早于任何"可能触发事件"的动作**，否则开局那几秒
     * （正好是最容易出事的时候：掉进洞、被怪围）是瞎的。
     *
     * 返回值就是能力表——它是启动流程里唯一需要往下传的东西（见 `bootstrap`）。
     */
    private async attachBody(): Promise<BodyCapabilities> {
        const port = this.bodyPort;
        if (port == null) {
            log(this.name, 'body port is not set; cannot start without a body.');
            throw new Error('body port is not set');
        }
        // **先把身体拉起来**：它自己会连游戏、出生、再开门。settings 在这一刻
        // 已经是"从 MindServer 取回来的那一份"（`serverProxy.connect` 里
        // `setSettings` 过了），转交即可，不再走第二条获取路径。
        startBody(this.name, this.count_id, port);
        const body = await RemoteBody.connectWithRetry(`ws://127.0.0.1:${port}`, 120_000, 500, () => {
            // 身体进程自己崩了 → 它永远不会来开门。再等 120 秒只会把错误信息
            // 引到"timeout"上去，而真相是"它退出时是 code=1"（写 Java 身体时
            // 这条路径会被反复踩到）。
            const exit = bodyExitInfo();
            if (exit == null) return null;
            return new Error(
                `body process exited before opening its port (code ${exit.code}, signal ${exit.signal})`,
            );
        });
        this.body = body;
        const caps = await body.hello();
        // 空工具表 = 这个身体一个命令都跑不了。**判成协议错误**，而不是"那就
        // 不给工具"：后者会让大脑带着零个工具继续跑，模型只能干聊，
        // 而日志里一切正常——这是最坏的一种失败。
        if (caps.tools.length === 0) {
            throw new Error(`body ${caps.bodyKind} declared no executable tools`);
        }
        this.log.with('lifecycle').info({
            event: 'body-attached',
            kind: caps.bodyKind,
            tools: caps.tools.length,
            observations: caps.observations,
        });

        // 事件：身体观察到的 → 审计台账 + intake。
        // 文本已由身体用同一个渲染器渲染好，**不再重渲**；但结构化那份
        // （type/kind/level/payload）要单独进 `loopLog`——它是"谁在什么时候
        // 叫醒了 agent"的唯一记录，`Feedback` 的历史摘要直接读它。
        body.onEvent((event: BodyEvent) => {
            const kind = event.kind as Kind;
            const level = event.level as Level;
            this.recordEvent(event.type, kind, level, event.payload);
            // 文本归属：身体渲染了就用它的，没渲染则由大脑渲染（Java 身体渲染不了）。
            // 见 `eventTextFor` 与 D-59。
            this.intake.notify({
                type: event.type,
                kind,
                level,
                payload: event.payload,
                text: eventTextFor(kind, level, event.payload, event.text),
                ts: event.ts,
                // 身体声明"我为这条事件启动了哪个处理"，以及"这条是哪个处理的完成报告"。
                // 等级不决定谁处理——那是事件类型的事（见 handlers.ts）。
                reflex: event.reflex ?? null,
                completes: event.completes ?? null,
            });
        });
        // 聊天也是事件，走同一个入口——"是玩家在问我还是队友在报坐标"是它在大脑侧的
        // 处理（见 `buildEventHandlers` 的 `player.chat`）。

        // **身体没了 → 大脑跟着退**。这条是分层新引入的失败模式：单进程时代身体崩了
        // 就等于整个进程崩了，没有人需要"发现"这件事；分层之后大脑会变成一个
        // 看不见的僵尸——心跳照跑、模型照调、每个动作都失败，而日志里一条错都没有。
        // 真机实测：杀掉身体进程后两分钟，大脑日志零新增。
        //
        // 退出码 1（不是 2）：主进程的重启策略据此拉起一个新的 agent（连带新身体），
        // 那正是主线"机器人被踢下线 → 重启 agent"的行为。code > 1 是"结束任务"。
        body.onClose((info) => {
            if (this.killing) return; // 我们自己关的（关停路径），不是事故
            this.killing = true;
            void this.announceBodyLost(info);
        });

        return caps;
    }

    /**
     * 身体没了：记一笔，然后退出，交给主进程的重启策略拉起一套新的。
     *
     * **为什么先等一小会儿再退**：身体进程的退出码比 WebSocket 的关闭码有用得多
     * ——1006 只说"连接异常关闭"，不说是崩了、被杀了、还是自己退的。
     * 但这两个事件在父进程里是**赛跑**：socket 关闭从 TCP 上来，子进程的 `exit`
     * 从操作系统上来。真机上实测过 exit 处理函数排在 `process.exit` 之后，
     * 于是那行日志（唯一带退出码的地方）直接丢了。250ms 足够，也不影响任何人。
     */
    private async announceBodyLost(info: CloseInfo): Promise<void> {
        const deadline = Date.now() + 250;
        while (bodyExitInfo() == null && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        const exit = bodyExitInfo();
        this.log.with('lifecycle').error({
            event: 'body-lost',
            closeCode: info.code,
            closeReason: info.reason,
            processExitCode: exit?.code ?? null,
            processSignal: exit?.signal ?? null,
        });
        console.error(
            this.name,
            `身体连接断了（websocket ${info.code}${info.reason ? ` ${info.reason}` : ''}；` +
                `进程退出码 ${exit?.code ?? '未知'}/信号 ${exit?.signal ?? '未知'}）；大脑退出，交给主进程重启。`,
        );
        stopBody();
        process.exit(1);
    }

    /**
     * 大脑侧的处理表：**事件类型 → 处理**。
     *
     * 这里只登记**大脑侧的反射**（不需要模型、但也不需要身体侧毫秒级反应的事）。
     * 身体侧的反射由身体自己在事件里声明（`event.reflex`），模型的处理是默认
     * ——查不到就是"交给模型看看"。见 `runtime/handlers.ts` 的三条规则。
     *
     * **为什么不再有 300ms 轮询**：这两件事以前都挂在同一个心跳上，用"定期盲问"
     * 代替"发生变化的那一刻报告"。轮询的错不在于多几次往返，而在于**在世界没有
     * 变化的时候声称"发生了"**——那是伪造事件。现在它们各自是身体推来的边沿事件。
     */
    private buildEventHandlers(): EventHandler[] {
        return [
            {
                types: ['inventory.changed'],
                executor: 'reflex',
                note: '背包变化：更新计数缓存并复查任务是否完成',
                run: (event) => this.reflexInventoryChanged(event),
            },
            {
                types: ['player.chat', 'developer.message'],
                executor: 'reflex',
                note: '聊天路由：玩家 → 必须回应的用户事件；队友 → 背景消息',
                run: (event) => {
                    this.routeChat(event);
                    return Promise.resolve();
                },
            },
        ];
    }

    /**
     * `inventory.changed` 的处理：更新计数缓存，然后复查任务是否完成。
     *
     * 载荷带的是**新的完整槽位表**（身体在变化的那一刻采的），所以这里既不需要
     * 再问一次身体，也不需要定时刷新。
     *
     * 这条处理**不单独留记录**：它的可观测结果就是"任务完成/失败"那条事件
     * （`checkTaskDone` 会发），再写一条"我更新了缓存"是纯噪音。
     */
    private reflexInventoryChanged(event: GameEvent): Promise<void> {
        const payload = event.payload as { slots?: ({ name: string; count: number } | null)[] } | null;
        if (payload?.slots != null) this.slotsCache = payload.slots;
        this.checkTaskDone();
        return Promise.resolve();
    }

    /** `Task` 数物品用。由 `inventory.changed` 事件维护。 */
    inventorySlots(): ({ name: string; count: number } | null)[] {
        return this.slotsCache;
    }

    async _setupEventHandlers(save_data: unknown, init_message: string | null): Promise<void> {
        void save_data;

        if (init_message && save_data) {
            // 载入旧存档时不会走 handleMessage（那会把开场白当成新事件重放），
            // 但开场白本身得留在上下文里。被动写一条 entry：不唤醒模型。
            void this.wiring?.runtime.write({
                kind: 'mc.init',
                model: [{ role: 'user', content: init_message, timestamp: Date.now() }],
                data: { source: 'system' },
            });
        }
        if (init_message && !save_data) {
            await this.handleMessage('system', init_message);
        } else if (!init_message && !save_data) {
            this.openChat(MESSAGES.hello(this.name));
        }

        if (!save_data) {
            if (settings.task) {
                this.task.initBotTask();
                this.task.setAgentGoal();
            }
        } else if (settings.task) {
            // set the goal without initializing the rest of the task
            this.task.setAgentGoal();
        }
    }

    // ── 事件的唯一入口 ─────────────────────────────────────────────────────

    private currentSource: string = 'system';

    /**
     * 事件的**唯一入口**（大脑自己产生的那几条）。
     *
     * 事件就是一条消息：渲染成文本后交给 `EventIntake`，由它按**事件类型**
     * 找处理（见 `buildEventHandlers`），按**等级**决定投递力度
     * （L2 `write` 记录、L3 `steer` 唤醒、L4 `abort`+`submit`、
     * L5 `abort`+锁通道+`submit`）。
     *
     * `loopLog` 仍然留一份审计台账——它是"谁在什么时候叫醒了 agent"的唯一
     * 记录，和模型看到什么无关，但排障时救命。
     *
     * **身体推来的事件不走这里**：它们由身体用同一个 `renderEventText` 渲染好，
     * 直接进 `intake`（见 `attachBody`）。这里只处理**大脑自己产生**的那几条
     * （任务完成/失败、工具结果、初始化消息）。
     */
    private notify(type: string, kind: Kind, level: Level, payload: unknown): void {
        this.recordEvent(type, kind, level, payload);
        this.intake.notify({
            type,
            kind,
            level,
            payload,
            text: renderEventText(kind, level, payload),
            ts: Date.now(),
            reflex: null,
            completes: null,
        });
    }

    /**
     * 只记台账、不投递（身体推来的事件已经有成品文本了，走这条）。
     *
     * 台账和投递**必须分开**：`loopLog` 记的是全部事件（身体的 + 大脑自己产生的），
     * 而投递路径有两条（身体渲染好的 / 大脑自己渲染的）。合并成一个函数就会
     * 逼着身体推来的事件重渲一遍，那正是两侧文本会漂移的由来。
     */
    private recordEvent(type: string, kind: Kind, level: Level, payload: unknown): void {
        this.loopLog.push({ type, kind, level, payload });
        if (this.loopLog.length > EVENT_LOG_LIMIT) {
            this.loopLog.splice(0, this.loopLog.length - EVENT_LOG_LIMIT);
        }
        this.log.with('event').debug({ phase: 'queued', type, kind, level, payload });
    }

    /**
     * `player.chat` / `developer.message` 的处理：把一条"有人说话了"变成该走的东西。
     *
     * **这就是"聊天也是事件"的落点**：身体只报"谁说了什么"（它不知道谁是队友），
     * 而"这是玩家在问我、还是队友在报坐标"依赖 profiles——那是大脑的知识，
     * 所以它是这条事件的**处理**。
     *
     * 真机现象（这条处理的来由）：玩家在聊天框问"你们能听到我说话吗？"，两个 bot
     * 收到了、也进了上下文（日志里同一句话被重复渲染了 120+ 次），但**一句话不回**
     * ——因为它在模型眼里是背景噪音。所以玩家的话必须带上"有人在直接问你、
     * 先回一句"的框，并且 `expectReply` 落在载荷里。
     */
    private routeChat(event: GameEvent): void {
        const { from: username, message, whisper } = event.payload as ChatMessage;
        if (message === '') return;
        if (username === this.name) return;
        if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
        try {
            const ignore_messages = [
                'Set own game mode to',
                'Set the time to',
                'Set the difficulty to',
                'Teleported ',
                'Set the weather to',
                'Gamerule ',
                // **指令反馈不是聊天。** 真机事故（2026-10-18 23:26）：玩家的建造工具
                // 以 `mcbuild` 的名字在世界里批量填充方块，每批都广播一条
                // `Successfully filled 15 block(s)`，两个 bot **每一条**都收到
                // 「有人在直接跟你说话，先用 Say 回一句」——80+ 条把上下文刷爆
                // （bot 自己报了这条 Feedback）。这类文案属于"命令回显"，
                // 跟 `Set the time to` 是一家人，看到就丢。
                'Successfully filled',
                'Successfully placed',
                'Successfully set',
                'Filled ',
                'Changed the block at',
            ];
            if (ignore_messages.some((m) => message.startsWith(m))) return;

            // **同一个人重复同一句话，不能每次都当"有人在跟你说话"。**
            // 上面的黑名单只能挡已知的批量指令文案；真正的兜底在
            // `shared/chat.ts` 的 `noteChatRepeat`（纯函数、有单测）：
            // 窗口内重复超过阈值 ⇒ 只提示一次，其余静默。
            const repeat = noteChatRepeat(this.chatRepeatAt, username, message, Date.now());
            if (repeat.verdict === 'first-suppress') {
                console.log(
                    this.name,
                    'chat repeat suppressed:',
                    username,
                    '(' + String(repeat.count) + '× in ' + String(repeat.windowSeconds) + 's):',
                    message,
                );
                this.handleMessage(
                    username,
                    '【系统】' + username + ' 在 ' + String(repeat.windowSeconds) + ' 秒内重复同一条消息 ' +
                        String(repeat.count) + ' 次（' + message + '）。' +
                        '**这多半是批量工具/脚本的广播，不是有人在等你回话**——不用回，继续手上的活；' +
                        '同类消息我接下来不会再打扰你。',
                    KIND.USER,
                    LEVEL.STATE,
                );
                return;
            }
            if (repeat.verdict === 'suppress') return;

            console.log(this.name, 'received message from', username, ':', message);

            // **开发者通道不是聊天**：`bots/<name>/inbox.txt` 的行按"注入一条用户事件"
            // 处理。如果按"玩家在跟我说话"处理，脚本刷日志时会刷出一堆多余的回合。
            if (username === 'developer') {
                this.handleMessage('developer', message, KIND.USER, LEVEL.WAKE);
                return;
            }

            // 全中文：不再做英文翻译，直接处理原文。
            // 投递力度由 `classifyChat` 决定（纯函数，有单测）：玩家=唤醒+要求回话，
            // 队友=默认只记录（见那里的真机教训：队友消息曾经的 expectReply: true
            // 让两个 bot 陷入「报坐标 → 收到 → 再报坐标」的无限乒乓）。
            const isTeammate = this.teammateNames.has(username);
            // 队友"点名唤醒"的预算：上一次真的叫醒我到现在过了多久。
            // 状态汇报里天然带对方名字，没有预算的话"点名才唤醒"等于"每条都唤醒"。
            const lastWake = this.teammateWakeAt.get(username) ?? null;
            const delivery = classifyChat({
                message,
                fromTeammate: isTeammate,
                whisper: whisper === true,
                selfName: this.name,
                sinceLastWakeMs: lastWake == null ? null : Date.now() - lastWake,
            });
            if (delivery.level >= LEVEL.WAKE) this.teammateWakeAt.set(username, Date.now());
            const level: Level = delivery.level;
            if (!isTeammate) {
                const text =
                    '玩家 ' + username + ' 对你说：' + message +
                    (whisper ? '（这是私聊，别人听不到）' : '') +
                    '\n**有人在直接跟你说话，先用 Say（或正文）回一句，再继续手上的活。**';
                this.handleMessage(username, text, KIND.USER, level, {
                    whisper,
                    mention: delivery.addressed,
                    expectReply: delivery.expectReply,
                });
                return;
            }

            this.handleMessage(username, message, KIND.USER, level, {
                whisper,
                mention: delivery.addressed,
                expectReply: delivery.expectReply,
            });
        } catch (error: unknown) {
            console.error('Error handling message:', error);
        }
    }

    /**
     * 装配 deliberative 层。
     *
     * 与旧的 `buildLoop` 的区别：没有手写循环、没有 `Prompter`、没有 `History`。
     * 回合、历史、上下文压缩、持久化全部由 pi-durable 的 `Conversation` 承担；我们
     * 只提供**工具集**与**每轮尾巴**。
     *
     * `ActionRunner`（身体通道）**保留**：E1–E4 的契约住在这里，它不是
     * "重复造轮子"，而是本项目的业务约束——同一时刻最多一个占用型动作。
     */
    private async buildRuntime(caps: BodyCapabilities): Promise<void> {
        this.log.with('lifecycle').info({ event: 'build-runtime', bot: this.name });
        this.scheduler = new Scheduler();
        this.actionRunner = new ActionRunner({
            scheduler: this.scheduler,
            // 参数校验的依据是身体握手里报上来的**声明**（大脑这边没有命令表）。
            catalog: this.catalog,
            // pi-durable 自己会记工具结果；动作**完成**走 L3 消息（见 notify）。
            // 这里不再往上下文补一条回执——那会把同一件事喂两遍。
            record: () => Promise.resolve(),
            speak: (text: string): void => {
                this.routeResponse(this.currentSource, text);
            },
            // **身体在另一个进程**：这里发出去的是协议请求，那边跑
            // `executeToolCall(bodyAgent, name, args)`。
            execute: (tool: string, toolArgs: Record<string, unknown>): Promise<string> =>
                this.bodyAct(tool, toolArgs),
            notify: (payload: { call: string; result: ToolOutcome }): void => {
                this.notify('tool.action.done', KIND.TOOL, LEVEL.WAKE, payload);
            },
            // 身体通道的观测：认领 / 忙时幂等 / 忙时别动作 / 完成 / 过期丢弃。
            // 这些是 E1–E4 契约的行为证据，以前全静默。
            trace: (event): void => {
                this.log.with('action').info({ ...event });
            },
            // 「还在跑」的进度回执要能判断**有没有在动**：采样一次身体状态，
            // 只取坐标。采样失败返回 null，回执会说"读不到坐标"而不是编一个。
            bodyPosition: async (): Promise<{ x: number; y: number; z: number } | null> => {
                try {
                    const live = (await this.body?.sample()) as
                        | { position?: { x?: number; y?: number; z?: number } }
                        | null
                        | undefined;
                    const p = live?.position;
                    if (p == null) return null;
                    const x = Number(p.x);
                    const y = Number(p.y);
                    const z = Number(p.z);
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
                    return { x, y, z };
                } catch {
                    return null;
                }
            },
        });
        // 异步装配（要开 SQLite）。`bootstrap` 会等它——工具的 schema 依赖
        // 身体能力表，而 schema 定下来之后再补工具是补不进去的。
        await this.openRuntime(caps);
    }

    /** 异步装配运行时。失败不拖垮 agent：日志留痕，事件仍在 intake 里等着。 */
    private async openRuntime(caps: BodyCapabilities): Promise<void> {
        const profile = this.profile;
        if (profile == null) return;
        const baseDir = `./bots/${this.name}`;
        const sink = createRequestLogSink({ dir: `${baseDir}/logs`, tools: () => this.toolNames() });
        try {
            const wiring = await openBotWiring({
                name: this.name,
                profile,
                intake: this.intake,
                baseDir,
                systemPrompt: () => systemPromptFromProfile(profile, this.name),
                // 每轮现实采一份世界快照（在**身体侧**采），渲染成尾巴。
                // 这就是 `settings.allow_vision` 那句注释一直承诺、却从没接线
                // 的东西：现在它跨进程了，但语义没变。
                liveTail: () => this.bodyLiveTail(),
                // 每轮现拍一张画面，跟世界快照一起进请求。拍不到（相机没开）
                // 返回 null，请求退化成纯文本，不报错。
                liveImage: () => this.captureScreenshot(),
                tools: [
                    ...buildGameTools({
                        execute: (name: string, args: Record<string, unknown>) =>
                            this.invokeTool(name, args),
                        // **工具来自身体握手**：身体报什么就装什么，大脑不再有
                        // 第二份命令表——所以"身体不支持的命令"根本进不了 schema。
                        declarations: caps.tools,
                        // 只有声明了 withScreenshot 的命令会真的调它（目前只有 !stats）。
                        captureImage: () => this.captureScreenshot(),
                    }),
                    // 地点三件套住在大脑侧：它们读写的都是会话里的文档。
                    ...(() => {
                      const deps = this.placesDeps();
                      return [
                        createGetPlacesTool(deps),
                        createRememberHereTool(deps),
                        createGoToRememberedPlaceTool(deps),
                      ];
                    })(),
                    createStopTool(() => this.fullStop()),
                    createUpdatePlanTool((goal, todos) => {
                        const snapshot = this.plan.update(goal, todos as PlanTodoInput[]);
                        // **改完就写进会话文档**：计划属于这个 Pi Durable 会话，
                        // 跨重启要跟着会话回来。以前它只在内存里，重启即归零
                        // （Feedback #23：模型说遇到 5~6 次重启，每次打回原点）。
                        this.persistPlan();
                        return snapshot;
                    }),
                    createFeedbackTool({
                        dir: () => baseDir,
                        plan: () => this.plan.snapshot(),
                        // 台账尾部当"历史摘要"：feedback 只需要一点上下文线索，
                        // 不需要把整份对话塞进去。
                        historyTail: () =>
                            this.loopLog.slice(-10).map((entry) => ({
                                role: 'system',
                                content: JSON.stringify(entry.payload),
                            })),
                    }),
                ],
                onSay: (text: string): void => {
                    this.routeResponse(this.currentSource, text);
                },
                // 大脑侧的反射（掉落物、背包变化）。身体侧的反射由身体在事件里
                // 自己声明，模型的处理是默认。
                handlers: this.buildEventHandlers(),
                // 动作通道锁：L5 的反射开始跑就锁上，最后一个报告完成才解开。
                beginEmergency: () => this.scheduler.beginEmergency(),
                endEmergency: () => this.scheduler.endEmergency(),
                // 空转护栏：**必须留痕**。它是"模型不调工具时替它踩一脚油门"，
                // 夜里复盘时唯一能回答"bot 是真在干活还是被护栏拖着走"的证据。
                stallGuard: {
                    onContinue: (attempt: number): void => {
                        this.log.with('stall').info({ phase: 'continue', attempt });
                    },
                    onWatchdog: (idleMs: number, attempt: number): void => {
                        this.log.with('stall').warn({ phase: 'watchdog', idleMs, attempt });
                    },
                },
                extensions: [
                    defineExtension({
                        name: 'request-log',
                        hooks: [requestLogHook(sink), compactionPageHook(sink)],
                    }),
                    // provider 终态响应（含 errorMessage）+ 上下文压缩。这两件以前完全
                    // 不可见——42 轮静默失败就是漏了前者。
                    defineExtension({
                        name: 'agent-log',
                        hooks: [providerLogHook(this.log), compactionLogHook(this.log)],
                    }),
                ],
                // 事件落点：write / steer / preempt / emergency。
                onEvent: (event, action): void => {
                    this.log.with('event').info({
                        phase: 'delivered',
                        level: event.level,
                        action,
                        text: event.text,
                    });
                    this.cliEvents.push({ at: Date.now(), level: event.level as number, action, text: event.text });
                    if (this.cliEvents.length > CLI_EVENT_LOG_LIMIT) {
                        this.cliEvents.splice(0, this.cliEvents.length - CLI_EVENT_LOG_LIMIT);
                    }
                },
            });
            this.wiring = wiring;

            // 迁移旧存档（幂等）。
            const migrated = await migrateLegacyState(
                wiring.runtime.session.harness,
                wiring.runtime.conversation.id,
                readLegacySave(baseDir),
                BACKGROUND_CONTEXT,
            );
            if (migrated.memory || migrated.places > 0 || migrated.plan) {
                console.log(
                    `Migrated legacy state: memory=${migrated.memory} places=${migrated.places} plan=${migrated.plan}`,
                );
            }

            // 恢复上一次的计划。**必须在迁移之后**——迁移可能刚把旧存档写进文档。
            await this.restorePlan();
        } catch (error: unknown) {
            console.error('Runtime init failed:', error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * 工具名列表（请求日志头用）。
     *
     * 走**和工具装配同一个来源**：身体握手报上来的声明。两处各取一份迟早漂移，
     * 而这一处漂移的后果尤其坏：日志会显示模型其实没有的工具。
     * `caps` 还没到手时给空表——那正是"模型此刻一个工具都没有"的事实。
     */
    private toolNames(): string[] {
        return (this.caps?.tools ?? []).map((tool) => tool.name);
    }

    /** 外部 CLI 的 `help` / "哪些是长命令"要用同一份声明（命令定义在身体侧）。 */
    cliToolDeclarations(): readonly ToolDeclaration[] {
        return this.caps?.tools ?? [];
    }

    // ── 身体接口的小包装 ───────────────────────────────────────────────────

    /** 一切动作的出口。身体没就绪时给一条明确回执，别抛异常。 */
    private async bodyAct(name: string, args: Record<string, unknown>): Promise<string> {
        const body = this.body;
        if (body == null) return '身体还没连上，稍后再试。';
        const result = await body.act({ name, args });
        return result.text;
    }

    private async bodyLiveTail(): Promise<string> {
        const body = this.body;
        if (body == null) return liveTailFromText('(身体未连接)');
        let state: unknown;
        try {
            state = await body.sample();
        } catch (err: unknown) {
            this.log.with('perception').warn({ phase: 'sample-failed', err: String(err) });
            return liveTailFromText('(世界快照取不到)');
        }
        // **goal / todos 由大脑填**：它们是决策层的状态，身体不知道。
        const live = state as LiveState;
        const plan = this.plan.snapshot();
        const task = this.task as { goal?: unknown } | null;
        live.goal = plan.goal ?? (typeof task?.goal === 'string' ? task.goal : null);
        live.todos = plan.todos;
        return liveTailFromText(renderLiveState(live));
    }

    /**
     * 把当前计划写进会话文档（`PlanDoc`）。**失败只记日志**——计划本身已经生效了，
     * 不该因为存不下来就报错给模型（它无法处理"保存失败"这件事）。
     */
    private persistPlan(): void {
        const wiring = this.wiring;
        if (wiring == null) return; // 运行时还没装配好，等下次更新再存。
        const snapshot = this.plan.snapshot();
        void wiring.state
            .setPlan({ goal: snapshot.goal, todos: snapshot.todos })
            .catch((err: unknown) => {
                this.log.with('plan').warn({ phase: 'persist-failed', err: String(err) });
            });
    }

    /**
     * 启动时把会话里存着的计划取回来。
     *
     * 这是"重启后接着干"的另一半：光有会话历史不够，模型还得拿回它自己维护的
     * goal / todos——否则历史里写着"我定好计划了"，而计划是空的。
     */
    private async restorePlan(): Promise<void> {
        const wiring = this.wiring;
        if (wiring == null) return;
        try {
            const stored = await wiring.state.plan();
            if (stored.goal == null && stored.todos.length === 0) return;
            this.plan.hydrate(stored.goal, stored.todos);
            console.log(`Restored plan from session: goal=${String(stored.goal)} todos=${stored.todos.length}`);
        } catch (err: unknown) {
            this.log.with('plan').warn({ phase: 'restore-failed', err: String(err) });
        }
    }

    /**
     * 地点工具的依赖：**真源是会话文档**（`state.places`），不是身体里的那份。
     *
     * 以前 `rememberHere` / `goToRememberedPlace` 是身体侧命令、地点存在身体里，
     * 于是同一份事实有了两个持有者——身体重启就丢，而大脑的 `PlacesDoc` 一直空着
     * （Feedback #6 / #5）。现在身体只负责"我现在在哪"和"走到哪"，记的事归大脑。
     */
    private placesDeps(): {
      read: () => Promise<Record<string, [number, number, number]>>;
      write: (places: Record<string, [number, number, number]>) => Promise<void>;
      here: () => Promise<{ x: number; y: number; z: number } | null>;
      goto: (x: number, y: number, z: number) => Promise<string>;
    } {
      // ⚠️ **wiring 必须在每次调用时现取，不能在闭包里捕获。**
      // 工具是在 `openBotWiring` 那一刻创建的，而 `this.wiring` 要等异步装配完
      // 才有值——在闭包里 `const wiring = this.wiring` 拿到的永远是 null，
      // 于是每次写地名都报"会话还没就绪"（模型一重启就撞上，Feedback 实测）。
      return {
        read: async () => {
          const wiring = this.wiring;
          return wiring == null ? {} : await wiring.state.places();
        },
        write: async (places) => {
          const wiring = this.wiring;
          if (wiring == null) throw new Error('会话还没就绪，存不进去');
          await wiring.state.setPlaces(places);
        },
        here: async () => {
          try {
            const live = (await this.body?.sample()) as { position?: { x?: number; y?: number; z?: number } } | null;
            const p = live?.position;
            if (p?.x == null || p?.y == null || p?.z == null) return null;
            return { x: p.x, y: p.y, z: p.z };
          } catch {
            return null;
          }
        },
        // 走动作通道：占身体的动作必须走它，不然会和别的动作抢身体。
        goto: async (x, y, z) => await this.invokeTool('!goToCoordinates', { x, y, z }),
      };
    }

    private async captureScreenshot(): Promise<string | null> {
        const body = this.body;
        if (body == null) return null;
        // 能力表说没有截图能力就别问了——每个回合都白跑一次协议往返，
        // 而回执必然是 null。`allow_vision=false` 的那类部署正好走这条。
        if (this.caps != null && !this.caps.observations.includes('screenshot')) return null;
        try {
            return await body.image();
        } catch (err: unknown) {
            this.log.with('vision').warn({ phase: 'capture-failed', err: String(err) });
            return null;
        }
    }

    /** 全部停下：动作停、回到 idle。 */
    private async fullStop(): Promise<void> {
        // **Stop 必须无条件清模型动作锁**：body 的 actions.stop 只解身体锁，
        // 大脑 Scheduler 那个 action 不释放的话，之后所有动作都会被 ACTION_BUSY
        // 拒（真机 Feedback #55/#56：快照 idle，但 makeObsidian/useOn/stay 全被拒，
        // Stop 也不放行）。先释放大脑通道，再让身体收手。
        const stopped = this.scheduler?.stopAll();
        try {
            this.log.with('action').info({
                event: 'full-stop',
                stopped,
                scheduler: this.scheduler?.describe(),
            });
        } catch {
            // 日志失败不能阻止 Stop。
        }
        try {
            await this.body?.stop();
        } catch (err: unknown) {
            try {
                this.log.with('action').warn({
                    event: 'full-stop-body-error',
                    err: err instanceof Error ? err.message : String(err),
                    scheduler: this.scheduler?.describe(),
                });
            } catch {
                // 同上。
            }
        }
    }

    /**
     * 当前正在跑的动作名——**以调度器的身体通道为唯一真相**。
     *
     * 不能用 `ActionManager.currentActionLabel`：那个标签要等动作函数返回才清，
     * 而通道在 Stop / 结束时就释放了，两者会错开。模型反馈里出现过
     * "goToSurface 时快照显示的还是 collectBlocks"，就是读了这一份陈旧标签。
     */
    currentActionName(): string | null {
        return this.scheduler?.currentAction()?.id ?? null;
    }

    /**
     * 游戏工具的执行入口。
     *
     * **必须走 `ActionRunner`**：动作类工具要认领身体通道，直连
     * `executeToolCall` 会绕过通道，E1（忙时同动作幂等）/E3（Stop 一次停干净）
     * 当场失效。回执文本走 `loopResultText`，与旧 `runTool` 逐字一致。
     */
    private async invokeTool(name: string, args: Record<string, unknown>): Promise<string> {
        const log = this.log.with('tool');
        const started = Date.now();
        const runner = this.actionRunner;
        if (runner == null) {
            log.warn({ name, args, note: '工具通道尚未就绪' });
            return '工具通道尚未就绪，稍后再试。';
        }
        // **额度不在这里扣**：计数的单位是"身体执行了一次动作"，而唯一确定这件
        // 事的地方就是身体（它自己的 `action` 处理里扣，并且同样豁免申请额度的
        // 控制工具与只读查询）。以前为此专门有一条 `consumeCall` 协议指令，
        // 那是在同步一份身体本来就知道的事实。
        const text = await actionChannelInvoker(runner)(name, args);
        log.info({ name, args, ms: Date.now() - started, result: text });
        return text;
    }

    /** CLI 事件缓冲（见 `runCliCommand`）。外部命令行靠它补看"不在场时"发生的事。 */
    private cliEvents: CliEvent[] = [];

    /** CLI 任务表（见 `startCliJob`）。状态机在 `cli_jobs.ts`，那边可单测。 */
    private cliJobs = new CliJobTracker({
        stop: async () => {
            await this.body?.stop();
        },
    });

    /** 提交一个任务，**立即返回 id**，命令在后台跑（详见 `CliJobTracker`）。 */
    startCliJob(name: string, args: Record<string, unknown>, force: boolean): { id: string } {
        return this.cliJobs.start(name, () => this.runOneCommand(name, args, force));
    }

    /** 单个任务状态；没有就是 `unknown`（可能已被挤出表）。 */
    cliJobStatus(id: string): ReturnType<CliJobTracker['status']> {
        return this.cliJobs.status(id);
    }

    /** 全部任务。 */
    cliJobList(): ReturnType<CliJobTracker['list']> {
        return this.cliJobs.list();
    }

    /** 取消：置标记 + 真的去停动作。 */
    async cliCancelJob(id: string): Promise<boolean> {
        return await this.cliJobs.cancel(id);
    }

    /**
     * 等一个任务。超时**不是失败**——返回 `state: 'running'` 表示它还在跑。
     * 这一点和"超时即报错"不一样：那时超时了动作却没停，人看着终端以为失败，
     * 其实机器人还在走路。
     */
    async cliWaitJob(id: string, timeoutMs: number): Promise<ReturnType<CliJobTracker['status']>> {
        return await this.cliJobs.wait(id, timeoutMs);
    }

    /** `jobs`：列出任务表。 */
    private cliListJobs(): string {
        const jobs = this.cliJobList();
        if (jobs.length === 0) return '(还没有任务)';
        return jobs.map((j) => `  #${j.id}  ${j.state.padEnd(9)} ${j.name}  (${Math.round(j.ms / 1000)}s)`).join('\n');
    }

    /** `tools`：列出所有能跑的命令（游戏工具 + 内置命令）。 */
    private cliListTools(): string {
        // 同 `toolNames`：列的是**这个身体真能跑的**，不是全表。
        const game = (this.caps?.tools ?? []).map((tool) => tool.name).sort();
        const builtin = ['tools', 'jobs', 'history', 'events'].sort();
        return [`游戏工具（${game.length}）：`, ...game, '', `内置命令（${builtin.length}）：`, ...builtin].join('\n');
    }

    /** `events`：只看最近事件（不跑任何命令）。 */
    private cliRecentEvents(limit: number): string {
        const recent = this.cliEvents.slice(-limit);
        if (recent.length === 0) return '(这段时间没有事件)';
        return recent.map((e) => `[L${e.level}/${e.action}] ${e.text}`).join('\n');
    }

    /**
     * `history`：整份对话历史。
     *
     * 走 `harness.context()` 拿原始 transcript（entry + 它对应的模型消息），不自己
     * 另存一份——另存就会和真实上下文漂移，看历史看到的是假的。
     */
    private async cliHistory(limit: number): Promise<string> {
        const wiring = this.wiring as
            | { runtime?: { session?: { harness?: any }; conversation?: { id?: any } } }
            | null
            | undefined;
        const harness = wiring?.runtime?.session?.harness;
        const convId = wiring?.runtime?.conversation?.id;
        if (harness == null || convId == null) return '(会话还没起来，暂无历史)';
        try {
            const view = await harness.context(convId, BACKGROUND_CONTEXT);
            const entries: readonly any[] = view?.entries ?? [];
            const contributions: readonly (readonly any[])[] = view?.contributions ?? [];
            const lines: string[] = [];
            const start = Math.max(0, entries.length - limit);
            for (let i = start; i < entries.length; i++) {
                const entry = entries[i];
                const kind = entry?.kind ?? '?';
                const msgs = contributions[i] ?? [];
                for (const m of msgs) {
                    const role = m?.role ?? '?';
                    const text = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
                    lines.push(`#${i} ${kind} [${role}] ${text}`);
                }
            }
            if (lines.length === 0) return '(历史是空的)';
            return lines.join('\n');
        } catch (err: unknown) {
            return `读历史失败：${err instanceof Error ? err.message : String(err)}`;
        }
    }

    /**
     * 给外部 CLI 用的一次调用：跑一条命令，并把**上次调用以来积攒的事件**一起带走。
     *
     * 为什么要带事件：CLI 是被动的——它没法像游戏内玩家那样"被唤醒"。用户敲一次
     * 命令才看一次输出，中间那几十秒里机器人挨了打、进了水、做完了一个动作，全
     * 都不在回执里。所以每次调用把这段时间的事件一并打印，不管用户问没问。
     *
     * `since` 由 CLI 自己记（它知道上次看到哪），这样多个 CLI / 多次重开互不干扰。
     */
    async runCliCommand(
        name: string,
        args: Record<string, unknown> = {},
        opts: { since?: number; force?: boolean } = {},
    ): Promise<{ output: string; events: CliEvent[] }> {
        const since = typeof opts.since === 'number' ? opts.since : 0;
        const events = this.cliEvents.filter((e) => e.at > since);
        return {
            output: await this.runOneCommand(name, args, opts.force === true),
            events,
        };
    }

    /** 跑一条命令（工具或内置命令）。`force` = 先把身体抢过来再跑。 */
    private async runOneCommand(name: string, args: Record<string, unknown>, force: boolean): Promise<string> {
        // 内置命令（不是游戏工具）：这些得在大脑进程里跑，因为要碰会话数据库。
        if (name === 'tools') return this.cliListTools();
        if (name === 'jobs') return this.cliListJobs();
        if (name === 'history') return await this.cliHistory(Number(args.limit ?? 40) || 40);
        if (name === 'events') return this.cliRecentEvents(Number(args.limit ?? 30) || 30);

        if (force) {
            try {
                await this.body?.stop();
            } catch {
                // 停不掉就硬着头皮跑，回执里会体现冲突。
            }
        }
        const found = this.catalog.get(name);
        if (found == null) return `没有这条命令：${name}。用 tools 看看有哪些。`;
        // **不在大脑里执行 `perform`**：那些实现全是 mineflayer 调用。走协议到
        // 身体上去跑，由那边 `executeToolCall` 按同样的具名参数展开——语义一致。
        const result = await this.bodyAct(name, args);
        const text = result === '' ? '(no output)' : result;
        // **CLI 这条路不走 `commandToRegistration`**（那个是给模型用的，把图塞进
        // 工具回执的多模态 content 里）。这里是终端，塞 base64 只会刷屏——
        // 存成临时文件，回执给路径，人自己打开看。
        return found.withScreenshot === true ? await this.attachScreenshotFile(text) : text;
    }

    /**
     * 把这一刻的画面存成临时文件，回执里给路径。
     *
     * 为什么不直接给 base64：终端显示不了图片，几千个字符只会把有用信息淹没。
     * 存 Temp 是系统临时目录（`os.tmpdir()`），系统会自己清理，不用我们管生命周期。
     */
    private async attachScreenshotFile(text: string): Promise<string> {
        const b64 = await this.captureScreenshot();
        if (b64 == null) return `${text}\n\n（没拍到画面：相机没开，或者还没就绪）`;
        try {
            const dir = join(tmpdir(), 'mindcraft-cli');
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `${this.name}-${Date.now()}.jpg`);
            writeFileSync(file, Buffer.from(b64, 'base64'));
            return `${text}\n\n画面：${file}`;
        } catch (err: unknown) {
            return `${text}\n\n（画面存不下来：${err instanceof Error ? err.message : String(err)}）`;
        }
    }

    handleMessage(
        source: string,
        message: string,
        kind: Kind = KIND.USER,
        level: Level = LEVEL.WAKE,
        extra: Record<string, unknown> = {},
    ): boolean {
        this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        // 全中文：不再做翻译，直接使用原文
        console.log('received message from', source, ':', message);

        // 不再在这里往历史里塞一份：这条消息会作为事件经 `notify()` 进上下文
        // （L3 走 steer 输入）。两处都写就是同一请求里喂两遍。
        this.currentSource = source;
        this.notify('user.message', kind, level, { source, message, ...extra });
        return true;
    }

    routeResponse(to_player: string, message: string): void {
        void to_player;
        this.openChat(message);
    }

    openChat(message: string): void {
        // 全中文直发：不再拆分翻译命令与正文
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (const username of settings.only_chat_with) {
                void this.body?.say(message, username);
            }
        } else {
            void this.body?.say(message);
            sendOutputToServer(this.name, message);
        }
    }

    isIdle(): boolean {
        // 大脑这边没有"身体忙闲"的本地真相；模型动作是否在跑看调度器。
        return this.scheduler == null || this.scheduler.currentAction() == null;
    }

    cleanKill(msg = 'Killing agent process...', code = 1): void {
        this.killing = true;
        // **同步写盘**：紧接着就是 process.exit，异步日志会连同缓冲区一起丢——
        // 而"退出前最后一行"恰恰是排错最需要的（静默死亡最难查）。
        this.log.with('lifecycle').error({ event: 'exit', msg, code });
        console.log(this.name, msg);
        void this.body?.say(code > 1 ? MESSAGES.restarting : MESSAGES.exiting);
        // **身体的生死挂在脑上**：不叫这一声，服务器里会留一个没人管的连接。
        stopBody();
        process.exit(code);
    }

    checkTaskDone(): void {
        if (this.task.data) {
            const res = this.task.isDone();
            if (res) {
                // 任务完成/失败先进消息队列（失败 L4，成功 L3），再收尾退出。
                const failed = typeof res.score === 'number' && res.score < 1;
                this.notify(failed ? 'task.failed' : 'task.done', KIND.WORLD, failed ? LEVEL.PREEMPT : LEVEL.WAKE, {
                    score: res.score,
                });
                void this.wiring?.runtime.write({
                    kind: 'mc.task-ended',
                    model: [
                        { role: 'user', content: MESSAGES.taskEnded(res.score), timestamp: Date.now() },
                    ],
                    data: { score: res.score },
                });
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll(): void {
        serverProxy.shutdown();
    }
}
