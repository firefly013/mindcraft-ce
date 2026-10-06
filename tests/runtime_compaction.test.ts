/**
 * 压缩接线：profile → `CompactionPolicy`，以及那个 8.7 倍阈值 bug。
 *
 * 旧实现 `resolveContextWindow()` 读不到 `profile.context_window` 就回退
 * `128_000`，触发线成了 `115_200`；而 OpenCode Go 的 `deepseek-v4.1-flash`
 * 真实窗口是 `1_000_000`。这里把它钉死。
 */
import { mkdtempSync, rmSync } from 'node:fs';
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
} from '../src/runtime/compaction.js';
import { readProfileModel, resolveProvider } from '../src/runtime/provider.js';
import type { ResolvedProvider } from '../src/runtime/provider.js';
import { openBotRuntime } from '../src/runtime/runtime.js';

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

/** 生产 profile 的形状（主线给 opencode.json 加的那三个字段）。 */
const PRODUCTION_PROFILE = {
  name: 'opencode',
  context_window: 1_000_000,
  reserve_tokens: 16_384,
  keep_recent_tokens: 20_000,
  model: {
    api: 'openai',
    model: 'deepseek-v4.1-flash',
    url: 'https://opencode.ai/zen/go/v1',
    params: { api_key_env: 'OPENCODE_API_KEY' },
  },
};

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

  it('非法值落回默认；compaction_enabled:false 关掉自动压仓', () => {
    const policy = compactionPolicyFromProfile({
      reserve_tokens: -1,
      keep_recent_tokens: 'nope',
      background_tokens: Number.NaN,
      compaction_enabled: false,
    });
    expect(policy.enabled).toBe(false);
    expect(policy.reserveTokens).toBe(DEFAULT_RESERVE_TOKENS);
    expect(policy.keepRecentTokens).toBe(DEFAULT_KEEP_RECENT_TOKENS);
    expect(policy.backgroundTokens).toBe(DEFAULT_BACKGROUND_TOKENS);
  });
});

describe('8.7 倍阈值 bug', () => {
  it('触发线用**模型目录**的窗口，不是 profile 的回退值', () => {
    const resolved = resolveProvider(PRODUCTION_PROFILE);
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

describe('自定义端点的窗口声明', () => {
  it('profile 顶层的 context_window 会被读到（主线写在顶层）', () => {
    expect(readProfileModel(PRODUCTION_PROFILE).contextWindow).toBe(1_000_000);
  });

  it('model 内层与 params 里也认', () => {
    expect(readProfileModel({ model: { model: 'x', context_window: 4096 } }).contextWindow).toBe(4096);
    expect(
      readProfileModel({ model: { model: 'x', params: { context_window: 8192 } } }).contextWindow,
    ).toBe(8192);
  });

  it('自定义端点据此合成模型窗口，而不是永远回退 128_000', () => {
    const resolved = resolveProvider({
      model: { model: 'local-model', url: 'http://127.0.0.1:1/v1', params: { api_key_env: 'MISSING' } },
      context_window: 32_000,
    });
    expect(resolved.providerId).toBe('custom');
    expect(resolved.contextWindow).toBe(32_000);
  });
});

describe('真集成：小窗口 + 长对话 → 压仓触发', () => {
  it('超过 contextWindow - reserveTokens 后出现压仓 entry', async () => {
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

    const long = '这是一段很长的上下文填充文本用来把估算 token 推过压仓触发线。'.repeat(8);
    for (let i = 0; i < 3; i++) {
      await (await runtime.submit(`${long} 第${i}条`)).wait(ctx);
    }

    const page = await runtime.conversation.entries({}, 100, undefined, ctx);
    const kinds = page.items.map((entry) => entry.kind);

    // 压仓 entry 的 kind 是 pi.compaction；每次压仓会额外打一次模型做总结，
    // 所以模型调用次数会多于提交次数。
    expect(kinds.some((kind) => kind.includes('compaction'))).toBe(true);
    expect(faux.state.callCount).toBeGreaterThan(3);
    await runtime.close();
  });
});
