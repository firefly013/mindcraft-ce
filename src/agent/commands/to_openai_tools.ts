import { actionsList } from './actions.js';
import type { AgentCommand, CommandParamDef } from './actions.js';
import { queryList } from './queries.js';
import { td, tp } from '../../prompts.js';
import { validateFeedback as validateFeedbackArgs } from '../feedback.js';
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

/** domain 形如 [min, max] 或 [min, max, '[)']；第三项是区间括号，缺省两端闭。 */
function domainBounds(param: CommandParamDef): {
    min: number | null;
    max: number | null;
    minExclusive: boolean;
    maxExclusive: boolean;
} | null {
    const domain = param.domain;
    if (!Array.isArray(domain) || domain.length < 2) return null;
    const min = typeof domain[0] === 'number' ? domain[0] : null;
    const max = typeof domain[1] === 'number' ? domain[1] : null;
    if (min == null && max == null) return null;
    const brackets = typeof domain[2] === 'string' ? domain[2] : '[]';
    return { min, max, minExclusive: brackets.startsWith('('), maxExclusive: brackets.endsWith(')') };
}

/**
 * 数值参数的范围校验。domain 以前只写在命令定义里、既不进 schema
 * 也不校验，模型给个 -64 之外的 y 也照跑。这里按区间括号语义检查。
 */
export function checkDomain(param: CommandParamDef, value: number, path: string): string | null {
    const b = domainBounds(param);
    if (b == null) return null;
    if (b.min != null && (b.minExclusive ? value <= b.min : value < b.min)) {
        return `${path}: expected ${b.minExclusive ? '>' : '>='} ${b.min}, got ${value}`;
    }
    if (b.max != null && (b.maxExclusive ? value >= b.max : value > b.max)) {
        return `${path}: expected ${b.maxExclusive ? '<' : '<='} ${b.max}, got ${value}`;
    }
    return null;
}

/** 命令参数类型 -> JSON Schema 类型；数值参数把 domain 的有限上下界也带出去。 */
function paramToSchema(param: CommandParamDef): Record<string, unknown> {
    const desc = typeof param.description === 'string' ? param.description : '';
    let schema: Record<string, unknown>;
    switch (param.type) {
        case 'int':
            schema = { type: 'integer', description: desc };
            break;
        case 'float':
            schema = { type: 'number', description: desc };
            break;
        case 'boolean':
            return { type: 'boolean', description: desc };
        case 'BlockName':
        case 'ItemName':
        case 'BlockOrItemName':
        case 'string':
        default:
            return { type: 'string', description: desc };
    }
    const b = domainBounds(param);
    // JSON Schema 的 minimum/maximum 是**闭**语义，而 domain 支持开区间
    // （第三项 '[)' / '(]'）。开的那一端必须用 exclusiveMinimum/Maximum 表达，
    // 否则广告给模型的区间比 checkDomain 实际放行的更宽：模型给 0 是"合法"，
    // 到了校验器却被拒。
    if (b?.min != null && Number.isFinite(b.min)) {
        if (b.minExclusive) schema['exclusiveMinimum'] = b.min;
        else schema['minimum'] = b.min;
    }
    if (b?.max != null && Number.isFinite(b.max)) {
        if (b.maxExclusive) schema['exclusiveMaximum'] = b.max;
        else schema['maximum'] = b.max;
    }
    return schema;
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
            // 声明了 optional / default 的参数不能进 required：校验器的
            // canOmit = optional===true || default!==undefined 会放行，
            // 而 schema 说必填就是"广告比校验更严"（例如 getCraftingPlan.quantity）。
            if (param.optional !== true && param.default === undefined) required.push(name);
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
 * 末尾追加 5 个控制工具：Finish/Stop/Say/UpdatePlan/Feedback（名单见 CONTROL_TOOLS）。
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
                    todos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                text: { type: 'string', description: '待办内容。' },
                                done: { type: 'boolean', description: '是否已完成。' },
                            },
                            required: ['text'],
                            additionalProperties: false,
                        },
                        description: tp('UpdatePlan', 'todos'),
                    },
                },
                required: [],
                additionalProperties: false,
            },
        },
    });
    tools.push({
        type: 'function',
        function: {
            name: 'Feedback',
            description: td('Feedback'),
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: tp('Feedback', 'title') },
                    body: { type: 'string', description: tp('Feedback', 'body') },
                },
                required: ['title', 'body'],
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
    // 校验器把 `null` 当"没给"（canOmit 收 null），但 JS 的默认参数只对
    // `undefined` 生效——不在这里归一，`{quantity: null}` 就会把 null 原样
    // 传给 `perform(agent, targetItem, quantity = 1)`，拿不到默认值。
    const ordered = paramNames.map((k) => args[k] ?? undefined);
    try {
        const result: unknown = await command.perform(agent, ...ordered);
        return (result as string | null | undefined) ?? '';
    } catch (err: unknown) {
        return `Tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
}

/** UpdatePlan 形状校验：goal 可选字符串，todos 可选 {text,done}[]（整单替换）。
 *  注意这里比 JSON Schema **更宽松**（收纯字符串、done 可省，按未完成折算）：
 *  schema 是给模型看的严格形式，校验器负责兼容旧格式，二者故意不一致。 */
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
        const todos = given['todos'];
        if (!Array.isArray(todos)) {
            errors.push('$.todos: expected array');
        } else {
            todos.forEach((todo, i) => {
                const path = `$.todos[${i}]`;
                // 旧格式（纯字符串）仍然收，按未完成折算。
                if (typeof todo === 'string') return;
                if (todo == null || typeof todo !== 'object' || Array.isArray(todo)) {
                    errors.push(`${path}: expected object {text,done}`);
                    return;
                }
                const entry = todo as Record<string, unknown>;
                for (const key of Object.keys(entry)) {
                    if (key !== 'text' && key !== 'done') errors.push(`${path}: unknown property '${key}'`);
                }
                if (typeof entry['text'] !== 'string' || entry['text'].trim() === '') {
                    errors.push(`${path}.text: expected non-empty string`);
                }
                if (entry['done'] !== undefined && typeof entry['done'] !== 'boolean') {
                    errors.push(`${path}.done: expected boolean`);
                }
            });
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
/** Feedback 形状校验：title/body 必填非空字符串（错误带路径）。 */
export function validateFeedback(args: unknown): ToolValidation {
    const checked = validateFeedbackArgs(args);
    if (checked.ok) return { ok: true };
    return { ok: false, code: 'BAD_ARGS', errors: checked.errors };
}

export function validateToolCall(toolName: string, args: unknown): ToolValidation {
    if (toolName === 'Finish' || toolName === 'Stop' || toolName === 'Say') return { ok: true };
    if (toolName === 'UpdatePlan') return validateUpdatePlan(args);
    if (toolName === 'Feedback') return validateFeedback(args);
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
        else if (typeof value === 'number') {
            // 类型对了还要在 domain 范围内：[-64,320] 这类约束以前形同虚设。
            const outOfRange = checkDomain(def, value, `$.${name}`);
            if (outOfRange) errors.push(outOfRange);
        }
    }
    if (errors.length > 0) return { ok: false, code: 'BAD_ARGS', errors };
    return { ok: true };
}

const actionNames = new Set(actionsList.map((c) => stripBang(c.name)));

/** 控制类工具（循环/说话/计划/反馈），走注册 handler，不占身体通道。 */
export const CONTROL_TOOLS = new Set(['Finish', 'Stop', 'Say', 'UpdatePlan', 'Feedback']);
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

