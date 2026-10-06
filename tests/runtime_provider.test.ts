/**
 * P1 等价性：pi-ai 供应商层（`src/runtime/`）vs 旧手写 `GPT` 适配器。
 *
 * 两组验证：
 *  1. 端点解析：OpenCode Go 的 profile 必须命中 pi-ai 内置目录，从而拿到真实的
 *     1_000_000 上下文窗口与 `thinkingFormat: "deepseek"` 等 compat。
 *  2. payload 等价：同一组输入下，新路径经 pi-ai 组出的请求体与旧适配器一致。
 *
 * 全程**不联网**：fetch 注入成必失败函数，payload 由 `onPayload` 在发送前截获；
 * 旧适配器走注入的 stub client。
 */
import { describe, expect, it } from 'vitest';
import { GPT } from '../src/models/gpt.js';
import { PiModel } from '../src/runtime/model.js';
import { resolveProvider } from '../src/runtime/provider.js';
import type { ChatMessage, OpenAITool } from '../src/types/common.js';

const OFFLINE_URL = 'http://127.0.0.1:1/v1';
const MISSING_KEY = 'DEFINITELY_MISSING_KEY_FOR_TEST';

/** 必失败的 fetch：请求发不出去，但 `onPayload` 已在发送前触发。 */
const offlineFetch = (() =>
  Promise.reject(new Error('offline'))) as unknown as typeof globalThis.fetch;

/** 取第一条捕获结果；没有就抛，避免用非空断言。 */
function first<T>(items: T[]): T {
  const value = items[0];
  if (value === undefined) throw new Error('expected at least one captured payload');
  return value;
}

const TOOLS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'Look',
      description: 'Look around',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

/** 本地兼容端点 profile（走 custom provider，不需要真 key）。 */
const LOCAL_PROFILE = {
  model: { model: 'gpt-5.4', url: OFFLINE_URL, params: { api_key_env: MISSING_KEY } },
};

function capturingPi(profile: unknown): {
  model: PiModel;
  payloads: Record<string, unknown>[];
} {
  const payloads: Record<string, unknown>[] = [];
  const model = new PiModel(profile, {
    fetch: offlineFetch,
    maxRetries: 0,
    onPayload: (payload) => {
      payloads.push(payload as Record<string, unknown>);
      return undefined;
    },
  });
  return { model, payloads };
}

function capturingGpt(): { model: GPT; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: (body: Record<string, unknown>) => {
          bodies.push(body);
          return Promise.resolve({ choices: [{ message: { content: 'ok', tool_calls: [] } }] });
        },
      },
    },
  };
  return { model: new GPT('gpt-5.4', OFFLINE_URL, undefined, client as never), bodies };
}

describe('resolveProvider 端点分派', () => {
  it('OpenCode Go profile 命中内置目录：真实 1M 窗口 + deepseek thinking 格式', () => {
    const profile = {
      name: 'opencode',
      model: {
        api: 'openai',
        model: 'deepseek-v4.1-flash',
        url: 'https://opencode.ai/zen/go/v1',
        params: {
          api_key_env: 'OPENCODE_API_KEY',
          headers: { 'x-opencode-session': '${OPENCODE_SESSION_ID}' },
        },
      },
    };
    const resolved = resolveProvider(profile);
    expect(resolved.providerId).toBe('opencode-go');
    expect(resolved.model.id).toBe('deepseek-v4.1-flash');
    expect(resolved.model.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    // 这就是现有代码 128_000 回退所丢掉的那个数。
    expect(resolved.contextWindow).toBe(1_000_000);
    expect(resolved.model.input).toContain('image');
    expect(resolved.model.compat).toMatchObject({
      thinkingFormat: 'deepseek',
      supportsStrictMode: true,
      maxTokensField: 'max_tokens',
    });
    expect(resolved.headers).not.toBeNull();
    expect(resolved.headers?.['x-opencode-session']).toBeTruthy();
  });

  it('Zen 端点不会被 Go 抢走（Go 是 Zen 的子路径，匹配顺序敏感）', () => {
    const resolved = resolveProvider({
      model: { model: 'deepseek-v4.1-flash', url: 'https://opencode.ai/zen/v1' },
    });
    expect(resolved.providerId).toBe('opencode');
    expect(resolved.model.baseUrl).toBe('https://opencode.ai/zen/v1');
  });

  it('本地端点缺 key → 占位 not-needed，且不因目录缺失而崩', () => {
    const resolved = resolveProvider(LOCAL_PROFILE);
    expect(resolved.providerId).toBe('custom');
    expect(resolved.apiKey).toBe('not-needed');
    expect(resolved.contextWindow).toBe(128_000);
  });

  it('无 url 且无 key → 抛，保留旧 getKey 的明确报错', () => {
    expect(() =>
      resolveProvider({ model: 'gpt-5.4', params: { api_key_env: MISSING_KEY } }),
    ).toThrow(/not found in keys.json/);
  });

  it('裸字符串 profile 与 `openai/` 前缀都能归一', () => {
    expect(resolveProvider({ model: 'openai/gpt-5.4', url: OFFLINE_URL }).model.id).toBe('gpt-5.4');
    expect(resolveProvider({ model: 'gpt-5.4', url: OFFLINE_URL }).model.id).toBe('gpt-5.4');
  });
});

describe('payload 等价：PiModel vs GPT', () => {
  const turns: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'go north' },
  ];
  const TAIL = '## 当前世界快照\nhp=20';

  it('messages / tools / tool_choice 与旧适配器逐字节一致', async () => {
    const { model: pi, payloads } = capturingPi(LOCAL_PROFILE);
    await pi.sendRequestWithTools(turns, 'SYS', TOOLS, 'required', TAIL);
    const { model: gpt, bodies } = capturingGpt();
    await gpt.sendRequestWithTools(turns, 'SYS', TOOLS, 'required', TAIL);

    expect(payloads).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    const next = first(payloads);
    const old = first(bodies);

    // 语义部分必须完全一致。
    expect(next['model']).toBe(old['model']);
    expect(next['messages']).toEqual(old['messages']);
    expect(next['tools']).toEqual(old['tools']);
    expect(next['tool_choice']).toBe(old['tool_choice']);

    // pi-ai 额外带的都是传输层字段，不是语义差异：
    //   stream + stream_options.include_usage → 内部流式收集 + 用量统计
    //   store:false                          → 明确不落供应商侧存储
    expect(next['stream']).toBe(true);
    expect(next['stream_options']).toEqual({ include_usage: true });
    expect(next['store']).toBe(false);

    // 顺序：system 头固定，历史居中，尾巴永远最后一条。
    const messages = next['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatchObject({ role: 'system', content: 'SYS' });
    expect(messages[4]).toMatchObject({ role: 'user', content: TAIL });
  });

  it('尾巴只有空白且无截图时不追加消息', async () => {
    const { model, payloads } = capturingPi(LOCAL_PROFILE);
    await model.sendRequestWithTools(turns, 'SYS', TOOLS, 'auto', '   ');
    // 3 条历史 + system 头；空白尾巴不追加消息
    expect((payloads[0]?.['messages'] as unknown[]).length).toBe(4);
  });

  it('带截图时尾巴与图合成同一条多模态 user 消息', async () => {
    const { model, payloads } = capturingPi(LOCAL_PROFILE);
    await model.sendRequestWithTools(turns, 'SYS', TOOLS, 'auto', TAIL, 'QUJD');
    const messages = payloads[0]?.['messages'] as Array<Record<string, unknown>>;
    // 3 条历史 + system 头 + 尾巴 = 5
    expect(messages).toHaveLength(5);
    expect(messages[4]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: TAIL },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      ],
    });
  });

  it('sendRequest 把 stop 放进请求体；模型名含 o1/o3/5 时删掉（复刻旧 URL 分支）', async () => {
    // 'llama-3-8b' 不含 o1/o3/5 → 应带 stop。
    const withStop = capturingPi({
      model: { model: 'llama-3-8b', url: OFFLINE_URL, params: { api_key_env: MISSING_KEY } },
    });
    await withStop.model.sendRequest(turns, 'SYS');
    expect(withStop.payloads[0]?.['stop']).toBe('***');

    // 'o3-mini' 命中 o3 → 旧适配器会删掉 stop，新路径必须一致。
    const noStop = capturingPi({
      model: { model: 'o3-mini', url: OFFLINE_URL, params: { api_key_env: MISSING_KEY } },
    });
    await noStop.model.sendRequest(turns, 'SYS');
    expect(noStop.payloads[0]?.['stop']).toBeUndefined();
  });

  it('profile.params 原样进请求体，接线字段被剔除', async () => {
    const { model, payloads } = capturingPi({
      model: {
        model: 'gpt-5.4',
        url: OFFLINE_URL,
        params: {
          api_key_env: MISSING_KEY,
          headers: { 'x-test': 'v' },
          thinking: { type: 'disabled' },
          temperature: 0.3,
        },
      },
    });
    await model.sendRequestWithTools(turns, 'SYS', [], 'auto');
    const payload = first(payloads);
    expect(payload['thinking']).toEqual({ type: 'disabled' });
    expect(payload['temperature']).toBe(0.3);
    expect(payload).not.toHaveProperty('api_key_env');
    expect(payload).not.toHaveProperty('headers');
  });
});
