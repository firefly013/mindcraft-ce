/**
 * "CLI 每次调用都要一张实时画面"这条承诺的入口。
 *
 * 真正发 socket 的部分在 `cli.ts` 的 `main()` 里（要连 MindServer，单测够不到），
 * 所以把最容易写错的那段抽成 `requestLiveScreenshot(send)`：
 * 发什么 op、超时多少、失败怎么吞。这里钉住这三件事。
 */
import { describe, expect, it } from 'vitest';
import {
  LIVE_SCREENSHOT_TIMEOUT_MS,
  requestLiveScreenshot,
  type CliRequest,
} from '../src/cli/live_screenshot.js';

describe('requestLiveScreenshot', () => {
  it('发一次 op:screenshot，把应答里的路径拿回来', async () => {
    const calls: Array<{ payload: Record<string, unknown>; timeoutMs: number }> = [];
    const send: CliRequest = (payload, timeoutMs) => {
      calls.push({ payload, timeoutMs });
      return Promise.resolve({ ok: true, screenshot: 'C:/tmp/mindcraft-cli/pia-live.jpg' });
    };

    await expect(requestLiveScreenshot(send)).resolves.toBe('C:/tmp/mindcraft-cli/pia-live.jpg');
    expect(calls).toEqual([{ payload: { op: 'screenshot' }, timeoutMs: LIVE_SCREENSHOT_TIMEOUT_MS }]);
  });

  it('拍不到（null / ok:false / 形状不对）→ null，不抛', async () => {
    expect(await requestLiveScreenshot(() => Promise.resolve({ ok: true, screenshot: null }))).toBeNull();
    expect(await requestLiveScreenshot(() => Promise.resolve({ ok: false }))).toBeNull();
    expect(await requestLiveScreenshot(() => Promise.resolve({ ok: true }))).toBeNull();
  });

  it('请求本身炸了也吞掉：截图失败不许让 CLI 调用失败', async () => {
    const send: CliRequest = () => Promise.reject(new Error('socket closed'));
    await expect(requestLiveScreenshot(send)).resolves.toBeNull();
  });
});
