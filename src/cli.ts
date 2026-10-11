/**
 * 外部命令行：在机器人**外面**直接调它的工具。
 *
 * ## 为什么需要它
 *
 * 机器人是个连着 Minecraft 的进程，模型在自己跑循环。想调试"这个工具到底返回
 * 什么""我现在身上有什么"时，原来只能翻日志或者听模型自己说——而它说不说，
 * 取决于它想不想说。
 *
 * ## 异步
 *
 * 命令**默认异步**：提交就拿到任务 id，命令在机器人那边继续跑。想等就 `wait`，
 * 不想等就 `status`，反悔就 `cancel`。
 *
 * 为什么不直接同步等：动作类命令（`goToCoordinates` 之类）的包装是
 * `runAsAction(actionFn, timeout = -1)`——**默认没有超时**，寻路寻几分钟很正常。
 * 同步等下去，撞到超时只能报"失败"，而那个超时并不取消动作，于是终端说失败、
 * 机器人还在走。异步化之后这件事才说得清。
 *
 * ## 事件
 *
 * **每次调用都附上上次以来积攒的事件**，不管你问没问。CLI 是被动的，没人会
 * "唤醒"一个命令行；不附上的话，中间那几十秒里机器人挨了打、进了水、做完了
 * 一个动作，你全都看不见，只会以为它什么都没干。
 *
 * @example
 *   cli --agent pia stats                     # 提交，拿 id（短命令一般已顺带完成）
 *   cli --agent pia goToCoordinates --x 100 --y 64 --z 200
 *   cli --agent pia status 3
 *   cli --agent pia wait 3 --timeout 300000
 *   cli --agent pia cancel 3
 *   cli --agent pia jobs
 */

import { io } from 'socket.io-client';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCliArgs } from './cli/args.js';
import { GAME_COMMANDS } from './runtime/game_tools.js';
import { stripBang } from './agent/commands/to_openai_tools.js';

/**
 * 这条命令是不是"长时间"的。
 *
 * 判据不是我列的清单，而是 `runAsAction` 打在 perform 上的 `longRunning`
 * 标记——**走身体通道的就是长命令**。清单会漏、会过期，这个不会。
 */
function isLongRunning(name: string): boolean {
  const cmd = GAME_COMMANDS.find((c) => c.name === `!${name}` || c.name === name);
  return cmd?.perform?.longRunning === true;
}

/** `help [命令]`：给命令的用途和参数。查不到就直说。 */
function describeCommand(name: string): string {
  const cmd = GAME_COMMANDS.find((c) => c.name === `!${name}` || c.name === name);
  if (cmd == null) return `没有这条命令：${name}。用 tools 看看有哪些。`;
  const lines: string[] = [stripBang(cmd.name), `  ${cmd.description ?? '(没写说明)'}`];
  const params = Object.entries(cmd.params ?? {});
  if (params.length > 0) {
    lines.push('  参数：');
    for (const [key, def] of params) {
      const def2 = def as { type?: string; description?: string; optional?: boolean; default?: unknown };
      const tail =
        def2.optional === true ? `（可选${def2.default != null ? `，默认 ${String(def2.default)}` : ''}）` : '';
      lines.push(`    --${key}  ${def2.type ?? ''}  ${def2.description ?? ''}${tail}`);
    }
  }
  if (isLongRunning(name)) lines.push('  （长时间命令：提交后异步跑，加 --wait 可顺带等）');
  return lines.join('\n');
}

/** 一条事件（与 `Agent` 侧 `CliEvent` 对齐）。 */
interface CliEvent {
  at: number;
  level: number;
  action: string;
  text: string;
}

interface JobView {
  state: string;
  output?: string;
  error?: string;
  name?: string;
  ms?: number;
}

interface CliResult {
  ok: boolean;
  timeout?: boolean;
  error?: string;
  jobId?: string;
  job?: JobView;
  jobs?: Array<{ id: string; name: string; state: string; ms: number }>;
  cancelled?: boolean;
  events?: CliEvent[];
}

function cursorPath(agent: string): string {
  return `./bots/${agent}/.cli-cursor.json`;
}

function readCursor(agent: string): number {
  try {
    const raw = JSON.parse(readFileSync(cursorPath(agent), 'utf8')) as { since?: unknown };
    return typeof raw.since === 'number' ? raw.since : 0;
  } catch {
    return 0; // 第一次调用：之前的都不算"新的"，从现在开始看。
  }
}

function writeCursor(agent: string, since: number): void {
  try {
    writeFileSync(cursorPath(agent), JSON.stringify({ since }));
  } catch {
    // 写不进去不影响本次输出，下次多打一点而已。
  }
}

function renderEvents(events: readonly CliEvent[]): string {
  if (events.length === 0) return '';
  return `\n--- 期间的事件（${events.length}）---\n${events
    .map((e) => `  [L${e.level}/${e.action}] ${e.text}`)
    .join('\n')}`;
}

function renderJobs(jobs: readonly { id: string; name: string; state: string; ms: number }[]): string {
  if (jobs.length === 0) return '(还没有任务)';
  return jobs.map((j) => `  #${j.id}  ${j.state.padEnd(9)} ${j.name}  (${Math.round(j.ms / 1000)}s)`).join('\n');
}

function renderJob(job: JobView, id: string): string {
  const head = `#${id} ${job.state}${job.name != null ? ` ${job.name}` : ''}${
    job.ms != null ? ` (${Math.round(job.ms / 1000)}s)` : ''
  }`;
  if (job.state === 'running') return `${head}\n  （还在跑）`;
  if (job.output == null && job.error != null) return `${head}\n  ${job.error}`;
  return `${head}\n${job.output ?? '(no output)'}`;
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

  // `help` 完全在本地：命令定义本来就在同一个代码库里，犯不着为了查参数去打扰机器人。
  if (opts.command === 'help' || opts.help) {
    const target = typeof opts.args['0'] === 'string' ? String(opts.args['0']) : null;
    process.stdout.write(`${target == null ? opts.usage : describeCommand(target)}\n`);
    return;
  }
  if (opts.command == null) {
    process.stdout.write(`${opts.usage}\n`);
    return;
  }

  const socket = io(`http://localhost:${opts.port}`, { reconnection: false });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (err: unknown) =>
      reject(new Error(`连不上 MindServer（端口 ${opts.port}）：${String(err)}`)),
    );
    setTimeout(() => reject(new Error('连 MindServer 超时')), 5000);
  });

  const send = (payload: Record<string, unknown>, timeoutMs: number): Promise<CliResult> =>
    new Promise<CliResult>((resolve) => {
      socket.emit('cli-command', opts.agent, { ...payload, timeoutMs }, (res: CliResult) => resolve(res));
      // 比服务端超时多留 5 秒，避免"服务端还没回、这边先放弃了"。
      setTimeout(() => resolve({ ok: false, timeout: true, error: 'CLI 这边等超时了' }), timeoutMs + 5000);
    });

  let result: CliResult;

  if (opts.op !== 'run') {
    // 任务控制类：不产生新任务，只查询/干预。
    result = await send({ op: opts.op, id: opts.jobId, waitMs: opts.timeoutMs }, opts.timeoutMs + 5000);
  } else {
    // **分流**：长命令强制异步（--wait 才等），其余强制同步。
    // 不用人去记哪个该异步 —— 记不住，而且记错了就是"终端说失败、机器人还在走"。
    const longRunning = isLongRunning(opts.command);
    const shouldWait = !longRunning || opts.wait;

    const started = await send(
      {
        op: 'start',
        name: opts.command,
        args: opts.args,
        force: opts.force,
        since: opts.all ? 0 : readCursor(opts.agent),
      },
      15_000,
    );
    if (!started.ok || started.jobId == null) {
      result = started;
    } else if (!shouldWait) {
      // 长命令、没加 --wait：拿 id 就走，命令继续跑。
      result = started;
    } else {
      const waited = await send(
        { op: 'wait', id: started.jobId, waitMs: opts.timeoutMs },
        opts.timeoutMs + 5000,
      );
      result = { ...waited, jobId: started.jobId, events: dedupe([...(started.events ?? []), ...(waited.events ?? [])]) };
    }

    // 短命令上指定 --async 是无效操作，说一句，免得用户以为生效了。
    if (!longRunning && opts.async) {
      process.stdout.write(`（${opts.command} 是同步命令，--async 无效）\n`);
    }
  }

  if (!result.ok) {
    // 超时不是失败：任务还在跑，说清楚而不是吓唬人。
    if (result.timeout === true) {
      process.stdout.write(`（还在跑，没等到结果）${result.error ?? ''}\n`);
    } else {
      process.stdout.write(`${result.error ?? '命令失败'}\n`);
      socket.close();
      process.exitCode = 1;
      return;
    }
  } else if (result.jobs != null) {
    process.stdout.write(`${renderJobs(result.jobs)}\n`);
  } else if (result.job != null) {
    process.stdout.write(`${renderJob(result.job, result.jobId ?? opts.jobId ?? '?')}\n`);
  } else if (result.cancelled != null) {
    process.stdout.write(
      result.cancelled
        ? `任务 #${opts.jobId} 已请求取消。\n`
        : `任务 #${opts.jobId} 取消不了（已经结束或不存在）。\n`,
    );
  } else if (result.jobId != null) {
    process.stdout.write(
      `任务 #${result.jobId} 已提交（${opts.command}）。\n` +
        `用 wait ${result.jobId} 等它、status ${result.jobId} 看状态、cancel ${result.jobId} 停掉。\n`,
    );
  }

  const events = result.events ?? [];
  if (events.length > 0) {
    process.stdout.write(`${renderEvents(events)}\n`);
    // 用**最后一条事件的时间**推进，不是"现在"——否则同毫秒到达的两条会漏掉一条。
    writeCursor(opts.agent, Math.max(...events.map((e) => e.at)));
  }

  socket.close();
}

/** 合并两次请求的事件（wait 那次没传 since，会重复）。 */
function dedupe(events: readonly CliEvent[]): CliEvent[] {
  const seen = new Set<number>();
  const out: CliEvent[] = [];
  for (const e of events) {
    const key = e.at * 1000 + e.level;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

void main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
