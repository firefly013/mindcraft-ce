/**
 * 配置文件的三份 schema：`providers.json` / `auth.json` / `profiles/*.json`。
 *
 * 形状照搬 Pi（`packages/coding-agent`）：供应商端点与模型一份、凭据一份、
 * 每个 agent 的行为一份。与 Pi 的差别只有一处：Pi 把它们放在 agent 目录下，
 * 我们放在仓库根，因为本项目是"一个仓库跑多个 bot"。
 *
 * **未知字段一律报错**（`additionalProperties: false`）：配置写错一个键名，
 * 必须在启动时炸出来，而不是静默当成默认值。
 */
import { type Static, Type } from 'typebox';
import { Compile } from 'typebox/compile';

const PositiveTokenCount = Type.Number({
  exclusiveMinimum: 0,
  description: 'Token 数，必须为正。',
});

const SamplingParams = Type.Record(Type.String(), Type.Unknown(), {
  description: '原样进请求体的采样参数（temperature、thinking…）。',
});

const ModelFields = {
  name: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1, description: "pi-ai 的 api 名，默认 openai-completions。" })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  contextWindow: Type.Optional(PositiveTokenCount),
  maxTokens: Type.Optional(PositiveTokenCount),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal('text'), Type.Literal('image')]))),
  samplingParams: Type.Optional(SamplingParams),
  samplingParamsByThinkingLevel: Type.Optional(Type.Record(Type.String(), SamplingParams)),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
} as const;

/** `providers.json` 里声明的一个模型。 */
const ModelDefinitionSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    ...ModelFields,
  },
  { additionalProperties: false, description: '端点上的一个模型。' },
);

/** 覆写内置目录里已有模型的那部分字段（都可选）。 */
const ModelOverrideSchema = Type.Object(ModelFields, {
  additionalProperties: false,
  description: '按 id 覆写内置目录里的模型。',
});

/** 一个供应商（端点）。 */
const ProviderConfigSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    baseUrl: Type.Optional(Type.String({ minLength: 1, description: '端点地址。' })),
    api: Type.Optional(Type.String({ minLength: 1 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    models: Type.Optional(Type.Array(ModelDefinitionSchema)),
    modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
  },
  { additionalProperties: false, description: '一个 OpenAI 兼容端点（或 pi-ai 内置供应商）的配置。' },
);

export const ProvidersConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    providers: Type.Record(Type.String(), ProviderConfigSchema, {
      description: 'providerId → 供应商配置。',
    }),
  },
  { additionalProperties: false },
);

/** `auth.json` 里的一条凭据。 */
const CredentialSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal('api_key'),
        key: Type.Optional(Type.String({ description: '支持字面量、$ENV / ${ENV}、以及 !command。' })),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal('oauth'),
        access: Type.String(),
        refresh: Type.String(),
        expires: Type.Number(),
      },
      { additionalProperties: false },
    ),
  ],
  { description: '每个 provider 一条凭据。' },
);

/** `profiles/*.json`：一个 bot 的身份、用哪个模型、提示词与行为。 */
const ModelReferenceSchema = Type.Union(
  [
    Type.String({ minLength: 1, description: '"provider/model"。' }),
    Type.Object(
      {
        provider: Type.Optional(Type.String({ minLength: 1 })),
        model: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false, description: '对象形式：指定 provider 和 model。' },
    ),
  ],
  { description: '模型引用："provider/model" 或对象形式。' },
);

const CompactionSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    reserveTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    keepRecentTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    backgroundTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false, description: '上下文压缩参数。缺省用 pi-durable 的默认值。' },
);

const PromptOverridesSchema = Type.Object(
  {
    conversing: Type.Optional(Type.String()),
    saving_memory: Type.Optional(Type.String()),
    saving_memory_update: Type.Optional(Type.String()),
    summary_system: Type.Optional(Type.String()),
  },
  { additionalProperties: false, description: '逐条覆写提示词模板。' },
);

export const ProfileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    name: Type.String({
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'bot 名，同时是 bots/<name>/ 的目录名。',
    }),
    model: ModelReferenceSchema,
    compaction: Type.Optional(CompactionSchema),
    promptSet: Type.Optional(Type.String({ minLength: 1, description: '提示词集名，默认 default。' })),
    prompts: Type.Optional(PromptOverridesSchema),
    skin: Type.Optional(
      Type.Object(
        { model: Type.String(), path: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const CREDENTIAL_SCHEMA = CredentialSchema;

/** `auth.json` 的整体形状（生成 JSON Schema 用；校验在 `load.ts` 里逐条做）。 */
export const AUTH_CONFIG_SCHEMA = Type.Record(Type.String(), CredentialSchema, {
  description: 'providerId → 凭据。顶层允许一个 $schema。',
});

/** 生成 JSON Schema 用的原始定义。 */
export const PROVIDERS_CONFIG_SCHEMA = ProvidersConfigSchema;
export const PROFILE_SCHEMA = ProfileSchema;

export const MODEL_DEFINITION_SCHEMA = ModelDefinitionSchema;

export const PROFILE_VALIDATOR = Compile(ProfileSchema);
export const PROVIDERS_VALIDATOR = Compile(ProvidersConfigSchema);
export const CREDENTIAL_VALIDATOR = Compile(CredentialSchema);

export type ProvidersConfig = Static<typeof ProvidersConfigSchema>;
export type ProviderConfig = Static<typeof ProviderConfigSchema>;
export type ModelDefinition = Static<typeof ModelDefinitionSchema>;
export type ModelOverride = Static<typeof ModelOverrideSchema>;
export type Profile = Static<typeof ProfileSchema>;
export type ModelReference = Static<typeof ModelReferenceSchema>;
export type Credential = Static<typeof CredentialSchema>;
export type AuthConfig = Record<string, Credential>;
