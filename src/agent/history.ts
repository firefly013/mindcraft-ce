import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';
import type { ChatMessage } from '../types/common.js';
import { maybeCompact } from './compaction.js';

// history.load() 从 memory.json 读出的数据形状
export interface HistorySaveData {
    memory: string;
    turns: ChatMessage[];
    taskStart: number;
    [key: string]: unknown;
}


export class History {
    agent: any; // 交叉引用 Agent，避免循环依赖
    name: string;
    memory_fp: string;
    full_history_fp: string | undefined;

    turns: ChatMessage[];

    // Natural language memory as a summary of recent messages + previous memory
    memory: string;

    // Maximum number of messages to keep in context before saving chunk to memory
    max_messages: number;

    // Number of messages to remove from current history and save into memory
    summary_chunk_size: number;
    // chunking reduces expensive calls to promptMemSaving and appendFullHistory
    // and improves the quality of the memory summary

    constructor(agent: any) {
        this.agent = agent;
        this.name = agent.name as string;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 5;
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
        // and improves the quality of the memory summary
    }

    getHistory(): ChatMessage[] {
        return JSON.parse(JSON.stringify(this.turns)) as ChatMessage[];
    }

    async summarizeMemories(turns: ChatMessage[]): Promise<void> {
        console.log("Storing memories...");
        this.memory = await this.agent.prompter.promptMemSaving(turns) as string;

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(Memory truncated to 500 chars. Compress it more next time)';
        }

        console.log("Memory updated to: ", this.memory);
    }

    // eslint-disable-next-line require-await -- History API is promise-based; callers await persistence
    async appendFullHistory(to_store: ChatMessage[]): Promise<void> {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
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

        if (this.turns.length >= this.max_messages) {
            // 先做无害的 level-1 删除（过期 world 噪声）：删得动就省一次总结。
            // 满载即视为有压力（usageRatio=1），不注入总结器，只删不过期的不动。
            const compacted = await maybeCompact({ entries: this.turns, usageRatio: 1, summarize: null });
            if (compacted.compacted) this.turns = compacted.entries;
        }

        if (this.turns.length >= this.max_messages) {
            const chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0]?.role === 'assistant') {
                const shifted = this.turns.shift();
                if (shifted)
                    chunk.push(shifted); // remove until turns starts with system/user message
            }

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    // eslint-disable-next-line require-await -- History API is promise-based; callers await persistence
    async save(): Promise<void> {
        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                taskStart: this.agent.task.taskStartTime
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
