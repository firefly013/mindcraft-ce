// Shared core types for the Mindcraft TypeScript migration.
// Keep this file dependency-free so every module can import it.

/**
 * 一次模型调用的 token 用量，来自 provider 的 `usage` 字段。
 *
 * 这是压缩触发线的唯一可信输入：字符估算法在中文上误差极大，
 * 只有 provider 自己数的 token 才能用来判断"离上下文窗口还有多远"。
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 上下文占用量的口径：prompt + completion（缺省由两者相加）。 */
  totalTokens: number;
}

/** Single chat turn used by all model wrappers and history. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional name prefix already merged into content by History.add(). */
  name?: string;
  /**
   * 可选的事件分级元数据（compaction 用，缺了就当不可删除）：
   * kind 取 user/world/tool/model/system，level 取 1-5。
   */
  kind?: string;
  level?: number;
  /** 写入时间戳（ms），World 条目过期用。 */
  at?: number;
  /**
   * 本条 assistant 回复的真实 token 用量。压仓用它当锚点：
   * 这条之后新增的消息才需要估算，之前的量是 provider 报的实数。
   */
  usage?: TokenUsage;
}

/** OpenAI-style tool definition passed to models. */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Normalized tool call returned by models. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Result of sendRequestWithTools(). */
export interface ToolResponse {
  text: string;
  tool_calls: ToolCall[];
  /** provider 报的 token 用量；端点不返回时缺省。 */
  usage?: TokenUsage;
  /**
   * 请求因上下文超限被拒（`context_length_exceeded` / `stopReason: length`）。
   * 上层据此压缩后重试一次——这是压仓触发线之外的兜底。
   */
  overflow?: boolean;
}

/** Minimal model interface every wrapper must satisfy. */
export interface AIModel {
  sendRequest(turns: ChatMessage[], systemMessage: string, stopSeq?: string): Promise<string>;
  // 独立的 sendVisionRequest 已删除：截图随 liveImage 走主循环，没有第二条视觉链。
  sendRequestWithTools?(
    turns: ChatMessage[],
    systemMessage: string,
    tools: OpenAITool[],
    toolChoice?: string,
    /**
     * 现采 Live State 原文。实现层必须把它放在消息列最后面单独发，
     * 不能并进 system——常变部分不能前移破坏前缀缓存。
     */
    liveTail?: string,
    /**
     * 本轮现拍示意图（base64 JPEG）。只有看得懂图的实现需要处理，
     * 看不懂的直接忽略——文字快照永远都在。
     */
    liveImage?: string | null,
  ): Promise<ToolResponse>;
}

/** Profile JSON shape (profile JSON merged with defaults). */
export interface AgentProfile {
  name: string;
  model: string;
  api?: string;
  url?: string;
  params?: Record<string, unknown>;
  cooldown?: number;
  max_tokens?: number;
  skin?: { model: string; path: string };
  goal_setting?: string;
  [key: string]: unknown;
}

/** Global settings object (settings.ts). */
export interface Settings {
  minecraft_version: string;
  host: string;
  port: number | string;
  auth: string;
  mindserver_port: number | string;
  auto_open_ui: boolean;
  base_profile: string;
  profiles: string[];
  profile?: AgentProfile;
  load_memory: boolean;
  init_message: string;
  only_chat_with: string[];
  chat_ingame: boolean;
  allow_vision: boolean;
  blocked_actions: string[];
  cheat: boolean;
  spawn_timeout: number;
  task?: unknown;
  [key: string]: unknown;
}

/** Task definition fragment used by Agent. */
export interface TaskDef {
  task_id?: string | null;
  taskStartTime?: number;
  blocked_actions?: string[];
  [key: string]: unknown;
}
