/**
 * 背包 delta 措辞（Lead 2026-10-21 真机 A：「减少 -oak_log×N」——负数减少，词和数字矛盾）
 * + 物品消失取证：两次快照之间少了东西 ⇒ 回执点名是哪一步之间少的，而不是沉默。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatInventoryDeltaNote } from '../src/body/library/inventory_delta.js';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

describe('措辞：词与数字永远一致', () => {
  it('减少 2（不是"减少 -2"）', () => {
    const note = formatInventoryDeltaNote({ oak_log: 3 }, { oak_log: 1 }, 'oak_log');
    expect(note.lost).toEqual(['oak_log×2']);
    expect(note.note).toContain('减少 oak_log×2');
    expect(note.note).not.toMatch(/减少\s*-/);
  });
  it('增加 2（不是"增加 +2"）', () => {
    const note = formatInventoryDeltaNote({ oak_log: 1 }, { oak_log: 3 }, 'oak_log');
    expect(note.gained).toEqual(['oak_log×2']);
    expect(note.note).toContain('增加 oak_log×2');
    expect(note.note).not.toMatch(/增加\s*\+/);
  });
  it('零变化 ⇒ 目标没增加，但不谎报减少', () => {
    const note = formatInventoryDeltaNote({ oak_log: 2 }, { oak_log: 2 }, 'oak_log');
    expect(note.lost).toEqual([]);
    expect(note.note).toContain('目标物品并没有增加');
  });
  it('读不到 ⇒ 明说读不到，不当成没变化', () => {
    expect(formatInventoryDeltaNote(null, { oak_log: 2 }).note).toContain('读数不可用');
    expect(formatInventoryDeltaNote({ oak_log: 2 }, null).note).toContain('读数不可用');
  });
});

describe('物品消失取证：点名"哪一步之间少的"', () => {
  function fakeBody(inventory: () => Record<string, number> | null): any {
    const body: any = Object.create(MineflayerBody.prototype);
    const events: any[] = [];
    body.readInventoryCounts = inventory;
    body.notify = (_type: string, _kind: unknown, _level: unknown, payload: any) => events.push(payload);
    body.lastActionInventory = null;
    body.lastActionName = '';
    return { body, events };
  }
  it('collectBlocks 后到 craft 前少了 oak_log×3 ⇒ 事件写清两个动作与物品数量', () => {
    const { body, events } = fakeBody(() => ({ oak_log: 0, dirt: 4 }));
    body.lastActionInventory = { oak_log: 3, dirt: 4 };
    body.lastActionName = 'collectBlocks';
    body.detectVanishedInventory('craft');
    expect(events).toHaveLength(1);
    const payload = events[0];
    expect(payload.lost).toEqual(['oak_log×3']);
    expect(String(payload.detail)).toContain('collectBlocks');
    expect(String(payload.detail)).toContain('craft');
    expect(String(payload.detail)).toContain('oak_log×3');
  });
  it('没有减少 ⇒ 不报噪音', () => {
    const { body, events } = fakeBody(() => ({ oak_log: 3 }));
    body.lastActionInventory = { oak_log: 3 };
    body.lastActionName = 'collectBlocks';
    body.detectVanishedInventory('craft');
    expect(events).toHaveLength(0);
  });
  it('两次快照都没有（首次动作/读不到）⇒ 不报', () => {
    const { body, events } = fakeBody(() => null);
    body.detectVanishedInventory('collectBlocks');
    expect(events).toHaveLength(0);
  });
});

describe('接线守卫', () => {
  it('身体在动作开始取证、结束记快照；描述方法委托统一措辞', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(code).toContain('this.detectVanishedInventory(name);');
    // 进度标签不跨动作（huntFor 曾把上一个动作的「挖矿」标签带进回执）。
    expect(code).toContain('__actionProgress = null');
    expect(code).toContain('this.rememberInventoryAfterAction(name);');
    expect(code).toContain("this.notify('inventory-vanish'");
    expect(code).toContain('return formatInventoryDeltaNote(before, after, targetName);');
  });
});
