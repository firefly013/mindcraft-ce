import { createMindServer, registerAgent, numStateListeners } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import open from 'open';
import type { Server as HttpServer } from 'http';
import type { Settings } from '../../shared/types/common.js';
import { ConfigError, validateProfile } from '../../shared/config/load.js';
import { resolveProvider } from '../runtime/provider.js';

export interface CreateAgentResult {
    success: boolean;
    error: string | null;
}

let mindserver: HttpServer | undefined;
let connected = false;
const agent_processes: Record<string, AgentProcess> = {};
let agent_count = 0;
let mindserver_port: number | string = 8080;

export function init(
    host_public = false,
    port: number | string = 8080,
    auto_open_ui = true,
): void {
    if (connected) {
        console.error('Already initiliazed!');
        return;
    }
    mindserver = createMindServer(host_public, port);
    mindserver_port = port;
    connected = true;
    if (auto_open_ui) {
        setTimeout(() => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                void open('http://localhost:' + port);
            }
        }, 3000);
    }
}

export async function createAgent(incomingSettings: Settings): Promise<CreateAgentResult> {
    // 网页上传的 profile 不经过 main.ts 的启动校验，所以这里再校验一次；
    // 顺带把端点/模型/凭据解析一遍——配置错了要在**起进程之前**报出来，
    // 否则 agent 进程起来就死，只剩重启循环。
    try {
        validateProfile(incomingSettings.profile);
        resolveProvider(incomingSettings.profile);
    } catch (error: unknown) {
        const message = error instanceof ConfigError || error instanceof Error ? error.message : String(error);
        // 调用方负责显示：网页端把 error 回给浏览器，CLI 端打印后退出。
        return { success: false, error: message };
    }

    if (!incomingSettings.profile?.name) {
        console.error('Agent name is required in profile');
        return {
            success: false,
            error: 'Agent name is required in profile',
        };
    }
    const settings: Settings = JSON.parse(JSON.stringify(incomingSettings)) as Settings;
    const agent_name = settings.profile?.name as string;
    const agentIndex = agent_count++;
    const viewer_port = 3000 + agentIndex;
    registerAgent(settings, viewer_port);
    const load_memory = settings.load_memory || false;
    const init_message = (settings.init_message as string | null) || null;

    try {
        try {
            const configuredPort = Number(settings.port);
            const portForLookup = Number.isInteger(configuredPort) ? configuredPort : -1;
            const server = await getServer(
                settings.host as string,
                portForLookup,
                settings.minecraft_version as string,
            );
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = server.version ?? settings.minecraft_version;
        } catch (error: unknown) {
            console.warn(`Error getting server:`, error);
            if (settings.minecraft_version === 'auto') {
                settings.minecraft_version = null as unknown as string;
            }
            console.warn(`Attempting to connect anyway...`);
        }

        const agentProcess = new AgentProcess(agent_name, mindserver_port);
        agentProcess.start(load_memory, init_message, agentIndex);
        agent_processes[agent_name] = agentProcess;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error creating agent ${agent_name}:`, error);
        destroyAgent(agent_name);
        return {
            success: false,
            error: message,
        };
    }
    return {
        success: true,
        error: null,
    };
}

export function getAgentProcess(agentName: string): AgentProcess | undefined {
    return agent_processes[agentName];
}

export function startAgent(agentName: string): void {
    if (agent_processes[agentName]) {
        agent_processes[agentName]?.forceRestart();
    } else {
        console.error(`Cannot start agent ${agentName}; not found`);
    }
}

export function stopAgent(agentName: string): void {
    if (agent_processes[agentName]) {
        agent_processes[agentName]?.stop();
    }
}

export function destroyAgent(agentName: string): void {
    if (agent_processes[agentName]) {
        agent_processes[agentName]?.stop();
        Reflect.deleteProperty(agent_processes, agentName);
    }
}

export function shutdown(): void {
    console.log('Shutting down');
    for (const agentName in agent_processes) {
        agent_processes[agentName]?.stop();
    }
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}
