# mindcraft-ce → pi-durable 迁移设计

> 状态：设计已定，PoC 已验证，尚未改动仓库代码。
> 目标运行时：`@earendil-works/pi-durable` **1.0.4**（精确锁定，不用 caret）、`@earendil-works/pi-ai` **1.0.4**、`@earendil-works/chord` **1.0.4**。

## 0. 决策摘要

| 问题 | 决定 |
|---|---|
| 迁移深度 | 全量替换 deliberative 层（对话/历史/压缩/ReAct/工具/子代理/持久化） |
| 强制工具调用 | 改用 pi-durable 原生 `control: { terminate: true }`，放弃 `tool_choice: 'required'` |
| 存储拓扑 | 每个 bot 进程一个 SQLite：`bots/<profile.name>/session.db` |
| 反射层 | `scheduler.ts` / `emergency.ts` / `edges.ts` / `live_state.ts` **冻结**，不进 durable 路径 |
| 双通道 | 保留：散文 = `pi.assistant`；Say = 自定义 entry `mc.say` |

## 1. 已验证的环境事实

### 1.1 供应商：内置 provider 与现有 profile 逐字段命中

`profiles/opencode.json` 的 `url` 是 **`https://opencode.ai/zen/go/v1`**（OpenCode **Go**，不是 Zen），`model` 是 `deepseek-v4.1-flash`。pi-ai 内置 `opencodeGoProvider()`（id `opencode-go`，name "OpenCode Go"）目录中该模型：

```
baseUrl      https://opencode.ai/zen/go/v1
api          openai-completions
contextWindow 1000000        maxTokens 384000
input        ["text","image"]        ← 视觉原生支持
cost         in 0.15 / out 0.6 / cacheRead 0.003
compat       supportsStore:false, supportsDeveloperRole:false,
             supportsStrictMode:true, maxTokensField:"max_tokens",
             requiresReasoningContentOnAssistantMessages:true,
             thinkingFormat:"deepseek"
thinkingLevelMap  off→null, low→"low", high→"high", max→"max"
inputLimits.images.resize  maxWidth/Height 2000, maxBytes 4718592, jpegQuality 80
```

- 会话头由 `withOpenCodeSessionHeader()` 自动注入，真实头名是 **`x-opencode-session`**（现有 profile 写的名字是对的，但值用 `randomUUID()`，每进程随机、不持久）。
- `thinkingFormat:"deepseek"` 正是现有 profile `thinking:{type:'disabled'}` 的格式；`off→null` 即 disabled。
- 认证：`OPENCODE_API_KEY`（或 CredentialStore），取代 `params.api_key_env` + `keys.json` 手写查找。

### 1.2 PoC 实测（`%TEMP%\pi-poc`，faux provider + `tsc --noEmit` = 0）

| 验证项 | 结果 |
|---|---|
| `Harness.open` + `root()` + `submit()` + `wait()` | `status: done` |
| 工具调用执行并落 `pi.tool-result` | ✅ |
| `control:{terminate:true}` 结束 run | ✅ **仅 1 次模型调用**，无额外请求 |
| 自定义 entry `mc.say` 写入 `{text:"hello world"}` | ✅ |
| `defineDoc` 同事务写入 `{"plan":["said: hello world"]}` | ✅ |
| `beforeRequest` 注入世界快照（尾部 user 消息） | ✅ |
| 纯文本作答 = 自动散文通道（`pi.assistant`，无工具调用） | ✅ |
| 图片内容透传到模型（`{type:"image"}`） | ✅ |
| `harness.usage()` 按 provider/model 汇总 | ✅ |
| mindcraft-ce 的 `tsconfig`（NodeNext + skipLibCheck）消费 pi-durable 的 `.d.ts` | ✅ 0 错误 |

**关键观察**：pi-ai 归一化后的 system 消息形如
`{role:"system", content:"", sections:{world:"..."}, toolsAdded:[...]}`
——section 文本走 `sections` 字段，增量只重发变化部分。但**section 值一变就会追加一条新的 `pi.system` entry**（PoC 第 2 轮实测出现第二条 `pi.system`）。

### 1.3 包成熟度（风险）

| 包 | 首次发布 | 1.0.0 | 1.0.4 |
|---|---|---|---|
| pi-durable | 2026-09-19 | 2026-10-01 | 2026-10-05 21:46 |
| pi-ai | 2026-05-07 | 2026-10-01 | 2026-10-05 21:44 |
| chord | 2026-09-04 | 2026-10-01 | 2026-10-05 21:44 |

pi-durable 仅 17 天历史、6 天发 6 个版本，README 自述 "Experimental. The API changes without notice between releases."。
pi-ai 传递依赖较重（含 `@google/genai`、`protobufjs`、`esbuild`，90 包）。
`engines.node` 要求 `>=22.19.0`，现为 `>=22.13.0`，需上调。

## 2. 边界：什么进 pi-durable，什么冻结

```
mineflayer bot（20 tps）
  ├─ edges.ts / live_state.ts / emergency.ts / scheduler.ts   ← 冻结，不改
  │     确定性反射、滞回边沿、L1–L5 抢占：pi-durable 无 tick loop，其延迟单位是
  │     一次 durable commit，结构上无法承载 20 tps 反射
  │
  └─ deliberative 层 → pi-durable Harness（每进程一个 SQLite）
        GenerationTask / ToolTask / CompactionTask
        Conversation（transcript）/ defineDoc（places, plan, memory）
        watchEvents() → mindserver / 前端
```

### 冻结契约（迁移中不得改动签名）

- **反射层**：`scheduler.ts`（`LEVEL`/`KIND`/`EventPayload`/`Decision`/各 `Verdict` + `pushEvent/beginRequest/finishRequest/startAction/releaseAction/isCurrent/describe/stopAll`）、`emergency.ts` 全部导出、`edges.ts` 全部导出、`action_runner.ts` 的 generation 协议。
- **感知层**：`live_state.ts`（`LiveState` + `sampleLiveState(ctx)` + 常量）、`event_stream.ts`（`formatEventEntry/renderEvents/composeTail`）。

### 抢占协议的真实形态（决定 P3 的桥接方式）

**不是事件总线，是同步返回值协议。** `pushEvent(event)` 同步返回 `{decision, seq}`；`loop.ts:142` 用 `describe().currentRequestId !== begun.requestId` 判定在途响应作废；`unsee()` 把事件退回"未消费"，好让新请求重新带上。

- 只有 **L4（PREEMPT）/ L5（EMERGENCY）** 会打断并作废在途模型回合。
- L5 额外：清空动作、`generation++`、锁死动作通道（`startAction` 返 `EMERGENCY_LOCKED`）。
- `emergency.ts` 全程**绕过模型**，只经 `EmergencyBot`（`health/inventoryNames/feet/threats/stopAll/fleeTo/eat`）。

→ 迁移时必须在反射层与 `conversation.abort()` / `whenBusy:"steer"` 之间写一层**同步判定 → 异步动作**的桥；不能假设存在事件总线。

### 感知文本是缓存敏感契约

`composeTail` 以 `\n\n` 拼接，顺序固定为 **事件 → 记忆摘要 → 世界快照**，渲染为最后一条 user 消息。`renderLiveState` 的文本（`Body:`/`Held:`/`Backpack (free N):`/`Position:`/`Environment:`/`Nearby entities (within 32: N+X more):`/`Goal:`/`Meta:` 等行标）是 token 与 prompt-cache 敏感契约，迁移需版本化，不得顺手改动措辞。

## 3. 模块映射

| 现有 | 迁移后 | 处置 |
|---|---|---|
| `src/models/gpt.ts`（9.8KB） | `opencodeGoProvider()` + pi-ai auth | **删除** |
| `src/models/_model_map.ts` | pi-ai 内置目录 | **删除** |
| `src/utils/keys.ts` + `${VAR}` 头展开 | pi-ai `CredentialStore` / `envApiKeyAuth` | **删除** |
| `src/models/prompter.ts`（13.8KB） | 保留提示词/冷却/日志职责；HTTP 与工具编排移交 pi-durable | 大幅瘦身 |
| `src/agent/history.ts`（11.4KB） | Conversation entries + `entries()`/`context()` | **删除**，改为查询 |
| `src/agent/compaction.ts`（6.4KB） | `CompactionTask` + `CompactionPolicy` + `beforeCompact` hook | **删除** |
| `src/agent/loop.ts`（7.3KB） | `GenerationTask` + `ToolTask` | **删除** |
| `src/agent/requestLog.ts` | pi-ai `onPayload`/`onResponse` + `watchEvents()` + `pi.usage` | 改接 |
| `src/agent/event_stream.ts` | `conversation.watch()`（Chord 精确 op 帧、有界缓冲、late-join） | 改接 |
| `src/agent/plan.ts` / `memory_bank.ts` / `places` | `defineDoc`（同事务提交、fork 语义） | 改写 |
| `commands/to_openai_tools.ts`（17.4KB） | `defineTool` + registry + `beforeTool` hook | 重写 |
| 52 个工具（47 命令 + 5 控制） | TypeBox schema | 机械转换 + 手工 |
| `action_runner.ts` 的通道认领/超时 | `ToolTask.executionMode` + `beforeTool` | 改接 |
| 子代理（当前无） | `ownership:{kind:"task"}` + `api.conversation()` | 新增能力 |

## 4. 关键设计决策

**D1 感知快照用 `beforeRequest`，不用 `section`。**
`section` 的值一变就追加一条 `pi.system` entry，且 Zen/Go 的 compat 未开 `supportsMidConvoSystemMessages`。因此：**静态提示词 → sections；动态世界快照/事件/记忆 → `beforeRequest` 追加尾部 user 消息**。PoC 已双向验证。

**D2 `control.terminate` 取代 `tool_choice:'required'`。**
`Finish` 语义从"结束本轮推理"变为"结束 run"。注意 `terminate` 的生效条件是**整轮所有结果都请求 terminate**，因此"`Finish` 之后的调用被拒"（AFTER_FINISH）需要在 `afterTool` hook 里自行保留。模型现在可以纯文本作答——这正是自动散文通道，是**增益**而非损失。

**D3 双通道落地。**
散文 = `pi.assistant`；Say = 自定义 entry `mc.say`（`data:{text}`）+ `Say` 工具。前端通过 `watch()` 消费 Chord op 流，天然支持 late-join 与重连。

**D4 状态文档化。**
`places`/`plan`/`memory` → `defineDoc`（`scope:"conversation"`, `history:"latest"`, `fork:"initial"`）。现有 history 的 level 1/2 分级淘汰语义改为 doc 字段 + `CompactionTask`。

**D5 每 bot 一个 SQLite。**
`bots/<profile.name>/session.db`（`openNodeSqliteStorage`，WAL + `synchronous=NORMAL`）。**同名或同 profile 多开会撞文件**，需并入 `count_id`。注意 pi-durable 明确"一个进程同时只能独占一个 storage，且无跨进程锁"——与现有"1 bot = 1 子进程"拓扑天然吻合。

**D6 图片路径简化。**
现有：800×512 JPEG quality 100 无缩放 → base64。迁移后由 pi-ai 的 `inputLimits.images.resize` 自动处理（2000×2000 / 4.7MB / q80）。相机采集保留，编码/缩放可删。

## 5. 迁移顺带修掉的现存缺陷

以下均由只读侦察在现有代码中确认，非猜测：

1. **`blocked_actions` 可被绕过（安全）**：`validateToolCall` 与 `executeToolCall` **都不检查黑名单**，仅在 `getOpenAITools` / `getToolDocs` 里过滤广告。模型按名字直接调用被禁工具**仍会执行**。迁到 `beforeTool` hook 补上真正的强制点。
2. **压缩阈值算错 8.7 倍（成本/质量）**：`resolveContextWindow()` 读 `profile.context_window`，而**所有 profile 都没有这个字段**，于是回退 `FALLBACK_CONTEXT_WINDOW = 128_000`；真实窗口是 **1_000_000**。压缩在 90%×128k = 115.2k tokens 就触发，而模型能吃到 900k。pi-ai 目录里自带正确的 `contextWindow`。
3. **`requiresReasoningContentOnAssistantMessages: true`**：所有 Zen/Go deepseek 模型都要求回放的 assistant 消息补空 `reasoning_content`，手写适配器未处理。
4. **`process.exit` 遍布** `agent.ts:80/93/131/159/193/878`，durable 运行时无法接管生命周期。
5. **路径不一致**：`prompter.ts` 用 `__dirname/../../bots/...`（dist 下会指向 `dist/bots`），其余文件用 `./bots/...`。
6. **`tool_choice:'required'` 已是软保证**：`prompter.ts:198-207` 遇 400 静默回落 `'auto'` 重试一次。

## 6. 分阶段计划

每阶段独立可验证，前一阶段门禁通过才进入下一阶段。

| 阶段 | 内容 | 验证 |
|---|---|---|
| P0 | 冻结反射层契约；建 `src/runtime/` 适配骨架（不动旧代码） | `tsc` 0 |
| P1 | pi-ai 替换 `gpt.ts`/`_model_map.ts`/keys | 同一 profile 下请求等价 + `check:prompts` |
| P2 | SQLite + Conversation 替换 `history.ts` 落盘 | 重启后续接；`memory.json` 可迁移 |
| P3 | `GenerationTask`+`ToolTask`+`control.terminate` 替换 `loop.ts` | 回合链路端到端 + 抢占不回归 |
| P4 | 52 工具 → TypeBox registry（脚本转 47 + 手工 5 控制 + 2 手检） | 工具表逐项等价；`blocked_actions` 真强制 |
| P5 | 感知注入（`beforeRequest`）+ 双通道 + 文档状态 | 快照/散文/Say 三路验证 |
| P6 | compaction/plan/memory → `CompactionTask` + `defineDoc` | 压缩阈值按 1M 生效 |
| P7 | 门禁全绿 + 真机冒烟 | tsc/eslint/vitest/coverage/check:prompts + MC 服务器实测 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| pi-durable 17 天历史、自述 API 会变 | 精确锁 1.0.4；所有接触点收敛在 `src/runtime/` 一层；不散落调用 |
| 崩溃重放对实时游戏无意义（"向前走一格"不幂等） | 动作类工具标 `replay:"unsafe"`（默认），仅幂等查询标 `safe`；不追求崩溃瞬间重放 |
| durable commit 节奏 vs 游戏循环 | 调 `settings.progress`；感知与反射不进 durable 路径 |
| 52 工具改写引入行为漂移 | 机械转换脚本 + 逐工具等价测试；`validateUpdatePlan` 的宽松兼容需显式保留 |
| 同名 bot 撞 SQLite | 文件名并入 `count_id`/pid |
| `engines.node` 需升到 `>=22.19.0` | 本地 v24.21.0 已满足；同步改 `package.json` |

## 8. 未决问题

- `Finish`/`AFTER_FINISH` 在 `control.terminate` 语义下的精确等价行为（需在 P3 用测试钉死）。
- 现有 `bots/<name>/memory.json` 的迁移脚本是否需要（还是直接弃旧从新）。
- 反射层向 deliberative 层的抢占信号，在 `conversation.abort()` + `whenBusy:"steer"` 下的等价性（P3 验证）。

## 9. 进度记录

### P1 已完成（pi-ai 替换模型层，双路径）

新增（旧 `gpt.ts`/`_model_map.ts` 保留，等价性已验证后才删）：

| 文件 | 作用 |
|---|---|
| `src/runtime/headers.ts` | `resolveHeaders` 从 `gpt.ts` 原样搬出（行为逐字不变） |
| `src/runtime/provider.ts` | profile → pi-ai `Models`/`Model`；端点分派 Go / Zen / 官方 / 自定义 |
| `src/runtime/model.ts` | `PiModel implements AIModel`，与旧 `GPT` 接口逐字兼容 |
| `tests/runtime_provider.test.ts` | 10 个测试：端点解析 + payload 等价 |

依赖：`@earendil-works/{pi-durable,pi-ai,chord}` **精确锁定 1.0.4**；`engines.node` 上调至 `>=22.19.0`。

**payload 等价证据**（同一组输入，`onPayload` 截获 vs 旧适配器 stub client 截获）：

```
messages    5 条逐字节一致：system("SYS") / user("hi") / assistant("hello") / user("go north") / user(尾巴)
tools       逐字节一致
tool_choice "required" 一致
model       "gpt-5.4" 一致
pi-ai 额外  stream:true, stream_options:{include_usage:true}, store:false  ← 传输层，非语义
```

**同时确认**：OpenCode Go profile 命中内置目录后 `contextWindow = 1_000_000`（即 §5 第 2 条 bug 在主路径上自动修复），`compat.thinkingFormat = "deepseek"`、`supportsStrictMode`、`maxTokensField = "max_tokens"` 全部来自目录而非手写。

**门禁**：`typecheck` 0 / `lint` 0 / **26 文件 345 测试全绿**（原 25/335）/ 覆盖率 100% / `build` 0 / `ALL PROMPT REFS OK`。

