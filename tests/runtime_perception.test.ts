/**
 * P5：每轮尾巴的拼装。
 *
 * 顺序与省略规则是 token / prompt-cache 敏感契约，必须逐字钉住：
 * **记忆摘要 → 世界快照**，空段丢弃，快照永远最后。
 *
 * 尾巴里**没有** `## 事件` 块：事件现在本身就是消息（L1/L2 走 `write`、
 * L3 走 `steer`），已在上下文里，再渲染一遍就是重复喂。见 `perception.ts`。
 */
import { describe, expect, it } from 'vitest';
import { composeLiveTail, liveTailFromTexts } from '../src/runtime/perception.js';

describe('liveTailFromTexts（纯拼装）', () => {
  it('记忆 + 快照的顺序与分隔', () => {
    expect(liveTailFromTexts('MEM', 'LIVE')).toBe('## 记忆摘要\nMEM\n\n## 当前世界快照\nLIVE');
  });

  it('记忆为空串或纯空白时整段省略', () => {
    expect(liveTailFromTexts('', 'LIVE')).toBe('## 当前世界快照\nLIVE');
    expect(liveTailFromTexts('   \n ', 'LIVE')).toBe('## 当前世界快照\nLIVE');
  });

  it('记忆正文被 trim，标题不加壳到别段底下', () => {
    expect(liveTailFromTexts('  MEM  ', 'LIVE')).toBe('## 记忆摘要\nMEM\n\n## 当前世界快照\nLIVE');
  });

  it('快照永远最后', () => {
    const tail = liveTailFromTexts('MEM', 'LIVE');
    expect(tail.endsWith('## 当前世界快照\nLIVE')).toBe(true);
  });
});

describe('composeLiveTail（接真实感知层）', () => {
  it('空 bot 也能采出快照，不抛', () => {
    const tail = composeLiveTail({ memory: '', sample: { bot: {} } });
    expect(tail.startsWith('## 当前世界快照')).toBe(true);
    expect(tail).not.toContain('## 记忆摘要');
  });

  it('真实读数进入快照', () => {
    const bot = {
      entity: { position: { x: 1.5, y: 64, z: -2.5 }, yaw: 0, pitch: 0 },
      health: 20,
      food: 18,
    };
    const tail = composeLiveTail({ memory: '', sample: { bot } });
    expect(tail).toContain('health 20');
    expect(tail).toContain('food 18');
  });

  it('记忆在快照之前', () => {
    const tail = composeLiveTail({ memory: '家在北边', sample: { bot: {} } });
    const memoryAt = tail.indexOf('## 记忆摘要');
    const liveAt = tail.indexOf('## 当前世界快照');
    expect(memoryAt).toBeGreaterThanOrEqual(0);
    expect(liveAt).toBeGreaterThan(memoryAt);
    expect(tail).toContain('家在北边');
  });

  it('goal / todos 来自计划，进快照的 Goal 行', () => {
    const tail = composeLiveTail({
      memory: '',
      sample: { bot: {}, goal: '造房子', todos: [{ text: '砍树', done: true }] },
    });
    expect(tail).toContain('造房子');
  });

  it('尾巴里不含事件块（事件已作为消息进上下文）', () => {
    const tail = composeLiveTail({ memory: '', sample: { bot: {} } });
    expect(tail).not.toContain('## 事件');
  });
});
