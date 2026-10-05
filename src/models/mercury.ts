import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class Mercury implements AIModel {
  static prefix = 'mercury';
  private model_name: string | null;
  private params: Record<string, unknown> | undefined;
  private openai: OpenAIApi;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params;
    const config: { baseURL?: string; apiKey?: string } = {};
    if (url) config.baseURL = url;
    else config.baseURL = 'https://api.inceptionlabs.ai/v1';

    config.apiKey = getKey('MERCURY_API_KEY');

    this.openai = new OpenAIApi(config);
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq: string | string[] = '***',
  ): Promise<string> {
    let stop: string[];
    if (typeof stop_seq === 'string') {
      stop = [stop_seq];
    } else if (Array.isArray(stop_seq)) {
      stop = stop_seq;
    } else {
      stop = [];
    }
    let messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...turns];
    messages = strictFormat(messages);
    const pack = {
      model: this.model_name || 'mercury-coder-small',
      messages,
      stop: stop,
      ...(this.params ?? {}),
    };

    let res: string | null;

    try {
      console.log('Awaiting mercury api response from model', this.model_name);
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
        return await this.sendRequest(turns.slice(1), systemMessage, stop);
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
          image_url: {
            url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
          },
        },
      ],
    });

    return this.sendRequest(imageMessages as unknown as ChatMessage[], systemMessage);
  }
}
