/**
 * 请求日志：D1（一文件一代、覆盖写）/ D2（压仓翻页）/ D3（= 模型实际收到的消息列）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { defineExtension } from '@earendil-works/pi-durable';
import type { ResolvedProvider } from '../src/runtime/provider.js';
import {
  compactionPageHook,
  createRequestLogSink,
  requestLogHook,
} from '../src/runtime/request_log.js';
import { openBotRuntime } from '../src/runtime/runtime.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-rlog-'));
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

function user(content: string): Message {
  return { role: 'user', content, timestamp: 0 } as Message;
}

function sinkIn(dir: string, tools: string[] = ['Look']): ReturnType<typeof createRequestLogSink> {
  return createRequestLogSink({
    dir,
    tools: () => tools,
    now: () => new Date('2026-10-06T12:00:00.000Z'),
  });
}

describe('D1：一个文件 = 一代上下文，覆盖写', () => {
  it('第一次请求建文件，头三行是 at / round / tools', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([user('第一句')]);

    const text = readFileSync(sink.file, 'utf8');
    expect(text).toContain('# request at 2026-10-06T12:00:00.000Z');
    expect(text).toContain('# round 1');
    expect(text).toContain('# tools Look');
    expect(text).toContain('[user] 第一句');
  });

  it('第二次请求**覆盖**，文件里只剩后一次（不追加）', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([user('旧的一轮')]);
    sink.writeRequest([user('新的一轮')]);

    const text = readFileSync(sink.file, 'utf8');
    expect(text).toContain('新的一轮');
    expect(text).not.toContain('旧的一轮');
    expect(readdirSync(dir)).toEqual(['request-001.log']);
  });

  it('# round 在同一代里递增', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([user('a')]);
    sink.writeRequest([user('b')]);
    sink.writeRequest([user('c')]);
    expect(readFileSync(sink.file, 'utf8')).toContain('# round 3');
  });
});

describe('D2：压仓翻页', () => {
  it('翻页后是新文件，旧文件保留', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([user('压前')]);
    const first = sink.file;

    sink.nextPage();
    sink.writeRequest([user('压后')]);

    expect(sink.page).toBe(2);
    expect(sink.file).toBe(join(dir, 'request-002.log'));
    expect(readdirSync(dir).sort()).toEqual(['request-001.log', 'request-002.log']);
    expect(readFileSync(first, 'utf8')).toContain('压前');
    expect(readFileSync(sink.file, 'utf8')).toContain('压后');
    expect(readFileSync(sink.file, 'utf8')).toContain('# round 1');
  });
});

describe('D3：日志 = 模型实际收到的消息列', () => {
  it('多行内容缩进，不把日志撑散', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([user('第一行\n第二行')]);
    const text = readFileSync(sink.file, 'utf8');
    expect(text).toContain('[user] 第一行\n  第二行');
  });

  it('系统消息的提示词在 `sections` 里，必须渲染出来', () => {
    // pi-ai 的 SystemMessage 只有 `content`（基础提示）+ `sections`（具名段落）。
    // 系统提示词走的是 section，所以只打 content 会得到一个空的 [system]——
    // 真机日志里就是这么暴露的（D3 不成立）。
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([
      { role: 'system', content: '', sections: { system: '你是 $NAME。\n第二行' } } as unknown as Message,
      user('你好'),
    ]);
    const text = readFileSync(sink.file, 'utf8');
    expect(text).toContain('[section:system]');
    expect(text).toContain('你是 $NAME。');
    expect(text).toContain('    第二行');
  });

  it('section 被移除时日志里也看得出来（null）', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([
      { role: 'system', content: '', sections: { system: null } } as unknown as Message,
    ]);
    expect(readFileSync(sink.file, 'utf8')).toContain('(removed)');
  });

  it('内部字段不进日志（messages 已是模型形状）', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([user('正文')]);
    const text = readFileSync(sink.file, 'utf8');
    for (const field of ['"kind"', '"level"', '"at"', '"usage"']) {
      expect(text).not.toContain(field);
    }
  });

  it('写不进去不抛（日志是旁路，不是主链路）', () => {
    // 拿一个**文件**当目录用：mkdirSync 必然失败（ENOTDIR），
    // 于是走到"写失败"那条兜底路径。
    const file = join(tempDir(), 'not-a-dir');
    writeFileSync(file, 'x');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sink = createRequestLogSink({ dir: join(file, 'logs'), tools: () => [] });
    expect(() => sink.writeRequest([user('x')])).not.toThrow();
    expect(error).toHaveBeenCalled();
  });

  it('content 序列化不了时降级成标记，不抛', () => {
    // 循环引用：`contentText` 的 catch 分支
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const dir = tempDir();
    const sink = sinkIn(dir);
    expect(() =>
      sink.writeRequest([{ role: 'user', content: circular } as unknown as Message]),
    ).not.toThrow();
    expect(readFileSync(sink.file, 'utf8')).toContain('[unserializable]');
  });

  it('content 是 undefined（JSON.stringify 返回 undefined）→ 记 null', () => {
    const dir = tempDir();
    const sink = sinkIn(dir);
    sink.writeRequest([{ role: 'user', content: undefined } as unknown as Message]);
    expect(readFileSync(sink.file, 'utf8')).toContain('[user] null');
  });
});

describe('真集成：hook 真的接在生成与压仓上', () => {
  it('一次请求写出日志；压仓后翻页', async () => {
    const dir = tempDir();
    const sink = sinkIn(dir, ['Look']);

    const faux = fauxProvider({ models: [{ id: 'mc-test', contextWindow: 300 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel('mc-test') ?? faux.getModel();
    const provider: ResolvedProvider = {
      models,
      model,
      providerId: faux.provider.id,
      apiKey: undefined,
      headers: null,
      contextWindow: model.contextWindow,
    };
    faux.setResponses([
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
    ]);

    const runtime = await openBotRuntime({
      name: 'tester',
      provider,
      baseDir: tempDir(),
      systemPrompt: () => 'SYS',
      liveTail: () => '',
      compaction: { enabled: true, reserveTokens: 20, keepRecentTokens: 50, backgroundTokens: 0 },
      extensions: [
        defineExtension({
          name: 'request-log',
          hooks: [requestLogHook(sink), compactionPageHook(sink)],
        }),
      ],
    });

    await (await runtime.submit('第一次')).wait(ctx);
    expect(readdirSync(dir)).toContain('request-001.log');
    expect(readFileSync(join(dir, 'request-001.log'), 'utf8')).toContain('[user] 第一次');

    // 窗口很小（300 − 20 = 280），继续塞长内容必然触发压仓 → 翻页
    const long = '填充文本'.repeat(60);
    for (let i = 0; i < 4; i++) {
      await (await runtime.submit(`${long} 第${i}条`)).wait(ctx);
    }

    // 先确认压仓真的发生了，再看翻页——否则分不清"没压仓"和"hook 没接上"
    const page = await runtime.conversation.entries({}, 100, undefined, ctx);
    expect(page.items.some((entry) => entry.kind.includes('compaction'))).toBe(true);

    const files = readdirSync(dir).sort();
    expect(files).toContain('request-002.log');
    await runtime.close();
  });
});
