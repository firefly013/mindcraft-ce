# 整夜双 Bot 实测发现（runtime-watch）

工作目录：C:\Users\bobo\mindcraft-ce-overnight。只记录实测证据，不编结果。

## F-1（blocker，已绕过）profile.name 必须是合法 Minecraft 用户名

- 现象：用 `profiles/overnight-a.json` / `overnight-b.json`（当时内部 `name` 带 `-`）启动，两个 bot 都连不上身体。
- 证据（tmp/overnight/archive/run1-name-hyphen/ 与 supervisor 日志）：
  - stderr：`[LoginGuard] Invalid name 'overnight-a'. Must be 3-16 alphanumeric/underscore characters.`
  - stderr：`body: failed to start: [LoginGuard] Invalid name 'overnight-a'...`
  - stdout：`Failed to attach body: body process exited before opening its port (code 1, signal null)`
- 根因：`src/body/mineflayer_body.ts` 用 `profile.name` 当用户名（`initBot(this.name)`），`src/shared/connection.ts` 的 `validateNameFormat` 要求 `^[a-zA-Z0-9_]{3,16}$`。
- 绕过：Lead 已把两个 profile 的内部 `name` 改成 `overnight_a` / `overnight_b`（文件名不变，启动路径不变）。
- 附带问题：这次崩溃发生在启动后 <10s，仓库自带 `AgentProcess` 命中 `exited too quickly and will not be restarted`，**子进程不会自动重启**，只有整树重启才能救回来。建议评估：快速崩溃也做有限次退避重启，或至少在日志/UI 上显式报警。

## F-2（噪音，已修）x-opencode-session header 解析不出来

- 现象：每次模型请求都往 stderr 打一行 `providers.json 里 provider "opencode-go" 的 header "x-opencode-session" 解析不出来（${OPENCODE_SESSION_ID}）`。
- 处理：supervisor 启动环境注入 `OPENCODE_SESSION_ID=overnight`，重启后计数 0。

## F-3（误报，已修）watcher 先于 MindServer 就绪

- 现象：首轮启动 watcher 立刻报 `mindserver-down`（websocket error）。
- 处理：watch.mjs 加 120s 启动宽限期，宽限期内不报 `mindserver-down` / `bot-offline` / `bot-back`。

## F-4（观察）profile 文件名与 bot 身份解耦

- 文件名可以带 `-`（`profiles/overnight-a.json`），但内部 `name` 不行；`bots/<name>/`、help 里的 agent 名、游戏内用户名都由内部 `name` 决定。运维上容易踩，建议在 profile schema 或启动校验里对 `name` 加同样的正则。
## F-5（模型反馈，通关阻塞）熔炉/useBlock 交互闭环坏了

阶段：挖铁烧铁（坐标 -12,48,8 附近）。证据在 tmp/overnight/feedback/FEEDBACK.md 第 3-5 条。

- `useBlock{type:furnace, input:"8 raw_iron", output:"8 iron_ingot"}` 只回 `{"action_id":"useBlock","generation":0}`，之后无完成/失败回执；模型判断 8 生铁"凭空消失"。
- 读熔炉内容多次无回执；取产物时人距熔炉 0.7~2 格却反复被拒「走到 (-12,48,8) 失败：路径被堵或到不了」3~4 次。
- 相关：autoPickup 顶掉主手工具；collectBlocks 砍树 54s 只拿 3 原木（模型随后 Stop）。

影响：iron 阶段直接卡住，后面铁镐/铁剑/钻石/下界/末地全被堵。建议优先排查「动作回执丢失 + useBlock 目标格寻路」两条链路。
## F-6（运行时，崩溃风暴）digDown 撞水 → action 拒绝停止 → body 自杀重启

- 现象：watcher 触发 `error-storm:lifecycle:body-lost`，10 分钟内 5 次 body-lost（a: 2, b: 3），closeCode=1006，body exit 1；整树未重启（supervisor restarts=0），靠内置 AgentProcess 自动拉起，bot 均恢复。
- 证据：
  - overnight_a：`15:58:50 World/L3 world.water.contact` → `15:58:51 World/L5 world.water.drowning` → `15:58:52 {"mod":"lifecycle","event":"body-lost","closeCode":1006,"processExitCode":1}`（digDown 挖竖井找钻石，y=61→21）。
  - overnight_b：`{"mod":"lifecycle","event":"exit","msg":"Action refused stop after 10 seconds. Killing process.","code":1}`（15:57:31）。
- 代码定位：`src/body/action_manager.ts` `stop()` 的 10s 保险丝 `cleanKill('Action refused stop after 10 seconds. Killing process.')`。
- 关联：模型 Feedback「digDown(115) 只挖 18 格就停、不给原因」应是同一处（撞水后进程被杀，而非正常结束）。
- 影响：进度反复重置（回出生点、丢竖井），但未丢关键道具；整夜会持续浪费时间与上下文。
- 建议：digDown 遇到水/岩浆/落差自行停止并回执；`stop()` 先做身体侧硬中断再考虑杀进程。
