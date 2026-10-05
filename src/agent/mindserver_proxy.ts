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
