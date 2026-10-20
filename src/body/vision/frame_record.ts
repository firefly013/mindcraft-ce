/**
 * **一帧的拍摄记录**：文件名 + 这一帧自己的朝向 + 拍摄时间。
 *
 * 为什么单独成模块：`camera.ts` 会 `import 'prismarine-viewer/...'`（内部引用 `window`），
 * 在纯逻辑测试里**不能**被 import。记录/校验是纯逻辑，放这里就能被测试钉住，
 * 而 `VisionInterpreter` 只把 `camera.capture()` 的返回值喂进来。
 *
 * 规则（真机事故：快照文字说"朝天空（pitch −88°）"、图里却是水平隧道 ⇒ bot 正确地不信图、
 * 丢掉一张好画面）：
 *   ① 朝向必须是**渲染这一帧时**的读数（`camera.capture()` 返回它）；
 *   ② 读不到就记 `null` ⇒ 回执**什么都不说**，绝不拿"现在身体朝哪"顶替；
 *   ③ 文件名/时间戳/朝向来自**同一次拍摄**，任何一项缺失都整条记录作废（宁可不说）。
 */

/** **这一帧自己的朝向**（弧度）。在渲染这一帧时读、和传给相机的同一次读数。 */
export interface FrameView {
    yaw: number | null;
    pitch: number | null;
}

export interface FrameRecord {
    file: string;
    takenAt: number;
    view: FrameView | null;
}

/** 相机返回的原始形状（不 import Camera，避免把 `window` 带进测试）。 */
export interface CapturedShot {
    file?: unknown;
    view?: { yaw?: unknown; pitch?: unknown } | null;
}

function finiteOrNull(value: unknown): number | null {
    // **`null` 不是 0**：`Number(null) === 0`，直转会把"没读到"读成"平视"。
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
}

/**
 * 把一次拍摄的返回值 + 拍摄时间，变成一条**自洽**的记录。形状不对 ⇒ 返回 null
 * （调用方据此"什么都不说"，而不是编一个朝向）。
 */
export function frameRecordOf(shot: unknown, takenAt: number): FrameRecord | null {
    if (shot == null || typeof shot !== 'object') return null;
    const raw = shot as CapturedShot;
    if (typeof raw.file !== 'string' || raw.file === '') return null;
    if (typeof takenAt !== 'number' || !Number.isFinite(takenAt)) return null;
    const view = raw.view;
    const recordedView: FrameView | null =
        view != null && typeof view === 'object'
            ? { yaw: finiteOrNull(view.yaw), pitch: finiteOrNull(view.pitch) }
            : null;
    return { file: raw.file, takenAt, view: recordedView };
}
