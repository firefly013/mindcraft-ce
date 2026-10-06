import type { ChatMessage } from '../types/common.js';

// ensures stricter turn order and roles:
// - system messages are treated as user messages and prefixed with SYSTEM:
// - combines repeated messages from users
// - separates repeat assistant messages with filler user messages
export function strictFormat(turns: ChatMessage[]): ChatMessage[] {
  let prev_role: ChatMessage['role'] | null = null;
  const messages: ChatMessage[] = [];
  const filler: ChatMessage = { role: 'user', content: '_' };
  for (const msg of turns) {
    if (typeof msg.content === 'string') {
      msg.content = msg.content.trim();
    }
    if (msg.role === 'system') {
      msg.role = 'user';
      msg.content = 'SYSTEM: ' + msg.content;
    }
    if (msg.role === prev_role && msg.role === 'assistant') {
      // insert empty user message to separate assistant messages
      messages.push(filler);
      messages.push(msg);
    } else if (msg.role === prev_role) {
      // combine new message with previous message instead of adding a new one
      messages[messages.length - 1].content += '\n' + msg.content;
    } else {
      messages.push(msg);
    }
    prev_role = msg.role;
  }
  if (messages.length > 0 && messages[0].role !== 'user') {
    messages.unshift(filler); // anthropic requires user message to start
  }
  if (messages.length === 0) {
    messages.push(filler);
  }
  return messages;
}

/**
 * 内部历史条目 -> 发给模型的消息（Pi 的 `convertToLlm` 对应物）。
 *
 * 历史条目上挂着 `kind` / `level` / `at` / `usage` 这些内部字段，
 * 它们不是 API 的一部分：直接把它们塞进请求体，轻则浪费 token，
 * 重则被严格网关判成非法字段。这里只保留 role + content，
 * 再走 strictFormat 保证角色交替合法。
 */
export function toLlmMessages(turns: ChatMessage[]): ChatMessage[] {
  return strictFormat(
    turns.map((turn) => ({ role: turn.role, content: turn.content }) as ChatMessage),
  );
}

/**
 * 摘要请求用的对话序列化（Pi 的 `serializeConversation` 对应物）。
 *
 * 用 `[User]:` / `[Assistant]:` / `[Tool result]:` 这种台账格式，
 * 而不是原样的多轮消息：摘要模型是在**读一份记录**，不是在接着聊，
 * 否则它会顺着最后一条 assistant 的语气继续写下去。
 *
 * 单条截断到 `entryLimit`：工具回执（stats / 背包 / 搜索结果）往往是
 * 上下文中最大的一块，摘要请求自己也会撑爆。
 */
export const SUMMARIZE_ENTRY_LIMIT = 2000;

export function serializeConversation(turns: ChatMessage[], entryLimit = SUMMARIZE_ENTRY_LIMIT): string {
  const label = (turn: ChatMessage): string => {
    if (turn.kind === 'summary') return '[Previous summary]';
    if (turn.kind === 'tool') return '[Tool result]';
    if (turn.role === 'assistant') return '[Assistant]';
    if (turn.role === 'user') return '[User]';
    return '[System]';
  };
  const lines: string[] = [];
  for (const turn of turns) {
    const chars = Array.from(turn.content);
    const body =
      chars.length > entryLimit
        ? `${chars.slice(0, entryLimit).join('')}…[truncated ${chars.length - entryLimit} chars]`
        : turn.content;
    lines.push(`${label(turn)}: ${body}`);
  }
  return lines.join('\n');
}
