import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

export class Ollama implements AIModel {
  static prefix = 'ollama';
  private model_name: string | null;
  private params: Record<string, unknown> | undefined;
  private url: string;
  private chat_endpoint: string;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.params = params;
    this.url = url || 'http://127.0.0.1:11434';
    this.chat_endpoint = '/api/chat';
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    const model = this.model_name || 'sweaterdog/andy-4:micro-q8_0';
    const messages = strictFormat(turns);
    messages.unshift({ role: 'system', content: systemMessage });
    const maxAttempts = 5;
    let attempt = 0;
    let finalRes: string | null = null;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`Awaiting local response... (model: ${model}, attempt: ${attempt})`);
      let res: string | null;
      try {
        const apiResponse = await this.send(this.chat_endpoint, {
          model: model,
          messages: messages,
          stream: false,
          ...(this.params ?? {}),
        });
        if (apiResponse) {
          res = apiResponse['message']['content'] as string;
        } else {
          res = 'No response data.';
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('context length') && turns.length > 1) {
          console.log('Context length exceeded, trying again with shorter context.');
          return await this.sendRequest(turns.slice(1), systemMessage);
        } else {
          console.log(err);
          res = 'My brain disconnected, try again.';
        }
      }

      const safe = res ?? '';
      const hasOpenTag = safe.includes('<think>');
      const hasCloseTag = safe.includes('</think>');

      if (hasOpenTag && !hasCloseTag) {
        console.warn('Partial <think> block detected. Re-generating...');
        if (attempt < maxAttempts) continue;
      }
      if (hasCloseTag && !hasOpenTag) {
        res = '<think>' + safe;
      }
      if (hasOpenTag && hasCloseTag) {
        res = safe.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
      finalRes = res;
      break;
    }

    if (finalRes == null) {
      console.warn('Could not get a valid response after max attempts.');
      finalRes = 'I thought too hard, sorry, try again.';
    }
    return finalRes;
  }

  async send(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, Record<string, string>> | null> {
    const url = new URL(endpoint, this.url);
    const method = 'POST';
    const headers = new Headers();
    const request = new Request(url, { method, headers, body: JSON.stringify(body) });
    let data: Record<string, Record<string, string>> | null = null;
    try {
      const res = await fetch(request);
      if (res.ok) {
        data = (await res.json()) as Record<string, Record<string, string>>;
      } else {
        throw new Error(`Ollama Status: ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to send Ollama request.');
      console.error(err);
    }
    return data;
  }

  sendVisionRequest(
    messages: ChatMessage[],
    systemMessage: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    // Ollama vision models expect OpenAI-style image parts; keep as loose messages.
    const imageMessages = [...(messages as unknown as Array<Record<string, unknown>>)];
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
