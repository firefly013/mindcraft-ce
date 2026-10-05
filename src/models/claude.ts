import Anthropic from '@anthropic-ai/sdk';
import { strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class Claude implements AIModel {
  static prefix = 'anthropic';
  private model_name: string | null;
  private params: Record<string, unknown>;
  private anthropic: Anthropic;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params ?? {};

    const config: Record<string, string> = {};
    if (url) config['baseURL'] = url;

    config['apiKey'] = getKey('ANTHROPIC_API_KEY');

    this.anthropic = new Anthropic(config);
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    const messages = strictFormat(turns);
    let res: string | null;
    try {
      console.log(`Awaiting anthropic response from ${this.model_name}...`);
      const p = this.params as { max_tokens?: number; thinking?: { budget_tokens?: number } };
      if (!p.max_tokens) {
        if (p.thinking?.budget_tokens) {
          p.max_tokens = p.thinking.budget_tokens + 1000;
          // max_tokens must be greater than thinking.budget_tokens
        } else {
          p.max_tokens = 4096;
        }
      }
      const resp = await this.anthropic.messages.create({
        model: this.model_name || 'claude-sonnet-4-6',
        system: systemMessage,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        ...(this.params as Record<string, never>),
      } as never);

      console.log('Received.');
      // get first content of type text
      const textContent = resp.content.find((content) => content.type === 'text');
      if (textContent && textContent.type === 'text') {
        res = textContent.text;
      } else {
        console.warn('No text content found in the response.');
        res = 'No response from Claude.';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('does not support image input')) {
        res = 'Vision is only supported by certain models.';
      } else {
        res = 'My brain disconnected, try again.';
      }
      console.log(err);
    }
    return res ?? 'My brain disconnected, try again.';
  }

  sendVisionRequest(
    turns: ChatMessage[],
    systemMessage: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    const imageMessages = [...(turns as unknown as Array<Record<string, unknown>>)];
    imageMessages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: systemMessage,
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: imageBuffer.toString('base64'),
          },
        },
      ] as unknown as string,
    });

    return this.sendRequest(imageMessages as unknown as ChatMessage[], systemMessage);
  }
}
