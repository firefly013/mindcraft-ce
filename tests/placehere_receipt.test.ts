/**
 * placeHere 只报回读（Lead 2026-10-21 ①）：目标格通常就是身体所在格，放不进去是常态；
 * 回执必须说清"这就是我现在站的位置"并给替代，而不是含糊的"放置失败"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatPlaceHereReceipt } from '../src/body/library/placement_guard.js';

const target = { x: 10, y: 64, z: 20 };

describe('身体格：只报事实', () => {
  it('目标就是身体格 ⇒ 报"没做到"与占用事实，不出现"Placed"', () => {
    const text = formatPlaceHereReceipt({ ok: false, target, expected: 'torch', readBack: 'air', bodyCell: true });
    expect(text).toContain('没能放下，(10,64,20) 正是我脚和头所在的那一格，回读到的方块是');
    expect(text).toContain('没能放下，(10,64,20) 正是我脚和头所在的那一格，回读到的方块是');
    expect(text).toContain('air');
    expect(text).not.toContain('Placed');
  });
});

describe('非身体格：回读确认才算成功', () => {
  it('回读匹配 ⇒ 已放置 + 回读值', () => {
    const text = formatPlaceHereReceipt({ ok: true, target, expected: 'torch', readBack: 'torch', bodyCell: false });
    expect(text).toContain('这个方块已经放在 (10,64,20)，回读到的方块是 torch。');
    expect(text).toContain('这个方块已经放在 (10,64,20)，回读到的方块是 torch。');
    expect(text).toContain('10,64,20');
  });
  it('回读不匹配 ⇒ "没做到" + 实测读到的名字（不说成功）', () => {
    const text = formatPlaceHereReceipt({ ok: true, target, expected: 'torch', readBack: 'air', bodyCell: false });
    expect(text).toContain('没能放下，(10,64,20) 回读到的方块是 air，我本来想放的是 t');
    expect(text).toContain('air');
    expect(text).not.toContain('已放置');
  });
  it('读不到 ⇒ 如实说读不到，不猜', () => {
    const text = formatPlaceHereReceipt({ ok: false, target, expected: 'torch', readBack: null, bodyCell: false });
    expect(text).toContain('读不到');
  });
});

describe('接线守卫', () => {
  it('actions.placeHere 调用 placeBlock 后回读目标格并写 formatter 回执', () => {
    const code = readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'actions.ts'), 'utf8');
    expect(code).toContain('formatPlaceHereReceipt(');
    expect(code).toContain('const ok = await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);');
    expect(code).toContain('agent.bot.blockAt(new Vec3(cell.x, cell.y, cell.z))');
  });
});
