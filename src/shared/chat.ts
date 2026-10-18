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

/** 一条聊天消息的投递判定（纯逻辑，便于单测）。 */
export interface ChatDelivery {
  /** 这条消息是不是**在跟我说**（点名或私聊）。 */
  addressed: boolean;
  /** 投递力度：L2 只记录 / L3 唤醒 / L4 抢占。 */
  level: 2 | 3 | 4;
  /** 要不要在事件里要求模型回一句。 */
  expectReply: boolean;
}

/**
 * 一条聊天消息该用多大力气处理。
 *
 * 两种来源，语义**故意不同**：
 *
 * - **玩家**：是"有人在直接问你"。一律 L3/L4 唤醒 + `expectReply`，并且外面会
 *   加一层"先回一句再干活"的框。真机教训：玩家问"你们能听到我说话吗"，
 *   两个 bot 都收到了却一句话不回——因为它在模型眼里是背景噪音。
 * - **队友（另一个 bot）**：是**情报**，不是提问。默认 L2 只记录、不要求回话。
 *   真机教训（双 bot 实测）：队友消息曾经也带 `expectReply: true` + L3，于是
 *   互相报坐标变成「收到 → 回一句 → 对方再收到」的无限乒乓，一晚烧掉大量请求，
 *   真正的活被挤掉。只有**点名喊我**或私聊才算真的在跟我说话；喊急停词仍然抢占。
 */
export function classifyChat(input: {
  message: string;
  /** 发消息的人是不是队友（另一个 bot）。 */
  fromTeammate: boolean;
  /** 私聊（只有我能看到）。 */
  whisper: boolean;
  /** 我自己的名字；消息里出现它就算点名。 */
  selfName: string;
}): ChatDelivery {
  const lower = input.message.toLowerCase();
  const urgent = STOP_WORDS.some((word) => lower.includes(word.toLowerCase()));
  const addressed = input.whisper || lower.includes(input.selfName.toLowerCase());
  if (!input.fromTeammate) {
    return { addressed: true, level: urgent ? 4 : 3, expectReply: true };
  }
  return {
    addressed,
    // 急停词永远抢占（队友喊"救命"也要立刻醒），其次是点名，其余只记账。
    level: urgent ? 4 : addressed ? 3 : 2,
    expectReply: addressed,
  };
}

