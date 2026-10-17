# 整夜双 Bot 实测装置（scripts/overnight）

工作目录固定 `C:\Users\bobo\mindcraft-ce-overnight`（分支 `overnight/game-clear`），不碰主目录 `C:\Users\bobo\mindcraft-ce`。

## 组成

| 文件 | 作用 |
| --- | --- |
| `supervisor.ps1` | 守护进程：SETTINGS_JSON 注入 → 起 `main.ts` → 起 `watch.mjs`；main 退出/MindServer 挂/收到重启请求时杀整树并拉起 |
| `overnight-settings.json` | 注入的 SETTINGS_JSON：init_message（求稳+频繁 Feedback+通关流程）、auto_open_ui=false、allow_vision=false、spawn_timeout=60 |
| `watch.mjs` | 采集与告警：stdout/stderr、`bots/*/logs/agent-*.log`、`feedback.jsonl`、`session.db` 元信息、CLI events |
| `start.ps1` / `stop.ps1` / `status.ps1` | 启 / 停 / 查 |
| `alerts-since.mjs` | 增量读取 critical 告警（runtime-watch 用它轮询后转报 Lead） |

## 用法

```powershell
pwsh scripts/overnight/start.ps1      # 后台启动（-Vision 可开截图，默认关）
pwsh scripts/overnight/status.ps1     # 状态 + 最近告警 + 最近 Feedback
pwsh scripts/overnight/stop.ps1       # 停止
node scripts/overnight/alerts-since.mjs   # 自上次以来新增的 critical 告警
```

## 运行参数

- Minecraft `127.0.0.1:61359`；MindServer `:8080`；body 端口 `9400/9401`；viewer `3000/3001`。
- profile：`profiles/overnight-a.json` / `profiles/overnight-b.json`（内部 `name` = `overnight_a` / `overnight_b`）。
- 模型：`opencode-go/deepseek-v4.1-flash`；环境变量 `OPENCODE_SESSION_ID=overnight`（supervisor 注入）。
- 运行产物根目录：`tmp/overnight/`。

## 采集产物

- `tmp/overnight/stdout.log` / `stderr.log`：含全部子进程 stdout（`stdio:inherit`）；每次重启轮转为 `.1`/`.2`。
- `tmp/overnight/feedback/FEEDBACK.md`、`feedback-list.jsonl`：模型用 Feedback 工具提的建议，按时间落成可追踪清单（`feedback-new.jsonl` 是未转报队列）。
- `tmp/overnight/cli-events.jsonl`：CLI events 增量（走 MindServer `cli-command` 的 `op:list`，无副作用）。
- `tmp/overnight/watch-status.json`：bots 在线、session.db 大小/更新时间、错误窗口、告警计数。
- `tmp/overnight/alerts.jsonl` / `alerts-critical.jsonl` / `ALERTS.md`：告警。
- `tmp/overnight/supervisor.jsonl` / `restarts.jsonl`：守护进程与重启台账。

## 自动拉起

- main 进程退出 → supervisor 杀整树重启；若存活 <30s 则退避 5s→300s（避免配置错误打转）。
- MindServer 端口连续 300s 不可达 → 整树重启。
- watcher 判定 bot 掉线 ≥150s 或停滞 ≥30min → 写 `.restart-request` → supervisor 整树重启。
- 注意仓库自带的 `AgentProcess` 对「启动 <10s 就崩」的子进程**明确不重启**（`exited too quickly and will not be restarted`），所以整树重启是最后兜底。

## 实测发现的约束（详见 tmp/overnight/FINDINGS.md）

- `profile.name` 就是 Minecraft 用户名，必须匹配 `^[a-zA-Z0-9_]{3,16}$`；带 `-` 会在身体握手阶段被 LoginGuard 拒绝，agent 退出且不会自动重启。
- `providers.json` 的 `x-opencode-session` header 需要 `OPENCODE_SESSION_ID`，否则每次模型请求一行 stderr 警告（已注入）。
- watcher 启动后 120s 为宽限期，宽限期内不报 `mindserver-down` / `bot-offline`，避免「watcher 先起、8080 后起」的误报。
