import { actionsList } from './actions.js';
import type { AgentCommand, CommandParamDef } from './actions.js';
import { queryList } from './queries.js';
import { td, tp } from '../../prompts.js';
import type { OpenAITool } from '../../types/common.js';

const commandList: AgentCommand[] = queryList.concat(actionsList);
const commandMap: Record<string, AgentCommand> = {};
for (const command of commandList) {
    commandMap[command.name] = command;
}

/** '!goToPlayer' -> 'goToPlayer'（OpenAI tool 名不允许 ! 前缀） */
export function stripBang(name: string): string {
    return name.startsWith('!') ? name.slice(1) : name;
}

/** 命令参数类型 -> JSON Schema 类型 */
function paramToSchema(param: CommandParamDef): Record<string, string> {
    const desc = typeof param.description === 'string' ? param.description : '';
    switch (param.type) {
        case 'int':
            return { type: 'integer', description: desc };
        case 'float':
            return { type: 'number', description: desc };
        case 'boolean':
            return { type: 'boolean', description: desc };
        case 'BlockName':
        case 'ItemName':
        case 'BlockOrItemName':
        case 'string':
        default:
            return { type: 'string', description: desc };
    }
}

/**
 * 单个命令 -> OpenAI function tool。
 * 参数顺序按 Object.keys(command.params) 保持，与旧文本解析一致。
 */
export function commandToTool(command: AgentCommand): OpenAITool {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (command.params) {
        for (const [name, param] of Object.entries(command.params)) {
            properties[name] = paramToSchema(param);
            required.push(name);
        }
    }
    return {
        type: 'function',
        function: {
            name: stripBang(command.name),
            description: command.description || command.name,
            parameters: {
                type: 'object',
                properties,
                required,
                additionalProperties: false,
            },
        },
    };
}

/**
 * 按 blocked_actions 过滤后，返回 OpenAI tools 数组。
 * 末尾追加 Finish（结束本轮）与 Say（说话唯一通道）控制工具。
 */
export function getOpenAITools(agent: any): OpenAITool[] {
    const blocked = (agent?.blocked_actions || []) as string[];
    const tools = commandList
        .filter((cmd) => !blocked.includes(cmd.name))
        .map(commandToTool);
    tools.push({
        type: 'function',
        function: {
            name: 'Finish',
            description: td('Finish'),
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
    });
    tools.push({
        type: 'function',
        function: {
            name: 'Stop',
            description: td('Stop'),
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
    });
    tools.push({
        type: 'function',
        function: {
            name: 'Say',
            description: td('Say'),
            parameters: {
                type: 'object',
                properties: { text: { type: 'string', description: tp('Say', 'text') } },
                required: ['text'],
                additionalProperties: false,
            },
        },
    });
    tools.push({
        type: 'function',
        function: {
            name: 'UpdatePlan',
            description: td('UpdatePlan'),
            parameters: {
                type: 'object',
                properties: {
                    goal: { type: 'string', description: tp('UpdatePlan', 'goal') },
                    todos: { type: 'array', items: { type: 'string' }, description: tp('UpdatePlan', 'todos') },
                },
                required: [],
                additionalProperties: false,
            },
        },
    });
    return tools;
}

/**
 * 执行一次原生工具调用，底层复用同一个 command.perform。
 * args 为对象，按 command.params 的 key 顺序展开为位置参数。
 */
export async function executeToolCall(agent: any, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    if (toolName === 'Finish') return 'Finished.';
    const commandName = toolName.startsWith('!') ? toolName : '!' + toolName;
    const command = commandMap[commandName];
    if (!command) {
        return `Unknown tool: ${toolName}.`;
    }
    const paramNames = command.params ? Object.keys(command.params) : [];
    const ordered = paramNames.map((k) => args[k]);
    try {
        const result: unknown = await command.perform(agent, ...ordered);
        return (result as string | null | undefined) ?? '';
    } catch (err: unknown) {
        return `Tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}

/** UpdatePlan 形状校验：goal 可选字符串，todos 可选字符串数组（整单替换）。 */
export function validateUpdatePlan(args: unknown): ToolValidation {
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, code: 'BAD_ARGS', errors: ['$: expected object'] };
    }
    const given = args as Record<string, unknown>;
    const errors: string[] = [];
    for (const key of Object.keys(given)) {
        if (key !== 'goal' && key !== 'todos') errors.push(`$: unknown property '${key}'`);
    }
    if (given['goal'] !== undefined && given['goal'] !== null && typeof given['goal'] !== 'string') {
        errors.push('$.goal: expected string');
    }
    if (given['todos'] !== undefined && given['todos'] !== null) {
        if (!Array.isArray(given['todos']) || !(given['todos'] as unknown[]).every((t) => typeof t === 'string')) {
            errors.push('$.todos: expected string[]');
        }
    }
    if (errors.length > 0) return { ok: false, code: 'BAD_ARGS', errors };
    return { ok: true };
}

/** 兼容检查：tool 名是否存在（不带 ! 也行） */
export function toolExists(toolName: string): boolean {
    if (CONTROL_TOOLS.has(toolName)) return true;
    const commandName = toolName.startsWith('!') ? toolName : '!' + toolName;
    return commandMap[commandName] !== undefined;
}

export interface ToolValidation {
    ok: boolean;
    code?: 'UNKNOWN_TOOL' | 'BAD_ARGS';
    errors?: string[];
}

function checkParamType(type: string, value: unknown, path: string): string | null {
    switch (type) {
        case 'int':
            return Number.isInteger(value) ? null : `${path}: expected integer, got ${JSON.stringify(value)}`;
        case 'float':
            return typeof value === 'number' && Number.isFinite(value)
                ? null
                : `${path}: expected number, got ${JSON.stringify(value)}`;
        case 'boolean':
            return typeof value === 'boolean' ? null : `${path}: expected boolean, got ${JSON.stringify(value)}`;
        default:
            // string / BlockName / ItemName / BlockOrItemName 都是字符串
            return typeof value === 'string' ? null : `${path}: expected string, got ${JSON.stringify(value)}`;
    }
}

/**
 * 严格校验一次工具调用：未知工具、未知参数、缺必填、类型不对
 * 都变成带路径的 verdict，而不是抛错。null 视为"没给"：
 * 有 optional/default 的可缺，否则按缺失算。
 */
export function validateToolCall(toolName: string, args: unknown): ToolValidation {
    if (toolName === 'Finish' || toolName === 'Stop' || toolName === 'Say') return { ok: true };
    if (toolName === 'UpdatePlan') return validateUpdatePlan(args);
    const commandName = toolName.startsWith('!') ? toolName : '!' + toolName;
    const command = commandMap[commandName];
    if (!command) return { ok: false, code: 'UNKNOWN_TOOL', errors: [`No such tool: ${toolName}.`] };
    if (args == null || typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, code: 'BAD_ARGS', errors: [`$: expected object, got ${Array.isArray(args) ? 'array' : typeof args}`] };
    }
    const params = command.params ?? {};
    const given = args as Record<string, unknown>;
    const errors: string[] = [];
    for (const key of Object.keys(given)) {
        if (!(key in params)) errors.push(`$: unknown property '${key}'`);
    }
    for (const [name, def] of Object.entries(params)) {
        const value = given[name];
        const canOmit = def.optional === true || def.default !== undefined;
        if (value === undefined || value === null) {
            if (!canOmit) errors.push(`$: missing required property '${name}'`);
            continue;
        }
        const bad = checkParamType(def.type, value, `$.${name}`);
        if (bad) errors.push(bad);
    }
    if (errors.length > 0) return { ok: false, code: 'BAD_ARGS', errors };
    return { ok: true };
}

const actionNames = new Set(actionsList.map((c) => stripBang(c.name)));

/** 控制类工具（循环/说话/计划/机器人命令），走注册 handler，不占身体通道。 */
const CONTROL_TOOLS = new Set(['Finish', 'Stop', 'Say', 'UpdatePlan']);
/**
 * 该工具是否占用身体动作通道。动作类工具一次只能跑一个
 * （忙时拒绝，不排队）；查询类只读不占；控制类走 handler。
 */
export function isActionTool(toolName: string): boolean {
    const base = stripBang(toolName);
    if (CONTROL_TOOLS.has(base)) return false;
    return actionNames.has(base);
}

/** 游戏内单行聊天上限：超长截断（记录仍保留全文）。 */
export const SAY_LINE_LIMIT = 240;

/**
 * Say 文案整形（纯函数）：空话拒绝，超长截断。
 * 说话走 handler 发出，这里只定形状。
 */
export function formatSay(text: unknown): { ok: boolean; line?: string; full?: string; reason?: string } {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, reason: 'Say text must be non-empty.' };
    }
    const chars = Array.from(text);
    const line = chars.length > SAY_LINE_LIMIT ? `${chars.slice(0, SAY_LINE_LIMIT).join('')}…` : text;
    return { ok: true, line, full: text };
}

/** 给 help 工具用的人类可读工具清单（替代旧文本命令文档） */
export function getToolDocs(agent: any): string {
    const blocked = (agent?.blocked_actions || []) as string[];
    let docs = 'Native tools. Call them via function calling with a JSON arguments object.\n';
    for (const command of commandList) {
        if (blocked.includes(command.name)) continue;
        docs += `${stripBang(command.name)}: ${command.description || ''}\n`;
        if (command.params) {
            for (const param in command.params) {
                docs += `  ${param}: ${command.params[param]?.description || ''}\n`;
            }
        }
    }
    // 控制类工具不在 commandList 里，单独列出（与 getOpenAITools 追加的一致）。
    for (const name of ['Finish', 'Stop', 'Say', 'UpdatePlan']) {
        docs += `${name}: ${td(name)}\n`;
    }
    return docs;
}
