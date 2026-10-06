/**
 * 结构化日志。
 *
 * 两条最要紧的性质：
 *  1. **同步写盘** —— 崩溃/被 kill 时最后几行必须还在（静默死亡最难查的就是这个）
 *  2. **永不抛** —— 日志是旁路，写不进去不许拖垮 agent
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_LIMIT, createLogger, nullLogger } from '../src/runtime/logger.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-log-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
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

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('createLogger', () => {
  it('一行一个 JSON，带 ts / level / mod 与自定义字段', () => {
    const dir = tempDir();
    const log = createLogger({ dir, now: () => new Date('2026-10-06T12:00:00.000Z') });
    log.with('tool').info({ name: 'goToSurface', ms: 12 });

    const rows = lines(log.file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ts: '2026-10-06T12:00:00.000Z',
      level: 'info',
      mod: 'tool',
      name: 'goToSurface',
      ms: 12,
    });
  });

  it('文件名按天：agent-YYYYMMDD.log', () => {
    const dir = tempDir();
    const log = createLogger({ dir, now: () => new Date(2026, 9, 6) });
    expect(log.file.endsWith('agent-20261006.log')).toBe(true);
  });

  it('**同步写盘**：调用返回时文件里已经有了（崩溃不丢）', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    log.with('lifecycle').error({ event: 'exit', code: 1 });
    // 没有任何 await / flush：立即读就该读到
    expect(existsSync(log.file)).toBe(true);
    expect(lines(log.file)[0]).toMatchObject({ event: 'exit', code: 1 });
  });

  it('追加不覆盖', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    log.info({ n: 1 });
    log.info({ n: 2 });
    expect(lines(log.file).map((r) => r['n'])).toEqual([1, 2]);
  });

  it('warn / error 镜像到 stdout，debug / info 不镜像', () => {
    const dir = tempDir();
    const mirrored: string[] = [];
    const log = createLogger({ dir, mirror: (level, line) => mirrored.push(`${level}:${line}`) });

    log.debug({ a: 1 });
    log.info({ a: 2 });
    log.warn({ a: 3 });
    log.error({ a: 4 });

    expect(mirrored).toHaveLength(2);
    expect(mirrored[0]).toContain('warn');
    expect(mirrored[1]).toContain('error');
    // 四条都落盘了
    expect(lines(log.file)).toHaveLength(4);
  });

  it('超长字段被截断（日志要能读，不能一行几 MB）', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    log.info({ big: 'x'.repeat(FIELD_LIMIT * 3) });
    const row = lines(log.file)[0] ?? {};
    const value = String(row['big']);
    expect(value.length).toBeLessThan(FIELD_LIMIT + 40);
    expect(value).toContain('[+');
  });

  it('循环引用不抛，降级成标记', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => log.info({ circular })).not.toThrow();
    expect(lines(log.file)).toHaveLength(1);
  });

  it('目录建不出来也不抛（日志是旁路，不是主链路）', () => {
    const file = join(tempDir(), 'not-a-dir');
    const log = createLogger({ dir: join(file, 'logs') });
    expect(() => log.info({ a: 1 })).not.toThrow();
  });

  it('顶层方法默认 mod=agent，with() 换模块名', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    log.info({ a: 1 });
    log.with('provider').info({ a: 2 });
    const rows = lines(log.file);
    expect(rows[0]?.['mod']).toBe('agent');
    expect(rows[1]?.['mod']).toBe('provider');
  });
});

describe('nullLogger', () => {
  it('什么都不做，也不抛', () => {
    const log = nullLogger();
    expect(() => {
      log.info({ a: 1 });
      log.with('x').error({ b: 2 });
    }).not.toThrow();
    expect(log.file).toBe('');
  });
});
