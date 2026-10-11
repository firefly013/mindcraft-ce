/**
 * steer 与 followUp 的**决定性差异**（实测，非推测）。
 *
 * 现在的运行时是**自然的 ReAct 工具循环**（不挂 `control.terminate`、没有
 * `Finish`），所以这里是常态下的行为：
 *
 *   steer    → 2 次调用：第 1 次请求 ["开始干活"]   第 2 次请求 ["开始干活","插进来"]
 *   followUp → 3 次调用：第 1 次请求 ["开始干活"]   第 2 次请求 ["开始干活"] ← 没带上
 *                       第 3 次请求 ["开始干活","插进来"]
 *
 * `steer` 插到当前工具轮之后、**加入正在跑的 run**，省一次往返；`followUp` 要等
 * 这一轮先答完、run 结束后再开新 run，所以多一次模型调用。
 *
 * 历史结论（已不适用，但值得记住）：曾经给每个工具挂 `control.terminate` 时，
 * run 在工具轮后立刻结束，`steer` 没有"正在进行的工作"可以加入，于是**退化成
 * followUp**，两者观测上完全一致。那正是拆掉 terminate 的动机之一。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineTool } from '@earendil-works/pi-durable';
import type { ResolvedProvider } from '../src/runtime/provider.js';
import { openBotRuntime } from '../src/runtime/runtime.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-svf-'));
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
      /* Windows 句柄 */
    }
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Measured {
  callCount: number;
  /** 每次模型请求里所有 user 消息的正文。 */
  requestUsers: string[][];
  /** assistant entry 的 generation task id；同一 run 相同，新 run 不同。 */
  taskIds: string[];
}

/** 把 run 钉在"在途"状态（慢工具等外部放行），再插一条 steer / followUp。 */
async function measure(mode: 'steer' | 'followUp'): Promise<Measured> {
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
    contextWindow: model.contextWindow,
  };

  const gate = deferred();
  const started = deferred();
  const Slow = defineTool({
    name: 'Slow',
    description: '慢工具',
    parameters: Type.Object({}),
    execute: () => {
      started.resolve();
      return gate.promise.then(() => ({ content: [{ type: 'text' as const, text: 'slow done' }] }));
    },
  });

  const requestUsers: string[][] = [];
  const step = (context: { messages: unknown }): ReturnType<typeof fauxAssistantMessage> => {
    requestUsers.push(
      (context.messages as Array<Record<string, unknown>>)
        .filter((message) => message['role'] === 'user')
        .map((message) => (typeof message['content'] === 'string' ? message['content'] : '')),
    );
    if (requestUsers.length === 1) {
      return fauxAssistantMessage([fauxToolCall('Slow', {})], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('后续轮次');
  };
  faux.setResponses([step, step, step, step]);

  const runtime = await openBotRuntime({
    name: 'tester',
    provider,
    baseDir: tempDir(),
    systemPrompt: () => 'SYS',
    liveTail: () => '',
    tools: [Slow],
  });

  const first = await runtime.submit('开始干活');
  const firstDone = first.wait(ctx);
  await started.promise;
  const second = await runtime.submit('插进来', { whenBusy: mode });
  const secondDone = second.wait(ctx);

  gate.resolve();
  await firstDone;
  await secondDone;

  const page = await runtime.conversation.entries({}, 50, undefined, ctx);
  const taskIds = page.items
    .filter((entry) => entry.kind === 'pi.assistant')
    .map((entry) => String(entry.byTaskId));

  await runtime.close();
  return { callCount: faux.state.callCount, requestUsers, taskIds };
}

describe('steer：插进当前 run，省一次往返', () => {
  it('第 2 次请求就带上了', async () => {
    const r = await measure('steer');
    expect(r.callCount).toBe(2);
    expect(r.requestUsers[1]).toEqual(['开始干活', '插进来']);
    expect(r.taskIds).toHaveLength(2);
  });
});

describe('followUp：等本轮答完，多一次往返', () => {
  it('第 2 次请求**不带**它，第 3 次才带', async () => {
    const r = await measure('followUp');
    expect(r.callCount).toBe(3);
    expect(r.requestUsers[1]).toEqual(['开始干活']);
    expect(r.requestUsers[2]).toEqual(['开始干活', '插进来']);
    expect(r.taskIds).toHaveLength(3);
  });
});
