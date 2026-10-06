/**
 * P4：命令 → pi-durable 工具的等价性。
 *
 * 最强的一条是 `schema 等价`：对 `queryList.concat(actionsList)` 里的**每一个**
 * 命令，把 TypeBox 生成的 schema 与旧 `commandToTool()` 的输出逐字段比对。
 * 只要有一个参数的类型/范围/必填性漂了，这条就会红。
 */
import { describe, expect, it } from 'vitest';
import type { AgentCommand } from '../src/agent/commands/actions.js';
import { actionsList } from '../src/agent/commands/actions.js';
import { queryList } from '../src/agent/commands/queries.js';
import { commandToTool, getOpenAITools } from '../src/agent/commands/to_openai_tools.js';
import { commandParameters } from '../src/runtime/tool_schema.js';
import { blockedActionsHook, commandToRegistration, outcomeText } from '../src/runtime/tools.js';

/** 与 `to_openai_tools.ts` 内部用的同一个列表。 */
const ALL_COMMANDS: AgentCommand[] = queryList.concat(actionsList);

/** TypeBox schema → 纯 JSON（丢掉 [Kind] 之类的 symbol，便于比对）。 */
function toJson(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

/**
 * JSON Schema 语义归一：`required` **缺失**与 `required: []` 等价（都表示没有
 * 必填参数）。TypeBox 在空参数时不发 `required`，旧实现发 `[]`——这是两边
 * **唯一**的差异类别（下面有一条专门钉住它）。
 *
 * 这个归一不会放过真正的漂移：若新实现把某个非空 `required` 漏掉，归一后是
 * `[]` 而旧的是非空数组，比对照样失败。
 */
function normalizeRequired(schema: unknown): unknown {
  const out = structuredClone(schema) as Record<string, unknown>;
  if (out['type'] === 'object' && out['required'] === undefined) out['required'] = [];
  return out;
}

describe('schema 等价：全部命令工具', () => {
  it('命令集合与旧广告同源（不写死数字）', () => {
    // 别写死数量：工具集会随死子系统清理而变化（construction 下线时一次就
    // 少了 4 个 blueprint 工具）。断言"非空 + 与旧广告逐项同源"——写死的
    // 数字只会腐坏，测不出真问题。
    expect(ALL_COMMANDS.length).toBeGreaterThan(0);
    const advertised = getOpenAITools({}).map((tool) => tool.function.name);
    const control = ['Finish', 'Stop', 'Say', 'UpdatePlan', 'Feedback'];
    expect(ALL_COMMANDS.map((command) => command.name.replace(/^!/, ''))).toEqual(
      advertised.filter((name) => !control.includes(name)),
    );
  });

  it.each(ALL_COMMANDS.map((command) => [command.name, command] as const))(
    '%s 的 TypeBox schema 与旧 JSON Schema 语义一致',
    (_name, command) => {
      const oldParameters = commandToTool(command).function.parameters;
      const nextParameters = toJson(commandParameters(command));
      expect(normalizeRequired(nextParameters)).toEqual(normalizeRequired(oldParameters));
    },
  );

  it('原始差异只允许"空 required 缺省"这一类，别的漂移一律不许有', () => {
    for (const command of ALL_COMMANDS) {
      const oldRaw = commandToTool(command).function.parameters as Record<string, unknown>;
      const newRaw = toJson(commandParameters(command)) as Record<string, unknown>;
      const oldKeys = Object.keys(oldRaw).sort();
      const newKeys = Object.keys(newRaw).sort();
      if (oldKeys.join('|') === newKeys.join('|')) continue;
      // 唯一允许的差异：新实现少一个**空**的 required
      expect(oldKeys.filter((key) => !newKeys.includes(key))).toEqual(['required']);
      expect(oldRaw['required']).toEqual([]);
    }
  });

  it('每个命令的 required 判定与旧实现一致（optional / default 不进 required）', () => {
    for (const command of ALL_COMMANDS) {
      const oldRequired = commandToTool(command).function.parameters['required'];
      const next = commandParameters(command) as unknown as { required?: string[] };
      expect(next.required ?? []).toEqual(oldRequired);
    }
  });
});

describe('工具注册项', () => {
  const demo: AgentCommand = {
    name: '!demo',
    description: '演示命令',
    params: {
      a: { type: 'int', description: 'A', domain: [1, 10] },
      b: { type: 'float', description: 'B', optional: true },
      c: { type: 'string', description: 'C' },
    },
    perform: () => 'never-called',
  };

  it('工具名去掉 ! 前缀', () => {
    const tool = commandToRegistration(demo, () => '');
    expect(tool.name).toBe('demo');
    expect(tool.description).toBe('演示命令');
  });

  it('位置参数按 params 的 key 顺序传入，null 归一为 undefined', async () => {
    let seen: unknown[] = [];
    const tool = commandToRegistration(demo, (_command, ordered) => {
      seen = ordered;
      return 'ok';
    });

    await tool.execute({ a: 3, b: null, c: 'x' } as never, {} as never, {} as never);
    expect(seen).toEqual([3, undefined, 'x']);

    // 缺参同样是 undefined（JS 默认参数才有机会生效）
    await tool.execute({ a: 1 } as never, {} as never, {} as never);
    expect(seen).toEqual([1, undefined, undefined]);
  });

  it('回执文本走 outcomeText', async () => {
    const tool = commandToRegistration(demo, () => ({ hits: 2 }));
    const result = await tool.execute({ a: 1 } as never, {} as never, {} as never);
    expect(result.content).toEqual([{ type: 'text', text: '{"hits":2}' }]);
  });

  it('实现抛错会冒泡（由 pi-durable 的 ToolTask 转成 error result）', async () => {
    const tool = commandToRegistration(demo, () => {
      throw new Error('boom');
    });
    await expect(tool.execute({ a: 1 } as never, {} as never, {} as never)).rejects.toThrow('boom');
  });
});

describe('outcomeText', () => {
  it('与 Agent.outcomeText 语义一致', () => {
    expect(outcomeText(null)).toBe('(no output)');
    expect(outcomeText(undefined)).toBe('(no output)');
    expect(outcomeText('')).toBe('(no output)');
    expect(outcomeText('hello')).toBe('hello');
    expect(outcomeText(0)).toBe('0');
    expect(outcomeText({ a: 1 })).toBe('{"a":1}');
  });

  it('循环引用退回 String()，不抛', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(outcomeText(circular)).toBe('[object Object]');
  });
});

describe('blocked_actions 强制点', () => {
  type BeforeTool = (call: { name: string }) => { block?: string } | undefined;

  function hookHandler(blocked: string[]): BeforeTool {
    const registration = blockedActionsHook(() => blocked);
    return (registration.handlers as unknown as { beforeTool: BeforeTool }).beforeTool;
  }

  it('带 ! 的名单能拦住去前缀后的工具名（旧实现拦不住）', () => {
    const beforeTool = hookHandler(['!checkBlueprint', '!getBlueprint']);
    expect(beforeTool({ name: 'checkBlueprint' })?.block).toContain('checkBlueprint');
    expect(beforeTool({ name: 'getBlueprint' })?.block).toBeTruthy();
  });

  it('不带 ! 的名单同样能拦', () => {
    const beforeTool = hookHandler(['stats']);
    expect(beforeTool({ name: 'stats' })?.block).toBeTruthy();
  });

  it('未禁用的工具放行', () => {
    const beforeTool = hookHandler(['!checkBlueprint']);
    expect(beforeTool({ name: 'goToPlayer' })).toBeUndefined();
    expect(beforeTool({ name: 'Say' })).toBeUndefined();
  });

  it('名单为空时全部放行', () => {
    const beforeTool = hookHandler([]);
    expect(beforeTool({ name: 'anything' })).toBeUndefined();
  });
});
