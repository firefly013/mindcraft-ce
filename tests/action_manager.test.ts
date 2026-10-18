/**
 * TRIAGE 附注 1：`ActionManager.timedout` 会不会粘住？
 *
 * 静态看：`timedout` 只在构造时置 false（action_manager.ts:53），`_startTimeout`
 * 置 true（:253）后没有任何复位。若真粘住，**一次超时之后每个动作都会被报成
 * "超时"**（actions.ts:98 的分支会吞掉真实回执），而身体日志的保留策略
 * （action_manager.ts:235）也会跟着反过来。
 */
import { describe, expect, it, vi } from 'vitest';
import { ActionManager } from '../src/body/action_manager.js';

function fakeAgent(): any {
    const bot: any = { output: '', interrupt_code: false, emit: (): void => {} };
    return {
        bot,
        clearBotLogs: (): void => {
            bot.output = '';
            bot.interrupt_code = false;
        },
        requestInterrupt: (): void => {
            bot.interrupt_code = true;
        },
        cleanKill: vi.fn(),
    };
}

describe('ActionManager.timedout 只属于当前动作', () => {
    it('一次真超时之后，下一个动作不得被报成超时', async () => {
        vi.useFakeTimers();
        try {
            const agent = fakeAgent();
            const mgr = new ActionManager(agent);
            const bot = agent.bot;

            const first = mgr.runAction(
                'action:stay',
                async (): Promise<void> => {
                    // 模拟"身体卡住"：只有被硬中断（interrupt_code）才收手。
                    while (!bot.interrupt_code) {
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                },
                { timeout: 1 },
            );
            await vi.advanceTimersByTimeAsync(61_000);
            const firstResult = await first;
            expect(firstResult.timedout).toBe(true);

            // 第二个动作正常结束：绝不能被上一次的超时标记污染。
            const second = await mgr.runAction(
                'action:jump',
                async (): Promise<void> => {
                    bot.output += 'jumped\n';
                },
                { timeout: 1 },
            );
            expect(second.timedout).toBe(false);
            expect(second.message).toContain('jumped');
        } finally {
            vi.useRealTimers();
        }
    });
});
