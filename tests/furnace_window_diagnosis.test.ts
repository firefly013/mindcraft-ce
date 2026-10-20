/**
 * 熔炉"全 0 读数"到底是真丢还是读不到（Lead 2026-10-20）。
 *
 * 真机 A/B 各一例：`Failed to smelt raw_iron` + 输入槽 0 / 燃料 0 / 产物 0 ⇒ 旧账算成"真丢 1"。
 * 但同一坐标的方块还在（`useBlock` 能定位到「已经在 (16,64,10) 的 furnace 旁边」），
 * 窗口也收到过 `window_items(items=39)`——**两件事互相矛盾**，不能凭此声称丢。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { furnaceSlotsVerdict } from '../src/body/commands/interact.js';

describe('furnaceSlotsVerdict：全 0 读数先问"可不可信"', () => {
  const base = {
    blockPresent: true,
    blockName: 'furnace',
    windowContentsArrived: true,
    slots: { input: 0, fuel: 0, output: 0 },
  };

  it('方块还在 + 名字还是熔炉 + 窗口内容到过 ⇒ 才允许当"可信的全 0"（真丢可下结论）', () => {
    expect(furnaceSlotsVerdict(base)).toBe('trusted-loss');
  });

  it('**方块没了** ⇒ uncertain（这是容器消失，不是"烧丢了"；先问方块在不在）', () => {
    expect(furnaceSlotsVerdict({ ...base, blockPresent: false })).toBe('uncertain');
  });

  it('方块位置变成别的东西（air/stone） ⇒ uncertain', () => {
    expect(furnaceSlotsVerdict({ ...base, blockName: 'stone' })).toBe('uncertain');
  });

  it('窗口内容没到过 ⇒ uncertain（读不到 ≠ 全 0）', () => {
    expect(furnaceSlotsVerdict({ ...base, windowContentsArrived: false })).toBe('uncertain');
  });

  it('任一项读不到 ⇒ uncertain', () => {
    expect(furnaceSlotsVerdict({ ...base, slots: { input: null, fuel: 0, output: 0 } })).toBe('uncertain');
    expect(furnaceSlotsVerdict({ ...base, slots: { input: 0, fuel: null, output: 0 } })).toBe('uncertain');
    expect(furnaceSlotsVerdict({ ...base, slots: { input: 0, fuel: 0, output: null } })).toBe('uncertain');
  });

  it('炉里有东西 ⇒ ok（不适用这条判定）', () => {
    expect(furnaceSlotsVerdict({ ...base, slots: { input: 1, fuel: 0, output: 0 } })).toBe('ok');
  });
});

describe('接线：不确定就别结算、并给包级证据', () => {
  const interact = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
  const body = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('interact：uncertainAllZero ⇒ 三项按 null 记账 + 明说矛盾、要求原样再试一次', () => {
    const code = interact();
    expect(code).toContain('const slotsTrust = furnaceSlotsVerdict({');
    expect(code).toContain('furnaceInput: uncertainAllZero ? null : slots.input,');
    expect(code).toContain('两件事互相矛盾');
    expect(code).toContain('这次**不结算**');
  });

  it('身体：合成/熔炉各自的窗口诊断事件（含槽位快照）', () => {
    const code = body();
    expect(code).toContain("event: 'furnace-window-diagnosis'");
    expect(code).toContain('slots: this.containerDumpSlots,');
    expect(code).toContain("(this.containerDumpLabel === 'craft' || this.containerDumpLabel === 'furnace')");
  });
});
