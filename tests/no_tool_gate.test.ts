/**
 * 用户推翻了"低耐久安全门"（Lead 2026-10-21），规则：
 * - 选工具是**省事**，不是门：模型可指定；未指定时默认选"够用且便宜"的。
 * - 工具在**长动作中途**断了 ⇒ 内部静默换一把并在最终回执里说一次；不在动作中间拦路。
 * - 单个短动作里断了 ⇒ 只报事实「镐断了，现在手里是 X」，不给建议式护栏。
 * - **不存在**"镐快用完了——先换 stone_pickaxe"这种门 ⇒ A 的震荡结构上不可能再发生。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseToolForJob } from '../src/body/library/tool_choice.js';

const progression = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'progression.ts'), 'utf8');

describe('安全门已删除', () => {
  it('progression 里不再有停止码 tool_low 的产生点（没有 gate 就没有震荡对象）', () => {
    const code = progression();
    expect(code).not.toContain("outcome.stop = 'tool_low'");
    expect(code).not.toContain('镐快用完了');
  });
  it('travelTo 的自动换手只做"默认便利选择"，不再因低耐久中止', () => {
    const code = progression();
    expect(code).toContain('chooseToolForJob(');
    expect(code).not.toContain('guard.low');
  });
});

describe('便宜优先工具选择仍是默认便利（不是门）', () => {
  const pick = (name: string, remaining: number) => ({ name, count: 1, maxDurability: 251, durabilityUsed: 251 - remaining });
  it('(d) 只剩一把快断的镐 ⇒ 直接用它，回执里没有"先换"', () => {
    const choice = chooseToolForJob({ tools: [pick('iron_pickaxe', 4)], usesNeeded: 2 });
    expect(choice.name).toBe('iron_pickaxe');
    expect(choice.message).not.toContain('先换');
  });
  it('(a) 3 把铁镐含剩 4 次、活只要 2 次 ⇒ 用剩 4 次那把（便宜优先）', () => {
    expect(chooseToolForJob({ tools: [pick('iron_pickaxe', 250), pick('iron_pickaxe', 4)], usesNeeded: 2 }).remaining).toBe(4);
  });
});
