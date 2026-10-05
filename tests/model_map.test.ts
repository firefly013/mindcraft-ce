import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createModel, selectAPI } from '../src/models/_model_map.js';
import type { AgentProfile } from '../src/types/common.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, '..', 'src', 'models');

const profile = (over: Record<string, unknown> = {}): AgentProfile =>
  ({ name: 'test', model: 'x', ...over }) as AgentProfile;

describe('selectAPI', () => {
  it('accepts a bare model string', () => {
    expect(selectAPI('ollama/llama3')).toEqual(
      expect.objectContaining({ api: 'ollama', model: 'llama3' }),
    );
  });

  it('accepts a String object too (legacy path)', () => {
    // `no-new-wrappers` is not enabled repo-wide; the wrapper is intentional here.
    const out = selectAPI(new String('ollama/llama3') as unknown as string);
    expect(out.api).toBe('ollama');
  });

  it('rewrites the legacy local prefix to ollama', () => {
    // 'local/llama3' -> api 'ollama', then the api prefix is stripped: 'llama3'
    expect(selectAPI(profile({ model: 'local/llama3' }))).toMatchObject({
      api: 'ollama',
      model: 'llama3',
    });
    expect(selectAPI(profile({ api: 'local', model: 'm' }))).toMatchObject({
      api: 'ollama',
      model: 'm',
    });
    // empty model: no replacement to run, ends up as the api default
    expect(selectAPI(profile({ api: 'local', model: '' })).model).toBeNull();
  });

  it('keeps an explicit api and strips its prefix from the model', () => {
    expect(selectAPI(profile({ api: 'openai', model: 'openai/gpt-4' }))).toMatchObject({
      api: 'openai',
      model: 'gpt-4',
    });
  });

  it('nulls the model when it only names the api', () => {
    const out = selectAPI(profile({ api: 'openai', model: 'openai/' }));
    expect(out.model).toBeNull();
  });

  it.each([
    ['gpt-4o', 'openai'],
    ['o1-mini', 'openai'],
    ['o3-mini', 'openai'],
    ['claude-opus', 'anthropic'],
    ['gemini-flash', 'google'],
    ['grok-beta', 'xai'],
    ['mistral-large', 'mistral'],
    ['deepseek-chat', 'deepseek'],
    ['qwen-max', 'qwen'],
  ])('infers %s -> %s without a prefix', (model, api) => {
    expect(selectAPI(profile({ model })).api).toBe(api);
  });

  it('infers by substring even when no registered prefix matches', () => {
    // 'my-*' matches no apiMap prefix, so these must fall through to the
    // substring inference chain (a startsWith-only mutant would throw here).
    expect(selectAPI(profile({ model: 'my-mistral-model' })).api).toBe('mistral');
    expect(selectAPI(profile({ model: 'my-deepseek-model' })).api).toBe('deepseek');
    expect(selectAPI(profile({ model: 'my-qwen-model' })).api).toBe('qwen');
  });

  it('throws exact errors for unknown models and apis', () => {
    expect(() => selectAPI(profile({ model: 'zzz-nope' }))).toThrow('Unknown model: zzz-nope');
    expect(() => selectAPI(profile({ api: 'zzz-nope', model: 'm' }))).toThrow(
      'Unknown api: zzz-nope',
    );
  });
});

describe('provider registry (directory-driven)', () => {
  it('routes every discovered prefix to selectAPI', async () => {
    const files = (await fs.readdir(MODELS_DIR)).filter(
      (f) => f.endsWith('.ts') && f !== '_model_map.ts' && f !== 'prompter.ts',
    );
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const mod = (await import(`../src/models/${file}`)) as Record<string, unknown>;
      const prefixes: string[] = [];
      for (const exported of Object.values(mod)) {
        if (
          typeof exported === 'function' &&
          Object.prototype.hasOwnProperty.call(exported, 'prefix')
        ) {
          const prefix = (exported as unknown as { prefix?: unknown }).prefix;
          if (typeof prefix === 'string' && prefix.length > 0) prefixes.push(prefix);
        }
      }
      expect(prefixes.length, file).toBeGreaterThan(0);
      for (const prefix of prefixes) {
        // Renaming/removing a prefix must break model routing loudly.
        expect(selectAPI(profile({ model: `${prefix}/some-model` })).api).toBe(prefix);
      }
    }
  });
});

describe('createModel', () => {
  it('builds the default model when the model value only names the api', () => {
    const model = createModel(profile({ api: 'ollama', model: 'ollama' }));
    expect(model.constructor.name).toBe('Ollama');
    expect(typeof model.sendRequest).toBe('function');
  });

  it('builds the api default model when the model is already null', () => {
    const model = createModel(profile({ api: 'ollama', model: null }));
    expect(model.constructor.name).toBe('Ollama');
  });

  it('throws exact errors for unknown and missing apis', () => {
    expect(() => createModel(profile({ api: 'zzz-nope', model: 'm' }))).toThrow(
      'Unknown api: zzz-nope',
    );
    expect(() => createModel(profile({ model: 'm' }))).toThrow('Unknown api: undefined');
  });
});

describe('registry resilience', () => {
  const BAD = path.join(MODELS_DIR, 'zz_probe_bad.ts');
  const BROKEN = path.join(MODELS_DIR, 'zz_probe_broken.ts');
  const BROKEN_STR = path.join(MODELS_DIR, 'zz_probe_broken_str.ts');

  // A broken provider file must never take down model routing for the rest.
  it('survives unloadable modules and malformed prefixes', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    writeFileSync(
      BAD,
      'export function helper(): number { return 1; }\n' +
        'export function empty(): void {}\n' +
        'export function numeric(): void {}\n' +
        "(empty as unknown as { prefix: string }).prefix = '';\n" +
        "(numeric as unknown as { prefix: unknown }).prefix = 42;\n",
      'utf8',
    );
    writeFileSync(BROKEN, "throw new Error('probe failure');\n", 'utf8');
    writeFileSync(BROKEN_STR, "throw 'plain probe failure';\n", 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      vi.resetModules();
      const fresh = await import('../src/models/_model_map.js');
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
      // healthy providers still route
      expect(fresh.selectAPI(profile({ model: 'ollama/m' })).api).toBe('ollama');
      expect(fresh.selectAPI(profile({ model: 'openai/gpt-4' })).api).toBe('openai');
    } finally {
      warn.mockRestore();
      rmSync(BAD, { force: true });
      rmSync(BROKEN, { force: true });
      rmSync(BROKEN_STR, { force: true });
      vi.resetModules();
    }
  });
});
