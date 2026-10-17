# 双 Bot 生存求稳：地下庇护所与烈焰人安全

> 任务：`task-2`（survival-dev）。工作目录 `C:\Users\bobo\mindcraft-ce-overnight`，分支 `overnight/game-clear`。
> 目标：两个 Bot 在生存流程里求稳——天黑前有地下庇护、夜里睡/等在地下、
> 打烈焰人前抗火 Buff 与食物就绪。**先设计状态检查，再实现最小可用版本。**

## 1. 为什么需要"状态检查"这一层

每轮的 Live State 已经给了原始事实：`Environment: time 14000`、`effects fire_resistance 45s`、
`Nearby entities`、`Backpack`。但模型要据此判断"还有多久天黑 / 头顶有没有顶 / 够不够打烈焰人"
仍在做多步心算，实测会算错、漏看。所以把判断收成**纯函数**：

- `src/body/library/survival.ts`：采样 + 评估（纯逻辑，可单测）。
- `src/body/commands/survival.ts`：工具声明（自包含，不依赖对共享入口的改动）。

时间阈值与 edges / live_state 同源：`NIGHT_START = 12542`、`NIGHT_END = 23460`。

## 2. 状态检查工具 `survivalCheck`（只读，不占身体通道）

一次返回模型决策需要的全部派生结论：

| 行 | 内容 |
|---|---|
| 时间 | 白天/夜晚、`timeOfDay`、距天黑/距天亮秒数 |
| 位置 | 当前 y、该列地表 y、（在地下几格） |
| 掩体 | 是否有顶、头顶是什么方块、算不算 `sheltered` |
| 威胁 | 32 格内敌对生物数量与最近一只 |
| 物资 | 床数量、hunger、背包食物份数、抗火 Buff 剩余、库存火抗药水 |
| 就绪 | 地下庇护 是/否；烈焰人准备 是/否（并列出缺件） |
| 建议 | 一句话下一步（seekShelter / sleepUnderground / prepareBlaze / 别硬拼） |

判定口径（`assessSurvival`）：

- `underground = y <= surfaceY - 2`；`roofed = 头顶 2~10 格内首个不透光方块存在`。
- `sheltered = roofed === true && underground !== false`（**读不到头顶方块时是 `null`，不假报安全**）。
- `fireResistReady = Buff >= 45s || 库存火抗药水 > 0`；`foodReady = 食物 >= 2 份`。
- `blazeReady = fireResistReady && foodReady && health >= 6`。

## 3. 提示词注入（`SURVIVAL_POLICY`）

静态文本，追加到 `conversing` 末尾即可（内容不变 → 不破坏前缀缓存）：

```
【生存求稳：天黑、下矿、打烈焰人都按这个来】
- 先看状态再行动：不确定时间/掩体/物资时调 survivalCheck。
- 天黑前：调 seekShelter 找/挖地下庇护所，把床和食物带下去；天黑了调 sleepUnderground。
- 地下庇护要有顶，别站在直通天空的竖井里睡觉。
- 打烈焰人/进下界前：先 prepareBlaze，喝抗火药水、吃饱；Buff 剩不到 45 秒就再调一次。
- 血量低、周围有敌对生物时先撤进掩体，不硬拼。
```

## 4. 动作工具（占身体通道，走 `agent.actions.runAction`）

| 工具 | 超时 | 行为 |
|---|---|---|
| `seekShelter` | 4 min | 已在掩体 → 附近找现成有顶空间 → 往下挖（目标地表下 3 格）→ 朝旁边掏 2 格高有顶的窝。遇到水/岩浆/落差停下并如实说明。 |
| `sleepUnderground` | 12 min | 先确保庇护；有床走 `skills.goToBed` 睡到天亮，没床在地下 `stay` 等到天亮（每 10 秒查一次时间）。白天调它只回报"不用睡"。 |
| `prepareBlaze` | 2 min | 检查并喝下火抗药水（按 NBT 挑 `fire_resistance`，不靠名字猜）、补饱食度，回报"够不够、缺什么"。Buff 快没了再调一次 = 保持 Buff。 |

安全边界：

- 挖/掏前先判 `water/lava/bedrock`，危险方向直接跳过（不挖穿水源/岩浆）。
- `findNearbyCoveredSpot` 只认"脚下有地板、脚/头空、头顶再上一格实心"的空间。
- 复用 skills 原语：`digDown` / `mineBlockAt` / `moveBy` / `goToPosition` / `goToBed` / `stay` / `consume` / `equip`。
- 睡觉拦爆炸：`goToBed` 已有 `sleep_in_bed` 危险操作闸门（下界/末地床会炸）。

## 5. 半自动烈焰人农场安全方案（可选，本轮只落地"Buff/食物就绪 + 规则"）

真正自动化刷怪笼/农场体量太大，本轮不接主循环；先把**安全前提**变成可调用工具：

1. 进地狱前：`prepareBlaze` 确认火抗 Buff 生效、食物满、血量足；火抗按需续。
2. 站位：站在半砖/栅栏围出的平台边缘，只留一格攻击面；脚下不要留岩浆。
3. 交战规则：`health < 6` 或被多只围攻时先退到掩体后（用 `moveAway` / 掩体），不贪刀。
4. Buff 维持：`survivalCheck` 报 Buff 剩 < 45s 时立刻再 `prepareBlaze`。
5. 后续可加 `!blazeFarmGuard`（持续维持 Buff + 低血撤退）——作为独立动作接入现有通道，本文件只保留设计。

## 6. 接入方式（registry 已接入；提示词注入由 lead 统一处理）

`src/body/commands/survival.ts` 导出：

- `survivalQueryList`（含 `!survivalCheck`）
- `survivalActionList`（含 `!seekShelter` / `!sleepUnderground` / `!prepareBlaze`）
- `SURVIVAL_TOOL_TEXT`（可原样合并进 `shared/prompts.ts` 的 `TOOL_TEXT`；不合并也能用，命令描述已自带）
- `SURVIVAL_POLICY`（追加到 `conversing`）

`registry.ts` 已按下面方式接入（本任务内完成）：
```ts
import { survivalQueryList, survivalActionList } from './survival.js';
// GAME_COMMANDS = queryList.concat(survivalQueryList, actionsList, survivalActionList)
// toolDeclarations(): queryList→query、survivalQueryList→query、actionsList→action、survivalActionList→action
```

## 7. 测试

`tests/survival.test.ts`（33 例）：时间边界、火抗药水 NBT 识别、食物/床计数、
`assessSurvival` 各分支（夜晚露天/有顶、就绪/缺件、血量）、`shelterDigDepth`、
采样假身体、`findNearbyCoveredSpot`、`carvePocket` 危险方向拒挖、`prepareBlazeSkill`
喝药+进食、命令声明与 `longRunning` 标记、`SURVIVAL_TOOL_TEXT` 一一对应、**读不到时间时不假报白天/天亮**、以及 **registry 接入契约**（转成声明后大脑侧目录/通道归属/参数校验都认）。
