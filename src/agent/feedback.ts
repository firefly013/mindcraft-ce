/*
 * Feedback：模型对"使用体验"的主动反馈，落盘 bots/<name>/feedback.jsonl。
 *
 * title 和正文由模型自己写；处理时附加上下文：时间戳、计划快照、
 * 最近 8 条聊天历史（每条只留摘要，报告才读得动——历史条目可能
 * 带着完整工具输出）。
 *
 * 写失败必须显式拒绝：意见被悄悄吞掉，是这条工具唯一不能发生的事。
 */

import { appendFileSync } from 'fs';
import { join } from 'path';

export const FEEDBACK_TITLE_LIMIT = 120;
export const FEEDBACK_BODY_LIMIT = 4000;
const HISTORY_TAIL = 8;
const SUMMARY_LIMIT = 300;

export interface FeedbackValidation {
  ok: boolean;
  errors?: string[];
}

export interface FeedbackArgs {
  title: string;
  body: string;
}

export interface FeedbackHistoryItem {
  role: string;
  content: string;
}

export interface FeedbackContext {
  at?: number;
  plan?: { goal: string | null; todos: string[] } | null;
  historyTail?: FeedbackHistoryItem[] | null;
}

export interface FeedbackEntry {
  at: number;
  title: string;
  body: string;
  plan: { goal: string | null; todos: string[] } | null;
  recent: Array<{ role: string; summary: string }> | null;
}

/** title/body 必填非空字符串；多余键拒绝。 */
export function validateFeedback(args: unknown): FeedbackValidation {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: ['$: expected object'] };
  }
  const given = args as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(given)) {
    if (key !== 'title' && key !== 'body') errors.push(`$: unknown property '${key}'`);
  }
  for (const key of ['title', 'body']) {
    const v = given[key];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`$.${key}: expected non-empty string`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/** 按码点截断（CJK 一字一符）。 */
function clamp(text: string, limit: number): string {
  const chars = Array.from(text.trim());
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…[截断]` : text.trim();
}

function summarize(content: string): string {
  const chars = Array.from(content);
  return chars.length > SUMMARY_LIMIT ? `${chars.slice(0, SUMMARY_LIMIT).join('')}…` : content;
}

/** 组一条反馈：模型原文 + 时间戳 + 计划快照 + 历史尾部摘要。 */
export function buildFeedbackEntry(args: FeedbackArgs, ctx: FeedbackContext = {}): FeedbackEntry {
  return {
    at: ctx.at ?? Date.now(),
    title: clamp(args.title, FEEDBACK_TITLE_LIMIT),
    body: clamp(args.body, FEEDBACK_BODY_LIMIT),
    plan: ctx.plan ?? null,
    recent: (ctx.historyTail ?? []).slice(-HISTORY_TAIL).map((t) => ({
      role: t.role,
      summary: summarize(t.content),
    })),
  };
}

/** 追加一行 JSONL 到 <dir>/feedback.jsonl，返回路径；写失败原样抛。 */
export function appendFeedback(dir: string, entry: FeedbackEntry): string {
  const file = join(dir, 'feedback.jsonl');
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return file;
}

export default { validateFeedback, buildFeedbackEntry, appendFeedback };
