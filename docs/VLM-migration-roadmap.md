# VLM-Bot 对齐现状（2026-10-06）

> 本文取代原先的《VLM-Bot → mindcraft-ce 改造路线图》。
> 原文档写于对齐开始前（基线 `cc9b6a3`），把移植写成未来计划；其中多数条目**已经完成**，
> 少数经复核后被判定为**不该对齐**。以本文件为准。

## 背景：VLM-Bot 是设计稿，不是可运行基准

复核后确认它自身有几处从未跑通的机制，因此本仓库的目标是**对齐设计意图，不是复制实现形态**：

- `compaction` 的 `usageRatio` 是 `createAgent` 的构造常量、默认 `0`，`main.js` 也不传；`summarize` 默认 `null`。
  → 90%/25%/TTL 这套策略在 VLM-Bot 里**从未触发过一次**，且它的 History 没有条数兜底。
- `edges.js` 的 `createEdgeWatcher` / `resolvePriority` **只被自己的单测引用**，生产里没有任何调用者。
- `primed` / `swelling` / `lockedOn` / `heldWeapon` 在 VLM-Bot 的 `src` 里**只有读取方、没有生产方**。
- 整个项目**没有任何持久化**：History 与 plan 都是纯内存。

---

## 一、已完成

### 1. Andy 网关与 Andy-4.x 模型族整体删除

默认 profile 从 `andy.json` 切到 `profiles/opencode.json`——它是唯一真正把截图作为
`image_url` 发给模型的适配器，其余适配器的 `sendRequestWithTools` 没有 `liveImage` 形参。

- 删除：`src/models/andy.ts`、`andy.json`、`profiles/andy-4.2.json`、`docs/andy.md`、
  `docs/assets/images/andy-4.2.jpeg`
- 移除：`ANDY_API_KEY`（`keys.example.json`）、mkdocs 导航项、README 的 Andy API 章节与支持表行
- 中性化：`ollama.ts` 默认模型 → `llama3.1`，`lmstudio.ts` → `qwen2.5-7b-instruct`
- 同步：`docs/FAQ.md`、`src/mindcraft-py/example.py`、`src/models/_model_map.ts`（目录扫描自动发现，无需改表）
- 保留：`tasks/`、`profiles/tasks/`、`docs/minecollab.md` 里作为**机器人名字**出现的 `andy`

### 2. 四处死接缝

| 症状 | 修法 |
|---|---|
| 调度器挑出来的未见事件被写进只写不读的 `loopLog`，模型被叫醒却不知道原因 | 新增 `## 事件` 段渲染未见事件；尾巴顺序为 **事件 → 记忆 → Live 快照**；`loopLog` 变成有上限的审计台账 |
| `snapshotFromBot` 从不填 `primed/swelling/hostile/lockedOn/heldWeapon`，两个 L5 检测器永不触发 | 补齐：`tnt` 实体名=已点燃 TNT、creeper `metadata[16]`=`swell_dir`、mcData 类别补敌对、实体 yaw 判朝向、`heldItem` 判武器；`ALWAYS_HOSTILE` 收敛为单一来源 |
| `maybeCompact` 收到 `summarize: null`，level-2 永远进不去，压仓形同虚设 | 注入 `summarize`/`makeSummary`；条数硬顶折算成压力；`keepLast` 取硬顶的三分之一防抖动；被删条目原样归档 |
| 先采 Live State 再拍照，快照里的截图引用滞后一轮 | 先拍照、再采样 |

另外 `SearchWiki` 抓取失败时**不再把异常文本当知识回给模型**，改为如实报"没有信息"，
并支持宿主注入语料（对齐 VLM 的注入式设计）。

### 3. 感知与上下文

- Live State 补：药水效果、主手耐久、水平速度、游戏天数、潜行/疾跑姿态。
- 明细列表从"16 条硬上限"改为**条数 + 1024 token 双上限**；超出部分按
  `名字×数量 方位` 聚合成一行，远处语义不再只剩 `+N more`。
- 历史尾巴加 token 预算（默认 100 条 / 8000 token），profile 可用
  `max_history_entries` / `max_history_tokens` 覆盖。
- `$MEMORY` 从 **system 前缀**挪到尾巴：记忆一更新不再击穿整个前缀缓存。
- 系统提示词补回**双通道契约**：`Finish` 只结束推理、`Stop` 只停身体、
  同一时刻一个占用型动作、被拒不盲目重试。

### 4. 工具面与持久化

- `UpdatePlan` 的 `todos` 从 `string[]` 改为 `{text, done}[]`，Live State 渲染成 `✓/○`；
  旧格式纯字符串仍被接受（按未完成折算）。
- 参数 `domain` **真正生效**：按区间括号语义校验，有限上下界同时写进 JSON Schema，
  模型在 schema 里就能看到边界（此前 `[-64,320]` 这类约束只写在定义里、从不检查）。
- `memory.json` 现在一并保存与恢复 **MemoryBank 的地点和 PlanStore 的计划**，
  老存档缺字段时安静跳过。

---

## 二、有意不对齐（连同理由）

1. **`Stop` 的执行顺序**：VLM-Bot 先 `await` 停身体再 `stopAll`，在 await 窗口内到达的
   过期完成回调仍算"活着"，会把过期结果写进历史并唤醒下一轮（double-report）。
   本仓库保持**先作废 generation、再停身体**。
2. **上下文的 API 形态**：VLM-Bot 把 system + 历史 + 快照压成**一条 `user` 消息**、
   历史渲染成 `#seq kind/Llevel {json}` 文本行。本仓库保持**原生多轮 messages**
   （system + 真实 role 轮次 + 末尾快照）。
3. **压缩的触发条件**：不采用"纯 90% 压力、无条数兜底"——VLM-Bot 的压力信号在生产里
   恒为 0，照搬等于把可用的兜底换成空转。本仓库保留**条数硬顶 + token 压力**双线。
4. **工具粒度**：不采用"单个 49 命令、无类型校验的 `Baritone` 字符串 DSL"
   （教程常驻 tool description 约 4k token，且能真写配置文件）。
   本仓库保持类型化工具 + `blocked_actions`。
5. **参数模型**：不采用"所有字段必填、用 `null` 表示没给"。只借它的
   `enum`/`minimum` 真校验思想。
6. **失败处理**：不采用"模型调用失败就合成一个 `Finish`"。那会把 API 故障伪装成
   "模型决定收工"，让故障彻底静默；本仓库返回空调用 + 显式错误。
7. **Say 与正文双通道**：**这是有意设计**，保持不动（正文当"干活的动静"，Say 是专门说话）。
8. **身体**：不引入 Baritone fork。本仓库用 `mineflayer-pathfinder`（钉 master + 补丁）
   + 自研技能库。
9. **实体级 L5 的修复不算"对齐"**：VLM-Bot 同样从未生产这些字段，这是**两边共同的 bug**。

---

## 三、供应商收敛为单一 OpenAI 兼容 + TTS 退役（2026-10-06 追加）

原 20 个适配器里，只有 3 个实现了 `sendRequestWithTools`（不全的还收不到截图），
其余 17 个连工具调用都没有 —— 对当前 agent 而言等于不存在。故整体收敛：

- **只留 `src/models/gpt.ts` 一个适配器**（前缀 `openai`），它现在是通用 OpenAI 兼容客户端：
  - `profile.model.url` → 任意兼容端点；
  - `params.api_key_env` → 指定 key 变量名（默认 `OPENAI_API_KEY`）；
  - `params.headers` → 额外 HTTP 头（如 Zen 的 `x-opencode-session`）；
  - `params` 其余键原样进请求体（如 `thinking: {type:'disabled'}`）；
  - 新增第 6 个 `liveImage` 形参：**截图现在真的能发给模型**（此前只有 opencode 收得到）；
  - 新增可注入 client 构造参数 + `clientOptions`，单测不联网。
- 删除 19 个适配器（azure/claude/gemini/opencode/openrouter/ollama/lmstudio/…）与 13 个对应 profile。
- `profiles/opencode.json` 不再是适配器，而是一个 **OpenAI 兼容 profile**：指向 Zen 端点，
  用 `api_key_env` + `headers` + `thinking` 表达它原本的网关特性。`x-opencode-session`
  写成 `${OPENCODE_SESSION_ID}`：设了环境变量就全进程共用，没设则每个适配器实例取一个新
  UUID——恢复被删适配器"每进程一个会话 id"的行为。默认 profile 仍是它。
- `_model_map` 的供应商启发式链删除：模型名不再需要前缀，任何名字都落到唯一的 provider；
  显式 `api` 指向不存在的供应商会**硬报错**（不再静默兜底）。
- `package.json` 里 7 个死掉的供应商 SDK（@anthropic、@cerebras、@google/genai、
  @huggingface、@mistralai、groq-sdk、replicate）已移除，装回用 `npm install --legacy-peer-deps`
  （不加该参数会撞上一个**与本次改动无关的** `@eslint/js` peer 冲突）。
- **TTS 整体退役**：删 `src/agent/speak.ts`、`gpt.ts` 的 `sendAudioRequest`/`TTSConfig`、
  `settings.speak` 与 profile 的 `speak_model`（含 `settings_spec.json` 与 README 的语音小节）。
  正文照旧直接进游戏聊天，不再有语音播报。

> 契约已用测试锁死：`tests/model_map.test.ts` 断言 `src/models/` 里**有且只有** `gpt.ts`，
> 且它的前缀是 `openai` —— 哪天多出一个适配器，这个测试会立刻失败。

### 独立审查后的修复（1 BLOCKER + 6 MAJOR + 14 MINOR）

- **BLOCKER：`lockedOn` 弧度/角度混用。** mineflayer 的 `entity.yaw` 是**弧度**（0=北、
  π=南），而判定按 notchian 角度（0=南、90=西）比。因 `eyaw ≤ 6.28` 恒成立，该字段实际
  等价于"bot 是否在该实体**正南** ±36°"，与实体朝向基本无关 → 假阴性/假阳性都有，
  `resolvePriority` 会把 L4 抢占加错对象。已全链路统一到弧度（`LOCK_ON_RADIANS`），
  并加四方位 + 背向回归线。
- **药水效果永远是 none。** mineflayer 只给 `{id, amplifier, duration}`，名字要查
  `bot.registry.effects[id]`；原实现读不存在的 `name`，整段等于死代码。
- **compaction 在无头部可压时不减反增。** 空数组仍调一次模型并返回
  `[摘要, ...原样全部]`：长度 +1、一条没删、下一轮压力依旧，于是每来一条消息调一次。
  现在 `head.length === 0` 直接返回"未压缩"。
- **无 key 的本地端点构造即崩。** 删掉 ollama/lmstudio/vllm 后丢了"这几个适配器不读 key"
  的特性，而 README 正好推荐把 `url` 指向本地兼容端点。现在有 `url` 但缺 key 时降级为
  占位 key `not-needed`；官方端点缺 key 仍硬报错。
- 其余：README 宣传已被静默忽略的 `vision_model`、`x-opencode-session` 从"每进程一个"
  退化成常量、速度单位错 20×（`velocity` 是格/**刻**）、摘要双份、尾巴标题错挂
  （"## 事件"挂在"## 当前世界快照"下）、`sendVisionRequest` 死代码、前缀剥离未锚定
  （`my-openai/proxy` 被吃成 `my-proxy`）、缺 `model` 字段 TypeError、todos 的 schema 与
  校验器不一致、docker-compose 仍挂 `settings.js`、苦力怕漏掉点燃首 tick、
  压仓抛错会让事件丢失、测试往仓库落盘（`historyDir`/`discoverModels` 改为可注入）。
- **额外自查发现**：`Math.floor(世界坐标 - 2*sin(π))` 因 `sin(π)=1.2e-16` 落到 **-1 号方块**，
  也就是正南方向（最常见）永远检测不到前方岩浆。改为"脚下方块 + 取整偏移"。

> 教训：上一轮 **302 个测试全绿**，同时 BLOCKER 与两个 MAJOR 都活着——因为测试喂了假数据
> 形状（用角度写 `entity.yaw`、给 `effects` 加 mineflayer 从不产生的 `name`、不检查传给
> `summarize` 的数组内容）。**测试全绿只证明"代码符合我的假设"，不证明假设是对的**，
> 所以本轮每个修复都配了能证伪它的断言。

### 第三轮审查（三份独立报告）后的修复

三份报告互相独立，其中**两份同时报出同一个 MAJOR**（光照语义），这是强证据：

- **MAJOR：`block.light` 被当成"亮度"。** `prismarine-chunk` 里 `light` 是**方块光**
  （`getBlockLight`）、`skyLight` 是**天光**（`getSkyLight`），两者独立且都能为 0——
  露天白天就是 `light 0 / skyLight 15`。所以 `light ?? skyLight` 永远拿不到天光（0 不是
  nullish），于是正午地表报 `light 0 (confidence high)`，既让 L3 `world.light_low` 误触发，
  又**每轮**告诉模型"伸手不见五指，而且我很确定"。而且 chunk 里的 skyLight **不随时辰变化**
  （半夜也是 15），判断"暗不暗"必须结合白天/黑夜。已改为
  `max(blockLight, isNight ? 0 : skyLight)`，并让 `skyExposed` 在**读不到柱状数据**时返回
  `null`（以前把"没数据"当露天，把置信度抬到 high）。
- **高坠阈值标定错。** 带阻力的真实递推是 `v=(v-0.08)*0.98`：恰好落下 8 格时 `v≈-1.08`，
  而 `v<=-1.1` 要到第 17 刻、已掉 9.67 格——注释里的 `sqrt(2gh)` 漏了阻力。阈值已改
  `-1.08`，并写清它是**近似**且受 300ms 轮询相位影响（8~9 格窗口窄可能错过、10~19 格
  概率触发、≥20 格必中；保守方向不误报）。
- **玩家实体的 `name` 是类型名 `'player'`。** mineflayer 的 `addNewPlayer` 写死
  `entity.name='player'`，身份在 `entity.username`，且不设 displayName——不先取 username
  的话快照里所有玩家都是匿名的 `player#N`。已改为 `username → name → displayName`。
- **`entity.pose` 不存在。** 真值在**实体元数据第 6 项**（mcData `metadataKeys[6]==='pose'`），
  已按元数据读取并映射枚举名；顺带钉了一条"光有 `entity.pose` 必须读不到"的契约测试。
  （附带核实：实体是 prismarine-entity 实例，其 `metadata` 初始化为**数组**、mineflayer 用
  数字下标写入，所以 `Array.isArray` 判据是对的——差点被"看起来像对象"误导而改错。）
- **schema 的 `required` 比校验器更严**：`commandToTool` 把所有参数无条件塞进 `required`，
  而校验器的 `canOmit = optional===true || default!==undefined`。全仓只有
  `getCraftingPlan.quantity` 命中。已改为跳过 optional/default 参数。
- **任务脚本的端点继承是假的**：`make_profiles` 以前**整块替换** `model`，所以不传 `--url`
  时生成的 profile 没有端点、直接打到官方 `api.openai.com`（文档却写"走默认 profile"）。
  已改为从 `profiles/opencode.json` 继承 `url`/`params`、只覆盖模型名，并保留模板的
  `prompt_set` 等字段。
- **README 的 `npm install` 会失败**（`@eslint/js` peer 冲突，与本次改动无关）：主流程已改
  `npm ci`（实测 `npm ci --dry-run` exit 0），并注明 `npm install` 需 `--legacy-peer-deps`。
- **`toolChoice` 是死路径**：`LoopAssembled.toolChoice` 没有生产者，下游 `void` 掉，prompter
  硬编码 `required`。已删除该字段与形参，并在注释里写明 `tool_choice` 固定为 `required`。
- **静音会吞事件**：`shut_up` 时 `modelCall` 早退，但 `beginRequest` 已把事件标 consumed，
  这些事件再也补不回来。已在 `handleMessage` 里挡在循环之前（解除静音后仍会送达）。
- **`check:prompts` 的参数级核对漏掉控制类工具**：已改用 `getOpenAITools` 取全部 52 个工具
  （含 5 个控制类）做双向核对。
- **有意接受**：同一轮里玩家消息既进历史轮又作事件行、异步动作结果同样双份——事件行多带
  whisper/mention 等路由元信息，属于双通道设计的代价，**明确接受**，不改。
- **已知性能项**：`sampleBlocks` 每轮扫描 65³≈27 万次 `blockAt`（Vec3 修复后从"立即抛错"
  变成真查表），真 prismarine 世界实测约 80–90ms/轮同步阻塞。属既有设计，后续可换
  `findBlocks` 或缩小扫描体，**不阻塞**。

### 第四轮审查（teammate `auditor`）后的修复

- **MAJOR（本轮修复自己引入的）玩家名改成 username 后，`creeper`/`tnt` 判据对玩家生效。**
  `primed = name === 'tnt'`、`swelling = name === 'creeper'` 以前因为玩家 `name` 恒为
  `'player'` 而永不命中；改成取 username 后，**用户名恰好叫 creeper 的玩家**会被判成起爆的
  苦力怕（玩家 `metadata[16]` 是 `score`、默认 0，`!== -1` 即成立）→ **L5 → EMERGENCY**，
  停掉全部动作并进 emergency。公开服上这是很常见的用户名。两处已加 `!isPlayer` 守卫，
  并补了"玩家叫 creeper/tnt 不得触发 L5"的回归钉子。
- **MAJOR（既有）摔落反射从未生效**：`agent.ts` 里写的 `fallCheck: true` **不是插件选项**——
  `@nxg-org/mineflayer-common-sense` 的真选项是 `mlgCheck`（默认 `false`），`setOptions` 只做
  `Object.assign`，所以那个键被静默忽略、`isFallingCheckEasy()` 直接 return。已改为
  `mlgCheck: true`。（`world.fall.lethal` 只能"停动作+逃 10 秒"，对坠落本身无济于事，
  所以这半条反射是真的缺。）
- **MINOR：`tests/keys.test.ts` 会破坏开发者真实的 `keys.json`**（`writeFileSync` 后 `rmSync`）。
  已改为进测试前备份、收尾还原。
- **MINOR：`lightConfidence` 死类型成员与缺回归线**：类型收紧为 `'high' | 'unknown'`
  （`'medium'`/`'low'` 已无产生点），并补了"读不到柱状数据必须报 unknown 而不是 high"的断言。
- **MINOR：`POSE_NAMES` 无本地权威来源**（mcData 里 `pose` 只是 varint）——已在注释里写明
  只影响可读性、不影响检测器。
- 残留清理：我的验证脚本忘了 chdir，把 `Andy_0.json`/`Jill_0.json`/`A.json` 写进了仓库根目录，
  已删除（`A.json` 未被 gitignore，会误入提交）。

### 第二轮验收又抓到一个 MAJOR（同类）：`bot.blockAt` 必须传 Vec3

`mineflayer` 的 `blockAt` 把参数原样交给 `prismarine-world`，而后者在**区块已加载**时
执行 `block.position = pos.floored()`——传 plain `{x, y, z}` 会抛
`TypeError: pos.floored is not a function`。快照层为了防御把 `blockAt` 包在 try/catch 里，
于是异常被吞掉，`light`/`inLava`/`inWater`/`biome`/`nextIsLava` **全部静默变成 undefined**：

- L5 的 `world.lava.contact`、`world.water.drowning`、`world.lava.about_to_enter` 与
  L3 的 `world.light_low` 在生产里**永不触发**；
- Live State 的方块段恒为 none、light 恒 unknown、biome 恒 null；
- 每轮快照要构造并捕获 ~27 万个 TypeError（实测 3071ms vs 传 Vec3 的 34ms，约 90×）。

已在 `edges.ts` / `live_state.ts` 的全部调用点改为传 `vec3`，并加"必须是 Vec3"的回归线。
**同一个测试假数据的病**：stub 的 `blockAt` 接受 plain 对象，于是断言的是真 API 给不出的形状。
同类修掉的还有 `thunderState`/`rainState`——mineflayer 给的是**数字等级**（`rain.js` 初值
`0`），代码却按 `=== true` 判断，导致雷暴永远识别不到、`world.thunder_start` 永不触发。

---

## 四、仍未做 / 可选后续

- **感知的远合并是简化版**：按"名字×方位"聚合，未做 VLM 那种按类型+罗盘的并发合并；
  也未把截图引用与图本身严格对齐到同一轮（已先拍后采，但采样仍在渲染前完成）。
- **Level-1 删除利用不足**：`defaultIsObsolete` 只认 `kind === 'world'`，而本仓库只有
  `system` 来源算 world，且几乎不写 level-1 条目，过期噪声主要靠 level-2 总结兜。
  另一个后果（当前**不可达**，先记下）：`Scheduler.beginRequest` 只收 `level >= 2` 的事件，
  而 `pruneConsumed()` 只删 `consumed` 的 —— 所以一旦真有 level-1 事件被 `pushEvent`，
  它会永远留在 `this.events` 这个 Map 里，形成无界增长。已核实目前没有任何
  `level: 1` 检测器、也没有 `pushEvent({ level: 1 })` 调用点。
- **Baritone 能力面**：鞘翅飞行、process 优先级仲裁、世界/区域缓存、`planTo` 级寻路内省、
  waypoint 持久化——这些在 VLM-Bot 是一等公民，本仓库没有对应实现。
- **Python 评测脚本已同步**（首轮漏掉、事后补齐）：`evaluation_script.py` 删掉了 `--api` 与
  vllm/ollama 分支，`make_profiles` 一律写 `{"api":"openai", ...}` 且只在传了 `--url` 时才带
  端点（默认不再硬编码 `127.0.0.1:8000`）；`multi_data_collection_script.py` 同样去掉 `--api`；
  `experiment_script.sh` 换成当前模型名。入口也从 `node main.js` 改成 `node --import tsx main.ts`
  （`run_task_file.py`/`human_ai_tasks.py`/evaluation_script 里的 tmux 命令），文档里的
  `settings.js`、`--vllm`、`--api vllm` 一并改正。

> 已补：`scripts/check-prompts.ts` 以前没挂进 npm script，且不认识 5 个控制类工具；
> 现在控制工具名单以 `to_openai_tools.ts` 的 `CONTROL_TOOLS` 为单一来源，
> 并挂成 `npm run check:prompts`（当前 `ALL PROMPT REFS OK`）。

---

## 五、验证（本次全部通过）

```
npx tsc --noEmit   # 0 error
npx eslint .       # 0 error
npm run build      # tsc 通过
npm run check:prompts  # ALL PROMPT REFS OK
npm test           # 25 files / 335 tests，7 个纯逻辑模块 100% 覆盖
```

### 验证边界（有意为之，不是遗漏）

- **真机实测（起 MC 服务端跑端到端）暂缓执行**：后续会有一轮架构大改，真机冒烟测试要等改完再做，
  现在做等于对着即将被替换的结构做一次昂贵且立刻过期的验证。因此本仓库当前所有验证都是
  **静态 + 源码级**的：类型、lint、单测、提示词引用、以及对着 `mineflayer`/`prismarine-*`
  源码与数据的逐条核对。
- 由此产生的**已知未验证面**：感知链路（L5 岩浆/溺水、L3 光照/雷暴、方块段与 biome）是否在
  真实服务器上真的点亮——`blockAt` 传 Vec3、天气按数字等级判断这两处已按源码契约修正并加了
  回归线，但没有在真服上确认过。
- 其它未验证：Zen 网关契约（`url` / `${OPENCODE_SESSION_ID}` 头 / 顶层 `thinking` /
  `deepseek-v4.1-flash` 是否存在 / 图片支持）、真 tokenizer 下的 90% 压缩压力线、
  `tasks/evaluation_script.py` 的 tmux 并行流程（需 tmux + 网络 + keys）。

