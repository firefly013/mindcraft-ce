import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKey, hasKey } from '../src/utils/keys.js';

const MARKER = 'MIGRATION_TEST_KEY_XYZ';
const FILE_KEY = 'MIGRATION_FILE_KEY_XYZ';

// 这个文件会往 CWD 写 ./keys.json 来测"文件优先"。开发者本机很可能有真的
// keys.json，所以先备份、收尾还原——以前是直接 rm，等于跑一次测试就把真 key 删了。
const KEYS_PATH = './keys.json';
const originalKeys = existsSync(KEYS_PATH) ? readFileSync(KEYS_PATH, 'utf8') : null;

afterEach(() => {
  Reflect.deleteProperty(process.env, MARKER);
  Reflect.deleteProperty(process.env, FILE_KEY);
  if (originalKeys == null) rmSync(KEYS_PATH, { force: true });
  else writeFileSync(KEYS_PATH, originalKeys, 'utf8');
});

describe('keys (no keys.json on disk)', () => {
  it('hasKey reads environment variables', () => {
    process.env[MARKER] = 'secret';
    expect(hasKey(MARKER)).toBe('secret');
  });

  it('hasKey returns undefined when missing', () => {
    expect(hasKey(MARKER)).toBeUndefined();
  });

  it('getKey returns the value', () => {
    process.env[MARKER] = 'secret';
    expect(getKey(MARKER)).toBe('secret');
  });

  it('getKey throws when missing everywhere', () => {
    expect(() => getKey(MARKER)).toThrow(`API key "${MARKER}" not found`);
  });
});

describe('keys (keys.json present)', () => {
  it('prefers keys.json over the environment', async () => {
    writeFileSync('./keys.json', JSON.stringify({ [FILE_KEY]: 'from-file' }), 'utf8');
    process.env[FILE_KEY] = 'from-env';
    vi.resetModules();
    const fresh = await import('../src/utils/keys.js');
    expect(fresh.hasKey(FILE_KEY)).toBe('from-file');
    expect(fresh.getKey(FILE_KEY)).toBe('from-file');
  });

  it('falls back to env when keys.json is corrupt', async () => {
    writeFileSync('./keys.json', '{not-json', 'utf8');
    process.env[MARKER] = 'secret';
    vi.resetModules();
    const fresh = await import('../src/utils/keys.js');
    expect(fresh.getKey(MARKER)).toBe('secret');
  });
});
