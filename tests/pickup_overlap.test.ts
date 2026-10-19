/**
 * 拾取几何 + 轨迹 —— 真机 2026-10-19（overnight_a 请求干预）。
 *
 * verbatim：「掉落物在 0.9m 同层第 6 次捡不到；move 方向反；jump 无效」，
 * 以及「容器坏 7 次 + 掉落物捡不到 7 次 + 背包清空 4 次」——A 侧完全没有获取物品的手段。
 *
 * 两个问题必须分开回答：
 *   ① 服务端是否**本该**判定可拾取？（原版规则：掉落物包围盒与玩家包围盒
 *      "水平各扩 1 格、垂直各扩 0.5 格"后相交，不是"脚底距离 < 1"）
 *   ② bot 到底**动没动**？（"move 方向反 / jump 无效"会让每次靠近都是空操作）
 */
import { describe, expect, it } from 'vitest';
import { pickupOverlapVerdict, summarizePickupTrace } from '../src/body/auto_pickup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const botAt = (x: number, y: number, z: number, height = 1.8) => ({ x, y, z, height });

describe('pickupOverlapVerdict：按原版包围盒规则判断"该不该能捡"', () => {
  it('同层 0.9 米（A 的现场）⇒ 相交，服务端应当允许拾取', () => {
    const verdict = pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0.9, y: 64.2, z: 0 } });
    expect(verdict.overlap).toBe(true);
    expect(verdict.reason).toContain('包围盒相交');
  });

  it('水平 1.9 米 ⇒ 不相交；1.5 米（扩 1 格内）⇒ 相交', () => {
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 1.9, y: 64.2, z: 0 } }).overlap).toBe(false);
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 1.5, y: 64.2, z: 0 } }).overlap).toBe(true);
  });

  it('掉落物在头顶 3 米（隔着楼层也别指望）⇒ 不相交', () => {
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0, y: 67.5, z: 0 } }).overlap).toBe(false);
  });

  it('垂直容差：脚下 0.5 米内仍算相交（掉落物掉在脚边）', () => {
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0, y: 63.6, z: 0 } }).overlap).toBe(true);
  });

  it('不同 y 层但水平很近、且超出垂直容差 ⇒ 不相交（"同层"必须是真同层）', () => {
    const verdict = pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0.2, y: 62.0, z: 0.2 } });
    expect(verdict.overlap).toBe(false);
    expect(verdict.reason).toContain('不相交');
  });
});

describe('summarizePickupTrace：bot 动没动 / 有没有真的靠近', () => {
  it('bot 几乎没动 ⇒ 明说"靠近这一步没生效"（对应 A 的"move 方向反"）', () => {
    const summary = summarizePickupTrace([
      { botMoved: 0, dx: 0.9, dy: 0.2, dz: 0, overlap: true },
      { botMoved: 0.01, dx: 0.9, dy: 0.2, dz: 0, overlap: true },
    ]);
    expect(summary.botTravel).toBeLessThan(0.2);
    expect(summary.note).toContain('几乎没动');
    expect(summary.overlapEver).toBe(true);
    expect(summary.note).toContain('几何上早该能捡');
  });

  it('从未相交 ⇒ 明说"一直没真正靠近到可拾取范围"', () => {
    const summary = summarizePickupTrace([
      { botMoved: 0.5, dx: 3, dy: 0, dz: 0, overlap: false },
      { botMoved: 0.6, dx: 2.2, dy: 0, dz: 0, overlap: false },
    ]);
    expect(summary.overlapEver).toBe(false);
    expect(summary.note).toContain('从未出现过包围盒相交');
    expect(summary.note).toContain('移动了');
  });

  it('给最近距离（用于回执里说清"差多少"）', () => {
    const summary = summarizePickupTrace([
      { botMoved: 0.4, dx: 3, dy: 1, dz: 0, overlap: false },
      { botMoved: 0.4, dx: 0.4, dy: 0.1, dz: 0.2, overlap: true },
    ]);
    expect(summary.closest?.dx).toBeCloseTo(0.4);
    expect(summary.samples).toBe(2);
  });

  it('没采到轨迹（掉落物已消失）⇒ 如实说，不编造"没动"', () => {
    const summary = summarizePickupTrace([]);
    expect(summary.samples).toBe(0);
    expect(summary.note).toContain('没有采到轨迹');
  });

  it('接线：拾取路径真的会采轨迹、并且失败时把摘要写进回执（源码守卫）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain("event: 'pickup-trace'");
    expect(src).toContain('summarizePickupTrace(traceSamples)');
    expect(src).toContain('拾取轨迹：');
    expect(src).toContain('setInterval(sampleTrace, 250)');
  });
});
