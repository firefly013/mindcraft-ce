// Shared core types for the Mindcraft TypeScript migration.
// Keep this file dependency-free so every module can import it.

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
}

/** Minimal model interface every wrapper must satisfy. */
export interface AIModel {
  sendRequest(turns: ChatMessage[], systemMessage: string, stopSeq?: string): Promise<string>;
  sendVisionRequest?(messages: ChatMessage[], systemMessage: string, imageBuffer: Buffer): Promise<string>;
  sendRequestWithTools?(
    turns: ChatMessage[],
    systemMessage: string,
    tools: OpenAITool[],
    toolChoice?: string,
  ): Promise<ToolResponse>;
}

/** Profile JSON shape (andy.json etc. merged with defaults). */
export interface AgentProfile {
  name: string;
  model: string;
  api?: string;
  url?: string;
  params?: Record<string, unknown>;
  vision_model?: string;
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
  speak: boolean | string;
  chat_ingame: boolean;
  render_bot_view: boolean;
  allow_vision: boolean;
  blocked_actions: string[];
  cheat: boolean;
  max_messages: number;
  spawn_timeout: number;
  log_all_prompts: boolean | string;
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
