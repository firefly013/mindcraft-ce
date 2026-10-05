/*
 * OpenCode Zen 网关（OpenAI 兼容）：默认 `deepseek-v4.1-flash`，思考全关。
 *
 * 接线依据（均为公开文档，不是猜的）：
 *   - 模型 ID 与 chat/completions 入口：https://opencode.ai/docs/zen/
 *     （DeepSeek V4.1 Flash → `deepseek-v4.1-flash`，
 *     `https://opencode.ai/zen/v1/chat/completions`）
 *   - 思考开关：DeepSeek API 文档 thinking_mode
 *     （OpenAI 格式走 extra_body `{"thinking": {"type": "disabled"}}`，
 *     默认开启，不关就一直想）
 *   - `x-opencode-session` 会话路由头：网关按会话路由，
 *     每个进程一个，OPENCODE_SESSION_ID 可覆盖。
 *
 * Key 名 OPENCODE_API_KEY：keys.json 或环境变量都行
 * （keys.ts 两边都读）。思考硬关闭——profile params 也打不开，
 * 这是故意的：要开思考就换别的供应商。
 */

import OpenAIApi from 'openai';
import { randomUUID } from 'crypto';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type {
  AIModel,
  ChatMessage,
  OpenAITool,
  ToolResponse,
} from '../types/common.js';

export const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
export const OPENCODE_DEFAULT_MODEL = 'deepseek-v4.1-flash';

/** 最小的可注入 client 形状：不断网单测用。 */
export interface OpenCodeClient {
  chat: {
    completions: {
      create: (
        body: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => Promise<{
        choices: Array<{
          finish_reason?: string;
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      }>;
    };
  };
}

export class OpenCode implements AIModel {
  static prefix = 'opencode';
  private model_name: string | null;
  private params: Record<string, unknown> | undefined;
  private openai: OpenCodeClient;
  readonly sessionId: string;

  constructor(
    model_name: string | null,
    url?: string,
    params?: Record<string, unknown>,
    client?: OpenCodeClient,
  ) {
    this.model_name = model_name;
    this.params = params;
    const session =
      (params?.['session_id'] as string | undefined) ??
      process.env['OPENCODE_SESSION_ID'] ??
      randomUUID();
    this.sessionId = session;
    this.openai =
      client ??
      (new OpenAIApi({
        baseURL: url || OPENCODE_BASE_URL,
        apiKey: getKey('OPENCODE_API_KEY'),
        defaultHeaders: { 'x-opencode-session': session },
      }) as unknown as OpenCodeClient);
  }

  private bodyBase(model: string, messages: ChatMessage[]): Record<string, unknown> {
    return {
      model,
      messages,
      ...(this.params ?? {}),
    };
  }

  /** 思考硬关闭的 extra_body（DeepSeek 文档格式）。 */
  private noThink(): Record<string, unknown> {
    return { extra_body: { thinking: { type: 'disabled' } } };
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    const messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...strictFormat(turns)];
    const model = this.model_name || OPENCODE_DEFAULT_MODEL;
    try {
      console.log(`Awaiting opencode response... (model: ${model})`);
      const completion = await this.openai.chat.completions.create(
        this.bodyBase(model, messages),
        this.noThink(),
      );
      if (completion.choices[0]?.finish_reason == 'length') throw new Error('Context length exceeded');
      console.log('Received.');
      return completion.choices[0]?.message.content ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown } | undefined)?.code;
      if ((msg == 'Context length exceeded' || code == 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        return await this.sendRequest(turns.slice(1), systemMessage);
      }
      console.log(err);
      return 'My brain disconnected, try again.';
    }
  }

  async sendRequestWithTools(
    turns: ChatMessage[],
    systemMessage: string,
    tools: OpenAITool[],
    tool_choice = 'auto',
    liveTail = '',
  ): Promise<ToolResponse> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemMessage },
      ...strictFormat(turns),
    ];
    // Live 快照放最后单独发：常变部分永不前移，前缀缓存才保得住。
    if (liveTail.trim() !== '') {
      messages.push({ role: 'user', content: `## 当前世界快照\n${liveTail}` });
    }
    const model = this.model_name || OPENCODE_DEFAULT_MODEL;
    console.log(`Awaiting opencode tool response... (model: ${model})`);
    const completion = await this.openai.chat.completions.create(
      { ...this.bodyBase(model, messages), tools, tool_choice },
      this.noThink(),
    );
    const msg = completion.choices[0]?.message ?? { content: '' };
    let tool_calls: ToolResponse['tool_calls'];
    try {
      tool_calls = (msg.tool_calls ?? []).map((tc) => {
        let args: Record<string, unknown>;
        try {
          args = (JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>) ?? {};
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.function?.name ?? '', args };
      });
    } catch {
      tool_calls = [];
    }
    return { text: msg.content ?? '', tool_calls };
  }
}

export function hasOpenCodeKey(): boolean {
  return hasKey('OPENCODE_API_KEY') !== undefined;
}
