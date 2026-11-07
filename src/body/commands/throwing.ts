/*
 * 通用投掷命令（`!throwItem`）：把 `library/throwing.ts` 的原语接到工具层。
 *
 * 参数是槽位 + 目标：打活体给 entity_id，往落点扔给三个坐标，二选一。
 * 不引新依赖、不做弹道表以外的计算——瞄准的几何全在库里（纯函数、已单测）。
 */

import * as skills from '../library/skills.js';
import * as throwingLib from '../library/throwing.js';
import type { AgentCommand, CommandPerform } from './actions.js';

export const THROWING_TOOL_TEXT = {
    throwItem: {
        description:
            '**通用投掷**：鸡蛋/雪球/末影珍珠/喷溅药水/滞留药水/三叉戟/箭/末影之眼都能扔，**必须给目标**：打活体给 entity_id，往某个落点扔给三个坐标，两种只能选一种。按物品的轨迹类型分别处理：' +
            '① 抛物线类（egg/snowball/ender_pearl/splash_potion/lingering_potion/trident）——重力、空气阻力、初速和路径遮挡交给弹道库 `minecrafthawkeye` 解算（回执里写清抬头多少度、偏航多少度、库量到的最近距离）；活体目标会带速度做提前量。' +
            '② 箭矢类（arrow）——自动找弓、拉满 1000ms 再放箭，弹道同样交给库；' +
            '③ 制导类（eye_of_ender）——**不做弹道解算**，朝目标的水平方向扔出去后**追踪它往哪飞（8 方位）**，别看落点。' +
            '回执**只讲事实**：投前/投后数量（没少就是"没扔出去"）、观测到的投掷物实体飞了多久/在哪消失；' +
            '末影珍珠会等坐标跳变（跳了就报落点并提醒**固定吃 5 点伤害**，没跳就说没传送）；' +
            '弹道库算不出可行弹道时**如实说"打不到"并且不扔**；带激流的三叉戟在水里或雨里会直接拒绝并说明那是冲刺。',
        params: {
            slot: '要扔的那一格，背包行里的 [N]。三叉戟、药水、珍珠都按这一格拿，同名物品靠槽位区分。',
            entity_id: '可选。打活体目标时给 Live State 实体表里的 #编号；会按它的位置和速度算提前量。给了它就不要给坐标。',
            target_x: '可选。往落点扔时的目标 X；三个坐标要么都给，要么都不给。',
            target_y: '可选。目标 Y。',
            target_z: '可选。目标 Z。',
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
            return `这次 ${label} 超时了，${timeoutMinutes} 分钟没有跑完。`;
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
            slot: { type: 'int', description: THROWING_TOOL_TEXT.throwItem.params.slot, domain: [5, 45] },
            entity_id: {
                type: 'int',
                description: THROWING_TOOL_TEXT.throwItem.params.entity_id,
                optional: true,
            },
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
            async (agent, rawSlot?: unknown, rawEntityId?: unknown, rawX?: unknown, rawY?: unknown, rawZ?: unknown) => {
                const item = skills.itemAtSlot(agent.bot, rawSlot);
                if (item == null) return `第 ${Number(rawSlot)} 格没有东西，没法投掷。`;
                const name = String(item.name ?? '');
                if (name === '') return `第 ${Number(rawSlot)} 格读不到物品名，没法投掷。`;
                const entityId = rawEntityId == null ? null : Number(rawEntityId);
                const targetEntity =
                    entityId == null ? null : (agent.bot?.entities?.[entityId] ?? null);
                if (entityId != null && targetEntity == null) {
                    return `找不到实体 #${entityId}，没法瞄准。`;
                }
                const coordCount = [rawX, rawY, rawZ].filter((value) => value != null && value !== '').length;
                if (targetEntity != null && coordCount > 0) {
                    return 'entity_id 和目标坐标只能给一种，不能同时给。';
                }
                if (targetEntity == null && coordCount !== 3) {
                    return '要么给活体目标 entity_id，要么给完整的三个目标坐标。';
                }
                return await throwingLib.throwItemSkill(agent.bot, name, rawX, rawY, rawZ, {
                    exactItem: name === 'arrow' ? undefined : item,
                }, {
                    targetEntity: targetEntity ?? undefined,
                });
            },
        ),
    },
];
