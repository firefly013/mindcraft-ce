import OpenAIApi from 'openai';
import { getKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class OpenRouter implements AIModel {
  static prefix = 'openrouter';
  private model_name: string | null;
  private openai: OpenAIApi;

  constructor(model_name: string | null, url?: string, _params?: Record<string, unknown>) {
    void _params; // the original wrapper ignores profile params; keep that behavior.
    this.model_name = model_name;

    const config: { baseURL?: string; apiKey?: string } = {};
    config.baseURL = url || 'https://openrouter.ai/api/v1';

    const apiKey = getKey('OPENROUTER_API_KEY');
    if (!apiKey) {
      console.error('Error: OPENROUTER_API_KEY not found. Make sure it is set properly.');
    }

    // Pass the API key to OpenAI compatible Api
    config.apiKey = apiKey;

    this.openai = new OpenAIApi(config);
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq = '*',
  ): Promise<string> {
    let messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...turns];
    messages = strictFormat(messages);

    // Choose a valid model from openrouter.ai (for example, "openai/gpt-4o")
    const pack = {
      model: this.model_name,
      messages,
      stop: stop_seq,
    };

    let res: string | null;
    try {
      console.log('Awaiting openrouter api response...');
      const completion = (await this.openai.chat.completions.create(
        pack as Parameters<typeof this.openai.chat.completions.create>[0],
      )) as unknown as {
        choices: Array<{
          finish_reason?: string;
          message: { content?: string | null };
        }>;
      };
      if (!completion?.choices?.[0]) {
        console.error('No completion or choices returned:', completion);
        return 'No response received.';
      }
      if (completion.choices[0].finish_reason === 'length') {
        throw new Error('Context length exceeded');
      }
      console.log('Received.');
      res = completion.choices[0].message.content ?? '';
    } catch (err) {
      console.error('Error while awaiting response:', err);
      // If the error indicates a context-length problem, we can slice the turns array, etc.
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
