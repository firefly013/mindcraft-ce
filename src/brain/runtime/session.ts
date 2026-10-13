/**
 * P2：每个 bot 进程一个 SQLite 的 pi-durable 会话。
 *
 * pi-durable 明确"一个进程同时只能独占一个 storage，且无跨进程锁"，这与仓库
 * 现有的"1 bot = 1 子进程"拓扑天然吻合（`src/process/agent_process.ts`）。
 * 目录规则沿用既有的 `bots/<profile.name>/`，所以落盘位置对运维是连续的。
 *
 * 注意：`openNodeSqliteStorage` 走 **Node 内置 `node:sqlite`**，没有第三方
 * 原生依赖，因此不需要 `npm install --legacy-peer-deps` 之外的额外构建步骤。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import {
  Harness,
  type CompactionPolicy,
  type Conversation,
  type ModelRef,
  type RegistryReader,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Models } from '@earendil-works/pi-ai';

/** 默认落盘根目录，与 `History.base_dir` 的规则一致。 */
export function botBaseDir(name: string): string {
  return `./bots/${name}`;
}

/**
 * SQLite 文件路径。
 *
 * `instanceId` 不是装饰：同名 bot 或同 profile 多开会共用 `bots/<name>/`，
 * 而 pi-durable 不做跨进程加锁——不区分就会两个进程写同一个库。
 */
export function botDbPath(name: string, baseDir?: string, instanceId?: string): string {
  const dir = baseDir ?? botBaseDir(name);
  const suffix = instanceId != null && instanceId !== '' ? `-${instanceId}` : '';
  return `${dir}/session${suffix}.db`;
}

export interface BotSessionOptions<Tool extends ToolRegistration = ToolRegistration> {
  /** bot 名（profile.name），决定目录。 */
  name: string;
  models: Models;
  registry: RegistryReader<Tool>;
  /**
   * 会话使用的模型。
   *
   * 必须给：不写进 `pi.agent` 的会话没有模型，generation 起不来，`submit()`
   * 会直接以 `unanswered` 结算（这个坑踩过一次）。
   * 首次创建时随 `root()` 写入；重开时若存档里的与当前不一致则以当前为准
   * （profile 换了模型要生效）。
   */
  model?: ModelRef;
  /**
   * 压仓策略。不给就用 pi-durable 的内置默认。
   *
   * 触发线是 `model.contextWindow - reserveTokens`——**窗口取自 pi-ai 目录**
   * （OpenCode Go 的 `deepseek-v4.1-flash` = 1_000_000），不是 profile 里的
   * 声明值。用 `compactionPolicyFromProfile()` 从 profile 解析。
   */
  compaction?: CompactionPolicy;
  /** 落盘根目录，默认 `./bots/<name>`。 */
  baseDir?: string;
  /** 实例区分后缀，用于同名/同 profile 多开时避免撞同一个库文件。 */
  instanceId?: string;
}

export interface BotSession {
  harness: Harness;
  conversation: Conversation;
  dbPath: string;
  close(): Promise<void>;
}

/** 打开（或创建）一个 bot 会话：SQLite storage + Harness + 根 conversation。 */
export async function openBotSession<Tool extends ToolRegistration>(
  options: BotSessionOptions<Tool>,
): Promise<BotSession> {
  const dbPath = botDbPath(options.name, options.baseDir, options.instanceId);
  mkdirSync(dirname(dbPath), { recursive: true });

  const storage = await openNodeSqliteStorage(dbPath);
  const harness = await Harness.open(
    storage,
    {
      models: options.models,
      registry: options.registry,
      ...(options.compaction != null ? { settings: { compaction: options.compaction } } : {}),
    },
    BACKGROUND_CONTEXT,
  );
  // 根 conversation 在首次调用时创建；重开同一个库会拿回同一个。
  const conversation = await harness.root(
    BACKGROUND_CONTEXT,
    options.model != null ? { agent: { model: options.model } } : undefined,
  );

  // `root()` 只在创建时应用 agent；重开时存档里的模型会赢。profile 换了模型
  // 要能生效，所以这里比对一次、不一致才写（避免每次开库都多一次 commit）。
  if (options.model != null) {
    const agent = await conversation.agent(BACKGROUND_CONTEXT);
    if (agent.model?.provider !== options.model.provider || agent.model?.modelId !== options.model.modelId) {
      await conversation.configure({ model: options.model }, BACKGROUND_CONTEXT);
    }
  }

  return {
    harness,
    conversation,
    dbPath,
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}
