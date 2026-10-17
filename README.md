# Mindcraft CE

> 面向 Minecraft 的大模型机器人，真·现代化，真·可拓展，真·稳定（bushi
>
> 基于 [mindcraft-ce/mindcraft-ce](https://github.com/mindcraft-ce/mindcraft-ce) 进行改造。

## 功能简介

玩 Minecraft。做你的助手。

## 快速开始

需要 Node.js ≥ 22.19.0、一个对局域网开放的 Minecraft 世界，以及一个 OpenAI 兼容的模型端点。游戏里显示的端口用 `--mc-port` 指定；不指定会自动扫描。要连别的机器，用 `--mc-host` 指定地址。

```bash
git clone <本仓库地址> && cd mindcraft-ce
npm ci

# 先把 DEEPSEEK_API_KEY 设成你的 key
# Windows PowerShell: $env:DEEPSEEK_API_KEY = "sk-..."
# macOS/Linux: export DEEPSEEK_API_KEY=sk-...

cp auth.example.json auth.json     # Windows: Copy-Item auth.example.json auth.json

npm start -- --profiles ./profiles/deepseek.json --mc-port 51234
```

原生模块（`canvas` / `gl`）装不上时，直接用 `docker compose up --build`。

---

## 自动进入下界

身体侧提供 `enterNether` 工具：模型会先检查背包里有没有至少 10 块黑曜石和 1 个打火石，然后自动选址、搭好 4×5 下界门框、点火，并走入传送门等待维度切换。4×5 门框的四个角在施工时会用背包里的常见方块（dirt / cobblestone 等，最多 4 个）垫住；垫块留在门角外侧，不影响点火和通行，已有实心门角会直接复用。

- **不动现场**：只往空气里放黑曜石；目标格被占用就换址，不会挖掉或覆盖已有方块。中途失败会保留已放的门框，并在回执里说明卡在哪一步。
- **复用已有入口**：附近已经有点燃的传送门时，直接尝试走进去。
- **点火要授权**：点火仍受危险操作闸门保护。先调用 `allowDangerousOps`（`ops="ignite"`，建议 `calls=1`），再调用 `enterNether`。
- **纯函数可测**：材料门槛、门框几何、选址预检都在 `src/body/library/nether_portal.ts`，单元测试见 `tests/nether_portal.test.ts`。

---

## 网页控制台与 CLI

`npm start` 后会自动打开 `http://localhost:8080`，和上游一样。

> ⚠️ 控制台固定监听 `0.0.0.0`，没有鉴权。只在可信网络里用，不要暴露到公网。

也有一个 CLI，本意是便于调试，不过我个人用的其实也不是很多。

```bash
npm run cli -- --agent deepseek --port 8080 stats
npm run cli -- --agent deepseek --port 8080 --wait mineBlock --x 10 --y 64 --z 20
```

> 本仓库代码完全由 AI 生成，纯属垃圾一坨。为保护各位开发者的眼睛和大脑，建议各位大概让 AI 讲讲，就不必捏着鼻子完整阅读了。

## 一些莫名其妙的 FAQ

为什么要做这个项目？

上游的设计有些过时了。它像是为 GPT-4 时代、没有长程工作能力的模型设计的。举个例子，上游设计模型输出 `!command(...)`，由正则解析后执行。上下文限制为 `max_messages: 15`，记忆截断到 500 字符，还有不少外围的不成熟功能。这些导致它运行得并不稳定。在 Claude Code 这类工具蓬勃发展的现在，Agent 的范式也逐渐成熟。借着 pi-durable 发布，我改造了 Mindcraft-CE，希望它能变得好用。
人话：看着不顺眼了

项目的思想有什么特别之处吗？

平平无奇的（相对于现代 Agent 而言），就像在 Pi 上挂了几个 Minecraft 的工具那样。不过，本项目完全由事件驱动（一切皆事件），大脑和身体分离，上下文末尾的 Live State 等等，也算是小有特色吧。

它能用了吗？

通关还不行，毕竟项目还没几天，我一个学生时间也不太多。不过，它很快就会成为最厉害的 Mineflayer 机器人🤖！

---

## 配置详解

### 文件分工

| 文件 | 作用 |
| --- | --- |
| `settings.ts` | 进程级设置，启动入口读它 |
| `providers.json` | 模型端点、模型窗口、采样参数 |
| `auth.json` | 凭据。从 `auth.example.json` 复制 |
| `profiles/*.json` | 每个 Bot 的身份、模型引用、上下文压缩和提示词 |
| `schemas/*.json` | JSON Schema，编辑器补全用 |

### 启动参数

`npm start -- ...` 会把参数传给 `main.ts`。

| 参数 | 作用 |
| --- | --- |
| `--mc-host <host>` | 临时覆盖 `settings.host` |
| `--mc-port <port>` | 指定 Minecraft 端口；不传就在 `host` 上扫描 |
| `--profiles <path...>` | 覆盖 `settings.profiles`，可以跟多个路径 |
| `--task_path <file>` | 读任务 JSON 文件 |
| `--task_id <id>` | 从任务文件里选一个任务，必须和 `--task_path` 一起用 |
| `--help` | 打印用法 |

```bash
npm start -- --mc-host 127.0.0.1 --mc-port 51234
npm start -- --profiles ./profiles/deepseek.json ./profiles/gpt.json
npm start -- --task_path ./tasks/demo.json --task_id gather_wood
```

### settings.ts

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `minecraft_version` | `"auto"` | 填 `"auto"` 自动识别；也可以写死，例如 `"1.21.11"` |
| `host` | `"127.0.0.1"` | Minecraft 服务器地址。`--mc-host` 会覆盖它 |
| `auth` | `"offline"` | `"offline"` 或 `"microsoft"` |
| `mindserver_port` | `8080` | 网页控制台端口。`MINDSERVER_PORT` 会覆盖它；CLI 的 `--port` 只是告诉 CLI 连哪个端口 |
| `auto_open_ui` | `true` | 启动后是否自动打开浏览器 |
| `profiles` | `[]` | 没有默认 Bot。用 `--profiles` 指定，或在这里加入自己的 profile；空数组会直接报错 |
| `load_memory` | `false` | 是否加载上一次的会话记忆 |
| `init_message` | 一句开场白 | Bot 出生后发给模型的初始消息 |
| `only_chat_with` | `[]` | 只处理这些玩家的聊天；空数组表示公开聊天 |
| `chat_ingame` | `true` | 是否把回复发到游戏聊天框 |
| `allow_vision` | `true` | 每轮请求是否带一张现拍截图 |
| `blocked_actions` | `[]` | 禁用的工具名，可以带或不带前导 `!` |
| `cheat` | `false` | 是否允许 `/tp`、`/setblock` 这类需要 OP 的作弊工具 |
| `spawn_timeout` | `30` | 等待 Bot 出生的秒数 |

### Minecraft 连接

打开 "对局域网开放" 后，把显示的端口填给 `--mc-port`。

```bash
npm start -- --mc-port 51234
```

不传 `--mc-port` 时自动扫描 `settings.host` 上的局域网端口。

host 默认 127.0.0.1，也可以指定。

```bash
npm start -- --mc-host 192.168.1.20 --mc-port 51234
```

`MINECRAFT_PORT` 环境变量也能提供端口。`settings.auth` 填 `"offline"` 时走离线登录，填 `"microsoft"` 时走微软账号登录。`minecraft_version` 保持 `"auto"` 一般就够了。

### providers.json

`providers.json` 存供应商和模型，允许写 `//` 注释。结构是 `providers[providerId]`。

```json
{
  "$schema": "./schemas/providers.schema.json",
  "providers": {
    "deepseek": {
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "headers": {},
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek-V4.1-Flash",
          "api": "openai-completions",
          "baseUrl": "https://api.deepseek.com",
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 393216,
          "input": ["text", "image"],
          "samplingParams": {
            "thinking": { "type": "enabled" },
            "reasoning_effort": "high"
          },
          "samplingParamsByThinkingLevel": {
            "high": {
              "thinking": { "type": "enabled" },
              "reasoning_effort": "high"
            }
          },
          "headers": {}
        }
      ],
      "modelOverrides": {
        "deepseek-flash": {
          "name": "DeepSeek-V4.1-Flash",
          "api": "openai-completions",
          "baseUrl": "https://api.deepseek.com",
          "reasoning": true,
          "contextWindow": 1000000,
          "maxTokens": 393216,
          "input": ["text", "image"],
          "samplingParams": {
            "thinking": { "type": "enabled" },
            "reasoning_effort": "high"
          },
          "samplingParamsByThinkingLevel": {
            "high": {
              "thinking": { "type": "enabled" },
              "reasoning_effort": "high"
            }
          },
          "headers": {}
        }
      }
    }
  }
}
```

供应商字段。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | 显示名 |
| `baseUrl` | 否 | OpenAI 兼容端点地址。自建端点通常要写 |
| `api` | 否 | pi-ai 的接口名，默认 `openai-completions` |
| `headers` | 否 | 额外请求头，值支持 `$ENV`、`${ENV}` 和 `!命令` |
| `models` | 否 | 这个端点上的模型列表 |
| `modelOverrides` | 否 | 按模型 id 覆写内置目录里的字段 |

模型字段。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 模型 id，profile 里的 `provider/model` 用它 |
| `name` | 否 | 显示名 |
| `api` | 否 | 单独指定接口名 |
| `baseUrl` | 否 | 单独指定端点 |
| `reasoning` | 否 | 是否启用推理模型相关行为 |
| `contextWindow` | 否 | 上下文窗口。上下文压缩触发线按它算 |
| `maxTokens` | 否 | 最大输出 token |
| `input` | 否 | 输入类型数组，例如 `["text", "image"]` |
| `samplingParams` | 否 | 原样进请求体的采样参数 |
| `samplingParamsByThinkingLevel` | 否 | 按思考等级给不同采样参数 |
| `headers` | 否 | 模型级请求头 |

内置供应商有 `opencode-go`、`opencode`、`openai`。内置模型可以用 `modelOverrides` 改窗口、采样参数或 header；要加全新的 OpenAI 兼容端点，就在 `providers` 里新建一个。

### auth.json

```bash
cp auth.example.json auth.json
```

结构是 `providerId -> 凭据`。`auth.json` 也允许写 `//` 注释。

```json
{
  "$schema": "./schemas/auth.schema.json",
  "deepseek": {
    "type": "api_key",
    "key": "$DEEPSEEK_API_KEY",
    "env": {}
  },
  "example-oauth": {
    "type": "oauth",
    "access": "access-token",
    "refresh": "refresh-token",
    "expires": 0
  }
}
```

`env` 和 `oauth` 是完整 schema 的形状；当前运行时只从 `api_key.key` 取凭据，OAuth 还没接。

`key` 支持三种写法。

| 写法 | 例子 | 说明 |
| --- | --- | --- |
| 环境变量 | `"$DEEPSEEK_API_KEY"` | 从环境变量取，取不到就报错 |
| 字面量 | `"sk-..."` | 直接写 key |
| 命令 | `"!security find-generic-password -w -s x"` | 执行命令取 stdout，10 秒超时，进程内缓存 |

凭据解析顺序是 `auth.json`、环境变量 `<PROVIDER_ID>_API_KEY`。例如 `deepseek` 对应的环境变量名是 `DEEPSEEK_API_KEY`。

自建端点如果没写 key，程序会用占位值 `not-needed`；内置供应商缺 key 会直接报错。

### profiles/*.json

一个 profile 就是一个 Bot。`settings.profiles` 里的每个路径都会起一套大脑和身体。

```json
{
  "$schema": "../schemas/profile.schema.json",
  "name": "deepseek",
  "model": {
    "provider": "deepseek",
    "model": "deepseek-flash"
  },
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "backgroundTokens": 32768
  },
  "promptSet": "default",
  "prompts": {
    "conversing": "你是一个 Minecraft 机器人，名字叫 $NAME。",
    "saving_memory": "把上面的对话压缩成摘要。",
    "saving_memory_update": "把新内容并入已有摘要。",
    "summary_system": "你是一个摘要助手。"
  },
  "skin": {
    "model": "slim",
    "path": "./skins/example.png"
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `$schema` | 否 | 编辑器补全用 |
| `name` | 是 | Bot 名，只能包含字母、数字、下划线和短横线；同时是 `bots/<name>/` 的目录名 |
| `model` | 是 | 字符串 `"provider/model"`，或对象 `{ provider, model }` |
| `compaction.enabled` | 否 | 是否启用上下文压缩，默认 `true` |
| `compaction.reserveTokens` | 否 | 给回复预留的 token，默认 `16384` |
| `compaction.keepRecentTokens` | 否 | 压缩时保留的最近 token，默认 `20000` |
| `compaction.backgroundTokens` | 否 | 后台压缩提前量，默认 `32768` |
| `promptSet` | 否 | 提示词集名字，默认 `default` |
| `prompts.conversing` | 否 | 系统提示词 |
| `prompts.saving_memory` | 否 | 首次压缩摘要提示词 |
| `prompts.saving_memory_update` | 否 | 更新摘要提示词 |
| `prompts.summary_system` | 否 | 摘要系统提示词 |
| `skin.model` / `skin.path` | 否 | 皮肤模型和图片路径 |

profile 也允许写 `//` 注释。未知字段会直接报错，不会静默忽略。键名在 `schemas/profile.schema.json`。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `MINECRAFT_PORT` | 覆盖 Minecraft 端口 |
| `MINDSERVER_PORT` | 覆盖网页控制台端口 |
| `PROFILES` | JSON 数组，覆盖 `settings.profiles`，例如 `["profiles/a.json"]` |
| `BLOCKED_ACTIONS` | JSON 数组，覆盖 `settings.blocked_actions` |
| `SETTINGS_JSON` | JSON 对象，覆盖 `settings` 里的任意字段 |
| `<PROVIDER_ID>_API_KEY` | 供应商缺省环境变量，例如 `DEEPSEEK_API_KEY` |

`SETTINGS_JSON` 是严格 JSON，不能写注释。`PROFILES` 和 `BLOCKED_ACTIONS` 也必须是 JSON 数组，不是逗号分隔字符串。

### 优先级

从低到高。

1. `settings.ts`
2. `SETTINGS_JSON`
3. `MINECRAFT_PORT`、`MINDSERVER_PORT`、`PROFILES`、`BLOCKED_ACTIONS`
4. 启动参数 `--mc-host`、`--mc-port`、`--profiles`
5. 如果最后还是没端口，自动扫描

CLI 的 `--port` 是指 MindServer 端口。它默认读取 `MINDSERVER_PORT`，再读 `settings.mindserver_port`，最后回退 `8080`。

---

## License

[MIT](LICENSE)
