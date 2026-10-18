/**
 * 拾取路径的背包快照差分 —— 真机 2026-10-19（overnight_a）。
 *
 * verbatim：「pickup 反射走到物品位置但没入包，背包原有 dirt×6 反而消失」。
 * 两件事都要能被**区分**：从没捡到 / 捡到了又丢 / 只是读错（未同步）。
 * 判据只能是"走路前后两次完整账目"，不能是叙事。
 */
import { describe, expect, it } from 'vitest';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

function bodyWith(): any {
  const body: any = Object.create(MineflayerBody.prototype);
  return body;
}

describe('describeInventoryDelta：只报变化，且区分三种情况', () => {
  const diff = (before: any, after: any, target = 'oak_log') =>
    bodyWith().describeInventoryDelta(before, after, target);

  it('① 从没捡到：账目完全没变 ⇒ changed=false，且说明"没捡到 ≠ 捡了又丢"', () => {
    const result = diff({ dirt: 6 }, { dirt: 6 });
    expect(result.changed).toBe(false);
    expect(result.gained).toEqual([]);
    expect(result.lost).toEqual([]);
  });

  it('② 捡到了但原有物品减少（真机那个形状）⇒ 点名"减少"并警告这不是没捡到', () => {
    const result = diff({ dirt: 6 }, { dirt: 0, oak_log: 1 });
    expect(result.changed).toBe(true);
    expect(result.gained.join()).toContain('+oak_log×1');
    expect(result.lost.join()).toContain('-dirt×6');
    expect(result.note).toContain('有物品减少');
    expect(result.note).toContain('不是"没捡到"');
  });

  it('③ 只捡到目标物品 ⇒ 报增加，且不误报"减少"', () => {
    const result = diff({ dirt: 6 }, { dirt: 6, oak_log: 2 });
    expect(result.changed).toBe(true);
    expect(result.gained.join()).toContain('+oak_log×2');
    expect(result.lost).toEqual([]);
    expect(result.note).not.toContain('有物品减少');
  });

  it('有变化但目标物品没涨（比如换成别的）⇒ 明说"目标物品并没有增加"', () => {
    const result = diff({ dirt: 6 }, { dirt: 6, oak_log: 0, cobblestone: 1 });
    expect(result.changed).toBe(true);
    expect(result.note).toContain('目标物品并没有增加');
    expect(result.note).not.toContain('有物品减少');
  });

  it('读数不可用（未同步/读失败）⇒ **绝不**当成"没变化"，明说不能据此判断', () => {
    const result = diff(null, { dirt: 6 });
    expect(result.changed).toBe(false);
    expect(result.note).toContain('读数不可用');
    expect(result.note).toContain('不能据此判断');
    const result2 = diff({ dirt: 6 }, null);
    expect(result2.note).toContain('读数不可用');
  });

  it('变化项很多时**有界**（最多列 8 项），不刷屏', () => {
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (let i = 0; i < 20; i++) after[`item_${i}`] = 1;
    const result = diff(before, after);
    expect(result.gained).toHaveLength(20); // 结构化字段给全
    const listed = result.note.split('、').length;
    expect(listed).toBeLessThanOrEqual(9); // 文案里有界
  });
});
