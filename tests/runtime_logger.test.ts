/**
 * 结构化日志。
 *
 * 两条最要紧的性质：
 *  1. **同步写盘** —— 崩溃/被 kill 时最后几行必须还在（静默死亡最难查的就是这个）
 *  2. **永不抛** —— 日志是旁路，写不进去不许拖垮 agent
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_LIMIT, createLogger, describeError, nullLogger } from '../src/runtime/logger.js';

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

  it('默认 mirror：warn/error 真的打到 console（不注入 mirror 时）', () => {
    const dir = tempDir();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger({ dir });
    log.warn({ a: 1 });
    log.error({ a: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('目录建不出来也不抛（日志是旁路，不是主链路）', () => {
    // 拿一个**文件**当目录用：mkdirSync 必然失败（ENOTDIR），
    // 于是走到"日志不可用"那条兜底路径。
    const filePath = join(tempDir(), 'not-a-dir');
    writeFileSync(filePath, 'x');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger({ dir: join(filePath, 'logs') });
    expect(() => log.info({ a: 1 })).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    // 只提一次，不刷屏
    log.info({ a: 2 });
    expect(error).toHaveBeenCalledTimes(1);
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

  it('不带字段也能记（data 缺省）', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    log.info();
    const row = lines(log.file)[0] ?? {};
    expect(row['level']).toBe('info');
    expect(row['mod']).toBe('agent');
  });

  it('函数值走 String() 兜底（JSON.stringify 对函数返回 undefined）', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    log.info({ fn: (): void => {} });
    expect(String((lines(log.file)[0] ?? {})['fn'])).toContain('=>');
  });

  it('对象原样嵌套（短），超长则截断成文本', () => {
    const dir = tempDir();
    const log = createLogger({ dir });
    log.info({ obj: { a: 1, b: 'x' } });
    log.info({ obj: { big: 'y'.repeat(FIELD_LIMIT * 2) } });
    const rows = lines(log.file);
    // 短对象保持嵌套结构，读日志时不用再看一层转义
    expect(rows[0]?.['obj']).toEqual({ a: 1, b: 'x' });
    // 超长的退成截断文本
    const long = String(rows[1]?.['obj']);
    expect(long).toContain('[+');
    expect(long.length).toBeLessThan(FIELD_LIMIT + 40);
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

describe('describeError', () => {
  it('Error 取 message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('非 Error 走 String()（真机够不到，但抽出来就能钉住）', () => {
    expect(describeError('裸字符串')).toBe('裸字符串');
    expect(describeError(42)).toBe('42');
  });
});
