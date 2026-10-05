import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type {
  AIModel,
  ChatMessage,
  OpenAITool,
  ToolResponse,
} from '../types/common.js';

export class GPT implements AIModel {
  static prefix = 'openai';
  // `protected` (not `private`) so subclasses (e.g. AzureGPT) can reconfigure them.
  protected model_name: string | null;
  protected params: Record<string, unknown> | undefined;
  protected url: string | undefined;
  protected openai: OpenAIApi;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params;
    this.url = url; // store so that we know whether a custom URL has been set

    const config: Record<string, string> = {};
    if (url) config['baseURL'] = url;

    if (hasKey('OPENAI_ORG_ID')) config['organization'] = getKey('OPENAI_ORG_ID');

    config['apiKey'] = getKey('OPENAI_API_KEY');

    this.openai = new OpenAIApi(config);
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq = '***',
  ): Promise<string> {
    const messages = strictFormat(turns).map((message) => {
      message.content += stop_seq;
      return message;
    });
    const model = this.model_name || 'gpt-5.4-mini';

    let res: string | null;

    try {
      console.log('Awaiting openai api response from model', model);
      // if a custom URL is set, use chat.completions
      // because custom "OpenAI-compatible" endpoints likely do not have responses endpoint
      if (this.url) {
        let msgs = [{ role: 'system', content: systemMessage } as ChatMessage].concat(turns);
        msgs = strictFormat(msgs);
        const pack: Record<string, unknown> = {
          model: model,
          messages: msgs,
          stop: stop_seq,
          ...(this.params ?? {}),
        };
        if (model.includes('o1') || model.includes('o3') || model.includes('5')) {
          delete pack['stop'];
        }
        const completion = (await this.openai.chat.completions.create(
          pack as unknown as Parameters<typeof this.openai.chat.completions.create>[0],
        )) as unknown as {
          choices: Array<{
            finish_reason?: string;
            message: { content: string | null; tool_calls?: never[] };
          }>;
        };
        if (completion.choices[0]?.finish_reason == 'length')
          throw new Error('Context length exceeded');
        console.log('Received.');
        res = completion.choices[0]?.message.content ?? null;
      } else {
        const msgs = strictFormat(turns);
        const withStop = msgs.map((message) => {
          message.content += stop_seq;
          return message;
        });
        const response = await this.openai.responses.create({
          model: model,
          instructions: systemMessage,
          input: withStop as never,
          ...(this.params ?? {}),
        });
        console.log('Received.');
        res = response.output_text;
        const stop_seq_index = res.indexOf(stop_seq);
        res = stop_seq_index !== -1 ? res.slice(0, stop_seq_index) : res;
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if ((msg == 'Context length exceeded' || code == 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
      } else if (msg.includes('image_url')) {
        console.log(err);
        res = 'Vision is only supported by certain models.';
      } else {
        console.log(err);
        res = 'My brain disconnected, try again.';
      }
    }
    return res ?? 'My brain disconnected, try again.';
  }

  /**
   * OpenAI 原生工具调用：把命令转换后的 tools 直接透传给 chat.completions。
   * liveTail（现采 Live State）放消息列最后单独发，不进 system。
   * 返回 { text, tool_calls: [{ id, name, args }] }，调用方用 executeToolCall 执行。
   */
  async sendRequestWithTools(
    turns: ChatMessage[],
    systemMessage: string,
    tools: OpenAITool[],
    tool_choice = 'auto',
    liveTail = '',
  ): Promise<ToolResponse> {
    const messages = [{ role: 'system', content: systemMessage } as ChatMessage].concat(
      strictFormat(turns),
    );
    if (liveTail.trim() !== '') {
      messages.push({ role: 'user', content: `## 当前世界快照\n${liveTail}` });
    }
    const model = this.model_name || 'gpt-5.4-mini';
    try {
      console.log('Awaiting openai tool response from model', model);
      const completion = await this.openai.chat.completions.create({
        model,
        messages: messages as never,
        tools: tools as never,
        tool_choice: tool_choice as never,
        ...(this.params ?? {}),
      });
      const msg = completion.choices[0]?.message;
      const tool_calls = (msg?.tool_calls ?? []).map((tc) => {
        const fn = (tc as { id?: string; function?: { name?: string; arguments?: string } }).function;
        let args: Record<string, unknown>;
        try {
          args = (JSON.parse(fn?.arguments ?? '{}') ?? {}) as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { id: (tc as { id: string }).id, name: fn?.name ?? '', args };
      });
      return { text: (msg?.content ?? '') as string, tool_calls };
    } catch (err) {
      console.log(err);
      return { text: 'My brain disconnected, try again.', tool_calls: [] };
    }
  }

  sendVisionRequest(
    messages: ChatMessage[],
    systemMessage: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    const imageMessages = [...(messages as unknown as Array<Record<string, unknown>>)];
    imageMessages.push({
      role: 'user',
      content: [
        { type: 'input_text', text: systemMessage },
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
        },
      ],
    });

    return this.sendRequest(imageMessages as unknown as ChatMessage[], systemMessage);
  }
}

export async function sendAudioRequest(
  text: string,
  model: string,
  voice: string,
  url?: string,
): Promise<string> {
  const payload = {
    model: model,
    voice: voice,
    input: text,
  };

  const config: Record<string, string> = {};

  if (url) config['baseURL'] = url;

  if (hasKey('OPENAI_ORG_ID')) config['organization'] = getKey('OPENAI_ORG_ID');

  config['apiKey'] = getKey('OPENAI_API_KEY');

  const openai = new OpenAIApi(config);

  const mp3 = await openai.audio.speech.create(payload as never);
  const buffer = Buffer.from(await mp3.arrayBuffer());
  const base64 = buffer.toString('base64');
  return base64;
}

export const TTSConfig = {
  sendAudioRequest: sendAudioRequest,
  baseUrl: 'https://api.openai.com/v1',
};
