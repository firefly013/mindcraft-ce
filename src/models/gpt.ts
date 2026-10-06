import OpenAIApi from 'openai';
import { randomUUID } from 'node:crypto';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat, toLlmMessages } from '../utils/text.js';
import type {
  AIModel,
  ChatMessage,
  OpenAITool,
  TokenUsage,
  ToolResponse,
} from '../types/common.js';

/** 构造 OpenAI 客户端时的选项类型（不再手写一遍形状）。 */
type OpenAIClientOptions = NonNullable<ConstructorParameters<typeof OpenAIApi>[0]>;

/**
 * provider 的 `usage` 归一化。
 *
 * 上下文占用量取 `total_tokens`（prompt + completion）：压仓判断的是
 * "这个窗口还能装多少"，所以补全出来的 token 也要算进去。
 * 老端点可能只给 prompt/completion 两项，缺 total 就自己加。
 * 三项都拿不到时返回 undefined——宁可不压仓，也不要拿 0 当"空上下文"。
 */
export function normalizeUsage(raw: unknown): TokenUsage | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const prompt = num(u['prompt_tokens']);
  const completion = num(u['completion_tokens']);
  const total = num(u['total_tokens']);
  if (prompt == null && completion == null && total == null) return undefined;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: total ?? promptTokens + completionTokens,
  };
}

/**
 * 这个错误是不是"上下文超限"。
 *
 * OpenAI 兼容端点报法不一：有 `code: 'context_length_exceeded'`，
 * 也有中文/英文的自由文本。宁可多认几种，认错的代价只是一次多余压缩。
 */
export function isContextOverflow(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } } | null;
  const code = typeof e?.code === 'string' ? e.code : typeof e?.error?.code === 'string' ? e.error.code : '';
  const msg =
    typeof e?.message === 'string'
      ? e.message
      : typeof e?.error?.message === 'string'
        ? e.error.message
        : '';
  const hay = `${code} ${msg}`.toLowerCase();
  return (
    hay.includes('context_length') ||
    hay.includes('context length') ||
    hay.includes('maximum context') ||
    hay.includes('too many tokens') ||
    hay.includes('reduce the length')
  );
}

/**
 * headers 支持 `${VAR}` 占位，未设置的变量取一个新的 UUID。
 *
 * 用途：Zen 这类网关按会话路由，需要"每个进程一个会话 id"，而 profile
 * 是静态 JSON。写成 `"x-opencode-session": "${OPENCODE_SESSION_ID}"` 就
 * 既能表达这个头，又默认保持唯一（设了环境变量则全进程共用同一个）。
 */
export function resolveHeaders(raw: unknown): Record<string, string> | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    out[key] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
      const fromEnv = process.env[name];
      return fromEnv != null && fromEnv !== '' ? fromEnv : randomUUID();
    });
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 唯一的供应商适配器：任何 OpenAI 兼容端点都走这里。
 *
 * profile 里能配的东西：
 *   - `url`：兼容端点根地址（不填走官方 OpenAI）；
 *   - `params.api_key_env`：从 keys.json/环境变量取 key 的变量名，
 *     默认 `OPENAI_API_KEY`（Zen、vLLM、LM Studio 各用各的 key 名）；
 *   - `params.headers`：额外 HTTP 头（如 Zen 的 `x-opencode-session`）；
 *   - `params` 其余键原样进请求体（如 `thinking: {type: 'disabled'}`）。
 */
export class GPT implements AIModel {
  static prefix = 'openai';
  // `protected` (not `private`) so subclasses can reconfigure them.
  protected model_name: string | null;
  protected params: Record<string, unknown> | undefined;
  protected url: string | undefined;
  protected openai: OpenAIApi;
  /** 构造时实际用的客户端选项（诊断/单测可读，避免为了看 headers 去联网）。 */
  readonly clientOptions: OpenAIClientOptions;

  constructor(
    model_name: string | null,
    url?: string,
    params?: Record<string, unknown>,
    client?: OpenAIApi | null,
  ) {
    this.model_name = model_name;
    this.params = params;
    this.url = url; // store so that we know whether a custom URL has been set

    const config: Record<string, unknown> = {};
    if (url) config['baseURL'] = url;

    if (hasKey('OPENAI_ORG_ID')) config['organization'] = getKey('OPENAI_ORG_ID');

    // key 变量名可由 profile 指定，这样一个适配器能服务任意兼容端点。
    const keyEnv =
      typeof params?.['api_key_env'] === 'string' ? (params['api_key_env'] as string) : 'OPENAI_API_KEY';
    if (client == null) {
      const key = hasKey(keyEnv);
      if (key != null && key !== '') {
        config['apiKey'] = key;
      } else if (url) {
        // 本地/自建兼容端点（LM Studio、vLLM、Ollama 兼容口…）通常不校验 key。
        // 这些以前各有专属适配器、根本不读 key；收敛成单一适配器后
        // 不能因为"keys.json 里没这一项"就崩在构造期。
        config['apiKey'] = 'not-needed';
      } else {
        // 官方端点缺 key 是明确的配置错误，按原样报出来。
        config['apiKey'] = getKey(keyEnv);
      }
    }

    const extraHeaders = resolveHeaders(params?.['headers']);
    if (extraHeaders != null) config['defaultHeaders'] = extraHeaders;

    this.clientOptions = config as OpenAIClientOptions;
    // client 可注入：单测不必联网，也不必真有 key。
    this.openai = client ?? new OpenAIApi(this.clientOptions);
  }

  /** 请求体参数：headers / api_key_env 是接线字段，不能混进 body。 */
  protected bodyParams(): Record<string, unknown> {
    const body: Record<string, unknown> = { ...(this.params ?? {}) };
    delete body['headers'];
    delete body['api_key_env'];
    return body;
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq = '***',
  ): Promise<string> {
    const model = this.model_name || 'gpt-5.4-mini';

    let res: string | null;

    try {
      console.log('Awaiting openai api response from model', model);
      // if a custom URL is set, use chat.completions
      // because custom "OpenAI-compatible" endpoints likely do not have responses endpoint
      if (this.url) {
        let msgs = [{ role: 'system', content: systemMessage } as ChatMessage].concat(
          toLlmMessages(turns),
        );
        msgs = strictFormat(msgs);
        const pack: Record<string, unknown> = {
          model: model,
          messages: msgs,
          stop: stop_seq,
          ...this.bodyParams(),
        };
        if (model.includes('o1') || model.includes('o3') || model.includes('5')) {
          delete pack['stop'];
        }
        const completion = (await this.openai.chat.completions.create(
          pack as unknown as Parameters<typeof this.openai.chat.completions.create>[0],
        )) as unknown as {
          choices: Array<{
            finish_reason?: string;
            message: { content: string | null; tool_calls?: never[] };
          }>;
        };
        if (completion.choices[0]?.finish_reason == 'length')
          throw new Error('Context length exceeded');
        console.log('Received.');
        res = completion.choices[0]?.message.content ?? null;
      } else {
        const msgs = toLlmMessages(turns);
        const withStop = msgs.map((message) => {
          message.content += stop_seq;
          return message;
        });
        const response = await this.openai.responses.create({
          model: model,
          instructions: systemMessage,
          input: withStop as never,
          ...this.bodyParams(),
        });
        console.log('Received.');
        res = response.output_text;
        const stop_seq_index = res.indexOf(stop_seq);
        res = stop_seq_index !== -1 ? res.slice(0, stop_seq_index) : res;
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if ((msg == 'Context length exceeded' || code == 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
      } else if (msg.includes('image_url')) {
        console.log(err);
        res = 'Vision is only supported by certain models.';
      } else {
        console.log(err);
        res = 'My brain disconnected, try again.';
      }
    }
    return res ?? 'My brain disconnected, try again.';
  }

  /**
   * OpenAI 原生工具调用：把命令转换后的 tools 直接透传给 chat.completions。
   *
   * `liveTail` 是调用方拼好的"本轮上下文尾巴"（事件 / 记忆 / Live 快照），
   * 原样作为最后一条 user 消息发出——标题由拼装方负责，这里不加壳，
   * 免得"## 事件"挂在"## 当前世界快照"标题底下。
   * 有现拍示意图就把图附在同一条 user 消息里（多模态数组）。
   */
  async sendRequestWithTools(
    turns: ChatMessage[],
    systemMessage: string,
    tools: OpenAITool[],
    tool_choice = 'auto',
    liveTail = '',
    liveImage: string | null = null,
  ): Promise<ToolResponse> {
    // 只发 role + content：历史条目上的 kind/level/at/usage 是内部字段，
    // 混进请求体既浪费 token 也可能被严格网关判成非法字段（Pi 的 convertToLlm）。
    const messages = [{ role: 'system', content: systemMessage } as ChatMessage].concat(
      toLlmMessages(turns),
    );
    if (liveTail.trim() !== '' || liveImage != null) {
      if (liveImage != null) {
        // ChatMessage.content 是 string，多模态要数组——网关认，类型上 cast 一下。
        const parts: Array<Record<string, unknown>> = [];
        if (liveTail.trim() !== '') parts.push({ type: 'text', text: liveTail });
        parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${liveImage}` } });
        messages.push({ role: 'user', content: parts } as unknown as ChatMessage);
      } else {
        messages.push({ role: 'user', content: liveTail });
      }
    }
    const model = this.model_name || 'gpt-5.4-mini';
    try {
      console.log('Awaiting openai tool response from model', model);
      const completion = await this.openai.chat.completions.create({
        model,
        messages: messages as never,
        tools: tools as never,
        tool_choice: tool_choice as never,
        ...this.bodyParams(),
      } as never);
      const choice = completion.choices[0];
      const msg = choice?.message;
      const tool_calls = (msg?.tool_calls ?? []).map((tc) => {
        const fn = (tc as { id?: string; function?: { name?: string; arguments?: string } }).function;
        let args: Record<string, unknown>;
        try {
          args = (JSON.parse(fn?.arguments ?? '{}') ?? {}) as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { id: (tc as { id: string }).id, name: fn?.name ?? '', args };
      });
      return {
        text: (msg?.content ?? '') as string,
        tool_calls,
        // usage 是压仓触发线的唯一可信输入，必须带回上层。
        usage: normalizeUsage(completion.usage),
        // finish_reason=length 说明这次回复被窗口截断了：即使还没报错，
        // 也按溢出处理，让上层压缩后重试。
        overflow: choice?.finish_reason === 'length',
      };
    } catch (err) {
      console.log(err);
      // 上下文超限不是"网络断了"，上层要据此压缩后重试一次。
      if (isContextOverflow(err)) return { text: '', tool_calls: [], overflow: true };
      return { text: 'My brain disconnected, try again.', tool_calls: [] };
    }
  }
}
