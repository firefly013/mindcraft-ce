/**
 * 实测钉住：in-flight run 下 pi-durable 三种提交语义的真实行为。
 *
 * 这是 L1–L5 → 原生原语 映射的**经验依据**，不是推测。前提是「每个工具都被
 * `withTerminate` 挂上 `control.terminate`」——也就是本项目"一轮一次模型调用"
 * 的设定。
 *
 * 实测结论：
 *   write    → 不唤醒模型（callCount 不增）          ⇒ L2「只记账，随下次请求带上」
 *   steer    → **加入正在跑的 run**，且**覆盖 terminate**（run 继续，第二次请求
 *              带上它）                              ⇒ 「引导」
 *   followUp → 本轮答完后开新一轮，第二次请求带上它   ⇒ L3「排队等本轮结束」
 *
 * L3 取 `followUp` 而不是 `steer`：旧 L3-busy 是「当前请求看不到它，本轮结束时
 * 由下一轮带上」，而 `steer` 会让当前轮**不结束**——那是行为改变。
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
  it('write：被动 entry，不唤醒模型', async () => {
    const p = await openProbe();
    const first = await p.runtime.submit('开始干活');
    await p.started;
    await p.runtime.write({ kind: 'mc.note', data: { text: '记一笔' } });
    p.release();
    expect((await first.wait(ctx)).status).toBe('done');
    // 只打了第一轮：write 没有把 run 拉起来
    expect(p.faux.state.callCount).toBe(1);
    await p.runtime.close();
  });

  it('steer：加入正在跑的 run，并覆盖 control.terminate', async () => {
    const p = await openProbe();
    const first = await p.runtime.submit('开始干活');
    await p.started;
    const steer = await p.runtime.submit('插一句话', { whenBusy: 'steer' });
    p.release();
    expect((await first.wait(ctx)).status).toBe('done');
    expect((await steer.wait(ctx)).status).toBe('done');

    // 所有工具都请求了 terminate，steer 仍然让 run 继续了第二次模型调用。
    expect(p.faux.state.callCount).toBe(2);
    expect(userTexts(p.seen[1])).toEqual(['开始干活', '插一句话']);
  });

  it('followUp：本轮答完后开新一轮，第二次请求带上它', async () => {
    const p = await openProbe();
    const first = await p.runtime.submit('开始干活');
    await p.started;
    const follow = await p.runtime.submit('等会儿再说', { whenBusy: 'followUp' });
    p.release();
    expect((await first.wait(ctx)).status).toBe('done');
    expect((await follow.wait(ctx)).status).toBe('done');

    expect(p.faux.state.callCount).toBe(2);
    expect(userTexts(p.seen[1])).toEqual(['开始干活', '等会儿再说']);
    await p.runtime.close();
  });
});
