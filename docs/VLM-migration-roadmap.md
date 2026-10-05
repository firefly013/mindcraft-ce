# VLM-Bot → mindcraft-ce 改造路线图（每步可跑）

> 目标：把 `~/VLM-Bot` 的 event-driven 大脑，嫁接到 `mindcraft-ce` 的成熟身体上，成为现代化强大的 Agent。
> 原则：只做加法不破坏，每一步都有 `npm test` / 冒烟可验证，回滚只需关 flag。

## 0. 基线（2026-10-05 已验证）

- `VLM-Bot@master cf0826a`：`npm test` **338 pass / 0 fail**，Node v24.21。`coverage` 门槛 95%。
- `mindcraft-ce@develop cc9b6a3`：默认 `andy.json`，offline auth，`port 55916`，`mindserver 8080`。`postinstall patch-package`。
- 结论：VLM 侧大脑逻辑完备但缺身体联调；mindcraft 侧身体完备但大脑是单线程 `写码→串行执行`。

## 1. 架构差异（为什么要改）

| 维度 | VLM-Bot（想要） | mindcraft-ce（现有） | 移植策略 |
|---|---|---|---|
| 驱动 | 事件驱动 + Scheduler 5级（1存/2记账/3唤醒/4抢占/5急停锁） | 消息回调直接触发 LLM，无优先级 | 原样搬 `scheduler.js`，先做 sidecar，不接业务 |
| 通道 | API线 vs 动作线独立，`Finish`只结束推理、`Stop`只停身体，`generation`防旧回调 | `ActionManager` 串行，`stop()` 杀进程式，`executing` 单 flag | 先包一层 `startAction/releaseAction/stopAll`，后切 `coder` 执行器 |
| 循环 | ReAct `required`：每轮至少一工具，以 `Finish` 收尾，抢占 void 整轮防 double-act | `max_commands` 截断，无 finish 语义，空响应会 stall | 新增 `AgentLoop`，先影子跑（只 log 不执行），再接管 |
| 上下文 | `system → history → LiveState`，保前缀缓存；`ENTRY_LIMIT 1000`，tail 100条/8000tok | `Prompter` 大杂烩 + `examples` + `relevant_docs`，无缓存意识 | 新增 `assemble.js`，先只读对比 token 量，后替换 |
| 历史 | append-only + `compaction`：90%触发，先删过期World（TTL 60s），不够再 LLM 总结（留20条） | `turns` 数组 + `max_messages 15` 粗暴截断 + `memory 500字` | 保留 `memory.json`，底层换 `History`，`summarizeMemories` 复用为 `summarize` 注入 |
| 感知 | `sampler→buildLiveState`：32格、实体/方块各1024tok预算，近详远合，缺字段渲`未知` | 散装 `bot.entity/health/food` 拼装，无预算 | 新增 `sampler.js`，先并行输出 diff，后替换 |
| 工具 | 13严格工具：`Baritone(dynamic)+Stop/Finish+Inspect/Use+Attack+UpdatePlan/SearchWiki/Feedback/Say`，BAD_ARGS 带路径，handler 抛错变 `rejected` | `!commands` 文本命令 + `Coder` 写任意 JS，LLM 幻觉可执行 | `ToolRunner` 包 `!commands`，先上 `Say/UpdatePlan/Baritone查询类`，再上动作类 |
| 说话 | 正文不自动进聊天，必须走 `Say`；工具调用广播 `🛠` | `chat_ingame/narrate_behavior` 自动说 | 加 `Say`，默认关自动广播，做 flag |
| 边缘 | `edges.js` 边沿+滞回：32进/40出、血≤6/回≥12、TNT/creeper/keyed 去抖 | `health/death/chat` 直发，无去抖 | 先只做 `health_low→L3 / emergency→L5`，后全表 |
| 急救 | `emergency.js`：停一切、远离最近 hostile 24格、吃最高饱和食物、10s无伤+32格无怪才交权 | 无 | 最后接，默认只 log 不接管 |

## 2. 分阶段计划

### P0 基线保活（本轮）
- [x] VLM `npm test` 通过（338/0）
- [x] mindcraft-ce `node --check main.js` 通过，`settings` 正常（profiles `./andy.json`, port 55916）
- [ ] mindcraft-ce `node_modules/mineflayer` **缺失**（`Test-Path False`，VLM 侧已装）→ 下轮跑 `npm ci`（需 patch-package，注意 canvas/gl 原生依赖）
- [ ] 本文件落盘即证据

### P1 调度器先行（只加文件，不改行为）
- 新增 `src/agent/vlm/scheduler.js`（从 VLM 原样拷，改 import 路径）
- 新增 `src/agent/vlm/scheduler.test.js`（影子单测）
- 验收：`npm test` 全过，线上行为零变化

### P2 上下文影子跑
- 新增 `history_vlm.js / assemble.js / compaction.js`
- 在 `Agent` 里双跑：老 prompt 照发，新 `assemble` 只打 log 对比 token
- 验收：连续 10 轮无抛错，token 差异可解释

### P3 感知并行
- 新增 `sampler.js`，输出 `LiveState` 文本到 `logs/vlm-live.log`
- 验收：与老状态拼装逐行 diff，缺字段全是 `未知` 而非 throw

### P4 工具化（风险最高，切片最小）
- 4a `Say + UpdatePlan`：只读+说话隔离
- 4b `Baritone查询类（scan/inspect/inventory/actions）`
- 4c `动作类（goto/dig/place/attack）`：走 `Scheduler.startAction`，忙时 `ACTION_BUSY` 而非排队
- 验收：每片独立 flag，关 flag 即回滚到 `!commands`

### P5 接线切循环
- `host.js`：`chat→L3/WAKE / whisper→L3 / death→L4 / health低→L5`
- `AgentLoop` 接管 `handleDecision`，`model` 先包现有 `Prompter`，后切 OpenAI tools
- 验收：空闲不空转、抢占不 double-act、kill 后 `generation` 失效

### P6 现代化（全都要，逐个来）
- 长记忆（LanceDB/RAG 在 agent-system 已有，直接复用为 `summarize`）
- `SearchWiki/Feedback`（复用 mindcraft `!wiki` + memory）
- 多智能体（`mindserver` 已有多 bot，在 Scheduler 上加跨 bot `mention` 路由）
- 视觉 VLM（`VisionInterpreter` 输出进 `bag.screenshot`，不再是 null）

## 3. 第一个 PR 切口（建议）
只做 P1，3 个文件，零行为变更：
```
src/agent/vlm/scheduler.js
src/agent/vlm/scheduler.test.js
docs/VLM-migration-roadmap.md（本文件）
```
回滚：一删即回。

## 4. 待你确认（回一句即可开工）
1. 不可妥协项：双通道 / 绝不脑补 / Say隔离，哪个最优先？
2. 必须保留项：coder写码 / vision / 多bot / tasks，哪个不能丢？
3. 实测环境：MC版本、LLM endpoint（Andy 还是 OpenAI 兼容）、服务器地址？
