import CerebrasSDK from '@cerebras/cerebras_cloud_sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class Cerebras implements AIModel {
  static prefix = 'cerebras';
  private model_name: string | null;
  private url: string | undefined;
  private params: Record<string, unknown> | undefined;
  private client: CerebrasSDK;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.url = url;
    this.params = params;

    // Initialize client with API key
    this.client = new CerebrasSDK({ apiKey: getKey('CEREBRAS_API_KEY') });
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq = '***',
  ): Promise<string> {
    void stop_seq;
    // Format messages array
    const messages = strictFormat(turns);
    messages.unshift({ role: 'system', content: systemMessage });

    const pack = {
      model: this.model_name || 'gpt-oss-120b',
      messages,
      stream: false as const,
      ...(this.params ?? {}),
    };

    let res: string | null;
    try {
      // `as never`: the SDK's overloads are strict about message/stream shapes;
      // the payload above is OpenAI-compatible and correct at runtime.
      const completion = (await this.client.chat.completions.create(pack as never)) as unknown as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      // OpenAI-compatible shape
      res = completion.choices?.[0]?.message?.content || '';
    } catch (err) {
      console.error('Cerebras API error:', err);
      res = 'My brain disconnected, try again.';
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
