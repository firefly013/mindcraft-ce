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
 * 调 `Stop`。
 */

import { MESSAGES } from '../shared/prompts.js';

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
    /** 当前动作开始时刻；锁快照用。 */
    currentStartedAt: number;

    constructor(agent: any) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.currentStartedAt = 0;
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
     * 身体侧硬中断：取消寻路、停止挖掘/收集、清控制状态，再置 interrupt 标志。
     *
     * 这是 Stop 的第一手段，不是等到 10 秒超时才做的事。真实故障里
     * digDown 撞水后 `stop()` 只反复调 `requestInterrupt`，而 mineshaft/
     * pathfinder 仍握着方向盘，于是 10 秒后被 cleanKill 杀进程、整晚回出生点。
     * 这里把「身体实际能收手的地方」一次全碰一遍。
     */
    hardInterrupt(): void {
        try {
            this.agent?.requestInterrupt?.();
        } catch {
            // 某一条底层调用坏掉不能阻止其他中断手段。
        }
        const bot = this.agent?.bot;
        try {
            bot?.clearControlStates?.();
        } catch {
            // 同上：逐条兜底，不让一个异常吞掉后面的清场。
        }
        try {
            bot?.pathfinder?.stop?.();
        } catch {
            // 同上。
        }
        try {
            bot?.stopDigging?.();
        } catch {
            // 同上。
        }
        if (bot != null) {
            bot.interrupt_code = true;
            // 中断回执要能指名是谁（见 commands/actions.ts）：这里是显式 Stop 的路径。
            if (bot.__interruptReason == null) bot.__interruptReason = 'Stop（显式停止）';
        }

    }

    /**
     * 释放当前动作标记，唤醒任何在看 `executing` 的等待者。
     *
     * 只在 stop 已经确认「硬中断也停不下来」、准备走 cleanKill 最后一条路时
     * 调用：它让 stop 循环本身不再无限挂起，也让上层知道通道已让出。
     */
    releaseCurrentAction(): void {
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.currentStartedAt = 0;
    }

    /** 锁快照：谁占用、多久。busy/Stop 日志都靠它。 */
    lockSnapshot(): { executing: boolean; label: string; runningMs: number } {
        return {
            executing: this.executing,
            label: this.currentActionLabel === '' ? '(idle)' : this.currentActionLabel,
            runningMs: this.currentStartedAt === 0 ? 0 : Math.max(0, Date.now() - this.currentStartedAt),
        };
    }

    /**
     * 停掉正在跑的动作：先硬中断，再等动作函数真的返回。
     *
     * 必须**等**：先释放通道再让身体继续动，就是"Stop 了但还在挖"。
     * 只有硬中断 + `STOP_WAIT_MS` 仍然停不下来，才认输杀进程；杀之前
     * 报出具体卡住的动作名——静默 cleanKill 会让整晚的问题查不出来。
     */
    async stop(): Promise<void> {
        if (!this.executing) return;
        const lock = this.lockSnapshot();
        console.log('stopping action lock:', JSON.stringify(lock));
        const stuckLabel = this.currentActionLabel === '' ? '(unknown action)' : this.currentActionLabel;
        const timeout = setTimeout(() => {
            this.hardInterrupt();
            if (this.executing) {
                // 先释放动作标记、唤醒等待者；动作函数仍不返回才杀进程。
                this.releaseCurrentAction();
                this.agent.cleanKill(
                    'Action "' + stuckLabel + '" refused stop after ' + (STOP_WAIT_MS / 1000) +
                    ' seconds of hard interrupts. Killing process.',
                );
            }
        }, STOP_WAIT_MS);

        // 第一下就硬中断，不等 300ms。
        this.hardInterrupt();
        while (this.executing) {
            console.log('waiting for action "' + stuckLabel + '" to finish executing...');
            await new Promise<void>(resolve => setTimeout(resolve, 300));
            this.hardInterrupt();
        }
        clearTimeout(timeout);
        // stop 返回时动作已经停了：锁快照必须归零，模型下一轮立刻能继续。
        this.releaseCurrentAction();
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
            this.currentStartedAt = Date.now();
            // **超时标记只属于当前动作。** 以前只在构造时置 false，一次真超时之后
            // 每个动作都会被读成 timedout=true：回执全走"超时"分支（真消息被吞）、
            // 身体日志的保留策略也跟着反过来。这里每次开跑都复位。
            this.timedout = false;

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
            this.currentStartedAt = 0;
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
            this.currentStartedAt = 0;
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
        const MAX_OUT = 900;
        if (output.length > MAX_OUT) {
            // **中段不许直接扔**（2026-10-21 实测：用 CLI 当玩家时 goToSurface 输出 2691 字符，
            // 截断后只留首尾各 250，而"空手挖不动 stone / 没有可走的路线"这些**真正的原因正好在中段**，
            // 玩家看到的是一个没有理由的失败）。现在：首 + **从被丢掉的中段里捞诊断行** + 尾。
            const head = output.substring(0, Math.floor(MAX_OUT / 3));
            const tail = output.substring(output.length - Math.floor(MAX_OUT / 3));
            const middle = output.substring(Math.floor(MAX_OUT / 3), output.length - Math.floor(MAX_OUT / 3));
            const diagRe = /(不能|无法|失败|没有|挖不动|够不着|拒绝|停止|不生效|错误|error|Error|fail|refus|cannot|unreach)/;
            const diag = middle
                .split('\n')
                .filter((line: string) => diagRe.test(line))
                .slice(0, 6)
                .join('\n');
            const skipped = middle.length - diag.length;
            output =
                `Action output is very long (${output.length} chars); kept head, diagnostic lines, and tail.` +
                `\nFirst outputs:\n${head}` +
                (diag.length > 0
                    ? `\n...跳过的中段里与诊断相关的行（其余 ${Math.max(0, skipped)} 字符省略）:\n${diag}`
                    : '\n...（中段没有诊断性内容）') +
                `\nFinal outputs:\n${tail}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10): ReturnType<typeof setTimeout> {
        // 这次超时属于**哪一次动作**：动作已经换人之后，旧定时器不许再把
        // timedout 贴到新动作头上（它可能是刚启动的正常动作）。
        const ownerStartedAt = this.currentStartedAt;
        return setTimeout(async () => {
            if (!this.executing || this.currentStartedAt !== ownerStartedAt) return;
            try {
                console.warn(MESSAGES.actionTimeout(TIMEOUT_MINS));
                this.timedout = true;
                // 身体进程没有 agent.history —— 这里以前直接 `.add`，超时后在
                // setTimeout 的 async 回调里抛 TypeError，变成 unhandledRejection
                // 把 body 静默带走（真机 action:stay 期间抓到的就是这条）。
                const history: any = (this.agent as any)?.history;
                if (history != null && typeof history.add === 'function') {
                    history.add('system', MESSAGES.actionTimeout(TIMEOUT_MINS));
                }
                await this.stop(); // last attempt to stop
            } catch (err: unknown) {
                // 超时兜底本身不能再把进程带崩：记录后继续走 ActionManager.stop 的路径。
                console.error(
                    'action timeout handler failed:',
                    err instanceof Error ? err.stack ?? err.message : String(err),
                );
            }
        }, TIMEOUT_MINS * 60 * 1000);
    }
}
