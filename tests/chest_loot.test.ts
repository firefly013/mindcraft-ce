/**
 * 「世界里有奖励箱，他们得拿」——开箱 = 拿东西，走模型真的能调用的 `useBlock`。
 *
 * 三条要钉住的事实：
 *   ① 箱子有东西 ⇒ 全部拿走、**按背包实测增量计数**（不是"点了几个槽"）；
 *   ② 装不下 ⇒ 拿走一部分，**说清剩下什么、为什么留**；
 *   ③ 空箱 ⇒ 说"空的"（不是"拿走 0 个"的成功）。
 * 外加一条历史教训：`takeFromChest` 从来不是工具，回执里不许再让模型去调它。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLootReport } from '../src/body/library/skills.js';

describe('formatLootReport：三件事分开说', () => {
  it('有东西、全拿走了 ⇒ 列出箱内清单 + 拿走清单（背包实测）+ 共多少件', () => {
    const lines = formatLootReport({
      readable: true,
      contents: [{ name: 'iron_ingot', count: 5 }, { name: 'bread', count: 3 }],
      taken: [{ name: 'iron_ingot', count: 5 }, { name: 'bread', count: 3 }],
      left: [],
      freeSlots: 20,
      reason: null,
    }).join('\n');
    expect(lines).toContain('箱子里有：iron_ingot×5、bread×3（共 8 件）');
    expect(lines).toContain('拿走：iron_ingot×5、bread×3');
    expect(lines).toContain('背包实测增量');
    expect(lines).not.toContain('留在箱子里');
  });

  it('装不下 ⇒ 拿走一部分，**说清剩下什么**和背包空位', () => {
    const lines = formatLootReport({
      readable: true,
      contents: [{ name: 'diamond', count: 9 }, { name: 'oak_log', count: 64 }],
      taken: [{ name: 'diamond', count: 9 }],
      left: [{ name: 'oak_log', count: 64 }],
      freeSlots: 0,
      reason: '背包没有空位',
    }).join('\n');
    expect(lines).toContain('拿走：diamond×9');
    expect(lines).toContain('留在箱子里：oak_log×64');
    expect(lines).toContain('背包没有空位');
  });

  it('空箱 ⇒ 明确说"空的"，不是"拿走 0 个"的成功', () => {
    const lines = formatLootReport({ readable: true, contents: [], taken: [], left: [], freeSlots: 30, reason: null }).join('\n');
    expect(lines).toContain('箱子是**空的**');
    expect(lines).not.toContain('拿走：');
    expect(lines).toContain('这不是失败');
  });

  it('槽位表读不到 ⇒ 不许说"空"，并给一行非容器兜底（不点名不存在的工具）', () => {
    const lines = formatLootReport({ readable: false, contents: [], taken: [], left: [], freeSlots: null, reason: '槽位表为空' }).join('\n');
    expect(lines).toContain('槽位表读不到');
    expect(lines).toContain('不能据此判断箱子是空的');
    expect(lines).toContain('useBlock');
    expect(lines).not.toContain('takeFromChest');
  });
});

describe('能力在 useBlock 里，且回执不再点名不存在的工具', () => {
  const interact = () => readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
  const actions = () => readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'actions.ts'), 'utf8');
  const skills = () => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

  it('useBlock 的 interact 分支真的会开箱拿东西（lootContainer）', () => {
    const src = interact();
    expect(src).toContain('skills.lootContainer(agent.bot, containerBlock)');
    expect(src).toContain('skills.formatLootReport(outcome)');
    expect(src).toContain("type.endsWith('shulker_box')");
  });

  it('模型可见的回执里不再出现"队友 takeFromChest 取"这类不可执行指引', () => {
    for (const src of [actions(), skills()]) {
      // 允许说明性句子（"没有 takeFromChest 这个工具"），但禁止把 it 当成可调用工具
      const offending = src
        .split('\n')
        .filter((line) => /takeFromChest/.test(line))
        .filter((line) => !/没有 takeFromChest 这个工具|不是工具|export async function|@example|await skills\.takeFromChest/.test(line));
      expect(offending).toEqual([]);
    }
  });

  it('死亡代价口径跟着 keepInventory=false 走（新世界 Hard、不掉保）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'safety', 'reflex_override.ts'), 'utf8');
    expect(src).toContain('这个存档**没有** keepInventory，死了会掉光背包——绝不能拿命去赌。');
  });
});
