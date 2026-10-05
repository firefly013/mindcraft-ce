import { History } from './history.js';
import type { HistorySaveData } from './history.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initBot } from '../utils/mcdata.js';
import { executeToolCall, getOpenAITools, isActionTool, validateToolCall, validateUpdatePlan, formatSay } from './commands/to_openai_tools.js';
import { stopPvp, consume } from './library/skills.js';
import pf from 'mineflayer-pathfinder';
import { isHostile } from '../utils/mcdata.js';
import { Scheduler, KIND, LEVEL } from './scheduler.js';
import type { Kind, Level } from './scheduler.js';
import { STOP_WORDS } from './edges.js';
import { AgentLoop } from './loop.js';
import type { LoopModelResponse, LoopRunner, LoopToolResult } from './loop.js';
import { sampleLiveState, renderLiveState } from './live_state.js';
import { runEmergency, shouldTriggerEmergency, FOOD_VALUE } from './emergency.js';
import type { ThreatEntity } from './emergency.js';
import { PlanStore } from './plan.js';
import { createEdgeWatcher, resolvePriority, schedulerLevelFor, snapshotFromBot } from './edges.js';
import { createRequestLog } from './requestLog.js';
import type { RequestLog } from './requestLog.js';

type EdgeWatcher = ReturnType<typeof createEdgeWatcher>;
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { MESSAGES } from '../prompts.js';
import { Task } from './tasks/tasks.js';
import type { TaskData } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import type { ToolResponse } from '../types/common.js';

export class Agent {
    count_id: number = 0;
    _disconnectHandled: boolean = false;

    actions!: ActionManager;
    prompter: any; // 未迁移模块，交叉引用统一 any
    name: string = '';
    history!: History;
    npc: any; // 未迁移模块，统一 any
    memory_bank!: MemoryBank;
    task: any; // 未迁移模块，统一 any
    blocked_actions: string[] = [];
    bot: any; // mineflayer 无类型，bot 统一 any
    vision_interpreter: VisionInterpreter | undefined;
    shut_up: boolean = false;
    respondFunc: ((username: string, message: string) => Promise<void>) | undefined;
    scheduler!: Scheduler;
    loop!: AgentLoop;
    loopLog: Array<{ kind: string; level: number; payload: unknown }> = [];
    plan: PlanStore = new PlanStore();
    edgeWatcher: EdgeWatcher | null = null;
    requestLog: RequestLog | null = null;
    toolHandlers = new Map<string, (args: unknown) => Promise<LoopToolResult>>();
    lowHpArmed: boolean = false;

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
        this.prompter = new Prompter(this, profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);

        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }

        this.history = new History(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.requestLog = createRequestLog({ dir: `./bots/${this.name}` });

        // load mem first before doing task
        let save_data: HistorySaveData | null = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart: number;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task as TaskData | null, taskStart);
        // 原生工具黑名单：getOpenAITools 按此过滤，不再需要文本命令黑名单
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        this.buildLoop();

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
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
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
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise<void>((resolve) => setTimeout(resolve, 1000));

                console.log(`${this.name} spawned.`);
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

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                // 全中文：不再做英文翻译，直接处理原文。
                // 聊天默认 L3 唤醒；喊急停词的直接抢占当前请求。
                const lower = message.toLowerCase();
                const urgent = STOP_WORDS.some((w) => lower.includes(w.toLowerCase()));
                await this.handleMessage(
                    username,
                    message,
                    KIND.USER,
                    urgent ? LEVEL.PREEMPT : LEVEL.WAKE,
                    { whisper, mention: lower.includes(this.name.toLowerCase()) },
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
                fallCheck: true,
                fireCheck: true,
                useOffhand: true
            });
        } catch (err: unknown) {
            console.warn('commonSense options failed:', err instanceof Error ? err.message : String(err));
        }

        if (init_message) {
            this.history.add('system', init_message);
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

    private buildLoop(): void {
        this.scheduler = new Scheduler();
        this.edgeWatcher = createEdgeWatcher();
        const runner: LoopRunner = {
            register: (name: string, handler: (args: unknown) => Promise<LoopToolResult>) => {
                this.toolHandlers.set(name, handler);
            },
            call: (name: string, args: unknown) => this.runTool(name, args),
        };
        this.loop = new AgentLoop({
            scheduler: this.scheduler,
            runner,
            history: {
                append: (kind: string, level: number, payload: unknown) => {
                    this.loopLog.push({ kind, level, payload });
                },
            },
            assemble: () => this.assembleContext(),
            model: (text: string, tools: unknown) => this.modelCall(text, tools),
            stopExecutor: async () => {
                await this.fullStop();
            },
            emergencyHandler: () => this.runEmergency(),
        });
        // Say 隔离：说话唯一通道。正文不再自动进聊天（见 modelCall），
        // 模型想让玩家听见必须调 Say；空话拒绝，超长截断但记全文。
        this.toolHandlers.set('Say', (args: unknown) => {
            const shaped = formatSay((args as { text?: unknown } | null)?.text);
            if (!shaped.ok || shaped.line == null) {
                return Promise.resolve({
                    status: 'rejected',
                    code: 'BAD_ARGS',
                    reason: shaped.reason ?? 'Bad arguments.',
                } as LoopToolResult);
            }
            this.routeResponse(this.currentSource, shaped.line);
            return Promise.resolve({ status: 'completed', data: shaped.full } as LoopToolResult);
        });
        // UpdatePlan：模型自己写计划，整单替换进存储，下一轮快照即见。
        this.toolHandlers.set('UpdatePlan', (args: unknown) => {
            const checked = validateUpdatePlan(args);
            if (!checked.ok) {
                return Promise.resolve({
                    status: 'rejected',
                    code: checked.code ?? 'BAD_ARGS',
                    reason: checked.errors?.join('; ') ?? 'Bad arguments.',
                } as LoopToolResult);
            }
            const a = (args ?? {}) as { goal?: string | null; todos?: string[] | null };
            const snap = this.plan.update(a.goal, a.todos);
            const summary =
                `Plan updated. Goal: ${snap.goal ?? 'none'}. ` +
                `Todos: ${snap.todos.length > 0 ? snap.todos.join('; ') : 'none'}.`;
            return Promise.resolve({ status: 'completed', data: summary } as LoopToolResult);
        });
    }

    /** 全部停下：动作停、日志清、续跑取消、回到 idle。 */
    private async fullStop(): Promise<void> {
        await this.actions.stop();
        this.clearBotLogs();
        this.actions.cancelResume();
        this.bot.emit('idle');
    }

    private async runTool(name: string, args: unknown): Promise<LoopToolResult> {
        const handler = this.toolHandlers.get(name);
        if (handler) {
            // 控制类调用也广播（Say 除外：它自己已经说话了）。
            if (name !== 'Say') this.routeResponse(this.currentSource, MESSAGES.usedMarker(name));
            return handler(args);
        }
        const record = async (outcome: string): Promise<void> => {
            await this.history.add('system', MESSAGES.toolOutcome(name, args, outcome), {
                kind: 'tool',
                level: 2,
            });
        };
        const checked = validateToolCall(name, args);
        if (!checked.ok) {
            const reason = checked.errors?.join('; ') ?? 'Bad arguments.';
            await record(`rejected: ${reason}`);
            return { status: 'rejected', code: checked.code ?? 'BAD_ARGS', reason };
        }
        if (isActionTool(name)) {
            const claim = this.scheduler.startAction(name);
            if (!claim.accepted) {
                const reason = 'An action is already running. Stop() first, then retry.';
                await record(`rejected: ${reason}`);
                return { status: 'rejected', code: claim.code ?? 'ACTION_BUSY', reason };
            }
            try {
                this.routeResponse(this.currentSource, MESSAGES.usedMarker(name));
                const data = await executeToolCall(this, name, args as Record<string, unknown>);
                await record(data);
                return { status: 'completed', data };
            } finally {
                this.scheduler.releaseAction();
            }
        }
        this.routeResponse(this.currentSource, MESSAGES.usedMarker(name));
        const data = await executeToolCall(this, name, args as Record<string, unknown>);
        await record(data);
        return { status: 'completed', data };
    }

    /** 每轮现采 Live State（原文给模型层，由它追加在消息列最后）。 */
    private assembleContext(): { text: string; tools: unknown } {
        const task = this.task as { goal?: unknown } | null;
        const plan = this.plan.snapshot();
        const live = sampleLiveState({
            bot: this.bot,
            vision: this.vision_interpreter,
            goal: plan.goal ?? (typeof task?.goal === 'string' ? task.goal : null),
            todos: plan.todos,
            currentAction: this.actions.currentActionLabel,
        });
        const text = renderLiveState(live);
        const tools = getOpenAITools(this);
        this.requestLog?.logRequest({
            text,
            tools: tools.map((t) => t.function.name),
        });
        return { text, tools };
    }

    private async modelCall(liveText: string, tools: unknown): Promise<LoopModelResponse> {
        void tools;
        if (this.shut_up) return { text: null, calls: [] };
        const history = this.history.getHistory();
        const res = await this.prompter.promptConvoTools(history, liveText);
        if (!res) return { text: null, calls: [] };
        if (res.text?.trim()) {
            // Say 隔离：正文只记历史不发言，想说话模型必须调 Say。
            await this.history.add(this.name, res.text, { kind: 'model', level: 2 });
        }
        return {
            text: res.text,
            calls: res.tool_calls.map((c: { name: string; args: unknown }) => ({ name: c.name, args: c.args })),
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
                    bot.pathfinder.setMovements(new pf.Movements(bot));
                    bot.pathfinder.setGoal(new pf.goals.GoalXZ(x, z));
                } catch (err: unknown) {
                    console.warn('emergency flee failed:', err instanceof Error ? err.message : String(err));
                }
            },
            eat: (food: string): Promise<void> => consume(bot, food).then(() => undefined),
        });
    }

    shutUp(): void {
        this.shut_up = true;
    }

    async handleMessage(
        source: string,
        message: string,
        kind: Kind = KIND.USER,
        level: Level = LEVEL.WAKE,
        extra: Record<string, unknown> = {},
    ): Promise<boolean> {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        // 全中文：不再做翻译，直接使用原文
        console.log('received message from', source, ':', message);

        // Handle other user messages
        await this.history.add(source, message, {
            kind: source === 'system' ? 'world' : 'user',
            level: 3,
        });
        this.history.save();

        if (typeof this.prompter.chat_model.sendRequestWithTools !== 'function') {
            const err = `Model ${this.prompter.chat_model.constructor?.name ?? 'unknown'} does not support native tool calling.`;
            console.error(err);
            this.routeResponse(source, MESSAGES.modelUnsupported);
            return false;
        }
        this.currentSource = source;
        const verdict = this.loop.notify({ kind, level, payload: { source, message, ...extra } });
        await this.loop.handleDecision(verdict.decision);
        return true;
    }

    routeResponse(to_player: string, message: string): void {
        void to_player;
        if (this.shut_up) return;
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
            if (settings.speak) {
                speak(message, this.prompter.profile.speak_model);
            }
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
            }
            prev_health = this.bot.health;
            // 低血边沿：掉进线以下发一次 L5，回到 12 以上才重新 armed。
            if (shouldTriggerEmergency(this.bot.health) && !this.lowHpArmed) {
                this.lowHpArmed = true;
                const verdict = this.loop.notify({
                    kind: KIND.WORLD,
                    level: LEVEL.EMERGENCY,
                    payload: { health: this.bot.health },
                });
                void this.loop.handleDecision(verdict.decision).catch((err: unknown) => {
                    console.error('emergency decision failed:', err instanceof Error ? err.message : String(err));
                });
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
            this.actions.cancelResume();
            this.actions.stop();
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
                void this.handleMessage(
                    'system',
                    MESSAGES.death(death_pos_text || 'unknown', dimention, message),
                    KIND.WORLD,
                    LEVEL.PREEMPT,
                );
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

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

    async update(delta: number): Promise<void> {
        void delta;
        await this.checkTaskDone();
        await this.pollEdges();
    }

    /**
     * 边沿轮询（300ms 一次）：现拼快照，过检测器，定级后泵入调度。
     * 等级高的先处理；顺序执行，一次只跑一轮（update 本来就是串行的）。
     */
    private async pollEdges(): Promise<void> {
        if (!this.edgeWatcher || !this.loop || !this.bot) return;
        let snapshot;
        try {
            const task = this.task as { goal?: unknown } | null;
            snapshot = snapshotFromBot(this.bot, {
                currentAction: this.actions?.currentActionLabel ?? null,
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
        if (events.length === 0) return;
        events.sort((a, b) => b.level - a.level);
        for (const event of events) {
            const edgeLevel = resolvePriority(
                { type: event.type, level: event.level, key: event.key },
                snapshot,
            );
            const verdict = this.loop.notify({
                kind: KIND.WORLD,
                level: schedulerLevelFor(edgeLevel),
                payload: {
                    type: event.type,
                    key: event.key,
                    delta: event.delta,
                    actionContext: event.actionContext,
                },
            });
            await this.loop.handleDecision(verdict.decision);
        }
    }

    isIdle(): boolean {
        return !this.actions.executing;
    }


    cleanKill(msg = 'Killing agent process...', code = 1): void {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? MESSAGES.restarting : MESSAGES.exiting);
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone(): Promise<void> {
        if (this.task.data) {
            const res = this.task.isDone();
            if (res) {
                await this.history.add('system', MESSAGES.taskEnded(res.score));
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll(): void {
        serverProxy.shutdown();
    }
}
