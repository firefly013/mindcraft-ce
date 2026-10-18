#!/usr/bin/env node
/**
 * 整夜双 Bot 实测装置的采集/告警进程（由 supervisor.ps1 拉起）。
 *
 * 采集：
 *   - tmp/overnight/stdout.log / stderr.log（main 进程 + 全部子进程的 stdout，stdio:inherit）
 *   - bots/<agent>/logs/agent-YYYYMMDD.log（结构化 JSONL）
 *   - bots/<agent>/feedback.jsonl（模型 Feedback）→ tmp/overnight/feedback/FEEDBACK.md + feedback-list.jsonl
 *   - bots/<agent>/*.db（session.db 等）的大小/更新时间
 *   - MindServer 的 CLI events（op:list，把 cliEvents 增量落 tmp/overnight/cli-events.jsonl）
 *
 * 告警：
 *   - 高频错误（10 分钟窗口内同签名 >= 5 次）、body-attach-failed、MC 连不上、
 *     mindserver 掉线、bot 掉线/停滞 → tmp/overnight/alerts.jsonl（critical 另落 alerts-critical.jsonl）
 *   - 需要整树重启时写 tmp/overnight/.restart-request，由 supervisor 执行
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { io } from 'socket.io-client';

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; }

const ROOT = arg('root', process.cwd());
const PORT = Number(arg('port', '8080'));
const POLL_MS = Number(arg('poll', '20000'));
const AGENTS = ['overnight_a', 'overnight_b'];
const RUN = join(ROOT, 'tmp', 'overnight');
const FEED_DIR = join(RUN, 'feedback');
const ALERTS = join(RUN, 'alerts.jsonl');
const ALERTS_MD = join(RUN, 'ALERTS.md');
const CRITICAL = join(RUN, 'alerts-critical.jsonl');
const CLI_EVENTS = join(RUN, 'cli-events.jsonl');
const STATUS = join(RUN, 'watch-status.json');
const STATE_FILE = join(RUN, 'watch-state.json');
const RESTART_REQ = join(RUN, '.restart-request');
const HEARTBEAT = join(RUN, 'watch-heartbeat.jsonl');

mkdirSync(FEED_DIR, { recursive: true });

let state = { files: {}, cliSince: {}, alerts: {} };
try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; } catch { }
state.files ??= {}; state.cliSince ??= {}; state.alerts ??= {};
function saveState() { try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { } }

const startedAt = Date.now();
const STARTUP_GRACE_MS = 120000; // watcher 可能先于 MindServer 就绪，宽限期内不报 mindserver-down / bot-offline
function iso(at = Date.now()) { return new Date(at).toISOString(); }

/** 增量读文件：跨轮询保留 offset 与行尾残片；文件被截断/轮转则重头读。 */
function readNew(abs) {
    const st = state.files[abs] ?? (state.files[abs] = { off: 0, rem: '' });
    let size = 0;
    try { size = statSync(abs).size; } catch { return []; }
    if (size < st.off) { st.off = 0; st.rem = ''; }
    if (size === st.off) return [];
    let text = '';
    const fd = openSync(abs, 'r');
    try {
        const len = Math.min(size - st.off, 4 * 1024 * 1024);
        const buf = Buffer.allocUnsafe(len);
        const got = readSync(fd, buf, 0, len, st.off);
        text = buf.subarray(0, got).toString('utf8');
        st.off += got;
    } catch { } finally { closeSync(fd); }
    const parts = (st.rem + text).split('\n');
    st.rem = parts.pop() ?? '';
    if (st.rem.length > 65536) st.rem = st.rem.slice(-65536);
    return parts.filter((l) => l.trim() !== '');
}

const ALERT_COOLDOWN = { critical: 10 * 60e3, warn: 15 * 60e3, info: 30 * 60e3 };
const alertCounts = { critical: 0, warn: 0, info: 0 };
function alert(sev, key, message, data = {}) {
    const now = Date.now();
    if (now - (state.alerts[key] ?? 0) < (ALERT_COOLDOWN[sev] ?? 600e3)) return false;
    state.alerts[key] = now;
    const rec = { ts: iso(now), at: now, sev, key, message, ...data };
    appendFileSync(ALERTS, JSON.stringify(rec) + '\n');
    if (sev === 'critical') appendFileSync(CRITICAL, JSON.stringify(rec) + '\n');
    appendFileSync(ALERTS_MD, `- [${rec.ts}] **${sev}** \`${key}\` ${message}\n`);
    alertCounts[sev]++;
    console.log(`[alert:${sev}] ${key} :: ${message}`);
    saveState();
    return true;
}

const lastRestartReq = {};
function requestRestart(reason, key, cooldownMs = 5 * 60e3) {
    const now = Date.now();
    if (now - (lastRestartReq[key] ?? 0) < cooldownMs) return;
    lastRestartReq[key] = now;
    try { writeFileSync(RESTART_REQ, JSON.stringify({ ts: iso(now), reason, by: 'watch.mjs' })); } catch { }
    alert('critical', `restart-request:${key}`, `请求重启整树：${reason}`, { reason });
}

// ---- 错误签名与高频统计 ----
const WINDOW_MS = 10 * 60e3;
const STORM_THRESHOLD = 5;
const errorEvents = [];
const errorTotals = {};
function noteError(sig, level, src, sample) {
    const now = Date.now();
    errorEvents.push({ at: now, sig, level, src });
    errorTotals[sig] = (errorTotals[sig] ?? 0) + 1;
    while (errorEvents.length > 0 && errorEvents[0].at < now - WINDOW_MS) errorEvents.shift();
    const inWindow = errorEvents.filter((e) => e.sig === sig).length;
    if (inWindow >= STORM_THRESHOLD) {
        alert('critical', `error-storm:${sig}`, `10 分钟内出现 ${inWindow} 次：${sig}`, { count: inWindow, src, sample: String(sample).slice(0, 300) });
    }
}

const SIGNALS = [
    { key: 'body-attach-failed', sev: 'critical', re: /body-attach-failed|Failed to attach body|attachBody/i },
    { key: 'mc-connect-failed', sev: 'critical', re: /ECONNREFUSED|ETIMEDOUT|getaddrinfo|Failed to connect|Connection refused/i },
    { key: 'disconnect', sev: 'warn', re: /disconnected|Disconnected from server|connection lost|socket closed|kicked|被踢/i },
    { key: 'model-error', sev: 'critical', re: /"stopReason":"error"|stopReason[^,]*error|unanswered|generation failed/i },
    { key: 'restart-loop', sev: 'critical', re: /exited too quickly|will not be restarted/i },
    { key: 'exception', sev: 'warn', re: /Uncaught|UnhandledPromiseRejection|uncaughtException/i },
];
const restartEvents = [];
function processLine(src, line) {
    let obj = null;
    if (line.startsWith('{')) { try { obj = JSON.parse(line); } catch { } }
    const level = obj?.level;
    if (level === 'error' || level === 'warn') {
        const raw = String(obj?.event ?? obj?.err ?? obj?.msg ?? obj?.mod ?? src);
        const sig = `${obj?.mod ?? src}:${raw.replace(/[0-9]+/g, '#').slice(0, 90)}`;
        noteError(sig, level, src, line);
    }
    for (const s of SIGNALS) {
        if (s.re.test(line)) {
            noteError(`${s.key}`, s.sev, src, line);
            if (s.sev === 'critical') alert('critical', `signal:${s.key}`, `${s.key}：${line.slice(0, 220)}`, { src });
        }
    }
    const m = /(Agent|Body) process exited with code (\S+) and signal (\S+)/.exec(line);
    if (m) {
        restartEvents.push({ at: Date.now(), kind: m[1], code: m[2], signal: m[3] });
        console.log(`[lifecycle] ${m[0]}`);
    }
}

// ---- Feedback 汇总（模型用 Feedback 工具提出的建议 → 可追踪清单）----
let feedbackCount = 0;
try { feedbackCount = readFileSync(join(FEED_DIR, 'feedback-list.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { }
let lastFeedback = null;
function renderFeedback(r) {
    const todos = (r.plan?.todos ?? []).map((t) => `${t.done ? '[x]' : '[ ]'} ${t.text}`).join('; ');
    const plan = r.plan ? `计划：goal=${r.plan.goal ?? '-'} | todos=${todos || '-'}` : '计划：-';
    return `\n## ${r.ts} · ${r.agent} · ${r.title}\n\n${r.body}\n\n_${plan}_\n`;
}
function collectFeedback() {
    for (const agent of AGENTS) {
        const f = join(ROOT, 'bots', agent, 'feedback.jsonl');
        for (const line of readNew(f)) {
            let e; try { e = JSON.parse(line); } catch { continue; }
            const rec = { ts: iso(), agent, at: e.at ?? null, title: e.title ?? '', body: e.body ?? '', plan: e.plan ?? null };
            appendFileSync(join(FEED_DIR, 'feedback-list.jsonl'), JSON.stringify(rec) + '\n');
            appendFileSync(join(FEED_DIR, 'feedback-new.jsonl'), JSON.stringify(rec) + '\n');
            appendFileSync(join(FEED_DIR, 'FEEDBACK.md'), renderFeedback(rec));
            feedbackCount++; lastFeedback = rec;
            console.log(`[feedback] ${agent} :: ${rec.title}`);
        }
    }
}

function agentLogFiles(agent) {
    const dir = join(ROOT, 'bots', agent, 'logs');
    try { return readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.log')).map((f) => join(dir, f)); }
    catch { return []; }
}
function dbInfo(agent) {
    const dir = join(ROOT, 'bots', agent);
    const out = [];
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith('.db')) continue;
            try { const st = statSync(join(dir, f)); out.push({ file: f, bytes: st.size, mtime: iso(st.mtimeMs) }); } catch { }
        }
    } catch { }
    return out;
}

// ---- CLI events / 在线探测 ----
function probeBots() {
    return new Promise((resolve) => {
        let settled = false;
        const socket = io(`http://127.0.0.1:${PORT}`, { reconnection: false, timeout: 4000, transports: ['websocket', 'polling'] });
        const finish = (result) => { if (settled) return; settled = true; try { socket.close(); } catch { } resolve(result); };
        const overall = setTimeout(() => finish({ connected: false, err: 'connect timeout' }), 8000);
        socket.on('connect_error', (e) => { clearTimeout(overall); finish({ connected: false, err: String(e?.message ?? e) }); });
        socket.on('connect', () => {
            clearTimeout(overall);
            const bots = {}; let pending = AGENTS.length;
            const doneOne = () => { if (--pending === 0) finish({ connected: true, bots }); };
            for (const agent of AGENTS) {
                const t = setTimeout(() => { bots[agent] ??= { ok: false, error: 'no response' }; doneOne(); }, 6000);
                try {
                    socket.emit('cli-command', agent, { op: 'list', since: state.cliSince[agent] ?? 0 }, (res) => {
                        clearTimeout(t); bots[agent] = res ?? { ok: false, error: 'empty response' }; doneOne();
                    });
                } catch (e) { clearTimeout(t); bots[agent] = { ok: false, error: String(e) }; doneOne(); }
            }
        });
    });
}

const offlineSince = {};
const lastProgressAt = {};
const online = {};
let mindserverFails = 0;
let lastNoFeedbackAlert = 0;

/**
 * 「两个 bot 同时不在线」的计时起点。
 *
 * 原来这里的判定是 `onlineCount === 0 && Date.now() - startedAt > 5 分钟`，
 * 而 `startedAt` 是 **watcher 自己的启动时刻**——于是只要 watcher 跑了 5 分钟
 * 以上，任何一次"两个 bot 恰好都不在线"的瞬间（尤其是 supervisor 主动重启后
 * 那 60 秒的重新登录窗口）都会立刻触发一次整树重启，重启又制造新的离线窗口
 * → 重启风暴（实测 12:56 刚起来的 main 只活了 22 秒就被这种请求杀掉）。
 *
 * 正确语义是"**持续**都不在线 5 分钟"，所以要自己记起点：一旦有人在线就清零。
 */
let allOfflineSince = null;
/** supervisor 换过 main 进程之后给的宽限期（新进程要重新登录，别急着判死）。 */
let freshMainUntil = 0;
let lastMainPid = null;

/** 读 supervisor 写的 main.pid；读不到返回 null。 */
function readMainPid() {
    try {
        const raw = readFileSync(join(RUN, 'main.pid'), 'utf8').trim();
        return raw === '' ? null : raw;
    } catch {
        return null;
    }
}

async function tick() {
    for (const f of [join(RUN, 'stdout.log'), join(RUN, 'stderr.log')]) {
        for (const line of readNew(f)) processLine(f.includes('stderr') ? 'stderr' : 'stdout', line);
    }
    for (const agent of AGENTS) {
        for (const f of agentLogFiles(agent)) {
            const lines = readNew(f);
            if (lines.length > 0) lastProgressAt[agent] = Date.now();
            for (const line of lines) processLine(`${agent}/${f.split(/[\\/]/).pop()}`, line);
        }
    }
    collectFeedback();

    // supervisor 拉起新 main 了：把"掉线/全掉线"的计时全部清零，并给一段宽限。
    // 不这么做的话，重启前积累的掉线时长会被算到新进程头上（新进程刚起来
    // 40-60 秒内 bot 必然还没登录），于是"掉线 ≥150s"立刻再触发一次重启。
    const mainPid = readMainPid();
    if (mainPid != null && mainPid !== lastMainPid) {
        if (lastMainPid != null) {
            for (const agent of AGENTS) {
                offlineSince[agent] = null;
                // **停滞计时也要清**：不清的话新进程一上线就带着"上一个进程
                // 已经停滞 N 分钟"的陈旧基线，45 分钟规则会立刻再杀一次
                // （对抗验证 VERIFY.md 声明 5，与 all-offline 同一类 bug）。
                lastProgressAt[agent] = null;
            }
            allOfflineSince = null;
            mindserverFails = 0;
            freshMainUntil = Date.now() + STARTUP_GRACE_MS;
            alert('info', 'main-restarted', `supervisor 换了 main 进程（pid ${mainPid}），掉线/停滞/端口失败计时清零并宽限 ${Math.round(STARTUP_GRACE_MS / 1000)}s`, { pid: mainPid });
        }
        lastMainPid = mainPid;
    }
    const inGrace = Date.now() - startedAt < STARTUP_GRACE_MS || Date.now() < freshMainUntil;

    const probe = await probeBots();
    if (!probe.connected) {
        mindserverFails++;
        if (!inGrace) {
            alert('critical', 'mindserver-down', `MindServer ${PORT} 连不上（第 ${mindserverFails} 次）：${probe.err}`, { fails: mindserverFails });
            if (mindserverFails >= 3) requestRestart(`MindServer ${PORT} 连续 ${mindserverFails} 次连不上：${probe.err}`, 'mindserver');
        }
    } else {
        mindserverFails = 0;
    }

    for (const agent of AGENTS) {
        const res = probe.bots?.[agent];
        const up = res?.ok === true;
        online[agent] = up;
        if (!up) {
            if (!offlineSince[agent]) offlineSince[agent] = Date.now();
            const sec = Math.round((Date.now() - offlineSince[agent]) / 1000);
            if (sec >= 90 && !inGrace) {
                alert('critical', `bot-offline:${agent}`, `${agent} 掉线 ${sec}s（MindServer：${res?.error ?? 'unreachable'}）`, { agent, sec });
                if (sec >= 150) requestRestart(`${agent} 掉线 ${sec}s`, `offline:${agent}`);
            }
            continue;
        }
        if (offlineSince[agent]) {
            if (!inGrace) alert('info', `bot-back:${agent}`, `${agent} 恢复在线（掉线约 ${Math.round((Date.now() - offlineSince[agent]) / 1000)}s）`, { agent });
            offlineSince[agent] = null;
        }
        lastProgressAt[agent] ??= Date.now();
        for (const ev of res.events ?? []) {
            appendFileSync(CLI_EVENTS, JSON.stringify({ ts: iso(), agent, at: ev.at, level: ev.level, action: ev.action, text: ev.text }) + '\n');
            lastProgressAt[agent] = Date.now();
        }
        if ((res.events ?? []).length > 0) state.cliSince[agent] = Math.max(...res.events.map((e) => e.at));
        const idleMin = (Date.now() - (lastProgressAt[agent] ?? Date.now())) / 60000;
        if (idleMin > 30) alert('warn', `stalled:${agent}`, `${agent} 在线但 ${idleMin.toFixed(0)} 分钟无日志/事件活动`, { agent, idleMin: Math.round(idleMin) });
        if (idleMin > 45 && !inGrace) requestRestart(`${agent} 停滞 ${idleMin.toFixed(0)} 分钟`, `stall:${agent}`);
        const dbs = dbInfo(agent);
        if (dbs.length === 0) alert('warn', `no-db:${agent}`, `${agent} 还没有 session.db（会话未落盘？）`, { agent });
    }

    // **持续**都不在线才算停摆：一有人回来就把起点清掉。
    const onlineCount = AGENTS.filter((a) => online[a]).length;
    if (onlineCount === 0) {
        allOfflineSince ??= Date.now();
        const allOfflineSec = Math.round((Date.now() - allOfflineSince) / 1000);
        if (allOfflineSec > 5 * 60 && !inGrace) {
            requestRestart(`两个 bot 都不在线超过 5 分钟（连续 ${allOfflineSec}s）`, 'all-offline');
        }
    } else {
        allOfflineSince = null;
    }
    if (onlineCount === 2 && feedbackCount === 0 && Date.now() - startedAt > 30 * 60e3 && Date.now() - lastNoFeedbackAlert > 60 * 60e3) {
        lastNoFeedbackAlert = Date.now();
        alert('warn', 'no-feedback', '两个 bot 在线 30 分钟仍无任何 Feedback（提示词要求频繁反馈）', {});
    }

    const status = {
        updatedAt: iso(), watcherPid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        mindserverUp: probe.connected, mindserverFails,
        bots: Object.fromEntries(AGENTS.map((a) => [a, {
            online: !!online[a],
            offlineForSec: offlineSince[a] ? Math.round((Date.now() - offlineSince[a]) / 1000) : 0,
            idleSec: Math.round((Date.now() - (lastProgressAt[a] ?? Date.now())) / 1000),
            cliEventsSince: state.cliSince[a] ?? 0,
            dbs: dbInfo(a),
        }])),
        feedback: { count: feedbackCount, last: lastFeedback ? { ts: lastFeedback.ts, agent: lastFeedback.agent, title: lastFeedback.title } : null },
        errors: { window: errorEvents.length, top: Object.entries(errorTotals).sort((a, b) => b[1] - a[1]).slice(0, 10) },
        lifecycle: { childExits: restartEvents.length, last: restartEvents.slice(-3) },
        alerts: { ...alertCounts },
    };
    writeFileSync(STATUS, JSON.stringify(status, null, 2));
    appendFileSync(HEARTBEAT, JSON.stringify({ ts: status.updatedAt, cycle, mindserverUp: probe.connected, bots: Object.fromEntries(AGENTS.map((a) => [a, online[a] ? 'up' : 'DOWN'])) }) + '\n');
    console.log(`[watch] cycle ${cycle} mindserver=${probe.connected} bots=${AGENTS.map((a) => `${a}:${online[a] ? 'up' : 'DOWN'}`).join(',')} fb=${feedbackCount} errWin=${errorEvents.length}`);
    saveState();
}

let cycle = 0;
console.log(`[watch] started root=${ROOT} port=${PORT} poll=${POLL_MS}ms`);
process.on('SIGINT', () => { saveState(); process.exit(0); });
process.on('SIGTERM', () => { saveState(); process.exit(0); });
for (;;) {
    cycle++;
    const t0 = Date.now();
    try { await tick(); } catch (e) {
        console.error('[watch] tick failed:', e);
        try { appendFileSync(join(RUN, 'watch-errors.log'), `${iso()} ${e?.stack ?? e}\n`); } catch { }
    }
    const wait = Math.max(1000, POLL_MS - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
}
