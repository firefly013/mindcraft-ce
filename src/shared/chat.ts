/*
 * 聊天词表：玩家说这些话时按"紧急"处理。
 *
 * 两个调用点，必须同一份词表：
 *   - 身体侧的边沿检测（`body/edges.ts::resolvePriority`）把含这些词的聊天判成 L4；
 *   - 大脑侧的 `Agent` 也用它把"停 / 危险 / 救命"直接当高优先级输入。
 * 各写一份就会漂，而漂了的后果是"玩家喊停，机器人继续挖"。
 */

/** 触发最高优先级（L4 抢占）的聊天关键词。 */
export const STOP_WORDS: readonly string[] = Object.freeze(['停', '别动', '危险', '救命', 'stop']);
