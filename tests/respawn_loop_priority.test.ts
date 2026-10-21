/**
 * 重生循环必须**压过** empty-after-death yield（Lead 2026-10-21，真机 overnight_b）：
 * 贴脸僵尸 0.5m、3 秒内又死、连续 30+ 次；reflex 每次都 yield「先 respawn 后收装备」，
 * 但身上啥也没有——一次正确的 yield，重复三十次就是致命的。
 * 另：重生后**空手**，跑不掉时必须立刻挖脚下自封（唯一可行动作）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planRespawnEscape, shouldYieldBePreempted } from '../src/body/safety/respawn_loop.js';

const body = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

describe('循环 verdict 压过普通 yield', () => {
  it('inLoop=true + 任意 yield ⇒ 必须被顶掉（由 breaker 接管）', () => {
    expect(shouldYieldBePreempted({ inLoop: true, yieldReason: 'empty-after-death' })).toBe(true);
  });
  it('不在循环里 ⇒ 普通 yield 行为不变', () => {
    expect(shouldYieldBePreempted({ inLoop: false, yieldReason: 'empty-after-death' })).toBe(false);
  });
  it('接线：empty-after-death 分支先算循环 verdict，inLoop 就 return null', () => {
    const code = body();
    // 契约变更（Lead 2026-10-22）：这里**必须传当前位置**。
    // 原来传 position: null，而 respawnLoopVerdict 里"同一个点反复死"分支依赖 position != null
    // ⇒ 等于把重生循环最典型的签名整个关掉。真机：复活点被僵尸守着，A 死 11 次 / B 死 6 次。
    expect(code).toMatch(/respawnLoopVerdict\(\{/);
    expect(code).toContain('position: pos == null ? null :');
    expect(code).not.toContain('position: null });');
    expect(code).toContain("shouldYieldBePreempted({ inLoop: loopV.inLoop, yieldReason: 'empty-after-death' })");
    expect(code).toContain('this.lastYieldBeatenReason');
  });
  it('respawn-loop 日志带 yieldReason / yieldBeaten（能看出 yield 何时赢了）', () => {
    const code = body();
    expect(code).toContain('yieldReason: this.lastYieldReason || null,');
    expect(code).toContain('yieldBeaten: this.lastYieldBeatenReason || null,');
  });
});

describe('空手贴脸 ⇒ 立刻挖脚下自封，而不是跑', () => {
  it('handEmpty + 0.5 格僵尸 + 能挖 ⇒ dig-seal', () => {
    const plan = planRespawnEscape({ threats: [{ x: 0.3, z: 0, distance: 0.5 }], health: 15, canDig: true, canPlace: false, handEmpty: true });
    expect(plan.action).toBe('dig-seal');
  });
  it('有装备（handEmpty=false）且血够 ⇒ 仍优先跑开', () => {
    const plan = planRespawnEscape({ threats: [{ x: 2, z: 0, distance: 2 }], health: 18, canDig: true, canPlace: true, handEmpty: false });
    expect(plan.action).toBe('sprint-away');
  });
  it('接线：breaker 里 handEmpty + ≤3 格 ⇒ 直接 respawnDigAndSeal', () => {
    const code = body();
    expect(code).toContain('const handEmpty = (((this.bot as any)?.inventory?.items?.() ?? []) as unknown[]).length === 0;');
    expect(code).toContain('if (handEmpty && threat.distance <= 3) {');
    expect(code).toContain('const sealed = await this.respawnDigAndSeal();');
  });
});
