/*
 * 末地通关命令：查询 `!endFightStatus` + 动作 `!enterEnd` / `!clearEndCrystals` /
 * `!bedBombDragon` / `!dodgeDragonBreath` / `!drinkPotion` /
 * `!recoverAfterDeath`。
 *
 * **本文件是自包含的**（和 `commands/survival.ts` 同一套路）：描述文本在下面
 * `ENDGAME_TOOL_TEXT`，动作包装在 `runEndgameAction`，不依赖对 `actions.ts` /
 * `prompts.ts` 的改动；接线只在 `registry.ts` 加两行。
 *
 * 为什么**大多数命令没有参数**：`scripts/check-prompts.ts` 现在也扫本文件；带参数的
 * 命令必须同时在 `prompts.ts` 的 `TOOL_TEXT` 里留一份**参数说明**（参数名逐字对齐
 * schema），否则门禁会报 `SCHEMA PARAM WITHOUT PROMPT TEXT`。需要"选哪个"的地方
 * 一律做成**显式参数**（如 `drinkPotion(potion)`），不靠工具内部替模型挑。
 *
 * 动作实现全部住在 `library/endgame_routine.ts`（读 bot 信号 + 调 `skills`），
 * 纯决策住在 `library/endgame.ts`（58 条离线测试）。
 */
import * as skills from '../library/skills.js';
import * as endgame from '../library/endgame_routine.js';
import type { AgentCommand, CommandPerform } from './actions.js';

/** 工具描述。键为去 `!` 的工具名，形状与 `TOOL_TEXT` 一致（本文件自带，不进 prompts.ts）。 */
export const ENDGAME_TOOL_TEXT: Record<string, { description: string; params: Record<string, string> }> = {
    endFightStatus: {
        description:
            '末地通关体检，一次给全**整条链**的信息：现在到哪一步（备齐清单 → 下界找要塞刷烈焰棒 → 刷末影珍珠 → 合成末影之眼 → 掷眼找要塞 → 激活传送门 → 进末地 → 拆水晶 → 床炸龙 → 收尾）、' +
            '装备还缺什么、眼的材料各差多少（烈焰棒/粉/珍珠/眼，以及下界要塞找没找到）、还有几颗末地水晶、末影龙还剩多少血、龙是不是正低头停在传送门上、有没有踩进龙息云、床炸闸门现在过不过。' +
            '只读，不占身体通道。**每到一个新阶段先调它**——它会把"还没刷够烈焰棒""没带缓降药水"这种要命的缺口直接点出来。',
        params: {},
    },
    enterEnd: {
        description:
            '自动进入末地：附近有已激活的末地传送门就直接走进去；没有就找**空的**末地传送门框架，用背包里的末影之眼一颗颗填满（12 颗全填上才激活），然后走进去等维度切换。' +
            '**两样都没有（要塞不在这）时它会替你掷一颗末影之眼指路**：跟着眼睛飞的方向走约 12 格再调一次；眼睛开始往下钻就说明要塞在脚下，往下挖。' +
            '进门之前会把主世界那个传送门的坐标记下来（死亡回收要用）。' +
            '进去落在 (100,49,0) 的黑曜石平台上、面朝西，**平台和主岛之间可能隔着虚空**（要搭桥或扔珍珠）。',
        params: {},
    },
    clearEndCrystals: {
        description:
            '拆末地水晶，一次处理一颗。地面能看见的水晶：退到 12 格外（爆炸威力 6，水**挡不住伤害和击退**）用弓射——**退不够它不会放箭**，只告诉你该退到哪；被铁栏杆笼住的那两颗：有 TNT 就在笼顶放一个点燃、按 12 格爆炸半径后撤（要先 allowDangerousOps(ops="ignite", calls=1)），没 TNT 就明说拆不掉、建议去合成或带缓降上柱子。' +
            '**必须全部拆完再打龙**：只要还剩一颗，龙就会持续回血，之前打的血全白打。回执会报"还剩几颗、下一颗在哪"。',
        params: {},
    },
    bedBombDragon: {
        description:
            '床炸末影龙，**一次一张床**（一张床 = 一次 sleep_in_bed 授权）。**只在龙低头停在 (0,64,0) 出口传送门上时有用**（它飞着时床炸不到）；工具先探真实地形选好"床位/掩体/站位"，再算安全账：**血量 <10、饥饿 <6、没有能兑现的掩体、够不着床、自伤超过一半血、龙离床 >3 格**——任一成立都**直接拒绝执行**并说清缺什么，一个方块都不放。被拒绝不是 bug。' +
            '在末地点床 = 尝试睡觉 = 爆炸，属于危险操作，**必须先 allowDangerousOps(ops="sleep_in_bed", calls=1)**，否则它不会放床。',
        params: {},
    },
    dodgeDragonBreath: {
        description:
            '躲龙息/自救。两条规则：① 龙低头停在传送门上时，只要你在它 20 格内就会被喷 3 秒龙息，**离 (0,64,0) 20 格以上才安全**；② 地上的紫色云是掉血区（护甲无效，算魔法伤害），站进去要立刻冲出去。' +
            '正在高空下坠时会**先往脚下扔一颗末影珍珠**免摔伤（手里没珍珠就明说）。会自己挪到算出来的安全格；一次挪不出去就再调一次。',
        params: {},
    },
    drinkPotion: {
        description:
            '喝一瓶指定 id 的药水（healing / strong_healing / long_slow_falling 这类）。背包里所有药水的物品名都是 potion，只有药水 id 能精确到等级和时长；没有这瓶时返回背包里现有的药水 id 清单。',
        params: {
            potion: '完整药水 id，例如 healing / strong_healing / long_slow_falling / fire_resistance。',
        },
    },
    recoverAfterDeath: {
        description:
            '死亡回收：读死亡点记录，给你"东西还在不在 + 已经过了多久 + 从哪回去"的方案。掉落物 **5 分钟**后消失，但**只在区块被加载时才计时**（旁边没人 = 基本不会消失，另一个 bot 在旁边则是在跑的）；掉进虚空（Y<-60）的东西**当场消失**，不用去捡。' +
            '人已经在末地时会直接带你走到尸体坐标；在别的维度则给路线（有记过主世界传送门坐标就顺着它回去；跨维度那一段要自己走）。**死亡后的第一件事就是调它**，别在原地发呆等掉落物过期。',
        params: {},
    },
    reviveDragon: {
        description:
            '**把已经打完的末影龙叫回来**（这个世界已经通关了，不然拆水晶/床炸那段代码永远跑不到）：往返回门基座环上的 **4 个标准位置**各放一颗末影水晶（背包要有 4 颗 end_crystal）。' +
            '它会**从世界读**返回门位置（`end_portal` **方块群的质心** → 龙蛋柱 → 记下来的坐标），**从真实方块推导**四个格子并按"像不像标准位置"分档（不写死 (0,62,0)），**放一颗复验一颗**（新出现的末影水晶实体），每放一颗之后都看一眼龙回来没有。' +
            '格子被占 / 水晶没放成 / 龙没回来都会**停手并如实说**，不会把 4 颗水晶一次烧光。' +
            '**推不出格子 ≠ 工具坏了**：那说明这个世界的返回门不是课本形状（比如已经通关、门是激活状态，那一层是 end_portal）——' +
            '这时**用 spots 参数显式给四个绝对坐标**（格式 "3,63,0;-3,63,0;0,63,3;0,63,-3"，分号隔开、每段 x,y,z），给了就用你给的、跳过自动推导；也可以找开发者确认门结构。' +
            '不在末地、龙还活着、水晶不够（会告诉你还差几颗 + 采购清单：4 恶魂之泪 + 4 末影之眼 + 28 玻璃）都会直接拒绝。' +
            '放完龙会带着**柱子上那 10 颗水晶**一起回来：先 clearEndCrystals 拆干净，再 bedBombDragon。',
        params: {
            spots:
                '可选。直接指定放水晶的格子（**绝对坐标**），格式 "x,y,z;x,y,z;x,y,z;x,y,z"，例如 "3,63,0;-3,63,0;0,63,3;0,63,-3"。' +
                '给了就**跳过自动推导**、照你给的四格放；不确认能不能触发仪式时先不放。不给就自己从世界里的方块推。',
        },
    },
};

/** 取描述（键名打错会在编译期就红）。 */
const DESCRIPTION = (name: keyof typeof ENDGAME_TOOL_TEXT): string => ENDGAME_TOOL_TEXT[name].description;

/**
 * 动作包装：走身体通道 + 超时兜底。与 `actions.ts` 的 `runAsAction` 同语义，
 * 但**显式传 label**，所以命令不需要住在 `actionsList` 里。
 *
 * `...args` 是**位置参数**（与 `progression.ts` 的 `runProgressionAction` 一致）：
 * 现在只有 `reviveDragon(spots)` 用得到。
 */
function runEndgameAction(
    label: string,
    timeoutMinutes: number,
    actionFn: (agent: any, ...args: any[]) => Promise<unknown>,
): CommandPerform {
    const wrapped = async function (agent: any, ...args: any[]): Promise<string | null | undefined> {
        const result = await agent.actions.runAction(
            `action:${label}`,
            async () => {
                await actionFn(agent, ...args);
            },
            { timeout: timeoutMinutes },
        );
        if (result.interrupted && !result.timedout) return;
        if (result.timedout) {
            return `这次动作超时了，${timeoutMinutes} 分钟没有跑完。`;
        }
        return result.message;
    };
    (wrapped as CommandPerform).longRunning = true;
    return wrapped as CommandPerform;
}

/** 把实现里的回执写进 `bot.output`——模型的工具回执就是从这里来（见 ActionManager 的 getBotOutputSummary）。 */
async function logReceipt(agent: any, run: () => Promise<string>): Promise<void> {
    skills.log(agent.bot, await run());
}

/** 只读查询：末地体检（不占身体通道）。 */
export const endgameQueryList: AgentCommand[] = [
    {
        name: '!endFightStatus',
        description: DESCRIPTION('endFightStatus'),
        params: {},
        perform: function (agent: any): string {
            // 传 agent：报告要读 Memory Bank 里记过的末地传送门坐标（知道门在哪就不用再掷眼找要塞）。
            return endgame.endgameStatusReport(agent.bot, agent);
        },
    },
];

/** 占用身体通道的动作。 */
export const endgameActionList: AgentCommand[] = [
    {
        name: '!enterEnd',
        description: DESCRIPTION('enterEnd'),
        params: {},
        // 找门 + 填 12 颗眼 + 走门 + 等维度切换，给足 5 分钟。
        // 传 agent 是为了把主世界传送门坐标记进 Memory Bank（recoverAfterDeath 要用）。
        perform: runEndgameAction('enterEnd', 5, (agent) =>
            logReceipt(agent, () => endgame.enterEndSkill(agent.bot, agent)),
        ),
    },
    {
        name: '!clearEndCrystals',
        description: DESCRIPTION('clearEndCrystals'),
        params: {},
        // 走位 + 拉弓/放 TNT + 按爆炸半径后撤，一次一颗，给 5 分钟（和工具声明一致）。
        perform: runEndgameAction('clearEndCrystals', 5, (agent) =>
            logReceipt(agent, () => endgame.clearEndCrystalsSkill(agent.bot)),
        ),
    },
    {
        name: '!bedBombDragon',
        description: DESCRIPTION('bedBombDragon'),
        params: {},
        perform: runEndgameAction('bedBombDragon', 3, (agent) => logReceipt(agent, () => endgame.bedBombDragon(agent.bot))),
    },
    {
        name: '!dodgeDragonBreath',
        description: DESCRIPTION('dodgeDragonBreath'),
        params: {},
        perform: runEndgameAction('dodgeDragonBreath', 2, (agent) =>
            logReceipt(agent, () => endgame.dodgeDragonBreathSkill(agent.bot)),
        ),
    },
    {
        name: '!drinkPotion',
        description: DESCRIPTION('drinkPotion'),
        params: {
            potion: {
                type: 'string',
                description: ENDGAME_TOOL_TEXT.drinkPotion.params.potion,
            },
        },
        perform: runEndgameAction('drinkPotion', 2, (agent, potion) =>
            logReceipt(agent, () => endgame.drinkPotionById(agent.bot, potion)),
        ),
    },
    {
        name: '!recoverAfterDeath',
        description: DESCRIPTION('recoverAfterDeath'),
        params: {},
        // 跨维度走位可能很久，给 10 分钟。
        perform: runEndgameAction('recoverAfterDeath', 10, (agent) =>
            logReceipt(agent, () => endgame.recoverAfterDeathSkill(agent)),
        ),
    },
    {
        name: '!reviveDragon',
        description: DESCRIPTION('reviveDragon'),
        params: {
            spots: {
                type: 'string',
                description: ENDGAME_TOOL_TEXT.reviveDragon.params.spots,
                optional: true,
            },
        },
        // 找门 + 放 4 颗水晶 + 等龙回来，给 3 分钟。
        perform: runEndgameAction('reviveDragon', 3, (agent, spots) =>
            logReceipt(agent, () => endgame.reviveDragon(agent.bot, agent, { spots })),
        ),
    },
];