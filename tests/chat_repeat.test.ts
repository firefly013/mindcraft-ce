
/**
 * 批量广播去重 + 指令回显黑名单。
 *
 * 真机事故（2026-10-18 23:26）：玩家的建造工具以 `mcbuild` 的名字批量填充方块，
 * 每批广播一条 `Successfully filled 15 block(s)`；两个 bot 每条都被要求
 * 「先用 Say 回一句」——80+ 条把上下文刷爆（它们各自报了这条 Feedback）。
 */
import { describe, expect, it } from 'vitest';
import { CHAT_REPEAT_MAX, CHAT_REPEAT_WINDOW_MS, noteChatRepeat, type ChatRepeatState } from '../src/shared/chat.js';

function fresh(): Map<string, ChatRepeatState> {
  return new Map();
}

describe('批量广播去重', () => {
  it('前 3 条正常投递，第 4 条起只提示一次、之后静默', () => {
    const s = fresh();
    const t0 = 1_000_000;
    const verdicts = [1, 2, 3, 4, 5, 6].map((i) =>
      noteChatRepeat(s, 'mcbuild', 'Successfully filled 15 block(s)', t0 + i * 200).verdict,
    );
    expect(verdicts).toEqual(['allow', 'allow', 'allow', 'first-suppress', 'suppress', 'suppress']);
    expect(CHAT_REPEAT_MAX).toBe(3);
  });

  it('不同的人、或不同的话，各自独立计数（真人聊天不受影响）', () => {
    const s = fresh();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i += 1) noteChatRepeat(s, 'mcbuild', 'Successfully filled 15 block(s)', t0 + i);
    expect(noteChatRepeat(s, 'mcbuild', '你们在干嘛？', t0 + 10).verdict).toBe('allow');
    expect(noteChatRepeat(s, 'bobo', 'Successfully filled 15 block(s)', t0 + 11).verdict).toBe('allow');
    // 但那个人那句还在被压着
    expect(noteChatRepeat(s, 'mcbuild', 'Successfully filled 15 block(s)', t0 + 12).verdict).toBe('suppress');
  });

  it('超出窗口就重新计数（慢速刷屏仍会被抓，久远的一句不算）', () => {
    const s = fresh();
    const t0 = 1_000_000;
    const late = t0 + CHAT_REPEAT_WINDOW_MS + 1;
    for (let i = 0; i < 4; i += 1) noteChatRepeat(s, 'mcbuild', 'x', t0 + i);
    expect(noteChatRepeat(s, 'mcbuild', 'x', late).verdict).toBe('allow');
  });

  it('计的是"同一个人的同一句话"，不是条数总量', () => {
    const s = fresh();
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i += 1) {
      const v = noteChatRepeat(s, 'mcbuild', 'filled batch #' + String(i), t0 + i).verdict;
      expect(v).toBe('allow');
    }
  });
});
