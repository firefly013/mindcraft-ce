/**
 * 配置值解析：`$ENV` / `${ENV}` / `!command`。
 *
 * 照搬 Pi 的 `core/resolve-config-value.ts`（`github.com/earendil-works/pi`，
 * `packages/coding-agent`）。我们只留本项目用得上的表面：`providers.json` 里的
 * `headers`，以及 `auth.json` 里凭据的 `key`。
 *
 * 语义（与 Pi 一致）：
 *   - 以 `!` 开头 → 执行后面的命令，取 stdout（**进程级缓存**，10 秒超时）；
 *   - `$NAME` / `${NAME}` → 环境变量，任何一个缺失就让整个值变成 undefined；
 *   - 非命令值里 `$$` 是字面 `$`，`$!` 是字面 `!`；
 *   - 其余当字面量。
 */
import { execSync } from 'node:child_process';

/** 命令结果的进程级缓存（与 Pi 相同：一个进程只跑一次）。 */
const commandResultCache = new Map<string, string | undefined>();
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: 'literal'; value: string } | { type: 'env'; name: string };
type ConfigValueReference = { type: 'command'; config: string } | { type: 'template'; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === 'literal') {
    previous.value += value;
    return;
  }
  parts.push({ type: 'literal', value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;

  while (index < config.length) {
    const dollarIndex = config.indexOf('$', index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }

    appendLiteral(parts, config.slice(index, dollarIndex));
    const nextChar = config[dollarIndex + 1];

    if (nextChar === '$' || nextChar === '!') {
      appendLiteral(parts, nextChar);
      index = dollarIndex + 2;
      continue;
    }

    if (nextChar === '{') {
      const endIndex = config.indexOf('}', dollarIndex + 2);
      if (endIndex < 0) {
        appendLiteral(parts, '$');
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: 'env', name });
      else appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
      index = endIndex + 1;
      continue;
    }

    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match) {
      parts.push({ type: 'env', name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }

    appendLiteral(parts, '$');
    index = dollarIndex + 1;
  }

  return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
  if (config.startsWith('!')) return { type: 'command', config };
  return { type: 'template', parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
  return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
  const names: string[] = [];
  for (const part of parts) {
    if (part.type !== 'env' || names.includes(part.name)) continue;
    names.push(part.name);
  }
  return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
  let resolved = '';
  for (const part of parts) {
    if (part.type === 'literal') {
      resolved += part.value;
      continue;
    }
    const envValue = resolveEnvConfigValue(part.name, env);
    if (envValue === undefined) return undefined;
    resolved += envValue;
  }
  return resolved;
}

/** 值是 `!命令` 吗？ */
export function isCommandConfigValue(config: string): boolean {
  return parseConfigValueReference(config).type === 'command';
}

/** 值里引用了哪些环境变量（命令式返回空数组）。 */
export function getConfigValueEnvVarNames(config: string): string[] {
  const reference = parseConfigValueReference(config);
  return reference.type === 'template' ? getTemplateEnvVarNames(reference.parts) : [];
}

/** 这些环境变量是不是都齐了。 */
export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
  return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

function executeCommandUncached(commandConfig: string): string | undefined {
  const command = commandConfig.slice(1);
  try {
    // `execSync` 带字符串命令时自己起系统 shell（Windows 上是 cmd.exe，其它平台 /bin/sh）。
    // 本项目没有 shell 配置项，Pi 那套"优先用配置里的 shell"不需要。
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executeCommand(commandConfig: string): string | undefined {
  if (commandResultCache.has(commandConfig)) return commandResultCache.get(commandConfig);
  const result = executeCommandUncached(commandConfig);
  commandResultCache.set(commandConfig, result);
  return result;
}

/** 解析一个配置值。解析不出来返回 undefined。 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
  const reference = parseConfigValueReference(config);
  if (reference.type === 'command') return executeCommand(reference.config);
  return resolveTemplate(reference.parts, env);
}

/**
 * 解析一个配置值，失败就抛**说清楚是什么失败**的错误。
 *
 * 与 Pi 一致：命令式报命令、环境变量式报缺哪个变量。配置错误必须能被看见。
 *
 * 走到最后一行时至少有一个环境变量是缺的：模板返回 undefined 的**唯一**原因是
 * 引用了取不到值的变量（命令式在上面已经拦掉了）。
 */
export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
  const value = resolveConfigValue(config, env);
  if (value !== undefined) return value;

  const reference = parseConfigValueReference(config);
  if (reference.type === 'command') {
    throw new Error(`无法从命令解析${description}：${reference.config.slice(1)}`);
  }
  const missing = getMissingConfigValueEnvVarNames(config, env);
  throw new Error(`无法解析${description}：环境变量 ${missing.join('、')} 未设置`);
}

/** 清命令结果缓存（测试用）。 */
export function clearConfigValueCache(): void {
  commandResultCache.clear();
}
