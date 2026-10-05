import * as Mindcraft from './src/mindcraft/mindcraft.js';
import settings from './settings.js';
import type { Settings } from './src/types/common.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync } from 'fs';

export interface MainArgs {
    profiles?: string[];
    task_path?: string;
    task_id?: string;
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
        .help()
        .alias('help', 'h')
        .parseSync();
    return {
        profiles: parsed.profiles?.map(String),
        task_path: parsed.task_path,
        task_id: parsed.task_id,
    };
}
const args = parseArguments();
if (args.profiles) {
    settings.profiles = args.profiles;
}
if (args.task_path) {
    const tasks: Record<string, Record<string, unknown>> = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        const selected = tasks[args.task_id];
        if (selected) {
            selected['task_id'] = args.task_id;
            settings.task = selected;
        }
        else {
            throw new Error(`task_id "${args.task_id}" not found in ${args.task_path}`);
        }
    }
    else {
        throw new Error('task_id is required when task_path is provided');
    }
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
    if (Array.isArray(parsedProfiles) && parsedProfiles.length > 0) {
        settings.profiles = parsedProfiles.map(String);
    }
}
if (process.env.BLOCKED_ACTIONS) {
    const parsedBlocked: unknown = JSON.parse(process.env.BLOCKED_ACTIONS);
    if (Array.isArray(parsedBlocked)) {
        settings.blocked_actions = parsedBlocked.map(String);
    }
}
if (process.env.MAX_MESSAGES) {
    const parsedMax = Number(process.env.MAX_MESSAGES);
    if (!Number.isNaN(parsedMax)) {
        settings.max_messages = parsedMax;
    }
}
if (process.env.LOG_ALL) {
    settings.log_all_prompts = process.env.LOG_ALL;
}
if (process.env.SETTINGS_JSON) {
    try {
        const parsedSettings: unknown = JSON.parse(process.env.SETTINGS_JSON);
        if (typeof parsedSettings === 'object' && parsedSettings !== null) {
            Object.assign(settings, parsedSettings);
        }
    } catch (err) {
        console.error("Failed to parse environment variable for SETTINGS_JSON:", err);
    }
}


void Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);

for (const profile of settings.profiles) {
    const profile_json: unknown = JSON.parse(readFileSync(profile, 'utf8'));
    settings.profile = profile_json as Settings['profile'];
    void Mindcraft.createAgent(settings);
}
