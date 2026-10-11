/**
 * P2：SQLite 会话层与旧存档迁移。
 *
 * 关键验证是**跨进程持久化**：写文档 → 关闭 → 重开同一个库 → 文档仍在。
 * 这同时也是 `node:sqlite`（pi-durable 的 SQLite 适配器所依赖的 Node 内置模块）
 * 在本机 Node 版本上可用的真机证明。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { createRegistry } from '@earendil-works/pi-durable';
import { migrateLegacyState, readLegacySave } from '../src/runtime/legacy.js';
import { botDbPath, openBotSession } from '../src/runtime/session.js';
import { MemoryDoc, PlacesDoc, PlanDoc } from '../src/runtime/state.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-session-'));
  tempDirs.push(dir);
  return dir;
}

function sessionOptions(baseDir: string) {
  return { name: 'tester', models: createModels(), registry: createRegistry(), baseDir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir == null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上 SQLite 句柄可能还没释放；临时目录残留不影响断言。
    }
  }
});

describe('botDbPath', () => {
  it('默认目录沿用 bots/<name>，实例后缀用于避免同名多开撞库', () => {
    expect(botDbPath('andy')).toBe('./bots/andy/session.db');
    expect(botDbPath('andy', '/tmp/x')).toBe('/tmp/x/session.db');
    expect(botDbPath('andy', '/tmp/x', '3')).toBe('/tmp/x/session-3.db');
    // 空串等同于不区分
    expect(botDbPath('andy', '/tmp/x', '')).toBe('/tmp/x/session.db');
  });
});

describe('SQLite 会话持久化', () => {
  it('文档落盘：关闭后重开同一个库，memory/places/plan 都还在', async () => {
    const baseDir = tempDir();
    const first = await openBotSession(sessionOptions(baseDir));
    // 路径沿用仓库既有的正斜杠约定（同 History.base_dir），Windows 上也能用。
    expect(first.dbPath).toBe(`${baseDir}/session.db`);
    const id = first.conversation.id;

    await first.harness.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, id);
      memory.text = '记住了：家在北边';
      const places = await tx.doc(PlacesDoc, id);
      places.places = { home: [10, 64, -20] };
      const plan = await tx.doc(PlanDoc, id);
      plan.goal = '造房子';
      plan.todos = [{ text: '砍树', done: true }];
    }, ctx);
    await first.close();
    expect(existsSync(first.dbPath)).toBe(true);

    const second = await openBotSession(sessionOptions(baseDir));
    // 根 conversation 是同一个，不是新建的
    expect(second.conversation.id).toBe(id);
    expect(await second.harness.snapshot(MemoryDoc, id, ctx)).toEqual({ text: '记住了：家在北边' });
    expect(await second.harness.snapshot(PlacesDoc, id, ctx)).toEqual({
      places: { home: [10, 64, -20] },
    });
    expect(await second.harness.snapshot(PlanDoc, id, ctx)).toEqual({
      goal: '造房子',
      todos: [{ text: '砍树', done: true }],
    });
    await second.close();
  });

  it('未创建过的文档读回 undefined，而不是默认值', async () => {
    const baseDir = tempDir();
    const session = await openBotSession(sessionOptions(baseDir));
    expect(await session.harness.snapshot(MemoryDoc, session.conversation.id, ctx)).toBeUndefined();
    await session.close();
  });
});

describe('旧存档迁移', () => {
  it('memory / places / plan 进文档；turns 故意不迁', async () => {
    const baseDir = tempDir();
    writeFileSync(
      join(baseDir, 'memory.json'),
      JSON.stringify({
        memory: 'old memory',
        turns: [{ role: 'user', content: '上一局的对话' }],
        taskStart: 123,
        places: { mine: [1, 2, 3] },
        plan: { goal: 'g', todos: [{ text: 't', done: false }] },
      }),
    );
    const legacy = readLegacySave(baseDir);
    expect(legacy?.memory).toBe('old memory');

    const session = await openBotSession(sessionOptions(baseDir));
    const id = session.conversation.id;
    const result = await migrateLegacyState(session.harness, id, legacy, ctx);

    expect(result).toEqual({ memory: true, places: 1, plan: true });
    expect(await session.harness.snapshot(MemoryDoc, id, ctx)).toEqual({ text: 'old memory' });
    expect(await session.harness.snapshot(PlacesDoc, id, ctx)).toEqual({
      places: { mine: [1, 2, 3] },
    });
    expect(await session.harness.snapshot(PlanDoc, id, ctx)).toEqual({
      goal: 'g',
      todos: [{ text: 't', done: false }],
    });
    await session.close();
  });

  it('幂等：已有文档不被旧存档覆盖，缺失的仍会补迁', async () => {
    const baseDir = tempDir();
    const session = await openBotSession(sessionOptions(baseDir));
    const id = session.conversation.id;
    await session.harness.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, id);
      memory.text = 'NEW';
    }, ctx);

    const result = await migrateLegacyState(
      session.harness,
      id,
      { memory: 'OLD', places: { a: [0, 0, 0] }, plan: { goal: 'old', todos: [] } },
      ctx,
    );

    expect(result).toEqual({ memory: false, places: 1, plan: true });
    expect(await session.harness.snapshot(MemoryDoc, id, ctx)).toEqual({ text: 'NEW' });
    await session.close();
  });

  it('legacy 为 null 时是空操作', async () => {
    const baseDir = tempDir();
    const session = await openBotSession(sessionOptions(baseDir));
    expect(
      await migrateLegacyState(session.harness, session.conversation.id, null, ctx),
    ).toEqual({ memory: false, places: 0, plan: false });
    await session.close();
  });

  it('readLegacySave：文件缺失或 JSON 损坏都安静返回 null', () => {
    const baseDir = tempDir();
    expect(readLegacySave(baseDir)).toBeNull();
    writeFileSync(join(baseDir, 'memory.json'), '{ not json');
    expect(readLegacySave(baseDir)).toBeNull();
  });
});
