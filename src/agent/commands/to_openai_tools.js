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

/** 命令参数类型 -> JSON Schema 类型 */
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
 * 单个命令 -> OpenAI function tool。
 * 参数顺序按 Object.keys(command.params) 保持，与旧文本解析一致。
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
 * 末尾追加 Finish 控制工具：当前工作完成时调用它结束本轮推理。
 */
export function getOpenAITools(agent) {
    const blocked = agent?.blocked_actions || [];
    const tools = commandList
        .filter((cmd) => !blocked.includes(cmd.name))
        .map(commandToTool);
    tools.push({
        type: 'function',
        function: {
            name: 'Finish',
            description: '当前工作完成时调用，结束本轮推理循环。正在执行的动作不受影响。',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        },
    });
    return tools;
}

/**
 * 执行一次原生工具调用，底层复用同一个 command.perform。
 * args 为对象，按 command.params 的 key 顺序展开为位置参数。
 */
export async function executeToolCall(agent, toolName, args = {}) {
    if (toolName === 'Finish') return 'Finished.';
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

/** 给 help 工具用的人类可读工具清单（替代旧文本命令文档） */
export function getToolDocs(agent) {
    const blocked = agent?.blocked_actions || [];
    let docs = 'Native tools. Call them via function calling with a JSON arguments object.\n';
    for (const command of commandList) {
        if (blocked.includes(command.name)) continue;
        docs += `${stripBang(command.name)}: ${command.description || ''}\n`;
        if (command.params) {
            for (const param in command.params) {
                docs += `  ${param}: ${command.params[param].description || ''}\n`;
            }
        }
    }
    return docs;
}
