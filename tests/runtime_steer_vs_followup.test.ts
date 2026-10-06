/**
 * steer 与 followUp 的**决定性差异**（实测，非推测）。
 *
 * | 配置 | 调用次数 | 第 2 次请求 | 第 3 次请求 |
 * |---|---|---|---|
 * | 无 terminate + steer    | 2 | 已带上 | — |
 * | 无 terminate + followUp | 3 | **没带上** | 已带上 |
 * | 有 terminate + steer    | 2 | 已带上 | — |
 * | 有 terminate + followUp | 2 | 已带上 | — |
 *
 * 结论两条：
 *  1. **常态下**（不挂 terminate）：`steer` 插到当前工具轮之后、**加入正在跑的
 *     run**，省一次往返；`followUp` 要等这一轮先答完、run 结束后再开新 run，
 *     所以多一次模型调用。
 *  2. **本项目当前给每个工具都挂了 `control.terminate`**，run 在工具轮后立刻
 *     结束，`steer` 没有"正在进行的工作"可以加入，于是**退化成 followUp**——
 *     两者观测上完全一致。所以在这套设定下，L3 选哪个都没有区别。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  type Conversation,
} from '@earendil-works/pi-durable';
import type { ResolvedProvider } from '../src/runtime/provider.js';
import { openBotRuntime } from '../src/runtime/runtime.js';
import { openBotSession } from '../src/runtime/session.js';

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

/**
 * @param terminate 工具是否挂 `control.terminate`
 *   （`openBotRuntime` 会强制挂；false 时走裸 session）
 */
async function measure(
  terminate: boolean,
  mode: 'steer' | 'followUp',
): Promise<Measured> {
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
  const raw = defineTool({
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

  let conversation: Conversation;
  let close: () => Promise<void>;

  if (terminate) {
    const runtime = await openBotRuntime({
      name: 'tester',
      provider,
      baseDir: tempDir(),
      systemPrompt: () => 'SYS',
      liveTail: () => '',
      tools: [raw],
    });
    conversation = runtime.conversation;
    close = () => runtime.close();
  } else {
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'probe', tools: [raw] }));
    const session = await openBotSession({
      name: 'tester',
      models,
      registry,
      model: { provider: model.provider, modelId: model.id },
      baseDir: tempDir(),
    });
    conversation = session.conversation;
    close = () => session.close();
  }

  const first = await conversation.submit({ type: 'input', content: '开始干活' }, ctx);
  const firstDone = first.wait(ctx);
  await started.promise;
  const second = await conversation.submit(
    { type: 'input', content: '插进来', whenBusy: mode },
    ctx,
  );
  const secondDone = second.wait(ctx);

  gate.resolve();
  await firstDone;
  await secondDone;

  const page = await conversation.entries({}, 50, undefined, ctx);
  const taskIds = page.items
    .filter((entry) => entry.kind === 'pi.assistant')
    .map((entry) => String(entry.byTaskId));

  await close();
  return { callCount: faux.state.callCount, requestUsers, taskIds };
}

describe('常态（不挂 terminate）：steer 省一次往返', () => {
  it('steer 插进当前 run，第 2 次请求就带上', async () => {
    const r = await measure(false, 'steer');
    expect(r.callCount).toBe(2);
    expect(r.requestUsers[1]).toEqual(['开始干活', '插进来']);
    // 两条 assistant 归属两个 generation task：第一轮 + 延续的那次
    expect(r.taskIds).toHaveLength(2);
  });

  it('followUp 等本轮答完，第 2 次请求**不带**它，第 3 次才带', async () => {
    const r = await measure(false, 'followUp');
    expect(r.callCount).toBe(3);
    expect(r.requestUsers[1]).toEqual(['开始干活']);
    expect(r.requestUsers[2]).toEqual(['开始干活', '插进来']);
    expect(r.taskIds).toHaveLength(3);
  });
});

describe('本项目当前设定（每个工具都挂 terminate）：两者无差别', () => {
  it('steer 与 followUp 观测上完全一致', async () => {
    const steer = await measure(true, 'steer');
    const follow = await measure(true, 'followUp');
    expect(steer.callCount).toBe(2);
    expect(follow.callCount).toBe(2);
    expect(steer.requestUsers).toEqual(follow.requestUsers);
    // 关键：terminate 让 run 在工具轮后立刻结束，steer 没有"正在进行的工作"
    // 可以加入，于是退化成 followUp。
    expect(steer.requestUsers[1]).toEqual(['开始干活', '插进来']);
    expect(follow.requestUsers[1]).toEqual(['开始干活', '插进来']);
  });
});
