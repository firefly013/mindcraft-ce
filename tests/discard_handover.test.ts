/**
 * ② 跨 bot 交接："刚扔的东西别自己捡回来"的免疫**必须按 bot 隔离**。
 *
 * 真机事故（2026-10-18）：B 把 `oak_log×4` 扔在 (18.125,70,-14.672)，A 站在
 * 0.4 米处、换了五种办法、5 分钟都没捡起来，物品过期。两个 bot 各自独立报告。
 * 结论：免疫的判据是（名字 / 落点半径 / 实体 id）匹配**自己进程里**的 discard
 * 记录——B 的免疫不该拦 A。这里把它做成**实例**，并用"X 扔、Y 捡"钉住。
 */
import { describe, expect, it } from 'vitest';
import { createDiscardTracker, nearestDropWithin } from '../src/body/auto_pickup.js';

const DROP_AT = { x: 18.125, y: 70, z: -14.672 };

function botAt(x: number, y: number, z: number, drops: Array<{ id: number; name: string; displayName: string; pos: any }>): any {
  const entities: Record<string, any> = {};
  for (const drop of drops) {
    entities[String(drop.id)] = {
      id: drop.id,
      name: 'item',
      displayName: drop.displayName,
      position: drop.pos,
    };
  }
  return { entity: { id: 1, position: { x, y, z } }, entities };
}

describe('X 扔、Y 捡（两个 tracker 实例）', () => {
  it('X 的 discard 免疫只对 X 生效；Y 视它为可捡的掉落物', () => {
    const trackerX = createDiscardTracker();
    const trackerY = createDiscardTracker();
    trackerX.markDiscarded('oak_log', DROP_AT);
    trackerX.noteDiscardedEntity(4242);

    // X 自己：不捡（这就是 discard 的承诺）
    expect(trackerX.isDiscardedDrop('Oak Log', DROP_AT, 4242)).toBe(true);
    // Y（队友）：完全不认识这条记录
    expect(trackerY.isDiscardedDrop('Oak Log', DROP_AT, 4242)).toBe(false);

    const drop = [{ id: 4242, name: 'oak_log', displayName: 'Oak Log', pos: DROP_AT }];
    // 位置/名字/id 三条路都不该把队友的东西挡掉
    expect(nearestDropWithin(botAt(DROP_AT.x + 0.4, 70, DROP_AT.z, drop), 8, trackerX)).toBeNull();
    expect(nearestDropWithin(botAt(DROP_AT.x + 0.4, 70, DROP_AT.z, drop), 8, trackerY)).toMatchObject({ id: 4242 });
  });

  it('丢完回执不再暗示"丢东西交接"可行，而是指向箱子', () => {
    // 回执文案在 actions.ts 的 !discard 分支里；这里做一个源码守卫：
    // 一旦有人把"要交接就给队友让开位置"这种暗示写回来，测试就红。
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'body', 'commands', 'actions.ts'), 'utf8');
    expect(src).toContain('交接别靠丢东西');
    expect(src).toContain('takeFromChest');
    expect(src).not.toContain('要交接就给队友让开位置');
  });

  it('两个实例的过期/清空互不影响', () => {
    const a = createDiscardTracker();
    const b = createDiscardTracker();
    a.markDiscarded('dirt', { x: 0, y: 64, z: 0 });
    a.clear();
    expect(a.isDiscardedDrop('dirt', { x: 0, y: 64, z: 0 })).toBe(false);
    b.markDiscarded('stone', { x: 1, y: 64, z: 1 });
    expect(b.isDiscardedDrop('stone', { x: 1, y: 64, z: 1 })).toBe(true);
    expect(a.isDiscardedDrop('stone', { x: 1, y: 64, z: 1 })).toBe(false);
  });
});
