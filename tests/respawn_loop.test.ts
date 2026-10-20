/**
 * 重生循环破解器（Lead 2026-10-21，真机 overnight_a）：
 * 「重生点就在骷髅射程内，出生即被射杀几十次；escape 反射只会"放弃并交还身体"不跑」。
 *
 * 判定信号不是"有没有危险"，而是「**我是不是刚死在这里，又一次？**」；
 * 循环里正确动作是**跑远 / 直下挖洞封顶**，而且**不能等模型回合**（等一轮=再死一次）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendDeath,
  formatRespawnEscapeReceipt,
  planRespawnEscape,
  RESPAWN_LOOP_WINDOW_MS,
  RESPAWN_SAFE_DISTANCE,
  respawnLoopVerdict,
} from '../src/body/safety/respawn_loop.js';

const now = 1_000_000;
const death = (at: number, x = 0, y = 64, z = 0) => ({ at, x, y, z });

describe('respawnLoopVerdict：两次死亡才算循环', () => {
  it('90 秒内死两次 ⇒ inLoop（这是要救命的场景）', () => {
    const verdict = respawnLoopVerdict({ deaths: [death(now - 20_000), death(now - 1_000)], now, position: { x: 0, y: 64, z: 0 } });
    expect(verdict.inLoop).toBe(true);
    expect(verdict.deathsInWindow).toBe(2);
    expect(verdict.reason).toContain('two-deaths');
  });

  it('同一个小圈（10 格内）死两次、但时间隔着也 ⇒ inLoop（原地打转）', () => {
    const verdict = respawnLoopVerdict({
      deaths: [death(now - RESPAWN_LOOP_WINDOW_MS * 3, 2, 64, 3), death(now - 1_000, 0, 64, 0)],
      now,
      position: { x: 0, y: 64, z: 0 },
    });
    expect(verdict.inLoop).toBe(true);
    expect(verdict.reason).toBe('two-deaths-near-same-point');
  });

  it('**只死一次 ⇒ 不进入循环**（普通反射行为不变）', () => {
    expect(respawnLoopVerdict({ deaths: [death(now - 5_000)], now }).inLoop).toBe(false);
  });

  it('干净重生（没有死亡记录）⇒ inLoop=false', () => {
    expect(respawnLoopVerdict({ deaths: [], now, position: { x: 0, y: 64, z: 0 } }).inLoop).toBe(false);
  });

  it('读不到位置 ⇒ 仍按时间窗口判定（宁可早救，不等第三次）', () => {
    expect(respawnLoopVerdict({ deaths: [death(now - 9_000), death(now - 1_000)], now, position: null }).inLoop).toBe(true);
  });

  it('appendDeath 有界（最多 8 条）', () => {
    let deaths: ReturnType<typeof death>[] = [];
    for (let i = 0; i < 20; i++) deaths = appendDeath(deaths, death(now + i));
    expect(deaths.length).toBe(8);
    expect(deaths[deaths.length - 1]!.at).toBe(now + 19);
  });
});

describe('planRespawnEscape：先跑，跑不掉挖洞封顶，都不行才放弃', () => {
  it('有怪 + 血还行 ⇒ sprint-away，方向是"远离攻击者"（量出来的）', () => {
    const plan = planRespawnEscape({ threats: [{ x: 3, z: 4, distance: 5 }], health: 18, canDig: true, canPlace: true });
    expect(plan.action).toBe('sprint-away');
    expect(plan.away).toEqual({ x: -0.6, z: -0.8 });
  });

  it('血太低（≤6）、跑不掉、能挖 ⇒ dig-seal（骷髅跟不下来）', () => {
    expect(planRespawnEscape({ threats: [{ x: 3, z: 4, distance: 5 }], health: 4, canDig: true, canPlace: true }).action).toBe('dig-seal');
  });

  it('血太低且不能挖 ⇒ give-up（并说明原因，不假装能救）', () => {
    const plan = planRespawnEscape({ threats: [{ x: 3, z: 4, distance: 5 }], health: 4, canDig: false, canPlace: false });
    expect(plan.action).toBe('give-up');
    expect(plan.reason).toContain('跑不掉也挖不了');
  });

  it('看不到攻击者但刚死过两次 ⇒ dig-seal（封顶躲着是最稳的）', () => {
    expect(planRespawnEscape({ threats: [], health: 18, canDig: true, canPlace: true }).action).toBe('dig-seal');
  });
});

describe('formatRespawnEscapeReceipt：说清经过 + "别马上回去"', () => {
  it('成功脱出：连死几次、被带到哪、最近威胁距离、不要马上回头', () => {
    const text = formatRespawnEscapeReceipt({ deaths: 2, action: 'sprint-away', position: { x: 30, y: 64, z: -12 }, nearestThreatDistance: null });
    expect(text).toContain('连着死了 2 次');
    expect(text).toContain('没有等你下令');
    expect(text).toContain('(30, 64, -12)');
    expect(text).toContain('别马上回去');
  });

  it('挖洞封顶：回执说清"直下挖了个洞并封住顶上"', () => {
    const text = formatRespawnEscapeReceipt({ deaths: 3, action: 'dig-seal', position: { x: 0, y: 61, z: 0 }, nearestThreatDistance: 9 });
    expect(text).toContain('直下挖了个洞并封住顶上');
    expect(text).toContain('最近敌对生物 9 格');
  });

  it('放弃：明说"我在重生循环里，无法自救" + 原因 + 可执行下一步', () => {
    const text = formatRespawnEscapeReceipt({ deaths: 4, action: 'give-up', position: { x: 0, y: 64, z: 0 }, nearestThreatDistance: null, gaveUpReason: '血太低且挖洞封顶失败' });
    expect(text).toContain('我在重生循环里，无法自救');
    expect(text).toContain('血太低且挖洞封顶失败');
    expect(text).toContain('Stop');
  });
});

describe('接线守卫：死亡记点、每 tick 判定、无需模型回合', () => {
  const src = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('死亡事件写入 recordRespawnDeath；update() 每 tick 调用 maybeBreakRespawnLoop', () => {
    const code = src();
    expect(code).toContain('this.recordRespawnDeath(death_pos ?? null);');
    expect(code).toContain('this.maybeBreakRespawnLoop();');
  });

  it('有界（15 秒）+ 事件日志 respawn-loop{deaths, windowMs, action} + 真的执行跑/挖', () => {
    const code = src();
    expect(code).toContain('const maxMs = 15_000;');
    expect(code).toContain("event: 'respawn-loop'");
    expect(code).toContain("bot.setControlState('sprint', true);");
    expect(code).toContain('respawnDigAndSeal');
    expect(code).toContain('RESPAWN_SAFE_DISTANCE');
  });
});
