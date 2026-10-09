import { VisionInterpreter } from './vision/vision_interpreter.js';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { initBot } from '../utils/mcdata.js';
import { expandTagRecipes } from '../utils/recipe_tags.js';
import { executeToolCall } from './commands/to_openai_tools.js';
import { ActionRunner } from './action_runner.js';
import { stopPvp, consume, goToPosition, forceExitWater } from './library/skills.js';
import { movementsFor } from './movements.js';
import { permits } from './permits.js';
import { safeguards } from './safeguards.js';
import pf from 'mineflayer-pathfinder';
import { isHostile } from '../utils/mcdata.js';
import { Scheduler, KIND, LEVEL } from './scheduler.js';
import type { Kind, Level } from './scheduler.js';
import { STOP_WORDS, shouldEmitHurt, isStuck, isStationaryAction, isHeartbeatDue } from './edges.js';
import { sampleLiveState, renderLiveState } from './live_state.js';
import type { SampleContext } from './live_state.js';
import { runEmergency, shouldTriggerEmergency, FOOD_VALUE } from './emergency.js';
import type { ThreatEntity } from './emergency.js';
import { validateFeedback, buildFeedbackEntry, appendFeedback } from './feedback.js';
import { PlanStore } from './plan.js';
import type { PlanTodoInput } from './plan.js';
import { createEdgeWatcher, resolvePriority, schedulerLevelFor, snapshotFromBot } from './edges.js';
import { EVENT_LOG_LIMIT, renderEventText } from './event_stream.js';
import { defineExtension } from '@earendil-works/pi-durable';
import { openBotWiring, type BotWiring } from '../runtime/bot.js';
import { createFeedbackTool, createStopTool, createUpdatePlanTool } from '../runtime/control_tools.js';
import { EventIntake } from '../runtime/events.js';
import { actionChannelInvoker, buildGameTools, GAME_COMMANDS } from '../runtime/game_tools.js';
import { stripBang } from './commands/to_openai_tools.js';
import { CliJobTracker } from './cli_jobs.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    AUTO_PICKUP_ID,
    PICKUP_INTERVAL_MS,
    PICKUP_RADIUS,
    PICKUP_TIMEOUT_MS,
    nearestDropWithin,
    shouldAttemptPickup,
    type PickupTarget,
} from './auto_pickup.js';
import { compactionLogHook, providerLogHook } from '../runtime/log_hooks.js';
import { createLogger, nullLogger, type Logger } from '../runtime/logger.js';
import { migrateLegacyState, readLegacySave } from '../runtime/legacy.js';
import { systemPromptFromProfile } from '../runtime/prompt.js';
import { compactionPageHook, createRequestLogSink, requestLogHook } from '../runtime/request_log.js';
import { loopResultText, type ToolOutcome } from '../runtime/tools.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

type EdgeWatcher = ReturnType<typeof createEdgeWatcher>;
import { ActionManager } from './action_manager.js';
import { MemoryBank } from './memory_bank.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { MESSAGES } from '../prompts.js';
import { Task } from './tasks/tasks.js';
import type { TaskData } from './tasks/tasks.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import type { ToolResponse } from '../types/common.js';

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
 * 控制类工具：它们**自己不发额度，也不消耗额度**。
 *
 * 模型申请"接下来 3 次动作别拦我"，如果申请这一步就吃掉一次，那它到手只剩 2 次，
 * 语义变成"申请 N 次实际能用 N-1 次" —— 模型很难算清，于是干脆不敢用这个功能。
 */
const CONTROL_TOOLS = new Set([
    '!allowDangerousOps',
    '!disableSafeguards',
    '!restoreAllSafety',
]);

export class Agent {
    count_id: number = 0;
    _disconnectHandled: boolean = false;

    actions!: ActionManager;
    name: string = '';
    npc: any; // 未迁移模块，统一 any
    memory_bank!: MemoryBank;
    task: any; // 未迁移模块，统一 any
    blocked_actions: string[] = [];
    bot: any; // mineflayer 无类型，bot 统一 any
    vision_interpreter: VisionInterpreter | undefined;
    respondFunc: ((username: string, message: string) => Promise<void>) | undefined;
    scheduler!: Scheduler;
    loopLog: Array<{ kind: string; level: number; payload: unknown }> = [];
    plan: PlanStore = new PlanStore();
    private lastHurtEmitAt: number = 0;
    private lastCollectEmitAt: number = 0;
    private stuckPos: string | null = null;
    private stuckSince: number = 0;
    private lastHeartbeatAt: number = Date.now();
    edgeWatcher: EdgeWatcher | null = null;
    lowHpArmed: boolean = false;
    /** 自动拾取：上次尝试时刻 / 是否正在捡（防重叠）/ 是否正被模型饿着。 */
    private lastPickupAt: number = 0;
    private pickingUp: boolean = false;
    private pickupStarved: boolean = false;
    /** 开发者通道的读取位置（见 pollInbox）。 */
    private inboxOffset: number = 0;
    /**
     * 强制出水：是否正在执行 / 上次检查时刻。
     *
     * **必须节流**：判定要做一次连通搜索（最多 256 格），而 `update()` 是每
     * 个物理 tick 都跑的（约 50ms 一次）——不节流等于把主线程泡在水里。
     */
    private exitingWater: boolean = false;
    private lastWaterCheckAt: number = 0;
    /** 连续几次没找到岸。纯水大陆上岸不会靠重试变可能，所以要退避。 */
    private waterExitFailures: number = 0;
    /**
     * 队友 bot 的名字（从 settings.profiles 那些 profile 文件里读）。
     *
     * **用来区分"人"和"队友"**：队友之间是高频背景音，走事件就够；
     * 而**玩家（人）在跟你说话是必须回应的**，得投成真正的用户回合。
     */
    private teammateNames: Set<string> = new Set();

    /** 从 profile 文件里读队友名字（读不到就当没有，不影响主流程）。 */
    private loadTeammateNames(): void {
        const raw = (settings as { profiles?: unknown }).profiles;
        const files: string[] = Array.isArray(raw) ? (raw as string[]) : [];
        for (const f of files) {
            try {
                const profile = JSON.parse(readFileSync(f, 'utf8')) as { name?: unknown };
                if (typeof profile.name === 'string' && profile.name !== '') this.teammateNames.add(profile.name);
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
    /** L1–L5 事件的唯一入口。`buildRuntime` 里接上运行时。 */
    private readonly intake = new EventIntake();
    /** 动作通道：占身体的动作走它（E1–E4 的契约住在这里）。 */
    private actionRunner: ActionRunner | null = null;
    /** profile 原文：供应商、压仓参数、提示词集都从它读。 */
    private profile: Record<string, unknown> | null = null;
    /**
     * 结构化日志：`bots/<name>/logs/agent-YYYYMMDD.log`（JSONL，同步写盘）。
     *
     * 在 `buildRuntime` 里建（那时才知道 bot 名）。在此之前用空实现，
     * 调用方不用到处写 `?.`。
     */
    private log: Logger = nullLogger();

    start(load_mem = false, init_message: string | null = null, count_id = 0): void {
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        const profile = settings.profile;
        if (!profile) {
            log(this.name || 'unknown', 'Agent profile is not loaded.');
            process.exit(1);
            return;
        }
        this.profile = profile as Record<string, unknown>;
        this.name = String(this.profile['name'] ?? this.name).trim();
        console.log(`Initializing agent ${this.name}...`);

        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }

        this.memory_bank = new MemoryBank();

        // 旧存档（memory.json）：这里只取 taskStart；记忆/地点/计划在运行时就绪后
        // 由 migrateLegacyState 迁进 SQLite 文档（幂等，不覆盖已有新状态）。
        const save_data = load_mem ? readLegacySave(`./bots/${this.name}`) : null;
        const taskStart = save_data?.taskStart ?? Date.now();
        this.task = new Task(this, settings.task as TaskData | null, taskStart);
        // 原生工具黑名单：getOpenAITools 按此过滤，不再需要文本命令黑名单
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        this.buildRuntime();

        this.loadTeammateNames();
        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);


        // Connection Handler
        const onDisconnect = (event: string, reason: unknown): void => {
            void event;
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
            void type;

            process.exit(1);
        };

        // Bind events
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
            serverProxy.login();

            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            const skin = this.profile?.['skin'] as { model: string; path: string } | undefined;
            if (skin) this.bot.chat(`/skin set URL ${skin.model} ${skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise<void>((resolve) => setTimeout(resolve, 1000));

                // **补 tag 配方必须在这里做**：`bot.registry` 是登录之后才加载的，
                // 之前放在 initBot 后面立刻调用，那时 registry 还是空的，补丁等于没打
                // （模型真机报"木棍还是做不出来（2 birch_planks → 4 stick 失败）"）。
                const addedRecipes = expandTagRecipes(this.bot?.registry);
                this.log.with('lifecycle').info({ event: 'tag-recipes-expanded', added: addedRecipes });

                console.log(`${this.name} spawned.`);
                this.log.with('lifecycle').info({ event: 'spawned', bot: this.name });
                this.clearBotLogs();

                this._setupEventHandlers(save_data, init_message);
                this.startEvents();

                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise<void>((resolve) => setTimeout(resolve, 10000));

            } catch (error: unknown) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data: unknown, init_message: string | null): Promise<void> {
        void save_data;
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];

        const respondFunc = async (username: string, message: string, whisper = false): Promise<void> => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                console.log(this.name, 'received message from', username, ':', message);

                // 全中文：不再做英文翻译，直接处理原文。
                // 聊天默认 L3 唤醒；喊急停词的直接抢占当前请求。
                const lower = message.toLowerCase();
                const urgent = STOP_WORDS.some((w) => lower.includes(w.toLowerCase()));
                // **人和队友走不同的路**：
                //   - 队友的话是高频背景音（他们一直在互相报坐标），投成**事件**就够；
                //   - **玩家（人）在跟你说话，是必须回应的** —— 投成**真正的用户回合**。
                //
                // 真机现象：玩家在聊天框问"你们能听到我说话吗？"，两个 bot 收到了、也进了上下文
                // （日志里同一句话被重复渲染了 120+ 次），但**一句话不回**。因为它是**事件**、
                // 不是"有人在问我"——事件尾巴每个请求都重放一遍，模型看多了就当背景噪音。
                // 用户回合不一样：它进对话历史，模型必须对它产出一轮。
                if (!this.teammateNames.has(username)) {
                    const text =
                        '玩家 ' + username + ' 对你说：' + message +
                        (whisper ? '（这是私聊，别人听不到）' : '') +
                        '\n**有人在直接跟你说话，先用 Say（或正文）回一句，再继续手上的活。**';
                    void this.wiring?.runtime.submit(text);
                    return;
                }

                await this.handleMessage(
                    username,
                    message,
                    KIND.USER,
                    urgent ? LEVEL.PREEMPT : LEVEL.WAKE,
                    {
                        whisper,
                        mention: lower.includes(this.name.toLowerCase()),
                        expectReply: true,
                    },
                );
            } catch (error: unknown) {
                console.error('Error handling message:', error);
            }
        };

		this.respondFunc = respondFunc;

        this.bot.on('whisper', (username: string, message: string) => {
            void respondFunc(username, message, true);
        });

        this.bot.on('chat', (username: string, message: string) => {
            void respondFunc(username, message, false);
        });

        // Set up auto-eat
        this.bot.autoEat.setOpts({
            priority: 'foodPoints',
            minHunger: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
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
                useOffhand: true
            });
        } catch (err: unknown) {
            console.warn('commonSense options failed:', err instanceof Error ? err.message : String(err));
        }

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
        }
        else if (!init_message && !save_data) {
            this.openChat(MESSAGES.hello(this.name));
        }
    }

    requestInterrupt(): void {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        stopPvp(this.bot);
    }

    clearBotLogs(): void {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    private currentSource: string = 'system';

    /**
     * 事件的**唯一入口**。
     *
     * 事件就是一条消息：渲染成文本后交给 `EventIntake`，由它按级别落到原生
     * 原语（L1/L2 `write` 被动 entry、L3 `steer` 引导、L4 `abort`+`submit`、
     * L5 `abort`+保命反射+恢复）。
     *
     * `loopLog` 仍然留一份审计台账——它是"谁在什么时候叫醒了 agent"的唯一
     * 记录，和模型看到什么无关，但排障时救命。
     */
    private notify(kind: Kind, level: Level, payload: unknown): void {
        this.loopLog.push({ kind, level, payload });
        if (this.loopLog.length > EVENT_LOG_LIMIT) {
            this.loopLog.splice(0, this.loopLog.length - EVENT_LOG_LIMIT);
        }
        this.log.with('event').debug({ phase: 'queued', kind, level, payload });
        this.intake.notify({ level, text: renderEventText(kind, level, payload) });
    }

    /**
     * 装配 deliberative 层。
     *
     * 与旧的 `buildLoop` 的区别：没有手写循环、没有 `Prompter`、没有 `History`。
     * 回合、历史、压仓、持久化全部由 pi-durable 的 `Conversation` 承担；我们
     * 只提供**工具集**与**每轮尾巴**。
     *
     * `ActionRunner`（身体通道）**保留**：E1–E4 的契约住在这里，它不是
     * "重复造轮子"，而是本项目的业务约束——同一时刻最多一个占用型动作。
     */
    private buildRuntime(): void {
        this.log = createLogger({ dir: `./bots/${this.name}/logs` });
        this.log.with('lifecycle').info({ event: 'build-runtime', bot: this.name });
        this.scheduler = new Scheduler();
        this.edgeWatcher = createEdgeWatcher();
        this.actionRunner = new ActionRunner({
            scheduler: this.scheduler,
            // pi-durable 自己会记工具结果；动作**完成**走 L3 消息（见 notify）。
            // 这里不再往上下文补一条回执——那会把同一件事喂两遍。
            record: () => Promise.resolve(),
            speak: (text: string): void => {
                this.routeResponse(this.currentSource, text);
            },
            execute: (tool: string, toolArgs: Record<string, unknown>): Promise<string> =>
                executeToolCall(this, tool, toolArgs),
            notify: (payload: { call: string; result: ToolOutcome }): void => {
                this.notify(KIND.TOOL, LEVEL.WAKE, payload);
            },
            // 身体通道的观测：认领 / 忙时幂等 / 忙时别动作 / 完成 / 过期丢弃。
            // 这些是 E1–E4 契约的行为证据，以前全静默。
            trace: (event): void => {
                this.log.with('action').info({ ...event });
            },
        });
        // 异步装配（要开 SQLite）；就绪前的事件由 intake 暂存，接上时补投。
        void this.openRuntime();
    }

    /** 异步装配运行时。失败不拖垮 agent：日志留痕，事件仍在 intake 里等着。 */
    private async openRuntime(): Promise<void> {
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
                sample: () => this.sampleContext(),
                // 每轮现拍一张画面，跟世界快照一起进请求。
                // 这就是 `settings.allow_vision` 那句注释一直承诺、却从没接线
                // 的东西：`captureBase64()` 有，`liveImage` 参数也有，中间缺的
                // 就是这一行。拍不到（相机没开 / worldView 没就绪）返回 null，
                // 请求退化成纯文本，不报错。
                liveImage: () => this.captureScreenshot(),
                tools: [
                    ...buildGameTools({
                        execute: (name: string, args: Record<string, unknown>) =>
                            this.invokeTool(name, args),
                        // 只有声明了 withScreenshot 的命令会真的调它（目前只有 !stats）。
                        // 相机没开/没就绪时返回 null，回执退化成纯文本，不报错。
                        captureImage: () => this.captureScreenshot(),
                    }),
                    createStopTool(() => this.fullStop()),
                    createUpdatePlanTool((goal, todos) => this.plan.update(goal, todos)),
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
                rescue: () => this.runEmergency(),
                extensions: [
                    defineExtension({
                        name: 'request-log',
                        hooks: [requestLogHook(sink), compactionPageHook(sink)],
                    }),
                    // provider 终态响应（含 errorMessage）+ 压仓。这两件以前完全
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
                    // **CLI 的事件缓冲**：外部命令行没有"被唤醒"这回事——它只在
                    // 被调用的那一刻才看得到东西。所以事件不能只在投递时打日志，
                    // 得留一份给下一次 CLI 调用带走。上限 200 条，够一次调试会话。
                    this.cliEvents.push({ at: Date.now(), level: event.level, action, text: event.text });
                    if (this.cliEvents.length > CLI_EVENT_LOG_LIMIT) {
                        this.cliEvents.splice(0, this.cliEvents.length - CLI_EVENT_LOG_LIMIT);
                    }
                },
            });
            this.wiring = wiring;
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
        } catch (error: unknown) {
            console.error('Runtime init failed:', error instanceof Error ? error.message : String(error));
        }
    }

    /** 工具名列表（请求日志头用）。 */
    private toolNames(): string[] {
        return buildGameTools({ execute: () => '' }).map((tool) => tool.name);
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
        let text: string;
        try {
            text = await actionChannelInvoker(runner)(name, args);
        } finally {
            // **失败也要消耗** —— 这是"按次数授权"全部意义所在：模型申请 3 次，
            // 第 2 次寻路失败，额度当场用完，闸门立刻回到默认禁止、保命重新接管。
            // 放 finally 里就是为了让异常路径也扣：不然模型可以无限重试同一件事。
            if (!CONTROL_TOOLS.has(name)) {
                const now = Date.now();
                const permitSpent = permits.consumeCall(now);
                const guardSpent = safeguards.consumeCall(now);
                if (permitSpent || guardSpent) {
                    log.info({ name, note: '次数额度用尽，闸门/保命恢复默认' });
                }
            }
        }
        log.info({ name, args, ms: Date.now() - started, result: text });
        return text;
    }

    /** CLI 事件缓冲（见 `runCliCommand`）。外部命令行靠它补看"不在场时"发生的事。 */
    private cliEvents: CliEvent[] = [];

    /** CLI 任务表（见 `startCliJob`）。状态机在 `cli_jobs.ts`，那边可单测。 */
    private cliJobs = new CliJobTracker({ stop: async () => { await this.actions.stop(); } });

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
        const game = GAME_COMMANDS.map((c) => stripBang(c.name)).sort();
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
        // 内置命令（不是游戏工具）：这些得在 bot 进程里跑，因为要碰会话数据库。
        if (name === 'tools') return this.cliListTools();
        if (name === 'jobs') return this.cliListJobs();
        if (name === 'history') return await this.cliHistory(Number(args.limit ?? 40) || 40);
        if (name === 'events') return this.cliRecentEvents(Number(args.limit ?? 30) || 30);

        if (force) {
            try {
                await this.actions.stop();
            } catch {
                // 停不掉就硬着头皮跑，回执里会体现冲突。
            }
        }
        const found = GAME_COMMANDS.find((c) => c.name === `!${name}` || c.name === name);
        if (found == null) return `没有这条命令：${name}。用 tools 看看有哪些。`;
        try {
            const ordered = Object.keys(found.params ?? {}).map((k) => args[k]);
            const raw = await found.perform(this, ...ordered);
            const text = raw == null ? '(no output)' : String(raw);
            // **CLI 这条路不走 `commandToRegistration`**（那个是给模型用的，把图塞进
            // 工具回执的多模态 content 里）。这里是终端，塞 base64 只会刷屏——
            // 存成临时文件，回执给路径，人自己打开看。
            return found.withScreenshot === true ? await this.attachScreenshotFile(text) : text;
        } catch (err: unknown) {
            return `命令 ${name} 出错：${err instanceof Error ? err.message : String(err)}`;
        }
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

    /**
     * 现拍一张画面（base64 jpeg）给工具回执用；拍不到就 null。
     *
     * 单独包一层是为了让"拍不到"这件事**安静地失败**：视觉是锦上添花，
     * 不能因为相机没就绪就把整条工具回执毁掉（工具回执是模型的行动依据）。
     */
    private async captureScreenshot(): Promise<string | null> {
        try {
            const vision = this.vision_interpreter as
                | { captureBase64?: () => Promise<string | null> }
                | null
                | undefined;
            if (vision == null || typeof vision.captureBase64 !== 'function') return null;
            return await vision.captureBase64();
        } catch (err: unknown) {
            this.log.with('vision').warn({ phase: 'capture-failed', err: String(err) });
            return null;
        }
    }

    /** 全部停下：动作停、日志清、回到 idle。 */
    private async fullStop(): Promise<void> {
        await this.actions.stop();
        this.clearBotLogs();
        this.bot.emit('idle');
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
     * 现采一份 Live State 文本。
     *
     * **感知与"拍照"共用同一份采样**：请求尾巴每轮现采（不进历史），
     * `stats` 工具则把这个文本作为 Tool 回执留在上下文里（永久留存，
     * 模型可以和上一次对比"我现在多了什么"）。两者绝不能各采各的，
     * 否则模型会看到两份互相矛盾的状态。
     */
    liveStateText(): string {
        return renderLiveState(sampleLiveState(this.sampleContext()));
    }

    /**
     * 感知采样的**唯一入口**。
     *
     * 尾巴（每轮现采、不进上下文）与 `stats`（模型主动拍、永久留存）都从这里
     * 取数——两处绝不能各采各的，否则模型会看到两份互相矛盾的状态。
     * 迁移到 pi-durable 后，它同时被 `openBotWiring` 的 `sample` 回调复用。
     */
    sampleContext(): SampleContext {
        const task = this.task as { goal?: unknown } | null;
        const plan = this.plan.snapshot();
        return {
            bot: this.bot,
            vision: this.vision_interpreter,
            goal: plan.goal ?? (typeof task?.goal === 'string' ? task.goal : null),
            todos: plan.todos,
            currentAction: this.currentActionName(),
        };
    }

    private async runEmergency(): Promise<void> {
        const bot = this.bot;
        await runEmergency({
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
                    // 水里按 jump 就是上浮；顺便抬头，免得贴着天花板原地顶。
                    bot.setControlState('jump', true);
                    void bot.look(bot.entity.yaw, -Math.PI / 2, true);
                } catch {
                    // 拿不到实体就没什么可做的。
                }
            },
            // 模型用 !disableSafeguards 签了生死状 → 连溺水都不再上浮。
            safeguardsOff: (): boolean => safeguards.isSuppressed(Date.now()),
        });
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
        this.notify(kind, level, { source, message, ...extra });
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
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.chat_ingame) {this.bot.chat(message);}
            sendOutputToServer(this.name, message);
        }
    }

    startEvents(): void {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
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
                    this.notify(KIND.WORLD, LEVEL.STATE, {
                        type: 'bot.hurt',
                        health: this.bot.health,
                        damage: hurt.damage,
                    });
                }
            }
            prev_health = this.bot.health;
            // 低血边沿：掉进线以下发一次 L5，回到 12 以上才重新 armed。
            if (shouldTriggerEmergency(this.bot.health) && !this.lowHpArmed) {
                this.lowHpArmed = true;
                this.notify(KIND.WORLD, LEVEL.EMERGENCY, { health: this.bot.health });
            } else if (typeof this.bot.health === 'number' && this.bot.health >= 12) {
                this.lowHpArmed = false;
            }
        });
        // Logging callbacks
        this.bot.on('error' , (err: unknown) => {
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
            // **立刻中断推理**，不等事件队列（L4 也要 abort，但先做一遍更稳）。
            void this.wiring?.runtime.abort();
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
                const text = MESSAGES.death(death_pos_text || 'unknown', dimention, message);
                // **先写一条 L2 被动记录**。L4 会走 `abort()`，而 `abort()` 撤回
                // 排队中的输入——真机上这条死亡消息 19 秒后才落地，最后连同被
                // abort 的那一轮一起丢了，模型全程不知道自己死了。
                // L2 是 write，pi-durable 明确"queued writes stay"，不参与撤回。
                //
                // 这里**不走 `handleMessage`**：它静音时会直接丢事件（`stfu`），
                // 而死亡不该被静音吃掉。
                this.notify(KIND.WORLD, LEVEL.STATE, { source: 'system', message: text });
                // 再用 L4 把模型叫起来（优先通道，立刻插队）。
                this.notify(KIND.WORLD, LEVEL.PREEMPT, {
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
        this.bot.on('playerCollect', (collector: any, collected: any) => {
            try {
                if (!collector || collector.id !== this.bot?.entity?.id) return;
                const now = Date.now();
                if (now - this.lastCollectEmitAt < 2000) return;
                this.lastCollectEmitAt = now;
                const name = collected?.name ?? collected?.displayName ?? 'item';
                this.notify(KIND.WORLD, LEVEL.WAKE, { type: 'inventory.collected', item: String(name) });
            } catch (err: unknown) {
                console.error('collect event failed:', err instanceof Error ? err.message : String(err));
            }
        });
        // 开箱：容器界面打开即事件（关箱不报，没信息量）。
        this.bot.on('windowOpen', (window: any) => {
            try {
                this.notify(KIND.WORLD, LEVEL.WAKE, {
                    type: 'inventory.container',
                    title: String(window?.title ?? 'container'),
                });
            } catch (err: unknown) {
                console.error('container event failed:', err instanceof Error ? err.message : String(err));
            }
        });

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
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

    update(delta: number): void {
        void delta;
        this.checkTaskDone();
        // 开发者通道：读 inbox 的新行（见 pollInbox）。
        this.pollInbox();
        // 拾取是后台行为，**不能 await**：它最多要走 4 秒，await 会把边沿轮询
        // 一起冻住（update 本来就是串行的）。
        this.maybeAutoPickup();
        // 兜底关窗：残留的开着的容器界面会废掉一整类世界交互（见 maybeCloseStaleScreen）。
        this.maybeCloseStaleScreen();
        // 深水强制出水（见 maybeForceExitWater）。同样是后台行为，不能 await。
        this.maybeForceExitWater();
        this.pollEdges();
    }

    /**
     * 站在危险的水里就自己上岸。
     *
     * 授权管的是"模型想不想下水"，管不了"它已经站在水里了"。用户的原话是
     * "其他情况，我们得想办法强制出水"，所以这条是我们写死的反射，不走模型。
     *
     * 三个不做：
     * - **正在出水就不重复触发**（它是 repeat 式判据，不锁会自己叠自己）。
     * - **模型正在干活就不抢方向盘**（它可能刚授权过、正打算水下作业）。
     * - **不着火也不授权才动** —— 这两条由 `forceExitWater` 自己判，别在这里
     *   复制一遍判据，复制就会漂移。
     */
    private maybeForceExitWater(): void {
        if (this.exitingWater) return;
        if (this.bot == null) return;
        const now = Date.now();
        // **失败就退避**：纯水大陆上"岸"这件事不会靠重试变可能，2 秒一轮只会
        // 反复抢身体、反复往回执里塞同一句话。退到 30 秒，把身体还给模型
        // （它也许想造船、或者游向某个方向）。
        const gap = this.waterExitFailures > 0 ? 30_000 : 2000;
        if (now - this.lastWaterCheckAt < gap) return;
        this.lastWaterCheckAt = now;
        if (this.scheduler?.currentAction() != null) return;

        const bot = this.bot;
        this.exitingWater = true;
        void forceExitWater(bot)
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
        if (this.scheduler?.currentAction() != null) return;
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
     * 开发者通道：`bots/<name>/inbox.txt` 里**新增的每一行**都当一条用户消息投进去。
     *
     * 为什么需要：跑起来之后要跟机器人说话，原来只有两条路——人肉在游戏里打字，
     * 或者重启（丢进度）。而临时起一个 mineflayer 客户端进服在这台服务器上会卡在
     * 握手。文件通道不依赖任何协议细节，脚本能写、也能一次性给两个 bot 发。
     *
     * 记 offset 只读新增内容，所以重复调用不会重复投递。读到就立刻走
     * `handleMessage`（L3），和玩家在游戏里说话是同一条路。
     */
    private pollInbox(): void {
        const file = `./bots/${this.name}/inbox.txt`;
        try {
            const size = statSync(file).size;
            if (size < this.inboxOffset) this.inboxOffset = 0; // 文件被重写过
            if (size === this.inboxOffset) return;
            const fd = openSync(file, 'r');
            const buf = Buffer.alloc(size - this.inboxOffset);
            readSync(fd, buf, 0, buf.length, this.inboxOffset);
            closeSync(fd);
            this.inboxOffset = size;
            for (const raw of buf.toString('utf8').split('\n')) {
                const line = raw.trim();
                if (line === '') continue;
                this.handleMessage('developer', line, KIND.USER, LEVEL.WAKE);
            }
        } catch {
            // 没有 inbox 文件是常态，不是错误。
        }
    }

    /**
     * 自动拾取调度：到点、没在捡、身体空闲就试一次。
     *
     * 它是"最低优先级的房客"——通道被模型的动作占着就老实等着；反过来模型
     * 要用身体时可以在 `ActionRunner` 里把它抢占掉（`Scheduler.preempt`），
     * **模型永远不该因为后台行为吃到 ACTION_BUSY**。
     */
    private maybeAutoPickup(): void {
        if (!this.bot || !this.scheduler) return;
        const now = Date.now();
        const target = nearestDropWithin(this.bot, PICKUP_RADIUS);
        if (target == null) {
            this.pickupStarved = false;
            return;
        }
        const busy = this.scheduler.currentAction() != null;
        if (
            !shouldAttemptPickup({
                busy,
                pickingUp: this.pickingUp,
                sinceLastAttemptMs: now - this.lastPickupAt,
            })
        ) {
            // "有掉落物、但通道被**模型的动作**占着"是最值得看见的一种失败：它
            // 意味着拾取根本轮不上（模型连着发动作）。每次挨饿只记一行，不刷屏。
            //
            // 必须排除"被自己占着"（上一次拾取还没结束）——那是正常重叠，
            // 报出来会变成 `blockedBy: autoPickup`，日志就在说假话了。
            if (busy && !this.pickingUp && !this.pickupStarved) {
                this.pickupStarved = true;
                this.log.with('pickup').warn({
                    note: '通道被模型的动作占着，先不捡',
                    target: target.name,
                    distance: Number(target.distance.toFixed(1)),
                    blockedBy: this.currentActionName(),
                });
            }
            if (!busy) this.pickupStarved = false;
            return;
        }
        this.pickupStarved = false;
        this.lastPickupAt = now;
        this.pickingUp = true;
        void this.tryAutoPickup(target).finally(() => {
            this.pickingUp = false;
        });
    }

    /** 走一步去把指定掉落物踩进背包；失败/超时/被抢占都安静收场。 */
    private async tryAutoPickup(target: PickupTarget): Promise<void> {
        const claim = this.scheduler.startAction(AUTO_PICKUP_ID, { id: target.id });
        if (!claim.accepted) return;
        const log = this.log.with('pickup');
        log.info({ phase: 'start', target: target.name, distance: Number(target.distance.toFixed(1)) });
        const generation = claim.generation ?? 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const started = Date.now();
        try {
            const arrived = await Promise.race([
                goToPosition(this.bot, target.x, target.y, target.z, 0)
                    .then(() => true)
                    .catch(() => false),
                // 被抢占（generation 变了）也立刻收手：模型要用身体了。
                (async (): Promise<boolean> => {
                    while (this.scheduler.isCurrent(generation)) {
                        await new Promise<void>((resolve) => setTimeout(resolve, 150));
                    }
                    return false;
                })(),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(false), PICKUP_TIMEOUT_MS);
                }),
            ]);
            if (!arrived) {
                try {
                    this.bot.pathfinder?.stop?.();
                } catch {
                    // 停不下来就算了，通道照样释放。
                }
            }
            log.info({
                phase: arrived ? 'arrived' : 'gave-up',
                target: target.name,
                ms: Date.now() - started,
                preempted: !this.scheduler.isCurrent(generation),
            });
        } catch (err: unknown) {
            log.error({ target: target.name, error: err instanceof Error ? err.message : String(err) });
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            // **只有这一代还活着才释放**：被 Stop/抢占过的话，通道已经不属于它了，
            // 这时 releaseAction 会把模型刚认领的通道误放掉。
            if (this.scheduler.isCurrent(generation)) this.scheduler.releaseAction();
        }
    }

    /**
     * 边沿轮询（300ms 一次）：现拼快照，过检测器，定级后交给 `notify`。
     * 等级高的先处理。
     *
     * 不再 async：事件的投递现在是一次同步 `notify`（`EventIntake` 内部把
     * 异步动作串行化），这里没有可 await 的东西了。
     */
    private pollEdges(): void {
        if (!this.edgeWatcher || !this.bot) return;
        let snapshot;
        try {
            const task = this.task as { goal?: unknown } | null;
            snapshot = snapshotFromBot(this.bot, {
                currentAction: this.currentActionName(),
                goal: typeof task?.goal === 'string' ? task.goal : null,
                foodNames: Object.keys(FOOD_VALUE),
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

            const currentAction = this.scheduler.describe().actionId ?? null;

            // **站着干活不算卡住**：开箱子/合成/查背包时位置当然不变。模型真机报过

            // "误报 task.stuck"，每次误报都白花一次 PREEMPT 唤醒。

            const stuck =

                !isStationaryAction(currentAction) &&

                isStuck(this.stuckPos, pos, this.stuckSince, now, currentAction != null);

            if (stuck) {

                const seconds = Math.round((now - this.stuckSince) / 1000);

                this.stuckSince = now;

                this.notify(KIND.WORLD, LEVEL.PREEMPT, {

                    type: 'task.stuck',

                    position: pos,

                    action: currentAction,

                    // 把"卡了多久"写进去，模型能据此判断是真卡还是刚起步。

                    stuckForSeconds: seconds,

                });

            }

        }
        // 心跳：5 分钟无动作无请求，醒一次做反思，防睡死。
        if (
            isHeartbeatDue(this.lastHeartbeatAt, now) &&
            this.scheduler.describe().actionId == null
        ) {
            this.lastHeartbeatAt = now;
            this.notify(KIND.WORLD, LEVEL.WAKE, { type: 'system.heartbeat' });
        }
        if (events.length === 0) return;
        events.sort((a, b) => b.level - a.level);
        for (const event of events) {
            const edgeLevel = resolvePriority(
                { type: event.type, level: event.level, key: event.key },
                snapshot,
            );
            this.notify(KIND.WORLD, schedulerLevelFor(edgeLevel), {
                type: event.type,
                key: event.key,
                delta: event.delta,
                actionContext: event.actionContext,
            });
        }
    }

    isIdle(): boolean {
        return !this.actions.executing;
    }


    cleanKill(msg = 'Killing agent process...', code = 1): void {
        // **同步写盘**：紧接着就是 process.exit，异步日志会连同缓冲区一起丢——
        // 而"退出前最后一行"恰恰是排错最需要的（静默死亡最难查）。
        this.log.with('lifecycle').error({ event: 'exit', msg, code });
        console.log(this.name, msg);
        this.bot.chat(code > 1 ? MESSAGES.restarting : MESSAGES.exiting);
        process.exit(code);
    }
    checkTaskDone(): void {
        if (this.task.data) {
            const res = this.task.isDone();
            if (res) {
                // 任务完成/失败先进消息队列（失败 L4，成功 L3），再收尾退出。
                const failed = typeof res.score === 'number' && res.score < 1;
                this.notify(KIND.WORLD, failed ? LEVEL.PREEMPT : LEVEL.WAKE, {
                    type: failed ? 'task.failed' : 'task.done',
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
