/*
 * 末地通关命令：查询 `!endFightStatus` + 动作 `!enterEnd` / `!clearEndCrystals` /
 * `!bedBombDragon` / `!dodgeDragonBreath` / `!drinkPotion` / `!drinkMilk` /
 * `!recoverAfterDeath` / `!throwHeld`。
 *
 * **本文件是自包含的**（和 `commands/survival.ts` 同一套路）：描述文本在下面
 * `ENDGAME_TOOL_TEXT`，动作包装在 `runEndgameAction`，不依赖对 `actions.ts` /
 * `prompts.ts` 的改动；接线只在 `registry.ts` 加两行。
 *
 * 为什么**所有命令都没有参数**：`scripts/check-prompts.ts` 只扫
 * `actions.ts` / `queries.ts` / `interact.ts` 三个文件里的 `td()` 与 `name: '!x'`，
 * 认不到新命令文件里的参数；只要这里带参数，那个门禁就会报
 * `SCHEMA PARAM WITHOUT PROMPT TEXT`。所以：
 *   - 需要"选哪个"的地方改成**显式工具名**（`drinkPotion` / `drinkMilk`）或
 *     **写进描述里的确定性优先级**（`drinkPotion` 自己按末地优先级挑药）；
 *   - 真需要加参数时，把命令挪进 `actions.ts`、参数说明写进 `prompts.ts` 的
 *     `TOOL_TEXT`，并把本文件加进 `check-prompts.ts` 的 `COMMAND_FILES`。
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
            '末地通关体检，一次给全「现在到哪一步了 / 装备还缺什么 / 还有几颗末地水晶 / 末影龙还剩多少血 / 龙是不是正低头停在传送门上 / 有没有踩进龙息云」。' +
            '只读，不占身体通道。**准备进末地之前、每次死亡重生之后、打龙之前各调一次**——它会把"没带缓降药水"这种要命的缺口直接点出来。',
        params: {},
    },
    enterEnd: {
        description:
            '自动进入末地：附近有已激活的末地传送门就直接走进去；没有就找**空的**末地传送门框架，用背包里的末影之眼一颗颗填满（12 颗全填上才激活），然后走进去等维度切换。' +
            '进去落在 (100,49,0) 的黑曜石平台上、面朝西，**平台和主岛之间可能隔着虚空**（要搭桥或扔珍珠）。' +
            '注意：进末地之后只有"杀掉龙"或"死"两条路出来，先确认背包再调。要塞不在这里时它会明确告诉你先去掷末影之眼。',
        params: {},
    },
    clearEndCrystals: {
        description:
            '拆末地水晶，一次处理一颗。地面能看见的水晶：退到 12 格外（爆炸威力 6，水**挡不住伤害和击退**）用弓射；被铁栏杆笼住的那两颗：有 TNT 就在笼顶放一个点燃后撤（要先 allowDangerousOps(ops="ignite", calls=1)），没 TNT 就明说拆不掉、建议去合成。' +
            '**必须全部拆完再打龙**：只要还剩一颗，龙就会持续回血，之前打的血全白打。回执会告诉你还剩几颗、下一颗在哪。',
        params: {},
    },
    bedBombDragon: {
        description:
            '床炸末影龙，一次一张床。**只在龙低头停在 (0,64,0) 出口传送门上时有用**（它飞着时床炸不到）；工具先算安全账：没有掩体、又退不到 10 格外（威力 5 的爆炸半径）时会**直接拒绝执行**，只告诉你哪里不行——被拒绝不是 bug。' +
            '在末地点床 = 尝试睡觉 = 爆炸，属于危险操作，**必须先 allowDangerousOps(ops="sleep_in_bed", calls=1)**（一张床 = 一次），否则一个方块都不会放。',
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
            '按末地优先级喝药，**不用记药水名**（所有药水在背包里都叫 potion）：① 在末地/空中且没有缓降 Buff 或剩余不到 30 秒 → 喝**缓降**（龙的翅膀能把你掀到几十格高空，摔死是头号死法）；② 血量 ≤10 → 喝**再生**（没有就治疗）；③ 在末地且没有抗性提升 → 喝**抗性**（爆炸和撞击都减）；④ 都不需要就明说，并列出背包里有哪些药。' +
            '想清掉负面效果、或者要主动清空自己所有 Buff 时用 drinkMilk。',
        params: {},
    },
    drinkMilk: {
        description:
            '喝牛奶桶：**立刻清掉自己身上的全部状态效果**。① 会把你刚喝的缓降/再生/抗性一起清掉，所以只在"中了负面效果"（中毒、虚弱、缓慢…）时用，别当疗伤药；② **不能灭火**——着火了要下水或踩水。没有牛奶桶会明确告诉你。',
        params: {},
    },
    recoverAfterDeath: {
        description:
            '死亡回收：读死亡点记录，给你"东西还在不在 + 从哪回去"的方案。掉落物 **5 分钟**后消失，但**只在区块被加载时才计时**（旁边没人 = 基本不会消失）；掉进虚空的东西**当场消失**，不用去捡。' +
            '人已经在末地时会直接带你走到尸体坐标；在别的维度则只给路线（跨维度那一段要自己走）。**死亡后的第一件事就是调它**，别在原地发呆等掉落物过期。',
        params: {},
    },
    throwHeld: {
        description:
            '把手里的东西扔出去（**先 equip 要扔的东西**：ender_eye 末影之眼 / ender_pearl 末影珍珠 / 雪球 / 鸡蛋）。' +
            '末影之眼会朝最近要塞方向飞约 12 格（每次 20% 概率碎）——跟着它指的方向走，眼睛开始往下钻就说明要塞在脚下，往下挖；末影珍珠是位移/免摔伤，**正在下坠时会自动往脚下扔**。' +
            '扔完会核对手里那一叠的数量有没有真的减少，没减少就说明服务端没采纳，它会如实报出来、不会假装成功。',
        params: {},
    },
};

/** 取描述（键名打错会在编译期就红）。 */
const DESCRIPTION = (name: keyof typeof ENDGAME_TOOL_TEXT): string => ENDGAME_TOOL_TEXT[name].description;

/**
 * 动作包装：走身体通道 + 超时兜底。与 `actions.ts` 的 `runAsAction` 同语义，
 * 但**显式传 label**，所以命令不需要住在 `actionsList` 里。
 */
function runEndgameAction(
    label: string,
    timeoutMinutes: number,
    actionFn: (agent: any) => Promise<unknown>,
): CommandPerform {
    const wrapped = async function (agent: any): Promise<string | null | undefined> {
        const result = await agent.actions.runAction(
            `action:${label}`,
            async () => {
                await actionFn(agent);
            },
            { timeout: timeoutMinutes },
        );
        if (result.interrupted && !result.timedout) return;
        if (result.timedout) {
            const why = typeof skills.describeStuck === 'function' ? skills.describeStuck(agent.bot) : '';
            return (
                `${label}：**超时**（${timeoutMinutes} 分钟没做完），已释放身体通道。注意：**超时 ≠ 没做成**——` +
                `有些步骤已经生效（比如框架已经填了几颗、床已经放下去了），先调 endFightStatus 核对状态再决定要不要重试。` +
                `${why === '' ? '' : `\n卡住时：${why}`}`
            );
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
            return endgame.endgameStatusReport(agent.bot);
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
        perform: runEndgameAction('enterEnd', 5, (agent) => logReceipt(agent, () => endgame.enterEndSkill(agent.bot))),
    },
    {
        name: '!clearEndCrystals',
        description: DESCRIPTION('clearEndCrystals'),
        params: {},
        // 走位 + 拉弓/放 TNT + 后撤，一次一颗，给 4 分钟。
        perform: runEndgameAction('clearEndCrystals', 4, (agent) =>
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
        params: {},
        perform: runEndgameAction('drinkPotion', 2, (agent) =>
            logReceipt(agent, () => endgame.drinkPotionsByPriority(agent.bot)),
        ),
    },
    {
        name: '!drinkMilk',
        description: DESCRIPTION('drinkMilk'),
        params: {},
        perform: runEndgameAction('drinkMilk', 2, async (agent) => {
            const drank = await endgame.drinkPotionByKind(agent.bot, 'milk');
            skills.log(
                agent.bot,
                drank
                    ? '喝下牛奶：身上所有状态效果被清空（包括你自己的缓降/再生/抗性）。牛奶不能灭火。'
                    : '没有喝到牛奶：背包里没有 milk_bucket。',
            );
        }),
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
        name: '!throwHeld',
        description: DESCRIPTION('throwHeld'),
        params: {},
        perform: runEndgameAction('throwHeld', 1, (agent) => logReceipt(agent, () => endgame.throwHeldSkill(agent.bot))),
    },
];