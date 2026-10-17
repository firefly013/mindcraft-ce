// 一屏运行摘要，给 runtime-watch 轮询用。
import { readFileSync, statSync } from 'node:fs';
const RUN = 'tmp/overnight';
const j = (f) => { try { return JSON.parse(readFileSync(`${RUN}/${f}`, 'utf8')); } catch { return null; } };
const w = j('watch-status.json'); const s = j('supervisor-status.json');
const bots = w ? Object.entries(w.bots).map(([k, v]) => `${k}:${v.online ? 'up' : 'DOWN'}${v.idleSec > 300 ? `(idle${v.idleSec}s)` : ''}`).join(' ') : 'no-status';
const errTop = (w?.errors?.top ?? []).slice(0, 3).map(([k, n]) => `${k}x${n}`).join(', ');
console.log(`watch: bots=${bots} fb=${w?.feedback?.count ?? '?'} errWin=${w?.errors?.window ?? '?'} top=[${errTop}] alerts=${JSON.stringify(w?.alerts ?? {})}`);
console.log(`sup: main=${s?.mainAlive ? 'alive' : 'DEAD'} pid=${s?.mainPid} uptime=${s?.mainUptimeSec}s restarts=${s?.restartCount} lastExit=${JSON.stringify(s?.lastExit ?? null)}`);
for (const f of ['stdout.log', 'stderr.log']) {
    try { const st = statSync(`${RUN}/${f}`); console.log(`${f}: ${st.size}B mtime=${new Date(st.mtimeMs).toISOString()}`); } catch { }
}
try { const tail = readFileSync(`${RUN}/stdout.log`, 'utf8').trim().split('\n').slice(-1)[0]; console.log('last-line: ' + tail.slice(0, 200)); } catch { }
