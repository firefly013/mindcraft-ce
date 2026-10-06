/**
 * 唯一供应商（OpenAI 兼容适配器）契约：
 *   - profile 的 `url` / `params.headers` / `params.api_key_env` 怎么落到客户端；
 *   - `headers` 与 `api_key_env` 是接线字段，绝不能混进请求体；
 *   - `params` 其余键原样进 body（如 `thinking`）；
 *   - `liveImage` 与 Live 快照落在同一条 user 消息（多模态数组）；
 *   - tool_calls 归一化。
 * client 直接注入，不联网、也不需要真 key。
 */
import { describe, expect, it } from 'vitest';
import { GPT } from '../src/models/gpt.js';

interface Seen {
  body: Record<string, unknown>;
}

function stubbed(opts: { model?: string | null; url?: string; params?: Record<string, unknown> } = {}): {
  model: GPT;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const client = {
    chat: {
      completions: {
        create: (body: Record<string, unknown>) => {
          seen.push({ body });
          return Promise.resolve({
            choices: [
              {
                message: {
                  content: 'hi',
                  tool_calls: [{ id: '1', function: { name: 'Finish', arguments: '{"a":1}' } }],
                },
              },
            ],
          });
        },
      },
    },
  };
  const model = new GPT(opts.model ?? 'gpt-5.4', opts.url, opts.params, client as never);
  return { model, seen };
}

describe('OpenAI-compatible provider wiring', () => {
  it('puts url and headers on the client, and keeps them out of the body', async () => {
    const { model, seen } = stubbed({
      url: 'https://gateway.example/v1',
      params: {
        api_key_env: 'SOME_KEY',
        headers: { 'x-opencode-session': 'mindcraft' },
        thinking: { type: 'disabled' },
      },
    });

    expect(model.clientOptions['baseURL']).toBe('https://gateway.example/v1');
    expect(model.clientOptions['defaultHeaders']).toEqual({ 'x-opencode-session': 'mindcraft' });

    await model.sendRequestWithTools([], 'SYS', [], 'auto', '');
    const body = seen[0]?.body as Record<string, unknown>;
    // 其余 params 原样进 body。
    expect(body['thinking']).toEqual({ type: 'disabled' });
    // 接线字段不能漏进 body。
    expect('headers' in body).toBe(false);
    expect('api_key_env' in body).toBe(false);
    expect('apiKey' in body).toBe(false);
  });

  it('is generic: no url means the default OpenAI endpoint', () => {
    const { model } = stubbed();
    expect(model.clientOptions['baseURL']).toBeUndefined();
    expect(model.clientOptions['apiKey']).toBeUndefined(); // client 注入时不查 key
  });

  it('normalises tool_calls into {id,name,args}', async () => {
    const { model } = stubbed();
    const res = await model.sendRequestWithTools([{ role: 'user', content: 'hi' }], 'SYS', [], 'auto', '');
    expect(res.text).toBe('hi');
    expect(res.tool_calls).toEqual([{ id: '1', name: 'Finish', args: { a: 1 } }]);
  });

  it('unparseable tool arguments degrade to {} instead of throwing', async () => {
    const client = {
      chat: {
        completions: {
          create: () =>
            Promise.resolve({
              choices: [{ message: { content: '', tool_calls: [{ id: '9', function: { name: 'Say', arguments: '{not json' } }] } }],
            }),
        },
      },
    };
    const model = new GPT('gpt-5.4', undefined, undefined, client as never);
    const res = await model.sendRequestWithTools([], 'SYS', [], 'auto', '');
    expect(res.tool_calls).toEqual([{ id: '9', name: 'Say', args: {} }]);
  });

  it('attaches the live snapshot and the round screenshot to one tail user message', async () => {
    const { model, seen } = stubbed();
    await model.sendRequestWithTools([], 'SYS', [], 'auto', 'SNAP', 'QUJD');
    const messages = (seen[0]?.body as Record<string, unknown>)['messages'] as Array<{
      role: string;
      content: unknown;
    }>;
    const last = messages[messages.length - 1]?.content as Array<Record<string, unknown>>;
    expect(Array.isArray(last)).toBe(true);
    expect(last[0]).toMatchObject({ type: 'text' });
    expect(String(last[0]?.['text'])).toContain('SNAP');
    const img = last[1] as { type?: string; image_url?: { url?: string } };
    expect(img.type).toBe('image_url');
    expect(img.image_url?.url).toBe('data:image/jpeg;base64,QUJD');
  });

  it('still sends the snapshot as plain text when there is no screenshot', async () => {
    const { model, seen } = stubbed();
    await model.sendRequestWithTools([], 'SYS', [], 'auto', 'SNAP', null);
    const messages = (seen[0]?.body as Record<string, unknown>)['messages'] as Array<{
      role: string;
      content: unknown;
    }>;
    const last = messages[messages.length - 1] as { role: string; content: unknown };
    expect(last.role).toBe('user');
    expect(typeof last.content).toBe('string');
    expect(String(last.content)).toContain('SNAP');
  });

  it('sends the tail verbatim, without wrapping it in its own header', async () => {
    const { model, seen } = stubbed();
    await model.sendRequestWithTools([], 'SYS', [], 'auto', '## 事件\n#1 World/L5 {}');
    const messages = (seen[0]?.body as Record<string, unknown>)['messages'] as Array<{ content: unknown }>;
    expect(messages[messages.length - 1]?.content).toBe('## 事件\n#1 World/L5 {}');
  });
});

describe('headers and keys', () => {
  const headersOf = (model: GPT): Record<string, string> =>
    (model.clientOptions['defaultHeaders'] ?? {}) as Record<string, string>;

  it('expands ${VAR} from the environment, otherwise mints a fresh UUID per instance', () => {
    Reflect.deleteProperty(process.env, 'MINDCRAFT_TEST_SESSION');
    const opts = { headers: { 'x-session': '${MINDCRAFT_TEST_SESSION}' } };
    const a = new GPT('m', 'http://127.0.0.1:1/v1', opts);
    const b = new GPT('m', 'http://127.0.0.1:1/v1', opts);
    expect(headersOf(a)['x-session']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headersOf(a)['x-session']).not.toBe(headersOf(b)['x-session']);

    process.env['MINDCRAFT_TEST_SESSION'] = 'shared-session';
    try {
      const c = new GPT('m', 'http://127.0.0.1:1/v1', opts);
      expect(headersOf(c)['x-session']).toBe('shared-session');
    } finally {
      Reflect.deleteProperty(process.env, 'MINDCRAFT_TEST_SESSION');
    }
  });

  it('uses a placeholder key for a local endpoint with no key configured', () => {
    // 本地兼容端点（LM Studio / vLLM / Ollama 兼容口）不校验 key。
    // 这些以前各有专属适配器、根本不读 key；收敛后不能因此崩在构造期。
    // 显式指定一个不存在的 key 变量，测试就不依赖跑测机器的环境。
    const model = new GPT('qwen2.5-7b-instruct', 'http://127.0.0.1:1234/v1', {
      api_key_env: 'DEFINITELY_MISSING_KEY_FOR_TEST',
    });
    expect(model.clientOptions['apiKey']).toBe('not-needed');
    expect(model.clientOptions['baseURL']).toBe('http://127.0.0.1:1234/v1');
  });

  it('still refuses the official endpoint when the named key variable is missing', () => {
    expect(
      () => new GPT('gpt-5.4', undefined, { api_key_env: 'DEFINITELY_MISSING_KEY_FOR_TEST' }),
    ).toThrow(/API key/);
  });
});
