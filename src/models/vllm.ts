// This code uses Dashscope and HTTP to ensure the latest support for the Qwen model.
// Qwen is also compatible with the OpenAI API format;

import OpenAIApi from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { strictFormat } from '../utils/text.js';
import type { AIModel, ChatMessage } from '../types/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class VLLM implements AIModel {
  static prefix = 'vllm';
  private model_name: string | null;
  private vllm: OpenAIApi;
  // `agent` stays `any` to avoid a circular dependency with the Agent class.
  // (Only used by the legacy saveToFile helper below, mirroring Prompter.)
  private agent: any = undefined;

  constructor(model_name: string | null, url?: string, _params?: Record<string, unknown>) {
    void _params; // the original wrapper takes no params; keep that behavior.
    this.model_name = model_name;

    // Currently use self-hosted SGLang API for text generation; use OpenAI text-embedding-3-small model for simple embedding.
    const vllm_config: { baseURL?: string; apiKey?: string } = {};
    if (url) vllm_config.baseURL = url;
    else vllm_config.baseURL = 'http://0.0.0.0:8000/v1';

    vllm_config.apiKey = '';

    this.vllm = new OpenAIApi(vllm_config);
  }

  async sendRequest(
    turns: ChatMessage[],
    systemMessage: string,
    stop_seq = '***',
  ): Promise<string> {
    let messages: ChatMessage[] = [{ role: 'system', content: systemMessage }, ...turns];
    const model = this.model_name || 'deepseek-ai/DeepSeek-R1-Distill-Qwen-32B';

    if (model.includes('deepseek') || model.includes('qwen')) {
      messages = strictFormat(messages);
    }

    const pack = {
      model: model,
      messages,
      stop: stop_seq,
    };

    let res: string | null;
    try {
      console.log('Awaiting openai api response...');
      // console.log('Messages:', messages);
      // todo set max_tokens, temperature, top_p, etc. in pack
      const completion = await this.vllm.chat.completions.create(pack);
      if (completion.choices[0].finish_reason == 'length') throw new Error('Context length exceeded');
      console.log('Received.');
      res = completion.choices[0].message.content ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: unknown } | undefined)?.code;
      if ((msg == 'Context length exceeded' || code == 'context_length_exceeded') && turns.length > 1) {
        console.log('Context length exceeded, trying again with shorter context.');
        return await this.sendRequest(turns.slice(1), systemMessage, stop_seq);
      } else {
        console.log(err);
        res = 'My brain disconnected, try again.';
      }
    }
    return res ?? 'My brain disconnected, try again.';
  }

  async saveToFile(logFile: string, logEntry: string): Promise<void> {
    const task_id = this.agent.task.task_id;
    console.log(task_id);
    let logDir: string;
    // NOTE: the original read `this.task_id` (an undeclared member); the local
    // `task_id` above is what was meant (same pattern as Prompter._saveToFile).
    if (task_id === null) {
      logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
    } else {
      logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
    }

    await fs.mkdir(logDir, { recursive: true });

    logFile = path.join(logDir, logFile);
    await fs.appendFile(logFile, String(logEntry), 'utf-8');
  }
}
