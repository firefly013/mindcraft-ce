/**
 * P5：每轮尾巴的拼装。
 *
 * 顺序与省略规则是 token / prompt-cache 敏感契约，必须逐字钉住：
 * 事件 → 记忆摘要 → 世界快照，空段丢弃，快照永远最后。
 */
import { describe, expect, it } from 'vitest';
import { composeLiveTail, liveTailFromTexts } from '../src/runtime/perception.js';

describe('liveTailFromTexts（纯拼装）', () => {
  it('三段齐全时的顺序与分隔', () => {
    expect(liveTailFromTexts('EV', 'MEM', 'LIVE')).toBe(
      'EV\n\n## 记忆摘要\nMEM\n\n## 当前世界快照\nLIVE',
    );
  });

  it('记忆为空串或纯空白时整段省略', () => {
    expect(liveTailFromTexts('EV', '', 'LIVE')).toBe('EV\n\n## 当前世界快照\nLIVE');
    expect(liveTailFromTexts('EV', '   \n ', 'LIVE')).toBe('EV\n\n## 当前世界快照\nLIVE');
  });

  it('事件为空时省略，但快照永远在最后', () => {
    expect(liveTailFromTexts('', '', 'LIVE')).toBe('## 当前世界快照\nLIVE');
    expect(liveTailFromTexts('', 'MEM', 'LIVE')).toBe(
      '## 记忆摘要\nMEM\n\n## 当前世界快照\nLIVE',
    );
  });

  it('记忆正文被 trim，标题不加壳到别段底下', () => {
    expect(liveTailFromTexts('', '  MEM  ', 'LIVE')).toBe(
      '## 记忆摘要\nMEM\n\n## 当前世界快照\nLIVE',
    );
  });
});

describe('composeLiveTail（接真实感知层）', () => {
  it('空 bot 也能采出快照，不抛', () => {
    const tail = composeLiveTail({ events: [], memory: '', sample: { bot: {} } });
    expect(tail.startsWith('## 当前世界快照')).toBe(true);
    expect(tail).not.toContain('## 记忆摘要');
  });

  it('真实读数进入快照', () => {
    const bot = {
      entity: { position: { x: 1.5, y: 64, z: -2.5 }, yaw: 0, pitch: 0 },
      health: 20,
      food: 18,
    };
    const tail = composeLiveTail({ events: [], memory: '', sample: { bot } });
    expect(tail).toContain('health 20');
    expect(tail).toContain('food 18');
  });

  it('事件在最前、快照在最后，记忆居中', () => {
    const tail = composeLiveTail({
      events: [{ seq: 1, kind: 'World', level: 3, payload: { type: 'entity.hostile_nearby' } }],
      memory: '家在北边',
      sample: { bot: {} },
    });
    const eventsAt = tail.indexOf('## 事件');
    const memoryAt = tail.indexOf('## 记忆摘要');
    const liveAt = tail.indexOf('## 当前世界快照');
    expect(eventsAt).toBeGreaterThanOrEqual(0);
    expect(memoryAt).toBeGreaterThan(eventsAt);
    expect(liveAt).toBeGreaterThan(memoryAt);
    expect(tail).toContain('entity.hostile_nearby');
    expect(tail).toContain('家在北边');
  });

  it('goal / todos 来自计划，进快照的 Goal 行', () => {
    const tail = composeLiveTail({
      events: [],
      memory: '',
      sample: {
        bot: {},
        goal: '造房子',
        todos: [{ text: '砍树', done: true }],
      },
    });
    expect(tail).toContain('造房子');
  });
});
