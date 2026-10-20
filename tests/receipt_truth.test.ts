/**
 * 回执精度（Lead 2026-10-20）：引擎**检测**对了，但**说得**不对。
 *  ② 熔炉「真丢：1」误判——原料其实已变成产物、只是还在炉内产物槽；
 *  ① 火把合成同一份回执既说成功又说没产出，还编造「现在背包里有 4 个」。
 * 规则：一句话只有一个声音；以**实测**为准；未测量的数字不许写。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatSmeltAccounting,
  unaccountedInput,
} from '../src/body/commands/interact.js';

const interact = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'commands', 'interact.ts'), 'utf8');
const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('② 熔炉账目：产物槽是合法的"东西所在处"', () => {
  it('真机反例（input 0 / 产物槽 1 / 背包 +0）⇒ 真丢 0，并指出"去取一次就行"', () => {
    const accounting = {
      rawName: 'raw_iron',
      productName: 'iron_ingot',
      bagBefore: 1,
      bagAfter: 0,
      furnaceInput: 0,
      furnaceFuel: 0,
      furnaceOutput: 1,
      productGained: 0,
      target: 1,
    };
    expect(unaccountedInput(accounting)).toBe(0);
    const text = formatSmeltAccounting(accounting, 1).join('\n');
    expect(text).toContain('真丢：**0**');
    expect(text).toContain('没取');
    expect(text).not.toContain('对不上账');
  });

  it('smelt 报失败时也要把产物取出来（源码守卫）', () => {
    const code = interact();
    expect(code).toContain('const takeFurnaceOutput');
    expect(code).toContain('if ((accounting.furnaceOutput ?? 0) > 0) {');
    expect(code).toContain('已取回');
  });
});

describe('① 合成回执：不许两个声音、不许编造数字', () => {
  it('"现在背包里有 N 个"这句未测量断言已删除，改成背包实测', () => {
    const code = skills();
    expect(code).not.toContain('现在背包里有 ${got} 个');
    expect(code).toContain('**背包实测**');
  });

  it('材料不够那条也不再断言"现在背包里有"', () => {
    expect(skills()).not.toContain('现在背包里有 ${got} 个 ${itemName}');
  });
});
