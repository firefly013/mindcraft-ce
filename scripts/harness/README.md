# 续做（resume）外部测试台

**目的**：验证“反射抢走身体 → 正在跑的动作被作废 → 反射完成 → 机械续做”这条链路。
它**不经过模型**，所以不能用“接进游戏让 VLM 去试、看 Feedback”的老办法；这里改成像
CLI 那样：**无模型接入游戏、从外部操控**。

## 一、前提

1. **MindServer 在跑**（外部操控的入口），见 `docs/cli-playtest-2026-10-23.md`；
2. **一个手动模式的 bot**：profile 里**没有 `model`**（例：`profiles/player.json` 只有 `name`）。
   手动模式现在会接一个“测试台运行时”（`src/brain/runtime/harness.ts`）：
   - 事件照常投递（`write`/`submit` 只记录，不叫模型）；
   - `beginEmergency`/`endEmergency` 接到**真实的** Scheduler/ActionRunner——L5 上锁、
     作废动作、解锁、续做，全部走线上同一条代码；
   - 事件同时落盘到 `bots/<name>/logs/harness-events.jsonl`。
3. **本地测试服**（能开 cheats / 有控制台或 RCON）——危险从外部制造。

## 二、跑法

### 方式 A：一键脚本（推荐）

```bash
# 终端 1：起 MindServer + 手动 bot（具体命令见 cli-playtest 文档）
C:/Users/bobo/scoop/apps/nodejs-lts/current/node.exe node_modules/tsx/dist/cli.mjs main.ts \
  --profiles profiles/player.json --mc-host 127.0.0.1 --mc-port 10000

# 终端 2：测试台（不带 --trigger 时会在 2.5s 后提示你去服务器控制台 summon）
node scripts/harness/resume.mjs --agent player

# 或者全自动：--trigger 里放你操作服务器的方式（RCON / 控制台脚本）
node scripts/harness/resume.mjs --agent player \
  --name collectBlocks --args '{"type":"oak_log","num":32}' \
  --trigger 'rcon-cli "summon zombie ~2 ~ ~"'
```

脚本会：提交动作（`via: 'runner'`，走动作通道）→ 到点触发危险 → 轮询事件 →
最后打印 `SUMMARY {...}` 并以退出码表示“是否观察到续做”。

### 方式 B：CLI 手动驱动

```bash
npx tsx src/cli.ts --agent player --via runner --wait --timeout 240000 \
  collectBlocks --type oak_log --num 32
# 在它跑着的时候，去服务器控制台：/summon zombie ~2 ~ ~
```

`--via runner` 是新增的：动作类命令走 `ActionRunner`（认领通道/幂等/中断/续做），
默认仍直连身体（旧行为）。

## 三、怎么制造“真实的打断”

从**服务器侧**制造，和 CLI 分工：CLI 管动作，服务器管世界。

| 危险 | 触发的东西 | 用途 |
| --- | --- | --- |
| `/summon zombie ~2 ~ ~` | 战斗反射（L5 `combat.engage`） | 最常用：打完自动续做 |
| `/setblock ~ ~-1 ~ lava` | 岩浆反射（L5） | 测“身体返回空结果”的路径 |
| `/summon creeper ~3 ~ ~` | 苦力怕反射（不走 L5 通道） | 对照组 |

## 四、期望事件序列

```
[L5/emergency]  combat.engage ...            ← 反射接管，动作通道上锁
[L3/steer]      动作 collectBlocks 被中断 ...  ← 中断回执（会写“会在反射结束后自动续做”）
[L2/written]    reflex.done ...               ← 反射完成（completes）
[L2/written]    action.resumed ...            ← 续做（带折算后的参数）
[L3/steer]      tool.action.done ...          ← 续做的那次动作跑完
```

断言点：`SUMMARY` 里 `sawL5` / `sawInterruptReceipt` / `sawResume` / `jobState`；
原始流水看 `bots/<name>/logs/harness-events.jsonl`。

## 五、测试矩阵

| 动作 | resume 声明 | 期望 |
| --- | --- | --- |
| `collectBlocks oak_log 32` | checkpoint | `action.resumed`，`num` 扣掉已砍数 |
| `travelTo x y z` | auto | `action.resumed`，参数原样 |
| `digDown distance 10` | checkpoint | 按身体坐标折算剩余深度 |
| `mineTunnel length 32` | checkpoint | 按原始终点折算；方向没给时用位移推断 |
| `craft …` | manual | **不**续做，中断回执写“不会自动续做” |
| 连续 summon 两次 | — | 续做两次（无次数上限） |
| 期间 `cli stop` | — | 不再续做 |

## 六、和单元测试的分工

- `tests/action_resume.test.ts`：in-process 契约测试（事件链路、折算、Stop、次数上限），
  快、能钉住回归；
- 本测试台：接真实游戏/身体，验证“身体被中断时到底返回什么、事件顺序、时间窗口”，
  以及手动模式接线本身。

## 七、已知限制

- 需要本地服务器有控制台/RCON 权限（没有的话只能手动 summon）；
- 手动模式没有会话数据库，`history` 等内置命令不可用（本来就不需要）；
- 测试台的“等结果”依赖 `tool.action.done` 事件；若身体进程崩了，任务会等到超时。
