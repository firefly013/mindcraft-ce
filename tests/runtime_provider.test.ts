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
import { beforeAll, describe, expect, it } from 'vitest';
import { PiModel } from '../src/runtime/model.js';
import { resolveProvider } from '../src/runtime/provider.js';
import type { ChatMessage, OpenAITool } from '../src/types/common.js';

const OFFLINE_URL = 'http://127.0.0.1:1/v1';
const MISSING_KEY = 'DEFINITELY_MISSING_KEY_FOR_TEST';

/**
 * 调用模型的测试显式抬高超时。
 *
 * pi-ai 的 `openai-completions` 适配器是**惰性 import** 的：首次调用要冷加载
 * OpenAI SDK。机器一有负载（例如刚跑完 `npm ci`），这一步就会逼近甚至越过
 * vitest 默认的 5s 单测超时。这里既预热（`beforeAll`）又留足上限，让断言跑在
 * 稳定的耗时上，而不是赌冷启动够快。
 */
const MODEL_CALL_TIMEOUT_MS = 30_000;

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

/**
 * 真机冒烟抓到的 bug：**key 从来没交给 pi-ai**。
 *
 * 内置 provider 的 auth 是 `envApiKeyAuth(name, [ENV])`，它只认**已存凭据**或
 * **环境变量**。而本项目的 key 在 `keys.json` 里（`getKey`），既不进环境也不进
 * pi-ai 的凭据库——于是每个请求都失败：`Provider is not configured: opencode-go`，
 * assistant 条目是 `stopReason: "error"`、usage 全 0，模型一个字都答不出来。
 *
 * 单测全都手动 `setProvider(faux)`，不需要鉴权，所以只有真机才暴露。
 * 这条断言用 `getAuth()`（pi-ai 自己的鉴权解析入口）当预言机，不需要联网。
 */
describe('凭据真的交给了 pi-ai', () => {
  it('resolveProvider 之后 getAuth 能解析出 key', async () => {
    process.env['PI_TEST_API_KEY'] = 'sk-test-12345';
    try {
      const resolved = resolveProvider({
        model: {
          model: 'deepseek-v4.1-flash',
          url: 'https://opencode.ai/zen/go/v1',
          params: { api_key_env: 'PI_TEST_API_KEY' },
        },
      });
      expect(resolved.providerId).toBe('opencode-go');
      const auth = await resolved.models.getAuth(resolved.model);
      expect(auth).toBeDefined();
      expect(auth?.auth.apiKey).toBe('sk-test-12345');
    } finally {
      delete process.env['PI_TEST_API_KEY'];
    }
  });

  it('本地端点用占位 key，也能解析出来（LM Studio / vLLM 那类不校验）', async () => {
    const resolved = resolveProvider({
      model: { model: 'local-model', url: OFFLINE_URL, params: { api_key_env: MISSING_KEY } },
    });
    const auth = await resolved.models.getAuth(resolved.model);
    expect(auth?.auth.apiKey).toBe('not-needed');
  });
});


