import { History } from './history.js';
import type { HistorySaveData } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initBot } from '../utils/mcdata.js';
import { executeToolCall } from './commands/to_openai_tools.js';
import { stopPvp } from './library/skills.js';
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
    coder!: Coder;
    npc: any; // 未迁移模块，统一 any
    memory_bank!: MemoryBank;
    task: any; // 未迁移模块，统一 any
    blocked_actions: string[] = [];
    bot: any; // mineflayer 无类型，bot 统一 any
    vision_interpreter: VisionInterpreter | undefined;
    shut_up: boolean = false;
    respondFunc: ((username: string, message: string) => Promise<void>) | undefined;

    start(load_mem = false, init_message: string | null = null, count_id = 0): void {
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        // settings.profile 在 Agent 启动前必已加载，这里断言非空
        this.prompter = new Prompter(this, settings.profile!);
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
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();

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
            console.log(this.name, 'logged in!');
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

        const respondFunc = async (username: string, message: string): Promise<void> => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);

                // 全中文：不再做英文翻译，直接处理原文
                await this.handleMessage(username, message);
            } catch (error: unknown) {
                console.error('Error handling message:', error);
            }
        };

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);

        this.bot.on('chat', (username: string, message: string) => {
            respondFunc(username, message);
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

    shutUp(): void {
        this.shut_up = true;
    }

    async handleMessage(source: string, message: string): Promise<boolean> {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        // ReAct 无限循环直到 Finish：无上限，循环只由 Finish / 无响应 / 中断结束

        // 全中文：不再做翻译，直接使用原文
        console.log('received message from', source, ':', message);

        const checkInterrupt = (): boolean => this.shut_up;

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        if (typeof this.prompter.chat_model.sendRequestWithTools !== 'function') {
            const err = `Model ${this.prompter.chat_model.constructor?.name ?? 'unknown'} does not support native tool calling.`;
            console.error(err);
            this.routeResponse(source, MESSAGES.modelUnsupported);
            return false;
        }
        for (;;) {
            if (checkInterrupt()) break;
            const history = this.history.getHistory();

            // 原生工具调用：模型直接返回 tool_calls，Finish 结束循环
            const toolRes: ToolResponse | undefined = await this.prompter.promptConvoTools(history);
            if (!toolRes || (!toolRes.tool_calls?.length && !toolRes.text?.trim())) {
                console.warn('no response');
                break;
            }
            if (toolRes.text?.trim()) {
                console.log(`${this.name} full response to ${source}: ""${toolRes.text}""`);
                this.history.add(this.name, toolRes.text);
                this.routeResponse(source, toolRes.text);
            }
            if (!toolRes.tool_calls?.length) {
                this.history.save();
                break;
            }
            let finished = false;
            for (const tc of toolRes.tool_calls) {
                if (checkInterrupt()) break;
                if (tc.name === 'Finish') {
                    finished = true;
                    break;
                }
                this.routeResponse(source, MESSAGES.usedMarker(tc.name));
                const execute_res = await executeToolCall(this, tc.name, tc.args);
                console.log('Agent executed tool:', tc.name, 'and got:', execute_res);
                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            this.history.save();
            if (finished || checkInterrupt()) break;
        }

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
        });
        // Logging callbacks
        this.bot.on('error' , (err: unknown) => {
            console.error('Error event!', err);
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
                this.handleMessage('system', MESSAGES.death(death_pos_text || 'unknown', dimention, message));
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
