/**
 * 事件流契约：调度器挑出来的未见事件必须原样进得了提示词。
 *
 * 这里锁的是三件事：一行一条、单条封顶、以及"事件在前、快照收尾"
 * 的最终拼接顺序。事件曾经只写进一个没人读的台账（loopLog），
 * 模型被叫醒了却不知道原因——这组用例就是那条回归线。
 */
import { describe, expect, it } from 'vitest';
import { composeTail, formatEventEntry, renderEvents, ENTRY_LIMIT } from '../src/agent/event_stream.js';

describe('formatEventEntry', () => {
  it('renders #seq kind/Llevel with the payload as JSON', () => {
    const line = formatEventEntry({ seq: 12, kind: 'World', level: 5, payload: { type: 'world.tnt.primed_nearby', key: 5 } });
    expect(line).toBe('#12 World/L5 {"type":"world.tnt.primed_nearby","key":5}');
  });

  it('keeps a user message readable', () => {
    const line = formatEventEntry({ seq: 3, kind: 'User', level: 3, payload: { source: 'Steve', message: '帮我挖点木头' } });
    expect(line).toContain('#3 User/L3');
    expect(line).toContain('帮我挖点木头');
  });

  it('marks missing fields instead of printing undefined', () => {
    expect(formatEventEntry({})).toBe('#? Event/L? null');
  });

  it('truncates long payloads and says how much was cut', () => {
    const line = formatEventEntry({ seq: 1, kind: 'Tool', level: 2, payload: { blob: 'x'.repeat(ENTRY_LIMIT * 2) } });
    expect(line).toContain('[truncated');
    expect(line.length).toBeLessThan(ENTRY_LIMIT + 200);
  });

  it('survives an unserializable payload', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(formatEventEntry({ seq: 1, kind: 'Tool', level: 2, payload: circular })).toBe('#1 Tool/L2 [unserializable]');
  });
});

describe('renderEvents', () => {
  it('returns an empty string when there is nothing to say', () => {
    expect(renderEvents([])).toBe('');
    expect(renderEvents(null)).toBe('');
    expect(renderEvents(undefined)).toBe('');
  });

  it('heads the block and emits one line per event, in order', () => {
    const block = renderEvents([
      { seq: 1, kind: 'World', level: 5, payload: { type: 'a' } },
      { seq: 2, kind: 'Tool', level: 2, payload: { type: 'b' } },
    ]);
    const lines = block.split('\n');
    expect(lines[0]).toBe('## 事件');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('#1 World/L5');
    expect(lines[2]).toContain('#2 Tool/L2');
  });
});

describe('composeTail', () => {
  it('puts live state last so the cacheable prefix stays stable', () => {
    expect(composeTail('## 事件\n#1 World/L5 {"type":"a"}', '## 当前世界快照\n血量 20')).toBe(
      '## 事件\n#1 World/L5 {"type":"a"}\n\n## 当前世界快照\n血量 20',
    );
  });

  it('drops empty blocks instead of leaving bare headers', () => {
    expect(composeTail('', '## 当前世界快照\n血量 20')).toBe('## 当前世界快照\n血量 20');
    expect(composeTail('', '', '')).toBe('');
    expect(composeTail(undefined, null, 'live')).toBe('live');
  });

  it('keeps events → memory → live in that order', () => {
    expect(composeTail('## 事件\nevent', '## 记忆摘要\nmem', '## 当前世界快照\nlive')).toBe(
      '## 事件\nevent\n\n## 记忆摘要\nmem\n\n## 当前世界快照\nlive',
    );
  });
});
