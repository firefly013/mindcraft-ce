/**
 * P1：`AIModel` 的 pi-ai 实现。
 *
 * 与旧 `src/models/gpt.ts` 的 `GPT` 类接口逐字兼容，因此可以在
 * `prompter`/`agent` 不改一行的前提下替换（双路径：等价性验证通过前旧代码不删）。
 *
 * 语义保持的三个要点：
 *   1. `liveTail` / 截图作为**最后一条 user 消息**原样发出，标题由拼装方负责，
 *      这里不加壳（否则"## 事件"会挂到"## 当前世界快照"标题底下）。
 *   2. 采样参数（模型定义里的 `samplingParams`）经
 *      pi-ai 的 `samplingParams` **原样进请求体**（`thinking` 等自定义字段照旧生效）。
 *   3. `stop` 走请求体字段，不追加到消息里；模型名含 o1/o3/5 时删掉——复刻旧
 *      URL 分支的行为。
 */
import {
  contentText,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type Tool,
  type ToolCall,
  type TSchema,
} from '@earendil-works/pi-ai';
import type { AIModel, ChatMessage, OpenAITool, ToolResponse } from '../../shared/types/common.js';
import { resolveModelRetries, resolveProvider, type ResolvedProvider } from './provider.js';

/** 重放历史里的 assistant 消息不携带真实用量，用零值占位。 */
const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 瞬时失败重试的退避基数；第 n 次重试延迟 base * 2^(n-1)。 */
export const MODEL_RETRY_BASE_DELAY_MS = 500;

export interface ModelRetryInfo {
  /** 第几次重试，1 起。 */
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorMessage: string;
}

/** 确定性错误：鉴权、参数、模型不存在、额度等，重试也不会变。 */
const NON_RETRYABLE_MODEL_ERROR_PATTERN =
  /(unauthor|forbidden|invalid[\s_-]*api[\s_-]*key|api[\s_-]*key|authentication|permission|not configured|bad[\s_-]*request|invalid[\s_-]*request|invalid[\s_-]*parameter|parameter|model[\s_-]*not[\s_-]*found|unknown[\s_-]*model|GoUsageLimitError|FreeUsageLimitError|usage[\s_-]*limit|quota|billing|insufficient_quota|available[\s_-]*balance|context[\s_-]*length|maximum[\s_-]*context|too[\s_-]*long)/i;

/** 瞬时错误：网络、超时、HTTP 5xx / 408。 */
const TRANSIENT_MODEL_ERROR_PATTERN =
  /(network[\s_-]*error|connection[\s_-]*(error|refused|reset|lost)|other[\s_-]*side[\s_-]*closed|fetch[\s_-]*failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed?[\s_-]*out|timeout|socket[\s_-]*hang[\s_-]*up|upstream[\s_-]*connect|reset[\s_-]*before[\s_-]*headers|socket[\s_-]*connection[\s_-]*was[\s_-]*closed|server[\s_-]*error|service[\s_-]*unavailable|internal[\s_-]*error|bad[\s_-]*gateway|gateway[\s_-]*time[\s_-]*out|overloaded|terminated|ended[\s_-]*without|stream[\s_-]*ended[\s_-]*before|pending[\s_-]*stream[\s_-]*has[\s_-]*been[\s_-]*canceled|408|\b5\d\d\b)/i;

function httpStatusOf(error: unknown): number | undefined {
  if (error == null || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * 只对网络/超时/5xx 等瞬时故障返回 true。
 *
 * 鉴权(401/403)、参数(400/422)、额度/billing 等确定性错误一律 false；
 * HTTP 状态码优先于文本匹配，避免把 400 的 network 文案误判成可重试。
 */
export function isTransientModelFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error == null
          ? ''
          : String(error);
  const status = httpStatusOf(error);
  if (status != null) {
    if (status === 408 || status >= 500) return true;
    if (status >= 400) return false;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /auth|model_validation|oauth/i.test(code)) return false;
  if (NON_RETRYABLE_MODEL_ERROR_PATTERN.test(message)) return false;
  return TRANSIENT_MODEL_ERROR_PATTERN.test(message);
}

/** ChatMessage[] → pi-ai Message[]（重放历史）。 */
export function toPiMessages(turns: ChatMessage[], model: Model<Api>): Message[] {
  return turns.map((turn): Message => {
    const timestamp = typeof turn.at === 'number' ? turn.at : Date.now();
    if (turn.role === 'assistant') {
      return {
        role: 'assistant',
        content: [{ type: 'text', text: turn.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: 'stop',
        timestamp,
      };
    }
    if (turn.role === 'system') {
      return { role: 'system', content: turn.content, timestamp };
    }
    return { role: 'user', content: turn.content, timestamp };
  });
}

/**
 * `OpenAITool[]` → pi-ai `Tool[]`。
 *
 * 现有 `paramToSchema` 产出的就是 JSON Schema，而 TypeBox 的 `TSchema` 在运行时
 * 就是 JSON Schema 对象，所以这里是一次结构转换而非重写；P4 再把声明本身迁到
 * `defineTool` + TypeBox。
 */
export function toPiTools(tools: OpenAITool[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters as unknown as TSchema,
  }));
}

export interface PiModelOptions {
  /** 测试/诊断：请求发出前观察或替换 payload（pi-ai 的 `onPayload`）。 */
  onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined;
  /** 测试注入：替代全局 fetch。对应旧 `GPT` 的 `client` 注入参数，同样不联网。 */
  fetch?: typeof globalThis.fetch;
  /**
   * 瞬时错误重试次数（不含首次请求）。默认读 MINDCRAFT_MODEL_RETRIES，
   * 未设置时用 2；0 表示关闭重试。
   */
  maxRetries?: number;
  /** 测试注入：重试退避的 sleep；默认 setTimeout。 */
  retrySleep?: (delayMs: number) => Promise<void>;
  /** 重试日志出口；默认 console.warn，记录第几次重试与退避时长。 */
  onRetry?: (info: ModelRetryInfo) => void;
  /** 测试注入：直接给已解析 provider，跳过 resolveProvider。 */
  resolvedProvider?: ResolvedProvider;
}

export class PiModel implements AIModel {
  static prefix = 'openai';

  readonly resolved: ResolvedProvider;
  private readonly params: Record<string, unknown>;
  private readonly options: PiModelOptions;
  private readonly maxRetries: number;
  private readonly retrySleep: (delayMs: number) => Promise<void>;
  private readonly onRetry: (info: ModelRetryInfo) => void;

  constructor(profile: unknown, options: PiModelOptions = {}) {
    this.resolved = options.resolvedProvider ?? resolveProvider(profile);
    this.params = this.resolved.params;
    this.options = options;
    this.maxRetries = options.maxRetries ?? resolveModelRetries();
    this.retrySleep =
      options.retrySleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.onRetry =
      options.onRetry ??
      ((info) => {
        console.warn(
          '[model] ' + info.errorMessage + '; retry ' +
            info.attempt + '/' + info.maxRetries + ' in ' + info.delayMs + 'ms',
        );
      });
  }

  /** 与旧 `GPT.clientOptions` 对应的只读诊断快照（旧测试读它，不联网）。 */
  get clientOptions(): Record<string, unknown> {
    return {
      baseURL: this.resolved.model.baseUrl,
      apiKey: this.resolved.apiKey,
      ...(this.resolved.headers != null ? { defaultHeaders: this.resolved.headers } : {}),
    };
  }

  /** 要带进请求体的采样参数（已由 provider 层合并好）。 */
  private bodyParams(): Record<string, unknown> {
    return { ...this.params };
  }

  /** 逐请求选项：apiKey / headers 用既有语义，其余经 `samplingParams` 原样进体。 */
  private requestOptions(samplingParams: Record<string, unknown>): Record<string, unknown> {
    return {
      apiKey: this.resolved.apiKey,
      ...(this.resolved.headers != null ? { headers: this.resolved.headers } : {}),
      samplingParams,
      ...(this.options.fetch != null ? { fetch: this.options.fetch } : {}),
      // 重试统一在本类里做，SDK 内层关闭，避免一次失败被两层叠加放大。
      maxRetries: 0,
      ...(this.options.onPayload != null ? { onPayload: this.options.onPayload } : {}),
    };
  }

  /**
   * 带瞬时错误重试的 complete：网络/超时/5xx 最多重试 maxRetries 次；
   * 鉴权/参数等确定性错误立即返回或抛出，不重试。
   */
  private async completeWithRetry(
    model: Model<Api>,
    request: () => Promise<AssistantMessage>,
  ): Promise<AssistantMessage> {
    for (let retryCount = 0; ; retryCount += 1) {
      let message: AssistantMessage | undefined;
      let thrown: unknown;
      try {
        message = await request();
        if (message.stopReason !== 'error') return message;
      } catch (error: unknown) {
        thrown = error;
      }

      const detail =
        message != null
          ? message.errorMessage ?? 'model returned error stopReason'
          : thrown instanceof Error
            ? thrown.message
            : String(thrown);
      const retryable =
        message != null
          ? isTransientModelFailure(message.errorMessage)
          : isTransientModelFailure(thrown);

      if (!retryable || retryCount >= this.maxRetries) {
        if (message != null) return message;
        throw thrown;
      }

      const attempt = retryCount + 1;
      const delayMs = MODEL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      this.onRetry({ attempt, maxRetries: this.maxRetries, delayMs, errorMessage: detail });
      await this.retrySleep(delayMs);
    }
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stopSeq = '***',
  ): Promise<string> {
    const model = this.resolved.model;
    // 旧适配器在 URL 分支把 stop 放在请求体字段里，且模型名含 o1/o3/5 时删掉。
    const sampling = this.bodyParams();
    if (!/o1|o3|5/.test(model.id)) sampling['stop'] = stopSeq;
    try {
      const message = await this.completeWithRetry(model, () =>
        this.resolved.models.complete(
          model,
          { systemPrompt: systemMessage, messages: toPiMessages(turns, model) },
          this.requestOptions(sampling) as never,
        ),
      );
      if (message.stopReason === 'error') {
        console.warn(
          '[model] request failed after retries: ' + (message.errorMessage ?? 'unknown error'),
        );
        return 'My brain disconnected, try again.';
      }
      const text = contentText(message.content);
      const index = text.indexOf(stopSeq);
      return index !== -1 ? text.slice(0, index) : text;
    } catch (err) {
      console.log(err);
      return 'My brain disconnected, try again.';
    }
  }

  async sendRequestWithTools(
    turns: ChatMessage[],
    systemMessage: string,
    tools: OpenAITool[],
    toolChoice = 'auto',
    liveTail = '',
    liveImage: string | null = null,
  ): Promise<ToolResponse> {
    const model = this.resolved.model;
    const messages = toPiMessages(turns, model);

    // 本轮上下文尾巴（事件 / 记忆 / Live 快照）+ 现拍截图，作为最后一条 user 消息。
    if (liveTail.trim() !== '' || liveImage != null) {
      const parts: (TextContent | ImageContent)[] = [];
      if (liveTail.trim() !== '') parts.push({ type: 'text', text: liveTail });
      if (liveImage != null) parts.push({ type: 'image', data: liveImage, mimeType: 'image/jpeg' });
      // 只有文字时退化成纯字符串，与旧适配器发出的形状一致。
      const content = parts.length === 1 && parts[0]?.type === 'text' ? liveTail : parts;
      messages.push({ role: 'user', content, timestamp: Date.now() });
    }

    try {
      const message = await this.completeWithRetry(model, () =>
        this.resolved.models.complete(
          model,
          { systemPrompt: systemMessage, messages, tools: toPiTools(tools) },
          {
            ...this.requestOptions(this.bodyParams()),
            toolChoice,
          } as never,
        ),
      );
      if (message.stopReason === 'error') {
        console.warn(
          '[model] request failed after retries: ' + (message.errorMessage ?? 'unknown error'),
        );
        return { text: 'My brain disconnected, try again.', tool_calls: [] };
      }
      const tool_calls = message.content
        .filter((block): block is ToolCall => block.type === 'toolCall')
        .map((call) => ({
          id: call.id,
          name: call.name,
          args: call.arguments as Record<string, unknown>,
        }));
      return { text: contentText(message.content), tool_calls };
    } catch (err) {
      console.log(err);
      return { text: 'My brain disconnected, try again.', tool_calls: [] };
    }
  }
}
