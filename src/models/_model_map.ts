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

// Dynamically discover model classes in this directory.
// Each model class must export a static `prefix` string.
const apiMap: Record<string, ModelConstructor> = await (async (): Promise<
  Record<string, ModelConstructor>
> => {
  const map: Record<string, ModelConstructor> = {};
  const files = (await fs.readdir(__dirname)).filter(
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
      const moduleUrl = pathToFileURL(path.join(__dirname, file)).href;
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
})();

export function selectAPI(profile: AgentProfile | string): AgentProfile {
  // `profile` may be a bare model string; normalize it into a minimal profile.
  // (`as AgentProfile` because `name` is filled in later by Prompter defaults.)
  let prof: AgentProfile;
  if (typeof profile === 'string' || profile instanceof String) {
    prof = { model: String(profile) } as AgentProfile;
  } else {
    prof = profile;
  }
  // backwards compatibility with local->ollama
  if (prof.api?.includes('local') || prof.model?.includes('local')) {
    prof.api = 'ollama';
    if (prof.model) {
      prof.model = prof.model.replace('local', 'ollama');
    }
  }
  if (!prof.api) {
    const api = Object.keys(apiMap).find((key) => prof.model?.startsWith(key));
    if (api) {
      prof.api = api;
    } else {
      // check for some common models that do not require prefixes
      if (prof.model.includes('gpt') || prof.model.includes('o1') || prof.model.includes('o3'))
        prof.api = 'openai';
      else if (prof.model.includes('claude')) prof.api = 'anthropic';
      else if (prof.model.includes('gemini')) prof.api = 'google';
      else if (prof.model.includes('grok')) prof.api = 'xai';
      else if (prof.model.includes('mistral')) prof.api = 'mistral';
      else if (prof.model.includes('deepseek')) prof.api = 'deepseek';
      else if (prof.model.includes('qwen')) prof.api = 'qwen';
    }
    if (!prof.api) {
      throw new Error('Unknown model: ' + String(prof.model));
    }
  }
  if (!apiMap[prof.api]) {
    throw new Error('Unknown api: ' + String(prof.api));
  }
  const model_name = prof.model.replace(prof.api + '/', ''); // remove prefix
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
