/**
 * P4：5 个控制工具的等价性与行为。
 *
 * 关键一条是**集成**验证：`UpdateGoal` 走 pi-durable 的 ToolTask，
 * 必须证明 `prepareArguments` 真的被调用、apply 收到的是目标字符串。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { PlanSnapshot } from '../src/brain/plan.js';
import { getOpenAITools } from '../src/brain/tools/advertise.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import {
  createFeedbackTool,
  createStopTool,
  createUpdateGoalTool,
  normalizeUpdateGoalArguments,
} from '../src/brain/tools/control_tools.js';
import { createSayTool } from '../src/brain/runtime/loop.js';
import type { ResolvedProvider } from '../src/brain/runtime/provider.js';
import { openBotRuntime } from '../src/brain/runtime/runtime.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ctl-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir == null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上句柄可能还没释放
    }
  }
});

/** JSON Schema 语义归一：`required` 缺失与 `[]` 等价。 */
function toJson(schema: unknown): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  if (out['type'] === 'object' && out['required'] === undefined) out['required'] = [];
  return out;
}

const emptyPlan = (): PlanSnapshot => ({ goal: null });

function buildControlTools() {
  // 只有 4 个：`Finish` 已按决策移除（自然的 ReAct 循环里"不再调工具"就是收尾），
  // 旧的 `getOpenAITools` 仍然广告它——那条差异由下面的测试显式记录。
  return [
    createStopTool(() => undefined),
    createSayTool(),
    createUpdateGoalTool(emptyPlan),
    createFeedbackTool({ dir: () => '', plan: () => null, historyTail: () => [] }),
  ];
}

describe('控制工具与旧广告一致', () => {
  const oldTools = new Map(getOpenAITools(toolDeclarations()).map((tool) => [tool.function.name, tool.function]));

  it('旧广告里有 5 个控制工具，我们只实现 4 个（Finish 已移除）', () => {
    for (const name of ['Finish', 'Stop', 'Say', 'UpdateGoal', 'Feedback']) {
      expect(oldTools.has(name)).toBe(true);
    }
    const implemented = buildControlTools().map((tool) => tool.name);
    expect(implemented).toEqual(['Stop', 'Say', 'UpdateGoal', 'Feedback']);
    expect(implemented).not.toContain('Finish');
  });

  it.each(buildControlTools().map((tool) => [tool.name, tool] as const))(
    '%s 的描述与 schema 与旧 getOpenAITools 一致',
    (_name, tool) => {
      const old = oldTools.get(tool.name);
      expect(old).toBeDefined();
      expect(tool.description).toBe(old?.description);
      expect(toJson(tool.parameters)).toEqual(toJson(old?.parameters));
    },
  );
});

describe('Stop', () => {
  it('调用 onStop 并回 {stopped:true}', async () => {
    let stopped = 0;
    const tool = createStopTool(() => {
      stopped += 1;
    });
    const result = await tool.execute({} as never, {} as never, {} as never);
    expect(stopped).toBe(1);
    expect(result.content).toEqual([{ type: 'text', text: '{"stopped":true}' }]);
  });
});

describe('UpdateGoal 行为', () => {
  it('多余键原样透传，交给 validateUpdateGoal 报错（不静默吞掉）', () => {
    expect(normalizeUpdateGoalArguments({ goal: 'g', bogus: 1 })).toEqual({ goal: 'g', bogus: 1 });
  });

  it('prepareArguments + execute 配对：apply 收到目标字符串', async () => {
    let applied: string | null | undefined | undefined;
    const tool = createUpdateGoalTool((goal) => {
      applied = goal;
      return { goal: goal ?? null };
    });
    const prepared = tool.prepareArguments?.({ goal: '造房子' });
    const result = await tool.execute(prepared as never, {} as never, {} as never);
    expect(applied).toBe('造房子');
    expect(result.content).toEqual([{ type: 'text', text: '目标已经更新，现在的目标是 造房子。' }]);
  });

  it('旧字段 todos 现在按未知属性拒绝', async () => {
    const tool = createUpdateGoalTool(emptyPlan);
    const result = await tool.execute({ goal: 'g', todos: ['砍树'] } as never, {} as never, {} as never);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("unknown property 'todos'");
  });

  it('非法入参回 isError，不调用 apply', async () => {
    let called = false;
    const tool = createUpdateGoalTool(() => {
      called = true;
      return emptyPlan();
    });
    const result = await tool.execute({ bogus: 1 } as never, {} as never, {} as never);
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('unknown property');
  });
});

describe('UpdateGoal 走真实 ToolTask（证明 prepareArguments 被调用）', () => {
  it('模型给的 goal 原样进入 apply', async () => {
    const faux = fauxProvider({ models: [{ id: 'mc-test' }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel('mc-test') ?? faux.getModel();
    const provider: ResolvedProvider = {
      models,
      model,
      providerId: faux.provider.id,
      apiKey: undefined,
      headers: null,
      params: {},
      contextWindow: model.contextWindow,
    };

    const applied: Array<string | null | undefined> = [];
    const updateGoal = createUpdateGoalTool((goal) => {
      applied.push(goal);
      return emptyPlan();
    });

    const runtime = await openBotRuntime({
      name: 'tester',
      provider,
      baseDir: tempDir(),
      systemPrompt: () => 'SYS',
      liveTail: () => '',
      tools: [updateGoal],
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('UpdateGoal', { goal: '挖矿' })], {
        stopReason: 'toolUse',
      }),
    ]);
    await (await runtime.submit('定个目标')).wait(ctx);

    expect(applied).toEqual(['挖矿']);
    await runtime.close();
  });
});

describe('Feedback', () => {
  it('成功落盘并回提示', async () => {
    const dir = tempDir();
    const tool = createFeedbackTool({
      dir: () => dir,
      plan: () => ({ goal: '造房子' }),
      historyTail: () => [{ role: 'user', content: '你好' }],
    });
    const result = await tool.execute(
      { title: '标题', body: '正文' } as never,
      {} as never,
      {} as never,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain('反馈已经记录到');

    const lines = readFileSync(join(dir, 'feedback.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['title']).toBe('标题');
    expect(entry['body']).toBe('正文');
    expect(entry['plan']).toEqual({ goal: '造房子' });
    expect(entry['recent']).toEqual([{ role: 'user', summary: '你好' }]);
  });

  it('空 title/body 被拒', async () => {
    const tool = createFeedbackTool({ dir: () => tempDir(), plan: () => null, historyTail: () => [] });
    const result = await tool.execute({ title: ' ', body: 'x' } as never, {} as never, {} as never);
    expect(result.isError).toBe(true);
  });

  it('写失败显式回 isError（意见不能被悄悄吞掉）', async () => {
    const tool = createFeedbackTool({
      dir: () => join(tempDir(), '不存在的子目录'),
      plan: () => null,
      historyTail: () => [],
    });
    const result = await tool.execute({ title: 't', body: 'b' } as never, {} as never, {} as never);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('rejected');
  });
});
