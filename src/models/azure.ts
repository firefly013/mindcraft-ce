import { AzureOpenAI } from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { GPT } from './gpt.js';

export class AzureGPT extends GPT {
  static override prefix = 'azure';
  constructor(model_name: string | null, url?: string, params?: Record<string, unknown>) {
    super(model_name, url);

    this.model_name = model_name;
    this.params = params ?? {};

    const config: { endpoint?: string; apiKey?: string; deployment?: string; apiVersion?: string } =
      {};

    if (url) config.endpoint = url;

    config.apiKey = hasKey('AZURE_OPENAI_API_KEY')
      ? getKey('AZURE_OPENAI_API_KEY')
      : getKey('OPENAI_API_KEY');

    config.deployment = model_name ?? undefined;

    if (this.params.apiVersion) {
      config.apiVersion = this.params.apiVersion as string;
      delete this.params.apiVersion; // remove from params for later use in requests
    } else {
      throw new Error('apiVersion is required in params for azure!');
    }

    this.openai = new AzureOpenAI(
      config as ConstructorParameters<typeof AzureOpenAI>[0],
    );
  }
}
