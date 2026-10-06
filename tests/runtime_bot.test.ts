/**
 * 装配层的全栈集成测试。
 *
 * 把 P1–P7 的零件真的拼起来跑一遍，覆盖 `agent.ts` 切换后会走的每一条路：
 *   供应商解析 → SQLite 会话 → 工具 → 尾巴注入 → 状态文档 → 事件接入 → 双通道
 *
 * 用 faux provider，不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineTool } from '@earendil-works/pi-durable';
import { openBotWiring, type BotWiring } from '../src/runtime/bot.js';
import { SayEntry } from '../src/runtime/entries.js';
import { EventIntake } from '../src/runtime/events.js';
import type { ResolvedProvider } from '../src/runtime/provider.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-bot-'));
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

const Look = defineTool({
  name: 'Look',
  description: '看一圈周围',
  parameters: Type.Object({}),
  execute: () => Promise.resolve({ content: [{ type: 'text' as const, text: '看到平原' }] }),
});

interface Harness {
  wiring: BotWiring;
  faux: ReturnType<typeof fauxProvider>;
  said: string[];
  rescues: () => number;
  /** 每次模型请求看到的完整消息列。 */
  seen: Array<Array<Record<string, unknown>>>;
}

async function openHarness(intake?: EventIntake): Promise<Harness> {
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

  const seen: Array<Array<Record<string, unknown>>> = [];
  const step = (context: { messages: unknown }): ReturnType<typeof fauxAssistantMessage> => {
    seen.push(context.messages as Array<Record<string, unknown>>);
    return fauxAssistantMessage('收到。');
  };
  faux.setResponses([step, step, step, step, step, step]);

  const said: string[] = [];
  let rescueCount = 0;

  const wiring = await openBotWiring({
    name: 'tester',
    profile: {},
    provider,
    baseDir: tempDir(),
    systemPrompt: () => 'SYS',
    sample: () => ({
      bot: {
        entity: { position: { x: 1.5, y: 64, z: -2.5 }, yaw: 0, pitch: 0 },
        health: 20,
        food: 18,
      },
    }),
    tools: [Look],
    onSay: (text) => said.push(text),
    rescue: () => {
      rescueCount += 1;
      return Promise.resolve();
    },
    ...(intake != null ? { intake } : {}),
  });

  return { wiring, faux, said, rescues: () => rescueCount, seen };
}

/** 某次请求里所有 user 消息的正文。 */
function userTexts(messages: Array<Record<string, unknown>> | undefined): string[] {
  return (messages ?? [])
    .filter((message) => message['role'] === 'user')
    .map((message) => (typeof message['content'] === 'string' ? message['content'] : ''));
}

/**
 * 轮询等待一个条件成立。
 *
 * `submit()` 只保证提交**已记录**，run 是异步跑的；`intake.settle()` 等的是
 * 动作链排空，不是 run 跑完。所以要观察"模型被调用了"必须等。
 */
async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('装配层全栈', () => {
  it('系统提示词真的发给了模型（在 system 消息的 sections 里）', async () => {
    // 这条缺口是真机冒烟抓出来的：请求日志里只有一个空的 [system]。
    // pi-ai 的 SystemMessage 把基础提示放 `content`、把具名段落放 `sections`，
    // 而系统提示词走的是 section——所以断言必须读 `sections`。
    const h = await openHarness();
    await (await h.wiring.runtime.submit('你好')).wait(ctx);

    const system = h.seen[0]?.find((message) => message['role'] === 'system');
    expect(system).toBeDefined();
    expect(JSON.stringify(system?.['sections'])).toContain('SYS');
    await h.wiring.close();
  });

  it('尾巴带 live state，但**不落 transcript**（核心诉求）', async () => {
    const h = await openHarness();
    await (await h.wiring.runtime.submit('看看我')).wait(ctx);

    const last = h.seen[0]?.[h.seen[0].length - 1];
    expect(String(last?.['content'])).toContain('## 当前世界快照');
    expect(String(last?.['content'])).toContain('health 20');

    const page = await h.wiring.runtime.conversation.entries({}, 50, undefined, ctx);
    expect(JSON.stringify(page.items)).not.toContain('当前世界快照');
    await h.wiring.close();
  });

  it('记忆**不进**尾巴——它是压仓摘要，随历史一起发', async () => {
    const h = await openHarness();
    await h.wiring.state.setMemory('家在北边');
    await (await h.wiring.runtime.submit('看看我')).wait(ctx);

    const last = h.seen[0]?.[h.seen[0].length - 1];
    // 尾巴只有快照
    expect(String(last?.['content'])).toContain('## 当前世界快照');
    expect(String(last?.['content'])).not.toContain('## 记忆摘要');
    // 记忆本身仍可读（迁移来的旧记忆留着，供 $MEMORY 类旧提示词用）
    expect(await h.wiring.state.memory()).toBe('家在北边');
    await h.wiring.close();
  });

  it('L2 事件走 write：不唤醒模型，但出现在下一次请求里', async () => {
    const h = await openHarness();
    h.wiring.intake.notify({ level: 2 as never, text: '背包里多了一块木头' });
    await h.wiring.intake.settle();
    // 没有模型调用：被动 entry 不拉起 run
    expect(h.faux.state.callCount).toBe(0);

    await (await h.wiring.runtime.submit('继续')).wait(ctx);
    expect(userTexts(h.seen[0])).toContain('背包里多了一块木头');
    await h.wiring.close();
  });

  it('L3 事件走 steer：出现在同一次请求里', async () => {
    const h = await openHarness();
    h.wiring.intake.notify({ level: 3 as never, text: '有玩家在叫我' });
    await h.wiring.intake.settle();
    // 空闲时 steer 也会把 run 拉起来（submit 只保证已记录，run 异步跑）
    await until(() => h.faux.state.callCount > 0);
    expect(h.faux.state.callCount).toBe(1);
    expect(userTexts(h.seen[0])).toContain('有玩家在叫我');
    await h.wiring.close();
  });

  it('L5 事件：abort + 保命反射，且不喂给模型', async () => {
    const h = await openHarness();
    await (await h.wiring.runtime.submit('干点活')).wait(ctx);
    const callsBefore = h.faux.state.callCount;

    h.wiring.intake.notify({ level: 5 as never, text: '脚下是岩浆' });
    await h.wiring.intake.settle();

    expect(h.rescues()).toBe(1);
    // 紧急事件由反射消化，不再拉起模型
    expect(h.faux.state.callCount).toBe(callsBefore);
    await h.wiring.close();
  });

  it('Say 双通道：落 mc.say entry 且触发回调', async () => {
    const h = await openHarness();
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('Say', { text: '你好呀' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('说完了。'),
    ]);
    await (await h.wiring.runtime.submit('打个招呼')).wait(ctx);

    const page = await h.wiring.runtime.conversation.entries({}, 50, undefined, ctx);
    expect(page.items.filter((entry) => SayEntry.is(entry))).toHaveLength(1);
    expect(h.said).toEqual(['你好呀']);
    await h.wiring.close();
  });

  it('工具与散文都在：一次工具轮 + 一次收尾', async () => {
    const h = await openHarness();
    h.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('Look', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('是平原。'),
    ]);
    await (await h.wiring.runtime.submit('看看周围')).wait(ctx);
    expect(h.faux.state.callCount).toBe(2);

    const page = await h.wiring.runtime.conversation.entries({}, 50, undefined, ctx);
    expect(page.items.some((entry) => entry.kind === 'pi.tool-result')).toBe(true);
    expect(JSON.stringify(page.items)).toContain('是平原。');
    await h.wiring.close();
  });

  it('运行时就绪前的事件被补投，一个都不丢', async () => {
    // Agent 的用法：先建 intake、注册事件监听，等 SQLite 打开后再接运行时。
    const intake = new EventIntake();
    intake.notify({ level: 2 as never, text: '连接期间的噪声' });
    expect(intake.attached).toBe(false);
    expect(intake.waitingCount).toBe(1);

    const h = await openHarness(intake);
    await intake.settle();
    expect(intake.attached).toBe(true);
    expect(intake.waitingCount).toBe(0);

    // L2 走 write：不唤醒模型，但下一次请求能看到
    expect(h.faux.state.callCount).toBe(0);
    await (await h.wiring.runtime.submit('继续')).wait(ctx);
    expect(userTexts(h.seen[0])).toContain('连接期间的噪声');
    await h.wiring.close();
  });

  it('关闭后重开：记忆与 conversation id 都还在', async () => {
    const h = await openHarness();
    await h.wiring.state.setMemory('记住了');
    const id = h.wiring.runtime.conversation.id;
    const baseDir = h.wiring.runtime.session.dbPath.replace(/[/\\]session\.db$/, '');
    await h.wiring.close();

    const faux2 = fauxProvider({ models: [{ id: 'mc-test' }] });
    const models2 = createModels();
    models2.setProvider(faux2.provider);
    const model2 = faux2.getModel('mc-test') ?? faux2.getModel();
    const reopened = await openBotWiring({
      name: 'tester',
      profile: {},
      provider: {
        models: models2,
        model: model2,
        providerId: faux2.provider.id,
        apiKey: undefined,
        headers: null,
        contextWindow: model2.contextWindow,
      },
      baseDir,
      systemPrompt: () => 'SYS',
      sample: () => ({ bot: {} }),
      rescue: () => Promise.resolve(),
    });

    expect(reopened.runtime.conversation.id).toBe(id);
    expect(await reopened.state.memory()).toBe('记住了');
    await reopened.close();
  });
});
