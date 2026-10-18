/*
 * 通用投掷命令（`!throwItem`）：把 `library/throwing.ts` 的原语接到工具层。
 *
 * 参数只有四个，都是模型能直接给的：`item_name` + 可选的目标坐标三个。
 * 不引新依赖、不做弹道表以外的计算——瞄准的几何全在库里（纯函数、已单测）。
 */

import * as skills from '../library/skills.js';
import * as throwingLib from '../library/throwing.js';
import type { AgentCommand, CommandPerform } from './actions.js';

export const THROWING_TOOL_TEXT = {
    throwItem: {
        description:
            '**通用投掷**：鸡蛋/雪球/末影珍珠/喷溅药水/经验瓶/箭/末影之眼都能扔，**按物品的轨迹类型分别处理**：' +
            '① 抛物线类（egg/snowball/ender_pearl/splash_potion/lingering_potion/experience_bottle）——给目标坐标就解**低伸弹道**（回执里写清抬头多少度、用的 v/g），' +
            '不给目标就按当前朝向平扔（远距离打不中）；② 箭矢类（arrow）——自动找弓、拉满 1000ms 再放箭；' +
            '③ 制导类（eye_of_ender）——**不做弹道解算**，朝方向扔出去后**追踪它往哪飞（8 方位）**，别看落点。' +
            '回执**只讲事实**：投前/投后数量（没少就是"没扔出去"）、观测到的投掷物实体飞了多久/在哪消失；' +
            '末影珍珠会等坐标跳变（跳了就报落点并提醒**固定吃 5 点伤害**，没跳就说没传送）；' +
            '距离超出射程时**如实说"打不到"并且不扔**，同时给一个走近坐标。',
        params: {
            item_name: '要扔的物品 id（英文）：egg / snowball / ender_pearl / splash_potion / lingering_potion / experience_bottle / arrow / eye_of_ender。也认俗称（ender_eye、xp_bottle）。',
            target_x: '目标 X（可选；三个坐标要么都给要么都不给）。抛物线类用它解弹道；末影之眼只取水平方向。',
            target_y: '目标 Y（可选）。抛物线类需要高差来算抬枪角度。',
            target_z: '目标 Z（可选）。',
        },
    },
};

const DESCRIPTION = (name: keyof typeof THROWING_TOOL_TEXT): string => THROWING_TOOL_TEXT[name].description;

/**
 * 动作包装：走身体通道 + 超时兜底，把实现返回的回执写进 `bot.output`。
 *
 * 投掷本身很快（观测最多几秒），所以超时给 3 分钟——真走到超时说明卡在装备/等待上，
 * 回执里会说明"超时 ≠ 没做成"，别让它变成一段空回执。
 */
export const THROW_TIMEOUT_MIN = 3;

function runThrowingAction(
    label: string,
    timeoutMinutes: number,
    actionFn: (agent: any, ...args: any[]) => Promise<string>,
): CommandPerform {
    const wrapped = async function (agent: any, ...args: any[]): Promise<string | null | undefined> {
        const result = await agent.actions.runAction(
            `action:${label}`,
            async () => {
                skills.log(agent.bot, await actionFn(agent, ...args));
            },
            { timeout: timeoutMinutes },
        );
        if (result.interrupted && !result.timedout) return;
        if (result.timedout) {
            const why = typeof skills.describeStuck === 'function' ? skills.describeStuck(agent.bot) : '';
            return (
                `${label}：**超时**（${timeoutMinutes} 分钟没做完），已释放身体通道。` +
                `投掷本身只要几秒，走到这里说明卡在装备/等待上；先看回执里已经做到哪一步。` +
                `${why === '' ? '' : `\n卡住时：${why}`}`
            );
        }
        return result.message;
    };
    (wrapped as CommandPerform).longRunning = true;
    return wrapped as CommandPerform;
}

export const throwingActionList: AgentCommand[] = [
    {
        name: '!throwItem',
        description: DESCRIPTION('throwItem'),
        params: {
            item_name: { type: 'ItemName', description: THROWING_TOOL_TEXT.throwItem.params.item_name },
            target_x: {
                type: 'float',
                description: THROWING_TOOL_TEXT.throwItem.params.target_x,
                optional: true,
            },
            target_y: {
                type: 'float',
                description: THROWING_TOOL_TEXT.throwItem.params.target_y,
                optional: true,
            },
            target_z: {
                type: 'float',
                description: THROWING_TOOL_TEXT.throwItem.params.target_z,
                optional: true,
            },
        },
        perform: runThrowingAction(
            'throwItem',
            THROW_TIMEOUT_MIN,
            (agent, rawItem?: unknown, rawX?: unknown, rawY?: unknown, rawZ?: unknown) =>
                throwingLib.throwItemSkill(agent.bot, rawItem, rawX, rawY, rawZ),
        ),
    },
];
