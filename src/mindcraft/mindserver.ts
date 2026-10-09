import { Server, type Socket } from 'socket.io';
import express, { type Request, type Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync } from 'fs';
import type { Settings } from '../types/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users
// - host for webapp

interface SettingsSpecEntry {
    required?: boolean;
    default?: unknown;
    [key: string]: unknown;
}

interface CreateAgentCallbackResult {
    success: boolean;
    error: string | null;
}

interface AgentStatusEntry {
    name: string;
    in_game: boolean;
    viewerPort: number;
    socket_connected: boolean;
}

let io: Server;
let server: http.Server;
const agent_connections: Record<string, AgentConnection> = {};
const agent_listeners: Socket[] = [];

const settings_spec = JSON.parse(
    readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'),
) as Record<string, SettingsSpecEntry>;

class AgentConnection {
    socket: Socket | null;
    settings: Settings;
    in_game: boolean;
    full_state: unknown;
    viewer_port: number;

    constructor(settings: Settings, viewer_port: number) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
    }

    setSettings(settings: Settings): void {
        this.settings = settings;
    }
}

export function registerAgent(settings: Settings, viewer_port: number): void {
    const agentConnection = new AgentConnection(settings, viewer_port);
    const name = settings.profile?.name as string;
    agent_connections[name] = agentConnection;
}

export function logoutAgent(agentName: string): void {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server
export function createMindServer(
    host_public = false,
    port: number | string = 8080,
): http.Server {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Serve static files
    const innerDirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(innerDirname, 'public')));

    // Texture proxy: resolve item/block textures using minecraft-assets with version fallback
    app.get('/assets/item/:agent/:name.png', async (req: Request, res: Response): Promise<void> => {
        try {
            const agentName = req.params.agent as string;
            const rawName = req.params.name as string;
            const itemName = String(rawName).toLowerCase();
            const conn = agent_connections[agentName];
            const preferred = conn?.settings?.minecraft_version as string | undefined;
            const candidates: string[] = [];
            if (preferred && preferred !== 'auto') candidates.push(preferred);
            candidates.push('1.21.11');

            // Lazy import to avoid ESM/CJS conflicts
            // minecraft-assets ships no types; treat as any
            const mod: any = await import('minecraft-assets');
            const mcAssetsFactory: any = mod.default || mod;

            for (const ver of candidates) {
                try {
                    const assets: any = mcAssetsFactory(ver);
                    // Prefer items path first, then blocks
                    const item: any = assets.items[itemName];
                    const block: any = assets.blocks[itemName];
                    const tex: string | null =
                        assets.textureContent?.[itemName]?.texture
                        || (item ? assets.textureContent?.[itemName]?.texture : null)
                        || (block ? assets.textureContent?.[itemName]?.texture : null);
                    if (tex) {
                        // textureContent already provides a data URL in many versions
                        if (tex.startsWith('data:image')) {
                            const base64 = tex.split(',')[1] as string;
                            const img = globalThis.Buffer.from(base64, 'base64');
                            res.setHeader('Content-Type', 'image/png');
                            res.end(img);
                            return;
                        }
                    }
                    // If textureContent missing, try static path resolution inside package
                    // Helps with some strange blocks like Leaf Litter
                    const guessPaths: string[] = [];
                    const base: string = assets.directory;
                    guessPaths.push(path.join(base, 'items', `${itemName}.png`));
                    guessPaths.push(path.join(base, 'blocks', `${itemName}.png`));
                    for (const p of guessPaths) {
                        try {
                            // fs re-import keeps the original lazy CJS/ESM behavior
                            const fsMod: any = await import('fs');
                            const buf: Buffer = fsMod.readFileSync(p);
                            res.setHeader('Content-Type', 'image/png');
                            res.end(buf);
                            return;
                        } catch { /* ignore */ }
                    }
                } catch { /* ignore */ }
            }
            // Not found, fallback svg
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">?</text></svg>');
        } catch {
            res.setHeader('Content-Type', 'image/svg+xml');
            res.status(500).send('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="100%" height="100%" fill="#444"/><text x="50%" y="55%" font-size="12" fill="#bbb" text-anchor="middle">!</text></svg>');
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket: Socket) => {
        let curAgentName: string | null = null;
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (
            settings: Settings,
            callback: (result: CreateAgentCallbackResult) => void,
        ) => {
            console.log('API create agent...');
            for (const key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key]?.required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    } else {
                        (settings as Record<string, unknown>)[key] = settings_spec[key]?.default;
                    }
                }
            }
            for (const key in settings) {
                if (!(key in settings_spec)) {
                    Reflect.deleteProperty(settings as Record<string, unknown>, key);
                }
            }
            if (settings.profile?.name) {
                if ((settings.profile.name as string) in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                const returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                const name = settings.profile.name as string;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    Reflect.deleteProperty(agent_connections, name);
                }
                agentsStatusUpdate();
            } else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (
            agentName: string,
            callback: (result: { settings?: Settings; error?: string }) => void,
        ) => {
            if (agent_connections[agentName]) {
                callback({ settings: agent_connections[agentName].settings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName: string) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName: string) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                curAgentName = agentName;
                agentsStatusUpdate();
            } else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('disconnect', () => {
            if (curAgentName && agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName: string, json: { message: string }) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket?.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName: string, settings: Settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                agent.setSettings(settings);
                agent.socket?.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentName: string) => {
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName]?.socket?.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName: string) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName: string) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName: string) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                Reflect.deleteProperty(agent_connections, agentName);
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (const agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (const agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                globalThis.process.exit(0);
            }, 2000);
        });

        socket.on('send-message', (agentName: string, data: unknown) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return;
            }
            try {
                agent_connections[agentName].socket?.emit('send-message', data);
            } catch (error: unknown) {
                console.error('Error: ', error);
            }
        });

        socket.on('bot-output', (agentName: string, message: unknown) => {
            io.emit('bot-output', agentName, message);
        });

        // **外部 CLI**：把命令转给对应机器人，等它回 ack，再原样回给 CLI。
        //
        // 为什么要超时：命令可能是"走过去"这种要几十秒的动作，而 CLI 那头的人在
        // 等提示符。一直挂着不返回，比返回一个"超时了"更难用——后者至少说明
        // 机器人还活着、只是没干完。默认 120 秒，CLI 可以传 `timeoutMs` 改。
        socket.on('cli-command', (agentName: string, data: unknown, callback?: (res: unknown) => void) => {
            const reply = (res: unknown): void => {
                try {
                    callback?.(res);
                } catch (error: unknown) {
                    console.error('Error replying cli-command: ', error);
                }
            };
            const agent = agent_connections[agentName];
            if (agent?.socket == null) {
                reply({ ok: false, error: `机器人 ${agentName} 不在线（或还没连上 MindServer）` });
                return;
            }
            const timeoutMs =
                typeof (data as { timeoutMs?: unknown })?.timeoutMs === 'number'
                    ? (data as { timeoutMs: number }).timeoutMs
                    : 120_000;
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                // `timeout: true` 让 CLI 能区分"真出错"和"还在跑"。后者对
                // `wait` 来说根本不是失败 —— 任务继续跑着，只是这次不等了。
                reply({
                    ok: false,
                    timeout: true,
                    error: `超过 ${Math.round(timeoutMs / 1000)} 秒还没返回（任务仍在继续）`,
                });
            }, Math.max(1000, timeoutMs));
            try {
                agent.socket?.emit('cli-command', data, (res: unknown) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    reply(res);
                });
            } catch (error: unknown) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = '0.0.0.0';
    server.listen(Number(port), host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket?: Socket | Server): void {
    const target: Socket | Server = socket ?? io;
    const agents: AgentStatusEntry[] = [];
    for (const agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName,
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket,
        });
    }
    target.emit('agents-status', agents);
}


let listenerInterval: NodeJS.Timeout | null = null;
function addListener(listener_socket: Socket): void {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(() => {
            void (async () => {
                const states: Record<string, unknown> = {};
                for (const agentName in agent_connections) {
                    const agent = agent_connections[agentName];
                    if (agent.in_game) {
                        try {
                            const state: unknown = await new Promise((resolve) => {
                                agent.socket?.emit('get-full-state', (s: unknown) => resolve(s));
                            });
                            states[agentName] = state;
                        } catch (e: unknown) {
                            states[agentName] = { error: String(e) };
                        }
                    }
                }
                for (const listener of agent_listeners) {
                    listener.emit('state-update', states);
                }
            })();
        }, 1000);
    }
}

function removeListener(listener_socket: Socket): void {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0 && listenerInterval) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = (): Server => io;
export const getServer = (): http.Server => server;
export const numStateListeners = (): number => agent_listeners.length;
