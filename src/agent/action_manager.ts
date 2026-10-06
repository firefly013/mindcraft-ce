/*
 * 动作执行器（薄）：跑一个动作函数、维护执行状态、收集输出摘要。
 *
 * **身体通道的唯一真相是 Scheduler**（`action_runner.ts` 认领/释放，
 * 同一时刻最多一个动作）。这里不再有自己的"忙/闲"判据去打断别人——
 * 那正是以前"两套通道各自为政"的病根：
 *   - `ActionManager.executing` 和 `Scheduler.action` 各说各话；
 *   - 每个动作入口先 `await this.stop()` 打断上一个，于是模型被 L3
 *     事件叫醒后重发同一动作时，会把**自己正在做的事**打断重来。
 *
 * 已删除的整套 resume 机制（`resume_func` / `_executeResume` /
 * `cancelResume` / `bot.on('idle')` 重放钩子）：它只被 `followPlayer`
 * 用过一次（`runAsAction(fn, true)`），做的是"每次 idle 就把上一个动作
 * 偷偷重放一遍"。那是**绕过身体通道的隐藏决策者**：动作结束了却不由
 * 模型决定要不要继续，于是"跟随"永远停不下来，而模型对此一无所知。
 * 现在 `followPlayer` 是一个正常的占用型动作——一直占着通道，直到模型
 * 调 `Stop`（见 docs/agent-design.md §6）。
 */

import { MESSAGES } from '../prompts.js';

export type ActionFn = () => unknown;

export interface ActionResult {
    success: boolean;
    message: string | null;
    interrupted: boolean;
    timedout: boolean;
}

export interface RunActionOptions {
    /** 超时分钟数；<= 0 表示不设超时。 */
    timeout?: number;
}

/** 停止一个卡住的动作的兜底等待上限（毫秒）。 */
export const STOP_WAIT_MS = 10_000;

export class ActionManager {
    agent: any; // 交叉引用 Agent，避免循环依赖
    executing: boolean;
    currentActionLabel: string;
    currentActionFn: ActionFn | null;
    timedout: boolean;

    constructor(agent: any) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
    }

    /**
     * 单发执行一个动作。
     *
     * 入口的 `stop()` 是**兜底**而不是常规路径：调度器的身体通道保证了
     * 同一时刻只有一个动作，所以这里通常是空操作（`stop()` 在没执行时
     * 立刻返回）。万一有路径绕过了通道，它最多做到"等上一个真的停下来"。
     */
    async runAction(actionLabel: string, actionFn: ActionFn, { timeout = -1 }: RunActionOptions = {}): Promise<ActionResult> {
        return await this._executeAction(actionLabel, actionFn, timeout);
    }

    /**
     * 停掉正在跑的动作：不断请求打断，直到动作函数真的返回。
     *
     * 必须**等**：先释放通道再让身体继续动，就是"Stop 了但还在挖"。
     * 超过 `STOP_WAIT_MS` 还没停下来才认输杀掉进程——这是最后的保险丝，
     * 正常路径永远走不到。
     */
    async stop(): Promise<void> {
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Action refused stop after 10 seconds. Killing process.');
        }, STOP_WAIT_MS);
        while (this.executing) {
            this.agent.requestInterrupt();
            console.log('waiting for action to finish executing...');
            await new Promise<void>(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    }

    async _executeAction(actionLabel: string, actionFn: ActionFn, timeout = -1): Promise<ActionResult> {
        let TIMEOUT: ReturnType<typeof setTimeout> | undefined;
        try {
            console.log('executing action...\n');

            // await current action to finish (executing=false)，兜底用。
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            if (TIMEOUT !== undefined) clearTimeout(TIMEOUT);

            // get bot activity summary
            const output = this.getBotOutputSummary();
            const interrupted = this.agent.bot.interrupt_code as boolean;
            const timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err: unknown) {
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            if (TIMEOUT !== undefined) clearTimeout(TIMEOUT);
            console.error("Action triggered catch:", err);
            // Log the full stack trace
            console.error(err instanceof Error ? err.stack : err);
            await this.stop();
            const errStr = String(err);
            const errStack = err instanceof Error ? err.stack : undefined;

            const message = this.getBotOutputSummary() +
                '!!Action threw exception!!\n' +
                'Error: ' + errStr + '\n' +
                'Stack trace:\n' + errStack + '\n';

            const interrupted = this.agent.bot.interrupt_code as boolean;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    getBotOutputSummary(): string {
        const { bot } = this.agent as { bot: any }; // mineflayer 无类型，bot 统一 any
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output as string;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10): ReturnType<typeof setTimeout> {
        return setTimeout(async () => {
            console.warn(MESSAGES.actionTimeout(TIMEOUT_MINS));
            this.timedout = true;
            this.agent.history.add('system', MESSAGES.actionTimeout(TIMEOUT_MINS));
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }
}
