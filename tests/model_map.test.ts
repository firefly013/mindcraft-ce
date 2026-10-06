/**
 * 供应商注册表契约：**只有一个** OpenAI 兼容适配器。
 *
 * 这里把"单一供应商"当成契约来锁：
 *   - 模型名不再需要前缀，任何名字都落到同一个 provider；
 *   - 显式 `api` 指向不存在的供应商要报错，不能静默兜底；
 *   - 目录里多出第二个适配器要立刻失败（这是我们主动收窄的决定）。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createModel, discoverModels, selectAPI } from '../src/models/_model_map.js';
import type { AgentProfile } from '../src/types/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, '..', 'src', 'models');

const profile = (over: Record<string, unknown> = {}): AgentProfile =>
  ({ name: 'test', model: 'x', ...over }) as AgentProfile;

// createModel 会真的 new 一个适配器，需要 key 存在（不联网，只是构造）。
const KEY = 'OPENAI_API_KEY';
const savedKey = process.env[KEY];
beforeAll(() => {
  process.env[KEY] = 'vitest-key';
});
afterAll(() => {
  if (savedKey === undefined) Reflect.deleteProperty(process.env, KEY);
  else process.env[KEY] = savedKey;
});

describe('selectAPI', () => {
  it('accepts a bare model string and routes it to the only provider', () => {
    expect(selectAPI('deepseek-v4.1-flash')).toEqual(
      expect.objectContaining({ api: 'openai', model: 'deepseek-v4.1-flash' }),
    );
  });

  it('accepts a String object too (legacy path)', () => {
    // `no-new-wrappers` is not enabled repo-wide; the wrapper is intentional here.
    const out = selectAPI(new String('gpt-5.4') as unknown as string);
    expect(out.api).toBe('openai');
  });

  it('keeps an explicit api and strips its prefix from the model', () => {
    expect(selectAPI(profile({ api: 'openai', model: 'openai/gpt-4' }))).toMatchObject({
      api: 'openai',
      model: 'gpt-4',
    });
  });

  it('nulls the model when it only names the api', () => {
    expect(selectAPI(profile({ api: 'openai', model: 'openai/' })).model).toBeNull();
  });

  it.each([
    'gpt-4o',
    'o1-mini',
    'claude-opus',
    'gemini-flash',
    'grok-beta',
    'mistral-large',
    'deepseek-chat',
    'qwen-max',
    'my-mistral-model',
    'zzz-nope',
  ])('routes %s to the single provider without a prefix', (model) => {
    expect(selectAPI(profile({ model })).api).toBe('openai');
  });

  it('strips a leading openai/ prefix but leaves other slashes alone', () => {
    expect(selectAPI(profile({ model: 'openai/gpt-4o' })).model).toBe('gpt-4o');
    // 单一供应商下没有别的前缀可认，整串原样当模型名。
    expect(selectAPI(profile({ model: 'vendor/model' })).model).toBe('vendor/model');
  });

  it('only strips the api prefix at the START of the string', () => {
    // 回归线：以前用 replace('openai/','')，会吃掉串中间的 "openai/"。
    expect(selectAPI(profile({ model: 'my-openai/proxy' })).model).toBe('my-openai/proxy');
    expect(selectAPI(profile({ model: 'vendor/openai/gpt-4' })).model).toBe('vendor/openai/gpt-4');
  });

  it('tolerates a profile with no model field (falls back to the provider default)', () => {
    const out = selectAPI({ name: 'x', api: 'openai' } as AgentProfile);
    expect(out.api).toBe('openai');
    expect(out.model).toBeNull();
  });

  it('throws for an api that is not registered', () => {
    expect(() => selectAPI(profile({ api: 'zzz-nope', model: 'm' }))).toThrow(
      'Unknown api: zzz-nope',
    );
    // 以前的 ollama/anthropic 等供应商已经不存在，必须是硬错误而不是静默兜底。
    expect(() => selectAPI(profile({ api: 'ollama', model: 'm' }))).toThrow('Unknown api: ollama');
  });
});

describe('provider registry (directory-driven)', () => {
  it('discovers exactly one adapter, and it is the OpenAI-compatible one', async () => {
    const files = (await fs.readdir(MODELS_DIR)).filter(
      (f) => f.endsWith('.ts') && f !== '_model_map.ts' && f !== 'prompter.ts',
    );
    expect(files).toEqual(['gpt.ts']);
    const mod = (await import('../src/models/gpt.js')) as Record<string, unknown>;
    const prefixes = Object.values(mod)
      .filter((exported) => typeof exported === 'function' && 'prefix' in exported)
      .map((exported) => (exported as unknown as { prefix: string }).prefix);
    expect(prefixes).toEqual(['openai']);
    // 改名/换前缀必须让路由立刻炸掉。
    expect(selectAPI(profile({ model: 'openai/some-model' })).api).toBe('openai');
  });
});

describe('createModel', () => {
  it('builds the provider default model when the model value only names the api', () => {
    const model = createModel(profile({ api: 'openai', model: 'openai' }));
    expect(model.constructor.name).toBe('GPT');
    expect(typeof model.sendRequest).toBe('function');
  });

  it('builds the api default model when the model is already null', () => {
    const model = createModel(profile({ api: 'openai', model: null }));
    expect(model.constructor.name).toBe('GPT');
  });

  it('throws exact errors for unknown and missing apis', () => {
    expect(() => createModel(profile({ api: 'zzz-nope', model: 'm' }))).toThrow(
      'Unknown api: zzz-nope',
    );
    expect(() => createModel(profile({ model: 'm' }))).toThrow('Unknown api: undefined');
  });
});

describe('registry resilience', () => {
  // A broken provider file must never take down model routing for the rest.
  // 探针建在系统临时目录：源码树保持干净（中断也不会在 src/models 里留东西）。
  it('survives unloadable modules and malformed prefixes', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const probeDir = mkdtempSync(path.join(tmpdir(), 'mindcraft-models-'));
    const write = (name: string, body: string): void =>
      writeFileSync(path.join(probeDir, name), body, 'utf8');
    write('good.ts', "export class Probe { static prefix = 'probe'; }\n");
    write(
      'zz_probe_bad.ts',
      'export function helper(): number { return 1; }\n' +
        'export function empty(): void {}\n' +
        'export function numeric(): void {}\n' +
        "(empty as unknown as { prefix: string }).prefix = '';\n" +
        "(numeric as unknown as { prefix: unknown }).prefix = 42;\n",
    );
    write('zz_probe_broken.ts', "throw new Error('probe failure');\n");
    write('zz_probe_broken_str.ts', "throw 'plain probe failure';\n");
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const map = await discoverModels(probeDir);
      expect(warn).toHaveBeenCalledWith(
        'Failed to load model module:',
        'zz_probe_broken.ts',
        'probe failure',
      );
      // non-Error throws are stringified instead
      expect(warn).toHaveBeenCalledWith(
        'Failed to load model module:',
        'zz_probe_broken_str.ts',
        'plain probe failure',
      );
      // 坏文件与畸形 prefix 都不进表；健康模块照常发现。
      expect(Object.keys(map)).toEqual(['probe']);
      // 真实注册表没被探针影响
      expect(selectAPI(profile({ model: 'openai/gpt-4' })).api).toBe('openai');
      expect(selectAPI(profile({ model: 'anything-else' })).api).toBe('openai');
    } finally {
      warn.mockRestore();
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
