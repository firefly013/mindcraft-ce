/**
 * 外部 CLI 的任务表。
 *
 * 单独一个文件是为了**可测**：状态机那几处（尤其"取消之后不能被写成 done"）
 * 埋在 `Agent` 里就没法单测，而它们恰恰是最容易写错的地方。
 *
 * ## 为什么需要异步任务
 *
 * 动作类命令（`goToCoordinates` 之类）的包装是 `runAsAction(actionFn, timeout = -1)`
 * ——**默认没有超时**，寻路寻几分钟是常态。同步等下去，撞到超时只能报"失败"，
 * 而那个超时并不取消动作，于是终端说失败、机器人还在走。异步化之后才有办法把
 * "还在跑""等到了""取消了"这三件事说清楚。
 */

export interface CliJob {
  id: string;
  name: string;
  state: 'running' | 'done' | 'error' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  output?: string;
  error?: string;
  /**
   * 用户请求过取消。
   *
   * **必须有这个独立标记**：`stop()` 不会让那个 `await` 立刻返回，等它真结束时
   * promise 的 `.then` 还会跑一次，把状态从 `cancelled` 又写回 `done`。所以
   * "请求过取消"不能被覆盖 —— 否则 `cancel` 点了跟没点一样。
   */
  cancelRequested?: boolean;
  promise?: Promise<string>;
}

export interface JobStatus {
  state: string;
  name?: string;
  output?: string;
  error?: string;
  ms: number;
}

export interface CliJobTrackerDeps {
  /** 真的去停动作。`cancel` 时调一次。 */
  stop: () => Promise<void>;
  now?: () => number;
}

/** 任务表上限。只是给 CLI 查着用的，没必要留一辈子。 */
export const CLI_JOB_LIMIT = 50;

export class CliJobTracker {
  private jobs = new Map<string, CliJob>();
  private seq = 0;

  constructor(private readonly deps: CliJobTrackerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 提交一个任务，**立即返回 id**，命令在后台跑。 */
  start(name: string, run: () => Promise<string>): { id: string } {
    const id = String(++this.seq);
    const job: CliJob = { id, name, state: 'running', startedAt: this.now() };
    job.promise = run()
      .then((output: string) => {
        if (job.cancelRequested === true) {
          job.state = 'cancelled';
          job.error = '已取消';
        } else {
          job.state = 'done';
          job.output = output;
        }
        job.finishedAt = this.now();
        return output;
      })
      .catch((err: unknown) => {
        job.state = job.cancelRequested === true ? 'cancelled' : 'error';
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = this.now();
        return '';
      });
    this.jobs.set(id, job);
    // 只留最近一批。
    if (this.jobs.size > CLI_JOB_LIMIT) {
      for (const key of [...this.jobs.keys()].slice(0, this.jobs.size - CLI_JOB_LIMIT)) {
        this.jobs.delete(key);
      }
    }
    return { id };
  }

  /** 单个任务状态。没有就 `unknown`（可能被挤出表了）。 */
  status(id: string): JobStatus {
    const job = this.jobs.get(id);
    if (job == null) return { state: 'unknown', ms: 0 };
    return {
      state: job.state,
      name: job.name,
      ...(job.state !== 'running' ? { output: job.output, error: job.error } : {}),
      ms: (job.finishedAt ?? this.now()) - job.startedAt,
    };
  }

  /** 全部任务，旧的在前。 */
  list(): Array<{ id: string; name: string; state: CliJob['state']; ms: number }> {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      name: j.name,
      state: j.state,
      ms: (j.finishedAt ?? this.now()) - j.startedAt,
    }));
  }

  /** 取消：置标记 + 真的去停。返回是否取消到了（已结束的取消不了）。 */
  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (job == null || job.state !== 'running') return false;
    job.cancelRequested = true;
    try {
      await this.deps.stop();
    } catch {
      // 停不掉也先把标记留着，等它自己结束时会判成 cancelled。
    }
    return true;
  }

  /**
   * 等一个任务。**超时不是失败** —— 返回 `state: 'running'` 表示它还在跑。
   *
   * 这一点和"超时即报错"不一样：那时超时了动作却没停，人看着终端以为失败了，
   * 其实机器人还在走路。
   */
  async wait(id: string, timeoutMs: number): Promise<JobStatus> {
    const job = this.jobs.get(id);
    if (job == null) return { state: 'unknown', error: `没有任务 ${id}（也许已被挤出任务表）`, ms: 0 };
    if (job.finishedAt != null) return this.status(id);
    await Promise.race([
      job.promise?.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve(),
      new Promise<void>((r) => {
        setTimeout(r, Math.max(0, timeoutMs));
      }),
    ]);
    return this.status(id);
  }

  /** 测试用：直接拿到内部任务对象。 */
  peek(id: string): CliJob | undefined {
    return this.jobs.get(id);
  }
}

export default { CliJobTracker, CLI_JOB_LIMIT };
