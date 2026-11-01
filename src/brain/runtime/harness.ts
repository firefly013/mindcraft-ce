/**
 * **无模型接入（测试台）**：手动模式下让事件系统照常运转，只是不叫模型。
 *
 * 背景（用户 2026-10-31）：续做（resume）不经过模型，所以"接进游戏、让 VLM 去
 * 试"那套测试方式用不上。要测它，就得像 CLI 那样**无模型接入游戏、从外部操控**。
 *
 * 手动模式（profile 没有 `model`）原来在 `openRuntime` 直接 return：`EventIntake`
 * 永远没 attach，身体事件全堆在 `waiting` 里，`cliEvents` 永远空，动作也不走
 * `ActionRunner`——续做根本不可达。
 *
 * 这里补的就是那半层运行时：
 *   - `write` / `submit` 只记录（走 `onEvent` 观测钩子），**不调模型**；
 *   - `abort` 空操作（没有在飞的模型请求）；
 *   - `beginEmergency` / `endEmergency` 仍然由调用方接到**真实的** Scheduler /
 *     ActionRunner 上——那正是要被测的东西（L5 上锁 → 作废动作 → 完成 → 续做）。
 *
 * 换句话说：除了"不叫模型"，L2/L3/L4/L5 的投递、反射的锁与解锁、动作通道的
 * generation/续做语义，全部和线上同一条代码路径。
 */
import type { Submission } from '@earendil-works/pi-durable';
import type { EventAction, EventIntakeDeps, GameEvent } from './events.js';
import type { HandlerLookup } from './handlers.js';

/** 测试台观测钩子：每条事件落到哪里（written/steer/preempt/emergency/reflex）。 */
export type HarnessEventListener = (event: GameEvent, action: EventAction) => void;

export interface HarnessIntakeOptions {
    /** 事件观测：CLI 事件流 / JSONL / 测试断言都从这里拿。 */
    onEvent?: HarnessEventListener;
    /** L5 反射开始：接到真实的 `scheduler.beginEmergency()` + 动作捕获。 */
    beginEmergency?: () => void;
    /** 最后一个反射完成：接到真实的 `scheduler.endEmergency()` + 续做。 */
    endEmergency?: () => void;
    /** 事件类型 → 处理。测试台只登记**安全的大脑反射**（如 inventory.changed）。 */
    lookup?: HandlerLookup;
    onError?: (error: unknown) => void;
}

/**
 * 一个"永远已经落定"的假提交。
 *
 * `EventIntake.flush` 会 `void submission.wait(...)`，所以这里必须给一个能落定的
 * 对象；但它**不代表一次模型请求**——测试台没有模型，事件只被记录。
 */
function idleSubmission(): Submission {
    return {
        id: 0 as Submission['id'],
        status: () => Promise.resolve({} as never),
        wait: () => Promise.resolve({ status: 'done' } as never),
        abort: () => Promise.resolve('aborted' as const),
    } as unknown as Submission;
}

/** 造一份无模型的 `EventIntakeDeps`：记录事件、保留锁/解锁语义、不叫模型。 */
export function createHarnessIntakeDeps(options: HarnessIntakeOptions = {}): EventIntakeDeps {
    const deps: EventIntakeDeps = {
        // 记录并"唤醒"：没有模型可唤醒，事件已经由 onEvent 逐条观测。
        submit: () => Promise.resolve(idleSubmission()),
        // L2：同样只记录（onEvent 会收到 written）。
        write: () => Promise.resolve(),
        abort: () => Promise.resolve(),
    };
    if (options.lookup != null) deps.lookup = options.lookup;
    if (options.beginEmergency != null) deps.beginEmergency = options.beginEmergency;
    if (options.endEmergency != null) deps.endEmergency = options.endEmergency;
    if (options.onEvent != null) deps.onEvent = options.onEvent;
    if (options.onError != null) deps.onError = options.onError;
    return deps;
}

export default { createHarnessIntakeDeps };
