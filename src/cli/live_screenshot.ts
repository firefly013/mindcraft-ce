/**
 * CLI 的"每次调用拍一张实时画面"。
 *
 * 单独抽出来是为了**可测**：这段逻辑埋在 `cli.ts` 的 `main()` 里，只能靠
 * 真起 MindServer + 机器人来验证——而"每次调用都要拍"正是这次最容易
 * 悄悄丢掉的承诺（比如哪天有人把 `send` 挪到命令之后再调，或者把 op 写错）。
 *
 * 契约很短：
 *  - 每次调用**都**发一次 `op: 'screenshot'`（由 `Agent.saveLiveScreenshot`
 *    覆盖同一个临时文件）；
 *  - 拍不到（相机没开、机器人不在线、超时）就是 `null`，**绝不让 CLI 调用失败**。
 *    截图是调试旁路，不是命令的前置条件。
 */

/** 拿到应答的最小形状（`cli.ts` 的 `CliResult` 结构上满足它）。 */
export interface LiveScreenshotReply {
  ok: boolean;
  /** 存下来的实时画面路径；拍不到是 null/缺省。 */
  screenshot?: string | null;
}

/** 发一次带 ack 的 CLI 请求。由 `cli.ts` 注入真正的 socket 实现。 */
export type CliRequest = (
  payload: Record<string, unknown>,
  timeoutMs: number,
) => Promise<LiveScreenshotReply>;

/**
 * 这张图的等待上限：相机初始化本身最多等 10 秒（见 `VisionInterpreter.captureBase64`），
 * 留够余量。超过就当作没拍到，命令继续。
 */
export const LIVE_SCREENSHOT_TIMEOUT_MS = 30_000;

/** 向机器人要一张实时画面（会覆盖临时目录里同一张图）。拍不到返回 null。 */
export async function requestLiveScreenshot(send: CliRequest): Promise<string | null> {
  try {
    const res = await send({ op: 'screenshot' }, LIVE_SCREENSHOT_TIMEOUT_MS);
    return res.ok && typeof res.screenshot === 'string' ? res.screenshot : null;
  } catch {
    // send 正常不 reject（超时也会 resolve）；真 reject 也只是少一张图。
    return null;
  }
}

export default { requestLiveScreenshot, LIVE_SCREENSHOT_TIMEOUT_MS };
