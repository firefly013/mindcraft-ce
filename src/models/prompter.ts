import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { getOpenAITools } from '../agent/commands/to_openai_tools.js';
import { serializeConversation } from '../utils/text.js';
import { renderRequestLog } from '../agent/requestLog.js';
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

    // 截图直看走主循环（liveTail 图片），独立理解链已拆：
    // 没有独立的 vision 模型，profile 里配 vision_model 也不会被读。

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

  /**
   * 提示词占位符替换。
   *
   * 现在只剩 `$NAME`：快照/事件/记忆都作为消息尾巴发出去（见 assembleContext），
   * 不再往提示词里塞动态数据——那些 `$STATS` / `$INVENTORY` / `$CONVO` 之类
   * 的占位符是"模型看不到世界"时代的补丁，随着 Live State + 原生工具全部退役。
   * 留着它们只会让后来人以为改提示词还能拿到数据。
   */
  replaceStrings(prompt: string): string {
    const replaced = prompt.replaceAll('$NAME', this.agent.name);
    const remaining = replaced.match(/\$[A-Z_]+/g);
    if (remaining !== null) {
      console.warn('Unknown prompt placeholders:', remaining.join(', '));
    }
    return replaced;
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
   * （放末尾，不破坏前缀缓存）。返回 { text, tool_calls, usage, overflow }，
   * 模型不支持时返回 null。
   *
   * tool_choice 默认 required：每轮至少调一个工具（想说话调 Say，
   * 收工调 Finish）。个别网关拒绝 required（400）时回落 auto 再试一次。
   *
   * 这里同时把**这一次请求的原文**写进请求日志（覆盖同一个文件）。
   * 日志放这里而不是 agent 里：只有此处同时拿得到最终 system 正文、
   * 全部历史消息和这一轮的尾巴。
   */
  async promptConvoTools(messages: ChatMessage[], extraTail = '', liveImage: string | null = null): Promise<ToolResponse | null> {
    if (typeof this.chat_model.sendRequestWithTools !== 'function') return null;
    this.most_recent_msg_time = Date.now();
    const current_msg_time = this.most_recent_msg_time;
    await this.checkCooldown();
    if (current_msg_time !== this.most_recent_msg_time) return { text: '', tool_calls: [] };

    let prompt = this.prompts.conversing;
    prompt = this.replaceStrings(prompt);
    const tools: OpenAITool[] = getOpenAITools(this.agent);
    this.logRequest(prompt, messages, extraTail, liveImage, tools);
    const send = this.chat_model.sendRequestWithTools.bind(this.chat_model);
    try {
      const res = await send(messages, prompt, tools, 'required', extraTail, liveImage);
      console.log('Generated tool response:', JSON.stringify(res.tool_calls?.map((t) => t.name)));
      let text = res.text ?? '';
      if (text.includes('</think>')) {
        text = text.split('</think>')[1] ?? '';
      }
      return { text, tool_calls: res.tool_calls ?? [], usage: res.usage, overflow: res.overflow };
    } catch (error) {
      if (isBadRequest(error)) {
        // 网关不吃 required：回落 auto 重试一次，不断轮次。
        console.warn('Tool choice required rejected, retrying with auto.');
        try {
          const res = await send(messages, prompt, tools, 'auto', extraTail, liveImage);
          let text = res.text ?? '';
          if (text.includes('</think>')) {
            text = text.split('</think>')[1] ?? '';
          }
          return { text, tool_calls: res.tool_calls ?? [], usage: res.usage, overflow: res.overflow };
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

  /**
   * 把这次请求原文写进请求日志：覆盖写 `bots/<name>/logs/request-00N.log`。
   * 内容按"实际发出的消息列"渲染——system 正文、每一轮历史、
   * 这一轮的尾巴（有截图就标一条），一眼能看出模型此刻看到了什么。
   */
  private logRequest(
    systemPrompt: string,
    messages: ChatMessage[],
    extraTail: string,
    liveImage: string | null,
    tools: OpenAITool[],
  ): void {
    const log = this.agent?.requestLog;
    if (log == null) return;
    log.logRequest({
      text: renderRequestLog({
        systemPrompt,
        messages,
        tail: extraTail,
        imageChars: liveImage?.length ?? 0,
      }),
      tools: tools.map((t) => t.function.name),
      round: this.agent?.loop?.rounds ?? null,
    });
  }

  /**
   * 摘要请求（Pi 的 generateSummary）。
   *
   * 一次调用、两条消息：system 是摘要助手契约，user 里依次是
   * `<conversation>` 台账、可选的 `<previous-summary>`、然后是指令。
   * 台账用 `[User]: / [Assistant]: / [Tool result]:` 序列化，而不是
   * 原样多轮消息——摘要模型是在**读记录**，否则它会接着最后一条
   * assistant 继续写下去。
   *
   * 头部第一条如果是上一轮压仓的摘要条目，说明这是**迭代压仓**，
   * 走 update 版指令，把新内容并进旧摘要。
   */
  async promptMemSaving(to_summarize: ChatMessage[]): Promise<string> {
    await this.checkCooldown();
    const previous = to_summarize.find((turn) => turn.kind === 'summary');
    const previousText =
      typeof previous?.content === 'string'
        ? previous.content.replace(/^\[记忆摘要\]\s*/, '')
        : '';
    const conversation = serializeConversation(to_summarize);
    const parts = [`<conversation>\n${conversation}\n</conversation>`];
    if (previousText.trim() !== '') {
      parts.push(`<previous-summary>\n${previousText.trim()}\n</previous-summary>`);
    }
    parts.push(
      previousText.trim() === ''
        ? this.prompts.saving_memory
        : this.prompts.saving_memory_update,
    );
    const prompt = parts.join('\n\n');
    const system = this.prompts.summary_system;
    let resp = await this.chat_model.sendRequest(
      [{ role: 'user', content: prompt } as ChatMessage],
      system,
    );
    if (resp?.includes('</think>')) {
      const [, afterThink] = resp.split('</think>');
      resp = afterThink ?? resp;
    }
    return resp;
  }
}
