/**
 * CLI 调试截图的落盘位置与写法。
 *
 * 两类文件，**生命周期完全不同**，混在一起就会有一方坏掉：
 *
 * - **实时画面** `<agent>-live.jpg`：每次 CLI 调用覆盖同一张。给人（或外部工具）
 *   一个稳定的"机器人现在长什么样"入口，不需要每次去扫目录。
 * - **stats 留档** `<agent>-stats-<时间>-<序号>.jpg`：stats 每被调用一次就新增一张，
 *   不覆盖。stats 的语义就是"我现在的状态照片"，留档才能和上一次比。
 *
 * 为什么放系统临时目录（`os.tmpdir()/mindcraft-cli`）：这些图纯属调试旁路，
 * 不进仓库、不需要跨重启保留，交给系统清理即可。目录/文件名抽出来是为了
 * **可测**——路径和覆盖语义写错不会报错，只会悄悄变成另一种文件布局。
 *
 * 单独成文件（而不是埋在 `Agent` 里）：`Agent` 要真身体、真相机才跑得起来，
 * 而"文件叫什么、覆盖不覆盖、写一半会不会被读到"这些才是最容易错的地方。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** CLI 截图的临时目录。 */
export function cliScreenshotDir(): string {
  return join(tmpdir(), 'mindcraft-cli');
}

/**
 * 文件名里只留安全字符。
 *
 * Agent 名来自 profile，正常是 `pia` 这类；但文件名要经得住空格、斜杠
 * （斜杠会变成子目录，甚至把图写到临时目录外面去）。空名回退 `agent`——
 * 让文件叫 `-live.jpg` 只会让人以为是 bug。
 */
export function safeAgentFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned === '' ? 'agent' : cleaned;
}

/** 实时画面：**固定**路径，每次调用覆盖。 */
export function liveScreenshotPath(agent: string, dir: string = cliScreenshotDir()): string {
  return join(dir, `${safeAgentFileName(agent)}-live.jpg`);
}

/** stats 留档序号：同一毫秒内被调两次也不能互相覆盖。 */
let statsSeq = 0;

/** stats 留档：每次一个新文件名，**不覆盖**。 */
export function statsScreenshotPath(
  agent: string,
  dir: string = cliScreenshotDir(),
  at: number = Date.now(),
): string {
  const seq = (++statsSeq).toString(36);
  return join(dir, `${safeAgentFileName(agent)}-stats-${at}-${seq}.jpg`);
}

/** 写临时文件的序号：同一进程并发写同一个实时画面时，互不踩临时文件。 */
let writeSeq = 0;

/**
 * 把 base64 jpeg 写进文件。
 *
 * **先写临时文件再改名**：实时画面会被外部进程（看图工具、监控脚本）随时打开，
 * 而直接覆盖写会让它们读到半张图。改名在同一目录内是原子的。
 *
 * 改名失败（Windows 上文件被杀毒/看图软件短暂占用是真实存在的）就退回直接写：
 * 截图是调试旁路，宁可牺牲一次原子性，也不该让整个 CLI 调用失败。
 */
export function saveScreenshot(file: string, base64: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const data = Buffer.from(base64, 'base64');
  const staging = `${file}.${process.pid}.${++writeSeq}.tmp`;
  try {
    writeFileSync(staging, data);
    renameSync(staging, file);
    return;
  } catch {
    try {
      rmSync(staging, { force: true });
    } catch {
      // 临时文件都清不掉时更要直接写目标文件；清不掉最多在临时目录留个垃圾。
    }
  }
  writeFileSync(file, data);
}

export default {
  cliScreenshotDir,
  safeAgentFileName,
  liveScreenshotPath,
  statsScreenshotPath,
  saveScreenshot,
};
