import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { AgentProfile, AIModel } from '../types/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Constructor shared by every model wrapper (matches `new apiMap[api](model, url, params)`). */
export type ModelConstructor = new (
  model_name: string | null,
  url?: string,
  params?: Record<string, unknown>,
) => AIModel;

// Dynamically discover model classes in a directory.
// Each model class must export a static `prefix` string.
/**
 * 扫描一个目录里的模型模块，收集带静态 `prefix` 的构造函数。
 * 目录可注入：单测用临时目录，不必往 `src/models` 里写探针文件。
 * 单个模块加载失败只 warn，不影响其它供应商。
 */
export async function discoverModels(dir: string): Promise<Record<string, ModelConstructor>> {
  const map: Record<string, ModelConstructor> = {};
  const files = (await fs.readdir(dir)).filter(
    // Source tree holds `.ts`, compiled `dist` holds `.js`; accept both so
    // model discovery works under `tsx` and from a `tsc` build alike.
    (f) =>
      (f.endsWith('.js') || f.endsWith('.ts')) &&
      f !== '_model_map.js' &&
      f !== '_model_map.ts' &&
      f !== 'prompter.js' &&
      f !== 'prompter.ts',
  );
  for (const file of files) {
    try {
      const moduleUrl = pathToFileURL(path.join(dir, file)).href;
      const mod = (await import(moduleUrl)) as Record<string, unknown>;
      for (const exported of Object.values(mod)) {
        if (typeof exported === 'function' && Object.prototype.hasOwnProperty.call(exported, 'prefix')) {
          const prefix = (exported as unknown as { prefix?: unknown }).prefix;
          if (typeof prefix === 'string' && prefix.length > 0) {
            map[prefix] = exported as unknown as ModelConstructor;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load model module:', file, e instanceof Error ? e.message : String(e));
    }
  }
  return map;
}

const apiMap: Record<string, ModelConstructor> = await discoverModels(__dirname);

export function selectAPI(profile: AgentProfile | string): AgentProfile {
  // `profile` may be a bare model string; normalize it into a minimal profile.
  // (`as AgentProfile` because `name` is filled in later by Prompter defaults.)
  let prof: AgentProfile;
  if (typeof profile === 'string' || profile instanceof String) {
    prof = { model: String(profile) } as AgentProfile;
  } else {
    prof = profile;
  }
  if (!prof.api) {
    // 只剩一个 OpenAI 兼容供应商：显式前缀命中就用它，否则一律当它。
    // 模型名不再需要供应商前缀（"gpt-5.4"、"deepseek-v4.1-flash" 都走同一个适配器），
    // 去哪儿由 profile 的 `url` 决定。
    prof.api = Object.keys(apiMap).find((key) => prof.model?.startsWith(key)) ?? 'openai';
  }
  if (!apiMap[prof.api]) {
    throw new Error('Unknown api: ' + String(prof.api));
  }
  // 只剥**开头**的 `api/`：`replace` 会吃掉串中间的 "openai/"
  // （"my-openai/proxy" → "my-proxy"），那不是前缀。
  const raw = typeof prof.model === 'string' ? prof.model : '';
  const model_name = raw.startsWith(prof.api + '/') ? raw.slice(prof.api.length + 1) : raw;
  // `AgentProfile.model` is typed `string`, but the runtime uses `null` for
  // "no specific model" (default model of that api); assert through unknown.
  (prof as unknown as { model: string | null }).model = model_name === '' ? null : model_name; // if model is empty, set to null
  return prof;
}

export function createModel(profile: AgentProfile): AIModel {
  const modelKey = profile.model as unknown as string | null;
  if (modelKey != null && !!apiMap[modelKey]) {
    // if the model value is an api (instead of a specific model name)
    // then set model to null so it uses the default model for that api
    (profile as unknown as { model: string | null }).model = null;
  }
  if (!profile.api || !apiMap[profile.api]) {
    throw new Error('Unknown api: ' + String(profile.api));
  }
  const model = new apiMap[profile.api](
    profile.model as unknown as string | null,
    profile.url,
    profile.params,
  );
  return model;
}
