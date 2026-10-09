/**
 * P5：状态门面（memory / places / plan）。
 *
 * 约定是"读不到就返回默认值"，且 plan 快照必须是深拷贝——调用方改它不该
 * 反噬存储。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import { createRegistry } from '@earendil-works/pi-durable';
import { openBotSession } from '../src/runtime/session.js';
import { createStateAccess } from '../src/runtime/state_access.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-state-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir == null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上句柄可能还没释放
    }
  }
});

async function openAccess(baseDir: string) {
  const session = await openBotSession({
    name: 'tester',
    models: createModels(),
    registry: createRegistry(),
    baseDir,
  });
  return { session, access: createStateAccess(session.harness, session.conversation.id) };
}

describe('状态门面', () => {
  it('文档不存在时返回默认值，而不是 undefined', async () => {
    const { session, access } = await openAccess(tempDir());
    expect(await access.memory()).toBe('');
    expect(await access.places()).toEqual({});
    expect(await access.plan()).toEqual({ goal: null, todos: [] });
    await session.close();
  });

  it('写入后读回，且关闭重开仍在', async () => {
    const baseDir = tempDir();
    const first = await openAccess(baseDir);
    await first.access.setMemory('家在北边');
    await first.access.setPlaces({ home: [10, 64, -20] });
    await first.access.setPlan({ goal: '造房子', todos: [{ text: '砍树', done: true }] });
    await first.session.close();

    const second = await openAccess(baseDir);
    expect(await second.access.memory()).toBe('家在北边');
    expect(await second.access.places()).toEqual({ home: [10, 64, -20] });
    expect(await second.access.plan()).toEqual({
      goal: '造房子',
      todos: [{ text: '砍树', done: true }],
    });
    await second.session.close();
  });

  it('plan() 返回深拷贝：改快照不反噬存储', async () => {
    const { session, access } = await openAccess(tempDir());
    await access.setPlan({ goal: 'g', todos: [{ text: 't', done: false }] });

    const snapshot = await access.plan();
    snapshot.todos.push({ text: 'x', done: true });
    const head = snapshot.todos[0];
    if (head != null) head.text = 'MUTATED';
    snapshot.goal = 'MUTATED';

    expect(await access.plan()).toEqual({ goal: 'g', todos: [{ text: 't', done: false }] });
    await session.close();
  });

  it('places() 返回拷贝：改它不反噬存储', async () => {
    const { session, access } = await openAccess(tempDir());
    await access.setPlaces({ mine: [1, 2, 3] });
    const places = await access.places();
    places['mine'] = [9, 9, 9];
    expect(await access.places()).toEqual({ mine: [1, 2, 3] });
    await session.close();
  });

  it('setPlan 不共享调用方的 todos 对象', async () => {
    const { session, access } = await openAccess(tempDir());
    const todos = [{ text: 't', done: false }];
    await access.setPlan({ goal: null, todos });
    todos.push({ text: 'later', done: true });
    expect((await access.plan()).todos).toHaveLength(1);
    await session.close();
  });
});
