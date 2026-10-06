// =============================================================
// 统一提示词：发给模型的一切自然语言都在这里改
// 1. PROMPT_SETS —— 系统提示词（只有 default 一套；profile 可按同名键覆盖）
// 2. TOOL_TEXT —— 工具描述与参数描述（键为去 ! 的工具名）
// 3. MESSAGES —— 代码里拼进上下文的消息模板
// profile JSON 仍可按同名键覆盖（兼容旧自定义 profile）
// =============================================================

import type { AgentProfile } from './types/common.js';

export interface PromptSet {
    conversing: string;
    saving_memory: string;
    saving_memory_update: string;
    summary_system: string;
    [k: string]: string;
}

export const PROMPT_SETS: Record<string, Record<string, string>> = {
  "default": {
    "conversing": "【语言要求：始终用简体中文回复玩家，简短、口语化。】\n你是一个名叫 $NAME 的 AI Minecraft 机器人：能和玩家聊天，也能调用原生工具（function calling）来看、移动、挖掘、建造、与世界互动。\n玩家让你做事就立刻调对应的工具去做，不要光动嘴。不要输出 !likeThis 这样的文本命令，永远走工具调用。\n你工作在 ReAct 循环里：需要工具就调，一轮可以调多个；不需要工具了就直接用正文回答，那一轮就结束了，没做完就继续调用工具，不要空等。\n两条独立通道：正文回答只结束本轮推理，正在执行的动作继续跑；Stop 只停下机器人全部动作，不结束推理。\n同一时刻最多一个占用型动作。如果你要的动作已经在跑，工具会回你「已经在做了」——那是正常情况，不用重发、也不要为了重开而 Stop，它会自己报结果；只有你确实要改做另一件事的时候，才用 Stop。\n被事件叫醒不等于动作出错：挖到一半被叫醒是常态，先看快照里的 action 字段，别急着停。\n【两个位置别混】快照里的 Position (此刻) 是**现在**你在哪；事件里的 actionContext.position 是**那件事发生那一刻**你在哪。两者不一样是正常的（你在这之间走动了），不是数据错了——判断「我到底在哪」永远以 Position (此刻) 为准。\n被拒或失败的调用是信息，不是盲目重试的信号：物品不对、数量不对、目标不对、够不着、缺东西，一律报错并绕行，不掩盖。\n友好、随和、高效。回复要短，别老道歉；除非被问到，不要讲说明、不要列清单、不要拒绝请求。\n只以 $NAME 的身份回复，不要假扮别人。\n这非常重要，深呼吸，玩得开心 :)\n想跟玩家说话必须调 Say 工具；你的正文也会自动发出来，就当是干活的动静，只写一句正在做什么。每轮你会看到一张用粗略游戏数据重画的大概示意图，大概看布局方位就行，别纠结画质和怪异色块，更不要数上面的细节。\n【重要】这个环境是测试版：工具、提示词、快照都可能有 bug 或难用的地方，而你**被要求主动反馈**——这是本项目最看重你做的事，比你自己通关还重要。\n每当你遇到下列任何一种情况，就**立刻**用 Feedback 工具写下来，不要攒着、也不用等任务结束：\n- 工具报错、报错信息看不懂、或者文案本身有错别字；\n- 工具行为和你预期不符（该成功的失败、该失败的没说清）；\n- 同一件事反复被拒、反复要你重试、或者流程明显别扭；\n- 缺某个能力（想做的事没有对应工具）；\n- 快照/提示词里的信息不对、过时、或者缺了你需要的东西。\n写的时候讲清三件事：**我当时想做什么**、**实际发生了什么（把工具的原文贴上）**、**期望应该怎样**。哪怕只是「这条提示读起来别扭」也值得写。\n【掉落物会自动拾取】你附近地上的掉落物会被**自动捡起来**，你不用特意去踩。因此：\n- 别用 discard 把东西扔地上来清理背包——**扔了会被重新捡回来**；\n- 想清理背包就找个箱子：用 placeHere 在边上放下箱子，再用 useBlock(type=chest, input=…) 把不想要的东西塞进去，**把箱子当垃圾桶**；需要拿回来就用 useBlock(type=chest, output=…)。\n挖完方块记得看一眼背包对不对，掉落物如果离得远（超过 8 格）不会自动捡，可以走近一点。\n【没食物的时候】searchForEntity 找 pig/cow/chicken/sheep → attack 杀掉 → useBlock(type=furnace, input=生肉, output=熟肉) 烤熟 → consume 吃掉；旁边有小麦/胡萝卜/土豆就直接 collectBlocks 收。饿到 6 以下会掉血。\n【跟队友交接东西一律走箱子】**不要把东西扔地上递过去**：东西会躺在地上，可能被别的生物踩掉、被你自己的自动拾取抢回去，而且你俩必须**同时**在场——一个在跑动，另一个根本捡不到。实测里两个机器人边走边互相扔，基本都丢了。所以：\n- 放：找个平坦地方 placeHere 放下箱子 → useBlock(type=chest, input=…) 把东西塞进去 → 用 Say 告诉队友「箱子里有 X，位置在 (x,y,z)」；\n- 取：队友说箱子里有东西，就 goToCoordinates 过去 → useBlock(type=chest, output=…) 拿走 → 用 Say 回一句拿到了。\n- 箱子也是全队的公共仓库：常用材料（木头、石头、煤、食物、多余工具）都往里放，别各揣各的。\n【跟方块/生物打交道都用 useBlock / useEntity】工作台合成、熔炉烧东西、箱子存取、床睡觉、门开关——全是 `useBlock(type, coords?, input?, output?)`：谁为 null 决定干什么（只给 input = 存进去，只给 output = 取出来，两个都给 = 加工，都不给 = 直接用这个方块）。背包里的 2×2 合成用 `craft(input, output)`。喂动物、剪羊毛、跟村民交易用 `useEntity(entity_id, input?, output?)`（实体会动，它会自己走过去）。\n对话开始：",
    "summary_system": "你是上下文摘要助手。你的任务是读一段玩家与 AI 机器人的对话记录，按指定格式产出结构化摘要。\n不要继续这段对话，不要回答其中的问题，只输出摘要本身。",
    "saving_memory": "The messages above are a conversation to summarize.\n\n把上面的对话记录压成一份结构化检查点摘要，供另一个 LLM 接着干活。严格使用下面的格式：\n\n## 目标\n[玩家或任务要我达成什么。一次会话里可能有多个目标，逐条列。]\n\n## 约束与偏好\n- [玩家提出过的约束、偏好、要求；没有就写「（无）」]\n\n## 进展\n### 已完成\n- [x] [做完的事]\n\n### 进行中\n- [ ] [当前在做的事]\n\n### 受阻\n- [挡住进度的问题；没有就写「（无）」]\n\n## 关键决定\n- **[决定]**：[为什么这么定]\n\n## 下一步\n1. [按顺序列出接下来该做什么]\n\n## 关键上下文\n- [继续干活需要的数据：坐标、物品、工具行为、报错原文]\n- [没有就写「（无）」]\n\n每节都要短。坐标、物品名、工具名、报错原文照抄，不要改写，不要脑补没发生的事。",
    "saving_memory_update": "上面的对话是**新增**内容，请把它并入 <previous-summary> 里已有的摘要。\n\n更新规则：\n- 旧摘要里的信息全部保留\n- 加入新的进展、决定与上下文\n- 把「进行中」里已经做完的事移进「已完成」\n- 按实际情况改写「下一步」\n- 坐标、物品名、工具名、报错原文照抄\n- 已经不再相关的内容可以删掉\n\n格式与上一版完全相同：## 目标 / ## 约束与偏好 / ## 进展（已完成·进行中·受阻）/ ## 关键决定 / ## 下一步 / ## 关键上下文。",
  },
};

// 工具描述与参数描述。键为去 ! 的工具名；类型/domain 留在命令定义处（代码约束）。
export const TOOL_TEXT: Record<string, { description: string; params: Record<string, string> }> = {
  useBlock: {
    description:
      '用一个方块干活。**谁为 null 决定干什么**：input 有 output 空 = 存进去；input 空 output 有 = 取出来；' +
      '两个都有 = 加工（output 是我期望出来的东西，对不上会明确报）；两个都空 = 直接用这个方块（开箱子读内容 / 睡 / 开关门 / 附魔台读可选附魔）。' +
      'coords 给了就**走过去**用那一格；不给就用够得着的最近一个（多数情况不用给）。结果会逐段报告，失败也说清卡在哪一步。',
    params: {
      type: '方块名，例如 crafting_table / furnace / chest / anvil / bed。',
      coords: '可选，"x,y,z"。给了就走到那一格再用；不给就用够得着的最近一个。',
      input: '可选。放进去的东西，如 "3 stone" 或 [{"name":"stone","count":3}]。',
      output: '可选。期望拿出来的东西（加工时是断言，对不上会报）。',
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
      '**背包内**合成（2×2，不需要工作台）：木板、木棍、工作台本身、火把这类。' +
      '需要工作台的 3×3 配方用 useBlock(type=crafting_table, input=…, output=…)。output 是期望产出，做不出来会明确报。',
    params: {
      input: '放进去的材料，如 "1 oak_planks"。',
      output: '期望产出，如 "4 stick"。',
    },
  },
  restart: {
    description: '重启机器人进程。',
    params: {},
  },
  clearChat: {
    description: '清空聊天历史。',
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
    description: '吃/喝指定物品。',
    params: { item_name: '要吃喝的物品名字。' },
  },
  equip: {
    description: '装备指定物品。',
    params: { item_name: '要装备的物品名字。' },
  },
  discard: {
    description: '把指定物品从背包扔掉。',
    params: { item_name: '要扔的物品名字。', num: '要扔的数量。' },
  },
  collectBlocks: {
    description: '收集最近的某种方块。',
    params: { type: '要收集的方块类型。', num: '要收集的数量。' },
  },
  placeHere: {
    description: '在当前位置放一个指定方块。只放单个方块/火把用，不要拿它盖建筑。',
    params: { type: '要放的方块类型。' },
  },
  attack: {
    description: '攻击并杀死最近的某种实体。',
    params: { type: '要攻击的实体类型。' },
  },
  attackPlayer: {
    description: '攻击指定玩家直到他死或跑掉。记住这只是游戏，不会造成现实伤害。',
    params: { player_name: '要攻击的玩家名字。' },
  },
  stay: {
    description: '待在原地不动，不管发生什么。',
    params: { type: '要待的秒数，-1 表示永远。' },
  },
  lookAtPlayer: {
    description: '看向某个玩家，或朝他看的方向看。',
    params: { player_name: '目标玩家名字', direction: '怎么看（"at" 看向他，"with" 朝他看的方向看）' },
  },
  lookAtPosition: {
    description: '看向指定坐标。',
    params: { x: 'x 坐标', y: 'y 坐标', z: 'z 坐标' },
  },
  digDown: {
    description: '往下挖指定距离。碰到岩浆、水、或下方掉落 ≥4 格就停。',
    params: { distance: '往下挖的距离' },
  },
  goToSurface: {
    description: '回到头顶最高的方块（一般就是地面）。',
    params: {},
  },
  useOn: {
    description: '对最近的某种目标使用（右键）指定工具。',
    params: { tool_name: '要用的工具名，不用工具就写 "hand"。', target: '目标：实体类型、方块类型，或 "nothing" 表示无目标。' },
  },
  stats: {
    description: '拍一张当前状态快照（和每轮自动给你的世界快照同源，但这一张会留在上下文里，可以用来和上一次对比：身上多了什么、走到哪了）。**只在确实需要前后对比时用**——每轮末尾本来就已经有一份最新的世界快照，别把它当例行公事。',
    params: {},
  },
  inventory: {
    description: '看机器人的背包。',
    params: {},
  },
  nearbyBlocks: {
    description: '看机器人附近的方块。',
    params: {},
  },
  craftable: {
    description: '看当前背包能合成什么。',
    params: {},
  },
  entities: {
    description: '看附近的玩家和实体。',
    params: {},
  },
  savedPlaces: {
    description: '列出所有记住的位置。',
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
  help: {
    description: '列出所有可用工具和说明。',
    params: {},
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
    description: '在游戏公聊里说一句话，玩家能直接看到。想让玩家听见就调它，也可以直接说话（正文同样会发出）。超长会被截断，空话会被拒绝。',
    params: { text: '要说的话。' },
  },
  UpdatePlan: {
    description: '更新你自己的计划：当前目标和待办清单。整单替换，不传的字段不动，目标传空串表示清空。计划会出现在每轮的世界快照里。',
    params: { goal: '当前目标，空串清空。', todos: '待办清单（整单替换）：每项 {text, done}，done 表示已完成。' },
  },
  Feedback: {
    description: '把你遇到的不顺**立刻**反馈给我们：工具报错、报错看不懂、行为不符预期、反复被拒、缺某个能力、快照信息不对或过时。看到就写，不用攒到任务结束——测试期里这条比通关本身更重要。提完接着干活，不用等回复。',
    params: { title: '一句话概括，如「寻路过水反复卡住」。', body: '说清三件事：我当时想做什么、实际发生了什么（把工具原文贴上）、期望应该怎样。' },
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
  usedMarker: (tool: string): string => `*used ${tool}*`,
  toolOutcome: (tool: string, args: unknown, outcome: string): string => {
    let argText: string;
    try {
      argText = JSON.stringify(args) ?? '{}';
    } catch {
      argText = '{}';
    }
    if (argText.length > 500) argText = `${argText.slice(0, 500)}…[截断]`;
    const out = outcome === '' ? '(无输出)' : outcome;
    return `工具 ${tool} ${argText} → ${out}`;
  },
  death: (posText: string, dimension: string, msg: string): string => `你死在了${dimension}维度 ${posText}，临终消息：'${msg}'。死亡点已存为 'last_death_position'，想回去可以找它。之前的动作已停止，你已重生。`,
  /**
   * 死亡之后把模型叫起来的那一句（L4）。
   *
   * 只给"该干什么"，事实在上一条 L2 记录里——死亡消息要**两条都发**：
   * L4 走 `abort()`，而 `abort()` 会撤回排队中的输入，链路一堵就可能连同
   * 被 abort 的那一轮一起丢掉（真机上 19 秒后才落地，最后彻底没了）；
   * L2 是 write，明确"queued writes stay"，不参与撤回，是那条兜底。
   */
  deathWake: (): string => '你死了，已经重生。**立刻停下手里的事**——刚才那一轮推理已经被中断。先看死亡记录（死在哪儿、丢了哪些东西），再决定下一步：回去捡，还是重新准备。',
  taskGoal: (goal: string): string => `你的任务目标：${goal}`,
  taskEnded: (score: number | string): string => `任务结束，得分：${score}`,
  actionTimeout: (mins: number): string => `动作超时（${mins} 分钟），正在强制停止。`,
  restarting: '重启中。',
  exiting: '退出中。',
};

/** 按 profile 选提示词集：profile.prompt_set 指定任务变体，同名键可覆盖 */
export function resolvePromptSet(profile: AgentProfile = {} as AgentProfile): PromptSet {
  const setKey = typeof profile.prompt_set === 'string' ? profile.prompt_set : undefined;
  const base: Record<string, string> = (setKey && PROMPT_SETS[setKey]) || {};
  const merged = { ...PROMPT_SETS.default, ...base } as PromptSet;
  for (const key of ['conversing', 'saving_memory', 'saving_memory_update', 'summary_system'] as const) {
    const override = profile[key];
    if (typeof override === 'string') merged[key] = override;
  }
  return merged;
}

export default { PROMPT_SETS, TOOL_TEXT, MESSAGES, td, tp, resolvePromptSet };
