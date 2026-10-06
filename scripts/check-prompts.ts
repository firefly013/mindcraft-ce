import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import * as P from '../src/prompts.js';
import { CONTROL_TOOLS, getOpenAITools } from '../src/agent/commands/to_openai_tools.js';

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
// 控制类工具不在命令文件里，名单以 to_openai_tools 的 CONTROL_TOOLS 为准。
for (const name of CONTROL_TOOLS) used.set(name, new Set<string>());
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
for (const name of CONTROL_TOOLS) defined.add(name);
for (const key of Object.keys(TOOL_TEXT)) {
  if (!defined.has(key)) { console.log('ORPHAN TOOL_TEXT:', key); fail++; }
}

// 1b. 提示词 <-> 真实 schema 的**参数**双向核对。
// 上面那轮只挡"孤儿工具名"，抓不到参数级漂移：提示词里还留着某参数的说明、
// 而 schema 已经不再声明它（或反过来 schema 有参数却没写提示词）。
// 用 getOpenAITools 取**全部**工具（含 5 个控制类），这样控制工具的参数也受检。
type BuiltTool = { function: { name: string; parameters: { properties?: Record<string, unknown> } } };
let builtTools: BuiltTool[] = [];
try {
  builtTools = getOpenAITools({ blocked_actions: [] }) as unknown as BuiltTool[];
} catch (err) {
  console.log('TOOL BUILD FAILED:', String(err));
  fail++;
}
for (const tool of builtTools) {
  const props = new Set(Object.keys(tool.function.parameters.properties ?? {}));
  const text = TOOL_TEXT[tool.function.name]?.params ?? {};
  for (const p of props) {
    if (!(p in text)) { console.log('SCHEMA PARAM WITHOUT PROMPT TEXT: ' + tool.function.name + '.' + p); fail++; }
  }
  for (const p of Object.keys(text)) {
    if (!props.has(p)) { console.log('ORPHAN PROMPT PARAM: ' + tool.function.name + '.' + p); fail++; }
  }
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
