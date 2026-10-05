import Groq from 'groq-sdk';
import { getKey } from '../utils/keys.js';
import type { AIModel, ChatMessage } from '../types/common.js';

// THIS API IS NOT TO BE CONFUSED WITH GROK!
// Go to grok.js for that. :)

// Umbrella class for everything under the sun... That GroqCloud provides, that is.
export class GroqCloudAPI implements AIModel {
  static prefix = 'groq';

  private model_name: string | null;
  private url: string | undefined;
  private params: Record<string, unknown>;
  private groq: Groq;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.url = url;
    this.params = params ?? {};

    // Remove any mention of "tools" from params:
    if (this.params.tools) delete this.params.tools;
    // This is just a bit of future-proofing in case we drag Mindcraft in that direction.

    // I'm going to do a sneaky ReplicateAPI theft for a lot of this, aren't I?
    if (this.url) console.warn('Groq Cloud has no implementation for custom URLs. Ignoring provided URL.');

    this.groq = new Groq({ apiKey: getKey('GROQCLOUD_API_KEY') });
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq: string | null = null,
  ): Promise<string> {
    // Construct messages array
    const messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...turns];

    let res: string | null;

    try {
      console.log('Awaiting Groq response...');

      // Handle deprecated max_tokens parameter
      if (this.params.max_tokens) {
        console.warn(
          'GROQCLOUD WARNING: A profile is using `max_tokens`. This is deprecated. Please move to `max_completion_tokens`.',
        );
        this.params.max_completion_tokens = this.params.max_tokens;
        delete this.params.max_tokens;
      }

      if (!this.params.max_completion_tokens) {
        this.params.max_completion_tokens = 4000;
      }

      const completion = await this.groq.chat.completions.create({
        messages: messages as never,
        model: this.model_name || 'qwen/qwen3-32b',
        stream: false,
        stop: stop_seq,
        ...(this.params as Record<string, never>),
      });

      res = completion.choices[0].message.content ?? '';

      res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('content must be a string')) {
        res = 'Vision is only supported by certain models.';
      } else {
        res = 'My brain disconnected, try again.';
      }
      console.log(err);
    }
    return res ?? 'My brain disconnected, try again.';
  }

  sendVisionRequest(
    messages: ChatMessage[],
    systemMessage: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    const imageMessages = messages.filter((message) => message.role !== 'system') as unknown as Array<
      Record<string, unknown>
    >;
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

    // NOTE: original code omitted `systemMessage` here (it arrived as `undefined`);
    // pass it through so the vision prompt is actually used.
    return this.sendRequest(imageMessages as unknown as ChatMessage[], systemMessage);
  }
}
