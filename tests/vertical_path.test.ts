/**
 * 上行/下行必须**消费 obstacles**（Lead 2026-10-21）：四个工具都死在「挖通了但走不进去」，
 * 而 stepIntoCell 已经说出了障碍物坐标/名字——调用方要顺手挖掉它再走。
 * 另外：刚放下的方块被"原版拾取"捡回，是 playerCollect 路径，绕过目标过滤器。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');
const progression = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'progression.ts'), 'utf8');
const body = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

describe('一个上/下行的原语：走不进就挖掉挡路格', () => {
  it('stepIntoCellClearing：只挖目标脚格/头格，最多 3 格，然后重试原语', () => {
    const code = skills();
    expect(code).toContain('export async function stepIntoCellClearing');
    expect(code).toContain('maxClears = 3');
    expect(code).toContain('digWithTimeout(');
    expect(code).toContain('result = await stepIntoCell(bot, target);');
  });

  it('digDown / stairUp / travelTo(mineTunnel) 都改用它（同一路径，不是四个补丁）', () => {
    const s = skills();
    const p = progression();
    expect(s).toContain('const sunkInto = await stepIntoCellClearing(bot');
    expect(s).toContain('const step = await stepIntoCellClearing(bot');
    expect(p).toContain('await skills.stepIntoCellClearing(bot, step.feet)');
    // 回执要把"顺手挖开了什么"写出来，而不是只报失败
    expect(s).toContain('step.cleared.length');
  });

  it('原来的裸 stepIntoCell 调用不再出现在这三个调用点', () => {
    expect(skills()).not.toContain('await stepIntoCell(bot, { x: verdict.target.x');
    expect(progression()).not.toContain('await skills.stepIntoCell(bot, step.feet)');
  });
});

describe('刚放下的方块被原版拾取（playerCollect 路径）也要拦住', () => {
  it('识别 placed-drop-collected ⇒ 不报"捡到"，并自动放回；失败时如实说', () => {
    const code = body();
    expect(code).toContain('placed-drop-collected');
    expect(code).toContain('isJustPlacedDrop(expectedItem, dropPos)');
    expect(code).toContain('已自动放回原位');
    expect(code).toContain('放回失败');
  });
});
