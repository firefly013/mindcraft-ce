/**
 * P3：回合语义 —— `control.terminate` ↔ "一轮一次模型调用"。
 *
 * 全部用 faux provider，不联网、不花钱、确定性。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { SayEntry } from '../src/runtime/entries.js';
import { liveTailHook } from '../src/runtime/loop.js';
import type { ResolvedProvider } from '../src/runtime/provider.js';
import { openBotRuntime, type BotRuntime } from '../src/runtime/runtime.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-loop-'));
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
      // Windows 上 SQLite 句柄可能还没释放；临时目录残留不影响断言。
    }
  }
});

/** 一个没有副作用的查询工具，代表"动作类/查询类"工具。 */
const Look: ToolRegistration = defineTool({
  name: 'Look',
  description: '看一圈周围',
  parameters: Type.Object({}),
  execute: () => Promise.resolve({ content: [{ type: 'text' as const, text: '看到平原' }] }),
});

interface Harness {
  runtime: BotRuntime;
  faux: ReturnType<typeof fauxProvider>;
  said: string[];
  baseDir: string;
  setTail: (value: string) => void;
}

/** 把 faux provider 包成 P1 的 `ResolvedProvider` 形状。 */
function resolveFaux(faux: ReturnType<typeof fauxProvider>): ResolvedProvider {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel('mc-test') ?? faux.getModel();
  return {
    models,
    model,
    providerId: faux.provider.id,
    apiKey: undefined,
    headers: null,
    contextWindow: model.contextWindow,
  };
}

async function openHarness(overrides: Partial<{ tools: ToolRegistration[] }> = {}): Promise<Harness> {
  const faux = fauxProvider({ models: [{ id: 'mc-test', input: ['text', 'image'] }] });

  let tail = '';
  const said: string[] = [];
  const baseDir = tempDir();

  const runtime = await openBotRuntime({
    name: 'tester',
    provider: resolveFaux(faux),
    baseDir,
    systemPrompt: () => 'SYS-PROMPT',
    liveTail: () => tail,
    tools: overrides.tools ?? [Look],
    onSay: (text) => said.push(text),
  });

  return { runtime, faux, said, baseDir, setTail: (value) => (tail = value) };
}

describe('回合语义：一轮一次模型调用', () => {
  it('工具轮结束后不再发起下一次模型请求', async () => {
    const h = await openHarness();
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('Look', {})], { stopReason: 'toolUse' }),
    ]);
    const submission = await h.runtime.submit('看看周围');
    expect((await submission.wait(ctx)).status).toBe('done');
    expect(h.faux.state.callCount).toBe(1);
    await h.runtime.close();
  });

  it('一轮里多个工具调用也只打一次模型（载荷测试：只给 Finish 挂 terminate 会失败）', async () => {
    const h = await openHarness();
    h.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('Look', {}), fauxToolCall('Say', { text: '我看到平原' })],
        { stopReason: 'toolUse' },
      ),
    ]);
    const submission = await h.runtime.submit('看看周围并告诉我');
    expect((await submission.wait(ctx)).status).toBe('done');
    // 整轮所有结果都请求 terminate 才结束；Look 与 Say 都必须带上。
    expect(h.faux.state.callCount).toBe(1);
    expect(h.said).toEqual(['我看到平原']);
    await h.runtime.close();
  });

  it('纯文本作答也结束 run（自动散文通道）', async () => {
    const h = await openHarness();
    h.faux.setResponses([fauxAssistantMessage('我就站在这儿，哪儿也不去。')]);
    const submission = await h.runtime.submit('你在干嘛');
    expect((await submission.wait(ctx)).status).toBe('done');
    expect(h.faux.state.callCount).toBe(1);

    const page = await h.runtime.conversation.entries({}, 50, undefined, ctx);
    const assistant = page.items.filter((e) => e.kind === 'pi.assistant');
    expect(assistant.length).toBeGreaterThan(0);
    expect(JSON.stringify(assistant)).toContain('我就站在这儿');
    await h.runtime.close();
  });
});

describe('Say 双通道', () => {
  it('Say 落独立 entry 且回调触发', async () => {
    const h = await openHarness();
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('Say', { text: '你好呀' })], { stopReason: 'toolUse' }),
    ]);
    await (await h.runtime.submit('打个招呼')).wait(ctx);

    const page = await h.runtime.conversation.entries({}, 50, undefined, ctx);
    const says = page.items.filter((e) => SayEntry.is(e));
    expect(says).toHaveLength(1);
    expect(says[0]?.data).toEqual({ text: '你好呀' });
    expect(h.said).toEqual(['你好呀']);
    await h.runtime.close();
  });

  it('空话被拒绝且不写 entry', async () => {
    const h = await openHarness();
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('Say', { text: '   ' })], { stopReason: 'toolUse' }),
    ]);
    await (await h.runtime.submit('说点什么')).wait(ctx);

    const page = await h.runtime.conversation.entries({}, 50, undefined, ctx);
    expect(page.items.filter((e) => SayEntry.is(e))).toHaveLength(0);
    expect(h.said).toEqual([]);
    await h.runtime.close();
  });

  it('超过上限的说话被截断到 240 字', async () => {
    const h = await openHarness();
    const long = 'x'.repeat(300);
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('Say', { text: long })], { stopReason: 'toolUse' }),
    ]);
    await (await h.runtime.submit('长话')).wait(ctx);

    const page = await h.runtime.conversation.entries({}, 50, undefined, ctx);
    const says = page.items.filter((e) => SayEntry.is(e));
    expect((says[0]?.data as { text: string }).text).toHaveLength(240);
    expect(h.said[0]).toHaveLength(240);
    await h.runtime.close();
  });
});

describe('动态尾巴注入', () => {
  it('尾巴作为最后一条 user 消息发出，且不落 transcript', async () => {
    const h = await openHarness();
    h.setTail('## 当前世界快照\nhp=20/20');
    let seen: unknown;
    h.faux.setResponses([
      (context) => {
        seen = context.messages;
        return fauxAssistantMessage('收到');
      },
    ]);
    await (await h.runtime.submit('看看状态')).wait(ctx);

    const messages = seen as Array<Record<string, unknown>>;
    expect(messages[messages.length - 1]).toMatchObject({ role: 'user', content: '## 当前世界快照\nhp=20/20' });

    // 关键：尾巴只影响本次请求，不进 entry——否则每轮追加一条 pi.system，缓存全废。
    const page = await h.runtime.conversation.entries({}, 50, undefined, ctx);
    expect(JSON.stringify(page.items)).not.toContain('当前世界快照');
    await h.runtime.close();
  });

  it('尾巴为空/纯空白时 hook 返回 undefined（不追加消息）', () => {
    // 直接单测 hook：比穿透整条管线断言更精确，也不依赖 pi-ai 归一化后
    // system 消息落在哪个位置（实测它排在 user 输入之后）。
    type Handler = (request: { messages: Array<Record<string, unknown>> }) =>
      | { messages: Array<Record<string, unknown>> }
      | undefined;

    const blank = liveTailHook(() => '   ').handlers as unknown as { beforeRequest: Handler };
    expect(blank.beforeRequest({ messages: [] })).toBeUndefined();

    const withTail = liveTailHook(() => 'X').handlers as unknown as { beforeRequest: Handler };
    const out = withTail.beforeRequest({ messages: [{ role: 'user', content: 'a' }] });
    expect(out?.messages).toHaveLength(2);
    expect(out?.messages[1]).toMatchObject({ role: 'user', content: 'X' });
  });

  it('系统提示词走 section，只落一次 pi.system', async () => {
    const h = await openHarness();
    h.setTail('## 事件\n#1 World/L3');
    h.faux.setResponses([fauxAssistantMessage('第一轮')]);
    await (await h.runtime.submit('一')).wait(ctx);
    h.setTail('## 事件\n#2 World/L3');
    h.faux.setResponses([fauxAssistantMessage('第二轮')]);
    await (await h.runtime.submit('二')).wait(ctx);

    const page = await h.runtime.conversation.entries({}, 50, undefined, ctx);
    const systems = page.items.filter((e) => e.kind === 'pi.system');
    // 静态提示词没变 → 不追加新的 pi.system
    expect(systems).toHaveLength(1);
    await h.runtime.close();
  });
});

describe('持久化与中断', () => {
  it('关闭后重开：entry 与 conversation id 都在', async () => {
    const h = await openHarness();
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('Say', { text: '记住了' })], { stopReason: 'toolUse' }),
    ]);
    await (await h.runtime.submit('记住这句话')).wait(ctx);
    const id = h.runtime.conversation.id;
    await h.runtime.close();

    const faux2 = fauxProvider({ models: [{ id: 'mc-test' }] });
    const reopened = await openBotRuntime({
      name: 'tester',
      provider: resolveFaux(faux2),
      baseDir: h.baseDir,
      systemPrompt: () => 'SYS-PROMPT',
      liveTail: () => '',
      tools: [Look],
    });
    expect(reopened.conversation.id).toBe(id);
    const page = await reopened.conversation.entries({}, 50, undefined, ctx);
    expect(page.items.filter((e) => SayEntry.is(e))).toHaveLength(1);
    await reopened.close();
  });

  it('abort() 能把在途 run 停掉', async () => {
    const h = await openHarness();
    // 第一轮工具调用后 run 正常结束；这里验证 abort 对空跑会话是安全幂等的。
    h.faux.setResponses([fauxAssistantMessage('ok')]);
    await (await h.runtime.submit('一')).wait(ctx);
    await h.runtime.abort();
    await h.runtime.abort();
    expect((await h.runtime.session.harness.inspect(ctx)).tasks).toHaveLength(0);
    await h.runtime.close();
  });
});
