/**
 * 模型解析：profile 的引用 → pi-ai 的 `Models` / `Model`。
 *
 * 这一层的规矩：
 *   - 端点、模型窗口、采样参数来自 `providers.json`（内置目录里的 provider 直接用目录）；
 *   - 凭据按 `auth.json` → 环境变量 → 自建端点占位 的顺序解析；
 *   - 解析不到**抛错**，不再"退回该 provider 的第一个模型"。
 *
 * 全程不联网：用临时目录里的 providers.json / auth.json。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  providerApiKeyEnvName,
  readModelReference,
  resolveProvider,
} from '../src/brain/runtime/provider.js';
import { clearConfigValueCache } from '../src/shared/config/value.js';

const tempDirs: string[] = [];
const tempEnvNames: string[] = [];
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/go/v1';

afterEach(() => {
  clearConfigValueCache();
  for (const name of tempEnvNames.splice(0)) Reflect.deleteProperty(process.env, name);
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

interface Fixture {
  models: Record<string, unknown>;
  auth?: Record<string, unknown>;
  env?: Record<string, string>;
}

/** 把 providers.json / auth.json 写到临时目录，返回 resolveProvider 用的路径。 */
function fixture(files: Fixture): { providersPath: string; authPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mc-provider-'));
  tempDirs.push(dir);
  const providersPath = join(dir, 'providers.json');
  const authPath = join(dir, 'auth.json');
  writeFileSync(providersPath, JSON.stringify({ providers: files.models }, null, 2), 'utf8');
  if (files.auth != null) writeFileSync(authPath, JSON.stringify(files.auth, null, 2), 'utf8');
  for (const [name, value] of Object.entries(files.env ?? {})) {
    tempEnvNames.push(name);
    process.env[name] = value;
  }
  return { providersPath, authPath };
}

/** opencode-go 端点：providers.json 只补 header，key 放 auth.json。 */
function opencodeFixture(extra: Record<string, unknown> = {}): { providersPath: string; authPath: string } {
  return fixture({
    models: {
      'opencode-go': {
        baseUrl: OPENCODE_BASE_URL,
        headers: { 'x-opencode-session': '$MC_TEST_SESSION_ID' },
        ...extra,
      },
    },
    auth: { 'opencode-go': { type: 'api_key', key: 'sk-from-auth-json' } },
    env: { MC_TEST_SESSION_ID: 'session-abc' },
  });
}

describe('readModelReference', () => {
  it('"provider/model" 拆成两半', () => {
    expect(readModelReference({ model: 'opencode-go/deepseek-v4.1-flash' })).toEqual({
      providerId: 'opencode-go',
      modelId: 'deepseek-v4.1-flash',
    });
  });

  it('裸模型名没有 provider', () => {
    expect(readModelReference({ model: 'gpt-5.4' })).toEqual({ modelId: 'gpt-5.4' });
  });

  it('`openai/` 前缀会被剥掉（旧适配器的老规矩）', () => {
    expect(readModelReference({ model: 'openai/gpt-5.4' }).modelId).toBe('gpt-5.4');
  });

  it('对象形式只读 provider 和 model', () => {
    const reference = readModelReference({
      model: { provider: 'local', model: 'm' },
    });
    expect(reference).toEqual({ providerId: 'local', modelId: 'm' });
  });

  it('对象形式缺模型名 → 报错', () => {
    expect(() => readModelReference({ model: { provider: 'local' } })).toThrow(/模型名/);
  });
});

describe('内置供应商', () => {
  it('opencode-go：窗口、compat 都来自内置目录', () => {
    const paths = opencodeFixture();
    const resolved = resolveProvider({ name: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' }, paths);

    expect(resolved.providerId).toBe('opencode-go');
    expect(resolved.model.id).toBe('deepseek-v4.1-flash');
    expect(resolved.model.baseUrl).toBe(OPENCODE_BASE_URL);
    expect(resolved.contextWindow).toBe(1_000_000);
    expect(resolved.model.input).toContain('image');
    expect(resolved.model.compat).toMatchObject({
      thinkingFormat: 'deepseek',
      supportsStrictMode: true,
      maxTokensField: 'max_tokens',
    });
  });

  it('providers.json 的 header 经 $ENV 解析后进请求', () => {
    const paths = opencodeFixture();
    const resolved = resolveProvider({ model: 'opencode-go/deepseek-v4.1-flash' }, paths);
    expect(resolved.headers?.['x-opencode-session']).toBe('session-abc');
  });

  it('opencode 与 opencode-go 是两个端点', () => {
    const paths = fixture({
      models: { opencode: { baseUrl: 'https://opencode.ai/zen/v1' } },
      auth: { opencode: { type: 'api_key', key: 'sk-zen' } },
    });
    const resolved = resolveProvider({ model: 'opencode/deepseek-v4.1-flash' }, paths);
    expect(resolved.providerId).toBe('opencode');
    expect(resolved.model.baseUrl).toBe('https://opencode.ai/zen/v1');
  });

  it('openai：模型名照目录解析', () => {
    const paths = fixture({
      models: { openai: {} },
      auth: { openai: { type: 'api_key', key: 'sk-openai' } },
    });
    const resolved = resolveProvider({ model: 'openai/gpt-5.4' }, paths);
    expect(resolved.providerId).toBe('openai');
    expect(resolved.model.id).toBe('gpt-5.4');
  });
});

describe('providers.json 声明的端点和模型', () => {
  it('自建端点：占位 key + 声明里的窗口', () => {
    const paths = fixture({
      models: {
        local: {
          baseUrl: 'http://127.0.0.1:1234/v1',
          models: [{ id: 'qwen2.5-coder-7b', contextWindow: 32768, maxTokens: 4096 }],
        },
      },
    });
    const resolved = resolveProvider({ model: 'local/qwen2.5-coder-7b' }, paths);
    expect(resolved.providerId).toBe('local');
    expect(resolved.apiKey).toBe('not-needed');
    expect(resolved.contextWindow).toBe(32768);
    expect(resolved.model.maxTokens).toBe(4096);
  });

  it('不写 provider 时按模型 id 找声明它的 provider', () => {
    const paths = fixture({
      models: { local: { baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'm1' }] } },
    });
    expect(resolveProvider({ model: 'm1' }, paths).providerId).toBe('local');
  });

  it('modelOverrides 覆写内置目录的字段', () => {
    const paths = opencodeFixture({
      modelOverrides: { 'deepseek-v4.1-flash': { contextWindow: 500_000, maxTokens: 1234 } },
    });
    const resolved = resolveProvider({ model: 'opencode-go/deepseek-v4.1-flash' }, paths);
    expect(resolved.contextWindow).toBe(500_000);
    expect(resolved.model.maxTokens).toBe(1234);
  });

  it('模型定义里的 samplingParams 直接进入请求', () => {
    const paths = opencodeFixture({
      models: [{ id: 'deepseek-v4.1-flash', samplingParams: { thinking: { type: 'disabled' }, topP: 0.9 } }],
    });
    const resolved = resolveProvider({ model: 'opencode-go/deepseek-v4.1-flash' }, paths);
    expect(resolved.params).toEqual({ thinking: { type: 'disabled' }, topP: 0.9 });
  });
});

describe('解析失败一律抛错', () => {
  it('模型不在目录里，也不是声明的模型 → 报错并列出已知模型', () => {
    const paths = opencodeFixture();
    try {
      resolveProvider({ model: 'opencode-go/definitely-not-a-model' }, paths);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('definitely-not-a-model');
      expect(message).toContain('deepseek-v4.1-flash');
    }
  });

  it('写了 provider 但它既不是内置也没声明 → 报错', () => {
    const paths = fixture({ models: {} });
    expect(() => resolveProvider({ model: 'nobody/knows-this' }, paths)).toThrow(/未知 provider "nobody"/);
  });

  it('没写 provider 且 providers.json 里没有该模型 → 报错', () => {
    const paths = fixture({ models: { local: { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'm1' }] } } });
    try {
      resolveProvider({ model: 'knows-this' }, paths);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('找不到');
      expect(message).toContain('m1');
    }
  });

  it('非内置 provider 没有 baseUrl → 报错', () => {
    const paths = fixture({ models: { weird: {} } });
    expect(() => resolveProvider({ model: 'weird/m' }, paths)).toThrow(/baseUrl/);
  });

  it('没有凭据 → 报错，消息里列出 auth.json 和环境变量', () => {
    const paths = fixture({ models: { openai: {} } });
    try {
      resolveProvider({ model: 'openai/gpt-5.4' }, paths);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('auth.json');
      expect(message).toContain(providerApiKeyEnvName('openai'));
    }
  });

  it('内置 provider 即使声明了 baseUrl，缺 key 也报错（不给占位 key）', () => {
    // 占位 key 只对自建端点有意义：内置的是已知云服务，拿 "not-needed" 去请求
    // 只会在网关那边变成一个看不懂的 401。
    const paths = fixture({ models: { openai: { baseUrl: 'https://api.openai.com/v1' } } });
    try {
      resolveProvider({ model: 'openai/gpt-5.4' }, paths);
      expect.unreachable('应当抛错');
    } catch (error: unknown) {
      expect((error as Error).message).toContain('没有可用凭据');
    }
  });
});

describe('凭据解析顺序', () => {
  it('auth.json 提供凭据', () => {
    const paths = fixture({
      models: { openai: {} },
      auth: { openai: { type: 'api_key', key: 'sk-from-auth-json' } },
    });
    const resolved = resolveProvider({ model: 'openai/gpt-5.4' }, paths);
    expect(resolved.apiKey).toBe('sk-from-auth-json');
  });

  it('都没有时用 <PROVIDER>_API_KEY 环境变量', () => {
    const envName = providerApiKeyEnvName('some-custom');
    expect(envName).toBe('SOME_CUSTOM_API_KEY');
    process.env[envName] = 'sk-from-provider-env';
    const paths = fixture({ models: { 'some-custom': { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'm' }] } } });
    try {
      expect(resolveProvider({ model: 'some-custom/m' }, paths).apiKey).toBe('sk-from-provider-env');
    } finally {
      Reflect.deleteProperty(process.env, envName);
    }
  });

  it('auth.json 引用缺失的环境变量 → 报错（不是静默用占位）', () => {
    const paths = fixture({
      models: { openai: {} },
      auth: { openai: { type: 'api_key', key: '$MC_TEST_MISSING_OPENAI_KEY' } },
    });
    expect(() => resolveProvider({ model: 'openai/gpt-5.4' }, paths)).toThrow(/MC_TEST_MISSING_OPENAI_KEY/);
  });

  it('凭据真的交给了 pi-ai：getAuth 能解析出 key', async () => {
    const paths = opencodeFixture();
    const resolved = resolveProvider({ model: 'opencode-go/deepseek-v4.1-flash' }, paths);
    const auth = await resolved.models.getAuth(resolved.model);
    expect(auth?.auth.apiKey).toBe('sk-from-auth-json');
  });

  it('自建端点的占位 key 也能被 pi-ai 解析出来', async () => {
    const paths = fixture({
      models: { local: { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'm' }] } },
    });
    const resolved = resolveProvider({ model: 'local/m' }, paths);
    const auth = await resolved.models.getAuth(resolved.model);
    expect(auth?.auth.apiKey).toBe('not-needed');
  });
});
