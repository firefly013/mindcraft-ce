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

describe('队友点名唤醒的预算：状态刷屏不许每条都叫醒', () => {
  it('刚被叫醒过（<90s）又点名 → 压回 L2，且不要求回话', () => {
    const d = classifyChat({
      message: 'overnight_a：我在 (124,39,18) 等你',
      fromTeammate: true,
      whisper: false,
      selfName: self,
      sinceLastWakeMs: 10_000,
    });
    expect(d).toEqual({ addressed: true, level: 2, expectReply: false, rateLimited: true });
  });

  it('超过 90s 再点名 → 正常唤醒', () => {
    const d = classifyChat({
      message: 'overnight_a：过来拿镐子',
      fromTeammate: true,
      whisper: false,
      selfName: self,
      sinceLastWakeMs: 91_000,
    });
    expect(d).toEqual({ addressed: true, level: 3, expectReply: true });
  });

  it('从没叫过（null）→ 正常唤醒', () => {
    const d = classifyChat({
      message: 'overnight_a 在吗',
      fromTeammate: true,
      whisper: false,
      selfName: self,
      sinceLastWakeMs: null,
    });
    expect(d.level).toBe(3);
  });

  it('急停词**不走**预算：刚叫醒过也照样抢占', () => {
    const d = classifyChat({
      message: 'overnight_a 救命！',
      fromTeammate: true,
      whisper: false,
      selfName: self,
      sinceLastWakeMs: 1_000,
    });
    expect(d.level).toBe(4);
    expect(d.rateLimited).toBeUndefined();
  });

  it('私聊走同一条预算（同样是队友消息）', () => {
    const d = classifyChat({
      message: '我在门边等你',
      fromTeammate: true,
      whisper: true,
      selfName: self,
      sinceLastWakeMs: 5_000,
    });
    expect(d.level).toBe(2);
    expect(d.rateLimited).toBe(true);
  });
});
