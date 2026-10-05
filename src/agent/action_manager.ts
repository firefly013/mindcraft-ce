import assert from 'node:assert';
import { MESSAGES } from '../prompts.js';

export type ActionFn = () => unknown;

export interface ActionResult {
    success: boolean;
    message: string | null;
    interrupted: boolean;
    timedout: boolean;
}

export interface RunActionOptions {
    timeout?: number;
    resume?: boolean;
}

export class ActionManager {
    agent: any; // 交叉引用 Agent，避免循环依赖
    executing: boolean;
    currentActionLabel: string;
    currentActionFn: ActionFn | null;
    timedout: boolean;
    resume_func: ActionFn | null;
    resume_name: string | null;
    last_action_time: number;
    recent_action_counter: number;

    constructor(agent: any) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
    }

    resumeAction(actionFn?: ActionFn | null, timeout?: number): Promise<ActionResult> {
        // 保留原 .js 逻辑：把 (actionFn, timeout) 直接透传给 _executeResume 的前两个形参
        return this._executeResume(
            actionFn as unknown as string | null,
            timeout as unknown as ActionFn | null
        );
    }

    runAction(actionLabel: string, actionFn: ActionFn, { timeout, resume = false }: RunActionOptions = {}): Promise<ActionResult> {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop(): Promise<void> {
        if (!this.executing) return;
        const timeout = setTimeout(() => {
            this.agent.cleanKill('Action refused stop after 10 seconds. Killing process.');
        }, 10000);
        while (this.executing) {
            this.agent.requestInterrupt();
            console.log('waiting for action to finish executing...');
            await new Promise<void>(resolve => setTimeout(resolve, 300));
        }
        clearTimeout(timeout);
    }

    cancelResume(): void {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel: string | null = null, actionFn: ActionFn | null = null, timeout = 10): Promise<ActionResult> {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume)) {
            this.currentActionLabel = this.resume_name as string;
            const res = await this._executeAction(this.resume_name as string, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel: string, actionFn: ActionFn, timeout = 10): Promise<ActionResult> {
        let TIMEOUT: ReturnType<typeof setTimeout> | undefined;
        try {
            if (this.last_action_time > 0) {
                const time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    console.error('Infinite action loop detected, shutting down.');
                    this.agent.cleanKill('Infinite action loop detected, shutting down.');
                    return { success: false, message: 'Infinite action loop detected, shutting down.', interrupted: false, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing action...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
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
            this.cancelResume();
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
