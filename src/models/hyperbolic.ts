import { getKey } from '../utils/keys.js';
import type { AIModel, ChatMessage } from '../types/common.js';

/** Hyperbolic chat completion response shape. */
interface HyperbolicChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
}

export class Hyperbolic implements AIModel {
  static prefix = 'hyperbolic';
  private modelName: string;
  private apiUrl: string;
  private apiKey: string;

  constructor(modelName: string | null, apiUrl?: string, _params?: Record<string, unknown>) {
    void _params; // Hyperbolic uses fixed request options; profile params are ignored (as in the original).
    this.modelName = modelName || 'deepseek-ai/DeepSeek-V3';
    this.apiUrl = apiUrl || 'https://api.hyperbolic.xyz/v1/chat/completions';

    // Retrieve the Hyperbolic API key from keys.js
    this.apiKey = getKey('HYPERBOLIC_API_KEY');
    if (!this.apiKey) {
      throw new Error('HYPERBOLIC_API_KEY not found. Check your keys.js file.');
    }
  }

  /**
   * Sends a chat completion request to the Hyperbolic endpoint.
   *
   * @param turns - An array of message objects, e.g. [{role: 'user', content: 'Hi'}].
   * @param systemMessage - The system prompt or instruction.
   * @param stopSeq - A stopping sequence, default '***'.
   * @returns The model's reply.
   */
  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stopSeq = '***',
  ): Promise<string> {
    void stopSeq; // accepted for a uniform model interface; the payload uses fixed options.
    // Prepare the messages with a system prompt at the beginning
    const messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...turns];

    // Build the request payload
    const payload = {
      model: this.modelName,
      messages: messages,
      max_tokens: 8192,
      temperature: 0.7,
      top_p: 0.9,
      stream: false,
    };

    const maxAttempts = 5;
    let attempt = 0;
    let finalRes: string | null = null;

    while (attempt < maxAttempts) {
      attempt++;
      console.log(`Awaiting Hyperbolic API response... (attempt: ${attempt})`);
      console.log('Messages:', messages);

      let completionContent: string | null;

      try {
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = (await response.json()) as HyperbolicChatResponse;
        if (data?.choices?.[0]?.finish_reason === 'length') {
          throw new Error('Context length exceeded');
        }

        completionContent = data?.choices?.[0]?.message?.content || '';
        console.log('Received response from Hyperbolic.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: unknown } | undefined)?.code;
        if (
          (msg === 'Context length exceeded' || code === 'context_length_exceeded') &&
          turns.length > 1
        ) {
          console.log('Context length exceeded, trying again with a shorter context...');
          return await this.sendRequest(turns.slice(1), systemMessage, stopSeq);
        } else {
          console.error(err);
          completionContent = 'My brain disconnected, try again.';
        }
      }

      const safe = completionContent ?? '';
      // Check for <think> blocks
      const hasOpenTag = safe.includes('<think>');
      const hasCloseTag = safe.includes('</think>');

      if (hasOpenTag && !hasCloseTag) {
        console.warn('Partial <think> block detected. Re-generating...');
        continue; // Retry the request
      }

      if (hasCloseTag && !hasOpenTag) {
        completionContent = '<think>' + safe;
      } else if (hasOpenTag && hasCloseTag) {
        completionContent = safe.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      } else {
        completionContent = safe;
      }

      finalRes = (completionContent ?? '').replace(/<\|separator\|>/g, '*no response*');
      break; // Valid response obtained—exit loop
    }

    if (finalRes == null) {
      console.warn('Could not get a valid <think> block or normal response after max attempts.');
      finalRes = 'I thought too hard, sorry, try again.';
    }
    return finalRes;
  }
}
