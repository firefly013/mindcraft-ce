/**
 * 结构化日志：一行一个 JSON，落到 `bots/<name>/logs/agent-YYYYMMDD.log`。
 *
 * ## 为什么另起一套，而不是继续 console.log
 *
 * 项目里有 130 处 `console.log/warn/error`，散在 21 个文件里，**没有级别、
 * 没有时间戳、没有模块名**，还和第三方库的输出混在一起。真机排错时几乎没法用：
 * 最严重的一次 bug（42 轮请求全部 `stopReason:"error"`，模型一个字答不出来）
 * 在 stdout 上一个字都没有，只能翻 SQLite 才看得见。
 *
 * ## 为什么用 appendFileSync（同步、无缓冲）
 *
 * **崩溃/被 kill 时最后几行必须还在**。异步写盘在 `process.exit` 或强杀时会丢
 * 掉缓冲区里的内容——而"最后几行"恰恰是排错最需要的。同步写的代价是每行一次
 * 系统调用，对这个量级（每轮请求几十行）完全可接受。
 *
 * ## 铁律：日志永远不许拖垮 agent
 *
 * 写不进去就吞掉（最多往 stderr 提一句）。日志是旁路，不是主链路。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 单条字段的序列化上限：日志要能读，不能把一行撑成几 MB。 */
export const FIELD_LIMIT = 2_000;

export interface LoggerOptions {
  /** 落盘目录，通常是 `./bots/<name>/logs`。 */
  dir: string;
  /** 注入时钟（测试用）。 */
  now?: () => Date;
  /** 注入 stdout 镜像（测试用；默认 warn/error 走 console）。 */
  mirror?: (level: LogLevel, line: string) => void;
}

export interface ModuleLogger {
  debug(data?: Record<string, unknown>): void;
  info(data?: Record<string, unknown>): void;
  warn(data?: Record<string, unknown>): void;
  error(data?: Record<string, unknown>): void;
}

export interface Logger extends ModuleLogger {
  /** 固定模块名，省得每行都写一遍。 */
  with(mod: string): ModuleLogger;
  /** 当前落盘文件（诊断用）。 */
  readonly file: string;
}

/**
 * 把任意抛出物转成一行可读文本。
 *
 * 单独抽出来是为了**能把它测干净**：内联写
 * `error instanceof Error ? error.message : String(error)` 时，非 Error 那条
 * 分支在真机上够不到（fs 只抛 Error），留着就是死分支、覆盖率也钉不住。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把任意值压成一行可读的短文本。
 *
 * 对象**原样嵌套**（日志更好读），但只在那确实能序列化时——`JSON.stringify`
 * 对函数 / symbol 返回 `undefined`，原样放回去会让整个字段从 JSON 行里
 * **消失**（`JSON.stringify` 会丢掉值为 undefined 的键），排错时看到的就是
 * "字段没了"。
 */
function short(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length <= FIELD_LIMIT
      ? value
      : `${value.slice(0, FIELD_LIMIT)}…[+${value.length - FIELD_LIMIT}]`;
  }
  let text: string;
  try {
    const json = JSON.stringify(value);
    // 函数 / symbol：JSON 里根本表示不出来，退成源码文本。
    if (json == null) return String(value);
    text = json;
  } catch {
    return '[unserializable]';
  }
  if (text.length <= FIELD_LIMIT) return value;
  return `${text.slice(0, FIELD_LIMIT)}…[+${text.length - FIELD_LIMIT}]`;
}

function dayStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? ((): Date => new Date());
  const mirror =
    options.mirror ??
    ((level: LogLevel, line: string): void => {
      // 只有 warn/error 镜像到 stdout：debug/info 太吵，而且主日志已经全有了。
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
    });

  const file = join(options.dir, `agent-${dayStamp(now())}.log`);
  let ready = false;

  const write = (level: LogLevel, mod: string, data?: Record<string, unknown>): void => {
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      mod,
    };
    for (const [key, value] of Object.entries(data ?? {})) record[key] = short(value);
    // `short()` 保证每个值都能序列化（长/循环/抛错的一律降级成字符串），
    // 所以这里不需要再兜一层 try——那是够不到的分支。
    const line = JSON.stringify(record);
    try {
      if (!ready) {
        mkdirSync(options.dir, { recursive: true });
        ready = true;
      }
      appendFileSync(file, `${line}\n`);
    } catch (error: unknown) {
      // 日志写不进去不许拖垮 agent。只在第一次说一声，免得刷屏。
      if (!ready) {
        ready = true;
        console.error('agent log unavailable:', describeError(error));
      }
    }
    if (level === 'warn' || level === 'error') {
      mirror(level, `[${level}] ${mod} ${line}`);
    }
  };

  const at = (mod: string): ModuleLogger => ({
    debug: (data) => write('debug', mod, data),
    info: (data) => write('info', mod, data),
    warn: (data) => write('warn', mod, data),
    error: (data) => write('error', mod, data),
  });

  return {
    ...at('agent'),
    with: at,
    file,
  };
}

/**
 * 一个什么都不做的日志器：给测试和"日志还没建好"的阶段用。
 * 有了它，调用方不用到处写 `?.`。
 */
export function nullLogger(): Logger {
  const noop = (): void => {};
  const at = (): ModuleLogger => ({ debug: noop, info: noop, warn: noop, error: noop });
  return { ...at(), with: at, file: '' };
}
