import { defineConfig } from 'vitest/config';

// 覆盖率门禁：下面 include 的纯逻辑模块要求 100%（行/分支/函数）。
// 需要真 MC 服务端 / 模型 API Key / 网络的模块（agent 循环、mindserver、
// skills、mcdata 注册表、SDK sendRequest 等）不在单元覆盖范围内。
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/shared/prompts.ts',
        'src/shared/utils/math.ts',
        'src/shared/utils/tokens.ts',
        'src/shared/config/json.ts',
        'src/shared/config/load.ts',
        'src/shared/config/schema.ts',
        'src/shared/config/value.ts',
        'src/body/memory_bank.ts',
        'src/body/auto_pickup.ts',
        'src/shared/logger.ts',
        'src/brain/runtime/events.ts',
        'src/brain/runtime/compaction.ts',
        'src/brain/runtime/prompt.ts',
        'src/brain/tools/tools.ts',
        'src/brain/tools/game_tools.ts',
        'src/brain/runtime/request_log.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
