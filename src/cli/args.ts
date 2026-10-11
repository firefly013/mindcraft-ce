/**
 * CLI 参数解析。
 *
 * 形状是 `cli --agent pia <命令> [参数...]`，参数两种写法都认：
 *
 *   cli --agent pia goToCoordinates --x 100 --y 64 --z 200
 *   cli --agent pia stats inventory          # 按工具声明的顺序给位置参数
 *
 * 位置参数怎么落到具名参数上，由**被调工具声明的顺序**决定（`Agent.runOneCommand`
 * 按 `params` 的 key 顺序取值），所以 `--key value` 更安全，位置参数只图快。
 */

export interface CliOptions {
  agent: string;
  port: number;
  command: string | null;
  /** 具名参数。 */
  args: Record<string, unknown>;
  /** 操作类型：`run` 提交任务，其余是任务控制。 */
  op: CliOp;
  /** `wait/status/cancel` 的任务号。 */
  jobId: string | null;
  /** 提交后自动等它跑完（长命令才有意义）。 */
  wait: boolean;
  /** 只提交，不等结果。 */
  async: boolean;
  /** 先抢占身体再跑（别被模型正在做的动作挡住）。 */
  force: boolean;
  /** 忽略 cursor，把缓冲里的事件全打出来。 */
  all: boolean;
  timeoutMs: number;
  help: boolean;
  usage: string;
}

const USAGE = `用法：cli --agent <名字> [选项] <命令> [参数...]

命令 = 机器人的任意游戏工具（stats / goToCoordinates / mineBlock …）。
**异步与否不用你操心，按命令性质自动分流**：

  长时间命令（走身体通道的：goToCoordinates / mineBlock / followPlayer …）
    → 强制异步：立刻返回任务 id，命令继续跑。加 --wait 就顺带等到结束。
  其余命令（stats / history / tools …）
    → 强制同步：直接给结果，指定 --async 也没用。

任务控制：
  wait <id>     等它跑完（等不到只说"还在跑"，不是失败）
  status <id>   看一眼状态
  cancel <id>   真的去停掉它
  jobs          列出全部任务

内置命令（不需要任务号）：
  help          这个用法；help <命令> 看某条命令的参数
  tools         列出所有能跑的命令
  history       看整份对话历史（--limit N，默认 40）
  events        只看最近事件，不跑命令（--limit N，默认 30）

每次调用都会附上"上次以来积攒的事件"——CLI 没法被唤醒，所以这是你唯一能看到
它不在场时发生了什么的方式。

选项：
  --agent <名字>   机器人名字（必填）
  --port <端口>    MindServer 端口，默认 8099
  --wait           长命令提交后顺带等到结束（省得再跑一次 wait）
  --force          先停掉机器人正在做的动作再跑这条命令
  --all            忽略本地进度，把积攒的事件全部打印
  --timeout <毫秒> 等待上限，默认 120000
  -h, --help       看这个

例：
  cli --agent pia stats
  cli --agent pia goToCoordinates --x 100 --y 64 --z 200
  cli --agent pia --wait goToCoordinates --x 100 --y 64 --z 200
  cli --agent pia help mineBlock
  cli --agent pia cancel 3
`;

/** 任务控制类子命令。它们不提交新任务，只查询或干预。 */
export type CliOp = 'run' | 'wait' | 'status' | 'cancel' | 'list';

const JOB_OPS: Record<string, CliOp> = {
  wait: 'wait',
  status: 'status',
  cancel: 'cancel',
  jobs: 'list',
};

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let agent = '';
  let port = 8099;
  let asyncMode = false;
  let waitMode = false;
  let force = false;
  let all = false;
  let help = false;
  let timeoutMs = 120_000;
  let command: string | null = null;
  const args: Record<string, unknown> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === '-h' || token === '--help') {
      help = true;
      continue;
    }
    if (token === '--force') {
      force = true;
      continue;
    }
    if (token === '--all') {
      all = true;
      continue;
    }
    if (token === '--async') {
      asyncMode = true;
      continue;
    }
    if (token === '--wait') {
      waitMode = true;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      // `--flag` 后面没有值、或者下一个还是 flag → 当成布尔开关。
      if (next == null || (next as string).startsWith('--')) {
        args[key] = true;
        continue;
      }
      const value = next as string;
      i++;
      switch (key) {
        case 'agent':
          agent = value;
          break;
        case 'port':
          port = Number(value) || port;
          break;
        case 'timeout':
          timeoutMs = Number(value) || timeoutMs;
          break;
        default:
          // 数字就给数字：工具的 params 多半是 int/float，给字符串过去会判不过。
          args[key] = value !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
      }
      continue;
    }
    // 第一个裸词是命令名，后面的是位置参数。
    if (command == null) command = token;
    else positional.push(token);
  }

  // 位置参数按顺序铺开，具名写法优先（不覆盖）。
  positional.forEach((value, index) => {
    args[String(index)] = value !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
  });

  // 任务控制子命令：第一个裸词是 `wait`/`status`/`cancel`/`jobs`，它后面那个裸词
  // 是任务号。`jobs` 不要号。
  const op: CliOp = command != null ? (JOB_OPS[command] ?? 'run') : 'run';
  let jobId: string | null = null;
  if (op !== 'run' && op !== 'list') {
    jobId = positional[0] != null ? String(positional[0]) : null;
  }

  return {
    agent,
    port,
    command,
    args,
    op,
    jobId,
    wait: waitMode,
    async: asyncMode,
    force,
    all,
    timeoutMs,
    help,
    usage: USAGE,
  };
}

export default { parseCliArgs, USAGE };
