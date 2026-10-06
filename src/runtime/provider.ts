/**
 * P1：profile → pi-ai `Models`/`Model` 的解析层。
 *
 * 这一层替换手写的 `src/models/gpt.ts`。它只负责"去哪儿、用什么模型、带什么
 * 头和 key"，不碰 deliberative 层；`prompter`/`agent` 暂时仍走旧路径（双路径
 * 迁移，旧代码在等价性验证通过前不删）。
 *
 * 关键点：OpenCode Go / Zen 是 pi-ai 的内置 provider，目录里带着正确的
 * `contextWindow`、`compat`（`thinkingFormat: "deepseek"`、
 * `requiresReasoningContentOnAssistantMessages`）以及
 * `withOpenCodeSessionHeader()` 自动注入的 `x-opencode-session`。
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { getKey, hasKey } from '../utils/keys.js';
import { resolveHeaders } from './headers.js';

/** OpenCode Go 的端点片段（注意必须比 Zen 先匹配，Go 的路径是 Zen 的子路径）。 */
const GO_HOST = 'opencode.ai/zen/go';
/** OpenCode Zen 的端点片段。 */
const ZEN_HOST = 'opencode.ai/zen';

/** 自定义端点未声明窗口时的回退值（与 `src/agent/compaction.ts` 的既有回退一致）。 */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/** profile.model 的两种写法（裸字符串 / 对象）归一后的结果。 */
export interface ProfileModel {
  modelId: string;
  url?: string;
  params: Record<string, unknown>;
}

/** 一个 profile 解析出的 pi-ai 侧全部所需。 */
export interface ResolvedProvider {
  models: Models;
  model: Model<Api>;
  providerId: string;
  /**
   * 请求级 apiKey。pi-ai 自己有 auth 机制，但仓库既有语义是
   * keys.json → 环境变量 → 本地端点占位 `'not-needed'`，这里保留原样，
   * 经 `ProviderRequestOptions.apiKey` 逐请求传入。
   */
  apiKey: string | undefined;
  /** profile 显式配置的额外头（`${VAR}` 已展开）。 */
  headers: Record<string, string> | null;
  /** 真实上下文窗口。内置目录直接给出（OpenCode Go 的 deepseek-v4.1-flash = 1_000_000）。 */
  contextWindow: number;
}

/** 只剥**开头**的 `openai/`，与 `_model_map.selectAPI` 的既有规则一致。 */
function stripApiPrefix(raw: string): string {
  return raw.startsWith('openai/') ? raw.slice('openai/'.length) : raw;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 归一 profile 的模型声明。支持三种历史写法：
 *   - 裸字符串：`"deepseek-v4.1-flash"`
 *   - `model` 为对象：`{ model: { model, url, params } }`（生产 profile 的写法）
 *   - 平铺：`{ model: "x", url, params }`
 */
export function readProfileModel(profile: unknown): ProfileModel {
  if (typeof profile === 'string' || profile instanceof String) {
    return { modelId: stripApiPrefix(String(profile)), params: {} };
  }
  const top = asRecord(profile);
  const raw = top['model'];
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    const nested = asRecord(raw);
    return {
      modelId: stripApiPrefix(typeof nested['model'] === 'string' ? (nested['model'] as string) : ''),
      url: typeof nested['url'] === 'string' ? (nested['url'] as string) : undefined,
      params: asRecord(nested['params']),
    };
  }
  return {
    modelId: stripApiPrefix(typeof raw === 'string' ? raw : ''),
    url: typeof top['url'] === 'string' ? (top['url'] as string) : undefined,
    params: asRecord(top['params']),
  };
}

/** 自定义 OpenAI 兼容端点用的合成模型条目。 */
function customModel(
  modelId: string,
  url: string,
  params: Record<string, unknown>,
): Model<'openai-completions'> {
  const declared = params['context_window'];
  const contextWindow =
    typeof declared === 'number' && Number.isFinite(declared) && declared > 0
      ? declared
      : FALLBACK_CONTEXT_WINDOW;
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'custom',
    baseUrl: url,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow,
    maxTokens: 4096,
  };
}

/**
 * 把 profile 解析成可用的 pi-ai `Models` 集合与具体 `Model`。
 *
 * 端点分派：
 *   - `opencode.ai/zen/go*` → 内置 `opencodeGoProvider()`
 *   - `opencode.ai/zen*`    → 内置 `opencodeProvider()`
 *   - 无 `url`              → 官方 `openaiProvider()`
 *   - 其它 `url`            → `createProvider()` 现造一个 OpenAI 兼容 provider
 */
export function resolveProvider(profile: unknown): ResolvedProvider {
  const { modelId, url, params } = readProfileModel(profile);
  const apiKeyEnv =
    typeof params['api_key_env'] === 'string' ? (params['api_key_env'] as string) : 'OPENAI_API_KEY';
  const headers = resolveHeaders(params['headers']);

  // key 语义与旧适配器逐字一致：keys.json → 环境变量；本地/自建端点缺 key
  // 时用占位（LM Studio、vLLM、Ollama 兼容口通常不校验）；官方端点缺 key
  // 是明确的配置错误，交给 getKey 抛出。
  const found = hasKey(apiKeyEnv);
  let apiKey: string | undefined;
  if (found != null && found !== '') {
    apiKey = found;
  } else if (url != null) {
    apiKey = 'not-needed';
  } else {
    apiKey = getKey(apiKeyEnv);
  }

  const models = createModels();
  let providerId: string;
  if (url != null && url.includes(GO_HOST)) {
    providerId = 'opencode-go';
    models.setProvider(opencodeGoProvider());
  } else if (url != null && url.includes(ZEN_HOST)) {
    providerId = 'opencode';
    models.setProvider(opencodeProvider());
  } else if (url == null) {
    providerId = 'openai';
    models.setProvider(openaiProvider());
  } else {
    providerId = 'custom';
    models.setProvider(
      createProvider({
        id: providerId,
        name: 'OpenAI-compatible endpoint',
        baseUrl: url,
        auth: { apiKey: envApiKeyAuth(apiKeyEnv, [apiKeyEnv]) },
        models: [customModel(modelId, url, params)],
        api: { 'openai-completions': openAICompletionsApi() },
      }),
    );
  }

  // 目录里没有该 id 时退到该 provider 的第一个模型（旧适配器对未知模型名
  // 是直接透传给网关，让网关去报错；这里保持"不因本地目录缺失就崩"）。
  const model = models.getModel(providerId, modelId) ?? models.getModels(providerId)[0];
  if (model == null) {
    throw new Error(`Model "${modelId}" not found in provider "${providerId}".`);
  }

  return { models, model, providerId, apiKey, headers, contextWindow: model.contextWindow };
}
