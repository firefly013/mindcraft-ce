/*
 * 历史：一份**完整**的对话记录 + Pi 式压仓。
 *
 * 与 Pi（packages/coding-agent）一致的三条：
 *   1. 发给模型的是**整份历史**（system + 压仓摘要 + 之后的全部条目）。
 *      不再有"最近 100 条 / 8000 token"的尾巴预算——那是 VLM-Bot 的实现
 *      偏差，等于每轮都在截断上下文，模型看不到自己干过什么。
 *   2. 唯一裁剪机制是压仓：`contextTokens > contextWindow - reserveTokens`
 *      时把头部总结成一条摘要条目，尾部逐字保留（见 compaction.ts）。
 *   3. 没有条数上限。`max_messages` 那种东西不该存在：窗口还很空的时候
 *      按条数压仓，只会把可用上下文换成一段有损摘要。
 *
 * `turns` 里的 assistant 条目带 provider 报的真实 `usage`，那是压仓
 * 触发线的锚点。
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import type { ChatMessage, TokenUsage } from '../types/common.js';
import { maybeCompact, resolvePolicy } from './compaction.js';
import type { CompactResult } from './compaction.js';
import { formatEventEntry } from './event_stream.js';

// history.load() 从 memory.json 读出的数据形状
export interface HistorySaveData {
    turns: ChatMessage[];
    taskStart: number;
    /** 记住的地点（MemoryBank 落盘）。 */
    places?: Record<string, [number, number, number]>;
    /** 模型自己维护的计划（PlanStore 落盘）。 */
    plan?: { goal: string | null; todos: Array<{ text: string; done: boolean }> } | null;
    /** 旧存档的自然语言记忆；载入时折算成一条摘要条目，不再单独发。 */
    memory?: string;
    [key: string]: unknown;
}

export interface AddMeta {
    kind?: string;
    level?: number;
    /** provider 报的真实 token 用量（assistant 条目才有）。 */
    usage?: TokenUsage;
}

/** 压仓摘要条目的正文前缀（测试与诊断靠它认条目）。 */
export const SUMMARY_PREFIX = '[记忆摘要] ';

export class History {
    agent: any; // 交叉引用 Agent，避免循环依赖
    name: string;
    /** 落盘根目录；默认 ./bots/<name>，测试可经 agent.historyDir 注入临时目录。 */
    base_dir: string;
    memory_fp: string;
    full_history_fp: string | undefined;

    turns: ChatMessage[];

    constructor(agent: any) {
        this.agent = agent;
        this.name = agent.name as string;
        this.base_dir = typeof agent?.historyDir === 'string' ? agent.historyDir : `./bots/${this.name}`;
        this.memory_fp = `${this.base_dir}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`${this.base_dir}/histories`, { recursive: true });

        this.turns = [];
    }

    /**
     * 发给模型的完整历史。压仓摘要就在 turns 里（它是头部被总结后的
     * 替身），所以照样发出去——这正是 Pi 的投影：system + 摘要 + 保留段。
     */
    getHistory(): ChatMessage[] {
        return JSON.parse(JSON.stringify(this.turns)) as ChatMessage[];
    }

    /** 当前压仓策略（profile 可覆盖窗口/预留/保留量）。 */
    policy(): ReturnType<typeof resolvePolicy> {
        return resolvePolicy(this.agent?.prompter?.profile);
    }

    /**
     * 事件入账：**每个事件在上下文里恰好一次**。
     *
     * 玩家说话保持自然的 user 轮次（`#15 bobo: …`），其余事件（世界/工具/
     * 模型）渲染成一条带序号的 system 行（`#16 World/L3 {…}`）。
     * 序号就是唤醒标记 `## 本轮新事件` 里的那个 `#N`，模型据此能对上号。
     *
     * 这里是同步的：事件到达在调度器回调里，不能 await 压缩。压仓的
     * 检查点因此放在**每次请求之前**（`modelCall`）——那也正是 Pi 的位置。
     */
    addEvent(event: { kind: string; level: number; payload: unknown; seq: number }): void {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const message = payload['message'];
        if (event.kind === 'User' && typeof message === 'string') {
            const source = typeof payload['source'] === 'string' ? payload['source'] : 'system';
            this.turns.push({
                role: 'user',
                content: `#${event.seq} ${source}: ${message}`,
                kind: 'user',
                level: event.level,
                at: Date.now(),
            });
            return;
        }
        this.turns.push({
            role: 'system',
            content: formatEventEntry({ seq: event.seq, kind: event.kind, level: event.level, payload: event.payload }),
            kind: 'event',
            level: event.level,
            at: Date.now(),
        });
    }

    /**
     * 追加一条历史。`meta.usage` 只在 assistant 条目上有意义，
     * 它是压仓触发线的锚点。
     */
    async add(name: string, content: string, meta?: AddMeta): Promise<void> {
        let role: ChatMessage['role'] = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        const turn: ChatMessage = { role, content };
        if (meta?.kind !== undefined) turn.kind = meta.kind;
        if (meta?.level !== undefined) turn.level = meta.level;
        if (meta?.usage !== undefined) turn.usage = meta.usage;
        turn.at = Date.now();
        this.turns.push(turn);

        // 压仓要调模型，绝不能让它把这条消息的入队流程带崩：
        // add() 的调用方（handleMessage）在它之后才 notify 循环。
        try {
            await this.compactIfNeeded();
        } catch (error: unknown) {
            console.error('Compaction failed (history kept as-is):', error);
        }
    }

    /**
     * 到触发线就压仓。返回是否真压了（供测试与诊断）。
     *
     * 压仓成功会顺手让请求日志翻页：一个日志文件 = 一代上下文。
     */
    compactIfNeeded(): Promise<boolean> {
        return this.runCompaction(false);
    }

    /** 忽略触发线强制压一次（上下文超限恢复用）。 */
    compactNow(): Promise<boolean> {
        return this.runCompaction(true);
    }

    private async runCompaction(force: boolean): Promise<boolean> {
        const result: CompactResult<ChatMessage> = await maybeCompact<ChatMessage>({
            entries: this.turns,
            policy: this.policy(),
            summarize: (head) => this.summarize(head),
            makeSummary: (text, at) => ({
                role: 'system',
                content: `${SUMMARY_PREFIX}${text}`,
                kind: 'summary',
                level: 2,
                at,
            }),
            force,
        });
        if (!result.compacted) return false;

        const kept = new Set(result.entries);
        const dropped = this.turns.filter((turn) => !kept.has(turn));
        this.turns = result.entries;
        // 被压掉的原样归档：摘要不等于把原文弄丢。
        if (dropped.length > 0) await this.appendFullHistory(dropped);
        // 压仓点 = 日志翻页点。
        this.agent?.requestLog?.rotate?.();
        return true;
    }

    /**
     * 把一段历史交给模型总结。返回值必须回传，它就是新的摘要条目正文。
     * 上一轮摘要就在 head 的第一条，等于 Pi 的"把旧摘要一起带上"迭代总结。
     */
    async summarize(head: ChatMessage[]): Promise<string> {
        console.log('Storing memories...');
        const summary = (await this.agent.prompter.promptMemSaving(head)) as string;
        console.log('Memory updated to: ', summary);
        return summary;
    }

    /**
     * 旧的"记忆摘要"字段：现在只是最近一条摘要条目的正文，
     * 保留给 $MEMORY 占位符和旧提示词用。没有任何摘要时返回空串。
     */
    get memory(): string {
        for (let i = this.turns.length - 1; i >= 0; i--) {
            const turn = this.turns[i];
            if (turn.kind === 'summary' && typeof turn.content === 'string') {
                return turn.content.startsWith(SUMMARY_PREFIX)
                    ? turn.content.slice(SUMMARY_PREFIX.length)
                    : turn.content;
            }
        }
        return '';
    }

    // eslint-disable-next-line require-await -- History API is promise-based; callers await persistence
    async appendFullHistory(to_store: ChatMessage[]): Promise<void> {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `${this.base_dir}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            const full_history = JSON.parse(data) as ChatMessage[];
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`Error reading ${this.name}'s full history file: ${msg}`);
        }
    }

    // eslint-disable-next-line require-await -- History API is promise-based; callers await persistence
    async save(): Promise<void> {
        try {
            const data: HistorySaveData = {
                turns: this.turns,
                taskStart: this.agent.task.taskStartTime,
                // 地点与计划也落盘：它们和自然语言记忆一样是跨会话的。
                // 以前只有 memory + turns 活过重启，rememberHere 和
                // UpdatePlan 的东西一关服就没了。
                places: this.agent?.memory_bank?.getJson?.() ?? {},
                plan: this.agent?.plan?.snapshot?.() ?? null,
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);
        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load(): HistorySaveData | null {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8')) as HistorySaveData;
            this.turns = data.turns || [];
            // 旧存档把记忆存在独立字段里。以前它是以 `## 记忆摘要` 段随尾巴
            // 发出的；现在摘要必须是条目本身，否则那段信息会凭空消失。
            const legacyMemory = typeof data.memory === 'string' ? data.memory.trim() : '';
            const hasSummary = this.turns.some((turn) => turn.kind === 'summary');
            if (legacyMemory !== '' && !hasSummary) {
                this.turns.unshift({
                    role: 'system',
                    content: `${SUMMARY_PREFIX}${legacyMemory}`,
                    kind: 'summary',
                    level: 2,
                    at: Date.now(),
                });
            }
            // 地点与计划一并恢复（缺字段说明是老存档，安静跳过）。
            if (data.places != null) this.agent?.memory_bank?.loadJson?.(data.places);
            if (data.plan != null) this.agent?.plan?.update?.(data.plan.goal, data.plan.todos);
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear(): void {
        this.turns = [];
    }
}
