/**
 * 裸装拒绝不许给"不可能的下一步"（Lead 2026-10-21：血 7、空手、脚下 stone，
 * digDown 说"先换正确的工具"——裸装永远没有镐，这是墙）。
 *
 * 第二轮（同日，用 CLI 当玩家实测）：只给三条**通用**建议仍然不够——那次周围全是石头、
 * 只有 2 个土、洞口已不记得，**三条建议一条都不可行**，模型读到一段"看起来有出路、
 * 实际没有"的文案，继续对 stone 发同一条命令。
 * 所以契约改成：**就地测量**附近有没有软方块、有没有能钻的洞口，
 * 都有就说走哪条，都没有就直说"这一列确实没路"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('裸手挖不动的拒绝文案', () => {
  // 锚点：breakBlockAt 里那段"就地测量"（附近软方块/可钻洞口），
  // 它**紧跟** planDig 的拒绝 note 之后打印，所以一起看。
  const anchor = 'const measured = softNearby > 0 || caveNearby > 0;';
  const region = (): string => {
    const code = skills();
    const i = code.indexOf(anchor);
    return i < 0 ? '' : code.slice(i, i + 3000);
  };

  it('不再只说"先换正确的工具再来"（那对裸装不可能）', () => {
    expect(region()).not.toContain('先换正确的工具再来');
    // 拒绝 note 本身必须给出 force 这条出路
    expect(skills()).toContain('force=true');
  });

  it('拒绝里带**就地测量**的结果，而不是没验证过的通用建议', () => {
    const r = region();
    // 测出来的软方块
    expect(r).toMatch(/dirt/);
    expect(r).toMatch(/gravel|sand/);
    // 测出来的洞口
    expect(r).toMatch(/洞口|cave|空腔/);
    // 关键：有"实测"和"没路"这两个分支的说法
    expect(r).toContain('实测');
    expect(r).toMatch(/确实没路|没有/);
  });

  // 2026-10-24：处方删掉（"别再对着它硬挖：换个方向…"）——回执只报实测事实，
  // 怎么走由模型判断。守卫反过来：不许再把"别再"式命令写回回执。
  it('实测都没有出路时，只报事实，不再塞"别再…"式命令', () => {
    expect(region()).not.toMatch(/别再/);
    expect(region()).toContain('这一列确实没路');
  });
});
