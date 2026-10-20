/**
 * 工作台 3×3 窗口取证（Lead 2026-10-19 ①）。
 *
 * 真机 overnight_a：「【主线死锁】工作台窗口 0/4 成功 → 末影之眼/末影水晶永远合不出来」。
 * 关键区分：(a) 两条 crafting 实现、一条死（`useBlock(crafting_table)` 能成，`bot.craft` 不能）
 * 还是 (b) 窗口偶发无内容。**形状不是证据**，所以先给 craft 路径装上和开箱子同款的包转储。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const body = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('craft 窗口取证', () => {
  it('craft 之前武装、成功/失败都解除，并带 craft 标签', () => {
    const src = skills();
    expect(src).toContain("arm?.(`craft ${String(recipe?.result?.id ?? count)}`, 'craft');");
    expect(src).toContain("disarm?.('crafted');");
  });

  it('身体侧按标签落 craft-window-diagnosis{recipe, verdict, openWindow, contents, protocolFaults}', () => {
    const src = body();
    expect(src).toContain("event: 'craft-window-diagnosis'");
    for (const field of ['reason:', 'verdict,', 'openWindow:', 'contents:', 'protocolFaults:']) {
      expect(src).toContain(field);
    }
  });

  it('verdict 语义仍是"槽位包到了才算开窗成功"（不许把开窗包当成功）', () => {
    // window-arrived 由 window_items/set_content 判定；opened-no-slots = 开了窗没内容
    const src = body();
    expect(src).toContain("const hasSlots = inbound.some((n) => /window_items|set_content|container_set_content/i.test(n));");
    expect(src).toContain("const hasOpen = inbound.some((n) => /open_window|open_screen/i.test(n));");
  });
});

describe('合成窗口槽位快照（Lead 2026-10-20：craft 报 ok 而背包不变）', () => {
  it('合成窗口的内容包到达后抓槽位快照，并进 craft-window-diagnosis', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain('private containerDumpSlots');
    expect(src).toContain("this.containerDumpLabel === 'craft'");
    expect(src).toContain('this.containerDumpSlots = slots');
    expect(src).toContain('slots: this.containerDumpSlots,');
  });

  it('快照读不到时是 null（不猜），而不是空数组冒充"没有材料"', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain('this.containerDumpSlots = null;');
  });
});
