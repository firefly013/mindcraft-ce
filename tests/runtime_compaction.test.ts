/**
 * 压缩接线：profile → `CompactionPolicy`，以及那个 8.7 倍阈值 bug。
 *
 * 旧实现 `resolveContextWindow()` 读不到 `profile.context_window` 就回退
 * `128_000`，触发线成了 `115_200`；而 OpenCode Go 的 `deepseek-v4.1-flash`
 * 真实窗口是 `1_000_000`。这里把它钉死：**窗口只来自模型定义**（内置目录或
 * `providers.json`），profile 顶层的 `context_window` 已经不存在了。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import {
  DEFAULT_BACKGROUND_TOKENS,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  compactionPolicyFromProfile,
  compactionTriggerTokens,
} from '../src/brain/runtime/compaction.js';
import { readModelReference, resolveProvider } from '../src/brain/runtime/provider.js';
import type { ResolvedProvider } from '../src/brain/runtime/provider.js';
import { openBotRuntime } from '../src/brain/runtime/runtime.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-comp-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir == null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄 */
    }
  }
});

/**
 * 生产 profile 的形状。
 *
 * 窗口不再写在 profile 里：`opencode-go/deepseek-v4.1-flash` 的 1_000_000
 * 来自 pi-ai 的内置目录；自建端点则来自 `providers.json` 的模型定义。
 */
const PRODUCTION_PROFILE = {
  name: 'opencode',
  model: 'opencode-go/deepseek-v4.1-flash',
  compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
};

/** 写一份临时 providers.json + auth.json：内置 provider 也要有 key 才能解析。 */
function configPaths(): { providersPath: string; authPath: string } {
  const dir = tempDir();
  const providersPath = join(dir, 'providers.json');
  const authPath = join(dir, 'auth.json');
  writeFileSync(
    providersPath,
    JSON.stringify({ providers: { 'opencode-go': { baseUrl: 'https://opencode.ai/zen/go/v1' } } }),
    'utf8',
  );
  writeFileSync(authPath, JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'sk-test' } }), 'utf8');
  return { providersPath, authPath };
}

describe('profile → CompactionPolicy', () => {
  it('空 profile 落回 pi-durable 的内置默认', () => {
    expect(compactionPolicyFromProfile(undefined)).toEqual({
      enabled: true,
      reserveTokens: DEFAULT_RESERVE_TOKENS,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      backgroundTokens: DEFAULT_BACKGROUND_TOKENS,
    });
  });

  it('生产 profile 的三个字段被正确读出', () => {
    const policy = compactionPolicyFromProfile(PRODUCTION_PROFILE);
    expect(policy).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: DEFAULT_BACKGROUND_TOKENS,
    });
  });

  it('非法值落回默认；compaction.enabled:false 关掉自动上下文压缩', () => {
    const policy = compactionPolicyFromProfile({
      compaction: {
        reserveTokens: -1,
        keepRecentTokens: 'nope',
        backgroundTokens: Number.NaN,
        enabled: false,
      },
    });
    expect(policy.enabled).toBe(false);
    expect(policy.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
    expect(policy.keepRecentTokens).toBe(DEFAULT_KEEP_RECENT_TOKENS);
    expect(policy.backgroundTokens).toBe(DEFAULT_BACKGROUND_TOKENS);
  });
});

describe('8.7 倍阈值 bug', () => {
  it('触发线用**模型目录**的窗口，不是回退值', () => {
    const resolved = resolveProvider(PRODUCTION_PROFILE, configPaths());
    // 内置目录给出真实窗口
    expect(resolved.contextWindow).toBe(1_000_000);

    const policy = compactionPolicyFromProfile(PRODUCTION_PROFILE);
    const fixed = compactionTriggerTokens(resolved.contextWindow, policy);
    expect(fixed).toBe(983_616);

    // 旧实现的错误触发线：128_000 回退 − 90% 压力线
    const legacy = 128_000 * 0.9;
    expect(legacy).toBe(115_200);

    // 差距就是那个 8.7 倍
    expect(fixed / legacy).toBeGreaterThan(8);
    expect(fixed / legacy).toBeLessThan(9);
  });
});

describe('模型的窗口从哪来', () => {
  it('引用形式：窗口由 provider 侧决定，profile 不再有 context_window', () => {
    expect(readModelReference(PRODUCTION_PROFILE).modelId).toBe('deepseek-v4.1-flash');
    expect(PRODUCTION_PROFILE).not.toHaveProperty('context_window');
  });

  it('对象形式只读 provider/model，不覆写窗口', () => {
    const reference = readModelReference({ model: { provider: 'x', model: 'x' } });
    expect(reference).toEqual({ providerId: 'x', modelId: 'x' });
  });

  it('自建端点的窗口来自 providers.json 的模型定义', () => {
    const dir = tempDir();
    const providersPath = join(dir, 'providers.json');
    const authPath = join(dir, 'auth.json');
    writeFileSync(
      providersPath,
      JSON.stringify({
        providers: {
          local: { baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'local-model', contextWindow: 32_000 }] },
        },
      }),
      'utf8',
    );
    writeFileSync(authPath, '{}', 'utf8');

    const resolved = resolveProvider({ model: 'local/local-model' }, { providersPath, authPath });
    expect(resolved.providerId).toBe('local');
    expect(resolved.contextWindow).toBe(32_000);
  });
});

describe('真集成：小窗口 + 长对话 → 上下文压缩触发', () => {
  it('超过 contextWindow - reserveTokens 后出现上下文压缩 entry', async () => {
    const faux = fauxProvider({ models: [{ id: 'mc-test', contextWindow: 300 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel('mc-test') ?? faux.getModel();
    const provider: ResolvedProvider = {
      models,
      model,
      providerId: faux.provider.id,
      apiKey: undefined,
      headers: null,
      params: {},
      contextWindow: model.contextWindow,
    };
    expect(provider.contextWindow).toBe(300);

    faux.setResponses([
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
      fauxAssistantMessage('嗯。'),
    ]);

    const runtime = await openBotRuntime({
      name: 'tester',
      provider,
      baseDir: tempDir(),
      systemPrompt: () => 'SYS',
      liveTail: () => '',
      compaction: {
        enabled: true,
        reserveTokens: 20,
        keepRecentTokens: 50,
        backgroundTokens: 0,
      },
    });

    const long = '这是一段很长的上下文填充文本用来把估算 token 推过上下文压缩触发线。'.repeat(8);
    for (let i = 0; i < 3; i++) {
      await (await runtime.submit(`${long} 第${i}条`)).wait(ctx);
    }

    const page = await runtime.conversation.entries({}, 100, undefined, ctx);
    const kinds = page.items.map((entry) => entry.kind);

    // 上下文压缩 entry 的 kind 是 pi.compaction；每次上下文压缩会额外打一次模型做总结，
    // 所以模型调用次数会多于提交次数。
    expect(kinds.some((kind) => kind.includes('compaction'))).toBe(true);
    expect(faux.state.callCount).toBeGreaterThan(3);
    await runtime.close();
  });
});
