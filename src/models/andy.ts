import { hasKey, getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage, OpenAITool, ToolResponse } from '../types/common.js';

/** OpenAI-compatible chat completion shape returned by the Andy gateway. */
interface AndyChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
}

export class Andy implements AIModel {
  static prefix = 'andy';

  private model_name: string | null;
  private params: Record<string, unknown> | undefined;
  private base_url: string;
  private chat_endpoint: string;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name || 'auto';
    this.params = params;
    this.base_url = url || 'https://andy.mindcraft-ce.com';
    this.chat_endpoint = '/api/v1/chat/completions';
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    const model = this.model_name || 'auto';
    const messages: ChatMessage[] = [
      { role: 'system', content: systemMessage },
      ...strictFormat(turns),
    ];

    const maxAttempts = 5;
    let attempt = 0;
    let finalRes: string | null = null;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`Awaiting Andy API response... (model: ${model}, attempt: ${attempt})`);
      let res: string | null;
      try {
        const data = await this.send(this.chat_endpoint, {
          model,
          messages,
          stream: false,
          ...(this.params ?? {}),
        });
        if (data?.choices?.[0]?.message?.content) {
          res = data.choices[0].message.content;
        } else {
          res = 'No response data.';
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('context length') && turns.length > 1) {
          console.log('Context length exceeded, trying again with shorter context.');
          return await this.sendRequest(turns.slice(1), systemMessage);
        } else {
          console.log(err);
          res = 'My brain disconnected, try again.';
        }
      }

      const safe = res ?? '';
      const hasOpenTag = safe.includes('<think>');
      const hasCloseTag = safe.includes('</think>');

      if (hasOpenTag && !hasCloseTag) {
        console.warn('Partial <think> block detected. Re-generating...');
        if (attempt < maxAttempts) continue;
      }
      if (hasCloseTag && !hasOpenTag) {
        res = '<think>' + safe;
      }
      if (hasOpenTag && hasCloseTag) {
        res = safe.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
      finalRes = res;
      break;
    }

    if (finalRes == null) {
      console.warn('Could not get a valid response after max attempts.');
      finalRes = 'I thought too hard, sorry, try again.';
    }
    return finalRes;
  }

  /**
   * OpenAI 原生工具调用（OpenAI 兼容网关）：把 !Command 转换后的 tools
   * 透传给 chat/completions，返回 { text, tool_calls: [{ id, name, args }] }。
   * 调用方用 executeToolCall 执行。不支持时抛错，由上层回落到文本 !Command。
   */
  async sendRequestWithTools(
    turns: ChatMessage[],
    systemMessage: string,
    tools: OpenAITool[],
    tool_choice = 'auto',
  ): Promise<ToolResponse> {
    const model = this.model_name || 'auto';
    const messages: ChatMessage[] = [
      { role: 'system', content: systemMessage },
      ...strictFormat(turns),
    ];
    console.log(`Awaiting Andy tool response... (model: ${model})`);
    const data = await this.send(this.chat_endpoint, {
      model,
      messages,
      tools,
      tool_choice,
      stream: false,
      ...(this.params ?? {}),
    });
    const msg: NonNullable<NonNullable<AndyChatResponse['choices']>[number]['message']> =
      data?.choices?.[0]?.message ?? {};
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

  async send(endpoint: string, body: Record<string, unknown>): Promise<AndyChatResponse> {
    const url = new URL(endpoint, this.base_url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = hasKey('ANDY_API_KEY') ? getKey('ANDY_API_KEY') : null;
    if (apiKey && apiKey !== 'optional') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const request = new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const res = await fetch(request);
    if (!res.ok) {
      throw new Error(`Andy API status: ${res.status}`);
    }
    return (await res.json()) as AndyChatResponse;
  }
}
