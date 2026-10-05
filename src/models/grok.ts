import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import type { AIModel, ChatMessage } from '../types/common.js';

// xAI doesn't supply a SDK for their models, but fully supports OpenAI and Anthropic SDKs
export class Grok implements AIModel {
  static prefix = 'xai';
  private model_name: string | null;
  private url: string | undefined;
  private params: Record<string, unknown> | undefined;
  private openai: OpenAIApi;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.url = url;
    this.params = params;

    const config: { baseURL?: string; apiKey?: string } = {};
    if (url) config.baseURL = url;
    else config.baseURL = 'https://api.x.ai/v1';

    config.apiKey = getKey('XAI_API_KEY');

    this.openai = new OpenAIApi(config);
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    const messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...turns];

    const pack = {
      model: this.model_name || 'grok-4.1-fast-non-reasoning',
      messages,
      ...(this.params ?? {}),
    };

    let res: string | null;
    try {
      console.log('Awaiting xai api response...');
      ///console.log('Messages:', messages);
      const completion = await this.openai.chat.completions.create(pack);
      if (completion.choices[0].finish_reason == 'length') throw new Error('Context length exceeded');
      console.log('Received.');
      res = completion.choices[0].message.content ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown } | undefined)?.code;
      if ((msg == 'Context length exceeded' || code == 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        return await this.sendRequest(turns.slice(1), systemMessage);
      } else if (msg.includes('The model expects a single `text` element per message.')) {
        console.log(err);
        res = 'Vision is only supported by certain models.';
      } else {
        console.log(err);
        res = 'My brain disconnected, try again.';
      }
    }
    // sometimes outputs special token <|separator|>, just replace it
    return (res ?? 'My brain disconnected, try again.').replace(/<\|separator\|>/g, '*no response*');
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
