import { Mistral as MistralClient } from '@mistralai/mistralai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class Mistral implements AIModel {
  static prefix = 'mistral';
  #client: MistralClient;
  private model_name: string | null | undefined;
  private params: Record<string, unknown> | undefined;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params;

    if (typeof url === 'string') {
      console.warn("Mistral does not support custom URL's, ignoring!");
    }

    if (!getKey('MISTRAL_API_KEY')) {
      throw new Error('Mistral API Key missing, make sure to set MISTRAL_API_KEY in settings.json');
    }

    this.#client = new MistralClient({
      apiKey: getKey('MISTRAL_API_KEY'),
    });

    // Prevents the following code from running when model not specified
    if (typeof this.model_name === 'undefined' || this.model_name === null) return;

    // get the model name without the "mistral" or "mistralai" prefix
    // e.g "mistral/mistral-large-latest" -> "mistral-large-latest"
    if (typeof model_name?.split('/')[1] !== 'undefined') {
      this.model_name = model_name?.split('/')[1];
    }
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    let result: string | null;

    try {
      const model = this.model_name || 'mistral-large-latest';

      const messages: ChatMessage[] = [{ role: 'system', content: systemMessage }];
      messages.push(...strictFormat(turns));

      console.log('Awaiting mistral api response...');
      const response = await this.#client.chat.complete({
        model,
        messages: messages as never,
        ...(this.params as Record<string, never> | undefined),
      });

      const content = response.choices?.[0]?.message?.content;
      result = typeof content === 'string' ? content : String(content ?? '');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes(
          "A request containing images has been given to a model which does not have the 'vision' capability.",
        )
      ) {
        result = 'Vision is only supported by certain models.';
      } else {
        result = 'My brain disconnected, try again.';
      }
      console.log(err);
    }

    return result ?? 'My brain disconnected, try again.';
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
          imageUrl: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
        },
      ],
    });

    return this.sendRequest(imageMessages as unknown as ChatMessage[], systemMessage);
  }
}
