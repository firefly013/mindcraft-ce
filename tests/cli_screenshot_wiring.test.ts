/**
 * 截图接线：这次新行为里最要命的那几处，大多**埋在真实入口里**。
 *
 * 能直接测的就直接测（MindServer 代理的 op 分发），够不到的用源码守卫钉调用点：
 *  - `main()` 里没发 `op: 'screenshot'` → 实时画面永远不更新；
 *  - `Agent` 的 `withScreenshot` 仍走裸 `captureScreenshot()` → 模型调 stats 的图不落盘。
 *
 * 仓库里已有同类守卫（`isolation.test.ts` 钉进程边界、`movements.test.ts` 钉裸调用），
 * 这里沿用：读源码钉调用点，比"注释里说接了"可信。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverProxy } from '../src/brain/mindserver_proxy.js';

const read = (relative: string): string => readFileSync(join(process.cwd(), relative), 'utf8');

describe('CLI 每次调用都拍实时画面', () => {
  it('CLI 在跑任何命令之前就拍了', () => {
    const cli = read('src/cli.ts');
    const captureAt = cli.indexOf('requestLiveScreenshot(send)');
    // `{ op: 'tools' }` 是连上之后的第一件事，命令在它后面；画面必须更早。
    const firstCommandAt = cli.indexOf("{ op: 'tools' }");
    expect(captureAt).toBeGreaterThan(-1);
    expect(firstCommandAt).toBeGreaterThan(-1);
    expect(captureAt).toBeLessThan(firstCommandAt);
  });

  it('MindServer 代理认得 screenshot op：调 Agent 的实时画面方法并回路径', async () => {
    let calls = 0;
    serverProxy.setAgent({
      cliEvents: [],
      saveLiveScreenshot: () => {
        calls++;
        return Promise.resolve('C:/tmp/mindcraft-cli/pia-live.jpg');
      },
    });
    const dispatch = serverProxy as unknown as {
      handleCliCommand(data: Record<string, unknown>): Promise<unknown>;
    };
    await expect(dispatch.handleCliCommand({ op: 'screenshot' })).resolves.toEqual({
      ok: true,
      screenshot: 'C:/tmp/mindcraft-cli/pia-live.jpg',
    });
    expect(calls).toBe(1);
  });
});

describe('stats 的两条回执都留档', () => {
  it('模型走 captureStatsScreenshot，CLI 走 attachScreenshotFile', () => {
    const agent = read('src/brain/agent.ts');
    expect(agent).toContain('captureImage: async () => (await this.captureStatsScreenshot())?.b64 ?? null');
    expect(agent).toContain('found.withScreenshot === true ? await this.attachScreenshotFile(text) : text');
  });
});
