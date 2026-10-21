import * as Mindcraft from './src/brain/mindserver/mindcraft.js';
import settings from './settings.js';
import { ConfigError, loadAuthConfig, loadProvidersConfig, loadProfile } from './src/shared/config/load.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';

export interface MainArgs {
    profiles?: string[];
    task_path?: string;
    task_id?: string;
    mcHost?: string;
    mcPort?: number;
}

function parseArguments(): MainArgs {
    const parsed = yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .option('mc-host', {
            type: 'string',
            describe: 'Minecraft server host (defaults to settings.host)'
        })
        .option('mc-port', {
            type: 'number',
            describe: 'Minecraft server port; omit to scan the host for LAN servers'
        })
        .help()
        .alias('help', 'h')
        .parseSync();
    return {
        profiles: parsed.profiles?.map(String),
        task_path: parsed.task_path,
        task_id: parsed.task_id,
        mcHost: typeof parsed.mcHost === 'string' ? parsed.mcHost : undefined,
        mcPort: typeof parsed.mcPort === 'number' ? parsed.mcPort : undefined,
    };
}

/**
 * 配置错误一律**当场退出**（退出码 1）。
 *
 * 规矩：配置文件解析失败、校验失败、引用的模型找不到，都在这里炸出来，
 * 而不是取个默认值继续跑——跑起来的错配比启动失败难查得多。
 */
try {
    const args = parseArguments();
    if (args.task_path) {
        const tasks: Record<string, Record<string, unknown>> = JSON.parse(readFileSync(args.task_path, 'utf8'));
        if (args.task_id) {
            const selected = tasks[args.task_id];
            if (selected) {
                selected['task_id'] = args.task_id;
                settings.task = selected;
            }
            else {
                throw new ConfigError(args.task_path, [`找不到 task_id "${args.task_id}"`]);
            }
        }
        else {
            throw new ConfigError(args.task_path, ['提供了 task_path 就必须给 task_id']);
        }
    }

    if (process.env.SETTINGS_JSON) {
        const parsedSettings: unknown = JSON.parse(process.env.SETTINGS_JSON);
        if (parsedSettings == null || typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) {
            throw new ConfigError('$SETTINGS_JSON', ['必须是一个 JSON 对象']);
        }
        Object.assign(settings, parsedSettings);
    }

    // these environment variables override certain settings
    if (process.env.MINECRAFT_PORT) {
        settings.port = process.env.MINECRAFT_PORT;
    }
    if (process.env.MINDSERVER_PORT) {
        settings.mindserver_port = process.env.MINDSERVER_PORT;
    }
    if (process.env.PROFILES) {
        const parsedProfiles: unknown = JSON.parse(process.env.PROFILES);
        if (!Array.isArray(parsedProfiles)) {
            throw new ConfigError('$PROFILES', ['必须是 JSON 数组']);
        }
        if (parsedProfiles.length > 0) {
            settings.profiles = parsedProfiles.map(String);
        }
    }
    if (process.env.BLOCKED_ACTIONS) {
        const parsedBlocked: unknown = JSON.parse(process.env.BLOCKED_ACTIONS);
        if (!Array.isArray(parsedBlocked)) {
            throw new ConfigError('$BLOCKED_ACTIONS', ['必须是 JSON 数组']);
        }
        settings.blocked_actions = parsedBlocked.map(String);
    }
    // CLI 参数优先级最高，放在所有文件与环境变量之后。
    if (args.profiles) {
        settings.profiles = args.profiles;
    }
    if (args.mcHost) {
        settings.host = args.mcHost;
    }
    if (args.mcPort != null) {
        settings.port = args.mcPort;
    }
    if (settings.port == null) {
        settings.port = -1;
    }
    if (settings.profiles.length === 0) {
        throw new ConfigError('settings.profiles', ['没有配置任何 Bot。用 --profiles 指定 profile，或把路径写进 settings.ts 的 profiles。']);
    }

    // 供应商与凭据先过一遍校验：错在这里就该退出，而不是等每个 bot 起来再炸。
    loadProvidersConfig();
    loadAuthConfig();

    void Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);

    for (const profilePath of settings.profiles) {
        settings.profile = loadProfile(profilePath);
        // `createAgent` 在这里已经跑过一遍模型解析（端点、模型、凭据），失败就退出：
        // 让一个连不上模型的 bot 进程起来再死，只会变成重启循环。
        const created = await Mindcraft.createAgent(settings);
        if (!created.success) {
            throw new ConfigError(profilePath, [created.error ?? '创建 agent 失败']);
        }
    }
} catch (error: unknown) {
    if (error instanceof ConfigError) {
        console.error(`配置错误：\n${error.message}`);
        process.exit(1);
    }
    throw error;
}

/**
 * **MindServer 的底线：不许因为一个 bot 的异常把自己带走。**
 *
 * 2026-10-21 真机事故：用 `cli spawn` 开了一个 agent，几秒后把那个 bot 进程杀掉，
 * MindServer 整个退出——所有 `cli` 命令立刻 "xhr poll error"，两个正常运行的机器人一起失联。
 * 一个成员的故障升级成了全集群故障，代价完全没必要。
 *
 * 这里只兜**进程级**的漏网异常：记日志、继续服务。业务内的错误仍然要在各自 handler 里
 * try/catch 并回话（见 create-agent），不要把这条当成"错误不用处理"的借口。
 */
process.on('unhandledRejection', (reason: unknown) => {
    console.error('[MindServer] 未处理的 Promise rejection（继续运行）:', reason);
});
process.on('uncaughtException', (error: unknown) => {
    console.error('[MindServer] 未捕获异常（继续运行）:', error);
});
