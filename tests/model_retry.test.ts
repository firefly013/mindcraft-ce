import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  MODEL_CIRCUIT_COOLDOWN_MS,
  MODEL_CIRCUIT_FAILURE_THRESHOLD,
  MODEL_RETRY_BASE_DELAY_MS,
  MODEL_RETRY_MAX_DELAY_MS,
  PiModel,
  isTransientModelFailure,
  modelRetryDelayMs,
  type ModelRetryInfo,
} from '../src/brain/runtime/model.js';
import {
  DEFAULT_MODEL_RETRIES,
  MODEL_RETRIES_ENV,
  resolveModelRetries,
  type ResolvedProvider,
} from '../src/brain/runtime/provider.js';

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function textMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-model',
    usage: ZERO_USAGE,
    stopReason: 'stop',
    timestamp: 0,
  } as unknown as AssistantMessage;
}

function errorMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-model',
    usage: ZERO_USAGE,
    stopReason: 'error',
    errorMessage: text,
    timestamp: 0,
  } as unknown as AssistantMessage;
}

type CompleteFn = (model: unknown, context: unknown, options: unknown) => Promise<AssistantMessage>;

function fakeResolved(complete: CompleteFn): ResolvedProvider {
  return {
    models: { complete } as unknown as ResolvedProvider['models'],
    model: {
      id: 'fake-model',
      name: 'fake-model',
      api: 'openai-completions',
      provider: 'fake',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: 10000,
      maxTokens: 1000,
    } as unknown as ResolvedProvider['model'],
    providerId: 'fake',
    apiKey: 'fake-key',
    headers: null,
    contextWindow: 10000,
    params: {},
  };
}

describe('模型重试配置', () => {
  it('默认 4 次，MINDCRAFT_MODEL_RETRIES 可覆盖，0 关闭', () => {
    expect(DEFAULT_MODEL_RETRIES).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_MODEL_RETRIES).toBeLessThanOrEqual(5);
    expect(resolveModelRetries({} as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_MODEL_RETRIES);
    expect(resolveModelRetries({ [MODEL_RETRIES_ENV]: '0' } as unknown as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveModelRetries({ [MODEL_RETRIES_ENV]: '3' } as unknown as NodeJS.ProcessEnv)).toBe(3);
    expect(resolveModelRetries({ [MODEL_RETRIES_ENV]: 'abc' } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MODEL_RETRIES,
    );
    expect(resolveModelRetries({ [MODEL_RETRIES_ENV]: '-1' } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MODEL_RETRIES,
    );
    expect(resolveModelRetries({ [MODEL_RETRIES_ENV]: '2.5' } as unknown as NodeJS.ProcessEnv)).toBe(
      DEFAULT_MODEL_RETRIES,
    );
  });

  it('可以显式给 fallback', () => {
    expect(resolveModelRetries({} as unknown as NodeJS.ProcessEnv, 1)).toBe(1);
  });
});

describe('瞬时错误分类', () => {
  it('网络、超时、5xx 返回 true', () => {
    for (const text of [
      'Connection error',
      'Request timed out',
      'fetch failed',
      'socket hang up',
      'ECONNRESET',
      'upstream connect error',
      '500 Internal Server Error',
      '502 Bad Gateway',
      '503 Service Unavailable',
    ]) {
      expect(isTransientModelFailure(text)).toBe(true);
    }
    expect(isTransientModelFailure({ status: 503 })).toBe(true);
    expect(isTransientModelFailure({ statusCode: 408 })).toBe(true);
  });

  it('鉴权、参数、额度等确定性错误返回 false', () => {
    expect(isTransientModelFailure('401 Unauthorized')).toBe(false);
    expect(isTransientModelFailure('Invalid API key')).toBe(false);
    expect(isTransientModelFailure('403 Forbidden')).toBe(false);
    expect(isTransientModelFailure('400 Bad Request: invalid parameter')).toBe(false);
    expect(isTransientModelFailure({ status: 400, message: 'network error disguised' })).toBe(false);
    expect(isTransientModelFailure({ code: 'auth', message: 'fetch failed' })).toBe(false);
    expect(isTransientModelFailure('GoUsageLimitError')).toBe(false);
    expect(isTransientModelFailure('insufficient_quota')).toBe(false);
  });
});

describe('重试退避与 jitter', () => {
  it('指数退避并叠加 50%-100% jitter，封顶 15s', () => {
    expect(modelRetryDelayMs(1, 1)).toBe(MODEL_RETRY_BASE_DELAY_MS);
    expect(modelRetryDelayMs(2, 1)).toBe(MODEL_RETRY_BASE_DELAY_MS * 2);
    expect(modelRetryDelayMs(3, 1)).toBe(MODEL_RETRY_BASE_DELAY_MS * 4);
    expect(modelRetryDelayMs(4, 1)).toBe(MODEL_RETRY_BASE_DELAY_MS * 8);
    expect(modelRetryDelayMs(10, 1)).toBe(MODEL_RETRY_MAX_DELAY_MS);
    expect(modelRetryDelayMs(1, 0)).toBe(MODEL_RETRY_BASE_DELAY_MS / 2);
    expect(modelRetryDelayMs(10, 0)).toBe(MODEL_RETRY_MAX_DELAY_MS / 2);
  });
});

describe('PiModel 瞬时重试', () => {
  it('网络错误后重试成功，日志写第几次与退避多久', async () => {
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? errorMessage('Connection error') : textMessage('hello ***');
    });
    const retryLog: ModelRetryInfo[] = [];
    const sleeps: number[] = [];
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 2,
        retryRandom: () => 1,
        retrySleep: async (delayMs) => { sleeps.push(delayMs); },
        onRetry: (info) => { retryLog.push(info); },
      },
    );

    await expect(model.sendRequest([], 'sys')).resolves.toBe('hello ');
    expect(calls).toBe(2);
    expect(retryLog).toEqual([
      {
        attempt: 1,
        maxRetries: 2,
        delayMs: MODEL_RETRY_BASE_DELAY_MS,
        errorMessage: 'Connection error',
      },
    ]);
    expect(sleeps).toEqual([MODEL_RETRY_BASE_DELAY_MS]);
  });

  it('5xx 重试到上限后回落，不无限重试', async () => {
    const complete = vi.fn(async () => errorMessage('503 Service Unavailable'));
    const retryLog: ModelRetryInfo[] = [];
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 2,
        retryRandom: () => 1,
        retrySleep: async () => {},
        onRetry: (info) => { retryLog.push(info); },
      },
    );

    await expect(model.sendRequest([], 'sys')).resolves.toBe('My brain disconnected, try again.');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(retryLog.map((info) => info.attempt)).toEqual([1, 2]);
    expect(retryLog.map((info) => info.delayMs)).toEqual([1000, 2000]);
  });

  it('鉴权错误不重试', async () => {
    const complete = vi.fn(async () => errorMessage('401 Unauthorized: Invalid API key'));
    const onRetry = vi.fn();
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 2,
        retrySleep: async () => {},
        onRetry,
      },
    );

    await expect(model.sendRequest([], 'sys')).resolves.toBe('My brain disconnected, try again.');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('抛出的网络异常也会重试', async () => {
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
      return textMessage('recovered');
    });
    const onRetry = vi.fn();
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 1,
        retrySleep: async () => {},
        onRetry,
      },
    );

    await expect(model.sendRequest([], 'sys')).resolves.toBe('recovered');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('默认日志记录第几次重试和退避时长', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? errorMessage('Request timed out') : textMessage('ok');
    });
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 1,
        retryRandom: () => 1,
        retrySleep: async () => {},
      },
    );

    await model.sendRequest([], 'sys');
    const logged = String(warn.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('retry 1/1');
    expect(logged).toContain('timed out');
    expect(logged).toContain('1000ms');
    warn.mockRestore();
  });

  it('连续瞬态失败先降频、再短暂熔断，避免请求风暴', async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const complete = vi.fn(async () => errorMessage('Connection error'));
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 0,
        circuitFailureThreshold: MODEL_CIRCUIT_FAILURE_THRESHOLD,
        circuitCooldownMs: MODEL_CIRCUIT_COOLDOWN_MS,
        circuitFirstDelayMs: 2000,
        retrySleep: async (delayMs) => { sleeps.push(delayMs); nowMs += delayMs; },
        now: () => nowMs,
        onRetry: () => {},
      },
    );

    await model.sendRequest([], 'sys');
    await model.sendRequest([], 'sys');
    await model.sendRequest([], 'sys');

    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, MODEL_CIRCUIT_COOLDOWN_MS]);
    const logs = warn.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
    expect(logs).toContain('next request delayed 2000ms');
    expect(logs).toContain('circuit open for ' + MODEL_CIRCUIT_COOLDOWN_MS + 'ms');
    warn.mockRestore();
  });

  it('降频后的第一次成功会重置连续失败计数', async () => {
    let nowMs = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const complete = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? errorMessage('Connection error') : textMessage('ok');
    });
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 0,
        circuitFailureThreshold: MODEL_CIRCUIT_FAILURE_THRESHOLD,
        circuitFirstDelayMs: 2000,
        retrySleep: async (delayMs) => { sleeps.push(delayMs); nowMs += delayMs; },
        now: () => nowMs,
        onRetry: () => {},
      },
    );

    await expect(model.sendRequest([], 'sys')).resolves.toBe('My brain disconnected, try again.');
    await expect(model.sendRequest([], 'sys')).resolves.toBe('ok');
    await expect(model.sendRequest([], 'sys')).resolves.toBe('ok');

    expect(complete).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000]);
  });

  it('sendRequestWithTools 同样走瞬时重试', async () => {
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? errorMessage('Connection error') : textMessage('tool ok');
    });
    const model = new PiModel(
      {},
      {
        resolvedProvider: fakeResolved(complete as unknown as CompleteFn),
        maxRetries: 1,
        retrySleep: async () => {},
        onRetry: () => {},
      },
    );

    await expect(model.sendRequestWithTools([], 'sys', [])).resolves.toEqual({
      text: 'tool ok',
      tool_calls: [],
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
