/**
 * 聊天投递判定：玩家 vs 队友，谁要唤醒、谁要回话。
 *
 * 这条测钉的是双 bot 真机事故：队友消息曾经和玩家消息走同一条路
 * （`expectReply: true` + L3 唤醒），于是两个 bot 互相 Say 报坐标变成
 * 「报坐标 → 收到 → 回一句 → 对方再收到」的**无限乒乓**——一晚烧掉大量请求，
 * 真正的活被挤掉。队友的话是**情报**（默认只记录），玩家的话才是**提问**。
 */
import { describe, expect, it } from 'vitest';
import { classifyChat } from '../src/shared/chat.js';

const self = 'overnight_a';

describe('玩家消息：有人在直接问你', () => {
  it('普通聊天 → L3 唤醒 + 要求回话', () => {
    const d = classifyChat({ message: '你们能听到我说话吗？', fromTeammate: false, whisper: false, selfName: self });
    expect(d).toEqual({ addressed: true, level: 3, expectReply: true });
  });

  it('喊急停词 → L4 抢占', () => {
    const d = classifyChat({ message: 'Stop 一下', fromTeammate: false, whisper: false, selfName: self });
    expect(d.level).toBe(4);
    expect(d.expectReply).toBe(true);
  });
});

describe('队友消息：默认是情报，不是提问', () => {
  it('报坐标这种状态同步 → L2 只记录、不要求回话（乒乓的根因）', () => {
    const d = classifyChat({
      message: '📍(124.5,39,18.4) 待机等 wooden_pickaxe，血食 20/20',
      fromTeammate: true,
      whisper: false,
      selfName: self,
    });
    expect(d).toEqual({ addressed: false, level: 2, expectReply: false });
  });

  it('点名喊我 → L3 唤醒 + 要求回话', () => {
    const d = classifyChat({
      message: 'overnight_a 你到哪了？',
      fromTeammate: true,
      whisper: false,
      selfName: self,
    });
    expect(d).toEqual({ addressed: true, level: 3, expectReply: true });
  });

  it('点名不区分大小写', () => {
    const d = classifyChat({ message: 'OVERNIGHT_A 过来', fromTeammate: true, whisper: false, selfName: self });
    expect(d.addressed).toBe(true);
  });

  it('私聊 → 算在跟我说话', () => {
    const d = classifyChat({ message: '我在门边等你', fromTeammate: true, whisper: true, selfName: self });
    expect(d).toEqual({ addressed: true, level: 3, expectReply: true });
  });

  it('队友喊救命 → 不管有没有点名都抢占', () => {
    const d = classifyChat({ message: '救命，我被岩浆困住了', fromTeammate: true, whisper: false, selfName: self });
    expect(d.level).toBe(4);
  });
});
