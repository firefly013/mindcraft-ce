import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as P from '../src/prompts.js';

// 1. 命令文件引用完整性
const used = new Map();
for (const fp of ['./src/agent/commands/actions.js', './src/agent/commands/queries.js']) {
  const src = readFileSync(fp, 'utf8');
  for (const m of src.matchAll(/td\('([^']+)'\)/g)) if (!used.has(m[1])) used.set(m[1], new Set());
  for (const m of src.matchAll(/tp\('([^']+)',\s*'([^']+)'\)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(m[2]);
  }
}
used.set('Finish', new Set());
let fail = 0;
for (const [key, params] of used) {
  if (!P.TOOL_TEXT[key]) { console.log('MISSING TOOL_TEXT:', key); fail++; continue; }
  for (const p of params) {
    if (!(p in (P.TOOL_TEXT[key].params ?? {}))) { console.log('MISSING PARAM ' + key + '.' + p); fail++; }
  }
}
const defined = new Set();
for (const fp of ['./src/agent/commands/actions.js', './src/agent/commands/queries.js']) {
  const src = readFileSync(fp, 'utf8');
  for (const m of src.matchAll(/name:\s*['"]!([^'"]+)['"]/g)) defined.add(m[1]);
}
defined.add('Finish');
for (const key of Object.keys(P.TOOL_TEXT)) {
  if (!defined.has(key)) { console.log('ORPHAN TOOL_TEXT:', key); fail++; }
}

// 2. MESSAGES / MODE_TEXT 引用完整性
const files = [];
const collect = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) { if (e !== 'node_modules') collect(p); }
    else if (e.endsWith('.js')) files.push(p);
  }
};
collect('./src');
const msgKeys = new Set(Object.keys(P.MESSAGES));
const modeKeys = new Set(Object.keys(P.MODE_TEXT));
for (const fp of files) {
  const src = readFileSync(fp, 'utf8');
  for (const m of src.matchAll(/MESSAGES\.(\w+)/g)) {
    if (!msgKeys.has(m[1])) { console.log('MISSING MESSAGE:', m[1], 'in', fp); fail++; }
  }
  for (const m of src.matchAll(/MODE_TEXT\.(\w+)/g)) {
    if (!modeKeys.has(m[1])) { console.log('MISSING MODE_TEXT:', m[1], 'in', fp); fail++; }
  }
}
console.log(fail === 0 ? 'ALL PROMPT REFS OK' : 'FAILURES: ' + fail);
process.exit(fail === 0 ? 0 : 1);
