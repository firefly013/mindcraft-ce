import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { executeToolCall, getOpenAITools } from '../agent/commands/to_openai_tools.js';
import { stringifyTurns } from '../utils/text.js';
import settings from '../agent/settings.js';
import { resolvePromptSet, MESSAGES } from '../prompts.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import type {
  AIModel,
  AgentProfile,
  ChatMessage,
  OpenAITool,
  ToolResponse,
} from '../types/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 400 类网关拒绝（不支持 required 等参数形状）：特征是 status 400
 * 或错误体里点名参数。命中就回落 auto 重试，其他错误直接判失败。
 */
export function isBadRequest(error: unknown): boolean {
  if (error == null) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 400) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes('400') || /tool_choice/i.test(msg);
}

export class Prompter {
  // `agent` stays `any` to avoid a circular dependency with the Agent class.
  private agent: any;
  private profile: AgentProfile;
  private prompts: Record<string, string>;
  private cooldown: number;
  private last_prompt_time: number;
  private most_recent_msg_time: number;
  private chat_model: AIModel;
  private vision_model: AIModel;

  constructor(agent: any, profile: AgentProfile) {
    this.agent = agent;
    this.profile = profile;
    const defaults_dir = path.join(__dirname, '../../profiles/defaults');
    const default_profile = JSON.parse(
      readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'),
    ) as Record<string, unknown>;
    let base_fp = '';
    if (settings.base_profile.includes('survival')) {
      base_fp = path.join(defaults_dir, 'survival.json');
    } else if (settings.base_profile.includes('assistant')) {
      base_fp = path.join(defaults_dir, 'assistant.json');
    } else if (settings.base_profile.includes('creative')) {
      base_fp = path.join(defaults_dir, 'creative.json');
    } else if (settings.base_profile.includes('god_mode')) {
      base_fp = path.join(defaults_dir, 'god_mode.json');
    }
    const base_profile = JSON.parse(readFileSync(base_fp, 'utf8')) as Record<string, unknown>;

    // first use defaults to fill in missing values in the base profile
    for (const key in default_profile) {
      if (base_profile[key] === undefined) base_profile[key] = default_profile[key];
    }
    // then use base profile to fill in missing values in the individual profile
    for (const key in base_profile) {
      if ((this.profile as Record<string, unknown>)[key] === undefined)
        (this.profile as Record<string, unknown>)[key] = base_profile[key];
    }
    // base overrides default, individual overrides base

    // 系统提示词统一来自 src/prompts.js（profile 可按同名键覆盖）
    this.prompts = resolvePromptSet(this.profile) as Record<string, string>;

    const name = this.profile.name;
    this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
    this.last_prompt_time = 0;
    this.most_recent_msg_time = 0;

    // for backwards compatibility, move max_tokens to params
    let max_tokens: unknown = null;
    if (this.profile.max_tokens) max_tokens = this.profile.max_tokens;
    void max_tokens;

    const chat_model_profile = selectAPI(this.profile.model);
    this.chat_model = createModel(chat_model_profile);

    if (this.profile.vision_model) {
      const vision_model_profile = selectAPI(this.profile.vision_model as string);
      this.vision_model = createModel(vision_model_profile);
    } else {
      this.vision_model = this.chat_model;
    }

    // RAG 已彻底移除：不再有 embedding 模型、示例检索与 skill 文档检索

    mkdirSync(`./bots/${name}`, { recursive: true });
    // NOTE: the original passed a callback to writeFileSync (a bug — the sync
    // API takes no callback); call it synchronously instead.
    writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4));
    console.log('Copy profile saved.');
  }

  getName(): string {
    return this.profile.name;
  }

  async replaceStrings(
    prompt: string,
    messages: ChatMessage[] | null,
    to_summarize: ChatMessage[] = [],
    last_goals: Record<string, boolean> | null = null,
  ): Promise<string> {
    prompt = prompt.replaceAll('$NAME', this.agent.name);

    if (prompt.includes('$STATS')) {
      let stats = ((await executeToolCall(this.agent, 'stats', {})) as string) + '\n';
      stats += ((await executeToolCall(this.agent, 'entities', {})) as string) + '\n';
      stats += (await executeToolCall(this.agent, 'nearbyBlocks', {})) as string;
      prompt = prompt.replaceAll('$STATS', stats);
    }
    if (prompt.includes('$INVENTORY')) {
      const inventory = (await executeToolCall(this.agent, 'inventory', {})) as string;
      prompt = prompt.replaceAll('$INVENTORY', inventory);
    }
    if (prompt.includes('$ACTION')) {
      prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
    }
    if (prompt.includes('$MEMORY')) prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
    if (prompt.includes('$TO_SUMMARIZE'))
      prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
    if (prompt.includes('$CONVO'))
      prompt = prompt.replaceAll(
        '$CONVO',
        MESSAGES.recentConvoPrefix + stringifyTurns(messages ?? []),
      );
    if (prompt.includes('$LAST_GOALS')) {
      let goal_text = '';
      for (const goal in last_goals ?? {}) {
        if ((last_goals as Record<string, boolean>)[goal]) goal_text += MESSAGES.goalDone(goal) + '\n';
        else goal_text += MESSAGES.goalFailed(goal) + '\n';
      }
      prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
    }
    if (prompt.includes('$BLUEPRINTS')) {
      if (this.agent.npc.constructions) {
        let blueprints = '';
        for (const blueprint in this.agent.npc.constructions) {
          blueprints += blueprint + ', ';
        }
        prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
      }
    }

    // check if there are any remaining placeholders with syntax $<word>
    const remaining = prompt.match(/\$[A-Z_]+/g);
    if (remaining !== null) {
      console.warn('Unknown prompt placeholders:', remaining.join(', '));
    }
    return prompt;
  }

  async checkCooldown(): Promise<void> {
    const elapsed = Date.now() - this.last_prompt_time;
    if (elapsed < this.cooldown && this.cooldown > 0) {
      await new Promise((r) => setTimeout(r, this.cooldown - elapsed));
    }
    this.last_prompt_time = Date.now();
  }

  /**
   * 原生工具调用版对话：tools 由全部命令转换而来，模型直接返回
   * tool_calls。extraTail 是现采的 Live State 文本，追加在正文最后
   * （放末尾，不破坏前缀缓存）。返回 { text, tool_calls }，
   * 模型不支持时返回 null。
   *
   * tool_choice 默认 required：每轮至少调一个工具（想说话调 Say，
   * 收工调 Finish）。个别网关拒绝 required（400）时回落 auto 再试一次。
   */
  async promptConvoTools(messages: ChatMessage[], extraTail = ''): Promise<ToolResponse | null> {
    if (typeof this.chat_model.sendRequestWithTools !== 'function') return null;
    this.most_recent_msg_time = Date.now();
    const current_msg_time = this.most_recent_msg_time;
    await this.checkCooldown();
    if (current_msg_time !== this.most_recent_msg_time) return { text: '', tool_calls: [] };

    let prompt = this.prompts.conversing;
    prompt = await this.replaceStrings(prompt, messages);
    const tools: OpenAITool[] = getOpenAITools(this.agent);
    const send = this.chat_model.sendRequestWithTools.bind(this.chat_model);
    try {
      const res = await send(messages, prompt, tools, 'required', extraTail);
      console.log('Generated tool response:', JSON.stringify(res.tool_calls?.map((t) => t.name)));
      await this._saveLog(prompt, messages, JSON.stringify(res), 'conversation-tools');
      let text = res.text ?? '';
      if (text.includes('</think>')) {
        text = text.split('</think>')[1] ?? '';
      }
      return { text, tool_calls: res.tool_calls ?? [] };
    } catch (error) {
      if (isBadRequest(error)) {
        // 网关不吃 required：回落 auto 重试一次，不断轮次。
        console.warn('Tool choice required rejected, retrying with auto.');
        try {
          const res = await send(messages, prompt, tools, 'auto', extraTail);
          let text = res.text ?? '';
          if (text.includes('</think>')) {
            text = text.split('</think>')[1] ?? '';
          }
          return { text, tool_calls: res.tool_calls ?? [] };
        } catch (retryError) {
          console.error(
            'Tool request failed:',
            retryError instanceof Error ? retryError.message : String(retryError),
          );
          return null;
        }
      }
      console.error(
        'Tool request failed, falling back to text commands:',
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  async promptMemSaving(to_summarize: ChatMessage[]): Promise<string> {
    await this.checkCooldown();
    let prompt = this.prompts.saving_memory;
    prompt = await this.replaceStrings(prompt, null, to_summarize);
    let resp = await this.chat_model.sendRequest([], prompt);
    await this._saveLog(prompt, to_summarize, resp, 'memSaving');
    if (resp?.includes('</think>')) {
      const [, afterThink] = resp.split('</think>');
      resp = afterThink ?? resp;
    }
    return resp;
  }

  async promptVision(messages: ChatMessage[], imageBuffer: Buffer): Promise<string> {
    await this.checkCooldown();
    let prompt = this.prompts.image_analysis;
    prompt = await this.replaceStrings(prompt, messages);
    const sendVisionRequest = this.vision_model.sendVisionRequest;
    if (typeof sendVisionRequest !== 'function') {
      throw new Error('Vision model does not support sendVisionRequest.');
    }
    return await sendVisionRequest.call(this.vision_model, messages, prompt, imageBuffer);
  }

  async promptGoalSetting(
    messages: ChatMessage[],
    last_goals: Record<string, boolean>,
  ): Promise<{ name: string; quantity: number } | null> {
    // deprecated
    let system_message = this.profile.goal_setting as string;
    system_message = await this.replaceStrings(system_message, messages);

    let user_message = 'Use the below info to determine what goal to target next\n\n';
    user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO';
    user_message = await this.replaceStrings(user_message, messages, [], last_goals);
    const user_messages: ChatMessage[] = [{ role: 'user', content: user_message }];

    const res = await this.chat_model.sendRequest(user_messages, system_message);

    let goal: { name?: unknown; quantity?: unknown } | null = null;
    try {
      const data = (res.split('```')[1] ?? '').replace('json', '').trim();
      goal = JSON.parse(data) as { name?: unknown; quantity?: unknown };
    } catch (err) {
      console.log('Failed to parse goal:', res, err);
    }
    if (
      !goal ||
      typeof goal.name !== 'string' ||
      !goal.name ||
      goal.quantity == null ||
      isNaN(parseInt(String(goal.quantity)))
    ) {
      console.log('Failed to set goal:', res);
      return null;
    }
    return { name: goal.name, quantity: parseInt(String(goal.quantity)) };
  }

  async _saveLog(
    prompt: string,
    messages: ChatMessage[] | null,
    generation: string,
    tag: string,
  ): Promise<void> {
    if (!settings.log_all_prompts) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let logEntry: string;
    const task_id = this.agent.task.task_id;
    if (task_id == null) {
      logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
    } else {
      logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
    }
    const logFile = `${tag}_${timestamp}.txt`;
    await this._saveToFile(logFile, logEntry);
  }

  async _saveToFile(logFile: string, logEntry: string): Promise<void> {
    const task_id = this.agent.task.task_id;
    let logDir: string;
    if (task_id == null) {
      logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
    } else {
      logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
    }

    await fs.mkdir(logDir, { recursive: true });

    logFile = path.join(logDir, logFile);
    await fs.appendFile(logFile, String(logEntry), 'utf-8');
  }
}
