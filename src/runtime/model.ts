/**
 * P1：`AIModel` 的 pi-ai 实现。
 *
 * 与旧 `src/models/gpt.ts` 的 `GPT` 类接口逐字兼容，因此可以在
 * `prompter`/`agent` 不改一行的前提下替换（双路径：等价性验证通过前旧代码不删）。
 *
 * 语义保持的三个要点：
 *   1. `liveTail` / 截图作为**最后一条 user 消息**原样发出，标题由拼装方负责，
 *      这里不加壳（否则"## 事件"会挂到"## 当前世界快照"标题底下）。
 *   2. profile 的 `params` 去掉 `headers`/`api_key_env` 后经 pi-ai 的
 *      `samplingParams` **原样进请求体**（`thinking` 等自定义字段照旧生效）。
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
import type { AIModel, ChatMessage, OpenAITool, ToolResponse } from '../types/common.js';
import { readProfileModel, resolveProvider, type ResolvedProvider } from './provider.js';

/** 重放历史里的 assistant 消息不携带真实用量，用零值占位。 */
const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** `ChatMessage[]` → pi-ai `Message[]`（重放历史）。 */
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
  /** 请求级重试次数。测试里设 0，避免失败后退避等待。 */
  maxRetries?: number;
}

export class PiModel implements AIModel {
  static prefix = 'openai';

  readonly resolved: ResolvedProvider;
  private readonly params: Record<string, unknown>;
  private readonly options: PiModelOptions;

  constructor(profile: unknown, options: PiModelOptions = {}) {
    this.resolved = resolveProvider(profile);
    this.params = readProfileModel(profile).params;
    this.options = options;
  }

  /** 与旧 `GPT.clientOptions` 对应的只读诊断快照（旧测试读它，不联网）。 */
  get clientOptions(): Record<string, unknown> {
    return {
      baseURL: this.resolved.model.baseUrl,
      apiKey: this.resolved.apiKey,
      ...(this.resolved.headers != null ? { defaultHeaders: this.resolved.headers } : {}),
    };
  }

  /** profile 的 `params` 去掉接线字段，其余原样进请求体（旧 `bodyParams()`）。 */
  private bodyParams(): Record<string, unknown> {
    const body: Record<string, unknown> = { ...this.params };
    delete body['headers'];
    delete body['api_key_env'];
    return body;
  }

  /** 逐请求选项：apiKey / headers 用既有语义，其余经 `samplingParams` 原样进体。 */
  private requestOptions(samplingParams: Record<string, unknown>): Record<string, unknown> {
    return {
      apiKey: this.resolved.apiKey,
      ...(this.resolved.headers != null ? { headers: this.resolved.headers } : {}),
      samplingParams,
      ...(this.options.fetch != null ? { fetch: this.options.fetch } : {}),
      ...(this.options.maxRetries != null ? { maxRetries: this.options.maxRetries } : {}),
      ...(this.options.onPayload != null ? { onPayload: this.options.onPayload } : {}),
    };
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
      const message = await this.resolved.models.complete(
        model,
        { systemPrompt: systemMessage, messages: toPiMessages(turns, model) },
        this.requestOptions(sampling) as never,
      );
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
      const message = await this.resolved.models.complete(
        model,
        { systemPrompt: systemMessage, messages, tools: toPiTools(tools) },
        {
          ...this.requestOptions(this.bodyParams()),
          toolChoice,
        } as never,
      );
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
