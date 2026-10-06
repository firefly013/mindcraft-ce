/**
 * 实测钉住：in-flight run 下 pi-durable 三种提交语义的真实行为。
 *
 * 这是 L1–L5 → 原生原语 映射的**经验依据**，不是推测。运行时是**自然的 ReAct
 * 工具循环**（不挂 `control.terminate`、没有 `Finish`）。
 *
 * 实测结论：
 *   write    → 空闲时**不唤醒模型**（callCount 保持 0）  ⇒ L1/L2「只记账」
 *   steer    → 加入正在跑的 run，第 2 次请求就带上它      ⇒ 「引导」
 *   followUp → 本轮答完后开新一轮，第 3 次请求才带上它    ⇒ 「排队」
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
import { openBotRuntime, type BotRuntime } from '../src/runtime/runtime.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-inbox-'));
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

interface Probe {
  runtime: BotRuntime;
  faux: ReturnType<typeof fauxProvider>;
  /** 每次模型请求看到的完整消息列。 */
  seen: Array<Array<Record<string, unknown>>>;
  release: () => void;
  started: Promise<void>;
}

/** 把 run 钉在"在途"状态：慢工具等外部放行。 */
async function openProbe(): Promise<Probe> {
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
  const startedSignal = deferred();
  const Slow = defineTool({
    name: 'Slow',
    description: '慢工具',
    parameters: Type.Object({}),
    execute: () => {
      startedSignal.resolve();
      return gate.promise.then(() => ({ content: [{ type: 'text' as const, text: 'slow done' }] }));
    },
  });

  const seen: Array<Array<Record<string, unknown>>> = [];
  const step = (context: { messages: unknown }): ReturnType<typeof fauxAssistantMessage> => {
    seen.push(context.messages as Array<Record<string, unknown>>);
    if (seen.length === 1) {
      return fauxAssistantMessage([fauxToolCall('Slow', {})], { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('后续轮次');
  };
  faux.setResponses([step, step, step]);

  const runtime = await openBotRuntime({
    name: 'tester',
    provider,
    baseDir: tempDir(),
    systemPrompt: () => 'SYS',
    liveTail: () => '',
    tools: [Slow],
  });

  return { runtime, faux, seen, release: gate.resolve, started: startedSignal.promise };
}

/** 某次请求里所有 user 消息的正文。 */
function userTexts(messages: Array<Record<string, unknown>> | undefined): string[] {
  return (messages ?? [])
    .filter((message) => message['role'] === 'user')
    .map((message) => (typeof message['content'] === 'string' ? message['content'] : ''));
}

describe('in-flight run 下的提交语义（实测）', () => {
  it('write：空闲时被动写 entry，不唤醒模型', async () => {
    const p = await openProbe();
    // 什么都不提交，先写一条 entry
    await p.runtime.write({ kind: 'mc.note', data: { text: '记一笔' } });
    // 一次模型调用都没有：write 不会把 run 拉起来
    expect(p.faux.state.callCount).toBe(0);
    expect(p.seen).toHaveLength(0);
    await p.runtime.close();
  });

  it('steer：加入正在跑的 run，第 2 次请求就带上', async () => {
    const p = await openProbe();
    const first = await p.runtime.submit('开始干活');
    await p.started;
    const steer = await p.runtime.submit('插一句话', { whenBusy: 'steer' });
    p.release();
    expect((await first.wait(ctx)).status).toBe('done');
    expect((await steer.wait(ctx)).status).toBe('done');

    expect(p.faux.state.callCount).toBe(2);
    expect(userTexts(p.seen[1])).toEqual(['开始干活', '插一句话']);
  });

  it('followUp：本轮答完后开新一轮，第 3 次请求才带上', async () => {
    const p = await openProbe();
    const first = await p.runtime.submit('开始干活');
    await p.started;
    const follow = await p.runtime.submit('等会儿再说', { whenBusy: 'followUp' });
    p.release();
    expect((await first.wait(ctx)).status).toBe('done');
    expect((await follow.wait(ctx)).status).toBe('done');

    // 多一次往返：第 2 次请求是"答完"的那一轮，没带上它
    expect(p.faux.state.callCount).toBe(3);
    expect(userTexts(p.seen[1])).toEqual(['开始干活']);
    expect(userTexts(p.seen[2])).toEqual(['开始干活', '等会儿再说']);
    await p.runtime.close();
  });
});
