/**
 * `shelter-skip` 内部日志（Lead 2026-10-21）：shelter 辅助触发 0 次，日志里 4 条
 * 「天黑了，我在」其实是 **bot 自己聊天文本**，不是 `formatShelterReceipt`——
 * 字符串匹配不等于能力真的接上了。模型可见回执保持静默，但内部必须能区分三态：
 * 没触发 / 判定安全故意不说话 / 根本没接线。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

describe('shelter-skip：内部观测，不进模型上下文', () => {
  it('none 分支写 lifecycle 日志 shelter-skip{reason, timeOfDay, health}', () => {
    const code = src();
    expect(code).toContain("event: 'shelter-skip'");
    expect(code).toContain('reason: skipReason');
    expect(code).toContain('timeOfDay');
    expect(code).toContain('health: typeof bot.health');
  });

  it('同一原因 60 秒内只记一次（不刷屏），且 skip 时不发 reflex.done 回执', () => {
    const code = src();
    expect(code).toContain('now - this.shelterSkipLoggedAt > 60_000');
    expect(code).toContain('this.shelterSkipReasonSeen = skipReason');
    // none 分支里 return 之前只有日志；确认没有 notify
    const skipBlock = code.slice(code.indexOf("if (plan.action === 'none') {"), code.indexOf('this.shelterRunning = true;'));
    expect(skipBlock).not.toContain("this.notify(");
  });
});
