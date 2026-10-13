/**
 * 事件流契约：调度器挑出来的未见事件必须原样进得了提示词。
 *
 * 这里锁的是三件事：一行一条、单条封顶、以及"事件在前、快照收尾"
 * 的最终拼接顺序。事件曾经只写进一个没人读的台账（loopLog），
 * 模型被叫醒了却不知道原因——这组用例就是那条回归线。
 */
import { describe, expect, it } from 'vitest';
import {
  composeTail,
  eventTextFor,
  formatEventEntry,
  renderEventText,
  renderEvents,
  ENTRY_LIMIT,
} from '../src/shared/event_stream.js';

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

  it('emits only the wake marker — the bodies live in history, not twice', () => {
    const block = renderEvents([
      { seq: 1, kind: 'World', level: 5, payload: { type: 'a' } },
      { seq: 2, kind: 'Tool', level: 2, payload: { type: 'b' } },
    ]);
    const lines = block.split('\n');
    expect(lines[0]).toBe('## 本轮新事件');
    expect(lines[1]).toBe('#1 #2');
    // 关键：正文不再重发（否则同一条消息会在一个请求里出现两次）。
    expect(block).not.toContain('"type":"a"');
  });
});

describe('composeTail', () => {
  it('puts live state last so the cacheable prefix stays stable', () => {
    expect(composeTail('## 本轮新事件\n#1', '## 当前世界快照\n血量 20')).toBe(
      '## 本轮新事件\n#1\n\n## 当前世界快照\n血量 20',
    );
  });

  it('drops empty blocks instead of leaving bare headers', () => {
    expect(composeTail('', '## 当前世界快照\n血量 20')).toBe('## 当前世界快照\n血量 20');
    expect(composeTail('', '', '')).toBe('');
    expect(composeTail(undefined, null, 'live')).toBe('live');
  });

  it('keeps events → live in that order', () => {
    expect(composeTail('## 本轮新事件\n#1', '## 当前世界快照\nlive')).toBe(
      '## 本轮新事件\n#1\n\n## 当前世界快照\nlive',
    );
  });
});

/**
 * 事件文本的归属（跨语言契约，D-59）。
 *
 * Mineflayer 身体能 import `renderEventText`，所以它渲染；**Java 身体渲染不了**
 * （那是 TS 函数），它只发 `{kind, level, payload}` 三元组、`text` 留空，
 * 由大脑渲染。这组用例锁的就是"空文本必须被大脑接住"——
 * 它一旦失效，Java 身体推来的每条事件在模型眼里都是空字符串。
 */
describe('eventTextFor：身体不渲染时由大脑渲染', () => {
  it('身体渲染过就原样用（不许重渲，那是两份文本的起点）', () => {
    const bodyText = '[事件] World/L2 身体渲染的版本';
    expect(eventTextFor('World', 2, { type: 'x' }, bodyText)).toBe(bodyText);
  });

  it('身体没渲染（空串）就由大脑渲染，格式与身体渲染的完全一致', () => {
    const payload = { type: 'world.hostile_far', key: 'creeper' };
    const rendered = eventTextFor('World', 2, payload, '');
    // 和身体用的同一个渲染器，所以两边产出的文本必然同形。
    expect(rendered).toBe(renderEventText('World', 2, payload));
    expect(rendered).toContain('[事件] World/L2');
    expect(rendered).toContain('creeper');
  });

  it('Java 身体的典型输入：只有三元组、text 为空', () => {
    const text = eventTextFor('User', 3, { source: 'developer', message: '挖点木头' }, '');
    expect(text).toContain('挖点木头');
  });
});
