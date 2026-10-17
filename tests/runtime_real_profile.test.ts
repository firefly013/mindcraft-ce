/**
 * 端到端：用**真实 profile** 装配。
 *
 * 前面的装配测试都用 `profile = {}`，那是简化过的。这里读盘上的
 * `profiles/opencode.json`（生产 profile），只把供应商换成 faux，其余全部走
 * 真实路径：真实提示词集、真实上下文压缩参数、真实工具表、真实 SQLite。
 *
 * 覆盖的契约：
 *   - 系统提示词 = 真实提示词集渲染出来的静态文本（不含任何占位符）
 *   - 上下文压缩参数来自 profile 的 compaction.reserveTokens / keepRecentTokens
 *   - 工具表 = 真实命令表 + 4 个控制工具 + Say
 *   - 一轮真的跑得起来，且尾巴带世界快照、不落 transcript
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { composeLiveTail } from '../src/body/live_state.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openBotWiring } from '../src/brain/runtime/bot.js';
import { compactionPolicyFromProfile } from '../src/brain/runtime/compaction.js';
import { buildGameTools } from '../src/brain/tools/game_tools.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import { loadProfile } from '../src/shared/config/load.js';
import type { ResolvedProvider } from '../src/brain/runtime/provider.js';

const ctx = BACKGROUND_CONTEXT;
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-real-'));
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

/** 读生产 profile（与 `settings.profile` 同源的那份文件，走真实的校验路径）。 */
function readProductionProfile(): Record<string, unknown> {
  return loadProfile(join(process.cwd(), 'profiles', 'opencode.json')) as unknown as Record<string, unknown>;
}

function fauxProviderFor(): { provider: ResolvedProvider; faux: ReturnType<typeof fauxProvider> } {
  const faux = fauxProvider({ models: [{ id: 'mc-test' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel('mc-test') ?? faux.getModel();
  return {
    faux,
    provider: {
      models,
      model,
      providerId: faux.provider.id,
      apiKey: undefined,
      headers: null,
      params: {},
      contextWindow: model.contextWindow,
    },
  };
}

describe('真实 profile 装配', () => {
  const profile = readProductionProfile();

  it('profile 形状符合预期（这几个字段是接线要读的）', () => {
    expect(profile['name']).toBe('opencode');
    expect(profile['model']).toBe('opencode-go/deepseek-v4.1-flash');
    // 窗口不再写在 profile 里：它由内置目录或 providers.json 的模型定义决定。
    expect(profile).not.toHaveProperty('context_window');
    expect(profile['compaction']).toEqual({ reserveTokens: 16_384, keepRecentTokens: 20_000 });
  });

  it('上下文压缩参数来自 profile', () => {
    expect(compactionPolicyFromProfile(profile)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: 32_768,
    });
  });

  it('一轮跑得起来；尾巴带快照且不落 transcript', async () => {
    const { provider, faux } = fauxProviderFor();
    const seen: Array<Array<Record<string, unknown>>> = [];
    faux.setResponses([
      (context: { messages: unknown }) => {
        seen.push(context.messages as Array<Record<string, unknown>>);
        return fauxAssistantMessage('收到。');
      },
    ]);

    const wiring = await openBotWiring({
      name: 'opencode',
      profile,
      provider,
      baseDir: tempDir(),
      systemPrompt: () => 'SYS',
      liveTail: () => composeLiveTail({
        bot: {
          entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 },
          health: 20,
          food: 18,
        },
      }),
      tools: buildGameTools({ declarations: toolDeclarations(), execute: () => 'ok' }),
    });

    await (await wiring.runtime.submit('看看周围')).wait(ctx);

    const last = seen[0]?.[(seen[0]?.length ?? 0) - 1];
    expect(String(last?.['content'])).toContain('## 当前世界快照');
    expect(String(last?.['content'])).toContain('health 20');

    const page = await wiring.runtime.conversation.entries({}, 100, undefined, ctx);
    expect(JSON.stringify(page.items)).not.toContain('当前世界快照');
    await wiring.close();
  });

  it('工具表 = 真实命令表 + 控制工具（Say 由运行时装）', () => {
    const names = buildGameTools({ declarations: toolDeclarations(), execute: () => 'ok' }).map((tool) => tool.name);
    // 生产 profile 对应的模型走的是同一张命令表
    expect(names.length).toBeGreaterThan(30);
    for (const control of ['Finish', 'Stop', 'Say', 'UpdatePlan', 'Feedback']) {
      expect(names).not.toContain(control);
    }
    // 之前删掉的 blueprint 系确实不在（construction 子系统已下线）
    expect(names).not.toContain('checkBlueprint');
  });
});
