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

/**
 * **卡死判定必须看"进度"，不能只看坐标**（Lead 2026-10-21 真机 A）：
 * 垂直下挖每挖一格只降"亚方块"高度，`stuckForSeconds` 却把"位置几乎不变"当卡死，
 * 67/81/118 秒三次误报并中止了合法下挖。证据源必须与 `dig-progress` 相同：
 * **done/total 变了就不是卡死**；y 变动 ≥0.1 是"在下降但慢"；两个信号都没有才是真停。
 */
export interface ActionProgressRecord {
    label: string;
    done: number;
    total: number;
    fromY?: number | null;
    toY?: number | null;
    at: number;
}

/** skills 在 emit `*-progress` 时同步写一份，身体用它做卡死判据（同一事实，不是第二意见）。 */
export function recordActionProgress(
    bot: unknown,
    record: Omit<ActionProgressRecord, 'at'> & { at?: number },
): void {
    try {
        (bot as { __actionProgress?: ActionProgressRecord }).__actionProgress = {
            label: record.label,
            done: record.done,
            total: record.total,
            fromY: record.fromY ?? null,
            toY: record.toY ?? null,
            at: record.at ?? Date.now(),
        };
    } catch {
        // 记录失败不阻挡动作本身。
    }
}

export type StuckKind = 'none' | 'moving-slow' | 'stuck';

export interface StuckEvaluation {
    kind: StuckKind;
    /** 一句话事实（只有 stuck / moving-slow 有）。 */
    message: string;
    /** 触发判据里的信号名，便于回执与测试。 */
    signals: string[];
}

/**
 * @param input.positionChanged 水平位置是否变化（≥0.35 格）
 * @param input.yChanged        竖直变化量绝对值（格）
 * @param input.progressAdvanced 窗口内动作是否报告过新进度（done 变化）
 * @param input.seconds         当前位置已经持续多久（秒）
 * @param input.thresholdSeconds 触发卡死的门槛（默认 60）
 */
export function evaluateStuck(input: {
    actionRunning: boolean;
    positionChanged: boolean;
    yChanged: number;
    progressAdvanced: boolean;
    seconds: number;
    thresholdSeconds?: number;
    progress?: ActionProgressRecord | null;
}): StuckEvaluation {
    if (!input.actionRunning) return { kind: 'none', message: '', signals: [] };
    // **有任何进展迹象就不报卡死**：进度增加 > 亚方块下降 > 坐标变化。
    if (input.progressAdvanced) return { kind: 'none', message: '', signals: ['progress'] };
    if (Math.abs(input.yChanged) >= 0.1) {
        const side = input.yChanged > 0 ? '上升' : '下降';
        return {
            kind: 'moving-slow',
            message: `${Math.round(input.seconds)} 秒里${side}了 ${Math.abs(input.yChanged).toFixed(1)} 格（不是卡住，是慢）——继续。`,
            signals: ['y-delta'],
        };
    }
    if (input.positionChanged) return { kind: 'none', message: '', signals: ['position'] };
    const threshold = input.thresholdSeconds ?? 60;
    if (input.seconds < threshold) return { kind: 'none', message: '', signals: [] };
    const progressText =
        input.progress != null
            ? `进度 ${input.progress.done}/${input.progress.total}（${input.progress.label}）`
            : '没有进度输出';
    return {
        kind: 'stuck',
        message: `${Math.round(input.seconds)} 秒里一格没挖掉/一步没走（${progressText} 未变，坐标也没动）——**不是挖慢，是真停了**。`,
        signals: ['position', 'progress', 'y-delta'],
    };
}

