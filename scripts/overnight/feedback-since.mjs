// 打印自上次以来新增的模型 Feedback 摘要，并推进游标。
import { readFileSync, writeFileSync } from 'node:fs';
const RUN = 'tmp/overnight';
const FILE = `${RUN}/feedback/feedback-list.jsonl`;
const CURSOR = `${RUN}/feedback/.cursor`;
let cursor = 0; try { cursor = Number(readFileSync(CURSOR, 'utf8')) || 0; } catch { }
let lines = []; try { lines = readFileSync(FILE, 'utf8').split('\n').filter(Boolean); } catch { }
const start = Math.max(0, Math.min(cursor, lines.length));
const fresh = lines.slice(start).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
if (fresh.length > 0) writeFileSync(CURSOR, String(lines.length));
console.log(JSON.stringify({ total: lines.length, newFeedback: fresh.length, items: fresh.map((f) => ({ ts: f.ts, agent: f.agent, title: f.title, body: String(f.body ?? '').slice(0, 240) })) }, null, 2));
