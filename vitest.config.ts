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
        'src/utils/text.ts',
        'src/utils/math.ts',
        'src/utils/keys.ts',
        'src/prompts.ts',
        'src/models/_model_map.ts',
        'src/agent/memory_bank.ts',
        'src/agent/compaction.ts',
        'src/agent/requestLog.ts',
        'src/agent/auto_pickup.ts',
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
