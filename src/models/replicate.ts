import Replicate from 'replicate';
import { toSinglePrompt } from '../utils/text.js';
import { getKey } from '../utils/keys.js';
import type { AIModel, ChatMessage } from '../types/common.js';

// llama, mistral, gemini
export class ReplicateAPI implements AIModel {
  static prefix = 'replicate';
  private model_name: string | null;
  private url: string | undefined;
  private params: Record<string, unknown> | undefined;
  private replicate: Replicate;

  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    this.model_name = model_name;
    this.url = url;
    this.params = params;

    if (this.url) {
      console.warn('Replicate API does not support custom URLs. Ignoring provided URL.');
    }

    this.replicate = new Replicate({
      auth: getKey('REPLICATE_API_KEY'),
    });
  }

  async sendRequest(turns: ChatMessage[], systemMessage: string): Promise<string> {
    const stop_seq = '***';
    const prompt = toSinglePrompt(turns, null, stop_seq);
    const model_name = this.model_name || 'meta/meta-llama-3-70b-instruct';

    // Detect model type to use correct input format
    const isGemini = model_name.includes('gemini');

    let input: Record<string, unknown>;
    if (isGemini) {
      // Gemini models on Replicate ignore system_prompt field
      // Combine system message into the main prompt instead
      const fullPrompt = systemMessage + '\n\n' + prompt;
      input = {
        prompt: fullPrompt,
        ...(this.params ?? {}),
      };
    } else {
      // Llama and other models use system_prompt
      input = {
        prompt,
        system_prompt: systemMessage,
        ...(this.params ?? {}),
      };
    }

    let res: string | null;
    try {
      console.log('Awaiting Replicate API response...');

      if (isGemini) {
        // Gemini doesn't stream well on Replicate, use run() instead
        const output = (await this.replicate.run(model_name as `${string}/${string}`, { input })) as unknown;
        // Output might be a string or an array
        if (Array.isArray(output)) {
          res = output.join('');
        } else if (typeof output === 'string') {
          res = output;
        } else {
          res = String(output);
        }
      } else {
        // Use streaming for other models
        let result = '';
        for await (const event of this.replicate.stream(model_name as `${string}/${string}`, { input })) {
          result += String(event);
          if (result === '') break;
          if (result.includes(stop_seq)) {
            result = result.slice(0, result.indexOf(stop_seq));
            break;
          }
        }
        res = result;
      }

      // Trim stop sequence if present
      if (res && res.includes(stop_seq)) {
        res = res.slice(0, res.indexOf(stop_seq));
      }
    } catch (err) {
      console.log(err);
      res = 'My brain disconnected, try again.';
    }
    console.log('Received.');
    return res ?? 'My brain disconnected, try again.';
  }
}
