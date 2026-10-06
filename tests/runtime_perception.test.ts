/**
 * 每轮尾巴：**只有世界快照**。
 *
 * 两条"不该在这里"的都要钉住：
 * - `## 事件`：事件本身就是消息（L1/L2 write、L3 steer），再渲染一遍是重复喂
 * - `## 记忆摘要`：记忆就是压仓摘要，作为历史第一条随整份历史发出，再发一遍也是重复喂
 */
import { describe, expect, it } from 'vitest';
import { composeLiveTail, liveTailFromText } from '../src/runtime/perception.js';

describe('liveTailFromText（纯拼装）', () => {
  it('只有快照段，标题在', () => {
    expect(liveTailFromText('LIVE')).toBe('## 当前世界快照\nLIVE');
  });

  it('快照永远收尾（它是这一轮最新鲜的东西，也是缓存前缀的边界）', () => {
    expect(liveTailFromText('LIVE').endsWith('## 当前世界快照\nLIVE')).toBe(true);
  });
});

describe('composeLiveTail（接真实感知层）', () => {
  it('空 bot 也能采出快照，不抛', () => {
    const tail = composeLiveTail({ bot: {} });
    expect(tail.startsWith('## 当前世界快照')).toBe(true);
  });

  it('真实读数进入快照', () => {
    const bot = {
      entity: { position: { x: 1.5, y: 64, z: -2.5 }, yaw: 0, pitch: 0 },
      health: 20,
      food: 18,
    };
    const tail = composeLiveTail({ bot });
    expect(tail).toContain('health 20');
    expect(tail).toContain('food 18');
  });

  it('goal / todos 来自计划，进快照', () => {
    const tail = composeLiveTail({
      bot: {},
      goal: '造房子',
      todos: [{ text: '砍树', done: true }],
    });
    expect(tail).toContain('造房子');
  });

  it('不含事件块（事件已作为消息进上下文）', () => {
    expect(composeLiveTail({ bot: {} })).not.toContain('## 事件');
  });

  it('不含记忆段（记忆是压仓摘要，随历史发出）', () => {
    expect(composeLiveTail({ bot: {} })).not.toContain('## 记忆摘要');
  });
});
