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
 * **颜色统计**（量的是渲染出来的像素：`|R−G| + |G−B|`，0~510）。
 *
 * 真机 overnight_b（2026-10-21）**纠正过一次这个指标的用法**：他看到的画面是左右浅灰石墙、
 * 正前方**大片橙褐色铁矿**、左下角红棕花岗岩——明显有颜色，而"全图平均彩度"只有 2.72，
 * 于是回执错判成"丢了颜色"。**数字对，结论错**：平均把尾部信息抹平了，
 * 而模型要认的恰恰是那块矿。所以判据改成**尾部/覆盖率**：
 *   - `colouredFraction`：彩度 ≥ `COLOURED_CHROMA_MIN` 的采样像素占比；
 *   - `p95`：第 95 百分位彩度（看尾部有多强）；
 *   - `mean` 只作为次要数字保留（并**写进消息**，让说法可核对）。
 * 判灰**只当彩色像素占比可以忽略**（< `GREYSCALE_MAX_COLOURED_FRACTION`）。
 */
export interface FrameColor {
    /** 平均彩度（次要指标，保留但**不再单独决定**结论）。 */
    mean: number | null;
    /** 彩度 ≥ 24 的采样像素占比（0~1）。 */
    colouredFraction: number | null;
    /** 第 95 百分位彩度（尾部强度）。 */
    p95: number | null;
    /** 判据命中 ⇒ 丢了颜色。`null` = 没测。 */
    grayscale: boolean | null;
}

/** 单像素彩度到这个数就算"彩色"（灰墙/石头通常 < 10，铁矿橙褐/花岗岩红棕远高于此）。 */
export const COLOURED_CHROMA_MIN = 24;
/** 彩色像素占比低于这个值才算"丢了颜色"（"可以忽略"，不是"平均低"）。 */
export const GREYSCALE_MAX_COLOURED_FRACTION = 0.02;

/**
 * 采样一张 RGBA 缓冲的彩度统计。纯函数：不 import 任何渲染器/画布。
 *
 * @param step 采样步长（每 step 个像素取 1 个；默认 7 —— 800×512 约 8k 个样本，够且便宜）
 */
export function chromaStatsOf(
    data: ArrayLike<number> | null | undefined,
    width: number,
    height: number,
    step = 7,
): { mean: number; p95: number; colouredFraction: number; sampled: number } | null {
    if (data == null) return null;
    const w = Number(width);
    const h = Number(height);
    const stride = Math.max(1, Math.floor(Number(step) || 1));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    if (data.length < w * h * 4) return null;
    const samples: number[] = [];
    let coloured = 0;
    for (let y = 0; y < h; y += stride) {
        for (let x = 0; x < w; x += stride) {
            const i = (y * w + x) * 4;
            const r = Number(data[i] ?? 0);
            const g = Number(data[i + 1] ?? 0);
            const b = Number(data[i + 2] ?? 0);
            const chroma = Math.abs(r - g) + Math.abs(g - b);
            samples.push(chroma);
            if (chroma >= COLOURED_CHROMA_MIN) coloured += 1;
        }
    }
    if (samples.length === 0) return null;
    samples.sort((a, b) => a - b);
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
    return {
        mean: Math.round(mean * 100) / 100,
        p95: Math.round(p95 * 100) / 100,
        colouredFraction: Math.round((coloured / samples.length) * 10000) / 10000,
        sampled: samples.length,
    };
}

/** 由统计得到"测过的颜色记录"；`null` 进 ⇒ `null` 出（不猜）。 */
export function colorFromStats(
    stats: { mean: number; p95: number; colouredFraction: number } | null | undefined,
): FrameColor | null {
    if (stats == null) return null;
    const mean = Number(stats.mean);
    const p95 = Number(stats.p95);
    const fraction = Number(stats.colouredFraction);
    if (!Number.isFinite(mean) || !Number.isFinite(p95) || !Number.isFinite(fraction)) return null;
    return {
        mean,
        p95,
        colouredFraction: fraction,
        grayscale: fraction < GREYSCALE_MAX_COLOURED_FRACTION,
    };
}

/** 相机返回的原始形状（不 import Camera，避免把 `window` 带进测试）。 */
export interface CapturedShot {
    file?: unknown;
    view?: { yaw?: unknown; pitch?: unknown } | null;
    color?: {
        mean?: unknown;
        p95?: unknown;
        colouredFraction?: unknown;
        grayscale?: unknown;
    } | null;
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
    const mean = finiteOrNull(raw.color?.mean);
    const p95 = finiteOrNull(raw.color?.p95);
    const colouredFraction = finiteOrNull(raw.color?.colouredFraction);
    const recordedColor: FrameColor | null =
        mean == null || p95 == null || colouredFraction == null
            ? null
            : {
                  mean,
                  p95,
                  colouredFraction,
                  grayscale:
                      typeof raw.color?.grayscale === 'boolean'
                          ? raw.color.grayscale
                          : colouredFraction < GREYSCALE_MAX_COLOURED_FRACTION,
              };
    return { file: raw.file, takenAt, view: recordedView, color: recordedColor };
}
