/**
 * 空转护栏：把"模型只说话不调工具"按回去继续干活。
 *
 * ## 这条测试钉的是真机事故，不是假想
 *
 * 2026-10-18 12:22 实测：整树重启后 `overnight_a`/`overnight_b` 各发一次
 * `content:["thinking","text"]` 的请求（零 `toolCall`），随后 10 分钟没有任何
 * 请求、没有任何动作，`Goal: none Todos: none` —— 也就是"AI 把自己停了"。
 * 根因是运行时的回合语义：`run` 结束 = 模型不再调工具，而下一轮只能靠事件
 * 唤醒；夜里没事件，就永远不动。
 *
 * 所以这里第一条就是**反证**：关掉护栏时，一次纯正文回答之后模型调用次数
 * 必须停在 1（复现事故）；开着护栏时，它必须被按回去继续（`STALL_NUDGE`
 * 出现在下一次请求的 user 消息里）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type, createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineTool } from '@earendil-works/pi-durable';
import type { ResolvedProvider } from '../src/brain/runtime/provider.js';
import { openBotRuntime, type BotRuntime } from '../src/brain/runtime/runtime.js';
import {
  STALL_NUDGE,
  STALL_NUDGE_ESCALATED,
  STALL_WATCHDOG_NUDGE,
  createStallGuard,
  readYieldText,
} from '../src/brain/runtime/stall_guard.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-stall-'));
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

/** 造一个 faux 供应商；`responses` 每次请求消费一条。 */
function fauxSetup(responses: Array<ReturnType<typeof fauxAssistantMessage>>): {
  provider: ResolvedProvider;
  faux: ReturnType<typeof fauxProvider>;
} {
  const faux = fauxProvider({ models: [{ id: 'mc-test' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel('mc-test') ?? faux.getModel();
  faux.setResponses(responses);
  const provider: ResolvedProvider = {
    models,
    model,
    providerId: faux.provider.id,
    apiKey: undefined,
    headers: null,
    params: {},
    contextWindow: model.contextWindow,
  };
  return { provider, faux };
}

/** 一个只在世界里改点东西的工具（用来代表"真的干活了"）。 */
const Work = defineTool({
  name: 'Work',
  description: '干活',
  parameters: Type.Object({}),
  execute: () => Promise.resolve({ content: [{ type: 'text' as const, text: 'done' }] }),
});

interface Measured {
  callCount: number;
  /** 每次请求里所有 user 消息正文。 */
  requestUsers: string[][];
}

/** 跑一次"用户说开始"，把期间每次请求的 user 消息记下来。 */
async function runWith(
  responses: Array<ReturnType<typeof fauxAssistantMessage>>,
  stallGuard: false | { maxContinues?: number },
): Promise<Measured> {
  const { provider, faux } = fauxSetup(responses);
  const requestUsers: string[][] = [];

  // 用 beforeRequest 之外的钩子拿不到"本次请求的消息列"，所以在 faux 的
  // 响应函数里取——`step` 形态的响应拿得到 context。
  const record = (context: { messages: unknown }): ReturnType<typeof fauxAssistantMessage> => {
    requestUsers.push(
      (context.messages as Array<Record<string, unknown>>)
        .filter((message) => message['role'] === 'user')
        .map((message) => (typeof message['content'] === 'string' ? message['content'] : '')),
    );
    return responses[Math.min(requestUsers.length - 1, responses.length - 1)]!;
  };
  // 每条响应都套一层记录（响应数不够时复用最后一条，避免 faux 抛错掩盖结论）。
  faux.setResponses(responses.map(() => record));

  const runtime: BotRuntime = await openBotRuntime({
    name: 'stalltester',
    provider,
    baseDir: tempDir(),
    systemPrompt: () => 'SYS',
    liveTail: () => '',
    tools: [Work],
    stallGuard,
  });

  await (await runtime.submit('开始干活')).wait(ctx);
  const callCount = faux.state.callCount;
  await runtime.close();
  return { callCount, requestUsers };
}

const textOnly = (): ReturnType<typeof fauxAssistantMessage> => fauxAssistantMessage('我先汇报一下情况。');
const toolTurn = (): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage([fauxToolCall('Work', {})], { stopReason: 'toolUse' });
/** 只说话、不改变世界的那个工具（护栏必须把它排除在"干过活"之外）。 */
const sayTurn = (): ReturnType<typeof fauxAssistantMessage> =>
  fauxAssistantMessage([fauxToolCall('Say', { text: '我在找要塞' })], { stopReason: 'toolUse' });

describe('反证：没有护栏时，一次纯正文回答就把 bot 停死', () => {
  it('关掉护栏 → 模型只被调用 1 次，之后没有任何请求', async () => {
    const r = await runWith([textOnly(), toolTurn(), toolTurn(), toolTurn()], false);
    expect(r.callCount).toBe(1);
  });
});

describe('onYield 护栏：把"只说话"的回合按回去继续', () => {
  it('第一次纯正文回答之后会收到 STALL_NUDGE，并真的继续调用工具', async () => {
    const r = await runWith([textOnly(), toolTurn(), textOnly(), toolTurn()], { maxContinues: 3 });
    expect(r.callCount).toBeGreaterThanOrEqual(3);
    // 第 1 次请求只有原始输入；第 2 次请求必须带上催办文案。
    expect(r.requestUsers[0]).toEqual(['开始干活']);
    expect(r.requestUsers[1]?.some((text) => text.includes(STALL_NUDGE))).toBe(true);
  });

  it('连续纯正文到达上限就放手（不无限续轮烧钱），且语气逐级变硬', async () => {
    const r = await runWith([textOnly(), textOnly(), textOnly(), textOnly(), textOnly()], {
      maxContinues: 3,
    });
    // 1 次原始 + 3 次按回 = 4；第 5 条响应永远不会被消费。
    expect(r.callCount).toBe(4);
    // 第 1 档文案出现在第 2 次请求；第 2 档（更硬）出现在第 3 次请求。
    expect(r.requestUsers[1]?.some((text) => text.includes(STALL_NUDGE))).toBe(true);
    expect(r.requestUsers[2]?.some((text) => text.includes(STALL_NUDGE_ESCALATED))).toBe(true);
    // **把上一轮的正文原样回灌**：模型在那句话里已经想清楚要做什么，
    // 只是把"写下意图"当成了"执行"（真机 A 的固定错误）。
    expect(r.requestUsers[2]?.some((text) => text.includes('【你上一轮写的正文是】我先汇报一下情况。'))).toBe(true);
    expect(r.requestUsers[2]?.some((text) => text.includes('作为工具调用**发出来'))).toBe(true);
  });

  it('只要调过一次工具，连击就清零（干活的 bot 不会被上限掐停）', async () => {    const r = await runWith(
      [textOnly(), toolTurn(), textOnly(), toolTurn(), textOnly(), toolTurn(), textOnly(), toolTurn()],
      { maxContinues: 1 },
    );
    // maxContinues=1 本来会在第 2 次纯正文时就放手（callCount 停在 2）；
    // 因为中间穿插了工具调用，每一次"汇报"都被按回去，8 条脚本响应全部消费，
    // 之后框架还会接着走（faux 用最后一条兜底），所以断言"远不止 2"。
    expect(r.callCount).toBeGreaterThanOrEqual(8);
    // 连击被工具清零 ⇒ 每次都是第 1 档文案，永远不会走到升级档。
    const allUsers = r.requestUsers.flat().join('\n');
    expect(allUsers).toContain(STALL_NUDGE);
    expect(allUsers).not.toContain(STALL_NUDGE_ESCALATED);
  });

  it('Say 不算"干过活"：反复"正文 → Say"不能击穿上限（对抗验证 VERIFY.md 声明 1）', async () => {
    // 曾经的洞：afterTool 无条件把连击清零，而 Say 是普通工具 ⇒ 模型只要
    // "正文 → Say → 正文 → Say" 就让 maxContinues 永远够不到——实测
    // maxContinues=1 时纯正文 2 次请求就停，加了 Say 之后 25 次请求 / 12 次
    // 催办还在继续。而 prompts.ts 又要求"报进度走 Say"，等于把 F-7 从
    // "3 次后放手"升级成无限循环。
    const r = await runWith(
      [textOnly(), sayTurn(), textOnly(), sayTurn(), textOnly(), sayTurn()],
      { maxContinues: 1 },
    );
    // maxContinues=1：第 1 次纯正文按回一次；Say 不清零 ⇒ 第 2 次 yield 就放手。
    // 3 次请求 = 正文 → Say → 正文，之后不再续轮。
    expect(r.callCount).toBe(3);
    // 上限之内只会用第 1 档文案（连击没被 Say 清零，也就走不到升级档）。
    expect(r.requestUsers.flat().join('\n')).not.toContain(STALL_NUDGE_ESCALATED);
  });
});

describe('心跳看门狗：连请求都没有时主动唤醒', () => {
  /** 拿到 guard 上某个 task 的 handlers（按有没有那个方法找，不猜 task 名）。 */
  function handlersWith(guard: ReturnType<typeof createStallGuard>, method: string) {
    const found = guard.hooks
      .map((registration) => registration.handlers as Record<string, ((...args: unknown[]) => unknown) | undefined>)
      .find((handlers) => typeof handlers[method] === 'function');
    expect(found, `没有找到带 ${method} 的 hook`).toBeDefined();
    return found!;
  }

  function harness(overrides: Partial<Parameters<typeof createStallGuard>[0]> = {}) {
    let clock = 0;
    const ticks: Array<() => void> = [];
    const woken: string[] = [];
    const continues: number[] = [];
    const guard = createStallGuard({
      idleMs: 60_000,
      maxIdleMs: 240_000,
      toolGraceMs: 120_000,
      now: () => clock,
      setInterval: (fn) => {
        ticks.push(fn);
        return 1;
      },
      clearInterval: () => {},
      wake: (text) => {
        woken.push(String(text));
        return Promise.resolve();
      },
      onContinue: (attempt) => continues.push(attempt),
      ...overrides,
    });
    return {
      guard,
      woken,
      continues,
      tick: () => ticks.forEach((fn) => fn()),
      setClock: (value: number) => {
        clock = value;
      },
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('没到阈值不唤醒，到了就提交一条唤醒消息', () => {
    const h = harness();
    h.advance(59_000);
    h.tick();
    expect(h.woken).toHaveLength(0);
    h.advance(2_000);
    h.tick();
    expect(h.woken).toHaveLength(1);
    expect(h.woken[0]).toBe(STALL_WATCHDOG_NUDGE);
    h.guard.stop();
  });

  it('有活动就重新计时（模型在答、工具在跑都不算停摆）', () => {
    const h = harness();
    h.advance(50_000);
    h.tick();
    h.guard.noteActivity();
    h.advance(50_000);
    h.tick();
    expect(h.woken).toHaveLength(0);
    h.advance(11_000);
    h.tick();
    expect(h.woken).toHaveLength(1);
    h.guard.stop();
  });

  it('动作正在跑时不插嘴（长动作有 10 分钟保险丝）', () => {
    const h = harness();
    const toolHooks = handlersWith(h.guard, 'beforeTool');
    toolHooks['beforeTool']!({}, {}, {});
    h.advance(61_000);
    h.tick();
    expect(h.woken).toHaveLength(0);
    // 超过宽限期还是不动 → 接手（真挂住的动作不能被无限等）。
    h.advance(120_000);
    h.tick();
    expect(h.woken).toHaveLength(1);
    h.guard.stop();
  });

  it('催了不动就退避，但永远不放弃', () => {
    const h = harness();
    h.advance(61_000);
    h.tick();
    expect(h.woken).toHaveLength(1);
    // 退避后：60s 已不够，要 120s。
    h.advance(61_000);
    h.tick();
    expect(h.woken).toHaveLength(1);
    h.advance(60_000);
    h.tick();
    expect(h.woken).toHaveLength(2);
    h.guard.stop();
  });

  it('心跳响过之后 onYield 那层重新上膛（否则护栏等于自杀）', () => {
    // 真机：连续 3 次"只写正文"用光上限后再没复位 ⇒ onYield 永久失效，
    // 每 10 分钟被叫醒一次回段正文又睡回去，两小时零动作（用户看到"不动弹"）。
    const h = harness();
    const genHooks = handlersWith(h.guard, 'onYield');
    const first = genHooks['onYield']!({}, {}, {}) as { continue?: unknown } | undefined;
    const second = genHooks['onYield']!({}, {}, {}) as { continue?: unknown } | undefined;
    const third = genHooks['onYield']!({}, {}, {}) as { continue?: unknown } | undefined;
    const fourth = genHooks['onYield']!({}, {}, {}) as { continue?: unknown } | undefined;
    expect(first?.continue).toBeDefined();
    expect(second?.continue).toBeDefined();
    expect(third?.continue).toBeDefined();
    expect(fourth).toBeUndefined(); // 上限 3，用光了
    // 心跳响一次 → 重新上膛
    h.advance(61_000);
    h.tick();
    expect(h.woken).toHaveLength(1);
    const again = genHooks['onYield']!({}, {}, {}) as { continue?: unknown } | undefined;
    expect(again?.continue).toBeDefined();
    h.guard.stop();
  });

  it('真的答过一轮之后退避复位（不会永远停在最大间隔）', () => {
    // 曾经的洞：退避只在 `noteActivity()` 里复位，而生产路径没人调用它 ⇒
    // 退避涨到上限后永远停在 30 分钟，健康跑了三小时的 bot 后来真卡住也要等满。
    const h = harness();
    h.advance(61_000);
    h.tick();
    h.advance(121_000);
    h.tick();
    h.advance(241_000);
    h.tick();
    expect(h.woken).toHaveLength(3); // 60s → 120s → 240s
    const genHooks = handlersWith(h.guard, 'afterResponse');
    genHooks['afterResponse']!({}, {}, {}); // 模型真的答了一轮
    h.advance(61_000);
    h.tick();
    // 复位到基准 60s：不需要等 480s。
    expect(h.woken).toHaveLength(4);
    h.guard.stop();
  });
});
