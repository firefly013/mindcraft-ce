import { rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKey, hasKey } from '../src/utils/keys.js';

const MARKER = 'MIGRATION_TEST_KEY_XYZ';
const FILE_KEY = 'MIGRATION_FILE_KEY_XYZ';

afterEach(() => {
  Reflect.deleteProperty(process.env, MARKER);
  Reflect.deleteProperty(process.env, FILE_KEY);
  rmSync('./keys.json', { force: true });
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
