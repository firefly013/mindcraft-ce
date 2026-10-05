import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

// llama, mistral
export class Novita implements AIModel {
  static prefix = 'novita';
  private model_name: string | null;
  private url: string;
  private params: Record<string, unknown> | undefined;
  private openai: OpenAIApi;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.url = url || 'https://api.novita.ai/v3/openai';
    this.params = params;

    const config: { baseURL?: string; apiKey?: string } = {
      baseURL: this.url,
    };
    config.apiKey = getKey('NOVITA_API_KEY');

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
      model: this.model_name || 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages,
      stop: [stop_seq],
      ...(this.params ?? {}),
    };

    let res: string | null;
    try {
      console.log('Awaiting novita api response...');
      const completion = await this.openai.chat.completions.create(pack);
      if (completion.choices[0].finish_reason == 'length') throw new Error('Context length exceeded');
      console.log('Received.');
      res = completion.choices[0].message.content ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown } | undefined)?.code;
      if ((msg == 'Context length exceeded' || code == 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        // NOTE: the original called a bare `sendRequest(...)` (undefined name);
        // it must be `this.sendRequest(...)`.
        return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
      } else {
        console.log(err);
        res = 'My brain disconnected, try again.';
      }
    }
    if (res && res.includes('<think>')) {
      const start = res.indexOf('<think>');
      const end = res.indexOf('</think>') + 8;
      if (start != -1) {
        if (end != -1) {
          res = res.substring(0, start) + res.substring(end);
        } else {
          res = res.substring(0, start + 7);
        }
      }
      res = res.trim();
    }
    return res ?? 'My brain disconnected, try again.';
  }
}
