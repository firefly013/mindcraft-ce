import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import type { ChatMessage } from '../types/common.js';
import {
    entriesTokens,
    estimateTokens,
    maybeCompact,
    resolveContextWindow,
    resolveHistoryEntries,
    resolveHistoryTokens,
    COMPACT_AT,
} from './compaction.js';

// history.load() 从 memory.json 读出的数据形状
export interface HistorySaveData {
    memory: string;
    turns: ChatMessage[];
    taskStart: number;
    /** 记住的地点（MemoryBank 落盘）。 */
    places?: Record<string, [number, number, number]>;
    /** 模型自己维护的计划（PlanStore 落盘）。 */
    plan?: { goal: string | null; todos: Array<{ text: string; done: boolean }> } | null;
    [key: string]: unknown;
}

/** memory.json 里自然语言记忆的字符上限（超了截断并提示压缩）。 */
export const MEMORY_LIMIT = 500;


export class History {
    agent: any; // 交叉引用 Agent，避免循环依赖
    name: string;
    /** 落盘根目录；默认 ./bots/<name>，测试可经 agent.historyDir 注入临时目录。 */
    base_dir: string;
    memory_fp: string;
    full_history_fp: string | undefined;

    turns: ChatMessage[];

    // Natural language memory as a summary of recent messages + previous memory
    memory: string;

    // Maximum number of messages to keep in context before compacting
    max_messages: number;

    constructor(agent: any) {
        this.agent = agent;
        this.name = agent.name as string;
        this.base_dir = typeof agent?.historyDir === 'string' ? agent.historyDir : `./bots/${this.name}`;
        this.memory_fp = `${this.base_dir}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`${this.base_dir}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before compacting
        this.max_messages = settings.max_messages;
    }

    /**
     * 发给模型的尾巴：整份历史默认全给，配了 max_history_entries /
     * max_history_tokens 就按预算从新到旧截。token 粗估复用 compaction
     * 的口径，故意往大估（早截比晚截安全）。
     */
    getHistory(): ChatMessage[] {
        // 压仓留下的摘要条目默认剔除：同一段文本已经以 `## 记忆摘要` 的形式
        // 随尾巴发出去，再当成一轮对话发一遍就是重复喂。
        // 例外：memory 为空时保留摘要条目——否则被压掉的头部对模型完全不可见
        // （只剩归档文件），宁可轻微重复也不能让它凭空消失。
        const hasMemory = this.memory.trim() !== '';
        const all = (JSON.parse(JSON.stringify(this.turns)) as ChatMessage[]).filter(
            (turn) => turn.kind !== 'summary' || !hasMemory,
        );
        const maxEntries = resolveHistoryEntries(this.agent?.prompter?.profile);
        const maxTokens = resolveHistoryTokens(this.agent?.prompter?.profile);
        let tail = all;
        if (maxEntries > 0 && tail.length > maxEntries) tail = tail.slice(-maxEntries);
        if (maxTokens > 0) {
            const picked: ChatMessage[] = [];
            let used = 0;
            for (let i = tail.length - 1; i >= 0; i--) {
                const entry = tail[i] as ChatMessage;
                const cost = estimateTokens(`${entry.role}:${typeof entry.content === 'string' ? entry.content : ''}`);
                if (picked.length > 0 && used + cost > maxTokens) break;
                picked.push(entry);
                used += cost;
            }
            tail = picked.reverse();
        }
        return tail;
    }

    /**
     * 把一段历史总结成记忆，返回摘要文本（同时更新 memory 字段）。
     * 一份逻辑两个用途：跨会话的 memory.json，以及 compaction
     * level-2 注入的 summarize。返回值必须回传，否则压仓拿不到摘要。
     */
    async summarizeMemories(turns: ChatMessage[]): Promise<string> {
        console.log("Storing memories...");
        const summary = (await this.agent.prompter.promptMemSaving(turns)) as string;
        this.memory =
            summary.length > MEMORY_LIMIT
                ? `${summary.slice(0, MEMORY_LIMIT)}...(Memory truncated to ${MEMORY_LIMIT} chars. Compress it more next time)`
                : summary;

        console.log("Memory updated to: ", this.memory);
        return this.memory;
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

    async add(name: string, content: string, meta?: { kind?: string; level?: number }): Promise<void> {
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
     * 压仓：条数到顶，或估算 token 压力到 90%，才动手。
     *
     * 动作分两级（见 compaction.ts）：先删过期 world 噪声（level 1），
     * 删不动就把头部交给 summarize 总结、尾部逐字保留（level 2）。
     *
     * 关键：必须注入 summarize 与 makeSummary。之前传的是 null，等于把
     * 这套策略接成了一根断线——level 2 永远进不去，真正的裁剪全靠老
     * 代码按条数往下砍，一次丢 5 条且没有任何摘要回填。
     */
    private async compactIfNeeded(): Promise<void> {
        const usageRatio =
            entriesTokens(this.turns) / resolveContextWindow(this.agent?.prompter?.profile);
        const overCount = this.turns.length >= this.max_messages;
        if (!overCount && usageRatio < COMPACT_AT) return;

        const before = this.turns.slice();
        const compacted = await maybeCompact({
            entries: this.turns,
            // 条数硬顶也折算成压力：策略本体只有 90% 一条线，硬顶是
            // 小窗口/评测场景的兜底，不能让它把压仓短路掉。
            usageRatio: Math.max(usageRatio, overCount ? COMPACT_AT : 0),
            // 尾部只留最新的三分之一：压完必须留出实打实的空间，
            // 否则"压完立刻又到顶"，每来一条消息就调一次模型总结。
            // 下限 1 不能去掉：slice(-0) 会返回**整个数组**，等于尾部全留、永不压。
            // 已知病态：max_messages ≤ 3 时窗口太窄，会接近"每条消息一次总结"
            // （max_messages = 1 时长度稳定在 2）。默认 15 无此问题。
            keepLast: Math.max(1, Math.floor(this.max_messages / 3)),
            summarize: (head: ChatMessage[]) => this.summarizeMemories(head),
            makeSummary: (text: string, at: number): ChatMessage => ({
                role: 'system',
                content: `[记忆摘要] ${text}`,
                kind: 'summary',
                level: 2,
                at,
            }),
        });
        if (!compacted.compacted) return;

        const kept = new Set(compacted.entries);
        const dropped = before.filter((turn) => !kept.has(turn));
        this.turns = compacted.entries;
        // 被压掉的原样归档：摘要不等于把原文弄丢。
        // 注意：level-2 的摘要条目不在 dropped 里（它是新对象，不是被删的原文）。
        if (dropped.length > 0) await this.appendFullHistory(dropped);
    }

    // eslint-disable-next-line require-await -- History API is promise-based; callers await persistence
    async save(): Promise<void> {
        try {
            const data: HistorySaveData = {
                memory: this.memory,
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
        } catch (error: unknown) {
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
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            // 地点与计划一并恢复（缺字段说明是老存档，安静跳过）。
            if (data.places != null) this.agent?.memory_bank?.loadJson?.(data.places);
            if (data.plan != null) this.agent?.plan?.update?.(data.plan.goal, data.plan.todos);
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error: unknown) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear(): void {
        this.turns = [];
        this.memory = '';
    }
}
