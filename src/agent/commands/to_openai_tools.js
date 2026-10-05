import { actionsList } from './actions.js';
import { queryList } from './queries.js';

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (const command of commandList) {
    commandMap[command.name] = command;
}

/** '!goToPlayer' -> 'goToPlayer'（OpenAI tool 名不允许 ! 前缀） */
export function stripBang(name) {
    return String(name).startsWith('!') ? String(name).slice(1) : String(name);
}

/** '!xxx' 文本命令参数类型 -> JSON Schema 类型 */
function paramToSchema(param) {
    const desc = param.description || '';
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
 * 单个 !Command -> OpenAI function tool（non-strict，兼容 picking）。
 * 参数顺序按 Object.keys(command.params) 保持，与 executeCommand 一致。
 */
export function commandToTool(command) {
    const properties = {};
    const required = [];
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
 * 供 GPT/兼容模型的 chat.completions 调用。
 */
export function getOpenAITools(agent) {
    const blocked = agent?.blocked_actions || [];
    return commandList
        .filter((cmd) => !blocked.includes(cmd.name))
        .map(commandToTool);
}

/**
 * 执行一次原生工具调用，底层复用同一个 command.perform。
 * args 为对象，按 command.params 的 key 顺序展开为位置参数。
 */
export async function executeToolCall(agent, toolName, args = {}) {
    const commandName = toolName.startsWith('!') ? toolName : '!' + toolName;
    const command = commandMap[commandName];
    if (!command) {
        return `Unknown tool: ${toolName}.`;
    }
    const paramNames = command.params ? Object.keys(command.params) : [];
    const ordered = paramNames.map((k) => args[k]);
    try {
        const result = await command.perform(agent, ...ordered);
        return result ?? '';
    } catch (err) {
        return `Tool ${toolName} failed: ${err?.message ?? String(err)}`;
    }
}

/** 兼容检查：tool 名是否存在（不带 ! 也行） */
export function toolExists(toolName) {
    const commandName = toolName.startsWith('!') ? toolName : '!' + toolName;
    return commandMap[commandName] !== undefined;
}
