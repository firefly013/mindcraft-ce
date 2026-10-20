/**
 * 裸装拒绝不许给"不可能的下一步"（Lead 2026-10-21：血 7、空手、脚下 stone，
 * digDown 说"先换正确的工具"——裸装永远没有镐，这是墙）。
 * 拒绝必须给**现在就能做**的三个动作，并明确劝阻继续 digDown。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const skills = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');

describe('裸手挖不动的拒绝文案', () => {
  it('不再只说"先换正确的工具再来"（那对裸装不可能）', () => {
    const code = skills();
    const region = code.slice(code.indexOf('空手挖不动'), code.indexOf('空手挖不动') + 900);
    expect(region).not.toContain('先换正确的工具再来');
    expect(region).toContain('dirt/gravel/sand');
    expect(region).toContain('洞穴');
    expect(region).toContain('不要');
  });
  it('三条动作都在：软土下挖 / 找洞穴躲 / 等天亮换方向', () => {
    const region = skills().slice(skills().indexOf('空手挖不动'), skills().indexOf('空手挖不动') + 900);
    expect(region).toMatch(/dirt\/gravel\/sand/);
    expect(region).toMatch(/洞穴|矿道/);
    expect(region).toMatch(/天亮了再动|换个方向/);
  });
});
