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

### P2 已完成（SQLite 会话层 + 旧存档迁移）

新增：

| 文件 | 作用 |
|---|---|
| `src/runtime/state.ts` | `MemoryDoc` / `PlacesDoc` / `PlanDoc`（对应原 `memory.json` 的跨会话字段） |
| `src/runtime/session.ts` | `openBotSession()`：`bots/<name>/session.db` + Harness + 根 conversation |
| `src/runtime/legacy.ts` | `readLegacySave()` / `migrateLegacyState()`，幂等 |
| `tests/runtime_session.test.ts` | 7 个测试 |

**关键决定：只迁 memory / places / plan，`turns` 故意不迁。** 那是易失上下文——把上一局的对话原样塞进新会话没有意义，模型看到的世界已经变了。

**SQLite 适配器走 Node 内置 `node:sqlite`**（`DatabaseSync`），没有第三方原生依赖；本机 Node v24.21.0 真机验证通过。

**持久化证据**：写 memory/places/plan → `close()` → 重开同一个库 → 三个文档原值返回，且根 conversation **id 不变**（不是新建的）。

**幂等证据**：文档已存在时不覆盖（`memory: false`），缺失的仍补迁（`places: 1, plan: true`）。

**踩坑记录**：pi-durable 要求文档类型满足 `JsonObject`，而 TypeScript **只给对象字面量类型隐式索引签名，`interface` 没有**——所以 `PlanState` 必须写成 `type` 而不是 `interface`。

**门禁**：`typecheck` 0 / `lint` 0 / 27 文件 352 测试全绿 / 覆盖率 100% / `build` 0 / `ALL PROMPT REFS OK`。

### P3 已完成（回合语义 + 运行时装配）

新增：

| 文件 | 作用 |
|---|---|
| `src/runtime/entries.ts` | `SayEntry`（自定义 entry `mc.say`），Say 通道的独立记录 |
| `src/runtime/loop.ts` | `withTerminate` / `createSayTool` / `createFinishTool` / `liveTailHook` / `systemSection` |
| `src/runtime/runtime.ts` | `openBotRuntime()`：把 P1+P2+P3 拼成可驱动的 `BotRuntime` |
| `tests/runtime_loop.test.ts` | 11 个测试（faux provider，不联网） |

**核心语义映射：`control.terminate` ↔ "一轮一次模型调用"。**

侦察发现 mindcraft-ce 的 ReAct **并不是**"工具结果自动续起下一轮"：`handleDecision` → `runRound`（一次模型请求）→ `runCalls` → `finishRequest`，下一轮由**新事件**触发。而 pi-durable 的 `terminate` 要求**整轮所有结果**都请求终止才结束 run。

→ 所以 `withTerminate` 必须包在**每一个**工具外面，而不是只给 `Finish` 挂。只挂 `Finish` 的话，`[Look, Say]` 这种常见组合因为 Look 没请求 terminate，会白白多打一次模型。这一条有专门的载荷测试（`callCount === 1`）钉住。

**保留 `Finish` 工具**：提示词里到处在教模型"用 Finish 收尾"，删掉会改提示词契约；它现在退化为一个显式 yield。

**动态内容不进 section**（延续 P1 的结论）：静态提示词走 `section`（只发增量），每轮变化的事件/记忆/快照走 `beforeRequest`。测试验证：两轮之间提示词不变时 `pi.system` **只有 1 条**；尾巴只影响本次请求，`JSON.stringify(entries)` 里搜不到尾巴文本。

**踩坑记录**：

1. **建根会话时必须写模型**。`harness.root(ctx)` 不带 `agent.model` 的会话没有模型，generation 起不来，`submit()` 直接以 `unanswered` 结算——9 个测试同时失败才暴露出来。现在 `openBotSession` 接受 `model`，创建时写入，重开时比对不一致才 `configure()`（避免每次开库多一次 commit）。
2. pi-durable 把系统提示词作为**独立的一条 system 消息**，且实测排在 user 输入**之后**。依赖消息顺序的断言不可靠，改为直接单测 hook。
3. `execute` 契约要求返回 Promise，但没有 `await` 时写 `async` 会触发 `require-await`；改用 `() => Promise.resolve(...)`。

**门禁**：`typecheck` 0 / `lint` 0 / **28 文件 363 测试全绿** / 覆盖率 100% / `build` 0 / `ALL PROMPT REFS OK`。

### P4 已完成（52 个工具全部接入）

新增：

| 文件 | 作用 |
|---|---|
| `src/runtime/tool_schema.ts` | 命令参数 DSL → TypeBox schema（逐关键字等价） |
| `src/runtime/tools.ts` | `commandToRegistration` / `outcomeText` / `blockedActionsHook` |
| `src/runtime/control_tools.ts` | `Stop` / `UpdatePlan` / `Feedback`（`Finish`/`Say` 在 P3） |
| `tests/runtime_tools.test.ts` | 60 个测试 |
| `tests/runtime_control_tools.test.ts` | 16 个测试 |

**做法：适配而不是重写。** 47 个 `perform` 实现一行没动——`commandToRegistration(command, invoke)` 只把**声明**搬过来（TypeBox schema + 位置参数调用约定 + 回执文本），`invoke` 注入以便单测，后续传入闭包住 agent 的实现即可。

**等价性证据（最强的一条）**：对 `queryList.concat(actionsList)` 里**每一个**命令，把 TypeBox 生成的 schema 与旧 `commandToTool()` 的输出逐字段比对（47 个 `it.each`）。差异只有**一类**且被单独钉死：

> 无参数命令时旧实现发 `"required":[]`，TypeBox 省略 `required`。JSON Schema 里二者语义等价。测试里有一条专门断言"原始差异只允许这一类"，其余任何漂移都会红。

**`blocked_actions` 的安全修复**：旧实现只在 `getOpenAITools` / `getToolDocs` 里过滤**广告**——被隐藏的工具只要模型按名字直接调用就**照样执行**（`validateToolCall` 与 `executeToolCall` 都不查黑名单）。现在 `blockedActionsHook` 挂在 `ToolTask.beforeTool` 上，是真正拦得住的地方。名单存的是带 `!` 的命令名而工具名已 strip，所以两种写法都比对。

**`UpdatePlan` 的旧格式兼容**：schema 是给模型看的**严格**形式，而 `PlanStore.update` 故意兼容纯字符串 todo。pi-durable 的 `prepareArguments` 正好是为"校验前修模型常见写法"设计的——于是两者都保住，不用把 schema 放宽。**并有集成测试证明它真的被 ToolTask 调用**（模型给 `['找矿洞']`，apply 收到 `[{text:'找矿洞',done:false}]`）。

**踩坑记录**：

1. `Say` 的 schema 我漏了 `{ additionalProperties: false }`——等价性测试当场抓住（新 schema 比旧广告宽松）。
2. 控制工具的 `execute` 全是同步逻辑，写 `async` 触发 `require-await`；改成显式 `Promise.resolve`。
3. 摘要文本来自 `apply` **返回的快照**而非入参；测试桩返回空计划导致断言写错——是测试的错，不是实现的错。

**门禁**：`typecheck` 0 / `lint` 0 / **30 文件 439 测试全绿** / 覆盖率 100% / `build` 0 / `ALL PROMPT REFS OK`。

### P5 已完成（感知注入 + 状态门面）

新增：

| 文件 | 作用 |
|---|---|
| `src/runtime/perception.ts` | `liveTailFromTexts`（纯拼装）/ `composeLiveTail`（接真实感知层） |
| `src/runtime/state_access.ts` | `createStateAccess`：memory / places / plan 的读写门面 |
| `tests/runtime_perception.test.ts` | 8 个测试 |
| `tests/runtime_state_access.test.ts` | 5 个测试 |

**拼装与旧实现逐字一致**（`agent.ts:462-488`）：`composeTail(renderEvents(events), memoryText, liveBlock)`，顺序 **事件 → 记忆摘要 → 世界快照**，空段丢弃，快照永远最后。`renderLiveState` 的文本是 token 与 prompt-cache 敏感契约，措辞不能顺手改。

拆成两层是为了可测：`liveTailFromTexts` 是纯函数（顺序与省略规则全在这），`composeLiveTail` 只负责现采一次。测试里两者都覆盖，后者用 `{bot:{}}` 空桩也能安全采样（`sampleLiveState` 全防御性读取）。

**状态门面约定"读不到就返回默认值"**，而不是 `undefined`——调用方不该到处判空。`plan()`/`places()` 返回**深拷贝**（与 `PlanStore.snapshot` 的既有约定一致），有测试证明改快照不反噬存储、`setPlan` 不共享调用方的 todos 对象。

**门禁**：`typecheck` 0 / `lint` 0 / **32 文件 452 测试全绿** / 覆盖率 100% / `build` 0 / `ALL PROMPT REFS OK`。

### P6 已完成（抢占桥）

新增：

| 文件 | 作用 |
|---|---|
| `src/runtime/preemption.ts` | `PreemptionBridge`：同步 Verdict → 异步会话操作 |
| `tests/runtime_preemption.test.ts` | 11 个测试（**真实** `Scheduler` + 假 run 句柄） |

**要解决的问题**：`Scheduler.pushEvent()` 是**同步**的，pi-durable 的 `submit()`/`abort()` 是**异步**的；旧循环靠同步返回值 + 一个 `requestId` 比对作废在途响应（`loop.ts:142`）。桥必须做到「同步判定 → 异步动作」，且**异步动作不能阻塞判定**。

**语义映射（逐条对照旧实现）**：

| verdict | 新行为 |
|---|---|
| `stored`（L1/L2 或 emergency 锁定） | 什么都不做 |
| `start`（L3 空闲 / L4 空闲） | `startRun()` |
| `queued`（L3 忙） | **什么都不做**——在途 run 结束时 `finishRequest()` 因存在未见的 L3+ 事件回 `start`，由那条路径续跑（这就是"搭车"的落点） |
| `preempt`（L4 忙） | `abortRun()` → `startRun()` |
| `emergency`（L5） | `abortRun()` → `onEmergency()`，**不**开 run（紧急反射绕过模型） |

**作废在途响应的落点**：旧实现比对 `describe().currentRequestId !== begun.requestId`；这里的等价物是 `current.requestId !== requestId`——被抢占那一轮结束时不再 `finishRequest`。双保险：即使时序错开让它真被调到，`pushEvent(preempt)` 已把 `currentRequestId` 清零，只会得到 `stale`。

**验证到的三条关键语义**（都是载荷测试，不是"看起来对"）：

1. `notify()` 返回时**异步动作尚未执行**（断言 `runs` 为空）——证明判定没被阻塞。
2. `preempt` 在在途 run 还跑着时插入，且新一轮带上了被 `unsee()` 退回的旧事件（`[{first:1},{urgent:2}]`）——**事件不丢**。
3. 被抢占那轮的**迟到结束不会再开一轮**（断言 `runs` 仍为 2）——等价于旧实现的响应作废。

**踩坑记录**：`settle()` 必须**循环**等待——链会在动作执行过程中被替换（一轮跑完发现还有未见的 L3+ 事件时追加下一轮），只 await 一次会漏掉后追加的工作。这是测试里最容易踩的陷阱，已在实现里注释说明。

**门禁**：`typecheck` 0 / `lint` 0 / **33 文件 463 测试全绿** / 覆盖率 100% / `build` 0 / `ALL PROMPT REFS OK`。

### 剩余：agent.ts 统一切换 + 压缩接线

1. **agent.ts 切换**：把 `AgentLoop` / `History` / `Prompter` 换成 `BotRuntime` + `PreemptionBridge`，`assembleContext` 换成 `composeLiveTail`，`routeResponse` 作为 `onSay` 注入（**不重写**，避免与 `only_chat_with` / `chat_ingame` 等既有逻辑漂移）。
   - **未决**：一轮 run 的 `submit()` 该提交什么内容？旧设计里每轮没有 user 消息——事件只进尾巴（`## 事件`），不进 transcript。若把事件当 user 消息提交，它们就会进 transcript 并被逐轮重放，与旧设计的分发/剪枝语义不同。这个选择需要单独定。
2. **压缩接线**：`CompactionTask` + `CompactionPolicy` 取代 `compaction.ts`，并按 pi-ai 目录的真实 `contextWindow`（1_000_000）修正阈值——旧实现回退 128_000，压缩线算错 8.7 倍。

## P7（修订）：事件系统 = 打断消息队列，不是独立子系统

### 原则修正

迁到 pi-durable 的理由是**一切皆插件 + 机制自带**：恢复、上下文压缩、上下文管理都是现成的，不需要重复造轮子——**只要把工具写出来，再注入一个 state**。

由此推出对 P6 的修正：**不该去桥接 `scheduler.ts` 那套手写分发**（`consumed`/`seenBy`/`unsee`/`pruneConsumed`/`generation`），那是在重实现 pi-durable 已经原生的东西。正确做法是让那套机制**消失**，每个级别落到一个原生原语上。

事件系统看起来和主流 Agent 不一样，其实**非常相似：它就是打断消息队列**。对应 DSH 的两个术语——**引导（steer）**：下一次 API 请求带上；**排队（followUp）**：等 Agent 完全结束工作再发过去拉起来。

### 实测结论（`tests/runtime_inbox_semantics.test.ts`）

前提是「每个工具都被 `withTerminate` 挂上 `control.terminate`」——本项目"一轮一次模型调用"的设定。用 faux provider + 可外部放行的慢工具把 run 钉在在途状态：

| 提交方式 | 模型调用 | 第二次请求看到 | 结论 |
|---|---|---|---|
| `write` | **1** | — | 不唤醒模型 |
| `steer` | **2** | `…toolResult:[slow done] \| user:插一句话` | **加入正在跑的 run** |
| `followUp` | **2** | `…toolResult:[slow done] \| user:等会儿再说` | 本轮答完后开新一轮 |

**最关键的发现：`steer` 会覆盖 `control.terminate`。** 所有工具都请求了 terminate，`steer` 一来 run 就继续了第二次模型调用。这正是"引导"的语义。

### 修正后的 L1–L5 映射

| 级别 | 旧语义 | 新落点 |
|---|---|---|
| L1 | 只记账，从不唤醒 | `write`（被动 entry） |
| L2 | 只记账，随下一次请求顺带发给模型 | `write`（同上；实测不增加模型调用） |
| L3 空闲 | 立刻开请求 | `submit()` |
| L3 忙 | 排队等本轮结束 | `submit({whenBusy:'followUp'})` |
| L4 | 取消当前回合、带事件重开 | `abort()` → `submit()` |
| L5 | 取消 + 停动作 + 锁通道 | `abort()` → 保命反射 → 恢复 |

**L3 取 `followUp` 而不是 `steer`**：旧 L3-busy 是「当前请求看不到它，本轮结束时由下一轮带上」，而 `steer` 会让当前轮**不结束**（实测），那是行为改变。`steer` 留给将来"要加入当前工作"的需求。

### 两个必须处理的问题

1. **`abort()` 会撤回排队中的输入。** 旧实现靠 `unsee()` 把事件退回，好让新请求重新带上；pi-durable 的 `abort()` 直接撤回。所以 L4/L5 之前需要把待处理事件**自己缓冲一份**，abort 之后重新提交——这就是"改造了一下队列"的实际工作量，很小但要记得做。
2. **`BotRuntime.write()`** 已补上（原先只有 `submit`），作为 L1/L2 的落点。

### 主线收敛的发现

主线（`C:\Users\bobo\mindcraft-ce` 工作区）正在改的 `src/agent/compaction.ts` 注释里明确写着**照 Pi 实现**（`github.com/earendil-works/pi`）——而 pi-durable 的 `CompactionTask` **就是** Pi 的压仓。两边连字段名都对上了：

| 主线 profile 新字段 | pi-durable `CompactionPolicy` |
|---|---|
| `context_window` | 模型目录的 `contextWindow` |
| `reserve_tokens: 16384` | `reserveTokens` |
| `keep_recent_tokens: 20000` | `keepRecentTokens` |

主线手写的这几件事 pi-durable 原生就有：真实 usage 锚点、超限压缩后重试一次、只追加摘要不删历史、切点不落在工具回执上。**所以迁移会把这整个文件变成接线，而不是重实现。**

**一处需要定的差异**：pi-durable 的摘要提示词不可配置——`beforeCompact` 只能"拒绝或提供自己的摘要"，而 hook 里**没有模型访问权限**。主线新写的 `summary_system` / `saving_memory`（结构化检查点格式）因此无法直接喂给内置 CompactionTask。要么接受 pi-durable 的摘要格式，要么自写 compaction task。







