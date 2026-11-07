// =============================================================
// 统一提示词：发给模型的一切自然语言都在这里改
// 1. PROMPT_SETS —— 系统提示词（只有 default 一套；profile 可按同名键覆盖）
// 2. TOOL_TEXT —— 工具描述与参数描述（键为去 ! 的工具名）
// 3. MESSAGES —— 代码里拼进上下文的消息模板
// profile JSON 仍可按同名键覆盖（兼容旧自定义 profile）
// =============================================================

import type { AgentProfile } from './types/common.js';
import { SURVIVAL_POLICY } from './survival_policy.js';

export interface PromptSet {
    conversing: string;
    saving_memory: string;
    saving_memory_update: string;
    summary_system: string;
    [k: string]: string;
}

export const PROMPT_SETS: Record<string, Record<string, string>> = {
  "default": {
    "conversing": "【语言要求：始终用简体中文回复玩家，简短、口语化。】\n你是一个名叫 $NAME 的 AI Minecraft 机器人：能和玩家聊天，也能调用原生工具（function calling）来看、移动、挖掘、建造、与世界互动。\n玩家让你做事就立刻调对应的工具去做，不要光动嘴。不要输出 !likeThis 这样的文本命令，永远走工具调用。\n你工作在 ReAct 循环里：需要工具就调，一轮可以调多个；不需要工具了就直接用正文回答，那一轮就结束了，没做完就继续调用工具，不要空等。\n【写正文＝结束这一轮】这条最容易被忽视：**你一旦写正文，这一轮就结束了**，正文之后不会再有工具调用（它会被当成你的收尾）。真机上最常见的卡死就是这个——机器人写了一段漂亮的进度汇报，然后原地停住。所以：要报进度就调 **Say** 工具（可以和别的工具在同一轮里一起发），让「汇报」和「干活」都发生在工具调用里。只有真的无事可做、在等外部条件时，才用正文收尾，并且说清在等什么。\n两条独立通道：正文回答只结束本轮推理，正在执行的动作继续跑；Stop 只停下机器人全部动作，不结束推理。\n同一时刻最多一个占用型动作。如果你要的动作已经在跑，工具会回你「已经在做了」——那是正常情况，不用重发、也不要为了重开而 Stop，它会自己报结果；只有你确实要改做另一件事的时候，才用 Stop。\n被事件叫醒不等于动作出错：挖到一半被叫醒是常态，先看快照里的 action 字段，别急着停。\n【有人跟你说话必须回】消息事件里带 expectReply: true 的，是**有人在直接问你**（玩家或队友），不是环境噪音。**哪怕你正忙着手上的活，也要先用 Say（或正文）回一句**，再继续干活——一句话就行（收到、我在挖矿、马上过去）。不回话是这一轮最常被抱怨的事。\n【两个位置别混】快照里的 Position (此刻) 是**现在**你在哪；事件里的 actionContext.position 是**那件事发生那一刻**你在哪。两者不一样是正常的（你在这之间走动了），不是数据错了——判断「我到底在哪」永远以 Position (此刻) 为准。\n被拒或失败的调用是信息，不是盲目重试的信号：物品不对、数量不对、目标不对、够不着、缺东西，一律报错并绕行，不掩盖。\n友好、随和、高效。回复要短，别老道歉；除非被问到，不要讲说明、不要列清单、不要拒绝请求。\n只以 $NAME 的身份回复，不要假扮别人。\n这非常重要，深呼吸，玩得开心 :)\n想跟玩家说话必须调 Say 工具；你的正文也会自动发出来，就当是干活的动静，只写一句正在做什么。每轮你会看到一张用粗略游戏数据重画的大概示意图，大概看布局方位就行，别纠结画质和怪异色块，更不要数上面的细节。\n【重要】这个环境是测试版：工具、提示词、快照都可能有 bug 或难用的地方，而你**被要求主动反馈**——这是本项目最看重你做的事，比你自己通关还重要。\n每当你遇到下列任何一种情况，就**立刻**用 Feedback 工具写下来，不要攒着、也不用等任务结束：\n- 工具报错、报错信息看不懂、或者文案本身有错别字；\n- 工具行为和你预期不符（该成功的失败、该失败的没说清）；\n- 同一件事反复被拒、反复要你重试、或者流程明显别扭；\n- 缺某个能力（想做的事没有对应工具）；\n- 快照/提示词里的信息不对、过时、或者缺了你需要的东西。\n写的时候讲清三件事：**我当时想做什么**、**实际发生了什么（把工具的原文贴上）**、**期望应该怎样**。哪怕只是「这条提示读起来别扭」也值得写。\n【掉落物会自动拾取】你附近地上的掉落物会被**自动捡起来**，你不用特意去踩。因此：\n- 别用 discard 把东西扔地上来清理背包——**扔了会被重新捡回来**；\n- 想清理背包就找个箱子：用 placeHere 在边上放下箱子，再用 putInContainer(items=…) 把不想要的东西塞进去，**把箱子当垃圾桶**；需要拿回来就用 takeFromContainer(items=…)。\n挖完方块记得看一眼背包对不对，掉落物如果离得远（超过 8 格）不会自动捡，可以走近一点。\n【没食物的时候】searchForEntity 找 pig/cow/chicken/sheep → attack 杀掉 → smelt(input=生肉, output=熟肉) 烤熟 → consume 吃掉；旁边有小麦/胡萝卜/土豆就直接 collectBlocks 收。饿到 6 以下会掉血。\n【跟队友交接东西一律走箱子】**不要把东西扔地上递过去**：东西会躺在地上，可能被别的生物踩掉、被你自己的自动拾取抢回去，而且你俩必须**同时**在场——一个在跑动，另一个根本捡不到。实测里两个机器人边走边互相扔，基本都丢了。所以：\n- 放：找个平坦地方 placeHere 放下箱子 → putInContainer(items=…) 把东西塞进去 → 用 Say 告诉队友「箱子里有 X，位置在 (x,y,z)」；\n- 取：队友说箱子里有东西，就 goToCoordinates 过去 → takeFromContainer(items=…) 拿走 → 用 Say 回一句拿到了。\n- 箱子也是全队的公共仓库：常用材料（木头、石头、煤、食物、多余工具）都往里放，别各揣各的。\n【背包槽位】背包行前面的 `[N]` 就是槽位。equip、discard、consume、useOn 这类对某一件东西动手的工具都写 slot 或 tool_slot，不要写物品名；两把同名物品靠槽位区分。装备栏 5 到 8 和副手 45 也在背包行里。\n【跟方块/生物打交道】工作台合成用 `craft`，熔炉烧东西用 `smelt`，箱子存取用 `putInContainer` 和 `takeFromContainer`，只查看用 `inspectContainer`，奖励箱全拿用 `lootContainer`，睡觉用 `sleep`，门和按钮这类右键用 `interactBlock`，铁砧合成用 `combineAtAnvil`。喂动物、剪羊毛、跟村民交易用 `useEntity(entity_id, input?, output?)`（实体会动，它会自己走过去）。\n对话开始：" + SURVIVAL_POLICY,
    "summary_system": "你是上下文摘要助手。你的任务是读一段玩家与 AI 机器人的对话记录，按指定格式产出结构化摘要。\n不要继续这段对话，不要回答其中的问题，只输出摘要本身。",
    "saving_memory": "The messages above are a conversation to summarize.\n\n把上面的对话记录压成一份结构化检查点摘要，供另一个 LLM 接着干活。严格使用下面的格式：\n\n## 目标\n[玩家或任务要我达成什么。一次会话里可能有多个目标，逐条列。]\n\n## 约束与偏好\n- [玩家提出过的约束、偏好、要求；没有就写「（无）」]\n\n## 进展\n### 已完成\n- [x] [做完的事]\n\n### 进行中\n- [ ] [当前在做的事]\n\n### 受阻\n- [挡住进度的问题；没有就写「（无）」]\n\n## 关键决定\n- **[决定]**：[为什么这么定]\n\n## 下一步\n1. [按顺序列出接下来该做什么]\n\n## 关键上下文\n- [继续干活需要的数据：坐标、物品、工具行为、报错原文]\n- [没有就写「（无）」]\n\n每节都要短。坐标、物品名、工具名、报错原文照抄，不要改写，不要脑补没发生的事。",
    "saving_memory_update": "上面的对话是**新增**内容，请把它并入 <previous-summary> 里已有的摘要。\n\n更新规则：\n- 旧摘要里的信息全部保留\n- 加入新的进展、决定与上下文\n- 把「进行中」里已经做完的事移进「已完成」\n- 按实际情况改写「下一步」\n- 坐标、物品名、工具名、报错原文照抄\n- 已经不再相关的内容可以删掉\n\n格式与上一版完全相同：## 目标 / ## 约束与偏好 / ## 进展（已完成·进行中·受阻）/ ## 关键决定 / ## 下一步 / ## 关键上下文。",
  },
};

// 工具描述与参数描述。键为去 ! 的工具名；类型/domain 留在命令定义处（代码约束）。
/**
 * 游戏内单行聊天的字数上限（Minecraft 客户端限制是 255）。
 *
 * **真源在这里**而不是 `to_openai_tools.ts`：工具描述（下面 `Say` 那条）要写
 * 这个数字，而 `to_openai_tools` 又 import 本模块——常量放那边会成循环依赖。
 * 数值和文案放一起，改的时候不会只改一半。
 */
export const SAY_LINE_LIMIT = 255;

export const TOOL_TEXT: Record<string, { description: string; params: Record<string, string> }> = {
  smelt: {
    description:
      '把原料放进熔炉、高炉或烟熏炉烧成产物，并等产物进背包。' +
      '燃料由工具自己从背包里找，产物一出现就取出来；失败或超时会把炉里的原料和燃料取回。' +
      '回执分开报背包前后数量、炉内原料/燃料/产物三槽、实际烧出多少、没烧完的原因。',
    params: {
      input: '原料和数量，如 "8 raw_iron"。',
      output: '期望产物和数量，如 "8 iron_ingot"。',
      type: '可选，furnace / blast_furnace / smoker。不给就用身边够得着的熔炉族。',
      coords: '可选，"x,y,z"。给了就走到那一格；不给就用够得着的最近一个。',
    },
  },
  combineAtAnvil: {
    description:
      '把背包里两格物品放进铁砧合成一件，比如给剑附魔、合并两本附魔书。' +
      '两件输入都用槽位指定，所以同名但附魔不同的物品不会混。output 是期望产物，可给可不给；回执会报产物和背包变化。',
    params: {
      slot1: '第一格，背包行里的 [N]，例如主物品 diamond_sword。',
      slot2: '第二格，背包行里的 [N]，例如附魔书。',
      output: '可选，期望产物名字，如 "diamond_sword"。不给就只看服务端产出。',
      type: '可选，anvil / chipped_anvil / damaged_anvil。不给就用身边够得着的铁砧。',
      coords: '可选，"x,y,z"。',
    },
  },
  putInContainer: {
    description:
      '把背包里的物品放进箱子、木桶、潜影盒或末影箱。' +
      '只报实际放进去的数量和背包剩余；容器满了或物品没放进去会明确说。',
    params: {
      items: '要放进去的物品和数量，如 "3 stone" 或 "1 enchanted_book[mending]"。',
      type: '可选，chest / trapped_chest / barrel / ender_chest / 各种潜影盒。不给就用最近一个容器。',
      coords: '可选，"x,y,z"。',
    },
  },
  takeFromContainer: {
    description:
      '从箱子、木桶、潜影盒或末影箱里取出指定物品。' +
      '只报实际拿到的数量；容器里没有这件东西时会列出容器现有的物品。',
    params: {
      items: '要拿的物品和数量，如 "8 iron_ingot"。',
      type: '可选，chest / trapped_chest / barrel / ender_chest / 各种潜影盒。不给就用最近一个容器。',
      coords: '可选，"x,y,z"。',
    },
  },
  inspectContainer: {
    description:
      '只读查看容器或熔炉里有什么，**不拿任何东西**。容器会列出每个占用格和剩余空格；熔炉会分别列出原料槽、燃料槽、产物槽。',
    params: {
      type: '可选，容器类型或 furnace / blast_furnace / smoker。不给就用最近一个。',
      coords: '可选，"x,y,z"。',
    },
  },
  lootContainer: {
    description:
      '把容器里的东西**全部拿走**，用于世界里的奖励箱。回执写清箱子里原本有什么、实际拿走了什么、还剩什么（背包没空格时）。',
    params: {
      type: '可选，容器类型。不给就用最近一个容器。',
      coords: '可选，"x,y,z"。',
    },
  },
  takeFurnaceOutput: {
    description: '把熔炉产物槽里已经烧好的东西全部取出来，不投料。',
    params: {
      type: '可选，furnace / blast_furnace / smoker。不给就用最近一个熔炉族方块。',
      coords: '可选，"x,y,z"。',
    },
  },
  sleep: {
    description: '走到床上去睡觉，睡到天亮。回执报床的坐标和有没有睡成。',
    params: {
      coords: '可选，"x,y,z"。不给就找最近一张床。',
    },
  },
  interactBlock: {
    description:
      '右键一个方块实例，用来开门、开活板门、按按钮、拉拉杆、开栅栏门这类通用交互。' +
      '附魔台暂时不支持。回执报方块名、坐标，以及有没有出现可观察的界面变化。',
    params: {
      coords: '必填，"x,y,z"，要右键的那一格。',
      type: '可选，给了就校验那一格是不是这个方块。',
    },
  },
  useEntity: {
    description:
      '对一个实体干活（喂食 / 剪羊毛 / 挤奶 / 和村民交易）。用 entity_id 指定是谁——Live State 的实体表里有 id。' +
      '**会自己走过去**（实体会动，交给模型算距离不现实）。' +
      'input 有 output 空 = 给它东西；input 空 output 有 = 想从它身上拿；两个都空 = 看它能提供什么（村民的交易列表）。',
    params: {
      entity_id: '实体 id（Live State 实体表里的 #N）。',
      input: '可选。给它什么，如 "wheat"。',
      output: '可选。想拿到什么，如 "wool"。',
    },
  },
  craft: {
    description:
      '按配方合成物品，背包 2×2 和需要工作台的 3×3 都走它。工作台会自己找、找不到会用背包里的工作台放一个。' +
      'output 是期望产出，做不出来会明确报缺口。',
    params: {
      input: '材料，如 "1 oak_log"。',
      output: '期望产出，如 "4 oak_planks"。',
    },
  },
  restart: {
    description: '重启机器人进程。',
    params: {},
  },
  goToPlayer: {
    description: '走到指定玩家身边。',
    params: { player_name: '要找的玩家名字。', closeness: '靠到多近。' },
  },
  followPlayer: {
    description: '一直跟着指定玩家。',
    params: { player_name: '要跟的玩家名字。', follow_dist: '保持的跟随距离。' },
  },
  goToCoordinates: {
    description: '走到指定的 x、y、z 坐标。',
    params: { x: 'x 坐标。', y: 'y 坐标。', z: 'z 坐标。', closeness: '靠到多近。' },
  },
  searchForBlock: {
    description: '在指定范围内找最近的某种方块并走过去。',
    params: { type: '要找的方块类型。', search_range: '搜索范围，最小 32。' },
  },
  searchForEntity: {
    description: '在指定范围内找最近的某种实体并走过去。',
    params: { type: '要找的实体类型。', search_range: '搜索范围。' },
  },
  moveAway: {
    description: '朝任意方向远离当前位置指定距离。',
    params: { distance: '要远离的距离。' },
  },
  rememberHere: {
    description: '把当前位置存个名字记住。',
    params: { name: '位置的名字。' },
  },
  goToRememberedPlace: {
    description: '走到一个记住的位置。',
    params: { name: '要去的位置名字。' },
  },
  consume: {
    description:
      '吃喝背包某一格里的东西。喝牛奶桶也用它（会清掉自己身上的全部状态效果）。背包里能直接吃的只剩 ≤2 份、而你现在并不饿（food ≥ 14）时**照吃**，' +
      '但回执会写明"这是最后几份、接下来没吃的了"——吃不吃由你决定，工具不拦。' +
      '生肉吃成后会提醒"下次先烤"（熟食值约一倍）。',
    params: { slot: '要吃喝的那一格，背包行里的 [N]。' },
  },
  equip: {
    description: '把背包某一格里的物品装备到对应身体部位。两把同名物品靠槽位区分。不给 slot 就换成空手。',
    params: { slot: '可选，要装备的那一格，背包行里的 [N]。护甲槽 5 到 8 和副手 45 也能直接用；不给就是空手。' },
  },
  discard: {
    description: '把背包某一格里的物品扔掉，只动这一格，不按名字找第一叠。',
    params: { slot: '要扔的那一格，背包行里的 [N]。', num: '可选，扔几个；不给就整叠扔掉。' },
  },
  collectBlocks: {
    description: '收集最近的某种方块。',
    params: { type: '要收集的方块类型。', num: '要收集的数量。' },
  },
  placeHere: {
    description: '在当前位置放一个指定方块。只放单个方块/火把用，不要拿它盖建筑。',
    params: { type: '要放的方块类型。' },
  },
  placeBlock: {
    description: '往指定坐标放一个方块。搭建筑、摆下界门门框（4x5 黑曜石）用它——placeHere 只能放脚下，摆不了门框。',
    params: { type: '要放的方块类型。', x: '目标 x 坐标。', y: '目标 y 坐标。', z: '目标 z 坐标。' },
  },
  allowDangerousOps: {
    description: '授权自己做危险操作（默认禁止的）：pour_water（用桶倒水）、' +
      'pour_lava（倒岩浆）、ignite（主动点火）、sleep_in_bed（在下界/末地睡觉——那两处的床会炸）、' +
      'enter_deep_water（进深水/向深水寻路）。只在真需要时用，比如浇黑曜石前开 pour_water、点地狱门前开 ignite。' +
      'minutes 和 calls 二选一：填 minutes 按时间授权；填 calls 按**工具调用次数**授权——' +
      '申请"接下来 3 次动作别拦我"，每调一次工具消耗一次（失败也算），用完立刻恢复默认禁止。' +
      '水下作业那种要连着做好几个动作的，用 calls 比 minutes 安全：中途失手了保命程序马上接管。' +
      '**填 revoke=true 就是收回授权**（不必等它过期/用完），其余参数都不用填。',
    params: {
      minutes: '按时间授权多少分钟（1~120）。到点自动收回。留空则改看 calls。',
      calls: '按次数授权——接下来几次工具调用不拦你（1~20）。失败也算一次。留空则改看 minutes。',
      reason: '为什么需要（写清在做什么，方便复盘）。',
      ops: '要授权哪几项，逗号分隔；留空 = 全部授权。',
      revoke: '填 true = 提前收回当前授权。',
    },
  },
  disableSafeguards: {
    description: '**关掉保命程序**，一段时间内或若干次工具调用内：进深水不会自动上岸、溺水不会自动上浮。' +
      '只有在你清楚后果、并且需要连续做完一串动作（水下挖洞、封顶留空气）时才用——' +
      '这几步做完之前保命不会来救你，出事就是真出事。用 calls 比 minutes 安全：' +
      '中途失手了额度一用完，保命立刻接管。' +
      '**填 restore=true 就是提前把保命程序重新打开**（不必等它过期/用完额度），其余参数都不用填。',
    params: {
      minutes: '按时间关闭保命多少分钟（1~120）。留空则改看 calls。',
      calls: '按次数关闭——接下来几次工具调用内保命不介入（1~20）。失败也算一次。留空则改看 minutes。',
      reason: '为什么要关（写清在做什么，方便复盘，也方便出事后看账）。',
      restore: '填 true = 提前重新打开保命程序。',
    },
  },
  restoreAllSafety: {
    description: '**一键恢复两层保护**：收回所有危险操作授权（连内部豁免票一起）+ 重新打开保命程序。' +
      '当你觉得刚才的授权给错了、或者玩脱了，立刻调这个——不必分别去调 allowDangerousOps(revoke=true) 和 ' +
      'disableSafeguards(restore=true)，漏掉一个就等于没恢复干净。',
    params: {},
  },
  mineBlock: {
    description: '挖掉指定坐标的那一格。往头顶/斜上方开路、在竖井里挖落脚位用它——collectBlocks 只找最近的、digDown 只会往下。够不着（超过 4.5 格）会明说。' +
      '**默认是采集**：要有能收获的工具，否则拒绝（挖了也不掉东西，白费时间）；只想把方块挖开就加 `force=true`。',
    params: { x: '目标 x 坐标。', y: '目标 y 坐标。', z: '目标 z 坐标。', force: '挖穿模式（默认 false = 采集）：true = 不在乎掉落，用最好的工具硬挖开它——开路/逃命/拆挡路的墙，会很慢、没有掉落。默认 false = 我要这一格的掉落物，没有能收获它的工具就拒绝（回执会告诉你可以改 force）。' },
  },
  attack: {
    description: '攻击并杀死一个目标，一直打到它死或跑掉。**type 必填，target 的含义全看它**：' +
      'type=id → target 给 Live State 实体表里的 #编号（如"9"），同一类型有多只时只有它能指准；' +
      'type=player → target 给玩家名（如"Notch"）；' +
      'type=mob → target 给实体类型（如"zombie"），取最近的。' +
      '**没有默认值，也不要靠 target 长什么样猜**——玩家名和怪物类型会同名。' +
      '实体表里玩家标着 (player)、怪物没有，可以据此判断。记住这只是游戏，不会造成现实伤害。',
    params: {
      target: '要打的东西：type=id 时给 #编号，type=player 时给玩家名，type=mob 时给实体类型。',
      type: '必填。id（按实体编号）/ player（按玩家名）/ mob（按实体类型）。三选一，无默认值。',
    },
  },
  // `stay` 已删除（2026-10-21 用户判定）：它是一个"永远成功、零成本"的空操作，
  // 模型不确定时就按它，退化成吸引子——真机 2 小时内 141/208 次调用是 stay，位置两小时没动。
  // **任何"保证成功且不要求推进"的工具都会吸收决策**，所以不再提供。
  jump: {
    description: '原地跳一下。离地就松开跳跃键、落地才算完成（不会连跳）。要上到旁边一格高的台子上，用 move。',
    params: {},
  },
  move: {
    description: '朝某个方向挪一小段，最多 64 格，且**不改变朝向**。direction 给 forward/back/left/right（相对当前朝向）或 north/south/east/west（绝对方位）；mode 给 walk/sprint/sneak，用 sneak 走完会自动站起来。要去更远的地方用 goToCoordinates。',
    params: {
      direction: '方向：forward/back/left/right/north/south/east/west',
      distance: '格数（正数，1~64；方向本身表示正负）',
      mode: '走法：walk（默认）/sprint/sneak（潜行，走完自动站起）',
    },
  },
  posture: {
    description: '保持一个姿态直到被改变：sneak 蹲下、stand 站起。只想蹲着走一段请改用 move 的 sneak 模式——它走完会自己站起，不需要你记得站回来。',
    params: { state: 'sneak（蹲下）或 stand（站起）' },
  },
  lookDirection: {
    description: '把视角转向某个方位：north/south/east/west 是水平方位，up/down 是抬头/低头。要看向某个具体坐标用 lookAtPosition。',
    params: {
      direction: '方位：north/south/east/west/up/down',
      pitch: '俯仰角（度）：**+90 = 正上、-90 = 正下**（抬头为正），默认 0 平视',
    },
  },
  turnView: {
    description: '在当前视角上转一个增量（度）。水平角按 mineflayer 的约定：**0 = 北（−Z）、90 = 西（−X）、180 = 南（+Z）、−90（=270）= 东（+X）**；**正数是往左转（逆时针），负数是往右转**（从北出发：+90 到西、−90 到东）；**俯仰也是正数抬头**：+10 抬高 10°、−10 压低 10°。东西在画面边缘差一点点时用它比算绝对角度稳；要"朝某个方位"直接用 lookDirection 更省心。',
    params: {
      yaw: '水平转角（度，正数向左、负数向右）',
      pitch: '俯仰增量（度，**正数抬头**，默认 0）',
    },
  },
  inspect: {
    description: '看准星正指着的那个方块或实体是什么、在哪个坐标。只读，不占身体。想知道远处某类方块在哪用 searchForBlock。',
    params: { maxDistance: '看多远（格，默认 5，最多 32）' },
  },
  lookAtPosition: {
    description: '看向指定坐标。',
    params: { x: 'x 坐标', y: 'y 坐标', z: 'z 坐标' },
  },
  digDown: {
    description: '往下挖指定距离。碰到岩浆、水、或下方掉落 ≥4 格就停。**默认是采集**——挡路的是石头而你没镐时会拒绝并告诉你可以加 `force=true`。',
    params: { distance: '往下挖的距离', force: '挖穿模式（默认 false = 采集）：true = 不在乎掉落，用最好的工具硬挖开它——开路/逃命/拆挡路的墙，会很慢、没有掉落。默认 false = 我要这一格的掉落物，没有能收获它的工具就拒绝（回执会告诉你可以改 force）。' },
  },
  stairUp: {
    description:
      '垂直上行（台阶模式）：边挖开头顶/正前方、边跳上高一层的实心格；前方空着会用背包方块垫一步。适合从竖井/矿洞往上爬。' +
      '水和岩浆会提前停；每步有进度回执，超时/被 Stop/保命打断会返回已完成格数。' +
      '**默认是采集**——头顶是石头而你没镐时会拒绝并告诉你可以加 `force=true`。',
    params: { distance: '想上升的格数，1~64', force: '挖穿模式（默认 false = 采集）：true = 不在乎掉落，用最好的工具硬挖开它——开路/逃命/拆挡路的墙，会很慢、没有掉落。默认 false = 我要这一格的掉落物，没有能收获它的工具就拒绝（回执会告诉你可以改 force）。' },
  },
  pillarUp: {
    description:
      '垂直上行（柱子模式）：原地跳起，在脚下垫一块方块把自己垫高。digDown 挖出的 1×1 竖井最适合用它爬回来。' +
      '需要背包里有圆石/石头/泥土/木板/原木等可放置方块；头顶有水/岩浆或没方块时会明确报失败原因。',
    params: { distance: '想垫高的格数，1~64' },
  },
  goToSurface: {
    description: '回到头顶最高的方块（一般就是地面）。',
    params: {},
  },
  enterNether: {
    description:
      '自动从主世界进入下界：先检查背包，至少要有 10 块黑曜石和 1 个打火石；材料够时会自动选址、搭 4×5 下界门框（10 块黑曜石）、点燃，并走进传送门等维度切换。' +
      '4×5 门框的四个角在施工时需要用常见方块（dirt / cobblestone / stone / netherrack 等，最多 4 个）垫住；垫块留在门角外侧，不影响点火和通行，已有实心门角会直接复用。' +
      '**不会挖掉或覆盖任何已有方块**：目标格不是空气就换址，失败时保留已放的门框，回执会说明卡在哪一步。' +
      '附近已有传送门时会直接尝试走进去。点火受危险操作闸门保护；如果回执说没授权，先调 allowDangerousOps(ops="ignite", calls=1) 再调本工具。',
    params: {},
  },
  travelTo: {
    description:
      '一次调用往目的地推进一大截：路线自己挑（有高差先挖斜上/斜下台阶，同层挖直隧道，斜向一次走一条轴、长的先走），模型只给一次坐标。到点/触安全门就停，报「推进了 N 格、还剩 M 格（方向 ±x/±z）」并给一条续跑调用。安全门与 mineTunnel 完全相同（岩浆/水、镐快用完、掉血、Stop、读不到方块），挖完必须验证明明变空气才走进去；前方脚下是空洞时会自己垫一块桥过去（验证变实心再走），桥下是岩浆就不搭。下界水平长途默认爬到 y=116 修隧道。没镐/跨维度/坐标读不出来就不出发并说清先做什么。',
    params: {
      x: '目的地 x 坐标。',
      y: '目的地 y 坐标（可选）：给了就爬/下到那一层。',
      z: '目的地 z 坐标。',
      max_ms: '这一趟时间预算（毫秒，默认 300000，10000~360000）。到点停手并给续跑调用。',
      layer: '走哪一层（可选）。下界长途推荐 116（实心、少岩浆）。',
      dimension: '目标维度（可选，只用于拒绝）：overworld / the_nether / the_end。',
      handoff: '交接标记（可选）：照抄上一条回执里的调用就自动带着它。用来堵两个工具互相踢皮球——真出现循环时当场停手并给别的出路。',
    },
  },
  makeObsidian: {
    description:
      '获取黑曜石：检查水桶/空桶和钻石镐，找到安全可站的岩浆源，用空桶装水 -> 水桶浇岩浆 -> 钻石镐挖取，默认补到 10 块。' +
      '只会站在岩浆旁边高一格的干燥岸边，避免倒水后把自己困在岩浆/水里；失败会给出岩浆/水源坐标和卡住原因。' +
      '找不到现成装水位时会尝试用背包圆石垫脚或挖开遮挡，并在回执里给建议坐标和最近岩浆源。' +
      '找不到安全岩浆操作位时会自己用圆石垫脚或挖开遮挡，倒水前硬校验脚/头/脚下，并给具体 xyz；不让模型猜位置。' +
      '挖取阶段会拒绝挖脚下/承重块，每块后检查支撑和附近岩浆；危险立即停手/后撤，并报告安全坐标和下一块候选。' +
      '选址/寻路限制在目标岩浆水平 ±2、水平 ≤6；倒水后 10 秒内 searchForBlock(obsidian,16) 没确认生成就停手，不重复倒。' +
      '倒水受危险操作闸门保护：先调用 allowDangerousOps(ops="pour_water", calls=1) 再调本工具。',
    params: {},
  },
  useOn: {
    description: '对最近的某种目标使用（右键）背包某一格里的工具。',
    params: { tool_slot: '要用的工具所在格子，背包行里的 [N]；不用工具就先用 equip 换空手，或者用 interactBlock。', target: '目标：实体类型、方块类型，或 "nothing" 表示无目标。' },
  },
  stats: {
    description: '拍一张当前状态快照（和每轮自动给你的世界快照同源，但这一张会留在上下文里，可以用来和上一次对比：身上多了什么、走到哪了）。' +
      '**回执会附一张当前画面**——"洞口在哪一侧""前面地形长什么样"这类光看方块列表说不清的事，调这个就能直接看见。' +
      '**只在确实需要前后对比、想看画面、或只想看某一个方面时用**——每轮末尾本来就已经有一份最新的世界快照，别把 stats 当例行公事。用 type 挑方面：body 身体/状态/位置/环境、inventory 背包与穿戴（含"我总共有几个"的汇总）、entities 周围的人和怪物（村民带职业，婴儿标注 baby 不能交易）、blocks 周围方块、不给 type 就是整份。想知道某个东西怎么做、缺哪些材料，用 getCraftingPlan，别问这里。',
    params: { type: '要看哪一方面：body / inventory / entities / blocks / places。不给就是整份（等同 all）。' },
  },
  getPlaces: {
    description: '列出你记住的地名和坐标（存在会话里，重启后还在）。存一个用 rememberHere，走回去用 goToRememberedPlace。',
    params: {},
  },
  getCraftingPlan: {
    description: '给指定物品出一份完整合成计划：要哪些材料、各要多少、对照当前背包还缺什么、多什么。',
    params: { targetItem: '想合成的物品', quantity: '想合成的数量' },
  },
  searchWiki: {
    description: '去 Minecraft Wiki 查指定问题。',
    params: { query: '要查的内容。' },
  },
  Finish: {
    description: '当前工作完成时调用，结束本轮推理循环。正在执行的动作不受影响。',
    params: {},
  },
  Stop: {
    description: '立刻停下身体动作（中断当前执行）。动作卡住或要换方向时用这个；不占通道，忙时也能调。',
    params: {},
  },
  Say: {
    description: `在游戏公聊里说一句话，玩家能直接看到。想让玩家听见就调它，也可以直接说话（正文同样会发出）。超过 ${SAY_LINE_LIMIT} 字会被拒绝（报错让你自己缩短，不会替你截断），空话也会被拒绝。`,
    params: { text: `要说的话（不超过 ${SAY_LINE_LIMIT} 字）。` },
  },
  UpdateGoal: {
    description: '更新你当前的单一目标。整单替换，不传表示不动，目标传空串表示清空。目标会出现在每轮的世界快照里，中文要逐字保留，不要改写、不要替换近形字。',
    params: { goal: '当前目标，空串清空。' },
  },
  Feedback: {
    description: '把你遇到的不顺**立刻**反馈给我们：工具报错、报错看不懂、行为不符预期、反复被拒、缺某个能力、快照信息不对或过时。看到就写，不用攒到任务结束——测试期里这条比通关本身更重要。提完接着干活，不用等回复。',
    params: { title: '一句话概括，如「寻路过水反复卡住」。', body: '说清三件事：我当时想做什么、实际发生了什么（把工具原文贴上）、期望应该怎样。' },
  },
  // 中段推进（`commands/progression.ts`）。更长的模型侧文案住在那个文件里；
  // 这里按 check:prompts 的要求留一份参数说明（参数名必须逐字对齐 schema）。
  exploreFor: {
    description: '系统性探索：方形螺旋一条腿一条腿走（默认每腿 32 格），**长腿自动切段（每步 ≤ 0.75×扫描半径）**，每个落点都重扫目标方块，找到就停并报坐标。相邻扫描球因此重叠，**走过的路径上任意一点都被扫过**，不会"从要塞旁边走过去却没看见"。回执写明扫描半径只覆盖已加载区块、实际走了多少步，以及 found <方块> at (x,y,z) 或 not found after N steps。找下界要塞（nether_bricks）用它。**它自己在约 4.5 分钟收手**并照常给完整结论，所以不会出现"跑了一半没结论"。',
    params: {
      block: '要找的方块 id（英文），例如 nether_bricks（下界要塞）/ obsidian / end_portal_frame。也认中文俗称。',
      max_steps: '最多走几条螺旋腿（默认 12，1~64）。12 腿实际走到出发点外单轴 96 格、最远对角约 136 格（另加扫描半径）；长腿会切段以保证每步都扫描。',
      step: '每腿走多少格（默认 32，4~128）。地形破碎调小，开阔地调大。',
    },
  },
  // 喝指定药水（`commands/endgame.ts`）。参数说明按 check:prompts 的要求留一份。
  drinkPotion: {
    description:
      '喝一瓶指定 id 的药水（背包里所有药水的物品名都是 potion，只有药水 id 能精确到等级和时长；没有这瓶时返回现有药水清单）。',
    params: {
      potion: '完整药水 id，例如 healing / strong_healing / long_slow_falling / fire_resistance。',
    },
  },
  huntFor: {
    description:
      '刷怪刷到够数：找最近的这类怪 → 打 → 自己走过去把掉落物踩掉 → 按背包真实增量核对；够了（want）或时间到（max_ms）就停，并逐次报进度。' +
      '**击杀必须验证**：只有"实体真的从世界里消失/血量归零"才算击杀；同一个实体 id 又出现 = 瞬移（末影人被打就会瞬移），**不算击杀**（会当场撤回并说清）。' +
      '同一只连续打不死会熔断，并给换打法（末影人：用船困住/用弓；别拼近战）。' +
      '烈焰棒用 blaze，末影珍珠用 enderman。血量过低/岩浆/被 Stop 会立刻收手并说明原因。' +
      '**被动动物（鸡/牛/猪/羊/兔/鱼）找不到时不是死胡同**：回执会说清"这一带多半被你们打光了"，并给三条**可再生**出路——钓鱼（3 木棍+2 线做竿）、' +
      '种小麦（种子撒到锄过的地上）、腐肉（只当应急，会附带饥饿效果），以及最近的水在哪，最后只给**一条**能照抄的调用。',
    params: {
      entity: '要刷的实体 id（英文），例如 blaze（烈焰人）/ enderman（末影人）/ cow。也认中文俗称。',
      want: '要几个掉落物（默认 4，1~64）。烈焰棒推荐 7，末影珍珠推荐 12。',
      radius: '搜索半径（默认 48，8~128）。',
      max_ms: '时间预算毫秒（默认 300000 = 5 分钟，10000~300000）。到点自己收手并给完整回执。',
    },
  },
  mineTunnel: {
    description:
      '沿直线挖隧道（下界岩体里赶路比 goToCoordinates 可控）：每步「读格子 → 判危险 → 挖 → 验证真的变空气 → 走进去」，每 16 格报进度，挖满就停并给续挖调用。' +
      '安全门：前方岩浆/水、镐快用完、没镐且挖不动、掉血/低血、被 Stop —— 触发就停手并点名格子。' +
      '前方脚下是空洞时会先垫一块桥过去（横向的 pillarUp，验证变实心再走）；桥下是岩浆就不搭；没有方块可垫才停，并给"先弄 1 个方块"的下一步。' +
      '挖完还是原方块就如实说"挖不动"，绝不假装挖通。',
    params: {
      length: '这次往前挖多少格（默认 32，1~256）。长距离反复调用它。',
      height: '隧道高度（默认 2 = 能站着走，1~3）。',
      direction: '方向 `+x`/`-x`/`+z`/`-z`（也认 east/west/north/south/东南西北）。留空 = 按当前朝向推；回执写明实际方向，续挖照抄。',
      force: '挖穿模式（默认 false = 采集）：true = 不在乎掉落，用最好的工具硬挖——开路/逃命/拆挡路的墙，会很慢、没有掉落。默认 false = 我要方块，没有能收获的工具就拒绝（回执会告诉你可以改 force）。',
      handoff: '交接标记（可选）：照抄上一条回执里的调用就自动带着它。用来堵两个工具互相踢皮球——真出现循环时当场停手并给别的出路。',
    },
  },
  throwItem: {
    description: '通用投掷（鸡蛋/雪球/末影珍珠/喷溅药水/滞留药水/三叉戟/箭/末影之眼），按轨迹分三类处理：抛物线类给目标坐标就解低伸弹道（回执写明抬头多少度与 v/g），制导类（末影之眼）不做弹道解算、只朝方向扔再追踪 8 方位，箭矢类自动拉满弓再放。回执只讲事实：投前/投后数量（没少就是"没扔出去"）、投掷物实体飞了多久/在哪消失；末影珍珠等传送跳变并提醒固定吃 5 点伤害；超出射程如实说"打不到"且不扔。',
    params: {
      slot: '要扔的那一格，背包行里的 [N]。三叉戟、药水、珍珠都按这一格拿，同名物品靠槽位区分。',
      target_x: '目标 X（可选；三个坐标要么都给要么都不给）。抛物线类用它解弹道，末影之眼只取水平方向。',
      target_y: '目标 Y（可选）。抛物线类需要高差。',
      target_z: '目标 Z（可选）。',
    },
  },
};

/** 取工具描述 */
export function td(key: string): string {
  return TOOL_TEXT[key]?.description ?? key;
}

/** 取工具参数描述 */
export function tp(key: string, name: string): string {
  return TOOL_TEXT[key]?.params?.[name] ?? '';
}

// 代码里拼进上下文的消息模板：改文案只改这里
export const MESSAGES = {
  hello: (name: string): string => `Hello world! 我是${name}`,
  modelUnsupported: '我的模型不支持原生工具调用，换个 OpenAI 兼容模型再试。',
  toolOutcome: (tool: string, outcome: string): string => {
    if (outcome === '') return `调用 ${tool} 之后，没有返回任何内容。`;
    return `调用 ${tool} 之后，返回的内容是 ${outcome}`;
  },
  death: (posText: string, dimension: string, msg: string, drops: string): string =>
    `你死在${dimension}维度，坐标是 ${posText}。临终消息里写的原因是 '${msg}'。` +
    (drops === '' ? '身上没带东西，没有掉落。' : `死亡时身上带着 ${drops}。`) +
    `你已经重生了。`,
  /** 死亡之后把模型叫起来的那一句（L4）。事实在紧邻的 L2 死亡记录里。 */
  deathWake: (): string => '你死了，已经重生了，死因、坐标和掉落都在上一条消息里。',
  taskGoal: (goal: string): string => `你的任务目标是 ${goal}`,
  taskEnded: (score: number | string): string => `任务结束了，得分是 ${score}。`,
  actionTimeout: (mins: number): string => `这次动作超时了，${mins} 分钟没有跑完。`,
  restarting: '重启中。',
  exiting: '退出中。',
};

/** 按 profile 选提示词集：`promptSet` 指定任务变体，`prompts.*` 逐条覆盖 */
export function resolvePromptSet(profile: AgentProfile = {} as AgentProfile): PromptSet {
  const setKey = typeof profile.promptSet === 'string' ? profile.promptSet : undefined;
  const base: Record<string, string> = (setKey && PROMPT_SETS[setKey]) || {};
  const merged = { ...PROMPT_SETS.default, ...base } as PromptSet;
  const overrides = profile.prompts ?? {};
  for (const key of ['conversing', 'saving_memory', 'saving_memory_update', 'summary_system'] as const) {
    const override = overrides[key];
    if (typeof override === 'string') merged[key] = override;
  }
  return merged;
}

export default { PROMPT_SETS, TOOL_TEXT, MESSAGES, td, tp, resolvePromptSet };
