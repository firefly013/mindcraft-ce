/**
 * profile 的模型引用 → pi-ai 的 `Models` / `Model`。
 *
 * 与旧实现的差别是**配置从文件来**，与 Pi 同一套：
 *   - profile 只写引用：`"model": "opencode-go/deepseek-v4.1-flash"`（或对象形式）；
 *   - 端点、模型、采样参数、窗口写在 `providers.json`；
 *   - 凭据写在 `auth.json`（值支持 `$ENV` / `!command`）。
 *
 * 解析不到就抛错。旧实现里"目录里没有这个 id 就退回该 provider 的第一个模型"
 * 已经删掉——那会让拼错的模型名悄悄跑到别的模型上。
 *
 * providerId 分两类：
 *   - pi-ai 内置目录里的（`opencode-go` / `opencode` / `openai`）：用内置 provider，
 *     目录里的窗口、cost、compat 都在；
 *   - 其余：由 `providers.json` 现造一个 OpenAI 兼容 provider，模型由 `models` 声明。
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Models,
  type Provider,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import { opencodeProvider } from '@earendil-works/pi-ai/providers/opencode';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { resolveConfigValue, resolveConfigValueOrThrow } from '../../shared/config/value.js';
import {
  DEFAULT_AUTH_PATH,
  DEFAULT_PROVIDERS_PATH,
  loadAuthConfig,
  loadProvidersConfig,
} from '../../shared/config/load.js';
import type { ModelDefinition, ModelOverride, ProvidersConfig } from '../../shared/config/schema.js';

/** 自定义端点未声明窗口时的回退值（与旧实现一致）。 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
/** 没有声明的 maxTokens 的回退值。 */
const FALLBACK_MAX_TOKENS = 4096;

/** profile.model 归一后的结果。 */
export interface ModelReference {
  /** `provider/model` 里的 provider；对象形式里没写就是 undefined，稍后按模型 id 找。 */
  providerId?: string;
  modelId: string;
}

/** 一个 profile 解析出的 pi-ai 侧全部所需。 */
export interface ResolvedProvider {
  models: Models;
  model: Model<Api>;
  providerId: string;
  apiKey: string | undefined;
  headers: Record<string, string> | null;
  contextWindow: number;
  /** 请求体里要带的采样参数，来自 providers.json 的模型定义。 */
  params: Record<string, unknown>;
}

export interface ResolveProviderOptions {
  providersPath?: string;
  authPath?: string;
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
 * 归一 profile 的模型引用。两种写法：
 *
 * ```jsonc
 * "model": "opencode-go/deepseek-v4.1-flash"
 * "model": { "provider": "opencode-go", "model": "deepseek-v4.1-flash" }
 * ```
 *
 * 裸字符串（没有 `/`）也认：那就只按模型 id 找，找不到再报错。
 */
export function readModelReference(profile: unknown): ModelReference {
  const source = asRecord(profile);
  const raw = source['model'] ?? profile;

  if (typeof raw === 'string') {
    const text = raw.trim();
    const slash = text.indexOf('/');
    if (slash > 0) {
      return { providerId: text.slice(0, slash), modelId: stripApiPrefix(text.slice(slash + 1)) };
    }
    return { modelId: stripApiPrefix(text) };
  }

  const ref = asRecord(raw);
  const providerId = typeof ref['provider'] === 'string' ? ref['provider'].trim() : undefined;
  const modelId = stripApiPrefix(typeof ref['model'] === 'string' ? ref['model'].trim() : '');
  if (modelId === '') {
    throw new Error('profile.model 缺少模型名：写 "provider/model"，或写成 { "model": "..." }');
  }
  const reference: ModelReference = { modelId };
  if (providerId != null && providerId !== '') reference.providerId = providerId;
  return reference;
}

/**
 * 只读凭据库：把已经解析出来的 key 交给 pi-ai 的鉴权解析。
 *
 * **为什么必须这么做**：内置 provider 的 auth 是 `envApiKeyAuth(name, [ENV])`，
 * 它只认**已存凭据**或**环境变量**。而本项目的 key 可能在 `auth.json` 里，
 * 既不进环境、也不进 pi-ai 的凭据库——那样**每个请求都会失败**：
 * `Provider is not configured`，assistant 条目是 `stopReason: "error"`、usage 全 0。
 *
 * 只读：登录/刷新交给 pi-ai 的交互式流程，本项目不写凭据。
 */
export function staticCredentialStore(providerId: string, apiKey: string | undefined): CredentialStore {
  const credential: Credential | undefined =
    apiKey == null || apiKey === '' ? undefined : { type: 'api_key', key: apiKey };
  return {
    read: (id) => Promise.resolve(id === providerId ? credential : undefined),
    list: () =>
      Promise.resolve(
        credential == null ? [] : ([{ providerId, type: credential.type }] as readonly CredentialInfo[]),
      ),
    modify: (_id, fn) => fn(credential),
    delete: () => Promise.resolve(),
  };
}

/** `opencode-go` → `OPENCODE_GO_API_KEY`。 */
export function providerApiKeyEnvName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function builtinProvider(providerId: string): Provider<Api> | undefined {
  if (providerId === 'opencode-go') return opencodeGoProvider() as Provider<Api>;
  if (providerId === 'opencode') return opencodeProvider() as Provider<Api>;
  if (providerId === 'openai') return openaiProvider() as Provider<Api>;
  return undefined;
}

/** 凭据来源，报错时要说清楚试过哪些地方。 */
export interface ApiKeyResolution {
  apiKey: string | undefined;
  source: 'auth.json' | 'environment' | 'placeholder';
}

/**
 * 解析凭据。顺序是存下来的 auth.json → 环境变量；自建端点再允许一个占位 key。
 *
 * `allowPlaceholder` 只对**非内置** provider 打开：内置的是已知的云服务，缺 key
 * 就是配置错误，拿占位 key 去请求只会在网关那边变成一个看不懂的 401。
 */
export function resolveApiKey(
  providerId: string,
  auth: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  allowPlaceholder = false,
): ApiKeyResolution {
  const credential = auth[providerId] as { type?: string; key?: string } | undefined;
  if (credential?.type === 'api_key' && typeof credential.key === 'string') {
    return {
      apiKey: resolveConfigValueOrThrow(credential.key, `auth.json 里 "${providerId}" 的 key`),
      source: 'auth.json',
    };
  }

  const envName = providerApiKeyEnvName(providerId);
  const fromEnv = env[envName];
  if (typeof fromEnv === 'string' && fromEnv !== '') return { apiKey: fromEnv, source: 'environment' };

  if (allowPlaceholder) return { apiKey: 'not-needed', source: 'placeholder' };

  throw new Error(
    `provider "${providerId}" 没有可用凭据。按顺序都试过了：` +
      `auth.json → 环境变量 ${envName}。` +
      `把 key 写进 auth.json（例如 {"${providerId}":{"type":"api_key","key":"$${envName}"}}），` +
      `或在 providers.json 里声明 baseUrl 表示这是自建端点。`,
  );
}

/** 按模型 id 在 providers.json 里找声明它的 provider（引用里没写 provider 时用）。 */
function findProviderByModelId(providers: ProvidersConfig, modelId: string): string | undefined {
  for (const [providerId, config] of Object.entries(providers.providers)) {
    if (config.models?.some((model) => model.id === modelId)) return providerId;
  }
  return undefined;
}

/**
 * 解析 provider 的 header。
 *
 * 与 key 不同，header 解析不出来**只警告不报错**：header 多是可选的请求装饰
 * （会话 id 之类），缺一个就让进程起不来太重。但绝不能一声不响地少发一个
 * header——那会在网关那边变成一个看不出来的 400。
 */
function resolveProviderHeaders(
  headers: Record<string, string> | undefined,
  providerId: string,
): Record<string, string> | null {
  if (headers == null) return null;
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const headerValue = resolveConfigValue(value);
    if (headerValue === undefined) {
      console.warn(
        `providers.json 里 provider "${providerId}" 的 header "${name}" 解析不出来（${value}）；` +
          `对应的环境变量没设置，这一条不会发出。`,
      );
      continue;
    }
    resolved[name] = headerValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
}

/** 模型定义 / 覆写 → pi-ai 的 `Model`。目录里没有这个 id 时用它现造一个。 */
function modelFromDefinition(
  providerId: string,
  definition: ModelDefinition,
  providerBaseUrl: string | undefined,
  providerApi: string | undefined,
  overrides: ModelOverride | undefined,
): Model<Api> {
  const baseUrl = definition.baseUrl ?? overrides?.baseUrl ?? providerBaseUrl;
  const api = (definition.api ?? overrides?.api ?? providerApi ?? 'openai-completions') as Api;
  const contextWindow = definition.contextWindow ?? overrides?.contextWindow;
  return {
    id: definition.id,
    name: definition.name ?? overrides?.name ?? definition.id,
    api,
    provider: providerId,
    ...(baseUrl != null ? { baseUrl } : {}),
    input: (definition.input ?? overrides?.input ?? ['text', 'image']) as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: definition.reasoning ?? overrides?.reasoning ?? false,
    contextWindow:
      contextWindow != null && Number.isFinite(contextWindow) && contextWindow > 0
        ? contextWindow
        : FALLBACK_CONTEXT_WINDOW,
    maxTokens:
      definition.maxTokens ?? overrides?.maxTokens ?? FALLBACK_MAX_TOKENS,
    ...(definition.samplingParams != null ? { samplingParams: definition.samplingParams } : {}),
  } as Model<Api>;
}

/** 把 providers.json 里的字段叠到一个已有模型上（窗口、maxTokens、采样参数、名字）。 */
function applyModelFields(base: Model<Api>, fields: ModelDefinition | ModelOverride | undefined): Model<Api> {
  if (fields == null) return base;
  const merged: Model<Api> = { ...base };
  if (fields.name != null) merged.name = fields.name;
  if (fields.reasoning != null) merged.reasoning = fields.reasoning;
  if (fields.contextWindow != null) merged.contextWindow = fields.contextWindow;
  if (fields.maxTokens != null) merged.maxTokens = fields.maxTokens;
  if (fields.input != null) merged.input = fields.input;
  if (fields.samplingParams != null) merged.samplingParams = fields.samplingParams;
  if (fields.headers != null) merged.headers = { ...merged.headers, ...fields.headers };
  return merged;
}

/**
 * 把 profile 解析成可用的 pi-ai `Models` 集合与具体 `Model`。
 *
 * 任何一步失败都抛错（配置错误必须能被看见，见 `ConfigError`）。
 */
export function resolveProvider(profile: unknown, options: ResolveProviderOptions = {}): ResolvedProvider {
  const reference = readModelReference(profile);
  const providersPath = options.providersPath ?? DEFAULT_PROVIDERS_PATH;
  const authPath = options.authPath ?? DEFAULT_AUTH_PATH;
  const providersConfig = loadProvidersConfig(providersPath);
  const auth = loadAuthConfig(authPath) as Record<string, unknown>;

  const providerId = reference.providerId ?? findProviderByModelId(providersConfig, reference.modelId);
  if (providerId == null) {
    const known = Object.values(providersConfig.providers).flatMap(
      (config) => config.models?.map((model) => model.id) ?? [],
    );
    throw new Error(
      `模型 "${reference.modelId}" 找不到：profile 里没写 provider，providers.json 里也没有声明它。` +
        (known.length > 0 ? `已声明的模型：${known.join('、')}。` : '写 "provider/model" 明确指定。'),
    );
  }

  const providerConfig = providersConfig.providers[providerId];
  const builtin = builtinProvider(providerId);
  if (builtin == null && providerConfig == null) {
    throw new Error(
      `未知 provider "${providerId}"：既不是内置供应商（opencode-go、opencode、openai），` +
        `也没在 providers.json 里声明。`,
    );
  }

  const { apiKey } = resolveApiKey(providerId, auth, process.env, builtin == null);
  const headers = resolveProviderHeaders(providerConfig?.headers, providerId);
  const declared = providerConfig?.models?.find((model) => model.id === reference.modelId);
  const overrides = providerConfig?.modelOverrides?.[reference.modelId];

  const models = createModels({ credentials: staticCredentialStore(providerId, apiKey) });
  if (builtin != null) {
    models.setProvider(builtin);
  } else {
    if (providerConfig?.baseUrl == null && declared?.baseUrl == null) {
      throw new Error(
        `provider "${providerId}" 既不是内置供应商，也没在 providers.json 里声明 baseUrl。` +
          `内置的有：opencode-go、opencode、openai。`,
      );
    }
    models.setProvider(
      createProvider({
        id: providerId,
        name: providerConfig?.name ?? providerId,
        baseUrl: (providerConfig?.baseUrl ?? declared?.baseUrl) as string,
        auth: { apiKey: envApiKeyAuth(providerApiKeyEnvName(providerId), [providerApiKeyEnvName(providerId)]) },
        models: (providerConfig?.models ?? []).map((definition) =>
          modelFromDefinition(providerId, definition, providerConfig?.baseUrl, providerConfig?.api, overrides),
        ),
        api: { 'openai-completions': openAICompletionsApi() },
      }),
    );
  }

  const fromCatalog = models.getModel(providerId, reference.modelId);
  const modelInstance =
    fromCatalog != null
      ? applyModelFields(fromCatalog, overrides ?? declared)
      : declared != null
        ? modelFromDefinition(providerId, declared, providerConfig?.baseUrl, providerConfig?.api, overrides)
        : undefined;

  if (modelInstance == null) {
    const available = models
      .getModels(providerId)
      .map((model) => model.id)
      .slice(0, 20);
    throw new Error(
      `模型 "${providerId}/${reference.modelId}" 不存在。` +
        (available.length > 0
          ? `该 provider 已知的模型：${available.join('、')}${available.length === 20 ? ' …' : ''}。`
          : '该 provider 没有已知模型，请在 providers.json 里用 models 声明。'),
    );
  }

  const model = applyModelFields(modelInstance, {
    ...(declared ?? {}),
    ...(overrides ?? {}),
  } as ModelOverride);

  const params: Record<string, unknown> = {
    ...(declared?.samplingParams ?? {}),
    ...(overrides?.samplingParams ?? {}),
  };

  return {
    models,
    model: model as Model<Api>,
    providerId,
    apiKey,
    headers,
    contextWindow: model.contextWindow,
    params,
  };
}

/** 供诊断：这个 profile 会用哪个 provider / 模型。 */
export function describeProvider(profile: unknown): {
  providerId: string;
  modelId: string;
  contextWindow: number;
} {
  const resolved = resolveProvider(profile);
  return {
    providerId: resolved.providerId,
    modelId: resolved.model.id,
    contextWindow: resolved.contextWindow,
  };
}

/** 诊断用：解析配置值（`$ENV` / `!command`）。 */
export { resolveConfigValue };
