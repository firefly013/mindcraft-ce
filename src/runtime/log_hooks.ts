/**
 * 把 pi-durable 的关键生命周期接到结构化日志上。
 *
 * 这里补的三件事以前**完全不可见**：
 *
 * | 模块 | 以前 | 现在 |
 * |---|---|---|
 * | `provider` | 什么都不打。42 轮请求全部 `stopReason:"error"`、模型一个字答不出来，stdout 上一个字都没有 | 每次终态响应都记 `stopReason` / `errorMessage` / usage，**error 走 error 级别并镜像到 stdout** |
 * | `compact` | 只能靠 request 文件翻页间接猜 | 记原因 / 压掉多少条 / 保留段第一条 |
 *
 * 两个 hook 都返回 `undefined`：只看不改，请求原样发出、压仓用框架默认摘要。
 */
import {
  CompactionTask,
  GenerationTask,
  hook,
  type HookRegistration,
} from '@earendil-works/pi-durable';
import type { EventIntake } from './events.js';
import type { Logger } from './logger.js';

/**
 * provider 的终态响应。
 *
 * `afterResponse` 是 pi-durable 给的钩子（"Every terminal provider message,
 * before classification"）——它拿得到 `errorMessage`，那是排错时唯一能告诉你
 * "模型为什么没回话"的字段。
 */
export function providerLogHook(logger: Logger): HookRegistration {
  const log = logger.with('provider');
  return hook(GenerationTask, {
    afterResponse: (message) => {
      const failed = message.stopReason === 'error' || message.errorMessage != null;
      const data: Record<string, unknown> = {
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        inputTokens: message.usage?.input ?? null,
        outputTokens: message.usage?.output ?? null,
        totalTokens: message.usage?.totalTokens ?? null,
        error: message.errorMessage ?? null,
        content: Array.isArray(message.content)
          ? message.content.map((part) => part.type)
          : typeof message.content,
      };
      if (failed) log.error(data);
      else log.info(data);
    },
  });
}

/** 压仓：为什么压、压掉多少条、保留段从哪开始。 */
export function compactionLogHook(logger: Logger): HookRegistration {
  const log = logger.with('compact');
  return hook(CompactionTask, {
    beforeCompact: (compaction) => {
      log.info({
        reason: compaction.reason,
        entriesReplaced: compaction.entries.length,
        messagesSummarized: compaction.messages.length,
        firstKept: compaction.firstKept,
        instructions: compaction.instructions ?? null,
      });
      return undefined;
    },
  });
}

/**
 * 把 provider 请求的开始/结束告诉接入层——那是 **L3 整流的闸门**。
 *
 * 模型正在生成的时候它**本来就不能反应**新事件，所以那段时间只攒不发；
 * 请求一结束再检查"需要请求"标志，把整批一次带走。
 *
 * 没有这个闸门就只能每条事件 `submit` 一次：实测 5 条 steer = 5 次 API 调用，
 * 真机上一场骷髅战掉 8 次血就是 8 次完整请求。
 */
export function intakeLifecycleHook(intake: EventIntake): HookRegistration {
  return hook(GenerationTask, {
    beforeRequest: () => {
      intake.requestStarted();
      return undefined;
    },
    afterResponse: () => {
      intake.requestFinished();
      return undefined;
    },
  });
}
