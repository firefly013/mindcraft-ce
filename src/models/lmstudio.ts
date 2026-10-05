import OpenAIApi from 'openai';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class LMStudio implements AIModel {
  static prefix = 'lmstudio';
  private model_name: string | null;
  private params: Record<string, unknown> | undefined;
  private openai: OpenAIApi;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params;
    this.openai = new OpenAIApi({
      baseURL: url || 'http://localhost:1234/v1',
      apiKey: 'lm-studio', // LM Studio ignores this but the client requires a non-empty value
    });
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq = '***',
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemMessage },
      ...strictFormat(turns),
    ];
    const model = this.model_name || 'andy-4.1';
    let res: string | null;

    try {
      console.log('Awaiting LM Studio response from model', model);
      const pack = {
        model,
        messages,
        stop: stop_seq,
        ...(this.params ?? {}),
      };
      const completion = await this.openai.chat.completions.create(pack);
      if (completion.choices[0].finish_reason === 'length') throw new Error('Context length exceeded');
      console.log('Received.');
      res = completion.choices[0].message.content ?? '';
      if (res.includes('</think>')) {
        if (!res.includes('<think>')) res = '<think>' + res;
        res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown } | undefined)?.code;
      if ((msg === 'Context length exceeded' || code === 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
      } else {
        console.log(err);
        res = 'My brain disconnected, try again.';
      }
    }
    return res ?? 'My brain disconnected, try again.';
  }

  sendVisionRequest(
    messages: ChatMessage[],
    systemMessage: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    const imageMessages = [...messages] as unknown as Array<Record<string, unknown>>;
    imageMessages.push({
      role: 'user',
      content: [
        { type: 'text', text: systemMessage },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` },
        },
      ],
    });
    return this.sendRequest(imageMessages as unknown as ChatMessage[], systemMessage);
  }
}
