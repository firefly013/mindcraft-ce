/**
 * 放置验证 + "刚放下的方块不许自己捡回来"（Lead 2026-10-21，真机 overnight_b）：
 * `placeBlock` 回执「Placed furnace at (43, 56, 10).」，紧接着 autoPickup 把 furnace
 * 捡回背包，`stats blocks` 里没有 furnace ⇒ **方块没留在世界里，回执却说成功**。
 *
 * 契约：成功 = 世界里读出该方块；"物品没减少"要警告并给掉落物豁免；
 * 世界里没有 ⇒ **绝不报成功**。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearPlacedRecords,
  isJustPlacedDrop,
  markPlaced,
  PLACED_DROP_GUARD_MS,
  placementVerdict,
} from '../src/body/library/placement_guard.js';

beforeEach(() => clearPlacedRecords());

describe('placementVerdict：世界里没有就不叫成功', () => {
  it('读回是目标方块 + 背包数量减少 ⇒ ok', () => {
    expect(placementVerdict({ blockRead: 'furnace', expected: 'furnace', countBefore: 2, countAfter: 1 })).toBe('ok');
  });

  it('读回是 air ⇒ **block-missing**（真机：回执写 Placed，实际那格是 air）', () => {
    expect(placementVerdict({ blockRead: 'air', expected: 'furnace', countBefore: 2, countAfter: 1 })).toBe('block-missing');
  });

  it('读回是别的方块 ⇒ block-missing（不能拿"差不多"当成功）', () => {
    expect(placementVerdict({ blockRead: 'cobblestone', expected: 'furnace', countBefore: 2, countAfter: 1 })).toBe('block-missing');
  });

  it('方块在世界上、但背包没减少 ⇒ placed-but-item-not-consumed（成功但要警告 + 掉落物豁免）', () => {
    expect(placementVerdict({ blockRead: 'furnace', expected: 'furnace', countBefore: 2, countAfter: 2 })).toBe(
      'placed-but-item-not-consumed',
    );
  });

  it('读不到方块 ⇒ uncertain（不下结论）', () => {
    expect(placementVerdict({ blockRead: null, expected: 'furnace', countBefore: null, countAfter: null })).toBe('uncertain');
  });

  it('墙火把/带朝向的变体也算匹配（bareName 前缀/后缀）', () => {
    expect(placementVerdict({ blockRead: 'wall_torch', expected: 'torch', countBefore: 3, countAfter: 2 })).toBe('ok');
  });
});

describe('刚放下的方块不是掉落物（防止 place→pickup 自我抵消）', () => {
  it('登记后 3 秒内、同一位置 2 格内 ⇒ true（拾取必须跳过）', () => {
    const now = 1_000_000;
    markPlaced('furnace', { x: 43, y: 56, z: 10 }, now);
    expect(isJustPlacedDrop('furnace', { x: 43.4, y: 56.2, z: 10.1 }, now + 500)).toBe(true);
  });

  it('超过 3 秒 ⇒ false（别人的掉落物照常捡）', () => {
    const now = 1_000_000;
    markPlaced('furnace', { x: 43, y: 56, z: 10 }, now);
    expect(isJustPlacedDrop('furnace', { x: 43, y: 56, z: 10 }, now + PLACED_DROP_GUARD_MS + 1)).toBe(false);
  });

  it('位置太远或名字不同 ⇒ false', () => {
    const now = 1_000_000;
    markPlaced('furnace', { x: 43, y: 56, z: 10 }, now);
    expect(isJustPlacedDrop('furnace', { x: 60, y: 56, z: 10 }, now)).toBe(false);
    expect(isJustPlacedDrop('cobblestone', { x: 43, y: 56, z: 10 }, now)).toBe(false);
  });
});

describe('接线守卫：placeBlock 回读验证 + 拾取跳过', () => {
  const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');
  const body = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('placeBlock：放置前登记、读回校验、失败重试一次、仍失败就报"没有生效"并 return false', () => {
    const code = skills();
    expect(code).toContain('markPlaced(blockType, { x: target_dest.x, y: target_dest.y, z: target_dest.z });');
    expect(code).toContain('placementVerdict({ blockRead: readBack');
    expect(code).toContain('放置没有生效');
    expect(code).toContain('return false;');
  });

  it('autoPickup：刚放下的方块静默跳过（不抢占、不回执）', () => {
    const code = body();
    expect(code).toContain('if (isJustPlacedDrop(target.name, { x: target.x, y: target.y, z: target.z })) return;');
  });
});
