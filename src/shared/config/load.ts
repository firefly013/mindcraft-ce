/**
 * 配置文件的读取与校验。
 *
 * 规矩（与 Pi 一致，但严格一档）：**解析或校验失败一律抛 `ConfigError`**，
 * 由调用方决定是退出进程（CLI 启动）还是回给 UI（网页上传 profile）。
 * 不做"写错了就取默认值"这种事——配置错误必须能被看见。
 *
 * 文件分工：
 *   - `providers.json`  供应商端点与模型
 *   - `auth.json`    凭据（每个 provider 一条）
 *   - `profiles/*.json`  一个 bot 的身份、模型引用、提示词与行为
 *
 * 三份都是手写配置，都允许 `//` 注释（JSONC）。`SETTINGS_JSON` 环境变量仍是严格 JSON。
 */
import { readFileSync } from 'node:fs';
import type { TLocalizedValidationError } from 'typebox/error';
import { stripBom, stripJsonComments } from './json.js';
import {
  CREDENTIAL_VALIDATOR,
  PROVIDERS_VALIDATOR,
  PROFILE_VALIDATOR,
  type AuthConfig,
  type Credential,
  type ProvidersConfig,
  type Profile,
} from './schema.js';

/** 一份配置文件加载失败。`issues` 每条都是给人和编辑器看的一行。 */
export class ConfigError extends Error {
  readonly file: string;
  readonly issues: readonly string[];

  constructor(file: string, issues: readonly string[], options?: ErrorOptions) {
    super(`${file}:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`, options);
    this.name = 'ConfigError';
    this.file = file;
    this.issues = issues;
  }
}

/** 默认路径：与 settings.ts 同级，放在仓库根。 */
export const DEFAULT_PROVIDERS_PATH = './providers.json';
export const DEFAULT_AUTH_PATH = './auth.json';

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === 'required') {
    const required = (error.params as { requiredProperties?: string[] } | undefined)?.requiredProperties;
    const first = required?.[0];
    if (first) {
      const base = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
      return base ? `${base}.${first}` : first;
    }
  }
  const path = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
  return path || '(根)';
}

/** 校验错误 → 一行一条：`字段路径: 原因`。 */
function formatIssues(errors: readonly TLocalizedValidationError[]): string[] {
  return errors.map((error) => `${formatValidationPath(error)}: ${error.message}`);
}

/**
 * 读一个文件。文件不存在返回 undefined；读不动（权限等）抛 `ConfigError`。
 *
 * "不存在"与"读不了"必须分开：前者是合法的默认（没有 providers.json 就用内置
 * 目录），后者是环境问题，不能当默认吞掉。
 */
function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(path, [`读取失败：${(error as NodeJS.ErrnoException).message}`], {
      cause: error,
    });
  }
}

/** 读一个必须存在的文件；不存在也抛 `ConfigError`。 */
export function readRequiredFile(path: string): string {
  const content = readOptionalFile(path);
  if (content === undefined) throw new ConfigError(path, ['文件不存在']);
  return content;
}

/** JSON / JSONC → 值。语法错误抛 `ConfigError`，带上解析器给的行列。 */
export function parseJsonFile(path: string, content: string, allowComments = false): unknown {
  const text = allowComments ? stripJsonComments(stripBom(content)) : stripBom(content);
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    // `JSON.parse` 只会抛 SyntaxError（一定是 Error），所以直接读 message。
    throw new ConfigError(path, [`JSON 解析失败：${(error as Error).message}`], {
      cause: error,
    });
  }
}

/** 校验一个 profile 值（网页上传的 profile 也走这里）。 */
export function validateProfile(value: unknown, file = '<profile>'): Profile {
  if (!PROFILE_VALIDATOR.Check(value)) {
    throw new ConfigError(file, formatIssues(PROFILE_VALIDATOR.Errors(value)));
  }
  return value;
}

/** 读并校验 `profiles/*.json`。文件不存在也算错：列在 settings.profiles 里的路径必须是实的。 */
export function loadProfile(path: string): Profile {
  return validateProfile(parseJsonFile(path, readRequiredFile(path), true), path);
}

/** 读 `providers.json`。文件不存在 = 没有自定义供应商（内置目录仍可用）。 */
export function loadProvidersConfig(path: string = DEFAULT_PROVIDERS_PATH): ProvidersConfig {
  const content = readOptionalFile(path);
  if (content === undefined) return { providers: {} };
  const parsed = parseJsonFile(path, content, true);
  if (!PROVIDERS_VALIDATOR.Check(parsed)) {
    throw new ConfigError(path, formatIssues(PROVIDERS_VALIDATOR.Errors(parsed)));
  }
  return parsed;
}

/**
 * 读 `auth.json`。文件不存在 = 没有存下来的凭据（还有环境变量这条路）。
 *
 * 形状是 `providerId → 凭据`。允许一个顶层 `$schema`（编辑器补全用），
 * 它不是 provider，读完就丢掉。
 */
export function loadAuthConfig(path: string = DEFAULT_AUTH_PATH): AuthConfig {
  const content = readOptionalFile(path);
  if (content === undefined) return {};
  const parsed = parseJsonFile(path, content, true);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(path, ['顶层必须是一个对象：providerId → 凭据']);
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const credentials: AuthConfig = {};
  const issues: string[] = [];
  for (const [providerId, credential] of entries) {
    if (providerId === '$schema') continue;
    if (!CREDENTIAL_VALIDATOR.Check(credential)) {
      for (const issue of formatIssues(CREDENTIAL_VALIDATOR.Errors(credential))) {
        issues.push(`${providerId}.${issue}`);
      }
      continue;
    }
    credentials[providerId] = credential as Credential;
  }
  if (issues.length > 0) throw new ConfigError(path, issues);
  return credentials;
}
