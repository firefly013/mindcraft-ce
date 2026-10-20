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
    /** **这一帧的颜色测过了吗**（测的是渲染出来的像素，不是 JPEG 字节）。 */
    color?: FrameColor | null;
}

/**
 * **颜色**：`chromaMean` = 采样像素上 `|R−G| + |G−B|` 的平均值（0~510）。
 *
 * 真机 overnight_b：同一会话里颜色**时有时无**——画面清晰可读却全灰（熔炉、石墙都在）。
 * 这不是重映射的形状（那换的是"哪张贴图"，不是饱和度）。所以每帧量一次：
 * 只报**测到的**，测不到就 `null`（不许猜"应该是彩色"）。
 */
export interface FrameColor {
    chromaMean: number | null;
    /** 平均彩度低于阈值 ⇒ 判为"丢了颜色"。`null` = 没测。 */
    grayscale: boolean | null;
}

/** 低于这个平均彩度就算"这一帧没颜色"（纯灰 ≈ 0；正常地形画面通常 ≫ 10）。 */
export const GRAYSCALE_CHROMA_MAX = 4;

/**
 * 采样一张 RGBA 缓冲的平均彩度。纯函数：不 import 任何渲染器/画布。
 *
 * @param step 采样步长（每 step 个像素取 1 个；默认 7 —— 800×512 约 8k 个样本，够且便宜）
 */
export function chromaMeanOf(
    data: ArrayLike<number> | null | undefined,
    width: number,
    height: number,
    step = 7,
): number | null {
    if (data == null) return null;
    const w = Number(width);
    const h = Number(height);
    const stride = Math.max(1, Math.floor(Number(step) || 1));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    if (data.length < w * h * 4) return null;
    let sum = 0;
    let counted = 0;
    for (let y = 0; y < h; y += stride) {
        for (let x = 0; x < w; x += stride) {
            const i = (y * w + x) * 4;
            const r = Number(data[i] ?? 0);
            const g = Number(data[i + 1] ?? 0);
            const b = Number(data[i + 2] ?? 0);
            sum += Math.abs(r - g) + Math.abs(g - b);
            counted += 1;
        }
    }
    if (counted === 0) return null;
    return Math.round((sum / counted) * 100) / 100;
}

/** 由平均彩度得到"测过的颜色记录"；`null` 进 ⇒ `null` 出（不猜）。 */
export function colorFromChroma(chromaMean: number | null | undefined): FrameColor | null {
    if (chromaMean == null || !Number.isFinite(chromaMean)) return null;
    return { chromaMean, grayscale: chromaMean < GRAYSCALE_CHROMA_MAX };
}

/** 相机返回的原始形状（不 import Camera，避免把 `window` 带进测试）。 */
export interface CapturedShot {
    file?: unknown;
    view?: { yaw?: unknown; pitch?: unknown } | null;
    color?: { chromaMean?: unknown; grayscale?: unknown } | null;
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
    const chroma = finiteOrNull(raw.color?.chromaMean);
    const recordedColor: FrameColor | null =
        chroma == null
            ? null
            : { chromaMean: chroma, grayscale: typeof raw.color?.grayscale === 'boolean' ? raw.color.grayscale : chroma < GRAYSCALE_CHROMA_MAX };
    return { file: raw.file, takenAt, view: recordedView, color: recordedColor };
}
