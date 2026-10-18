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
  /** 本来是"点名要说"，但被队友唤醒预算压回了只记录。 */
  rateLimited?: boolean;
}

/**
 * 队友"点名唤醒"的最小间隔（毫秒）。
 *
 * 真机现象：两个 bot 的状态汇报里**天然会带对方的名字**（"overnight_a：等你来"），
 * 于是"点名才唤醒"这条规则在实测里几乎等于"每条都唤醒"——overnight_a 每 4 分钟
 * 被叫醒一次，醒来只回一句话，接着又睡；而它自己的活一直没推进。
 *
 * 90 秒够短（真有事对方下一分钟就能把你叫起来），又足够长（把状态刷屏这种
 * 高频噪声压成 L2 记录）。**急停词不走预算**：喊"救命/停/危险"永远 L4 抢占。
 */
export const TEAMMATE_WAKE_MIN_GAP_MS = 90_000;

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
 *   真正的活被挤掉。只有**点名喊我**或私聊才算真的在跟我说话，而且点名唤醒
 *   还受 `TEAMMATE_WAKE_MIN_GAP_MS` 的预算约束；喊急停词永远抢占。
 */
export function classifyChat(input: {
  message: string;
  /** 发消息的人是不是队友（另一个 bot）。 */
  fromTeammate: boolean;
  /** 私聊（只有我能看到）。 */
  whisper: boolean;
  /** 我自己的名字；消息里出现它就算点名。 */
  selfName: string;
  /**
   * 距离这个队友上一次真的把我叫醒过了多久（毫秒）。没叫过就给 null。
   * 只在"队友 + 点名 + 非急停"时参与判定。
   */
  sinceLastWakeMs?: number | null;
}): ChatDelivery {
  const lower = input.message.toLowerCase();
  const urgent = STOP_WORDS.some((word) => lower.includes(word.toLowerCase()));
  const addressed = input.whisper || lower.includes(input.selfName.toLowerCase());
  if (!input.fromTeammate) {
    return { addressed: true, level: urgent ? 4 : 3, expectReply: true };
  }
  if (urgent) {
    // 急停词永远抢占：队友喊"救命"可能就是真的。
    return { addressed, level: 4, expectReply: addressed };
  }
  if (!addressed) {
    return { addressed: false, level: 2, expectReply: false };
  }
  const since = input.sinceLastWakeMs;
  if (since != null && since < TEAMMATE_WAKE_MIN_GAP_MS) {
    return { addressed: true, level: 2, expectReply: false, rateLimited: true };
  }
  return { addressed: true, level: 3, expectReply: true };
}

