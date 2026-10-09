import { io } from 'socket.io-client';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    private static instance: MindServerProxy | undefined;

    socket: any = null;
    connected: boolean = false;
    name: string = '';
    agent: any = null; // 交叉引用 Agent，避免循环依赖

    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }

        this.socket = null;
        this.connected = false;
        MindServerProxy.instance = this;
    }

    async connect(name: string, port: number | string): Promise<void> {
        if (this.connected) return;

        this.name = name;
        this.socket = io(`http://localhost:${port}`);

        await new Promise<void>((resolve, reject) => {
            this.socket.on('connect', () => resolve());
            this.socket.on('connect_error', (err: unknown) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
            }
        });

        this.socket.on('restart-agent', (agentName: string) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });

        this.socket.on('send-message', (data: any) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error: unknown) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('get-full-state', (callback: (state: unknown) => void) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error: unknown) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        // **外部 CLI 的入口**：跑一条命令，并把上次调用以来的事件一并带回。
        // 走 ack 回调（和 `get-full-state` 一样），mindserver 负责转发和超时。
        this.socket.on('cli-command', (data: any, callback: (res: unknown) => void) => {
            void (async () => {
                try {
                    if (this.agent == null) {
                        callback({ ok: false, error: '机器人还没准备好' });
                        return;
                    }
                    callback(await this.handleCliCommand(data));
                } catch (error: unknown) {
                    callback({ ok: false, error: error instanceof Error ? error.message : String(error) });
                }
            })();
        });

        // Request settings and wait for response
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, (response: any) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    /**
     * 分发外部 CLI 的请求。**一个事件、多种 op**，省得为每个操作再开一个 socket 事件。
     *
     * 事件（`since` 以后的）在**每个 op 上都带** —— 不管你是提交任务还是查状态，
     * 都该顺带看到"这段时间发生了什么"。
     */
    private async handleCliCommand(data: any): Promise<unknown> {
        const agent = this.agent;
        const op: string = String(data?.op ?? '');
        const args: Record<string, unknown> = data?.args ?? {};
        const since = typeof data?.since === 'number' ? data.since : 0;
        const events = (): unknown[] => (agent.cliEvents ?? []).filter((e: any) => e.at > since);

        switch (op) {
            case 'start': {
                const { id } = await agent.startCliJob(String(data?.name ?? ''), args, data?.force === true);
                return { ok: true, jobId: id, events: events() };
            }
            case 'wait': {
                const res = await agent.cliWaitJob(String(data?.id ?? ''), Number(data?.waitMs ?? 0));
                return { ok: true, job: res, events: events() };
            }
            case 'status': {
                return { ok: true, job: agent.cliJobStatus(String(data?.id ?? '')), events: events() };
            }
            case 'list': {
                return { ok: true, jobs: agent.cliJobList(), events: events() };
            }
            case 'cancel': {
                const cancelled = await agent.cliCancelJob(String(data?.id ?? ''));
                return { ok: true, cancelled, events: events() };
            }
            default:
                return { ok: false, error: `不认识的 op：${op}` };
        }
    }

    setAgent(agent: any): void {
        this.agent = agent;
    }

    login(): void {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown(): void {
        this.socket.emit('shutdown');
    }

    getSocket(): any {
        return this.socket;
    }
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for sending general output to server for display
export function sendOutputToServer(agentName: string, message: string): void {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
