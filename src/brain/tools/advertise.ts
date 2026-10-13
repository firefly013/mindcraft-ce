/*
 * 旧的 OpenAI function-tool 广告形态：**声明 → JSON Schema**。
 *
 * 生产路径已经不用它了（pi-durable 用 `tool_schema.ts` 生成 TypeBox schema），
 * 但它是**可比对的参照物**：`tests/runtime_tools.test.ts` 拿它对每个工具逐字
 * 比对新旧 schema，`scripts/check-prompts.ts` 拿它核对提示词里的参数名。
 * 换句话说，它是"重构前后行为不变"的证据载体，别删。
 *
 * 输入是**声明**（`ToolDeclaration`），不是命令实现——大脑这一侧只有声明。
 */

import { td, tp } from '../../shared/prompts.js';
import type { OpenAITool } from '../../shared/types/common.js';
import { domainBounds, type ToolDeclaration, type ToolParamDef } from '../../shared/tools.js';

/** 命令参数类型 -> JSON Schema 类型；数值参数把 domain 的有限上下界也带出去。 */
function paramToSchema(param: ToolParamDef): Record<string, unknown> {
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
 * 单个工具声明 -> OpenAI function tool。
 * 参数顺序按 Object.keys(declaration.params) 保持，与旧文本解析一致。
 */
export function commandToTool(declaration: ToolDeclaration): OpenAITool {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (declaration.params) {
        for (const [name, param] of Object.entries(declaration.params)) {
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
            name: declaration.name,
            description: declaration.description || declaration.name,
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
 * 按 `blocked_actions` 过滤后，返回 OpenAI tools 数组。
 *
 * 过滤是**广告层**的：被隐藏的工具只要模型按名字直接调用就照样执行。
 * 真正的强制点在身体通道入口（见 `brain/tools/tools.ts::blockedActionsHook`）。
 *
 * 末尾追加 5 个控制工具（Finish/Stop/Say/UpdatePlan/Feedback）——它们
 * **不住在身体里**，所以不在声明表里。与旧 `getOpenAITools` 逐字一致。
 */
export function getOpenAITools(
    declarations: readonly ToolDeclaration[],
    blocked: readonly string[] = [],
): OpenAITool[] {
    const tools = declarations
        .filter((declaration) => !blocked.includes(declaration.name) && !blocked.includes(`!${declaration.name}`))
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
