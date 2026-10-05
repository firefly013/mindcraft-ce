import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as P from '../src/prompts.js';

type ToolText = Record<string, { params?: Record<string, unknown> }>;
const TOOL_TEXT = P.TOOL_TEXT as ToolText;
const MESSAGES = P.MESSAGES as Record<string, unknown>;

// 1. 命令文件引用完整性
const used = new Map<string, Set<string>>();
for (const fp of ['./src/agent/commands/actions.ts', './src/agent/commands/queries.ts']) {
  const src = readFileSync(fp, 'utf8');
  for (const m of src.matchAll(/td\('([^']+)'\)/g)) if (!used.has(m[1] as string)) used.set(m[1] as string, new Set<string>());
  for (const m of src.matchAll(/tp\('([^']+)',\s*'([^']+)'\)/g)) {
    if (!used.has(m[1] as string)) used.set(m[1] as string, new Set<string>());
    used.get(m[1] as string)?.add(m[2] as string);
  }
}
used.set('Finish', new Set<string>());
let fail = 0;
for (const [key, params] of used) {
  if (!TOOL_TEXT[key]) { console.log('MISSING TOOL_TEXT:', key); fail++; continue; }
  for (const p of params) {
    if (!(p in (TOOL_TEXT[key]?.params ?? {}))) { console.log('MISSING PARAM ' + key + '.' + p); fail++; }
  }
}
const defined = new Set<string>();
for (const fp of ['./src/agent/commands/actions.ts', './src/agent/commands/queries.ts']) {
  const src = readFileSync(fp, 'utf8');
  for (const m of src.matchAll(/name:\s*['"]!([^'"]+)['"]/g)) defined.add(m[1] as string);
}
defined.add('Finish');
for (const key of Object.keys(TOOL_TEXT)) {
  if (!defined.has(key)) { console.log('ORPHAN TOOL_TEXT:', key); fail++; }
}

// 2. MESSAGES / MODE_TEXT 引用完整性
const files: string[] = [];
const collect = (d: string): void => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') collect(p); }
    else if (e.endsWith('.ts')) files.push(p);
  }
};
collect('./src');
const msgKeys = new Set<string>(Object.keys(MESSAGES));
for (const fp of files) {
  const src = readFileSync(fp, 'utf8');
  for (const m of src.matchAll(/MESSAGES\.(\w+)/g)) {
    if (!msgKeys.has(m[1] as string)) { console.log('MISSING MESSAGE:', m[1], 'in', fp); fail++; }
  }
  for (const m of src.matchAll(/MODE_TEXT\.(\w+)/g)) {
    console.log('STALE MODE_TEXT ref:', m[1], 'in', fp); fail++;
  }
}
console.log(fail === 0 ? 'ALL PROMPT REFS OK' : 'FAILURES: ' + fail);
process.exit(fail === 0 ? 0 : 1);
