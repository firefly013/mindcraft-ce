import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class DeepSeek implements AIModel {
  static prefix = 'deepseek';
  private model_name: string | null;
  private params: Record<string, unknown> | undefined;
  private openai: OpenAIApi;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params;

    const config: { baseURL?: string; apiKey?: string } = {};

    config.baseURL = url || 'https://api.deepseek.com';
    config.apiKey = getKey('DEEPSEEK_API_KEY');

    this.openai = new OpenAIApi(config);
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq = '***',
  ): Promise<string> {
    let messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...turns];

    messages = strictFormat(messages);

    const pack = {
      model: this.model_name || 'deepseek-chat',
      messages,
      stop: stop_seq,
      ...(this.params ?? {}),
    };

    let res: string | null;
    try {
      console.log('Awaiting deepseek api response...');
      // console.log('Messages:', messages);
      const completion = await this.openai.chat.completions.create(pack);
      if (completion.choices[0].finish_reason == 'length') throw new Error('Context length exceeded');
      console.log('Received.');
      res = completion.choices[0].message.content ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown } | undefined)?.code;
      if ((msg == 'Context length exceeded' || code == 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
      } else {
        console.log(err);
        res = 'My brain disconnected, try again.';
      }
    }
    return res ?? 'My brain disconnected, try again.';
  }
}
