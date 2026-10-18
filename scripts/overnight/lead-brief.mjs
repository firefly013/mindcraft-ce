/**
 * 一屏运行摘要（Lead 用）。
 *
 * 与 `brief.mjs` 的区别：那个读 watcher 的快照（可能滞后），这个**直接读两个 bot
 * 的 agent 日志**，所以能看到"刚刚到底有没有在干活"：最近一次工具调用、
 * 15 分钟内的工具直方图、provider 请求有没有 toolCall、空转护栏催了几次、
 * 新 Feedback、supervisor 状态。
 *
 * 用法：node scripts/overnight/lead-brief.mjs [--minutes 15] [--lines 6000]
 */
import { readFileSync, existsSync, statSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? Number(argv[i + 1]) : dflt;
};
const MINUTES = argOf('minutes', 15);
const TAIL_LINES = argOf('lines', 6000);

const ROOT = 'tmp/overnight';
const BOTS = ['overnight_a', 'overnight_b'];
const cutoff = Date.now() - MINUTES * 60_000;

/** 本地日期 → agent 日志文件名（身体按本地日期切文件）。 */
function todayLog(bot) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `bots/${bot}/logs/agent-${stamp}.log`;
}

/** JSONL 尾部解析；坏行跳过，不抛。 */
function parseTail(path, lines) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const all = raw.split('\n');
  const slice = all.slice(Math.max(0, all.length - lines));
  const out = [];
  for (const line of slice) {
    if (line === '' || line[0] !== '{') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 半行（正在写） */
    }
  }
  return out;
}

function tsMs(value) {
  if (value == null) return 0;
  const t = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

function humanAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

/** 工具名 + 参数（压缩成一行）。 */
function callLabel(entry) {
  const args = entry.args ?? {};
  const keys = Object.keys(args);
  if (keys.length === 0) return String(entry.name);
  return `${entry.name}(${keys.map((k) => `${k}=${JSON.stringify(args[k])}`).join(', ')})`;
}

console.log(`=== lead-brief ${new Date().toISOString()} (window ${MINUTES}m) ===`);

for (const bot of BOTS) {
  const path = todayLog(bot);
  const entries = parseTail(path, TAIL_LINES);
  const inWindow = entries.filter((e) => tsMs(e.ts) >= cutoff);
  const tools = entries.filter((e) => e.mod === 'tool');
  const providers = entries.filter((e) => e.mod === 'provider');
  const stalls = inWindow.filter((e) => e.mod === 'stall');
  const actions = inWindow.filter((e) => e.mod === 'action' && e.kind === 'done');

  const hist = new Map();
  for (const t of tools.filter((e) => tsMs(e.ts) >= cutoff)) {
    hist.set(t.name, (hist.get(t.name) ?? 0) + 1);
  }
  const histText = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}x${n}`)
    .join(' ');

  const lastTool = tools.at(-1);
  const lastProvider = providers.at(-1);
  const lastEntry = entries.at(-1);
  const noToolCalls = providers
    .filter((e) => tsMs(e.ts) >= cutoff)
    .filter((e) => !(e.content ?? []).includes('toolCall')).length;

  console.log(`\n--- ${bot} ---`);
  console.log(
    `  log=${path} mtime=${existsSync(path) ? new Date(statSync(path).mtimeMs).toISOString() : 'n/a'} entries=${entries.length}`,
  );
  console.log(
    `  last-anything: ${lastEntry ? `${lastEntry.ts} (${lastEntry.mod}/${lastEntry.name ?? lastEntry.type ?? lastEntry.phase ?? ''}) ${humanAgo(tsMs(lastEntry.ts))} ago` : 'n/a'}`,
  );
  console.log(
    `  tools[${MINUTES}m]=${histText || 'none'} | actions-done=${actions.length} | provider=${providers.filter((e) => tsMs(e.ts) >= cutoff).length} (text-only ${noToolCalls}) | stall-nudges=${stalls.length}`,
  );
  console.log(`  last-tool: ${lastTool ? `${lastTool.ts} ${callLabel(lastTool)}` : 'none'}`);
  console.log(
    `  last-provider: ${lastProvider ? `${lastProvider.ts} in=${lastProvider.inputTokens} out=${lastProvider.outputTokens} content=[${(lastProvider.content ?? []).join(',')}] stop=${lastProvider.stopReason}` : 'none'}`,
  );
  const lastStall = stalls.at(-1);
  if (lastStall) console.log(`  last-stall: ${lastStall.ts} ${lastStall.phase} attempt=${lastStall.attempt}`);

  // Feedback：文件尾 = 最新一条。
  const fbPath = `bots/${bot}/feedback.jsonl`;
  if (existsSync(fbPath)) {
    const fb = parseTail(fbPath, 200);
    const last = fb.at(-1);
    const st = statSync(fbPath);
    console.log(
      `  feedback: ${fb.length}+ lines, file mtime=${new Date(st.mtimeMs).toISOString()}`,
    );
    if (last) console.log(`     last: ${last.ts ?? '?'} · ${last.title ?? '(no title)'}`);
  }
}

// 监督进程状态
const supPath = `${ROOT}/supervisor-status.json`;
if (existsSync(supPath)) {
  try {
    const s = JSON.parse(readFileSync(supPath, 'utf8'));
    console.log(
      `\n[supervisor] main=${s.mainAlive ? 'alive' : 'DEAD'} pid=${s.mainPid} uptime=${s.mainUptimeSec}s restarts=${s.restartCount} mcUp=${s.mcServerUp} mindUp=${s.mindserverUp}`,
    );
    if (s.lastExit) console.log(`  lastExit=${JSON.stringify(s.lastExit)}`);
  } catch {
    console.log('\n[supervisor] status unreadable');
  }
}
