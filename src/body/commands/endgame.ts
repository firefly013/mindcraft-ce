/*
 * 末地命令：只剩 `!enterEnd`，外加两个通用动作 `!drinkPotion` / `!recoverAfterDeath`。
 *
 * 和末地相关的其余工具（endFightStatus / clearEndCrystals / bedBombDragon /
 * dodgeDragonBreath / reviveDragon）已按用户要求删除；drinkPotion 和
 * recoverAfterDeath 不是末地专属能力，留在这里只是沿用了原来的文件。
 *
 * **本文件是自包含的**（和 `commands/survival.ts` 同一套路）：描述文本在下面
 * `ENDGAME_TOOL_TEXT`，动作包装在 `runEndgameAction`，不依赖对 `actions.ts` /
 * `prompts.ts` 的改动；接线只在 `registry.ts` 加两行。
 *
 * 为什么**带参数的命令必须留提示词**：`scripts/check-prompts.ts` 也会扫本文件；带参数的
 * 命令必须同时在 `prompts.ts` 的 `TOOL_TEXT` 里留一份**参数说明**（参数名逐字对齐
 * schema），否则门禁会报 `SCHEMA PARAM WITHOUT PROMPT TEXT`。
 *
 * 动作实现全部住在 `library/endgame_routine.ts`（读 bot 信号 + 调 `skills`），
 * 纯决策住在 `library/endgame.ts`。
 */
import * as skills from '../library/skills.js';
import * as endgame from '../library/endgame_routine.js';
import type { AgentCommand, CommandPerform } from './actions.js';

/** 工具描述。键为去 `!` 的工具名，形状与 `TOOL_TEXT` 一致（本文件自带，不进 prompts.ts）。 */
export const ENDGAME_TOOL_TEXT: Record<string, { description: string; params: Record<string, string> }> = {
    enterEnd: {
        description:
            '自动进入末地：附近有已激活的末地传送门就直接走进去；没有就找**空的**末地传送门框架，用背包里的末影之眼一颗颗填满（12 颗全填上才激活），然后走进去等维度切换。' +
            '**两样都没有（要塞不在这）时它会替你掷一颗末影之眼指路**：跟着眼睛飞的方向走约 12 格再调一次；眼睛开始往下钻就说明要塞在脚下，往下挖。' +
            '进门之前会把主世界那个传送门的坐标记下来（死亡回收要用）。' +
            '进去落在 (100,49,0) 的黑曜石平台上、面朝西，**平台和主岛之间可能隔着虚空**（要搭桥或扔珍珠）。',
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
};

/** 取描述（键名打错会在编译期就红）。 */
const DESCRIPTION = (name: keyof typeof ENDGAME_TOOL_TEXT): string => ENDGAME_TOOL_TEXT[name].description;

/**
 * 动作包装：走身体通道 + 超时兜底。与 `actions.ts` 的 `runAsAction` 同语义，
 * 但**显式传 label**，所以命令不需要住在 `actionsList` 里。
 *
 * `...args` 是**位置参数**（与 `progression.ts` 的 `runProgressionAction` 一致）：
 * 现在只有 `drinkPotion(potion)` 用得到。
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

/** 只读查询：和末地相关的查询工具已经全部删除，这里保持空列表。 */
export const endgameQueryList: AgentCommand[] = [];

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
];
