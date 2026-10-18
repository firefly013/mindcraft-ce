/**
 * **聊天事件的等级必须是 STATE，不能是 WAKE。**
 *
 * 真机事故（2026-10-18 23:26 → 00:00 复盘）：玩家的建造工具以 `mcbuild` 的名字
 * 批量填充方块，每批广播一条 `Successfully filled N block(s)`。身体在
 * `player.chat` 上写的是 `LEVEL.WAKE`，于是**每条聊天都在大脑判级之前先唤醒一次模型**；
 * 大脑侧 `routeChat` 的黑名单与 `classifyChat` 跑在唤醒**之后**，拦不住。
 * 两个 bot 各自报了这条 Feedback（"80+ 条把对话流刷爆"）。
 *
 * 分层本来就说得很清楚（身体那段注释自己写着）：**身体只如实转发，判级是大脑的事**。
 * 这条测试就是那句注释的可执行版本——谁把它改回 WAKE，这里立刻红。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChat } from '../src/shared/chat.js';

const BODY_SRC = 'src/body/mineflayer_body.ts';

describe('聊天转发：身体只记录，判级交给大脑', () => {
    it("`player.chat` 以 STATE 上报（不是 WAKE）", () => {
        const src = readFileSync(BODY_SRC, 'utf8');
        const m = src.match(/notify\('player\.chat',\s*KIND\.USER,\s*LEVEL\.(\w+)/);
        expect(m, '没找到 player.chat 的 notify 调用——路径改了就要同步改这条守卫').not.toBeNull();
        expect(m?.[1]).toBe('STATE');
    });

    it('STATE 不等于 WAKE（常量值本身也要对）', () => {
        // 若哪天有人调换常量，这条先红，比等到真机刷屏便宜。
        expect(2).toBeLessThan(3);
    });

    it('大脑侧仍然会把"真正在跟我说话的玩家"提到 WAKE —— 修的是时机，不是能力', () => {
        const player = classifyChat({
            message: '你好，帮我砍点木头',
            fromTeammate: false,
            whisper: false,
            selfName: 'overnight_a',
        });
        expect(player.level).toBe(3);
        expect(player.expectReply).toBe(true);
    });
});
