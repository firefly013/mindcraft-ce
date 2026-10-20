/**
 * **长动作必须"边做边说"**（Lead 2026-10-21：三条独立报告——collectBlocks 静默 73 秒、
 * mineBlock 117 秒无进度、smelt 45 秒超时后当"丢 1 个"处理）。
 *
 * 规则：能合法跑很久的动作，**静默超过 ~10 秒就是缺陷**；超时/熔断时必须说清
 * 「完成 X/N、还剩 K、已用 T 秒」——不许让 `stuck for N seconds` 成为第一条消息。
 */
export const PROGRESS_INTERVAL_MS = 8_000;
/** 长动作的默认硬上限（超过就收工并如实报告剩余）。 */
export const LONG_ACTION_MAX_MS = 150_000;

export function shouldEmitProgress(lastEmitAt: number, now: number, intervalMs = PROGRESS_INTERVAL_MS): boolean {
    return lastEmitAt <= 0 || now - lastEmitAt >= intervalMs;
}

/** 进度行（机器可读 + 人话）：`挖第 2/4 块 · 已用 12 秒 · 还剩 2 个目标 · 离目标 1.7 格`。 */
export function formatProgressLine(input: {
    label: string;
    done: number;
    total: number;
    elapsedMs: number;
    remaining?: number | null;
    distance?: number | null;
}): string {
    const elapsed = Math.max(0, Math.round(input.elapsedMs / 1000));
    const parts = [`${input.label}第 ${input.done}/${input.total} 个`, `已用 ${elapsed} 秒`];
    if (input.remaining != null) parts.push(`还剩 ${input.remaining} 个目标`);
    if (input.distance != null && Number.isFinite(input.distance)) {
        parts.push(`离目标 ${Math.round(input.distance * 10) / 10} 格`);
    }
    return parts.join(' · ');
}

/** 到上限时的收尾话（说清完成到哪、剩什么，而不是"卡住了"）。 */
export function formatTimeoutSummary(input: {
    label: string;
    done: number;
    total: number;
    elapsedMs: number;
    remaining?: number | null;
}): string {
    const elapsed = Math.max(0, Math.round(input.elapsedMs / 1000));
    const left = input.remaining ?? Math.max(0, input.total - input.done);
    return (
        `${input.label}到 ${elapsed} 秒上限：已完成 ${input.done}/${input.total} 个，` +
        `还剩 ${left} 个没做——这是到时间上限，不是失败；可以直接再发一次同样的调用继续，进度不会丢。`
    );
}
